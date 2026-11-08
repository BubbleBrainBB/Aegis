import Darwin
import FBSimulatorControl
import Foundation
import ObjectiveC
import XPC

/// Talks to the simulator's `dtuhidd` (Xcode 27's HID service) directly, the
/// way idb's DTUHID transport does, for what idb does not expose:
///
/// - a touch's `target`, the display it lands on. A foldable has more than
///   one, and idb always sends 0, the main (outer) display;
/// - any hardware button by HID usage (volume, the Action button), as
///   Xcode's DeviceKit chrome names them.
///
/// Touch points are 0..1 fractions of the target display.
final class DirectHID: @unchecked Sendable {
    private static let digitizerService = "com.apple.coredevice.feature.remote.hid.digitizer"
    private let connection: xpc_connection_t
    private var touching = false
    private var touchEdge: UInt64 = 0

    init(simulator: FBSimulator) throws {
        typealias EndpointFromPort = @convention(c) (mach_port_t, UInt64, UInt64) -> xpc_endpoint_t?
        typealias ConnectionFromEndpoint = @convention(c) (xpc_endpoint_t) -> xpc_connection_t?
        typealias EnableSim2Host = @convention(c) (xpc_connection_t) -> Void
        guard let handle = dlopen(nil, RTLD_NOW),
              let endpointSymbol = dlsym(handle, "xpc_endpoint_create_mach_port_4sim"),
              let connectionSymbol = dlsym(handle, "xpc_connection_create_from_endpoint"),
              let enableSymbol = dlsym(handle, "xpc_connection_enable_sim2host_4sim") else {
            throw HelperError("The simulator HID symbols are not available.")
        }
        let port = try Self.lookup(Self.digitizerService, on: simulator)
        guard let endpoint = unsafeBitCast(endpointSymbol, to: EndpointFromPort.self)(port, 0, 0),
              let connection = unsafeBitCast(connectionSymbol, to: ConnectionFromEndpoint.self)(endpoint) else {
            throw HelperError("Could not connect to the simulator's HID service.")
        }
        // Without this the daemon sees the peer but never the payloads.
        unsafeBitCast(enableSymbol, to: EnableSim2Host.self)(connection)
        xpc_connection_set_event_handler(connection) { _ in }
        xpc_connection_resume(connection)
        self.connection = connection
    }

    deinit {
        xpc_connection_cancel(connection)
    }

    /// `-[SimDevice lookup:error:]`, through the runtime (SimDevice is private).
    private static func lookup(_ service: String, on simulator: FBSimulator) throws -> mach_port_t {
        let device = simulator.device as AnyObject
        let selector = NSSelectorFromString("lookup:error:")
        guard let object = device as? NSObject, object.responds(to: selector), let method = object.method(for: selector) else {
            throw HelperError("SimDevice lookup is not available.")
        }
        typealias Lookup = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> mach_port_t
        var error: NSError?
        let port = unsafeBitCast(method, to: Lookup.self)(device, selector, service as NSString, &error)
        if port == 0 { throw HelperError("The simulator's HID service is not running: \(error?.localizedDescription ?? "no port")") }
        return port
    }

    /// Whether a finger is down.
    var isTouching: Bool { touching }
    private var lastPoint: (x: Double, y: Double, target: UInt64) = (0, 0, 0)

    /// A finger: down starts a contact, move moves it, up ends it. A down
    /// while a finger is still down (its up was lost) lifts it first, so the
    /// new contact starts clean with its own edge.
    /// `edge` is the screen edge a contact starts on (IndigoHIDEdge), which iOS
    /// needs for its edge gestures: swipe up to go home, Control Center, back.
    /// It sticks to the contact until the finger lifts.
    func touch(phase: String, x: Double, y: Double, target: UInt64, edge: UInt64 = 0) async {
        let eventType: UInt64
        switch phase {
        case "up":
            guard touching else { return }
            touching = false
            eventType = 2
        case "down":
            if touching { await release() }
            touchEdge = edge
            touching = true
            eventType = 0
        default:
            eventType = touching ? 1 : 0
            if !touching { touchEdge = edge }
            touching = true
        }
        lastPoint = (x, y, target)
        let point = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_double(point, "x", min(1, max(0, x)))
        xpc_dictionary_set_double(point, "y", min(1, max(0, y)))
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_value(payload, "pointOne", point)
        xpc_dictionary_set_uint64(payload, "eventType", eventType)
        xpc_dictionary_set_uint64(payload, "edge", touchEdge)
        xpc_dictionary_set_uint64(payload, "target", target)
        await send("IndigoDigitizerEvent", payload)
    }

    /// Lift a finger left down (a pane closed mid-drag), where it last was.
    func release() async {
        guard touching else { return }
        await touch(phase: "up", x: lastPoint.x, y: lastPoint.y, target: lastPoint.target)
    }

    /// A hardware button by HID usage page and code, pressed and released.
    func press(page: UInt64, usage: UInt64, hold: TimeInterval = 0.08) async {
        for state: UInt64 in [1, 2] {
            let payload = xpc_dictionary_create(nil, nil, 0)
            xpc_dictionary_set_uint64(payload, "usagePage", page)
            xpc_dictionary_set_uint64(payload, "usageCode", usage)
            xpc_dictionary_set_uint64(payload, "state", state)
            await send("IndigoButtonEvent", payload)
            if state == 1 { try? await Task.sleep(nanoseconds: UInt64(hold * 1_000_000_000)) }
        }
    }

    private func send(_ messageType: String, _ payload: xpc_object_t) async {
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, "messageType", messageType)
        xpc_dictionary_set_bool(message, "isBarrier", false)
        xpc_dictionary_set_string(message, "featureIdentifier", Self.digitizerService)
        xpc_dictionary_set_value(message, "payload", payload)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            xpc_connection_send_message(connection, message)
            xpc_connection_send_barrier(connection) { continuation.resume() }
        }
    }
}
