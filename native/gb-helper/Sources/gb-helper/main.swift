// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
// gb-helper: persistent JSON-lines AX helper for gb-mcp.
// stdin: one request per line. stdout: one response per line — the protocol ONLY. Logs go to stderr.
import Foundation
import GBHelperCore

setvbuf(stdout, nil, _IOLBF, 0)
let backend = LiveBackend()
let dispatcher = Dispatcher(backend: backend)
FileHandle.standardError.write(Data("[gb-helper \(helperVersion)] ready; protocol \(protocolVersion); ax_trusted=\(backend.isTrusted())\n".utf8))

while let line = readLine(strippingNewline: true) {
  if line.allSatisfy(\.isWhitespace) { continue }
  RunLoop.current.run(until: Date()) // let AppKit refresh running-application state between requests
  let response = Response.forLine(line) { dispatcher.handle($0) }
  print(response.line())
  fflush(stdout)
}
