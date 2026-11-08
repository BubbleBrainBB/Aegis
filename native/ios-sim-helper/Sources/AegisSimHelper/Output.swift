import Darwin
import Foundation

/// The helper's only channel to Aegis: length-prefixed messages on the
/// process's original stdout. idb and CoreSimulator log freely, so fd 1 is
/// pointed at stderr at startup and the protocol keeps a private copy.
///
///     u8 kind | u32 big-endian length | payload
///
/// kind 1: a JSON object (replies and events).
/// kind 2: an H.264 access unit:
///     u8 udid length | udid | u8 flags (bit 0: keyframe) | u16 width | u16 height | Annex B bytes
final class Output: @unchecked Sendable {
    static let shared = Output()

    private let queue = DispatchQueue(label: "aegis-sim-helper.output")
    private var fd: Int32 = -1

    /// Keep the real stdout for the protocol; everything else written to fd 1
    /// ends up on stderr.
    func claimStdout() {
        fd = dup(STDOUT_FILENO)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        signal(SIGPIPE, SIG_IGN)
    }

    func json(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
            FileHandle.standardError.write(Data("unserializable reply: \(object)\n".utf8))
            return
        }
        write(kind: 1, payload: data)
    }

    func frame(udid: String, keyFrame: Bool, width: Int, height: Int, data: Data) {
        var header = Data()
        let udidBytes = Data(udid.utf8)
        header.append(UInt8(udidBytes.count))
        header.append(udidBytes)
        header.append(keyFrame ? 1 : 0)
        header.append(UInt8((width >> 8) & 0xff)); header.append(UInt8(width & 0xff))
        header.append(UInt8((height >> 8) & 0xff)); header.append(UInt8(height & 0xff))
        write(kind: 2, payload: header + data)
    }

    private func write(kind: UInt8, payload: Data) {
        queue.async { [fd] in
            guard fd >= 0 else { return }
            var message = Data(capacity: payload.count + 5)
            let length = UInt32(payload.count)
            message.append(kind)
            message.append(UInt8((length >> 24) & 0xff))
            message.append(UInt8((length >> 16) & 0xff))
            message.append(UInt8((length >> 8) & 0xff))
            message.append(UInt8(length & 0xff))
            message.append(payload)
            message.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                    if written < 0 {
                        if errno == EINTR { continue }
                        // Aegis went away: nothing left to serve.
                        exit(0)
                    }
                    offset += written
                }
            }
        }
    }
}
