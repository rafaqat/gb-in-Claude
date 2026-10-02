// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import XCTest
@testable import GBHelperCore

/// A fake GarageBand slider: each set moves `stepPerWrite` toward the target (tempo 120→98: one step per set).
final class SteppingSlider {
  var value: Double
  let stepPerWrite: Double
  var writes = 0
  init(_ value: Double, stepPerWrite: Double = 1) { self.value = value; self.stepPerWrite = stepPerWrite }
  func write(_ target: Double) -> Bool {
    writes += 1
    if stepPerWrite == .infinity { value = target; return true }
    if value < target { value = min(target, value + stepPerWrite) } else if value > target { value = max(target, value - stepPerWrite) }
    return true
  }
}

final class ConvergeTests: XCTestCase {
  func testConvergesAStepwiseSliderWithReadBack() {
    let s = SteppingSlider(120)
    let r = converge(target: 98, read: { s.value }, write: s.write)
    XCTAssertTrue(r.converged)
    XCTAssertEqual(r.steps, 22)
    XCTAssertEqual(r.before, 120)
    XCTAssertEqual(r.after, 98)
  }

  func testAlreadyAtTargetWritesNothing() {
    let s = SteppingSlider(173)
    let r = converge(target: 173, read: { s.value }, write: s.write)
    XCTAssertTrue(r.converged)
    XCTAssertEqual(r.steps, 0)
    XCTAssertEqual(s.writes, 0)
  }

  func testStuckSliderStopsEarlyInsteadOfBurningTheBudget() {
    let s = SteppingSlider(64, stepPerWrite: 0)
    let r = converge(target: 40, read: { s.value }, write: s.write)
    XCTAssertFalse(r.converged)
    XCTAssertTrue(r.stuck)
    XCTAssertEqual(s.writes, 3)
  }

  func testRespectsTheStepBudget() {
    let s = SteppingSlider(0, stepPerWrite: 0.5) // half-speed slider: needs 2× the default budget
    let r = converge(target: 10, read: { s.value }, write: s.write)
    XCTAssertFalse(r.converged)
    XCTAssertEqual(r.steps, 12) // |Δ| + 2
  }

  func testDirectSetConvergesInOneStep() {
    let s = SteppingSlider(0.7, stepPerWrite: .infinity)
    let r = converge(target: 0.5, read: { s.value }, write: s.write)
    XCTAssertTrue(r.converged)
    XCTAssertEqual(r.steps, 1)
  }

  func testStopsAtTheDeadline() {
    let s = SteppingSlider(120)
    var checks = 0
    let r = converge(target: 98, read: { s.value }, write: s.write, isExpired: { checks += 1; return checks > 5 })
    XCTAssertFalse(r.converged)
    XCTAssertTrue(r.deadlineExceeded)
    XCTAssertLessThan(s.writes, 22)
  }

  func testUnreadableTargetFailsFast() {
    let r = converge(target: 1, read: { nil }, write: { _ in true })
    XCTAssertFalse(r.converged)
    XCTAssertEqual(r.steps, 0)
    XCTAssertNil(r.before)
  }
}
