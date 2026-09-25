import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// stdout is reserved for one JSON object per line.
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func permissions() -> [String: Any] {
    ["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()]
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return "" }
    return value as? String ?? ""
}

func axElement(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
          let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func isSecure(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<8 {
        guard let item = current else { break }
        if axString(item, kAXSubroleAttribute as CFString) == "AXSecureTextField" { return true }
        current = axElement(item, kAXParentAttribute as CFString)
    }
    return false
}

func primaryTop() -> CGFloat { NSScreen.screens.first?.frame.maxY ?? 0 }
func quartzPoint(_ cocoa: NSPoint) -> CGPoint { CGPoint(x: cocoa.x, y: primaryTop() - cocoa.y) }

final class Recorder {
    private var monitors: [Any] = []
    private var activationObserver: NSObjectProtocol?
    private var started = false
    private let formatter = ISO8601DateFormatter()
    private let parentPID = getppid()

    init() { formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds] }

    func event(_ kind: String, detail: String, app: NSRunningApplication? = nil,
               title: String = "", point: CGPoint? = nil) {
        var object: [String: Any] = ["id": UUID().uuidString,
            "timestamp": formatter.string(from: Date()), "kind": kind,
            "app": app?.localizedName ?? "", "bundleId": app?.bundleIdentifier ?? "",
            "title": title, "detail": detail]
        if let point = point { object["x"] = point.x; object["y"] = point.y }
        emit(object)
    }

    private func shouldSkip(_ app: NSRunningApplication) -> Bool {
        let name = (app.localizedName ?? "").lowercased()
        let bundle = (app.bundleIdentifier ?? "").lowercased()
        return app.processIdentifier == getpid() || app.processIdentifier == parentPID ||
            name == "kite" || name == "kite sprite" || name == "electron" ||
            bundle == "com.kite.sprite" || bundle == "com.kite.app"
    }

    private func context(_ app: NSRunningApplication, target: AXUIElement? = nil) -> (String, String) {
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.3)
        let focused = axElement(application, kAXFocusedUIElementAttribute as CFString)
        if let target = target, isSecure(target) { return ("[redacted]", "Secure input context redacted") }
        if let focused = focused, isSecure(focused) { return ("[redacted]", "Secure input context redacted") }
        let window = axElement(application, kAXFocusedWindowAttribute as CFString)
        let title = window.map { axString($0, kAXTitleAttribute as CFString) } ?? ""
        guard let target = target else { return (title, "") }
        // Never read AXValue, selected text, text ranges, or document contents.
        let role = axString(target, kAXRoleAttribute as CFString)
        let label = axString(target, kAXTitleAttribute as CFString)
        let description = axString(target, kAXDescriptionAttribute as CFString)
        return (title, [role, label, description].filter { !$0.isEmpty }.joined(separator: " · "))
    }

    func start() {
        guard !started else { event("status", detail: "Already recording"); return }
        guard AXIsProcessTrusted() else {
            event("error", detail: "Accessibility permission is required. Recording did not start.")
            return
        }
        guard let mouse = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] e in
            self?.mouseDown(e)
        }) else { event("error", detail: "Could not install mouse observer. Recording did not start."); return }
        guard let keys = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
            self?.keyDown(e)
        }) else {
            NSEvent.removeMonitor(mouse)
            event("error", detail: "Could not install shortcut observer. Recording did not start.")
            return
        }
        monitors = [mouse, keys]
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.activated(app)
        }
        started = true
        event("status", detail: "Recording started")
        if let app = NSWorkspace.shared.frontmostApplication { activated(app) }
    }

    private func activated(_ app: NSRunningApplication) {
        guard started, !shouldSkip(app), checkPermission() else { return }
        event("app", detail: "Application activated", app: app, title: context(app).0)
    }

    private func checkPermission() -> Bool {
        guard AXIsProcessTrusted() else {
            cleanup()
            event("error", detail: "Accessibility permission was revoked. Recording stopped.")
            return false
        }
        return true
    }

    private func mouseDown(_ e: NSEvent) {
        guard started, checkPermission(), let app = NSWorkspace.shared.frontmostApplication, !shouldSkip(app) else { return }
        let point = e.cgEvent?.location ?? quartzPoint(NSEvent.mouseLocation)
        var target: AXUIElement?
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.3)
        let result = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &target)
        let info = context(app, target: result == .success ? target : nil)
        let button = e.type == .rightMouseDown ? "Right click" : e.type == .leftMouseDown ? "Click" : "Mouse button \(e.buttonNumber)"
        event("click", detail: info.1.isEmpty ? button : "\(button): \(info.1)", app: app, title: info.0, point: point)
    }

    private func keyDown(_ e: NSEvent) {
        guard started, checkPermission(), !e.isARepeat,
              let app = NSWorkspace.shared.frontmostApplication, !shouldSkip(app) else { return }
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard !flags.intersection([.command, .control, .option]).isEmpty else { return }
        let info = context(app)
        // Suppress even shortcut metadata while secure input is focused.
        guard info.0 != "[redacted]" else { return }
        var modifiers: [String] = []
        if flags.contains(.command) { modifiers.append("Cmd") }
        if flags.contains(.control) { modifiers.append("Ctrl") }
        if flags.contains(.option) { modifiers.append("Option") }
        if flags.contains(.shift) { modifiers.append("Shift") }
        modifiers.append("KeyCode(\(e.keyCode))")
        event("shortcut", detail: modifiers.joined(separator: "+"), app: app, title: info.0)
    }

    func cleanup() {
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors.removeAll()
        if let observer = activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        activationObserver = nil
        started = false
    }

    func stop() -> Never {
        cleanup()
        event("status", detail: "Recording stopped")
        exit(EXIT_SUCCESS)
    }
}

