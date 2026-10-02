// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import XCTest
@testable import GBHelperCore

final class SelectorVectorTests: XCTestCase {
  private func vectors() throws -> JSONValue {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("vectors/selector-cases.json")
    return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
  }

  func testSharedSelectorCases() throws {
    let v = try vectors()
    let tree = JSONTree(root: v["tree"]!)
    for c in v["cases"]!.arrayValue! {
      let name = c["name"]!.stringValue!
      let selector = try AXSelector.from(c["selector"]!)
      let root = tree.node(atPath: c["root"]?.stringValue ?? "")!
      let prune = Set((c["prune_roles"]?.arrayValue ?? []).compactMap(\.stringValue))
      let found = findAll(tree: tree, root: root, selector: selector, options: SearchOptions(pruneRoles: prune))
      let paths = found.matches.map(\.path)
      let expected = c["expect"]!.arrayValue!.compactMap(\.stringValue)
      XCTAssertEqual(paths, expected, name)
    }
  }

  func testInvalidSelectorsAreRejected() throws {
    for c in try vectors()["invalid_selectors"]!.arrayValue! {
      XCTAssertThrowsError(try AXSelector.from(c["selector"]!), c["name"]!.stringValue!)
    }
  }
}
