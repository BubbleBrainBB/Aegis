import CoreGraphics
import CoreImage
import FBControlCore
import FBSimulatorControl
import Foundation
import ImageIO
import IOSurface
import UniformTypeIdentifiers

/// `aegis-sim-helper serve`: one process for every simulator Aegis shows.
///
/// Requests are JSON lines on stdin: `{"id": 1, "cmd": "tap", "udid": "…", …}`.
/// A request with an id gets one reply `{"id": 1, "ok": true, "result": …}`
/// or `{"id": 1, "ok": false, "error": "…"}`; live touches carry no id and
/// get none. Requests for one device run in order; devices run in parallel.
/// Coordinates are in points. stdin closing ends the process.
@MainActor
final class Server {
    static let version = 1

    private let logger: FBControlCoreLogger
    private var simulatorSet: FBSimulatorSet?
    private var sessions: [String: DeviceSession] = [:]
    private var queues: [String: Task<Void, Never>] = [:]

    init() {
        logger = FBControlCoreLoggerFactory.systemLoggerWriting(toStderr: true, withDebugLogging: false)
        FBControlCoreGlobalConfiguration.defaultLogger = logger
    }

    func run() async {
        do {
            try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
            try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
            Output.shared.json(["event": "ready", "version": Self.version])
        } catch {
            Output.shared.json(["event": "fatal", "error": "Could not load the simulator frameworks from the selected Xcode: \(error.localizedDescription)"])
            return
        }
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                guard let data = line.data(using: .utf8),
                      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                dispatch(request)
            }
        } catch {
            FileHandle.standardError.write(Data("stdin: \(error)\n".utf8))
        }
        for session in sessions.values { session.close() }
    }

    private func dispatch(_ request: [String: Any]) {
        let id = request["id"]
        let reply: (Result<Any, Error>) -> Void = { result in
            guard let id else {
                if case let .failure(error) = result {
                    FileHandle.standardError.write(Data("\(request["cmd"] ?? "?") failed: \(error)\n".utf8))
                }
                return
            }
            switch result {
            case let .success(value): Output.shared.json(["id": id, "ok": true, "result": value])
            case let .failure(error): Output.shared.json(["id": id, "ok": false, "error": String(describing: error)])
            }
        }
        guard let udid = request["udid"] as? String else {
            reply(.failure(HelperError("udid is required")))
            return
        }
        // One device's requests run in order: a touch never overtakes a tap.
        let previous = queues[udid]
        queues[udid] = Task { @MainActor in
            await previous?.value
            do {
                reply(.success(try await self.handle(request, udid: udid)))
            } catch {
                reply(.failure(error))
            }
        }
    }

    private func simulator(_ udid: String) throws -> FBSimulator {
        if simulatorSet == nil {
            simulatorSet = try FBSimulatorControl.withConfiguration(
                FBSimulatorControlConfiguration(deviceSetPath: nil, logger: logger, reporter: SilentReporter())
            ).set
        }
        if let found = simulatorSet?.allSimulators.first(where: { $0.udid == udid }) { return found }
        // Created after the set was read: read it again.
        simulatorSet = try FBSimulatorControl.withConfiguration(
            FBSimulatorControlConfiguration(deviceSetPath: nil, logger: logger, reporter: SilentReporter())
        ).set
        guard let found = simulatorSet?.allSimulators.first(where: { $0.udid == udid }) else {
            throw HelperError("No simulator with id \(udid).")
        }
        return found
    }

    private func session(_ udid: String) throws -> DeviceSession {
        let simulator = try simulator(udid)
        guard simulator.state == .booted else { throw HelperError("\(simulator.name) is not booted.") }
        if let existing = sessions[udid], existing.isCurrent(for: simulator) { return existing }
        // A session from an earlier boot that was streaming: Aegis restarts
        // its stream (its watcher may not have noticed the reboot yet).
        if let stale = sessions[udid], stale.isStreaming {
            Output.shared.json(["event": "boot-changed", "udid": udid, "booted": true])
        }
        sessions[udid]?.close()
        let created = DeviceSession(simulator: simulator, logger: logger)
        sessions[udid] = created
        return created
    }

    private func handle(_ request: [String: Any], udid: String) async throws -> Any {
        let command = request["cmd"] as? String ?? ""
        func number(_ key: String) throws -> Double {
            if let value = request[key] as? Double { return value }
            if let value = request[key] as? Int { return Double(value) }
            throw HelperError("\(command) needs \(key)")
        }
        switch command {
        case "screen":
            return try session(udid).screen
        case "display":
            let simulator = try simulator(udid)
            return [
                "uiOrientation": ScreenInfo.uiOrientation(of: simulator).map { Int($0) } ?? 0,
                "screens": ScreenInfo.screens(of: simulator).map(\.json),
            ] as [String: Any]
        case "stream":
            let maxEdge = (request["maxEdge"] as? Int) ?? 1600
            let maxFps = (request["maxFps"] as? Double) ?? 60
            return try session(udid).startStream(maxEdge: maxEdge, maxFps: maxFps)
        case "keyframe":
            sessions[udid]?.streamer?.requestKeyFrame()
            return true
        case "unstream":
            await sessions[udid]?.releaseFinger()
            sessions[udid]?.stopStream()
            return true
        case "touch":
            let phase = request["phase"] as? String ?? "down"
            try await session(udid).touch(phase: phase, x: number("x"), y: number("y"))
            return true
        case "dtouch":
            // A live touch: fractions of the shown screen, sent as they come.
            try await session(udid).finger(phase: request["phase"] as? String ?? "down", x: number("x"), y: number("y"), edge: UInt64(request["edge"] as? Int ?? 0))
            return true
        case "dtap":
            let device = try session(udid)
            let hold = max(0.02, min((request["hold"] as? Double) ?? 0.05, 5))
            let x = try number("x"), y = try number("y")
            try await device.finger(phase: "down", x: x, y: y)
            try? await Task.sleep(nanoseconds: UInt64(hold * 1_000_000_000))
            try await device.finger(phase: "up", x: x, y: y)
            return true
        case "dswipe":
            let device = try session(udid)
            let from = (try number("x"), try number("y")), to = (try number("toX"), try number("toY"))
            let seconds = max(0.05, min((request["duration"] as? Double) ?? 0.3, 3))
            let steps = max(4, Int(seconds * 60))
            try await device.finger(phase: "down", x: from.0, y: from.1, edge: UInt64(request["edge"] as? Int ?? 0))
            for step in 1...steps {
                let t = Double(step) / Double(steps)
                try? await Task.sleep(nanoseconds: UInt64(seconds / Double(steps) * 1_000_000_000))
                try await device.finger(phase: "move", x: from.0 + (to.0 - from.0) * t, y: from.1 + (to.1 - from.1) * t)
            }
            try await device.finger(phase: "up", x: to.0, y: to.1)
            return true
        case "dbutton":
            try await session(udid).hardwareButton(page: UInt64(try number("page")), usage: UInt64(try number("usage")))
            return true
        case "tap":
            let hold = (request["hold"] as? Double) ?? 0.05
            try await session(udid).tap(x: number("x"), y: number("y"), hold: hold)
            return true
        case "swipe":
            try await session(udid).swipe(
                from: CGPoint(x: number("x"), y: number("y")),
                to: CGPoint(x: number("toX"), y: number("toY")),
                duration: (request["duration"] as? Double) ?? 0.3
            )
            return true
        case "button":
            try await session(udid).button(request["button"] as? String ?? "")
            return true
        case "key":
            try await session(udid).key(UInt32(try number("code")))
            return true
        case "text":
            let text = request["text"] as? String ?? ""
            guard let events = Keyboard.events(for: text) else { throw HelperError("unsupported-text") }
            try await session(udid).send(.composite(events))
            return true
        case "paste":
            // ⌘V: text the keyboard cannot type goes through the pasteboard.
            try await session(udid).send(.composite([
                .keyboard(direction: .down, keyCode: 227),
                .keyboard(direction: .down, keyCode: 25),
                .keyboard(direction: .up, keyCode: 25),
                .keyboard(direction: .up, keyCode: 227),
            ]))
            return true
        case "rotate":
            try await session(udid).rotate(request["orientation"] as? String ?? "portrait")
            return true
        case "describe":
            return try await session(udid).describe()
        case "screenshot":
            guard let path = request["path"] as? String else { throw HelperError("screenshot needs path") }
            try await session(udid).screenshot(to: path, screenID: (request["screenID"] as? Int).map(UInt32.init))
            return path
        case "close":
            let closing = sessions.removeValue(forKey: udid)
            await closing?.releaseFinger()
            closing?.close()
            return true
        default:
            throw HelperError("unknown command \(command)")
        }
    }
}

