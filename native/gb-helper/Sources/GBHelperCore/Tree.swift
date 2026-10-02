// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation

/// The attributes selectors can match on (exact equality only).
public enum AXAttr: String, Sendable, CaseIterable {
  case role, subrole, title, description, identifier
}

/// Read-only access to an accessibility tree. Implemented by the live AXUIElement backend and by `JSONTree` (tests, fixtures).
public protocol AXTreeReader {
  associatedtype Node
  func children(_ node: Node) -> [Node]
  func string(_ node: Node, _ attr: AXAttr) -> String?
  func value(_ node: Node) -> JSONValue?
}

/// An in-memory tree in the fixture format: `{role, subrole?, title?, desc?, id?, value?, children?}`.
public struct JSONTree: AXTreeReader {
  public struct Node: Sendable { public let json: JSONValue }
  public let root: Node

  public init(root: JSONValue) { self.root = Node(json: root) }

  public func children(_ node: Node) -> [Node] { (node.json["children"]?.arrayValue ?? []).map(Node.init) }

  public func string(_ node: Node, _ attr: AXAttr) -> String? {
    let key: String
    switch attr {
    case .role: key = "role"
    case .subrole: key = "subrole"
    case .title: key = "title"
    case .description: key = "desc"
    case .identifier: key = "id"
    }
    return node.json[key]?.stringValue
  }

  public func value(_ node: Node) -> JSONValue? { node.json["value"] }

  /// "" = root; "1.0.2" = root.children[1].children[0].children[2].
  public func node(atPath path: String) -> Node? {
    var current = root
    for part in path.split(separator: ".") {
      guard let i = Int(part), let next = children(current)[safe: i] else { return nil }
      current = next
    }
    return current
  }
}

extension Array {
  subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
