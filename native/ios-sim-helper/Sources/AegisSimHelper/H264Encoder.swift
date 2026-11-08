import CoreMedia
import QuartzCore
import CoreVideo
import Foundation
import VideoToolbox

/// Realtime H.264 for the pane: one Annex-B access unit per frame, with the
/// SPS/PPS in front of every keyframe so a decoder can join at any keyframe.
final class H264Encoder {
    typealias Output = (_ annexB: Data, _ keyFrame: Bool) -> Void

    private var session: VTCompressionSession?
    private let output: Output
    let width: Int32
    let height: Int32
    private(set) var bytesOut = 0

    init(width: Int32, height: Int32, fps: Int = 60, output: @escaping Output) throws {
        self.width = width
        self.height = height
        self.output = output
        var created: VTCompressionSession?
        let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &created
        )
        guard status == noErr, let created else { throw HelperError("VTCompressionSessionCreate failed: \(status)") }
        session = created
        let properties: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
            kVTCompressionPropertyKey_ExpectedFrameRate: fps,
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 2,
            kVTCompressionPropertyKey_AverageBitRate: Int(width) * Int(height) * 6,
        ]
        for (key, value) in properties {
            VTSessionSetProperty(created, key: key, value: value as CFTypeRef)
        }
        VTCompressionSessionPrepareToEncodeFrames(created)
    }

    deinit { invalidate() }

    func invalidate() {
        guard let session else { return }
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }

    /// Scales the source into the encoder's size; VideoToolbox does the
    /// resize on the GPU.
    func encode(_ pixelBuffer: CVPixelBuffer, frame: Int64, forceKeyFrame: Bool) {
        guard let session else { return }
        // Wall-clock timestamps: frames come only when the screen changes,
        // and rate control should see the real gaps.
        let time = CMTime(seconds: CACurrentMediaTime(), preferredTimescale: 1_000_000)
        let options: CFDictionary? = forceKeyFrame
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
            : nil
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: time,
            duration: .invalid,
            frameProperties: options,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer, let self else { return }
            guard let (data, keyFrame) = Self.annexB(from: sampleBuffer) else { return }
            self.bytesOut += data.count
            self.output(data, keyFrame)
        }
    }

    func flush() {
        guard let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    }

    private static let startCode: [UInt8] = [0, 0, 0, 1]

    static func annexB(from sampleBuffer: CMSampleBuffer) -> (Data, Bool)? {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
        var keyFrame = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
           let first = attachments.first,
           let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            keyFrame = !notSync
        }
        var out = Data()
        if keyFrame, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for index in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                if let pointer {
                    out.append(contentsOf: startCode)
                    out.append(pointer, count: size)
                }
            }
        }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer else { return nil }
        // AVCC (4-byte big-endian lengths) to Annex B start codes.
        var offset = 0
        pointer.withMemoryRebound(to: UInt8.self, capacity: length) { bytes in
            while offset + 4 <= length {
                let nalLength = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
                offset += 4
                guard nalLength > 0, offset + nalLength <= length else { break }
                out.append(contentsOf: startCode)
                out.append(bytes + offset, count: nalLength)
                offset += nalLength
            }
        }
        return (out, keyFrame)
    }
}
