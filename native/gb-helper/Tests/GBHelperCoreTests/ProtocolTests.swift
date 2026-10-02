// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import XCTest
@testable import GBHelperCore

final class ProtocolTests: XCTestCase {
  func testDecodesARequestLine() throws {
    let line = #"{"id":7,"op":"ax.find","params":{"root":{"kind":"main_window"},"selector":{"role":"AXSlider"}},"deadline_ms":1500}"#
    let req = try Request.decode(line: line)
    XCTAssertEqual(req.id, 7)
    XCTAssertEqual(req.op, "ax.find")
    XCTAssertEqual(req.deadlineMs, 1500)
    XCTAssertEqual(req.params["selector"]?["role"], .string("AXSlider"))
  }
}

final class ResponseEncodingTests: XCTestCase {
  func testEncodesSuccessAsOneSortedLine() {
    let line = Response.success(id: 7, result: ["count": 1, "path": "0.2"]).line()
    XCTAssertEqual(line, #"{"id":7,"ok":true,"result":{"count":1,"path":"0.2"}}"#)
  }

  func testEncodesErrorWithCodeMessageDetails() {
    let line = Response.failure(id: 3, code: "TARGET_AMBIGUOUS", message: "2 matches", details: ["count": 2]).line()
    XCTAssertEqual(line, #"{"error":{"code":"TARGET_AMBIGUOUS","details":{"count":2},"message":"2 matches"},"id":3,"ok":false}"#)
  }

  func testUnparseableLineYieldsProtocolErrorWithNullId() {
    let line = Response.forUnparseable(line: "not json").line()
    XCTAssertTrue(line.hasPrefix(#"{"error":{"code":"HELPER_PROTOCOL_ERROR""#), line)
    XCTAssertTrue(line.contains(#""id":null"#), line)
  }

  func testRejectsRequestsWithoutIdOrOp() {
    XCTAssertThrowsError(try Request.decode(line: #"{"op":"hello"}"#))
    XCTAssertThrowsError(try Request.decode(line: #"{"id":1}"#))
    XCTAssertThrowsError(try Request.decode(line: #"{"id":1,"op":"hello","params":[1]}"#))
  }
}
