// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation

public let helperVersion = "0.1.0"
public let protocolVersion = 1

/// Executes one request against a backend. Never throws: every failure becomes an error response.
public final class Dispatcher<B: AXBackend> {
  let backend: B

  public init(backend: B) { self.backend = backend }

  public func handle(_ req: Request) -> Response {
    let deadline = Deadline(startMs: backend.nowMs(), budgetMs: Double(req.deadlineMs), now: backend.nowMs)
    do {
      return .success(id: req.id, result: try run(req.op, req.params, deadline))
    } catch let e as HelperError {
      return .failure(id: req.id, e)
    } catch {
      return .failure(id: req.id, code: "HELPER_INTERNAL", message: "unexpected error")
    }
  }

  func run(_ op: String, _ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    switch op {
    case "ax.find": return try find(p, d)
    case "ax.press": return try press(p, d)
    case "ax.set": return try set(p, d)
    case "ax.converge": return try convergeOp(p, d)
    case "ax.menu": return try menu(p, d)
    case "ax.wait": return try wait(p, d)
    case "ax.snapshot": return try snapshot(p, d)
    case "hello":
      return ["version": .string(helperVersion), "protocol": .number(Double(protocolVersion)),
              "pid": .number(Double(ProcessInfo.processInfo.processIdentifier)), "ax_trusted": .bool(backend.isTrusted())]
    case "perm.check": return backend.permissions()
    case "app.state": return backend.appState()
    case "app.activate": return try activate(d)
    case "app.restore_focus": return ["restored": .bool(backend.restorePreviousFocus())]
    case "ax.click": return try click(p, d)
    case "ax.perform": return try perform(p, d)
    default:
      throw HelperError(code: "UNKNOWN_OP", message: "unknown op \"\(op)\"")
    }
  }

  // MARK: - plumbing

  func requireAX() throws {
    guard backend.isTrusted() else {
      throw HelperError(code: "PERMISSION_AX_DENIED", message: "Accessibility permission is not granted to the helper's responsible app")
    }
    guard backend.isRunning() else { throw HelperError(code: "GB_NOT_RUNNING", message: "GarageBand is not running") }
  }

  /// Resolve `p["root"]`: a base root plus an optional `element` selector narrowing it to exactly one node (a panel).
  func resolveRootParam(_ rootJSON: JSONValue?, _ d: Deadline) throws -> (spec: RootSpec, node: B.Node) {
    let spec = try RootSpec.from(rootJSON)
    let base = try resolveRoot(spec)
    guard let elementJSON = rootJSON?["element"] else { return (spec, base) }
    let selector = try AXSelector.from(elementJSON)
    var prune: Set<String> = []
    if case .dialog = spec { prune = defaultDialogPruneRoles }
    let found = findAll(tree: backend, root: base, selector: selector, options: SearchOptions(pruneRoles: prune), isExpired: d.isExpired)
    if found.deadlineExceeded { throw HelperError(code: "DEADLINE_EXCEEDED", message: "root element search did not finish within the deadline") }
    guard found.matches.count == 1 else {
      throw HelperError(code: found.matches.isEmpty ? "TARGET_NOT_FOUND" : "TARGET_AMBIGUOUS",
                        message: "root element: \(found.matches.count) matches (need exactly one)",
                        details: ["count": .number(Double(found.matches.count)),
                                  "candidates": .array(found.matches.prefix(6).map { .object(compact($0.node, path: $0.path)) })])
    }
    return (spec, found.matches[0].node)
  }

