// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import XCTest
@testable import GBHelperCore

final class DispatcherMiscTests: XCTestCase {
  var backend: FakeBackend!
  var dispatcher: Dispatcher<FakeBackend>!
  var exported = 0

  override func setUp() {
    backend = FakeBackend()
    backend.windows = [garageBandWindow()]
    backend.menuBarNode = garageBandMenuBar(onExport: { [unowned self] in self.exported += 1 })
    dispatcher = Dispatcher(backend: backend)
  }

  private func call(_ op: String, _ params: JSONValue, deadline: Int = 5000) -> Response {
    dispatcher.handle(Request(id: 1, op: op, params: params, deadlineMs: deadline))
  }

  // MARK: menu

  func testMenuDryRunResolvesWithoutPressing() {
    let r = call("ax.menu", ["path": ["Share", "Export Song to Disk…"], "dry_run": true])
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["pressed"], false)
    XCTAssertEqual(r.result?["enabled"], true)
    XCTAssertEqual(exported, 0)
  }

  func testMenuPressesTheLeafByFullPath() {
    let r = call("ax.menu", ["path": ["Share", "Export Song to Disk…"]])
    XCTAssertEqual(r.result?["pressed"], true, r.line())
    XCTAssertEqual(exported, 1)
  }

  func testMenuReadsTheCheckmark() {
    XCTAssertEqual(call("ax.menu", ["path": ["Record", "Count-in", "1 Bar"], "dry_run": true]).result?["mark"], "✓")
    XCTAssertEqual(call("ax.menu", ["path": ["Record", "Count-in", "2 Bars"], "dry_run": true]).result?["mark"], .null)
  }

  func testMenuMissingItemListsWhatIsThere() {
    let r = call("ax.menu", ["path": ["Share", "Export Song"]])
    XCTAssertEqual(r.error?.code, "TARGET_NOT_FOUND")
    XCTAssertEqual(r.error?.details?["at"], "Export Song")
    XCTAssertEqual(r.error?.details?["available"], ["Song to Music", "Export Song to Disk…"])
  }

  func testMenuRefusesDisabledItems() {
    XCTAssertEqual(call("ax.menu", ["path": ["Track", "Delete Track"]]).error?.code, "TARGET_DISABLED")
  }

  func testMenuNeedsANonEmptyPath() {
    XCTAssertEqual(call("ax.menu", ["path": []]).error?.code, "INPUT_INVALID")
  }

  // MARK: wait

  private func addDialog(at ms: Double) {
    backend.scheduled.append((ms, { [unowned self] in
      self.backend.windows.append(FakeNode([.role: "AXWindow", .subrole: "AXDialog", .title: "Export Song to Disk", .identifier: "save-panel"]))
    }))
  }

  func testWaitPresentSucceedsWhenTheElementAppears() {
    addDialog(at: 300)
    let r = call("ax.wait", ["root": ["kind": "app"], "condition": "present", "poll_ms": 100,
                             "selector": ["role": "AXWindow", "identifier": "save-panel"]])
    XCTAssertEqual(r.result?["satisfied"], true, r.line())
    XCTAssertEqual(r.result?["waited_ms"], 300)
  }

  func testWaitAbsentIsSatisfiedWhenTheDialogRootDisappears() {
    addDialog(at: 0); backend.sleep(ms: 0)
    backend.scheduled.append((500, { [unowned self] in self.backend.windows.removeLast() }))
    let r = call("ax.wait", ["root": ["kind": "dialog", "identifier": "save-panel"], "condition": "absent", "poll_ms": 100,
                             "selector": ["role": "AXWindow"]])
    XCTAssertEqual(r.result?["satisfied"], true, r.line())
    XCTAssertEqual(r.result?["waited_ms"], 500)
  }

  // security review 2026-10-06 (B5): a search cut off by its node cap (or the deadline) proves nothing about absence —
  // the export's abort() would skip Cancel and leave the panel open
  func testWaitAbsentIsNotSatisfiedByASearchThatStoppedEarly() {
    addDialog(at: 0); backend.sleep(ms: 0)
    let r = call("ax.wait", ["root": ["kind": "app"], "condition": "absent", "poll_ms": 100, "max_nodes": 1,
                             "selector": ["role": "AXWindow", "identifier": "save-panel"]], deadline: 1000)
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["satisfied"], false, r.line())
    XCTAssertEqual(r.result?["complete"], false, r.line())
  }

  func testWaitValueEquals() {
    backend.scheduled.append((200, { [unowned self] in self.backend.windows[0].children[0].children[1].value = 1 }))
    let r = call("ax.wait", ["root": ["kind": "main_window"], "condition": "value_equals", "value": 1, "poll_ms": 50,
                             "selector": ["role": "AXCheckBox", "title": "Play"]])
    XCTAssertEqual(r.result?["satisfied"], true, r.line())
  }

  func testWaitTimesOutWithAnAnswerNotAnError() {
    let r = call("ax.wait", ["root": ["kind": "app"], "condition": "present", "poll_ms": 100,
                             "selector": ["role": "AXWindow", "identifier": "never"]], deadline: 1000)
    XCTAssertTrue(r.ok, r.line())
    XCTAssertEqual(r.result?["satisfied"], false)
    XCTAssertLessThanOrEqual(r.result?["waited_ms"]?.numberValue ?? 9999, 1000)
  }

  // MARK: snapshot

  func testSnapshotIsCompactNestedAndDepthLimited() {
    let r = call("ax.snapshot", ["root": ["kind": "main_window"], "depth": 1])
    XCTAssertTrue(r.ok, r.line())
    let root = r.result?["root"]
    XCTAssertEqual(root?["role"], "AXWindow")
    let first = root?["children"]?.arrayValue?.first
    XCTAssertEqual(first?["desc"], "Control Bar")
    XCTAssertNil(first?["children"], "beyond depth: no children…")
    XCTAssertEqual(first?["child_count"], 3, "…but the agent knows there is more")
    XCTAssertEqual(r.result?["truncated"], false)
  }

  func testSnapshotNodeCapTruncates() {
    let r = call("ax.snapshot", ["root": ["kind": "main_window"], "depth": 8, "max_nodes": 4])
    XCTAssertEqual(r.result?["node_count"], 4)
    XCTAssertEqual(r.result?["truncated"], true)
  }

  // MARK: hello / perm.check / app.state

  func testHelloWorksWithoutGarageBand() {
    backend.running = false
    let r = call("hello", [:])
    XCTAssertEqual(r.result?["version"], .string(helperVersion))
    XCTAssertEqual(r.result?["protocol"], .number(Double(protocolVersion)))
    XCTAssertEqual(r.result?["ax_trusted"], true)
  }

  func testPermCheckAndAppStateComeFromTheBackend() {
    XCTAssertEqual(call("perm.check", [:]).result?["accessibility"], true)
    XCTAssertEqual(call("app.state", [:]).result?["running"], true)
  }
}

/// GarageBand's project chooser ("Choose a Project", id newProjectDialog) is an
/// AXStandardWindow. It must never be taken for the project window.
final class MainWindowChooserTests: XCTestCase {
  func testMainWindowSkipsTheProjectChooser() {
    let backend = FakeBackend()
    let chooser = FakeNode([.role: "AXWindow", .subrole: "AXStandardWindow", .title: "Choose a Project", .identifier: "newProjectDialog"],
                           children: [FakeNode([.role: "AXButton", .title: "Choose"], actions: ["AXPress"])])
    backend.windows = [chooser, garageBandWindow()]
    let d = Dispatcher(backend: backend)
    let r = d.handle(Request(id: 1, op: "ax.find", params: ["root": ["kind": "main_window"], "selector": ["role": "AXSlider", "description": "Tempo"]], deadlineMs: 2000))
    XCTAssertEqual(r.result?["count"], 1, r.line())
    backend.windows = [chooser]
    let none = d.handle(Request(id: 2, op: "ax.find", params: ["root": ["kind": "main_window"], "selector": ["role": "AXButton", "title": "Choose"]], deadlineMs: 2000))
    XCTAssertEqual(none.error?.code, "TARGET_NOT_FOUND", none.line())
  }
}