final class RingView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemRed.setStroke()
        let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 5, dy: 5))
        ring.lineWidth = 4
        ring.stroke()
    }
}

let args = CommandLine.arguments
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let recorder = Recorder()

// Must match server/point-schema.ts's bundleIdSchema (guarded by a parity
// test in tests/tools.test.ts). --open-app and --open-url both check it.
let bundleIdPattern = "^[A-Za-z0-9][A-Za-z0-9-]*(\\.[A-Za-z0-9][A-Za-z0-9-]*)+$"

// The ring --point shows. --click and --scroll show it at their target just
// before they send anything, so the user sees where the input will land. It
// ignores the mouse, so the click passes through it.
func showRing(at point: CGPoint) -> NSPanel {
    let cocoaPoint = NSPoint(x: point.x, y: primaryTop() - point.y)
    let frame = NSRect(x: cocoaPoint.x - 24, y: cocoaPoint.y - 24, width: 48, height: 48)
    let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.level = .screenSaver
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.contentView = RingView(frame: NSRect(origin: .zero, size: frame.size))
    panel.orderFrontRegardless()
    return panel
}

// Finite Quartz coordinates that lie on a connected display, as --point
// accepts them, or nil.
func connectedPoint(_ xText: String, _ yText: String) -> CGPoint? {
    guard let x = Double(xText), let y = Double(yText), x.isFinite, y.isFinite else { return nil }
    let cocoaPoint = NSPoint(x: x, y: Double(primaryTop()) - y)
    guard NSScreen.screens.contains(where: { $0.frame.contains(cocoaPoint) }) else { return nil }
    return CGPoint(x: x, y: y)
}

// How long the ring shows before a click or scroll is sent, and how long it
// stays after. Stop kills this process, so input stopped during the lead is
// never sent.
let ringLead = 0.4
let ringTail = 0.3

// Sending input needs Accessibility, which covers posting events. Both
// checks are the forms that never prompt: a tool call must not raise the
// system prompt; only --request-accessibility does, from onboarding or
// Settings. macOS checks the app responsible for this process: OpenMuse
// Desktop when it was opened from Finder or the Dock, or the terminal that
// ran `npm run dev`.
func eventAccessGranted() -> Bool { AXIsProcessTrusted() && CGPreflightPostEventAccess() }
let eventAccessError = "OpenMuse needs Accessibility permission to control the Mac. Ask the user to turn on OpenMuse Desktop in System Settings > Privacy & Security > Accessibility, then try again."