  func resolveRoot(_ spec: RootSpec) throws -> B.Node {
    let windows = backend.allWindows()
    func exactlyOne(_ found: [B.Node], _ what: String) throws -> B.Node {
      if found.count == 1 { return found[0] }
      throw HelperError(code: found.isEmpty ? "TARGET_NOT_FOUND" : "TARGET_AMBIGUOUS",
                        message: found.isEmpty ? "no \(what)" : "\(found.count) \(what)s",
                        details: ["root": .string(what), "count": .number(Double(found.count))])
    }
    switch spec {
    case .app:
      guard let app = backend.application() else { throw HelperError(code: "GB_NOT_RUNNING", message: "GarageBand is not running") }
      return app
    case .mainWindow:
      // The project chooser ("Choose a Project") is also a standard window: never the project.
      // Several project windows: refuse rather than pick one (exactly-one rule).
      let projects = windows.filter { backend.string($0, .subrole) == "AXStandardWindow" && backend.string($0, .identifier) != projectChooserId }
      return try exactlyOne(projects, "main window")
    case .dialog(let title, let identifier):
      let dialogs = windows.filter {
        ["AXDialog", "AXSystemDialog"].contains(backend.string($0, .subrole) ?? "")
          && (title == nil || backend.string($0, .title) == title)
          && (identifier == nil || backend.string($0, .identifier) == identifier)
      }
      return try exactlyOne(dialogs, "dialog")
    case .sheet:
      return try exactlyOne(windows.flatMap { backend.children($0).filter { backend.string($0, .role) == "AXSheet" } }, "sheet")
    case .menubar:
      guard let bar = backend.menuBar() else { throw HelperError(code: "TARGET_NOT_FOUND", message: "no menu bar") }
      return bar
    case .window(let title):
      return try exactlyOne(windows.filter { backend.string($0, .title) == title }, "window titled \(title)")
    }
  }

  func searchOptions(_ p: JSONValue, root: RootSpec, defaultDepth: Int, defaultNodes: Int) throws -> SearchOptions {
    var prune: Set<String> = []
    if case .dialog = root { prune = defaultDialogPruneRoles }
    if let list = p["prune_roles"] {
      guard let arr = list.arrayValue else { throw HelperError(code: "INPUT_INVALID", message: "prune_roles must be an array of roles") }
      prune = Set(arr.compactMap(\.stringValue))
    }
    let depth = min(max(p["depth"]?.intValue ?? defaultDepth, 1), 32)
    let nodes = min(max(p["max_nodes"]?.intValue ?? defaultNodes, 1), 50_000)
    return SearchOptions(maxDepth: depth, maxNodes: nodes, pruneRoles: prune)
  }

  /// Compact node: only meaningful fields (protects the agent's context window).
  func compact(_ node: B.Node, path: String, includeHelp: Bool = false) -> [String: JSONValue] {
    var o: [String: JSONValue] = ["path": .string(path)]
    let keys: [(AXAttr, String)] = [(.role, "role"), (.subrole, "subrole"), (.title, "title"), (.description, "desc"), (.identifier, "id")]
    for (attr, key) in keys {
      if let v = backend.string(node, attr), !v.isEmpty { o[key] = .string(v) }
    }
    if let v = backend.value(node) { o["value"] = v }
    let info = backend.info(node)
    if !info.enabled { o["enabled"] = false }
    if info.settable { o["settable"] = true }
    let actions = info.actions.filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
    if !actions.isEmpty { o["actions"] = .array(actions.map { .string($0) }) }
    if let m = info.min { o["min"] = m }
    if let m = info.max { o["max"] = m }
    if includeHelp, let h = info.help, !h.isEmpty { o["help"] = .string(h) }
    if let sel = info.selected { o["selected"] = .bool(sel) }
    return o
  }

  // MARK: - ops

  func find(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    try requireAX()
    guard let selJSON = p["selector"] else { throw HelperError(code: "INPUT_INVALID", message: "selector is required") }
    let selector = try AXSelector.from(selJSON)
    let (rootSpec, root) = try resolveRootParam(p["root"], d)
    let options = try searchOptions(p, root: rootSpec, defaultDepth: 24, defaultNodes: 20_000)
    let found = findAll(tree: backend, root: root, selector: selector, options: options, isExpired: d.isExpired)
    if found.deadlineExceeded { throw HelperError(code: "DEADLINE_EXCEEDED", message: "search did not finish within the deadline", details: ["visited": .number(Double(found.visited))]) }
    let maxResults = min(max(p["max_results"]?.intValue ?? 20, 1), 200)
    return [
      "count": .number(Double(found.matches.count)),
      "matches": .array(found.matches.prefix(maxResults).map { .object(compact($0.node, path: $0.path)) }),
      "truncated": .bool(found.truncated),
      "visited": .number(Double(found.visited)),
    ]
  }
}

