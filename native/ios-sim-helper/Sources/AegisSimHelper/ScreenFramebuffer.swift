@preconcurrency import CoreSimDeviceIO
import FBControlCore
import FBSimulatorControl
import Foundation
import IOSurface
import ObjectiveC

/// Where a stream's frames come from.
protocol FramebufferSource: AnyObject {
    func attach(_ consumer: any FBFramebufferConsumer, on queue: DispatchQueue) -> IOSurface?
    func detach(_ consumer: any FBFramebufferConsumer)
}

/// One screen's framebuffer: the registration idb's FBFramebuffer (MIT) makes
/// for the main display, on any display. Used for every device: a foldable
/// has two main displays with a surface each, and idb's own registration
/// crashes the process when the device shuts down while streaming
/// (CoreSimulator then calls back with nil, which Swift's nonnull import
/// of the block cannot take), so the callbacks here are blocks that accept
/// nil, registered through the runtime.
final class ScreenFramebuffer: FramebufferSource, @unchecked Sendable {
    let screenID: UInt32
    private let descriptor: AnyObject
    private var registrations: [ObjectIdentifier: UUID] = [:]

    init(display: ScreenInfo.Display) throws {
        let descriptor = display.descriptor
        guard descriptor.conforms(to: SimDisplayIOSurfaceRenderable.self),
              descriptor.conforms(to: SimDisplayRenderable.self) else {
            throw HelperError("Screen \(display.id) has no framebuffer.")
        }
        self.screenID = display.id
        self.descriptor = descriptor
    }

    func attach(_ consumer: any FBFramebufferConsumer, on queue: DispatchQueue) -> IOSurface? {
        let uuid = UUID()
        registrations[ObjectIdentifier(consumer)] = uuid
        nonisolated(unsafe) let target = consumer
        let changed: @convention(block) (AnyObject?) -> Void = { surface in
            nonisolated(unsafe) let surface = surface
            queue.async { target.didChange(surface as? IOSurface) }
        }
        let damage: @convention(block) (AnyObject?) -> Void = { _ in
            queue.async { target.didReceiveDamageRect() }
        }
        // Only one of the two surface names is served, depending on the Xcode.
        register("registerCallbackWithUUID:ioSurfacesChangeCallback:", uuid, changed)
        register("registerCallbackWithUUID:ioSurfaceChangeCallback:", uuid, changed)
        register("registerCallbackWithUUID:damageRectanglesCallback:", uuid, damage)
        let renderable = descriptor as! SimDisplayIOSurfaceRenderable
        var surface: IOSurface?
        try? FBObjCExceptionGuard.run { surface = renderable.framebufferSurface as? IOSurface }
        if surface == nil { try? FBObjCExceptionGuard.run { surface = renderable.ioSurface as? IOSurface } }
        return surface
    }

    func detach(_ consumer: any FBFramebufferConsumer) {
        guard let uuid = registrations.removeValue(forKey: ObjectIdentifier(consumer)) else { return }
        for name in [
            "unregisterIOSurfacesChangeCallbackWithUUID:",
            "unregisterIOSurfaceChangeCallbackWithUUID:",
            "unregisterDamageRectanglesCallbackWithUUID:",
        ] {
            let selector = NSSelectorFromString(name)
            guard let object = descriptor as? NSObject, object.responds(to: selector) else { continue }
            try? FBObjCExceptionGuard.run { _ = object.perform(selector, with: uuid as NSUUID) }
        }
    }

    private func register(_ name: String, _ uuid: UUID, _ callback: @escaping @convention(block) (AnyObject?) -> Void) {
        let selector = NSSelectorFromString(name)
        guard let object = descriptor as? NSObject, object.responds(to: selector) else { return }
        // Sent as a message (objc_msgSend), so the remote proxy forwards it
        // with the block intact.
        try? FBObjCExceptionGuard.run { _ = object.perform(selector, with: uuid as NSUUID, with: callback as AnyObject) }
    }
}
