import FBSimulatorControl
import CoreGraphics
import IOSurface
import Foundation
import ObjectiveC

/// What SimulatorKit knows about a device's screen right now: the UI
/// orientation (which also covers a foldable's display turned for its
/// posture, and rotation done in Simulator.app or Device Hub). Read through
/// the Objective-C runtime, as AXe does (MIT): SimDeviceScreen is private.
enum ScreenInfo {
    /// UIInterfaceOrientation: 1 portrait, 2 upside down, 3 landscape right
    /// (home on the right), 4 landscape left.
    static func uiOrientation(of simulator: FBSimulator) -> UInt32? {
        guard let properties = screenProperties(of: simulator) else { return nil }
        return sendUInt32(properties, "uiOrientation")
    }

    /// One of a device's screens, as SimulatorKit describes it.
    struct Screen {
        let id: UInt32
        let name: String?
        let poweredOn: Bool
        let pixelWidth: Int
        let pixelHeight: Int
        let uiOrientation: UInt32?
        let chromeIdentifier: String?
        let maskIdentifier: String?
        /// A main display (class 0) rather than TV out, AirPlay and the like.
        let main: Bool
        /// Its backlight is on: of a foldable's two main screens, the one
        /// in use (the other reads -101, off).
        let lit: Bool?

        var json: [String: Any] {
            var out: [String: Any] = ["id": Int(id), "poweredOn": poweredOn, "pixelWidth": pixelWidth, "pixelHeight": pixelHeight, "main": main]
            if let lit { out["lit"] = lit }
            if let name { out["name"] = name }
            if let uiOrientation { out["uiOrientation"] = Int(uiOrientation) }
            if let chromeIdentifier { out["chromeIdentifier"] = chromeIdentifier }
            if let maskIdentifier { out["maskIdentifier"] = maskIdentifier }
            return out
        }
    }

    /// One of a device's displays: its IO port descriptor (where its
    /// framebuffer and properties are) and whether it is a main display.
    /// Fixed for a boot; reading them walks every IO port over XPC, so a
    /// session reads them once.
    struct Display {
        let id: UInt32
        let descriptor: AnyObject
        let main: Bool
    }

    /// The device's displays: the IO ports whose descriptors are SimScreens.
    static func displays(of simulator: FBSimulator) -> [Display] {
        guard let io = sendObject(simulator.device as AnyObject, "io"), let ports = sendObject(io, "ioPorts") as? [AnyObject] else { return [] }
        var seen = Set<UInt32>()
        var out: [Display] = []
        for port in ports {
            guard let descriptor = sendObject(port, "descriptor"),
                  let properties = sendObject(descriptor, "screenProperties"),
                  let id = sendUInt32(properties, "screenID"),
                  seen.insert(id).inserted else { continue }
            out.append(Display(id: id, descriptor: descriptor, main: displayClass(of: descriptor) == 0))
        }
        return out.sorted { $0.id < $1.id }
    }

    /// Every screen of the device (a foldable has more than one), as its
    /// properties are now.
    static func screens(of simulator: FBSimulator) -> [Screen] {
        screens(of: displays(of: simulator))
    }

    static func screens(of displays: [Display]) -> [Screen] {
        var out: [Screen] = []
        for display in displays {
            guard let properties = sendObject(display.descriptor, "screenProperties") else { continue }
            let id = display.id
            let size = sendSize(properties, "pixelSize") ?? .zero
            let power = sendUInt32(properties, "powerState")
            // SimScreenBacklight.state: 2 lit, -101 off (a foldable's unused screen).
            let backlightState = sendObject(properties, "backlight").flatMap { sendInt32($0, "state") }
            out.append(Screen(
                id: id,
                name: sendObject(properties, "name") as? String,
                // SimScreen power states: 0 off, 1 on (others are transitions).
                poweredOn: power.map { $0 != 0 } ?? true,
                pixelWidth: Int(size.width),
                pixelHeight: Int(size.height),
                uiOrientation: sendUInt32(properties, "uiOrientation"),
                chromeIdentifier: sendObject(properties, "chromeIdentifier") as? String,
                maskIdentifier: sendObject(properties, "framebufferMaskIdentifier") as? String,
                main: display.main,
                lit: backlightState.map { $0 > 0 }
            ))
        }
        return out
    }