// MARK: - targeting & actions

extension Dispatcher {
  /// Resolve exactly one element or refuse: ambiguity lists candidates; absence lists same-role "similar" nodes.
  func resolveOne(_ p: JSONValue, _ d: Deadline) throws -> (node: B.Node, path: String) {
    try requireAX()
    guard let selJSON = p["selector"] else { throw HelperError(code: "INPUT_INVALID", message: "selector is required") }
    let selector = try AXSelector.from(selJSON)
    let (rootSpec, root) = try resolveRootParam(p["root"], d)
    let options = try searchOptions(p, root: rootSpec, defaultDepth: 24, defaultNodes: 20_000)
    let found = findAll(tree: backend, root: root, selector: selector, options: options, isExpired: d.isExpired)
    if found.deadlineExceeded { throw HelperError(code: "DEADLINE_EXCEEDED", message: "target search did not finish within the deadline") }
    if found.matches.count == 1 {
      let m = found.matches[0]
      try verifyIdentity(m.node, path: m.path, expect: p["expect"])
      return (m.node, m.path)
    }
    if found.matches.isEmpty {
      var similar: [JSONValue] = []
      if let role = selector.fields[.role] {
        var loose = AXSelector()
        loose.fields[.role] = role
        let near = findAll(tree: backend, root: root, selector: loose, options: options, isExpired: d.isExpired)
        similar = near.matches.prefix(8).map { .object(compact($0.node, path: $0.path)) }
      }
      throw HelperError(code: "TARGET_NOT_FOUND", message: "no element matches the selector",
                        details: ["similar": .array(similar)])
    }
    throw HelperError(code: "TARGET_AMBIGUOUS", message: "\(found.matches.count) elements match; refine the selector (ancestors/identifier/index)",
                      details: ["count": .number(Double(found.matches.count)),
                                "candidates": .array(found.matches.prefix(6).map { .object(compact($0.node, path: $0.path)) })])
  }

  /// Identity re-verification right before acting: every field the caller expects must still hold.
  func verifyIdentity(_ node: B.Node, path: String, expect: JSONValue?) throws {
    guard let expected = expect?.objectValue else { return }
    let actual = compact(node, path: path)
    for (key, want) in expected where ["path", "role", "subrole", "title", "desc", "id"].contains(key) {
      if (actual[key] ?? .string("")) != want {
        throw HelperError(code: "TARGET_CHANGED", message: "the target changed since it was resolved (\(key))",
                          details: ["expected": .object(expected), "actual": .object(actual)])
      }
    }
  }

  func settleMs(_ p: JSONValue, default def: Int) -> Int { min(max(p["settle_ms"]?.intValue ?? def, 0), 2_000) }

  func isValid(_ node: B.Node) -> Bool { backend.string(node, .role) != nil }

  func press(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    let (node, path) = try resolveOne(p, d)
    let info = backend.info(node)
    guard info.enabled else { throw HelperError(code: "TARGET_DISABLED", message: "the target is disabled; pressing it would do nothing") }
    guard info.actions.contains("AXPress") else { throw HelperError(code: "NOT_SUPPORTED", message: "the target has no AXPress action") }
    let before = compact(node, path: path)
    let rc = backend.press(node)
    if rc != 0 { throw axError(rc, during: "press") }
    backend.sleep(ms: settleMs(p, default: 150))
    let after: JSONValue = isValid(node) ? .object(compact(node, path: path)) : .null
    return ["before": .object(before), "after": after]
  }

  // MARK: - interaction