/// One booted simulator: its held HID connection and its screen stream.
@MainActor
final class DeviceSession {
    let simulator: FBSimulator
    private let logger: FBControlCoreLogger
    private let bootedAt: Date?
    private var hid: FBSimulatorHID?
    private(set) var streamer: FrameStreamer?
    private var framebuffer: FramebufferSource?
    /// The screen streamed, on a device with more than one main screen.
    private var streamedScreen: UInt32?
    private var streamSettings: (maxEdge: Int, maxFps: Double)?
    private var touching = false
    private var lastLegacyPoint: (x: Double, y: Double) = (0, 0)

    init(simulator: FBSimulator, logger: FBControlCoreLogger) {
        self.simulator = simulator
        self.logger = logger
        self.bootedAt = Self.bootTime(of: simulator)
    }

    /// The same boot of the device (a reboot invalidates HID and framebuffer).
    func isCurrent(for simulator: FBSimulator) -> Bool {
        simulator === self.simulator && Self.bootTime(of: simulator) == bootedAt
    }

    private static func bootTime(of simulator: FBSimulator) -> Date? {
        (simulator.device as AnyObject).value(forKey: "lastBootedAt") as? Date
    }

    func close() {
        stopStream()
        hid?.disconnect()
        hid = nil
        directHID = nil
    }

