/** Tests for enforcement-gate — Layer 2 round-boundary runtime enforcement. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPolicy, resetPolicy } from "../policy.js";
import {
  makeEnforcementResult,
  makeExecutionEvidence,
  makeSelfEvaluation,
  makeVerificationFlag,
  makeVerificationResult,
  type EnforcementResult,
  type SelfEvaluation,
  type VerificationResult,
} from "../protocol.js";
import type { VaultEntry } from "../backends/interface.js";
import {
  enforceRound,
  buildRejectionPrompt,
  findSafeRestorePoint,
  buildBacktrackPrompt,
} from "../enforcement-gate.js";
import { verifyBacktrackPrompt } from "./_backtrack-asserts.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build a minimal SelfEvaluation for testing. */
function se(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "Task completed.",
    constraint_violations: [],
    should_continue: true,
    ...overrides,
  });
}

/** Build a trusted VerificationResult with no flags. */
function trusted(): VerificationResult {
  return makeVerificationResult({ verdict: "trusted", flags: [] });
}

/** Build a VerificationResult with a "success_with_remaining_criteria" error flag. */
function contradictedSuccessWithRemaining(criteria: string[]): VerificationResult {
  return makeVerificationResult({
    verdict: "contradicted",
    flags: [
      makeVerificationFlag({
        severity: "error",
        field: "success",
        check: "success_with_remaining_criteria",
        detail: `Agent claims success but ${criteria.length} criteria remain unmet: ${criteria.join("; ")}`,
      }),
    ],
  });
}

/** Build a VerificationResult with a "recurring_violation" error flag. */
function contradictedRecurringViolation(violation: string): VerificationResult {
  return makeVerificationResult({
    verdict: "contradicted",
    flags: [
      makeVerificationFlag({
        severity: "error",
        field: "constraint_violations",
        check: "recurring_violation",
        detail: `Constraint violation "${violation}" has appeared in 3 consecutive rounds without resolution`,
      }),
    ],
  });
}