  /// The only action besides AXPress gb-mcp needs (confirming the Library search). Keep it minimal.
  static var allowedActions: Set<String> { ["AXConfirm"] }
  /// Roles that take clicks themselves: a hit on (or inside) one of these is NOT a click on the target.
  static var controlRoles: Set<String> {
    ["AXButton", "AXCheckBox", "AXSlider", "AXTextField", "AXPopUpButton", "AXRadioButton", "AXMenuButton", "AXComboBox",
     "AXValueIndicator", "AXDisclosureTriangle", "AXIncrementor", "AXMenuItem", "AXLink", "AXScrollBar", "AXTextArea"]
  }
  /// Actions that make an element a control in its own right.
  static var controlActions: Set<String> { ["AXPress", "AXIncrement", "AXDecrement", "AXConfirm", "AXPick"] }
  /// The user must have paused typing/pointing this long before GarageBand is brought forward (their keystrokes would
  /// otherwise land in GarageBand: Space plays, R records, Delete deletes).
  static var idleBeforeActivationMs: Double { 1_000 }
  /** No click within this long of the user's own input (they are mid-gesture or mid-word). */
  static var idleBeforeClickMs: Double { 500 }
  /// A role string from another app is arbitrary text: only `AX…` identifiers pass through.
  static func safeRole(_ role: String) -> String {
    role.range(of: "^AX[A-Za-z]{1,40}$", options: .regularExpression) != nil ? role : "AXUnknown"
  }

  func activate(_ d: Deadline) throws -> JSONValue {
    try requireAX()
    if backend.isFrontmost() { return ["frontmost": true, "changed": false] }
    guard backend.automationGranted() else {
      throw HelperError(code: "PERMISSION_AUTOMATION_DENIED", message: "bringing GarageBand forward needs the Automation permission for GarageBand (never prompted here)")
    }
    while backend.msSinceUserInput() < Self.idleBeforeActivationMs {
      if d.remainingMs() < 1_500 {
        throw HelperError(code: "USER_INPUT_ACTIVE", message: "you are typing or using the pointer; GarageBand was not brought forward (your keys would land in it)")
      }
      backend.sleep(ms: 100)
    }
    _ = backend.activateTarget()
    while !d.isExpired() {
      if backend.isFrontmost() { return ["frontmost": true, "changed": true] }
      backend.sleep(ms: 100)
    }
    throw HelperError(code: "NOT_FRONTMOST", message: "GarageBand could not be brought to the front (macOS refused activation)")
  }

