// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import AppKit
import ApplicationServices
import CoreGraphics
import GBHelperCore

/// The real backend: AXUIElement against GarageBand ONLY. The bundle id is a constant, never taken from a request,
/// and the pid is re-resolved on every request (GarageBand may have quit or relaunched).
final class LiveBackend: AXBackend {
  typealias Node = AXUIElement

  static let bundleId = "com.apple.garageband10"
  static let messagingTimeout: Float = 0.5

  private var cachedPid: pid_t = 0
  private var appElement: AXUIElement?
  /// The app that was frontmost when gb-helper brought GarageBand forward (OS-provided, never from a request).
  private var previousApp: NSRunningApplication?

  init() {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Self.messagingTimeout)
  }

  private func runningApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).first { !$0.isTerminated }
  }

  private func appAX() -> AXUIElement? {
    guard let app = runningApp() else { appElement = nil; cachedPid = 0; return nil }
    if app.processIdentifier != cachedPid || appElement == nil {
      cachedPid = app.processIdentifier
      let el = AXUIElementCreateApplication(cachedPid)
      AXUIElementSetMessagingTimeout(el, Self.messagingTimeout)
      appElement = el
    }
    return appElement
  }

  private func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
  }

  // MARK: AXTreeReader

  func children(_ node: AXUIElement) -> [AXUIElement] { (attr(node, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

  func string(_ node: AXUIElement, _ a: AXAttr) -> String? {
    let name: String
    switch a {
    case .role: name = kAXRoleAttribute
    case .subrole: name = kAXSubroleAttribute
    case .title: name = kAXTitleAttribute
    case .description: name = kAXDescriptionAttribute
    case .identifier: name = kAXIdentifierAttribute
    }
    return attr(node, name) as? String
  }

  func value(_ node: AXUIElement) -> JSONValue? { Self.json(attr(node, kAXValueAttribute)) }

  static func json(_ v: AnyObject?) -> JSONValue? {
    guard let v else { return nil }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return .bool(CFBooleanGetValue((v as! CFBoolean))) }
    if let n = v as? NSNumber { return .number(n.doubleValue) }
    if let s = v as? String { return .string(s) }
    return nil // AXValue structs, elements, arrays: not part of the compact value contract
  }

  // MARK: AXBackend

  func isTrusted() -> Bool { AXIsProcessTrusted() } // never prompts
  func isRunning() -> Bool { runningApp() != nil }
  func application() -> AXUIElement? { appAX() }
  func allWindows() -> [AXUIElement] {
    guard let app = appAX() else { return [] }
    return (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  }
  func menuBar() -> AXUIElement? {
    guard let app = appAX(), let bar = attr(app, kAXMenuBarAttribute) else { return nil }
    return (bar as! AXUIElement)
  }

  func info(_ node: AXUIElement) -> NodeInfo {
    var names: CFArray?
    let actions = AXUIElementCopyActionNames(node, &names) == .success ? ((names as? [String]) ?? []) : []
    return NodeInfo(
      settable: isSettable(node),
      enabled: (attr(node, kAXEnabledAttribute) as? Bool) ?? true,
      actions: actions,
      min: Self.json(attr(node, kAXMinValueAttribute)),
      max: Self.json(attr(node, kAXMaxValueAttribute)),
      help: attr(node, kAXHelpAttribute) as? String,
      selected: attr(node, kAXSelectedAttribute) as? Bool)
  }

  func isSettable(_ node: AXUIElement) -> Bool {
    var b: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &b) == .success && b.boolValue
  }

  func press(_ node: AXUIElement) -> Int32 { AXUIElementPerformAction(node, kAXPressAction as CFString).rawValue }

  func setValue(_ node: AXUIElement, _ value: JSONValue) -> Int32 {
    let cf: CFTypeRef
    switch value {
    case .number(let n): cf = NSNumber(value: n)
    case .string(let s): cf = s as CFString
    case .bool(let b): cf = (b ? kCFBooleanTrue : kCFBooleanFalse)!
    default: return AXError.illegalArgument.rawValue
    }
    return AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, cf).rawValue
  }

  func menuMark(_ node: AXUIElement) -> String? {
    guard let m = attr(node, "AXMenuItemMarkChar") as? String, !m.isEmpty else { return nil }
    return m
  }

  func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
  func sleep(ms: Int) { if ms > 0 { usleep(useconds_t(ms) * 1_000) } }

  // MARK: interaction

  /// NSWorkspace's view is refreshed by the run loop (live finding: the AX "focused application" query is unreliable).
  func isFrontmost() -> Bool {
    RunLoop.current.run(until: Date())
    guard let app = runningApp() else { return false }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
  }

  /// Live finding: NSRunningApplication.activate() and AXFrontmost are refused for GarageBand (cooperative activation);
  /// the fixed AppleScript `activate` works. The source is a constant — nothing from a request reaches it.
  func activateTarget() -> Bool {
    RunLoop.current.run(until: Date())
    guard let gb = runningApp() else { return false }
    if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != gb.processIdentifier { previousApp = front }
    var error: NSDictionary?
    NSAppleScript(source: "tell application id \"\(Self.bundleId)\" to activate")?.executeAndReturnError(&error)
    return error == nil
  }

  /// Gives focus back only while GarageBand is still frontmost — if the user moved on meanwhile, nothing is yanked.
  func restorePreviousFocus() -> Bool {
    defer { previousApp = nil }
    guard let prev = previousApp, !prev.isTerminated, isFrontmost() else { return false }
    _ = prev.activate()
    for _ in 0..<30 {
      RunLoop.current.run(until: Date())
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == prev.processIdentifier { return true }
      usleep(50_000)
    }
    return false
  }

  func frame(_ node: AXUIElement) -> Rect? {
    guard let pv = attr(node, kAXPositionAttribute), let sv = attr(node, kAXSizeAttribute),
          CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero, z = CGSize.zero
    guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &z) else { return nil }
    return Rect(x: Double(p.x), y: Double(p.y), w: Double(z.width), h: Double(z.height))
  }

  /// System-wide hit test: the element that would really receive a click there, whichever app owns it.
  func element(atX x: Double, y: Double) -> AXUIElement? {
    var hit: AXUIElement?
    return AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success ? hit : nil
  }

  func parent(_ node: AXUIElement) -> AXUIElement? {
    guard let p = attr(node, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
    return (p as! AXUIElement)
  }

  func isSame(_ a: AXUIElement, _ b: AXUIElement) -> Bool { CFEqual(a, b) }

  /// A real (HID) left click — GarageBand ignores AX presses on track headers and Library rows. The pointer is put back.
  func click(x: Double, y: Double) -> Int32 {
    let saved = CGEvent(source: nil)?.location
    let src = CGEventSource(stateID: .hidSystemState)
    let pt = CGPoint(x: x, y: y)
    guard let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left),
          let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) else {
      return AXError.failure.rawValue
    }
    down.flags = []; up.flags = [] // never inherit the user's held modifier keys (⌘-click, ⌥-click mean other things)
    down.post(tap: .cghidEventTap)
    usleep(60_000)
    up.post(tap: .cghidEventTap)
    usleep(30_000)
    if let saved { CGWarpMouseCursorPosition(saved); CGAssociateMouseAndMouseCursorPosition(1) }
    return 0
  }

  func perform(_ node: AXUIElement, action: String) -> Int32 { AXUIElementPerformAction(node, action as CFString).rawValue }

  func isTargetApp(_ node: AXUIElement) -> Bool {
    var pid: pid_t = 0
    guard AXUIElementGetPid(node, &pid) == .success, let app = runningApp() else { return false }
    return pid == app.processIdentifier
  }

  func mouseButtonDown() -> Bool {
    [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.combinedSessionState, button: $0) }
  }

  /// The most recent keyboard/pointer event, over an explicit list of event types (no reliance on the ~0 "any input"
  /// sentinel, whose fallback would fail open).
  func msSinceUserInput() -> Double {
    let kinds: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .scrollWheel]
    let seconds = kinds.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    return seconds * 1_000
  }

  func automationGranted() -> Bool { Self.automationStatus(Self.bundleId) == "granted" }

  // MARK: state & permissions (read-only, never prompt)

  func appState() -> JSONValue {
    var o: [String: JSONValue] = ["bundle_id": .string(Self.bundleId), "ax_trusted": .bool(isTrusted())]
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleId) {
      let info = Bundle(url: url)?.infoDictionary ?? [:]
      o["installed"] = [
        "path": .string(url.path),
        "version": (info["CFBundleShortVersionString"] as? String).map { .string($0) } ?? .null,
        "build": (info["CFBundleVersion"] as? String).map { .string($0) } ?? .null,
      ]
    } else {
      o["installed"] = .null
    }
    guard let app = runningApp() else { o["running"] = false; return .object(o) }
    o["running"] = true
    o["pid"] = .number(Double(app.processIdentifier))
    o["frontmost"] = .bool(app.isActive)
    o["hidden"] = .bool(app.isHidden)
    if isTrusted() {
      let windows = allWindows()
      o["windows"] = .array(windows.map { w in
        var wo: [String: JSONValue] = [:]
        for (a, k) in [(AXAttr.role, "role"), (.subrole, "subrole"), (.title, "title"), (.identifier, "id")] {
          if let v = string(w, a), !v.isEmpty { wo[k] = .string(v) }
        }
        return .object(wo)
      })
      o["dialog_count"] = .number(Double(windows.filter { ["AXDialog", "AXSystemDialog"].contains(string($0, .subrole) ?? "") }.count))
      o["sheet_count"] = .number(Double(windows.reduce(0) { $0 + children($1).filter { string($0, .role) == "AXSheet" }.count }))
    }
    return .object(o)
  }

  func permissions() -> JSONValue {
    [
      "accessibility": .bool(isTrusted()),
      "automation": [
        "system_events": .string(Self.automationStatus("com.apple.systemevents")),
        "garageband": .string(Self.automationStatus(Self.bundleId)),
      ],
      "screen_recording": .bool(CGPreflightScreenCaptureAccess()),
    ]
  }

  /// Apple Events consent for a target app, WITHOUT prompting (askUserIfNeeded = false).
  static func automationStatus(_ bundleId: String) -> String {
    var desc = AEAddressDesc()
    let bytes = Array(bundleId.utf8)
    let created = bytes.withUnsafeBufferPointer { buf in
      AECreateDesc(DescType(typeApplicationBundleID), buf.baseAddress, buf.count, &desc)
    }
    guard created == noErr else { return "error:\(created)" }
    defer { AEDisposeDesc(&desc) }
    let status = AEDeterminePermissionToAutomateTarget(&desc, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
    switch status {
    case noErr: return "granted"
    case OSStatus(errAEEventNotPermitted): return "denied"
    case OSStatus(errAEEventWouldRequireUserConsent): return "not_determined"
    case OSStatus(procNotFound): return "not_running"
    default: return "error:\(status)"
    }
  }
}