    /// Whether a screen's picture shows anything: a foldable clears the
    /// screen it turns off to pure black. Samples a grid of pixels.
    static func hasContent(_ display: Display) -> Bool? {
        guard let object = sendObject(display.descriptor, "framebufferSurface") ?? sendObject(display.descriptor, "ioSurface") else { return nil }
        let surface = unsafeBitCast(object, to: IOSurfaceRef.self)
        guard IOSurfaceGetBytesPerElement(surface) == 4 else { return nil }
        IOSurfaceLock(surface, .readOnly, nil)
        defer { IOSurfaceUnlock(surface, .readOnly, nil) }
        let width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface)
        let rowBytes = IOSurfaceGetBytesPerRow(surface)
        let base = IOSurfaceGetBaseAddress(surface).assumingMemoryBound(to: UInt8.self)
        guard width > 0, height > 0 else { return nil }
        var lit = 0
        let steps = 24
        for row in 0..<steps {
            let y = (height - 1) * row / (steps - 1)
            for column in 0..<steps {
                let pixel = base + y * rowBytes + ((width - 1) * column / (steps - 1)) * 4
                if pixel[0] > 12 || pixel[1] > 12 || pixel[2] > 12 { lit += 1 }
            }
        }
        // Not a stray pixel or two (a camera dot, a cursor).
        return lit > steps * steps / 100
    }

    private static func displayClass(of descriptor: AnyObject) -> UInt16? {
        guard let state = sendObject(descriptor, "state") else { return nil }
        let selector = NSSelectorFromString("displayClass")
        guard let object = state as? NSObject, object.responds(to: selector), let method = object.method(for: selector) else { return nil }
        typealias Send = @convention(c) (AnyObject, Selector) -> UInt16
        return unsafeBitCast(method, to: Send.self)(state, selector)
    }

    private static func sendInt32(_ target: AnyObject, _ name: String) -> Int32? {
        let selector = NSSelectorFromString(name)
        guard let object = target as? NSObject, object.responds(to: selector), let method = object.method(for: selector) else { return nil }
        typealias Send = @convention(c) (AnyObject, Selector) -> Int32
        return unsafeBitCast(method, to: Send.self)(target, selector)
    }

    private static func sendSize(_ target: AnyObject, _ name: String) -> CGSize? {
        let selector = NSSelectorFromString(name)
        guard let object = target as? NSObject, object.responds(to: selector), let method = object.method(for: selector) else { return nil }
        typealias Send = @convention(c) (AnyObject, Selector) -> CGSize
        return unsafeBitCast(method, to: Send.self)(target, selector)
    }

    private static func screenProperties(of simulator: FBSimulator) -> AnyObject? {
        guard let device = sendObject(simulator, "device"),
              let screenClass = NSClassFromString("SimulatorKit.SimDeviceScreen") as? NSObject.Type,
              let allocated = allocate(screenClass) else { return nil }
        let initSelector = NSSelectorFromString("initWithDevice:screenID:")
        guard let initMethod = (allocated as? NSObject)?.method(for: initSelector) else { return nil }
        typealias Init = @convention(c) (AnyObject, Selector, AnyObject, Int) -> AnyObject
        let screenDevice = unsafeBitCast(initMethod, to: Init.self)(allocated, initSelector, device, 1)
        guard let screen = sendObject(screenDevice, "screen") else { return nil }
        return sendObject(screen, "screenProperties")
    }

    private static func allocate(_ type: NSObject.Type) -> AnyObject? {
        let selector = NSSelectorFromString("alloc")
        guard let method = class_getClassMethod(type, selector) else { return nil }
        typealias Alloc = @convention(c) (AnyClass, Selector) -> AnyObject?
        return unsafeBitCast(method_getImplementation(method), to: Alloc.self)(type, selector)
    }

    private static func sendObject(_ target: AnyObject, _ name: String) -> AnyObject? {
        let selector = NSSelectorFromString(name)
        guard let object = target as? NSObject, object.responds(to: selector), let method = object.method(for: selector) else { return nil }
        typealias Send = @convention(c) (AnyObject, Selector) -> AnyObject?
        return unsafeBitCast(method, to: Send.self)(target, selector)
    }

    private static func sendUInt32(_ target: AnyObject, _ name: String) -> UInt32? {
        let selector = NSSelectorFromString(name)
        guard let object = target as? NSObject, object.responds(to: selector), let method = object.method(for: selector) else { return nil }
        typealias Send = @convention(c) (AnyObject, Selector) -> UInt32
        return unsafeBitCast(method, to: Send.self)(target, selector)
    }
}
