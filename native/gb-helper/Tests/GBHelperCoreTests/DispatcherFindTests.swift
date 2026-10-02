// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import XCTest
@testable import GBHelperCore

final class DispatcherFindTests: XCTestCase {
  var backend: FakeBackend!
  var dispatcher: Dispatcher<FakeBackend>!

  override func setUp() {
    backend = FakeBackend()
    backend.windows = [garageBandWindow()]
    dispatcher = Dispatcher(backend: backend)
  }

  private func call(_ op: String, _ params: JSONValue, deadline: Int = 2000) -> Response {
    dispatcher.handle(Request(id: 1, op: op, params: params, deadlineMs: deadline))
  }

  func testFindReturnsMatchesWithPathsAndCompactNodes() {
    let r = call("ax.find", ["root": ["kind": "main_window"], "selector": ["role": "AXSlider", "description": "Volume"]])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["count"], 2)
    let first = r.result?["matches"]?.arrayValue?.first
    XCTAssertEqual(first?["path"], "1.0.2")
    XCTAssertEqual(first?["role"], "AXSlider")
    XCTAssertEqual(first?["desc"], "Volume")
    XCTAssertEqual(first?["value"], 173)
    XCTAssertEqual(first?["settable"], true)
  }

  func testGarageBandNotRunning() {
    backend.running = false
    let r = call("ax.find", ["root": ["kind": "main_window"], "selector": ["role": "AXSlider"]])
    XCTAssertEqual(r.error?.code, "GB_NOT_RUNNING")
  }

  func testAccessibilityNotTrusted() {
    backend.axTrusted = false
    let r = call("ax.find", ["root": ["kind": "main_window"], "selector": ["role": "AXSlider"]])
    XCTAssertEqual(r.error?.code, "PERMISSION_AX_DENIED")
  }

  func testInvalidSelectorIsInputInvalid() {
    let r = call("ax.find", ["root": ["kind": "main_window"], "selector": ["desc": "Tempo"]])
    XCTAssertEqual(r.error?.code, "INPUT_INVALID")
  }

  func testUnknownRootKind() {
    let r = call("ax.find", ["root": ["kind": "finder"], "selector": ["role": "AXSlider"]])
    XCTAssertEqual(r.error?.code, "INPUT_INVALID")
  }

  func testUnknownOp() {
    XCTAssertEqual(call("shell.exec", [:]).error?.code, "UNKNOWN_OP")
  }
}

final class RootRefinementTests: XCTestCase {
  func testRootCanBeNarrowedToOnePanelElement() {
    let backend = FakeBackend()
    backend.windows = [garageBandWindow()]
    let r = Dispatcher(backend: backend).handle(Request(id: 1, op: "ax.find", params: [
      "root": ["kind": "main_window", "element": ["role": "AXGroup", "description": "Tracks header"]],
      "selector": ["role": "AXSlider", "description": "Volume"],
    ], deadlineMs: 2000))
    XCTAssertEqual(r.result?["matches"]?.arrayValue?.map { $0["path"] }, ["0.2", "1.2"], r.line())
  }

  func testAmbiguousPanelRootIsRefused() {
    let backend = FakeBackend()
    backend.windows = [garageBandWindow()]
    let r = Dispatcher(backend: backend).handle(Request(id: 1, op: "ax.find", params: [
      "root": ["kind": "main_window", "element": ["role": "AXGroup", "description": "Control Bar"]],
      "selector": ["role": "AXSlider"],
    ], deadlineMs: 2000))
    XCTAssertEqual(r.error?.code, "TARGET_AMBIGUOUS", "two nested groups share the description: the caller must say which")
  }
}

final class LineHandlingTests: XCTestCase {
  func testInvalidRequestWithAnIdIsAnsweredWithThatId() {
    let r = Response.forLine(#"{"id":9,"op":""}"#) { _ in XCTFail("must not dispatch"); return .success(id: 0, result: nil) }
    XCTAssertEqual(r.id, 9)
    XCTAssertEqual(r.error?.code, "HELPER_PROTOCOL_ERROR")
  }

  func testValidRequestIsDispatched() {
    let r = Response.forLine(#"{"id":4,"op":"hello"}"#) { req in .success(id: req.id, result: ["op": .string(req.op)]) }
    XCTAssertEqual(r.result?["op"], "hello")
  }

  func testOversizedLinesAreRefusedWithoutParsing() {
    let r = Response.forLine(String(repeating: "x", count: 2_000_001)) { _ in XCTFail(); return .success(id: 0, result: nil) }
    XCTAssertEqual(r.error?.code, "HELPER_PROTOCOL_ERROR")
  }
}
