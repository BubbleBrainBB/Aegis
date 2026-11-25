import AppKit

// A controlled desktop target. Each window owns a separate editable value.
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let menu = NSMenu()
let appMenu = NSMenuItem()
menu.addItem(appMenu)
appMenu.submenu = NSMenu(title: "WindowFixture")
let item = NSMenuItem(title: "Document", action: nil, keyEquivalent: "")
menu.addItem(item)
let actions = NSMenu(title: "Document")
item.submenu = actions
actions.autoenablesItems = false
final class DocumentWindow: NSWindow {
    @objc func inspectDocument(_ sender: Any?) {
        print("menu invoked in \(title)")
        fflush(stdout)
    }
}
let inspect = actions.addItem(withTitle: "Inspect Document", action: #selector(DocumentWindow.inspectDocument(_:)), keyEquivalent: "")
application.mainMenu = menu
var windows: [NSWindow] = []
for (index, title) in ["First Document", "Second Document"].enumerated() {
    let window = DocumentWindow(contentRect: NSRect(x: 120 + index * 30, y: 180, width: 360, height: 160),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = title
    let field = NSTextField(frame: NSRect(x: 24, y: 65, width: 310, height: 26))
    field.stringValue = "original-\(index)"
    field.setAccessibilityLabel("Document value")
    window.contentView?.addSubview(field)
    window.orderBack(nil)
    windows.append(window)
}
// This document command follows the app's main document, as Save would.
inspect.target = windows[0]
let documentObserver = NotificationCenter.default.addObserver(forName: NSWindow.didBecomeMainNotification, object: nil, queue: .main) { note in
    if let window = note.object as? DocumentWindow { inspect.target = window }
}
windows[0].makeMain()
windows[0].makeKey()
let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
       app.processIdentifier == ProcessInfo.processInfo.processIdentifier {
        print("fixture took focus")
        fflush(stdout)
    }
}
let stopFile = CommandLine.arguments[1]
let parentPID = Int32(CommandLine.arguments[2])!
Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    if FileManager.default.fileExists(atPath: stopFile) || kill(parentPID, 0) != 0 {
        application.terminate(nil)
    }
}
DispatchQueue.main.async {
    print("ready")
    fflush(stdout)
}
application.run()