// The helper's parent is OpenMuse's main process, so this is whether
// OpenMuse is the frontmost app, where keys would reach OpenMuse itself.
func openMuseIsFrontmost() -> Bool {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == getppid()
}

// Whether the focused element, or one of its eight nearest ancestors, is a
// secure text field (isSecure, as the recorder uses it). An app that doesn't
// report its password fields can't be caught.
func focusedFieldIsSecure() -> Bool {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    guard let focused = axElement(system, kAXFocusedUIElementAttribute as CFString) else { return false }
    return isSecure(focused)
}

func postClick(at point: CGPoint, button: CGMouseButton, clicks: Int) {
    let source = CGEventSource(stateID: .hidSystemState)
    let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
    usleep(30_000)
    for click in 1...clicks {
        for kind in [down, up] {
            let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: point, mouseButton: button)
            // The count within a double or triple click, which is how apps
            // tell one from separate clicks.
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            event?.post(tap: .cghidEventTap)
        }
    }
}

// Lines per wheel notch, about what one notch of a mouse wheel scrolls.
let linesPerNotch: Int32 = 3

func postScroll(at point: CGPoint, direction: String, notches: Int) {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
    // Wheel 1 is vertical and wheel 2 horizontal. Positive values scroll up
    // and left, the way a wheel turned away from the user does.
    let vertical: Int32 = direction == "up" ? linesPerNotch : direction == "down" ? -linesPerNotch : 0
    let horizontal: Int32 = direction == "left" ? linesPerNotch : direction == "right" ? -linesPerNotch : 0
    for _ in 0..<notches {
        CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)?.post(tap: .cghidEventTap)
        usleep(20_000)
    }
}

func postText(_ text: String) {
    let source = CGEventSource(stateID: .hidSystemState)
    for character in text {
        // One key event pair per character, carrying the character itself,
        // so it types the same on any keyboard layout. A character made of
        // several code points, such as an emoji with a skin tone, goes in
        // one event.
        let units = Array(String(character).utf16)
        for isDown in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
            event?.flags = []
            event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            event?.post(tap: .cghidEventTap)
        }
        usleep(4_000)
    }
}

// Must list exactly server/computer-schema.ts's KEY_NAMES (guarded by a
// parity test in tests/computer-schema.test.ts). Virtual key codes from
// Carbon's Events.h: key positions on a US ANSI keyboard.
let keyCodes: [String: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
    "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
    "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "equal": 0x18,
    "9": 0x19, "7": 0x1A, "minus": 0x1B, "8": 0x1C, "0": 0x1D, "right_bracket": 0x1E, "o": 0x1F,
    "u": 0x20, "left_bracket": 0x21, "i": 0x22, "p": 0x23, "return": 0x24, "l": 0x25, "j": 0x26,
    "quote": 0x27, "k": 0x28, "semicolon": 0x29, "backslash": 0x2A, "comma": 0x2B, "slash": 0x2C,
    "n": 0x2D, "m": 0x2E, "period": 0x2F, "tab": 0x30, "space": 0x31, "grave": 0x32, "delete": 0x33,
    "escape": 0x35, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f3": 0x63, "f8": 0x64, "f9": 0x65,
    "f11": 0x67, "f10": 0x6D, "f12": 0x6F, "home": 0x73, "page_up": 0x74, "forward_delete": 0x75,
    "f4": 0x76, "end": 0x77, "f2": 0x78, "page_down": 0x79, "f1": 0x7A, "left": 0x7B, "right": 0x7C,
    "down": 0x7D, "up": 0x7E,
]

// Must list exactly server/computer-schema.ts's MODIFIERS.
let modifierFlags: [String: CGEventFlags] = [
    "command": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "control": .maskControl,
]

