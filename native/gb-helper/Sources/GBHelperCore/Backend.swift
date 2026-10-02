// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation

/// Per-node details beyond the matchable attributes (for compact snapshots).
public struct NodeInfo: Sendable {
  public var settable: Bool
  public var enabled: Bool
  public var actions: [String]
  public var min: JSONValue?
  public var max: JSONValue?
  public var help: String?
  /// AXSelected when the element has it (track headers, rows) — how a click's effect is read back.
  public var selected: Bool?
  public init(settable: Bool, enabled: Bool, actions: [String], min: JSONValue?, max: JSONValue?, help: String?, selected: Bool? = nil) {
    self.settable = settable; self.enabled = enabled; self.actions = actions; self.min = min; self.max = max; self.help = help
    self.selected = selected
  }
}

/// GarageBand's project chooser window identifier.
public let projectChooserId = "newProjectDialog"

/// Screen rectangle (points, top-left origin like AXPosition).
public struct Rect: Equatable, Sendable {
  public var x: Double, y: Double, w: Double, h: Double
  public init(x: Double, y: Double, w: Double, h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }
  public func contains(_ px: Double, _ py: Double) -> Bool { px >= x && px < x + w && py >= y && py < y + h }
}

/// Everything the dispatcher needs from the OS. The live implementation wraps AXUIElement and is bound to
/// com.apple.garageband10 only (the bundle id is never taken from a request).
public protocol AXBackend: AXTreeReader {
  func isTrusted() -> Bool
  func isRunning() -> Bool
  func application() -> Node?
  func allWindows() -> [Node]
  func menuBar() -> Node?
  func info(_ node: Node) -> NodeInfo
  func isSettable(_ node: Node) -> Bool
  /// AXError raw value (0 = success).
  func press(_ node: Node) -> Int32
  func setValue(_ node: Node, _ value: JSONValue) -> Int32
  /// AXMenuItemMarkChar (e.g. "✓"), nil when unmarked.
  func menuMark(_ node: Node) -> String?
  func nowMs() -> Double
  func sleep(ms: Int)
  func appState() -> JSONValue
  func permissions() -> JSONValue

  // interaction (GarageBand selects tracks / loads Library patches only for real clicks while frontmost)
  func isFrontmost() -> Bool
  /// Bring GarageBand forward (live: fixed AppleScript, no request data); remembers the previously frontmost app.
  func activateTarget() -> Bool
  /// Re-activate the app that was frontmost before `activateTarget()` (never an app named by a request).
  func restorePreviousFocus() -> Bool
  func frame(_ node: Node) -> Rect?
  func element(atX x: Double, y: Double) -> Node?
  func parent(_ node: Node) -> Node?
  func isSame(_ a: Node, _ b: Node) -> Bool
  /// System (HID) left click at a screen point; the live backend puts the pointer back afterwards. AXError-style code.
  func click(x: Double, y: Double) -> Int32
  func perform(_ node: Node, action: String) -> Int32
  /// The node belongs to GarageBand (a system-wide hit test can land on any app's UI).
  func isTargetApp(_ node: Node) -> Bool
  /// A mouse button is physically held right now (a click would break the user's drag).
  func mouseButtonDown() -> Bool
  /// Milliseconds since the user's last keyboard or mouse input.
  func msSinceUserInput() -> Double
  /// Apple Events consent for GarageBand is already granted (activation must never raise a consent prompt).
  func automationGranted() -> Bool
}

/// Where a search starts. Roots are resolved fresh on every request (no stale handles across requests).
public enum RootSpec: Equatable, Sendable {
  case app
  case mainWindow
  case dialog(title: String?, identifier: String?)
  case sheet
  case menubar
  case window(title: String)

  public static func from(_ json: JSONValue?) throws -> RootSpec {
    guard let o = json?.objectValue, let kind = o["kind"]?.stringValue else {
      throw HelperError(code: "INPUT_INVALID", message: "root must be {kind: app|main_window|dialog|sheet|menubar|window}")
    }
    switch kind {
    case "app": return .app
    case "main_window": return .mainWindow
    case "dialog": return .dialog(title: o["title"]?.stringValue, identifier: o["identifier"]?.stringValue)
    case "sheet": return .sheet
    case "menubar": return .menubar
    case "window":
      guard let t = o["title"]?.stringValue else { throw HelperError(code: "INPUT_INVALID", message: "window root needs an exact title") }
      return .window(title: t)
    default:
      throw HelperError(code: "INPUT_INVALID", message: "unknown root kind \"\(kind)\"",
                        details: ["allowed": ["app", "main_window", "dialog", "sheet", "menubar", "window"]])
    }
  }
}

/// Default subtrees never descended into: file-browser views in save panels hold thousands of rows
/// (a folder with ~17,000 entries made a whole-dialog walk take minutes).
public let defaultDialogPruneRoles: Set<String> = ["AXOutline", "AXBrowser"]
