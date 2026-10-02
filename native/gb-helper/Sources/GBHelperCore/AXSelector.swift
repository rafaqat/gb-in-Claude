// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation

/// A structured selector. Every given field must match EXACTLY (no substring/prefix/fuzzy).
/// "" matches an absent or empty attribute (e.g. GarageBand's pan slider has no description).
/// `ancestors` must match ancestors of the candidate in outer→inner order (the search root counts).
public struct AXSelector: Equatable, Sendable {
  public var fields: [AXAttr: String] = [:]
  public var value: JSONValue?
  public var ancestors: [AXSelector] = []
  public var index: Int?

  static let knownKeys: Set<String> = ["role", "subrole", "title", "description", "identifier", "value", "ancestors", "index"]

  public static func from(_ json: JSONValue) throws -> AXSelector {
    guard let o = json.objectValue else { throw HelperError(code: "INPUT_INVALID", message: "selector must be an object") }
    if let unknown = o.keys.first(where: { !knownKeys.contains($0) }) {
      throw HelperError(code: "INPUT_INVALID", message: "unknown selector field \"\(unknown)\"",
                        details: ["allowed": .array(knownKeys.sorted().map { .string($0) })])
    }
    var s = AXSelector()
    for attr in AXAttr.allCases {
      if let v = o[attr.rawValue] {
        guard let str = v.stringValue else { throw HelperError(code: "INPUT_INVALID", message: "\(attr.rawValue) must be a string") }
        s.fields[attr] = str
      }
    }
    s.value = o["value"]
    if let anc = o["ancestors"] {
      guard let arr = anc.arrayValue else { throw HelperError(code: "INPUT_INVALID", message: "ancestors must be an array") }
      s.ancestors = try arr.map { try AXSelector.from($0) }
    }
    if let idx = o["index"] {
      guard let i = idx.intValue, i >= 0 else { throw HelperError(code: "INPUT_INVALID", message: "index must be a non-negative integer") }
      s.index = i
    }
    if s.fields.isEmpty && s.value == nil {
      throw HelperError(code: "INPUT_INVALID", message: "selector needs at least one of role/subrole/title/description/identifier/value")
    }
    return s
  }

  /// Does this node itself satisfy the field/value constraints (ancestors are checked by the walker)?
  public func matchesNode<T: AXTreeReader>(_ tree: T, _ node: T.Node) -> Bool {
    for (attr, want) in fields {
      let actual = tree.string(node, attr) ?? ""
      if actual != want { return false }
    }
    if let want = value, tree.value(node) != want { return false }
    return true
  }

  /// Ancestor constraints as an in-order subsequence of the chain root…parent.
  public func ancestorsSatisfied<T: AXTreeReader>(_ tree: T, chain: [T.Node]) -> Bool {
    var i = 0
    for node in chain where i < ancestors.count {
      if ancestors[i].matchesNode(tree, node) { i += 1 }
    }
    return i == ancestors.count
  }
}

public struct SearchOptions: Sendable {
  public var maxDepth: Int
  public var maxNodes: Int
  public var pruneRoles: Set<String>
  public init(maxDepth: Int = 24, maxNodes: Int = 20_000, pruneRoles: Set<String> = []) {
    self.maxDepth = maxDepth
    self.maxNodes = maxNodes
    self.pruneRoles = pruneRoles
  }
}

public struct Match<N> {
  public let node: N
  public let path: String
}

public struct SearchResult<N> {
  public var matches: [Match<N>]
  public var visited: Int
  public var truncated: Bool
  public var deadlineExceeded: Bool
}

/// Pre-order walk from `root`; returns matches in document order (then applies `index`).
/// `isExpired` is polled as the walk proceeds so a request can never outlive its deadline.
public func findAll<T: AXTreeReader>(
  tree: T, root: T.Node, selector: AXSelector, options: SearchOptions = SearchOptions(),
  isExpired: () -> Bool = { false }
) -> SearchResult<T.Node> {
  var result = SearchResult<T.Node>(matches: [], visited: 0, truncated: false, deadlineExceeded: false)
  var chain: [T.Node] = []

  func visit(_ node: T.Node, _ path: String, _ depth: Int) {
    if result.truncated || result.deadlineExceeded { return }
    if result.visited >= options.maxNodes { result.truncated = true; return }
    if result.visited % 64 == 0, isExpired() { result.deadlineExceeded = true; return }
    result.visited += 1
    if selector.matchesNode(tree, node), selector.ancestorsSatisfied(tree, chain: chain) {
      result.matches.append(Match(node: node, path: path))
    }
    let role = tree.string(node, .role) ?? ""
    guard depth < options.maxDepth, !options.pruneRoles.contains(role) else { return }
    chain.append(node)
    for (i, child) in tree.children(node).enumerated() {
      visit(child, path.isEmpty ? "\(i)" : "\(path).\(i)", depth + 1)
    }
    chain.removeLast()
  }

  visit(root, "", 0)
  if let index = selector.index {
    result.matches = result.matches.indices.contains(index) ? [result.matches[index]] : []
  }
  return result
}