  func click(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    let (node, path) = try resolveOne(p, d)
    guard backend.isFrontmost() else {
      throw HelperError(code: "NOT_FRONTMOST", message: "GarageBand must be frontmost for a click (call app.activate first)")
    }
    let info = backend.info(node)
    guard info.enabled else { throw HelperError(code: "TARGET_DISABLED", message: "the target is disabled; clicking it would do nothing") }
    guard !info.actions.contains("AXPress") else { throw HelperError(code: "INPUT_INVALID", message: "the target is pressable: use ax.press, not a click") }
    guard let f = backend.frame(node), f.w >= 2, f.h >= 2 else { throw HelperError(code: "NOT_SUPPORTED", message: "the target has no on-screen frame") }
    let fx = min(max(p["at"]?["fx"]?.numberValue ?? 0.5, 0), 1)
    let fy = min(max(p["at"]?["fy"]?.numberValue ?? 0.5, 0), 1)
    let x = min(f.x + f.w * fx, f.x + f.w - 1), y = min(f.y + f.h * fy, f.y + f.h - 1) // strictly inside the frame
    // Everything slow happens BEFORE the hit test; the hit test is the last look before the click (TOCTOU).
    let before = compact(node, path: path)
    guard !backend.mouseButtonDown() else {
      throw HelperError(code: "USER_INPUT_ACTIVE", message: "a mouse button is held: not clicking into your drag")
    }
    guard backend.msSinceUserInput() >= Self.idleBeforeClickMs else {
      throw HelperError(code: "USER_INPUT_ACTIVE", message: "you are typing or moving the pointer right now: not clicking")
    }
    guard d.remainingMs() > 300 else { throw HelperError(code: "DEADLINE_EXCEEDED", message: "too little time left to click safely") }
    guard let hit = backend.element(atX: x, y: y) else {
      throw HelperError(code: "HIT_TEST_MISMATCH", message: "nothing is at the click point")
    }
    // The hit must be the target, or inside it with no control anywhere between (e.g. a slider's value indicator).
    var cursor: B.Node? = hit
    var inside = false
    var controlOnPath: String?
    var hops = 0
    while let c = cursor, hops < 12 {
      if backend.isSame(c, node) { inside = true; break }
      let role = backend.string(c, .role) ?? ""
      if controlOnPath == nil && (Self.controlRoles.contains(role) || !Self.controlActions.isDisjoint(with: backend.info(c).actions)) { controlOnPath = role }
      cursor = backend.parent(c); hops += 1
    }
    if !inside || controlOnPath != nil {
      let hitRole = Self.safeRole(backend.string(hit, .role) ?? "")
      // Another app's UI is never described beyond its (clamped) role: it may hold private text or injected instructions.
      let described: JSONValue = backend.isTargetApp(hit) ? .object(compact(hit, path: "?")) : ["foreign_app": true, "role": .string(hitRole)]
      throw HelperError(code: "HIT_TEST_MISMATCH", message: "another element (\(Self.safeRole(controlOnPath ?? hitRole))) would receive the click",
                        details: ["hit": described, "point": ["x": .number(x), "y": .number(y)]])
    }
    let rc = backend.click(x: x, y: y)
    if rc != 0 { throw axError(rc, during: "click") }
    backend.sleep(ms: settleMs(p, default: 300))
    let after: JSONValue = isValid(node) ? .object(compact(node, path: path)) : .null
    return ["before": .object(before), "after": after, "point": ["x": .number(x), "y": .number(y)]]
  }

  func perform(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    guard let action = p["action"]?.stringValue, Self.allowedActions.contains(action) else {
      throw HelperError(code: "INPUT_INVALID", message: "action must be one of \(Self.allowedActions.sorted().joined(separator: ", "))")
    }
    let (node, path) = try resolveOne(p, d)
    let info = backend.info(node)
    guard info.enabled else { throw HelperError(code: "TARGET_DISABLED", message: "the target is disabled") }
    guard info.actions.contains(action) else { throw HelperError(code: "NOT_SUPPORTED", message: "the target has no \(action) action") }
    let before = compact(node, path: path)
    let rc = backend.perform(node, action: action)
    if rc != 0 { throw axError(rc, during: action) }
    backend.sleep(ms: settleMs(p, default: 150))
    let after: JSONValue = isValid(node) ? .object(compact(node, path: path)) : .null
    return ["before": .object(before), "after": after]
  }

  func set(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    guard let requested = p["value"], requested != .null else { throw HelperError(code: "INPUT_INVALID", message: "value is required") }
    let (node, _) = try resolveOne(p, d)
    guard backend.isSettable(node) else { throw HelperError(code: "NOT_SETTABLE", message: "the target's value is not settable") }
    let before = backend.value(node) ?? .null
    let rc = backend.setValue(node, requested)
    if rc != 0 { throw axError(rc, during: "set") }
    backend.sleep(ms: settleMs(p, default: 150))
    return ["before": before, "after": backend.value(node) ?? .null, "requested": requested]
  }

