// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import XCTest
@testable import GBHelperCore

final class DispatcherActionTests: XCTestCase {
  var backend: FakeBackend!
  var dispatcher: Dispatcher<FakeBackend>!
  let mainWindow: JSONValue = ["kind": "main_window"]

  override func setUp() {
    backend = FakeBackend()
    backend.windows = [garageBandWindow()]
    dispatcher = Dispatcher(backend: backend)
  }

  private func call(_ op: String, _ params: JSONValue, deadline: Int = 5000) -> Response {
    dispatcher.handle(Request(id: 1, op: op, params: params, deadlineMs: deadline))
  }

  // MARK: press

  func testPressReturnsBeforeAndAfter() {
    let r = call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "title": "Play"]])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["before"]?["value"], 0)
    XCTAssertEqual(r.result?["after"]?["value"], 1)
  }

  func testPressRefusesAmbiguousTargetsAndListsCandidates() {
    let r = call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "description": "Mute"]])
    XCTAssertEqual(r.error?.code, "TARGET_AMBIGUOUS")
    XCTAssertEqual(r.error?.details?["candidates"]?.arrayValue?.count, 2)
  }

  func testPressNotFoundOffersSameRoleHints() {
    let r = call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "title": "Plya"]])
    XCTAssertEqual(r.error?.code, "TARGET_NOT_FOUND")
    let hints = r.error?.details?["similar"]?.arrayValue?.compactMap { $0["title"]?.stringValue } ?? []
    XCTAssertTrue(hints.contains("Play"), "\(hints)")
  }

  func testPressRefusesWhenIdentityChangedSinceResolve() {
    let r = call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "title": "Play"],
                              "expect": ["path": "0.1", "desc": "Record"]])
    XCTAssertEqual(r.error?.code, "TARGET_CHANGED")
    XCTAssertEqual(r.error?.details?["actual"]?["desc"], "Play")
  }

  func testPressRefusesDisabledControls() {
    backend.windows[0].children[0].children[1].enabled = false // Play disabled
    let r = call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "title": "Play"]])
    XCTAssertEqual(r.error?.code, "TARGET_DISABLED")
    XCTAssertEqual(backend.windows[0].children[0].children[1].value, 0, "must not press")
  }

  func testPressMapsAXErrors() {
    backend.pressFailure = -25204 // kAXErrorCannotComplete: app did not answer in time
    XCTAssertEqual(call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "title": "Play"]]).error?.code, "DEADLINE_EXCEEDED")
    backend.pressFailure = -25202 // kAXErrorInvalidUIElement: element went away
    XCTAssertEqual(call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "title": "Play"]]).error?.code, "TARGET_CHANGED")
    backend.pressFailure = -25211 // kAXErrorAPIDisabled
    XCTAssertEqual(call("ax.press", ["root": mainWindow, "selector": ["role": "AXCheckBox", "title": "Play"]]).error?.code, "PERMISSION_AX_DENIED")
  }

  // MARK: set

  func testSetWritesOnceAndReadsBack() {
    let r = call("ax.set", ["root": mainWindow, "value": 150,
                            "selector": ["role": "AXSlider", "description": "Volume", "ancestors": [["description": "Track 1 “Soft Saw Lead”"]]]])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["before"], 173)
    XCTAssertEqual(r.result?["after"], 150)
    XCTAssertEqual(r.result?["requested"], 150)
  }

  func testSetOnAStepwiseSliderReportsTheTruthNotTheRequest() {
    let r = call("ax.set", ["root": mainWindow, "value": 98, "selector": ["role": "AXSlider", "description": "Tempo"]])
    XCTAssertTrue(r.ok)
    XCTAssertEqual(r.result?["after"], 119, "one step only — the caller must converge")
  }

  func testSetRefusesNonSettableTargets() {
    let r = call("ax.set", ["root": mainWindow, "value": 1, "selector": ["role": "AXCheckBox", "title": "Play"]])
    XCTAssertEqual(r.error?.code, "NOT_SETTABLE")
  }

  // MARK: converge

  func testConvergeDrivesTheStepwiseTempoSliderToTarget() {
    let r = call("ax.converge", ["root": mainWindow, "target": 98, "selector": ["role": "AXSlider", "description": "Tempo"]])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["converged"], true)
    XCTAssertEqual(r.result?["before"], 120)
    XCTAssertEqual(r.result?["after"], 98)
    XCTAssertEqual(r.result?["steps"], 22)
  }

  func testConvergeReportsPartialProgressAtTheDeadline() {
    let r = call("ax.converge", ["root": mainWindow, "target": 98, "settle_ms": 100,
                                 "selector": ["role": "AXSlider", "description": "Tempo"]], deadline: 500)
    XCTAssertTrue(r.ok)
    XCTAssertEqual(r.result?["converged"], false)
    XCTAssertEqual(r.result?["deadline_exceeded"], true)
    XCTAssertLessThan(r.result?["after"]?.numberValue ?? 0, 120)
  }

  func testConvergeNeedsANumericTarget() {
    XCTAssertEqual(call("ax.converge", ["root": mainWindow, "target": "fast", "selector": ["role": "AXSlider", "description": "Tempo"]]).error?.code, "INPUT_INVALID")
  }
}