    /// Which of the device's screens is shown. A foldable has two main
    /// screens, each with its own framebuffer, and clears the one it turns
    /// off to black: the shown one is the one with a picture (the outer one
    /// folded, the inner one open). While both or neither have one (asleep,
    /// mid-fold), the one already streamed stays, else the one whose
    /// backlight reads on (it is not updated on every fold, so only a
    /// tie-break). Otherwise its one main screen.
    /// Touches target it, and its orientation, chrome and mask apply.
    func activeScreen() -> ScreenInfo.Screen? {
        let screens = ScreenInfo.screens(of: displays())
        let mains = screens.filter(\.main)
        if mains.count > 1 {
            let showing = mains.filter { screen in
                displays().first(where: { $0.id == screen.id }).flatMap(ScreenInfo.hasContent) == true
            }
            if showing.count == 1 { return showing[0] }
            return mains.first(where: { $0.id == streamedScreen })
                ?? mains.first(where: { $0.lit == true })
                ?? mains.first(where: { $0.poweredOn })
                ?? mains.first
        }
        return mains.first ?? screens.first(where: { $0.poweredOn }) ?? screens.first
    }

    /// The device's displays, read once per boot (it walks every IO port).
    private var cachedDisplays: [ScreenInfo.Display] = []

    func displays() -> [ScreenInfo.Display] {
        if cachedDisplays.isEmpty { cachedDisplays = ScreenInfo.displays(of: simulator) }
        return cachedDisplays
    }

    /// More than one main screen: a foldable, each screen streamed on its own.
    private var isMultiScreen: Bool { displays().filter(\.main).count > 1 }

    private func display(_ id: UInt32) throws -> ScreenInfo.Display {
        guard let found = displays().first(where: { $0.id == id }) else { throw HelperError("No screen \(id).") }
        return found
    }

    /// The screen as shown, in physical portrait points, with how its UI is
    /// turned and which screen (the HID target) it is.
    var screen: [String: Any] { screen(activeScreen()) }

    func screen(_ active: ScreenInfo.Screen?) -> [String: Any] {
        let info = simulator.screenInfo
        let scale = max(Double(info?.scale ?? 1), 1)
        let width = active.map { Double($0.pixelWidth) } ?? Double(info?.widthPixels ?? 0)
        let height = active.map { Double($0.pixelHeight) } ?? Double(info?.heightPixels ?? 0)
        var out: [String: Any] = [
            "name": simulator.name,
            "scale": scale,
            "pixelWidth": Int(width),
            "pixelHeight": Int(height),
            "pointWidth": width / scale,
            "pointHeight": height / scale,
            "hidWidth": Double(info?.widthPixels ?? 0) / scale,
            "hidHeight": Double(info?.heightPixels ?? 0) / scale,
            "uiOrientation": Int(active?.uiOrientation ?? ScreenInfo.uiOrientation(of: simulator) ?? 1),
            "screenID": Int(active?.id ?? 1),
        ]
        if let chrome = active?.chromeIdentifier { out["chromeIdentifier"] = chrome }
        if let mask = active?.maskIdentifier { out["maskIdentifier"] = mask }
        return out
    }

