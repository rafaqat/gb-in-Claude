// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation

/// A JSON value: the helper's protocol is dynamic JSON, decoded into this closed type (never `Any`).
public enum JSONValue: Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
  public var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
  public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
  public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
  public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
  public var intValue: Int? {
    guard let n = numberValue, n.rounded() == n, abs(n) < 9.0e15 else { return nil }
    return Int(n)
  }
}

extension JSONValue: Codable {
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
    else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value") }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n):
      if n.rounded() == n, abs(n) < 9.0e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
  ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
  public init(stringLiteral value: String) { self = .string(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }
  public init(nilLiteral: ()) { self = .null }
}
