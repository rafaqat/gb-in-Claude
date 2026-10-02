// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation
@testable import GBHelperCore

/// Mutable in-memory accessibility tree for dispatcher tests (reference semantics, like AXUIElement handles).
final class FakeNode {
  var attrs: [AXAttr: String]
  var value: JSONValue?
  var children: [FakeNode]
  var settable: Bool
  var actions: [String]
  var enabled: Bool
  var onPress: ((FakeNode) -> Void)?
  var onSet: ((FakeNode, JSONValue) -> Void)?
  var mark: String?
  var frame: Rect?
  /// nil = the element has no AXSelected attribute.
  var selected: Bool?
  var onClick: ((FakeNode) -> Void)?
  var onAction: ((String, FakeNode) -> Void)?
  init(_ attrs: [AXAttr: String], value: JSONValue? = nil, settable: Bool = false, actions: [String] = [],
       enabled: Bool = true, children: [FakeNode] = []) {
    self.attrs = attrs; self.value = value; self.settable = settable; self.actions = actions
    self.enabled = enabled; self.children = children
  }
}

final class FakeBackend: AXBackend {
  typealias Node = FakeNode
  var running = true
  var axTrusted = true
  var windows: [FakeNode] = []
  var menuBarNode: FakeNode?
  var clockMs: Double = 0
  var pressFailure: Int32?
  /// Scheduled UI changes, fired as the virtual clock advances (dialogs appearing/closing, values changing).
  var scheduled: [(atMs: Double, change: () -> Void)] = []
  // interaction
  var frontmost = false
  var activationWorks = true
  var restoredPrevious = false
  var hitTest: ((Double, Double) -> FakeNode?)?
  var clicks: [(x: Double, y: Double)] = []
  var foreign: Set<ObjectIdentifier> = []
  var buttonDown = false
  var inputIdleMs: Double = 10_000
  var inputKeepsComing = false
  var automationOK = true
  func isTargetApp(_ node: FakeNode) -> Bool { !foreign.contains(ObjectIdentifier(node)) }
  func mouseButtonDown() -> Bool { buttonDown }
  func msSinceUserInput() -> Double { inputKeepsComing ? 100 : inputIdleMs }
  func automationGranted() -> Bool { automationOK }

  func find(in root: FakeNode, _ pred: (FakeNode) -> Bool) -> FakeNode? {
    if pred(root) { return root }
    for c in root.children { if let f = find(in: c, pred) { return f } }
    return nil
  }
  func isFrontmost() -> Bool { frontmost }
  func activateTarget() -> Bool { if activationWorks { frontmost = true }; return activationWorks }
  func restorePreviousFocus() -> Bool { restoredPrevious = true; frontmost = false; return true }
  func frame(_ node: FakeNode) -> Rect? { node.frame }
  func element(atX x: Double, y: Double) -> FakeNode? { hitTest?(x, y) }
  func parent(_ node: FakeNode) -> FakeNode? {
    for w in windows { if let p = parentOf(node, in: w) { return p } }
    return nil
  }
  private func parentOf(_ node: FakeNode, in root: FakeNode) -> FakeNode? {
    for c in root.children { if c === node { return root }; if let p = parentOf(node, in: c) { return p } }
    return nil
  }
  func isSame(_ a: FakeNode, _ b: FakeNode) -> Bool { a === b }
  func click(x: Double, y: Double) -> Int32 {
    clicks.append((x, y))
    hitTest?(x, y)?.onClick?(hitTest!(x, y)!)
    return 0
  }
  func perform(_ node: FakeNode, action: String) -> Int32 {
    guard node.actions.contains(action) else { return -25206 }
    node.onAction?(action, node)
    return 0
  }

  func children(_ node: FakeNode) -> [FakeNode] { node.children }
  func string(_ node: FakeNode, _ attr: AXAttr) -> String? { node.attrs[attr] }
  func value(_ node: FakeNode) -> JSONValue? { node.value }