  func convergeOp(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    guard let target = p["target"]?.numberValue else { throw HelperError(code: "INPUT_INVALID", message: "target must be a number") }
    let (node, _) = try resolveOne(p, d)
    guard backend.isSettable(node) else { throw HelperError(code: "NOT_SETTABLE", message: "the target's value is not settable") }
    let settle = settleMs(p, default: 120)
    var lastError: Int32 = 0
    let r = converge(
      target: target,
      maxSteps: p["max_steps"]?.intValue.map { min(max($0, 1), 1_000) },
      tolerance: max(0, p["tolerance"]?.numberValue ?? 0),
      read: { backend.value(node)?.numberValue },
      write: { v in lastError = backend.setValue(node, .number(v)); return lastError == 0 },
      settle: { backend.sleep(ms: settle) },
      isExpired: d.isExpired)
    if lastError != 0 { throw axError(lastError, during: "converge") }
    var o: [String: JSONValue] = [
      "converged": .bool(r.converged), "steps": .number(Double(r.steps)), "target": .number(target),
      "stuck": .bool(r.stuck), "deadline_exceeded": .bool(r.deadlineExceeded),
    ]
    o["before"] = r.before.map { .number($0) } ?? .null
    o["after"] = r.after.map { .number($0) } ?? .null
    return .object(o)
  }

  /// AXError → helper error code (aligned with gb-mcp envelope codes where one exists).
  func axError(_ rc: Int32, during action: String) -> HelperError {
    let code: String
    switch rc {
    case -25211: code = "PERMISSION_AX_DENIED" // kAXErrorAPIDisabled
    case -25204: code = "DEADLINE_EXCEEDED" // kAXErrorCannotComplete: app did not answer within the messaging timeout
    case -25202: code = "TARGET_CHANGED" // kAXErrorInvalidUIElement: the element no longer exists
    case -25201: code = "INPUT_INVALID" // kAXErrorIllegalArgument
    case -25205, -25206, -25207, -25208, -25213: code = "NOT_SUPPORTED"
    default: code = "AX_ACTION_FAILED"
    }
    return HelperError(code: code, message: "\(action) failed (AXError \(rc))", details: ["ax_error": .number(Double(rc))])
  }
}

// MARK: - menu, wait, snapshot

extension Dispatcher {
  /// Walk the menu bar by FULL title path (never leaf-only: a unique "Delete" under the wrong parent must not match).
  func menu(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    try requireAX()
    guard let path = p["path"]?.arrayValue?.compactMap(\.stringValue), !path.isEmpty else {
      throw HelperError(code: "INPUT_INVALID", message: "path must be a non-empty array of menu titles, e.g. [\"Share\", \"Export Song to Disk…\"]")
    }
    guard var current = backend.menuBar() else { throw HelperError(code: "TARGET_NOT_FOUND", message: "no menu bar") }
    for (level, title) in path.enumerated() {
      var candidates = backend.children(current)
      if level > 0 { candidates = candidates.flatMap { backend.string($0, .role) == "AXMenu" ? backend.children($0) : [$0] } }
      let hits = candidates.filter { backend.string($0, .title) == title }
      guard hits.count == 1 else {
        let available = candidates.compactMap { backend.string($0, .title) }.filter { !$0.isEmpty }
        throw HelperError(code: hits.isEmpty ? "TARGET_NOT_FOUND" : "TARGET_AMBIGUOUS",
                          message: "menu item \"\(title)\" \(hits.isEmpty ? "not found" : "is ambiguous")",
                          details: ["at": .string(title), "level": .number(Double(level)), "available": .array(available.map { .string($0) })])
      }
      current = hits[0]
    }
    let enabled = backend.info(current).enabled
    let mark: JSONValue = backend.menuMark(current).map { .string($0) } ?? .null
    var result: [String: JSONValue] = ["path": .array(path.map { .string($0) }), "enabled": .bool(enabled), "mark": mark, "pressed": false]
    if p["dry_run"]?.boolValue == true { return .object(result) }
    guard enabled else { throw HelperError(code: "TARGET_DISABLED", message: "menu item \"\(path.joined(separator: " ▸ "))\" is disabled") }
    let rc = backend.press(current)
    if rc != 0 { throw axError(rc, during: "menu press") }
    result["pressed"] = true
    return .object(result)
  }

