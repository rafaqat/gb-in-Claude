// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import Foundation

public struct ConvergeResult: Equatable, Sendable {
  public var converged: Bool
  public var steps: Int
  public var before: Double?
  public var after: Double?
  public var stuck: Bool
  public var deadlineExceeded: Bool
}

/// GarageBand sliders move ONE step per AXValue set (tempo 120→98 took ~22 sets), so a "set"
/// is a loop: write the target, read back, repeat until read-back == target.
/// Budget defaults to |Δ| + 2. Three consecutive unchanged read-backs = stuck: stop instead of burning the budget.
public func converge(
  target: Double,
  maxSteps: Int? = nil,
  tolerance: Double = 0,
  read: () -> Double?,
  write: (Double) -> Bool,
  settle: () -> Void = {},
  isExpired: () -> Bool = { false }
) -> ConvergeResult {
  guard let before = read() else {
    return ConvergeResult(converged: false, steps: 0, before: nil, after: nil, stuck: false, deadlineExceeded: false)
  }
  let reached = { (v: Double) in abs(v - target) <= tolerance }
  var result = ConvergeResult(converged: reached(before), steps: 0, before: before, after: before, stuck: false, deadlineExceeded: false)
  if result.converged { return result }

  let budget = maxSteps ?? min(Int(abs(target - before).rounded(.up)) + 2, 1_000)
  var unchanged = 0
  var last = before
  while result.steps < budget {
    if isExpired() { result.deadlineExceeded = true; return result }
    guard write(target) else { return result }
    result.steps += 1
    settle()
    guard let v = read() else { return result }
    result.after = v
    if reached(v) { result.converged = true; return result }
    if v == last {
      unchanged += 1
      if unchanged >= 3 { result.stuck = true; return result }
    } else {
      unchanged = 0
    }
    last = v
  }
  return result
}