  func info(_ node: FakeNode) -> NodeInfo {
    NodeInfo(settable: node.settable, enabled: node.enabled, actions: node.actions, min: nil, max: nil, help: nil, selected: node.selected)
  }
  func application() -> FakeNode? { running ? FakeNode([.role: "AXApplication"], children: windows) : nil }
  func allWindows() -> [FakeNode] { running ? windows : [] }
  func menuBar() -> FakeNode? { running ? menuBarNode : nil }
  func isRunning() -> Bool { running }
  func isTrusted() -> Bool { axTrusted }
  func press(_ node: FakeNode) -> Int32 {
    if let f = pressFailure { return f }
    node.onPress?(node)
    return 0
  }
  func setValue(_ node: FakeNode, _ value: JSONValue) -> Int32 {
    guard node.settable else { return -25205 }
    if let hook = node.onSet { hook(node, value) } else { node.value = value }
    return 0
  }
  func isSettable(_ node: FakeNode) -> Bool { node.settable }
  func nowMs() -> Double { clockMs }
  func sleep(ms: Int) {
    clockMs += Double(ms)
    let due = scheduled.filter { $0.atMs <= clockMs }
    scheduled.removeAll { $0.atMs <= clockMs }
    due.forEach { $0.change() }
  }
  func menuMark(_ node: FakeNode) -> String? { node.mark }
  func appState() -> JSONValue { ["running": .bool(running)] }
  func permissions() -> JSONValue { ["accessibility": .bool(axTrusted)] }
}

/// A small GarageBand-shaped window: Control Bar (tempo, play, library) + two track headers.
func garageBandWindow() -> FakeNode {
  let tempo = FakeNode([.role: "AXSlider", .description: "Tempo"], value: 120, settable: true, actions: ["AXIncrement", "AXDecrement"])
  tempo.onSet = { node, target in // one step per set
    guard let v = node.value?.numberValue, let t = target.numberValue else { return }
    node.value = .number(v < t ? v + 1 : (v > t ? v - 1 : v))
  }
  let play = FakeNode([.role: "AXCheckBox", .title: "Play", .description: "Play"], value: 0, actions: ["AXPress"])
  play.onPress = { n in n.value = n.value == 0 ? 1 : 0 }
  let library = FakeNode([.role: "AXCheckBox", .title: "Library", .description: "Library"], value: 0, actions: ["AXPress"])
  library.onPress = { n in n.value = n.value == 0 ? 1 : 0 }
  func track(_ n: Int, _ name: String) -> FakeNode {
    let mute = FakeNode([.role: "AXCheckBox", .description: "Mute"], value: 0, actions: ["AXPress"])
    let item = FakeNode([.role: "AXLayoutItem", .description: "Track \(n) “\(name)”"], children: [
      mute,
      FakeNode([.role: "AXSlider"], value: 64, settable: true),
      FakeNode([.role: "AXSlider", .description: "Volume"], value: 173, settable: true),
    ])
    mute.onPress = { m in // GarageBand appends ", mute" to the track description
      m.value = m.value == 0 ? 1 : 0
      item.attrs[.description] = "Track \(n) “\(name)”" + (m.value == 1 ? ", mute" : "")
    }
    return item
  }
  return FakeNode([.role: "AXWindow", .subrole: "AXStandardWindow", .title: "Untitled - Tracks"], children: [
    FakeNode([.role: "AXGroup", .description: "Control Bar"], children: [
      FakeNode([.role: "AXGroup", .description: "Control Bar"], children: [tempo]),
      play, library,
    ]),
    FakeNode([.role: "AXGroup", .description: "Tracks header"], children: [track(1, "Soft Saw Lead"), track(2, "Taureg Moon Bass")]),
  ])
}

/// GarageBand-like menu bar: Share ▸ Export Song to Disk…, Record ▸ Count-in ▸ {None, 1 Bar ✓, 2 Bars}, Track ▸ Delete Track (disabled).
func garageBandMenuBar(onExport: @escaping () -> Void) -> FakeNode {
  func item(_ title: String, enabled: Bool = true, mark: String? = nil, submenu: [FakeNode]? = nil, press: (() -> Void)? = nil) -> FakeNode {
    let n = FakeNode([.role: "AXMenuItem", .title: title], actions: ["AXPress"], enabled: enabled,
                     children: submenu.map { [FakeNode([.role: "AXMenu"], children: $0)] } ?? [])
    n.mark = mark
    if let press { n.onPress = { _ in press() } }
    return n
  }
  func barItem(_ title: String, _ items: [FakeNode]) -> FakeNode {
    FakeNode([.role: "AXMenuBarItem", .title: title], actions: ["AXPress"], children: [FakeNode([.role: "AXMenu"], children: items)])
  }
  return FakeNode([.role: "AXMenuBar"], children: [
    barItem("Share", [item("Song to Music"), FakeNode([.role: "AXMenuItem", .title: ""]), item("Export Song to Disk…", press: onExport)]),
    barItem("Record", [item("Count-in", submenu: [item("None"), item("1 Bar", mark: "✓"), item("2 Bars")])]),
    barItem("Track", [item("Delete Track", enabled: false)]),
  ])
}