/** Build a vault entry with round and optional progress data. */
function vaultRound(
  round: number,
  progressEstimate?: number,
): VaultEntry {
  const entry: VaultEntry = {
    task_id: `loop:test-loop:r${round}`,
    loop_id: "test-loop",
    loop_lineage: { round, success: true, task: "test task" },
  };
  if (typeof progressEstimate === "number") {
    entry.execution_evidence = {
      files_changed: ["src/foo.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: [],
      success_criteria_remaining: [],
      progress_estimate: progressEstimate,
    };
  }
  return entry;
}

// ═══════════════════════════════════════════════════════════════════════════
// Happy path — trusted verdict, no issues
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — happy path", () => {
  it("accepts a round with trusted verdict and clean self-eval", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 3, failed: 1, skipped: 0 },
        progress_estimate: 0.5,
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "accept");
    assert.equal(result.reason, "");
  });

  it("accepts a round with suspect verdict (warn only, not error)", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/bar.ts"],
        test_results: { passed: 5, failed: 0, skipped: 0 },
        progress_estimate: 0.3,
      }),
    });
    const suspect: VerificationResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "progress_estimate",
          check: "progress_regression",
          detail: "Progress dropped from 0.5 to 0.3",
        }),
      ],
    });
    const result = enforceRound(curr, suspect, 2, [], 0);
    assert.equal(result.action, "accept");
  });

  it("accepts round 1 with no prior vault data", () => {
    const curr = se({ success: false });
    const result = enforceRound(curr, trusted(), 1, [], 0);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1: success=true with remaining criteria
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R1: fake success", () => {
  it("rejects when agent claims success but criteria remain unmet", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        success_criteria_met: ["criteria-1"],
        success_criteria_remaining: ["criteria-2", "criteria-3"],
        progress_estimate: 0.5,
      }),
    });
    const result = enforceRound(
      curr,
      contradictedSuccessWithRemaining(["criteria-2", "criteria-3"]),
      3, [], 0,
    );
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("criteria remain unmet"));
    assert.ok(result.fix_instructions.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2: recurring violation
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R2: recurring violation", () => {
  it("rejects when same violation appears in 3 consecutive rounds", () => {
    const curr = se({
      success: false,
      constraint_violations: ["missing docs"],
    });
    const result = enforceRound(
      curr,
      contradictedRecurringViolation("missing docs"),
      4, [], 0,
    );
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("3 consecutive rounds"));
    assert.ok(result.fix_instructions.includes("DIFFERENT approach"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R3: empty success — no files changed, no tests, claims success
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R3: empty success", () => {
  it("rejects when agent claims success with no files and no tests", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: null,
        progress_estimate: 1.0,
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("no verifiable evidence"));
  });

  it("accepts when success=true with files_changed (not empty)", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/fixed.ts"],
        test_results: { passed: 10, failed: 0, skipped: 0 },
        progress_estimate: 1.0,
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "accept");
  });

  it("rejects when execution_evidence is undefined — evidence is now mandatory", () => {
    // v1.17: execution_evidence is MANDATORY for structured self-evaluations.
    // Missing evidence when success=true → reject (agent must provide evidence).
    const curr = makeSelfEvaluation({
      success: true,
      output_summary: "Done.",
      constraint_violations: [],
      should_continue: true,
    });
    // Explicitly remove execution_evidence (default factory sets it)
    (curr as unknown as Record<string, unknown>).execution_evidence = undefined;
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("no execution_evidence"),
      `expected reason to mention missing evidence, got: ${result.reason}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R4: progress stall
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R4: progress stall", () => {
  it("rejects when progress is flat for 3 rounds", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.33,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      vaultRound(3, 0.32),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 0);
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("stalled"));
  });

  it("accepts when progress is increasing", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.80,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.50),
      vaultRound(3, 0.70),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 0);
    assert.equal(result.action, "accept");
  });

  it("backtracks on second consecutive stall rejection instead of terminating", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.33,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      vaultRound(3, 0.32),
    ];
    // v2.10: consecutiveRejections=1 + escalation + backtrack_enabled → backtrack
    // instead of v2.7's escalated reject. The agent is rolled back to the
    // last clean round rather than redoing the same round with guidance.
    const result = enforceRound(curr, trusted(), 4, vault, 1);
    assert.equal(result.action, "backtrack");
    assert.equal(result.check, "progress_stall");
  });

  it("terminates on third consecutive stall rejection after escalation", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.33,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      vaultRound(3, 0.32),
    ];
    // v2.7: consecutiveRejections=2 → terminate (escalation already given)
    const result = enforceRound(curr, trusted(), 4, vault, 2);
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "progress_stall");
  });

  it("does not fire with less than 3 rounds of vault data", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        progress_estimate: 0.32,
      }),
    });
    const vault = [vaultRound(1, 0.30)];
    const result = enforceRound(curr, trusted(), 2, vault, 0);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R5: max rejections
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R5: max rejections", () => {
  it("escalates after 2 consecutive rejections instead of terminating", () => {
    const curr = se({ success: false });
    // v2.7: consecutiveRejections=2 now escalates (reject + guidance) instead
    // of terminating immediately.
    const result = enforceRound(curr, trusted(), 3, [], 2);
    assert.equal(result.action, "reject");
    assert.ok(result.fix_instructions.includes("Escalation"));
    assert.equal(result.check, "max_rejections");
  });

  it("terminates after 3 consecutive rejections", () => {
    const curr = se({ success: false });
    // v2.7: consecutiveRejections=3 → terminate (escalation already given)
    const result = enforceRound(curr, trusted(), 3, [], 3);
    assert.equal(result.action, "terminate");
    assert.ok(result.reason.includes("consecutive enforcement rejections"));
  });

  it("does not escalate with only 1 rejection", () => {
    const curr = se({ success: false });
    const result = enforceRound(curr, trusted(), 3, [], 1);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Priority — R1 takes precedence over R3 when both conditions exist
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — rule priority", () => {
  it("R1 (fake success) fires before R3 (empty success)", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],       // triggers R3
        test_results: null,       // triggers R3
        success_criteria_met: ["x"],
        success_criteria_remaining: ["y", "z"],  // triggers R1
        progress_estimate: 1.0,
      }),
    });
    const result = enforceRound(
      curr,
      contradictedSuccessWithRemaining(["y", "z"]),
      2, [], 0,
    );
    // R1 should fire (criteria remaining), not R3 (empty success)
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("criteria remain unmet"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildRejectionPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildRejectionPrompt", () => {
  it("produces a prompt containing REJECTED, reason, and retry instructions", () => {
    const enforceResult = makeEnforcementResult({
      action: "reject",
      reason: "Agent claims success but 3 criteria remain unmet.",
      fix_instructions: "Complete all criteria or set success=false.",
    });
    const prompt = buildRejectionPrompt(5, "Audit the ERC20 token", enforceResult);
    assert.ok(prompt.includes("REJECTED"));
    assert.ok(prompt.includes("Round 5"));
    assert.ok(prompt.includes("criteria remain unmet"));
    assert.ok(prompt.includes("Complete all criteria"));
    assert.ok(prompt.includes("Audit the ERC20 token"));
    assert.ok(prompt.includes("Retry"));
    assert.ok(prompt.includes("do NOT advance"));
  });

  it("includes the task in the retry section", () => {
    const enforceResult = makeEnforcementResult({
      action: "reject",
      reason: "Test reason.",
      fix_instructions: "Test fix.",
    });
    const prompt = buildRejectionPrompt(2, "Fix bugs in auth module", enforceResult);
    assert.ok(prompt.includes("Fix bugs in auth module"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.8: R7 — Intent drift with drift_clarification
// ═══════════════════════════════════════════════════════════════════════════

describe("enforceRound — R7 intent drift with clarification", () => {
  it("rejects when intent_drift flag present without clarification", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was refactor auth but actual output fixed css — similarity 8%",
        }),
      ],
    });
    const result = enforceRound(selfEval, verifyResult, 3, [], 0);
    assert.equal(result.action, "reject", "should reject without clarification");
    assert.equal(result.check, "intent_drift");
  });

  it("accepts (skips reject) when agent provides substantive drift_clarification", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      drift_clarification:
        "Pivoted from auth refactor because data showed CSS layout was the actual user complaint. " +
        "The auth module refactor was preempted by this higher-priority fix. " +
        "Changed src/components/Login.css to fix the visual regression.",
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was refactor auth but actual output fixed css — similarity 8%",
        }),
      ],
    });
    const result = enforceRound(selfEval, verifyResult, 3, [], 0);
    assert.notEqual(result.action, "reject",
      "should not reject when clarification is provided");
    // v2.12: Should signal clarification was accepted
    assert.equal(result.clarification_accepted, true,
      "should mark clarification as accepted");
  });

  it("rejects when drift_clarification is too short (under 20 chars)", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      drift_clarification: "Changed plan.",
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was refactor auth but actual output fixed css — similarity 8%",
        }),
      ],
    });
    const result = enforceRound(selfEval, verifyResult, 3, [], 0);
    assert.equal(result.action, "reject",
      "should reject when clarification is too short");
  });

  it("still terminates on second consecutive intent_drift without clarification", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding again",
      should_continue: true,
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was audit contracts but actual output fixed css — similarity 5%",
        }),
      ],
    });
    const result = enforceRound(selfEval, verifyResult, 5, [], 1); // 2nd occurrence
    assert.equal(result.action, "terminate",
      "should terminate on second drift without clarification");
  });

  // ── v2.12: Semantic anchor detection ─────────────────────────────────

  it("accepts clarification with constraint ID anchor (c-XXXXXXXX)", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      drift_clarification:
        "Pivoted because constraint c-a3f2b1c0 (rate limiting) was already satisfied. " +
        "The CSS fix was higher priority.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, false, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has constraint ID");
    assert.equal(result.clarification_accepted, true,
      "should signal clarification was accepted");
  });

  it("accepts clarification with sub-goal ID anchor (sg-XXXXXXXX)", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Refactored utils",
      should_continue: true,
      drift_clarification:
        "Discovered that sub-goal sg-b5a6c7d8 was blocked by the util structure. " +
        "Refactored it first so the sub-goal can proceed next round.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, false, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has sub-goal ID");
    assert.equal(result.clarification_accepted, true);
  });

  it("accepts clarification with criterion ID anchor (cr-XXXXXXXX)", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Wrote integration tests",
      should_continue: true,
      drift_clarification:
        "Pivoted to write tests because criterion cr-f1e2d3c4 requires " +
        "integration coverage before the feature is considered done.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, false, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has criterion ID");
    assert.equal(result.clarification_accepted, true);
  });

  it("accepts clarification with file path anchor", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      drift_clarification:
        "Pivoted because I found a bug in src/components/Login.tsx that " +
        "was causing the layout issue. Fixed that before continuing auth work.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, false, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has file path");
    assert.equal(result.clarification_accepted, true);
  });

  it("rejects weak clarification (>= 20 chars but no anchors) on first occurrence", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      drift_clarification:
        "Because I think this is necessary for the current step implementation. " +
        "The direction change was needed for better results.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, false, 0);
    assert.equal(result.action, "reject",
      "should reject weak clarification without anchors");
    assert.equal(result.check, "intent_drift");
    // fix_instructions should mention the need for concrete references
    assert.ok(
      (result.fix_instructions ?? "").includes("drift_clarification"),
      "fix_instructions should mention drift_clarification",
    );
  });

  it("terminates on third consecutive weak clarification (streak >= 3)", () => {
    const makeDriftEval = () => makeSelfEvaluation({
      success: false,
      output_summary: "Did something else",
      should_continue: true,
      drift_clarification:
        "I changed direction because I felt this approach was more optimal " +
        "for the current implementation requirements. It was the right call.",
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    });

    // Streak = 0 → first weak clarification → reject only
    const r0 = enforceRound(makeDriftEval(), verifyResult, 3, [], 0, false, 0);
    assert.equal(r0.action, "reject",
      "streak 0 should reject (first weak clarification)");

    // Streak = 1 → second weak clarification → still reject, but with warning
    const r1 = enforceRound(makeDriftEval(), verifyResult, 4, [], 0, false, 1);
    assert.equal(r1.action, "reject",
      "streak 1 should still reject (second weak clarification)");
    assert.ok(
      (r1.fix_instructions ?? "").includes("Repeated Weak Clarification"),
      "fix_instructions should warn about repeated weak clarification on streak >= 2",
    );

    // Streak = 2 → third weak clarification (2 + 1 = 3 >= max_streak=3) → terminate
    const r2 = enforceRound(makeDriftEval(), verifyResult, 5, [], 0, false, 2);
    assert.equal(r2.action, "terminate",
      "streak 2 + 1 = 3 should terminate (reaches max_streak=3)");
  });

  it("keeps streak unchanged for substantive clarification", () => {
    // Even with an existing streak, a strong clarification should be accepted
    // without resetting the streak (the enforcement gate doesn't track state;
    // the SessionManager does). But the result should NOT be reject/terminate.
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS",
      should_continue: true,
      drift_clarification:
        "Pivoted because src/styles/main.css had a layout-breaking regression. " +
        "The auth work was blocked by this visual bug.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, false, 2); // streak = 2
    assert.notEqual(result.action, "reject",
      "should accept substantive clarification even with existing streak");
    assert.equal(result.clarification_accepted, true);
  });

  it("still rejects when drift_clarification is absent entirely (original behavior)", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      // No drift_clarification at all
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, false, 0);
    assert.equal(result.action, "reject",
      "should reject when no clarification provided");
  });

  it("weak clarification streak escalation disabled when max_streak is 0", () => {
    // Temporarily override the policy to disable the streak limit
    resetPolicy();
    const p = getPolicy();
    const orig = p.engine.drift_clarification_max_streak;
    p.engine.drift_clarification_max_streak = 0;

    try {
      const selfEval = makeSelfEvaluation({
        success: false,
        output_summary: "Did something else",
        should_continue: true,
        drift_clarification:
          "I changed direction because I felt this approach was better. " +
          "No concrete details but the length check still passes.",
      });
      const result = enforceRound(selfEval, makeVerificationResult({
        verdict: "suspect",
        flags: [makeVerificationFlag({
          severity: "warn", field: "output_summary",
          check: "intent_drift",
          detail: "Drift detected",
        })],
      }), 3, [], 0, false, 0);
      assert.notEqual(result.action, "reject",
        "should accept when max_streak is 0 (pre-v2.12 behavior)");
      assert.equal(result.clarification_accepted, true);
    } finally {
      p.engine.drift_clarification_max_streak = orig;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Backtrack — safe restore point
// ═══════════════════════════════════════════════════════════════════════════

describe("findSafeRestorePoint", () => {
  /** Build a clean vault entry for a round. */
  function cleanRound(rnd: number): VaultEntry {
    return {
      task_id: `loop:test:round:${rnd}`,
      task_type: "round_entry",
      timestamp: new Date().toISOString(),
      success: true,
      task: "test task",
      output_summary: `Round ${rnd} done`,
      constraint_violations: [],
      constraint_violations_entry: [],
      loop_id: "test",
      loop_lineage: { round: rnd, task: `Round ${rnd}`, success: true },
    };
  }

  function dirtyRound(rnd: number, severity: "warn" | "error" = "error"): VaultEntry {
    return {
      task_id: `loop:test:round:${rnd}`,
      task_type: "round_entry",
      timestamp: new Date().toISOString(),
      success: false,
      task: "test task",
      output_summary: `Round ${rnd} failed`,
      constraint_violations: ["bad thing"],
      constraint_violations_entry: ["bad thing"],
      loop_id: "test",
      loop_lineage: { round: rnd, task: `Round ${rnd}`, success: false },
      verification_flags: [{ check: "test_flag", detail: "error", severity }],
    };
  }

  function rejectedRound(rnd: number): VaultEntry {
    return {
      task_id: `loop:test:round:${rnd}`,
      task_type: "round_entry",
      timestamp: new Date().toISOString(),
      success: false,
      task: "test task",
      output_summary: `Round ${rnd} rejected`,
      constraint_violations: [],
      constraint_violations_entry: [],
      loop_id: "test",
      loop_lineage: { round: rnd, task: `Round ${rnd}`, success: false },
    };
  }

  it("returns the most recent clean round (current - 1)", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),
      cleanRound(3),
      cleanRound(4),
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 4);
    assert.deepEqual(result!.skippedDiscoveries, []);
  });

  it("skips a dirty round and returns the next clean one", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),
      cleanRound(3),       // clean
      dirtyRound(4),       // dirty — should be skipped
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 3, "should skip round 4 and restore to round 3");
  });

  it("collects discoveries from skipped rounds", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),
      cleanRound(3),       // clean — restore target
      { ...dirtyRound(4), discovered_constraints: ["discovery from r4"] },
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 3);
    assert.ok(result!.skippedDiscoveries.includes("discovery from r4"));
  });

  it("skips multiple dirty rounds to find a clean one", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),       // clean — restore target
      dirtyRound(3),       // dirty
      rejectedRound(4),    // rejected
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 2, "should skip rounds 4 and 3 to reach round 2");
  });

  it("returns null when maxDepth is exceeded", () => {
    const vault = [
      dirtyRound(1),
      dirtyRound(2),
      dirtyRound(3),
      dirtyRound(4),
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.equal(result, null);
  });

  it("returns null when no entries exist before currentRound", () => {
    const result = findSafeRestorePoint(1, [], 3);
    assert.equal(result, null);
  });

  it("skips rounds with error-level verification flags", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),       // clean
      {                       // round 3: has error flag → not clean
        ...cleanRound(3),
        success: false,
        verification_flags: [{ check: "test", detail: "error", severity: "error" }],
      },
      cleanRound(4),       // round 4: clean but... wait, this is the one we're at
    ];
    // currentRound=5, round 4 is clean, so restore to 4
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    // Round 4 is clean, round 3 is skipped (has errors)
    // Actually wait - we're scanning backwards from currentRound-1
    // depth=1: round 4 (clean) → found!
    assert.equal(result!.round, 4);
  });

  it("accepts rounds with warn-level flags as clean", () => {
    const entryWithWarn = {
      ...cleanRound(3),
      verification_flags: [{ check: "test_warn", detail: "just a warning", severity: "warn" }],
    };
    const vault = [cleanRound(1), cleanRound(2), entryWithWarn, cleanRound(4)];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 4); // r4 is clean and closer
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Build backtrack prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildBacktrackPrompt", () => {
  // ── Round-number exactness (regression guard for ${fromRound} literal bug) ──

  it("renders exact round numbers in all key positions", () => {
    const prompt = buildBacktrackPrompt(45, 42, "progress_stall", [],
      ["src/auth.ts"]);
    verifyBacktrackPrompt(prompt, 45, 42, [
      "Backtrack",
      "did not work",
      "different",
    ]);
    // No literal template expressions survive
    assert.ok(!prompt.includes("${"), "prompt must not contain any ${...} literal");
  });

  // ── Trigger-rule guidance ────────────────────────────────────────────────

  it("renders stall-specific guidance for progress_stall", () => {
    const prompt = buildBacktrackPrompt(45, 42, "progress_stall", []);
    verifyBacktrackPrompt(prompt, 45, 42, [
      "did not work",
      "different",
    ]);
    assert.ok(!prompt.includes("radically different"),
      "progress_stall should NOT include terminal-level language");
  });

  it("renders radical-change guidance for progress_stall_terminal", () => {
    const prompt = buildBacktrackPrompt(50, 45, "progress_stall_terminal", []);
    verifyBacktrackPrompt(prompt, 50, 45, [
      "radically different",
      "zero forward motion",
    ]);
  });

  // ── Discoveries + workspace restore ──────────────────────────────────────

  it("renders preserved discoveries and skipped files", () => {
    const discoveries = ["SafeERC20 required", "2-day timelock"];
    const skippedFiles = ["src/auth.ts", "lib/utils.go", "README.md"];
    const prompt = buildBacktrackPrompt(10, 8, "progress_stall",
      discoveries, skippedFiles);
    verifyBacktrackPrompt(prompt, 10, 8, [
      "Preserved Discoveries",
      "SafeERC20 required",
      "2-day timelock",
      "Workspace Restore",
      "src/auth.ts",
      "lib/utils.go",
      "README.md",
      "If git is unavailable",
      "rejected",
    ]);
  });

  it("truncates long file lists and omits discovery section when empty", () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const prompt = buildBacktrackPrompt(10, 5, "progress_stall", [],
      manyFiles);
    verifyBacktrackPrompt(prompt, 10, 5, [
      "Workspace Restore",
      "and 5 more files",
      "Files modified in skipped rounds",
    ]);
    assert.ok(!prompt.includes("Preserved Discoveries"),
      "should not render discovery section when empty");
  });
});
