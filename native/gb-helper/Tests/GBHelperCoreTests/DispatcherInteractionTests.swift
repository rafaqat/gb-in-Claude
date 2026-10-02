// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import XCTest
@testable import GBHelperCore

/// Interaction ops: activation, hit-tested clicks, allowlisted actions. GarageBand
/// only selects a track for a real (HID) click while it is frontmost; clicks posted to its pid are ignored.
final class DispatcherInteractionTests: XCTestCase {
  var backend: FakeBackend!
  var dispatcher: Dispatcher<FakeBackend>!
  var header: FakeNode!
  let mainWindow: JSONValue = ["kind": "main_window"]

  override func setUp() {
    backend = FakeBackend()
    let window = garageBandWindow()
    backend.windows = [window]
    header = backend.find(in: window) { $0.attrs[.description]?.hasPrefix("Track 2 ") == true }!
    header.frame = Rect(x: 0, y: 200, w: 300, h: 50)
    header.selected = false
    header.onClick = { $0.selected = true }
    backend.hitTest = { [unowned self] x, y in self.header.frame!.contains(x, y) ? self.header : nil }
    dispatcher = Dispatcher(backend: backend)
  }

  private func call(_ op: String, _ params: JSONValue) -> Response {
    dispatcher.handle(Request(id: 1, op: op, params: params, deadlineMs: 5000))
  }
  private let target: JSONValue = ["role": "AXLayoutItem", "description": "Track 2 “Taureg Moon Bass”"]

  func testActivateBringsGarageBandForwardAndConfirms() {
    let r = call("app.activate", [:])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["frontmost"], true)
    XCTAssertEqual(r.result?["changed"], true)
    XCTAssertTrue(backend.frontmost)
  }

  func testActivateFailsWhenMacOSRefuses() {
    backend.activationWorks = false
    XCTAssertEqual(call("app.activate", [:]).error?.code, "NOT_FRONTMOST")
  }

  func testRestoreFocusReturnsToTheRememberedAppOnly() {
    _ = call("app.activate", [:])
    let r = call("app.restore_focus", [:])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["restored"], true)
    XCTAssertTrue(backend.restoredPrevious)
  }

  func testClickHitsTheTargetAtTheRequestedPointAndReportsTheEffect() {
    backend.frontmost = true
    let r = call("ax.click", ["root": mainWindow, "selector": target, "at": ["fx": 0.03, "fy": 0.5]])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(backend.clicks.count, 1)
    XCTAssertEqual(backend.clicks[0].x, 9, accuracy: 0.01)
    XCTAssertEqual(backend.clicks[0].y, 225, accuracy: 0.01)
    XCTAssertEqual(r.result?["before"]?["selected"], false)
    XCTAssertEqual(r.result?["after"]?["selected"], true)
  }

  func testClickRefusesWhenGarageBandIsNotFrontmost() {
    backend.frontmost = false
    XCTAssertEqual(call("ax.click", ["root": mainWindow, "selector": target]).error?.code, "NOT_FRONTMOST")
    XCTAssertTrue(backend.clicks.isEmpty)
  }

  func testClickRefusesWhenSomethingElseIsAtThePoint() {
    backend.frontmost = true
    backend.hitTest = { _, _ in FakeNode([.role: "AXGroup", .description: "Tracks header"]) }
    XCTAssertEqual(call("ax.click", ["root": mainWindow, "selector": target]).error?.code, "HIT_TEST_MISMATCH")
    XCTAssertTrue(backend.clicks.isEmpty)
  }

  func testClickRefusesWhenAControlInsideTheTargetWouldReceiveIt() {
    backend.frontmost = true
    let mute = header.children.first { $0.attrs[.description] == "Mute" }!
    backend.hitTest = { _, _ in mute }
    XCTAssertEqual(call("ax.click", ["root": mainWindow, "selector": target]).error?.code, "HIT_TEST_MISMATCH")
    XCTAssertTrue(backend.clicks.isEmpty)
  }

  func testPerformRunsOnlyAllowlistedActions() {
    let field = FakeNode([.role: "AXTextField", .subrole: "AXSearchField"], value: "Lead", settable: true, actions: ["AXConfirm"])
    var confirmed = false
    field.onAction = { action, _ in confirmed = action == "AXConfirm" }
    backend.windows[0].children.append(field)
    let ok = call("ax.perform", ["root": mainWindow, "selector": ["subrole": "AXSearchField"], "action": "AXConfirm"])
    XCTAssertTrue(ok.ok, ok.line())
    XCTAssertTrue(confirmed)
    XCTAssertEqual(call("ax.perform", ["root": mainWindow, "selector": ["subrole": "AXSearchField"], "action": "AXDelete"]).error?.code, "INPUT_INVALID")
  }
}
