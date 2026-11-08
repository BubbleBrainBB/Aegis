import CoreVideo
import FBControlCore
import FBSimulatorControl
import Foundation
import IOSurface
import QuartzCore

/// Streams one simulator's screen: the framebuffer reports each change, and
/// the latest surface is encoded at most `maxFps` times a second. A static
/// screen sends nothing; the pane keeps showing the last frame.
final class FrameStreamer: NSObject, FBFramebufferConsumer, @unchecked Sendable {
    let udid: String
    private let framebuffer: FramebufferSource
    private let queue: DispatchQueue
    private let maxEdge: Int
    private let maxFps: Double
    private var surface: IOSurface?
    private var pixelBuffer: CVPixelBuffer?
    private var encoder: H264Encoder?
    private var frameNumber: Int64 = 0
    private var lastEncode: CFTimeInterval = 0
    private var pending = false
    private var wantKeyFrame = true
    private var stopped = false

    init(udid: String, framebuffer: FramebufferSource, maxEdge: Int, maxFps: Double) {
        self.udid = udid
        self.framebuffer = framebuffer
        self.maxEdge = maxEdge
        self.maxFps = maxFps
        self.queue = DispatchQueue(label: "aegis-sim-helper.frames.\(udid)", qos: .userInteractive)
        super.init()
    }

    /// Attach and send the current screen right away as a keyframe.
    func start() {
        if let immediate = framebuffer.attach(self, on: queue) {
            queue.async { self.adopt(immediate) }
        }
    }

    func stop() {
        framebuffer.detach(self)
        queue.async {
            self.stopped = true
            self.encoder?.invalidate()
            self.encoder = nil
        }
    }

    /// A new viewer joins: the next frame is a keyframe, sent now.
    func requestKeyFrame() {
        queue.async {
            self.wantKeyFrame = true
            self.encodeNow()
        }
    }

    /// Encoded size in pixels, once known.
    var size: (width: Int, height: Int)? {
        queue.sync { encoder.map { (Int($0.width), Int($0.height)) } }
    }

    /// The framebuffer in pixels, once attached. A foldable's surface
    /// changes size with its posture.
    var surfaceSize: (width: Int, height: Int)? {
        queue.sync { surface.map { (IOSurfaceGetWidth($0), IOSurfaceGetHeight($0)) } }
    }

    /// Called on the frame queue when the surface's size changes.
    var onSurfaceSize: (@Sendable (Int, Int) -> Void)?

    // MARK: FBFramebufferConsumer (called on `queue`)

    func didChange(_ surface: IOSurface?) {
        adopt(surface)
    }

    func didReceiveDamageRect() {
        schedule()
    }

    // MARK: Encoding

    private func adopt(_ next: IOSurface?) {
        guard !stopped, let next else { return }
        if surface === next, pixelBuffer != nil { return }
        let resized = surface.map { IOSurfaceGetWidth($0) != IOSurfaceGetWidth(next) || IOSurfaceGetHeight($0) != IOSurfaceGetHeight(next) } ?? true
        surface = next
        if resized { onSurfaceSize?(IOSurfaceGetWidth(next), IOSurfaceGetHeight(next)) }
        var unmanaged: Unmanaged<CVPixelBuffer>?
        CVPixelBufferCreateWithIOSurface(nil, next, nil, &unmanaged)
        pixelBuffer = unmanaged?.takeRetainedValue()
        let width = IOSurfaceGetWidth(next), height = IOSurfaceGetHeight(next)
        let scale = min(1, Double(maxEdge) / Double(max(width, height)))
        // H.264 wants even dimensions.
        let encodedWidth = Int32(Double(width) * scale) & ~1
        let encodedHeight = Int32(Double(height) * scale) & ~1
        if encoder?.width != encodedWidth || encoder?.height != encodedHeight {
            encoder?.invalidate()
            let udid = self.udid
            encoder = try? H264Encoder(width: encodedWidth, height: encodedHeight, fps: Int(maxFps)) { data, keyFrame in
                Output.shared.frame(udid: udid, keyFrame: keyFrame, width: Int(encodedWidth), height: Int(encodedHeight), data: data)
            }
            wantKeyFrame = true
        }
        encodeNow()
    }

    private func schedule() {
        guard !stopped, !pending else { return }
        let interval = 1 / maxFps
        let wait = lastEncode + interval - CACurrentMediaTime()
        if wait <= 0 {
            encodeNow()
            return
        }
        pending = true
        queue.asyncAfter(deadline: .now() + wait) {
            self.pending = false
            self.encodeNow()
        }
    }

    private func encodeNow() {
        guard !stopped, let pixelBuffer, let encoder else { return }
        lastEncode = CACurrentMediaTime()
        frameNumber += 1
        let key = wantKeyFrame
        wantKeyFrame = false
        encoder.encode(pixelBuffer, frame: frameNumber, forceKeyFrame: key)
    }
}
