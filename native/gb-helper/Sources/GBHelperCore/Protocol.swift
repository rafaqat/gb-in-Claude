// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation

/// One request line: `{"id":n,"op":"...","params":{...},"deadline_ms":n}`.
public struct Request: Equatable, Sendable {
  public let id: Int
  public let op: String
  public let params: JSONValue
  public let deadlineMs: Int

  public static let defaultDeadlineMs = 2_000
  public static let maxDeadlineMs = 120_000

  public static func decode(line: String) throws -> Request {
    try decode(value: try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)))
  }

  public static func decode(value: JSONValue) throws -> Request {
    guard let id = value["id"]?.intValue else { throw ProtocolError.invalid("missing integer id") }
    guard let op = value["op"]?.stringValue, !op.isEmpty else { throw ProtocolError.invalid("missing op") }
    let params = value["params"] ?? .object([:])
    guard params.objectValue != nil else { throw ProtocolError.invalid("params must be an object") }
    let deadline = value["deadline_ms"]?.intValue ?? defaultDeadlineMs
    return Request(id: id, op: op, params: params, deadlineMs: min(max(deadline, 1), maxDeadlineMs))
  }
}

public enum ProtocolError: Error, Equatable {
  case invalid(String)
}

/// One response line: success `{"id","ok":true,"result"}` or failure `{"id","ok":false,"error":{code,message,details}}`.
public struct Response: Equatable, Sendable {
  public let id: Int?
  public let ok: Bool
  public let result: JSONValue?
  public let error: HelperError?

  public static func success(id: Int, result: JSONValue) -> Response {
    Response(id: id, ok: true, result: result, error: nil)
  }

  public static func failure(id: Int?, code: String, message: String, details: JSONValue? = nil) -> Response {
    Response(id: id, ok: false, result: nil, error: HelperError(code: code, message: message, details: details))
  }

  public static func failure(id: Int?, _ error: HelperError) -> Response {
    Response(id: id, ok: false, result: nil, error: error)
  }

  public static let maxLineBytes = 1_000_000

  /// Full line handling: size cap, JSON parse, request validation (answering with the id when one exists), dispatch.
  public static func forLine(_ line: String, dispatch: (Request) -> Response) -> Response {
    if line.utf8.count > maxLineBytes {
      return failure(id: nil, code: "HELPER_PROTOCOL_ERROR", message: "request exceeds \(maxLineBytes) bytes")
    }
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)) else { return forUnparseable(line: line) }
    do {
      return dispatch(try Request.decode(value: value))
    } catch ProtocolError.invalid(let why) {
      return failure(id: value["id"]?.intValue, code: "HELPER_PROTOCOL_ERROR", message: why)
    } catch {
      return failure(id: value["id"]?.intValue, code: "HELPER_PROTOCOL_ERROR", message: "invalid request")
    }
  }

  public static func forUnparseable(line: String) -> Response {
    failure(id: nil, code: "HELPER_PROTOCOL_ERROR", message: "request is not valid JSON-lines protocol",
            details: ["length": .number(Double(line.utf8.count))])
  }

  public func toJSON() -> JSONValue {
    var o: [String: JSONValue] = ["id": id.map { .number(Double($0)) } ?? .null, "ok": .bool(ok)]
    if let result { o["result"] = result }
    if let error {
      var e: [String: JSONValue] = ["code": .string(error.code), "message": .string(error.message)]
      if let d = error.details { e["details"] = d }
      o["error"] = .object(e)
    }
    return .object(o)
  }

  /// Single line, sorted keys, no escaped slashes: the stdout wire format.
  public func line() -> String { JSONValue.encodeLine(toJSON()) }
}

public struct HelperError: Error, Equatable, Sendable {
  public let code: String
  public let message: String
  public let details: JSONValue?
  public init(code: String, message: String, details: JSONValue? = nil) {
    self.code = code
    self.message = message
    self.details = details
  }
}

extension JSONValue {
  public static func encodeLine(_ value: JSONValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value), let s = String(data: data, encoding: .utf8) else {
      return #"{"error":{"code":"HELPER_PROTOCOL_ERROR","message":"encode failed"},"id":null,"ok":false}"#
    }
    return s
  }
}