func postKeys(_ code: CGKeyCode, flags: CGEventFlags) {
    let source = CGEventSource(stateID: .hidSystemState)
    for isDown in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: isDown)
        // Exactly these modifiers, whatever keys the user is holding. No
        // separate modifier key events are sent, so none can be left held
        // down if Stop kills this process halfway.
        event?.flags = flags
        event?.post(tap: .cghidEventTap)
    }
}

if args.count > 1 {
    switch args[1] {
    case "--permissions": emit(permissions()); exit(EXIT_SUCCESS)
    case "--request-accessibility":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        emit(permissions()); exit(EXIT_SUCCESS)
    case "--request-screen":
        _ = CGRequestScreenCaptureAccess()
        emit(permissions()); exit(EXIT_SUCCESS)
    case "--open-app":
        guard args.count == 3, args[2].range(of: bundleIdPattern, options: .regularExpression) != nil,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: args[2]) else {
            recorder.event("error", detail: "Invalid or unavailable application bundle identifier")
            exit(EXIT_FAILURE)
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
            if let error = error { recorder.event("error", detail: error.localizedDescription); exit(EXIT_FAILURE) }
            recorder.event("status", detail: "Application opened", app: app)
            exit(EXIT_SUCCESS)
        }
        application.run()
    case "--point":
        guard args.count == 4, let x = Double(args[2]), let y = Double(args[3]), x.isFinite, y.isFinite else {
            recorder.event("error", detail: "Point requires finite Quartz screen coordinates")
            exit(EXIT_FAILURE)
        }
        let cocoaPoint = NSPoint(x: x, y: Double(primaryTop()) - y)
        guard NSScreen.screens.contains(where: { $0.frame.contains(cocoaPoint) }) else {
            recorder.event("error", detail: "Point lies outside connected displays")
            exit(EXIT_FAILURE)
        }
        let panel = showRing(at: CGPoint(x: x, y: y))
        recorder.event("status", detail: "Point displayed", point: CGPoint(x: x, y: y))
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { panel.orderOut(nil); exit(EXIT_SUCCESS) }
        application.run()
    case "--open-url":
        guard args.count == 4, args[2].range(of: bundleIdPattern, options: .regularExpression) != nil,
              let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: args[2]) else {
            recorder.event("error", detail: "Invalid or unavailable application bundle identifier")
            exit(EXIT_FAILURE)
        }
        guard let url = URL(string: args[3]), url.scheme == "https", let host = url.host, !host.isEmpty else {
            recorder.event("error", detail: "Only https web addresses with a host can be opened")
            exit(EXIT_FAILURE)
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config) { app, error in
            if let error = error { recorder.event("error", detail: error.localizedDescription); exit(EXIT_FAILURE) }
            recorder.event("status", detail: "Web page opened", app: app)
            exit(EXIT_SUCCESS)
        }
        application.run()
    case "--click":
        guard args.count == 6, let point = connectedPoint(args[2], args[3]),
              let button = ["left": CGMouseButton.left, "right": CGMouseButton.right][args[4]],
              let clicks = Int(args[5]), (1...3).contains(clicks) else {
            recorder.event("error", detail: "Click requires Quartz coordinates on a connected display, left or right, and 1 to 3 clicks")
            exit(EXIT_FAILURE)
        }
        guard eventAccessGranted() else { recorder.event("error", detail: eventAccessError); exit(EXIT_FAILURE) }
        let panel = showRing(at: point)
        DispatchQueue.main.asyncAfter(deadline: .now() + ringLead) {
            postClick(at: point, button: button, clicks: clicks)
            recorder.event("status", detail: "Click sent", point: point)
            DispatchQueue.main.asyncAfter(deadline: .now() + ringTail) { panel.orderOut(nil); exit(EXIT_SUCCESS) }
        }
        application.run()
    case "--scroll":
        guard args.count == 6, let point = connectedPoint(args[2], args[3]),
              ["up", "down", "left", "right"].contains(args[4]),
              let notches = Int(args[5]), (1...10).contains(notches) else {
            recorder.event("error", detail: "Scroll requires Quartz coordinates on a connected display, up, down, left or right, and 1 to 10 notches")
            exit(EXIT_FAILURE)
        }
        guard eventAccessGranted() else { recorder.event("error", detail: eventAccessError); exit(EXIT_FAILURE) }
        let panel = showRing(at: point)
        DispatchQueue.main.asyncAfter(deadline: .now() + ringLead) {
            postScroll(at: point, direction: args[4], notches: notches)
            recorder.event("status", detail: "Scroll sent", point: point)
            DispatchQueue.main.asyncAfter(deadline: .now() + ringTail) { panel.orderOut(nil); exit(EXIT_SUCCESS) }
        }
        application.run()
    case "--type":
        // The text comes on stdin, not argv: any process on the Mac can read
        // another's arguments. It is read first, so the writer never hits a
        // closed pipe on the refusals below.
        let data = FileHandle.standardInput.readDataToEndOfFile()
        let breaks: [Unicode.GeneralCategory] = [.control, .lineSeparator, .paragraphSeparator]
        guard args.count == 2, data.count <= 4096, let text = String(data: data, encoding: .utf8), !text.isEmpty,
              !text.unicodeScalars.contains(where: { breaks.contains($0.properties.generalCategory) }) else {
            recorder.event("error", detail: "Typing requires 1 to 4096 bytes of UTF-8 text on standard input, without control characters or line breaks")
            exit(EXIT_FAILURE)
        }
        guard eventAccessGranted() else { recorder.event("error", detail: eventAccessError); exit(EXIT_FAILURE) }
        guard !openMuseIsFrontmost() else {
            recorder.event("error", detail: "OpenMuse is the frontmost app, so the text would go to OpenMuse itself. Click the field you want to type into first.")
            exit(EXIT_FAILURE)
        }
        guard !focusedFieldIsSecure() else {
            recorder.event("error", detail: "The focused field is a password field. OpenMuse doesn't type into password fields; ask the user to type it themselves.")
            exit(EXIT_FAILURE)
        }
        postText(text)
        recorder.event("status", detail: "Text typed")
        exit(EXIT_SUCCESS)
    case "--keys":
        guard (3...7).contains(args.count), let code = keyCodes[args[2]] else {
            recorder.event("error", detail: "Keys require one known key name and up to four different modifiers")
            exit(EXIT_FAILURE)
        }
        var flags: CGEventFlags = []
        for name in args.dropFirst(3) {
            guard let flag = modifierFlags[name], !flags.contains(flag) else {
                recorder.event("error", detail: "Keys require one known key name and up to four different modifiers")
                exit(EXIT_FAILURE)
            }
            flags.insert(flag)
        }
        guard eventAccessGranted() else { recorder.event("error", detail: eventAccessError); exit(EXIT_FAILURE) }
        guard !openMuseIsFrontmost() else {
            recorder.event("error", detail: "OpenMuse is the frontmost app, so the keys would go to OpenMuse itself. Click in the app you want, or open it with open_application or open_url, first.")
            exit(EXIT_FAILURE)
        }
        postKeys(code, flags: flags)
        recorder.event("status", detail: "Keys pressed")
        exit(EXIT_SUCCESS)
    default: recorder.event("error", detail: "Unknown argument"); exit(EXIT_FAILURE)
    }
} else {
    recorder.event("status", detail: "Ready; waiting for start command")
    DispatchQueue.global(qos: .utility).async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let command = object["command"] as? String else {
                DispatchQueue.main.async { recorder.event("error", detail: "Expected a JSON command object") }
                continue
            }
            DispatchQueue.main.async {
                switch command {
                case "start": recorder.start()
                case "stop": recorder.stop()
                default: recorder.event("error", detail: "Unknown command")
                }
            }
        }
        DispatchQueue.main.async { recorder.stop() }
    }
    application.run()
}