    /// Tell Aegis when the UI turns (rotation, a foldable's posture, Device
    /// Hub) or the framebuffer changes size, while the screen streams.
    private var watcher: Task<Void, Never>?
    private var lastReported: (orientation: UInt32, width: Int, height: Int)?

    private func reportDisplay() {
        guard let active = activeScreen() else { return }
        // Folded or unfolded: stream the screen now in use. Also retries a
        // switch whose new screen could not be opened yet.
        if let settings = streamSettings, streamer == nil || (streamedScreen != nil && active.id != streamedScreen) {
            switchStream(to: active, settings: settings)
            return
        }
        let orientation = active.uiOrientation ?? 1
        if let last = lastReported, last.orientation == orientation, last.width == active.pixelWidth, last.height == active.pixelHeight { return }
        announce(active)
    }

    /// Move the stream to another screen, announced before its first frame
    /// so the pane never draws it in the other's outline. The watcher keeps
    /// running: if the screen cannot be opened (mid-fold), the next tick
    /// tries again.
    private func switchStream(to active: ScreenInfo.Screen, settings: (maxEdge: Int, maxFps: Double)) {
        streamer?.stop()
        streamer = nil
        framebuffer = nil
        announce(active)
        do {
            try openStream(maxEdge: settings.maxEdge, maxFps: settings.maxFps, screen: active)
        } catch {
            streamedScreen = nil
            logger.log("Could not stream screen \(active.id) yet: \(error)")
        }
    }

    private func announce(_ active: ScreenInfo.Screen) {
        lastReported = (active.uiOrientation ?? 1, active.pixelWidth, active.pixelHeight)
        cachedTarget = nil
        var event = screen(active)
        event["event"] = "display"
        event["udid"] = simulator.udid
        Output.shared.json(event)
    }

