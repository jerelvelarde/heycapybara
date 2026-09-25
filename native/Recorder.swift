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
        guard args.count == 3, args[2].range(of: "^[A-Za-z0-9][A-Za-z0-9-]*(\\.[A-Za-z0-9][A-Za-z0-9-]*)+$", options: .regularExpression) != nil,
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
        recorder.event("status", detail: "Point displayed", point: CGPoint(x: x, y: y))
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { panel.orderOut(nil); exit(EXIT_SUCCESS) }
        application.run()
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
