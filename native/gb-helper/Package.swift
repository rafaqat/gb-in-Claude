// swift-tools-version: 6.0
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import PackageDescription

// gb-helper: persistent JSON-lines AX helper for gb-mcp .
// GBHelperCore = pure, testable logic (protocol, selectors, converge, op dispatch over an AXBackend protocol).
// gb-helper     = the executable: live AXUIElement backend, permissions, stdin/stdout loop.
let package = Package(
  name: "gb-helper",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "gb-helper", targets: ["gb-helper"])],
  targets: [
    .target(name: "GBHelperCore"),
    .executableTarget(name: "gb-helper", dependencies: ["GBHelperCore"]),
    .testTarget(name: "GBHelperCoreTests", dependencies: ["GBHelperCore"]),
  ]
)