    private func watchDisplay() {
        watcher?.cancel()
        watcher = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                // Rebooted or shut down outside Aegis: this session's displays
                // and HID are gone. Say so and stop; Aegis streams again
                // through a new session once the device is up.
                if !self.isBootCurrent {
                    var event: [String: Any] = ["event": "boot-changed", "udid": self.simulator.udid]
                    event["booted"] = self.simulator.state == .booted
                    Output.shared.json(event)
                    self.stopStream()
                    return
                }
                self.reportDisplay()
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    var isStreaming: Bool { streamSettings != nil }

    /// Still the boot this session was made for.
    private var isBootCurrent: Bool {
        simulator.state == .booted && Self.bootTime(of: simulator) == bootedAt
    }

    func startStream(maxEdge: Int, maxFps: Double) throws -> [String: Any] {
        // Set before the first open: if the screen cannot be opened yet
        // (booting, mid-fold), the watcher keeps trying every tick.
        streamSettings = (maxEdge, maxFps)
        if let streamer {
            streamer.requestKeyFrame()
        } else {
            do {
                try openStream(maxEdge: maxEdge, maxFps: maxFps, screen: nil)
                lastReported = nil
            } catch {
                logger.log("Could not stream \(simulator.udid) yet, retrying: \(error)")
            }
        }
        if watcher == nil { watchDisplay() }
        return screen
    }

    /// The stream of one screen: the given one, else the shown one.
    private func openStream(maxEdge: Int, maxFps: Double, screen chosen: ScreenInfo.Screen?) throws {
        let framebuffer: FramebufferSource
        if isMultiScreen, let active = chosen ?? activeScreen() {
            framebuffer = try ScreenFramebuffer(display: display(active.id))
            streamedScreen = active.id
        } else {
            guard let main = displays().first(where: \.main) else { throw HelperError("\(simulator.name) has no screen yet.") }
            framebuffer = try ScreenFramebuffer(display: main)
            streamedScreen = nil
        }
        self.framebuffer = framebuffer
        let created = FrameStreamer(udid: simulator.udid, framebuffer: framebuffer, maxEdge: maxEdge, maxFps: maxFps)
        created.onSurfaceSize = { _, _ in
            Task { @MainActor [weak self] in self?.reportDisplay() }
        }
        streamer = created
        created.start()
    }

    func stopStream() {
        watcher?.cancel()
        watcher = nil
        streamer?.stop()
        streamer = nil
        framebuffer = nil
        streamedScreen = nil
        streamSettings = nil
    }

    private var directHID: DirectHID?
    private var cachedTarget: (id: UInt64, at: Date)?

    /// The HID target for touches: the shown screen's ID (an unknown one
    /// falls back to the main screen). Read again at most once a second;
    /// a posture change is caught by the display watcher.
    func touchTarget() -> UInt64 {
        if let cachedTarget, Date().timeIntervalSince(cachedTarget.at) < 1 { return cachedTarget.id }
        let id = UInt64(activeScreen()?.id ?? 1)
        cachedTarget = (id, Date())
        return id
    }

    private var directUnavailableUntil: Date?

    /// The simulator's own input service (dtuhidd, Xcode 27 and later), or
    /// nil where it is not running: older Xcodes take input through idb's
    /// legacy Indigo transport. A failed lookup is retried after a while, as
    /// a device that just booted may not have started it yet.
    func direct() -> DirectHID? {
        if let directHID { return directHID }
        if let until = directUnavailableUntil, Date() < until { return nil }
        do {
            let created = try DirectHID(simulator: simulator)
            directHID = created
            directUnavailableUntil = nil
            return created
        } catch {
            logger.log("Simulator input service unavailable, using idb's transport: \(error)")
            directUnavailableUntil = Date().addingTimeInterval(5)
            return nil
        }
    }

    /// One finger, at 0..1 fractions of the shown screen. Through dtuhidd it
    /// lands on the shown screen with its edge; through idb's transport (no
    /// dtuhidd) on the main screen, in its points, without an edge.
    func finger(phase: String, x: Double, y: Double, edge: UInt64 = 0) async throws {
        if let hid = direct() {
            await hid.touch(phase: phase, x: x, y: y, target: touchTarget(), edge: edge)
            return
        }
        let info = simulator.screenInfo
        let scale = max(Double(info?.scale ?? 1), 1)
        let width = Double(info?.widthPixels ?? 0) / scale, height = Double(info?.heightPixels ?? 0) / scale
        guard width > 0, height > 0 else { throw HelperError("The simulator screen size is not known.") }
        try await touch(phase: phase, x: min(1, max(0, x)) * width, y: min(1, max(0, y)) * height)
    }

    /// Lift any finger still down (a pane closed mid-drag).
    func releaseFinger() async {
        await directHID?.release()
        if touching { try? await touch(phase: "up", x: lastLegacyPoint.x, y: lastLegacyPoint.y) }
    }

    /// A hardware button by HID usage. Without dtuhidd only the ones idb's
    /// transport has: lock (consumer page, power) and home (consumer, menu).
    func hardwareButton(page: UInt64, usage: UInt64) async throws {
        if let hid = direct() {
            await hid.press(page: page, usage: usage)
            return
        }
        switch (page, usage) {
        case (12, 48): try await button("lock")
        case (12, 64): try await button("home")
        default: throw HelperError("This button needs the simulator input service of Xcode 27 or later.")
        }
    }

    private func connection() async throws -> FBSimulatorHID {
        if let hid { return hid }
        let created = try await simulator.connectToHID()
        hid = created
        return created
    }

    /// One event with the transport's settle time: for discrete actions.
    func send(_ event: FBSimulatorHIDEvent) async throws {
        try await connection().send(event: event, logger: logger)
    }

    /// Live touches from the pane: sent as they come, no settle time, so a
    /// finger follows the pointer.
    func touch(phase: String, x: Double, y: Double) async throws {
        let hid = try await connection()
        lastLegacyPoint = (x, y)
        switch phase {
        case "up":
            guard touching else { return }
            touching = false
            try await FBSimulatorHIDEvent.touch(direction: .up, x: x, y: y).sendAsync(on: hid)
        default:
            // A move is another touch-down at the new point.
            touching = true
            try await FBSimulatorHIDEvent.touch(direction: .down, x: x, y: y).sendAsync(on: hid)
        }
    }

    func tap(x: Double, y: Double, hold: Double) async throws {
        try await send(.composite([
            .touch(direction: .down, x: x, y: y),
            .delay(max(0.02, min(hold, 5))),
            .touch(direction: .up, x: x, y: y),
        ]))
    }

    func swipe(from: CGPoint, to: CGPoint, duration: Double) async throws {
        let seconds = max(0.05, min(duration, 3))
        let steps = max(4, Int(seconds * 60))
        var events: [FBSimulatorHIDEvent] = [.touch(direction: .down, x: from.x, y: from.y)]
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            events.append(.delay(seconds / Double(steps)))
            events.append(.touch(direction: .down, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        }
        events.append(.touch(direction: .up, x: to.x, y: to.y))
        try await send(.composite(events))
    }

    func button(_ name: String) async throws {
        let button: FBSimulatorHIDButton
        switch name {
        case "home": button = .homeButton
        case "lock": button = .lock
        case "siri": button = .siri
        case "side-button", "side": button = .sideButton
        default: throw HelperError("unknown button \(name)")
        }
        try await send(.shortButtonPress(button))
    }

    func key(_ code: UInt32) async throws {
        try await send(.shortKeyPress(code))
    }

    func rotate(_ orientation: String) async throws {
        let value: FBSimulatorHIDDeviceOrientation
        switch orientation {
        case "portrait": value = .portrait
        case "portrait-upside-down": value = .portraitUpsideDown
        case "landscape-left": value = .landscapeLeft
        case "landscape-right": value = .landscapeRight
        default: throw HelperError("unknown orientation \(orientation)")
        }
        try await send(.deviceOrientation(value))
    }

    /// What describe reports per element (the keys AXe's describe-ui uses).
    private static let accessibilityKeys: Set<FBAXKeys> = [
        .label, .frame, .value, .uniqueID, .type, .title, .frameDict, .help, .enabled, .role, .roleDescription, .subrole,
    ]

    /// The frontmost app's accessibility tree, nested, frames in points.
    func describe() async throws -> Any {
        let element = try await simulator.accessibilityElementForFrontmostApplication()
        defer { element.close() }
        let response = try element.serialize(with: FBAccessibilityRequestOptions(nestedFormat: true, keys: Self.accessibilityKeys))
        return JSONSafe.value(response.elements)
    }

    func screenshot(to path: String, screenID: UInt32? = nil) async throws {
        // idb captures the main framebuffer, dark on a folded foldable.
        if isMultiScreen, let id = screenID ?? activeScreen()?.id,
           let surface = Self.currentSurface(of: try ScreenFramebuffer(display: display(id))) {
            try Self.writePNG(surface, to: path)
            return
        }
        let png = try await simulator.takeScreenshot(format: .png)
        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    private static func currentSurface(of source: FramebufferSource) -> IOSurface? {
        final class Peek: NSObject, FBFramebufferConsumer {
            func didChange(_ surface: IOSurface?) {}
            func didReceiveDamageRect() {}
        }
        let peek = Peek()
        defer { source.detach(peek) }
        return source.attach(peek, on: DispatchQueue.global())
    }

    private static func writePNG(_ surface: IOSurface, to path: String) throws {
        let image = CIImage(ioSurface: surface)
        guard let cgImage = CIContext().createCGImage(image, from: image.extent),
              let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw HelperError("Could not encode the screenshot.")
        }
        CGImageDestinationAddImage(destination, cgImage, nil)
        guard CGImageDestinationFinalize(destination) else { throw HelperError("Could not write the screenshot.") }
    }
}

/// Accessibility values may hold NSValue and other types JSON cannot carry.
enum JSONSafe {
    static func value(_ input: Any) -> Any {
        switch input {
        case let array as [Any]: return array.map(value)
        case let dictionary as [String: Any]: return dictionary.mapValues(value)
        case let string as String: return string
        case let number as NSNumber: return number
        case is NSNull: return NSNull()
        case let value as NSValue:
            let rect = value.rectValue
            return ["x": rect.origin.x, "y": rect.origin.y, "width": rect.size.width, "height": rect.size.height]
        default: return String(describing: input)
        }
    }
}