  /// Poll until a condition holds or the deadline nears. Timing out is an ANSWER (satisfied: false), not an error.
  /// A missing root counts as zero matches, so "wait until the export dialog is gone" works on the dialog root itself.
  func wait(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    try requireAX()
    let rootSpec = try RootSpec.from(p["root"])
    guard let selJSON = p["selector"] else { throw HelperError(code: "INPUT_INVALID", message: "selector is required") }
    let selector = try AXSelector.from(selJSON)
    let condition = p["condition"]?.stringValue ?? "present"
    guard ["present", "absent", "value_equals"].contains(condition) else {
      throw HelperError(code: "INPUT_INVALID", message: "condition must be present, absent or value_equals")
    }
    if condition == "value_equals", p["value"] == nil { throw HelperError(code: "INPUT_INVALID", message: "value_equals needs value") }
    let poll = min(max(p["poll_ms"]?.intValue ?? 100, 20), 2_000)
    let options = try searchOptions(p, root: rootSpec, defaultDepth: 24, defaultNodes: 20_000)
    let start = backend.nowMs()
    while true {
      var matches: [Match<B.Node>] = []
      // complete: the whole tree under the root was searched. A root that no longer resolves is complete (a vanished
      // dialog root IS absent); a search cut off by its node cap or the deadline proves nothing about absence
      // (security review 2026-10-06, B5).
      var complete = true
      if let (_, root) = try? resolveRootParam(p["root"], d) {
        let found = findAll(tree: backend, root: root, selector: selector, options: options, isExpired: d.isExpired)
        matches = found.matches
        complete = !found.truncated && !found.deadlineExceeded
      }
      let satisfied: Bool
      switch condition {
      case "present": satisfied = !matches.isEmpty
      case "absent": satisfied = matches.isEmpty && complete
      default: satisfied = matches.count == 1 && backend.value(matches[0].node) == p["value"]
      }
      let waited = backend.nowMs() - start
      if satisfied || d.remainingMs() < Double(poll) + 25 {
        var o: [String: JSONValue] = ["satisfied": .bool(satisfied), "waited_ms": .number(waited.rounded()),
                                      "count": .number(Double(matches.count)), "condition": .string(condition),
                                      "complete": .bool(complete)]
        if let m = matches.first { o["match"] = .object(compact(m.node, path: m.path)) }
        return .object(o)
      }
      backend.sleep(ms: poll)
    }
  }

  /// Compact nested snapshot with depth and node caps; nodes cut off by depth report child_count.
  func snapshot(_ p: JSONValue, _ d: Deadline) throws -> JSONValue {
    try requireAX()
    let (rootSpec, root) = try resolveRootParam(p["root"], d)
    let options = try searchOptions(p, root: rootSpec, defaultDepth: 6, defaultNodes: 300)
    let depthLimit = min(options.maxDepth, 16)
    let nodeLimit = min(options.maxNodes, 3_000)
    let includeHelp = p["include_help"]?.boolValue == true
    var count = 0
    var truncated = false

    func build(_ node: B.Node, _ path: String, _ depth: Int) -> JSONValue? {
      if count >= nodeLimit || d.isExpired() { truncated = true; return nil }
      count += 1
      var o = compact(node, path: path, includeHelp: includeHelp)
      let role = backend.string(node, .role) ?? ""
      let kids = backend.children(node)
      if kids.isEmpty { return .object(o) }
      if depth >= depthLimit || options.pruneRoles.contains(role) {
        o["child_count"] = .number(Double(kids.count))
        return .object(o)
      }
      var built: [JSONValue] = []
      for (i, child) in kids.enumerated() {
        guard let c = build(child, path.isEmpty ? "\(i)" : "\(path).\(i)", depth + 1) else { break }
        built.append(c)
      }
      o["children"] = .array(built)
      return .object(o)
    }

    let tree = build(root, "", 0) ?? .null
    return ["root": tree, "node_count": .number(Double(count)), "truncated": .bool(truncated)]
  }
}

/// A request's time budget, measured on the backend's clock.
public struct Deadline {
  let startMs: Double
  let budgetMs: Double
  let now: () -> Double
  public func isExpired() -> Bool { now() - startMs >= budgetMs }
  public func remainingMs() -> Double { max(0, budgetMs - (now() - startMs)) }
}
