import CoreMedia
import CoreVideo
import FBControlCore
import FBSimulatorControl
import Foundation
import IOSurface
import VideoToolbox

/// `aegis-sim-helper probe <udid>`: measures what the helper is built on —
/// framebuffer change rate, H.264 encode, and touch latency over a held HID
/// connection — on a booted simulator.
@MainActor
enum Probe {
    final class Counter: NSObject, FBFramebufferConsumer {
        var surface: IOSurface?
        var damage = 0
        func didChange(_ surface: IOSurface?) { self.surface = surface }
        func didReceiveDamageRect() { damage += 1 }
    }

    static func run(udid: String) async throws {
        let logger = FBControlCoreLoggerFactory.systemLoggerWriting(toStderr: true, withDebugLogging: false)
        var started = Date()
        try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
        try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
        let set = try FBSimulatorControl.withConfiguration(
            FBSimulatorControlConfiguration(deviceSetPath: nil, logger: logger, reporter: SilentReporter())
        ).set
        guard let simulator = set.allSimulators.first(where: { $0.udid == udid }) else {
            throw HelperError("no simulator \(udid)")
        }
        print("setup \(ms(started)) ms, \(simulator.name)")

        started = Date()
        guard let main = ScreenInfo.displays(of: simulator).first(where: \.main) else { throw HelperError("no main screen") }
        let framebuffer = try ScreenFramebuffer(display: main)
        let counter = Counter()
        let immediate = framebuffer.attach(counter, on: DispatchQueue.main)
        if let immediate { counter.surface = immediate }
        try await Task.sleep(for: .milliseconds(300))
        guard let surface = counter.surface else { throw HelperError("no IOSurface") }
        print("framebuffer \(ms(started)) ms, surface \(IOSurfaceGetWidth(surface))x\(IOSurfaceGetHeight(surface)) fmt=\(fourcc(IOSurfaceGetPixelFormat(surface)))")

        started = Date()
        let hid = try await simulator.connectToHID()
        print("hid connect \(ms(started)) ms, transport \(hid.transportType)")

        // Encode a few frames to check VideoToolbox accepts the surface.
        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        CVPixelBufferCreateWithIOSurface(nil, surface, nil, &pixelBuffer)
        guard let buffer = pixelBuffer?.takeRetainedValue() else { throw HelperError("no pixel buffer") }
        let encoder = try H264Encoder(width: Int32(IOSurfaceGetWidth(surface)) / 2, height: Int32(IOSurfaceGetHeight(surface)) / 2) { _, _ in }
        started = Date()
        for index in 0..<10 { encoder.encode(buffer, frame: Int64(index), forceKeyFrame: index == 0) }
        encoder.flush()
        print("encode 10 frames \(ms(started)) ms, \(encoder.bytesOut / 1024) KB out")

        // Touch latency: down/move/up on the held connection while frames count.
        let width = Double(IOSurfaceGetWidth(surface)) / 3, height = Double(IOSurfaceGetHeight(surface)) / 3
        counter.damage = 0
        started = Date()
        try await FBSimulatorHIDEvent.touch(direction: .down, x: width * 0.8, y: height * 0.5).sendAsync(on: hid)
        print("touch down \(ms(started)) ms")
        let moveStart = Date()
        for step in 1...10 {
            let x = width * (0.8 - 0.06 * Double(step))
            let sent = Date()
            try await FBSimulatorHIDEvent.touch(direction: .down, x: x, y: height * 0.5).sendAsync(on: hid)
            if step == 1 { print("one move \(Int(Date().timeIntervalSince(sent) * 1_000_000)) us") }
            try await Task.sleep(for: .milliseconds(16))
        }
        try await FBSimulatorHIDEvent.touch(direction: .up, x: width * 0.2, y: height * 0.5).sendAsync(on: hid)
        print("10 moves + up \(ms(moveStart)) ms (160 ms of that is the 16 ms pacing)")
        try await Task.sleep(for: .seconds(1))
        let damageWindow = Date().timeIntervalSince(started)
        print("framebuffer changes during swipe: \(counter.damage) in \(String(format: "%.2f", damageWindow)) s")

        started = Date()
        try await hid.send(event: .shortButtonPress(.homeButton), logger: logger)
        print("home button \(ms(started)) ms")

        started = Date()
        let element = try await simulator.accessibilityElementForFrontmostApplication()
        let response = try element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: true, keys: nil))
        element.close()
        print("accessibility \(ms(started)) ms, \((response.elements as? [Any])?.count ?? 0) roots")

        started = Date()
        let png = try await simulator.takeScreenshot(format: .png)
        print("screenshot \(ms(started)) ms, \(png.count / 1024) KB")
        framebuffer.detach(counter)
        hid.disconnect()
    }

    static func ms(_ since: Date) -> Int { Int(Date().timeIntervalSince(since) * 1000) }

    static func fourcc(_ code: OSType) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }
        return String(bytes: bytes, encoding: .ascii) ?? "\(code)"
    }
}

final class SilentReporter: NSObject, FBEventReporter {
    var metadata: [String: String] = [:]
    func report(_ subject: FBEventReporterSubject) {}
    func addMetadata(_ metadata: [String: String]) {}
}

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
