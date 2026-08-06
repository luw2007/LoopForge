import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import {
  makeRoundId,
  prepareRoundTransaction,
  parseRoundTransactionSnapshot,
  RoundTransactionCoordinator,
} from "../round-transaction.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import type { SelfEvaluation } from "../protocol.js";
import { MemoryBackend } from "./_helpers.js";
import { getPolicyMetrics, resetPolicyMetrics } from "../policy-metrics.js";

function continuingEvaluation(): SelfEvaluation {
  return {
    success: false,
    output_summary: "partial progress",
    constraint_violations: [],
    should_continue: true,
    execution_evidence: {
      files_changed: [],
      test_results: null,
      success_criteria_met: [],
      success_criteria_remaining: ["remaining"],
      progress_estimate: 0.4,
    },
  };
}

function rejectedEvaluation(): SelfEvaluation {
  return {
    success: true,
    output_summary: "claimed completion",
    constraint_violations: [],
    should_continue: true,
    execution_evidence: {
      files_changed: ["src/change.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: [],
      success_criteria_remaining: ["still open"],
      progress_estimate: 0.5,
    },
  };
}

describe("RoundTransactionCoordinator", () => {
  it("keeps one stable round ID across rejected attempts", () => {
    assert.equal(makeRoundId("stable", 2), makeRoundId("stable", 2));
    assert.notEqual(makeRoundId("stable", 2), makeRoundId("stable", 3));
  });

  it("rejects with zero commit, then commits and replays exactly once", () => {
    resetPolicyMetrics();
    const backend = new MemoryBackend();
    const engine = new LoopForgeEngine(backend);
    const coordinator = new RoundTransactionCoordinator(engine, backend);
    const prepared = prepareRoundTransaction("tx-retry", 1, []);

    const rejected = coordinator.process({
      snapshot: prepared,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: rejectedEvaluation(),
      extractionSucceeded: true,
      consecutiveRejections: 0,
      successTrajectory: [],
      actualEvidence: [],
    });

    assert.equal(rejected.result.action, "reject");
    assert.equal(rejected.snapshot.phase, "rejected");
    assert.equal(rejected.snapshot.roundId, prepared.roundId);
    assert.equal(
      backend.queryEntries({ prefix: "loop:tx-retry:r1", feedbackOnly: true }).length,
      0,
    );

    const committed = coordinator.process({
      snapshot: rejected.snapshot,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: continuingEvaluation(),
      extractionSucceeded: true,
      consecutiveRejections: 1,
      successTrajectory: [],
      actualEvidence: [],
    });
    assert.equal(committed.result.action, "continue");
    assert.equal(committed.snapshot.phase, "committed");
    assert.equal(committed.snapshot.attempt, 2);
    assert.equal(committed.snapshot.roundId, prepared.roundId);

    const replayed = coordinator.process({
      snapshot: rejected.snapshot,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: rejectedEvaluation(),
      extractionSucceeded: true,
      consecutiveRejections: 1,
      successTrajectory: [],
      actualEvidence: [],
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.result.action, "continue");
    assert.equal(
      backend.queryEntries({ prefix: "loop:tx-retry:r1", feedbackOnly: true }).length,
      1,
    );
    const metrics = getPolicyMetrics("tx-retry");
    assert.equal(metrics.roundAttempts, 2);
    assert.equal(metrics.rejectedAttempts, 1);
    assert.equal(metrics.committedRounds, 1);
    assert.equal(metrics.replayedTransactions, 1);
    assert.equal(metrics.acceptanceRate, 0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Backtrack commit replay (v2.10 — regression guard)
// ═══════════════════════════════════════════════════════════════════════════

describe("backtrack commit replay", () => {
  it("parseRoundTransactionSnapshot accepts backtrack action", () => {
    const base = prepareRoundTransaction("bt-loop", 3, []);
    const snapshot: RoundTransactionSnapshot = {
      ...base,
      phase: "committed",
      afterEvidence: [],
      roundEvidence: [],
      evaluation: {
        success: false,
        output_summary: "stalled",
        constraint_violations: [],
        should_continue: true,
      },
      result: {
        action: "backtrack",
        roundSuccess: false,
        gateContradicted: false,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: false,
        verificationFlags: [],
      },
    };

    const parsed = parseRoundTransactionSnapshot(
      snapshot as unknown as Record<string, unknown>,
    );
    assert.ok(parsed !== null,
      "parseRoundTransactionSnapshot must accept backtrack result");
    assert.equal(parsed!.result!.action, "backtrack");
    assert.equal(parsed!.phase, "committed");
  });

  it("recover replays committed backtrack without re-evaluating", () => {
    const backend = new MemoryBackend();
    const engine = new LoopForgeEngine(backend);
    const coordinator = new RoundTransactionCoordinator(engine, backend);

    // 1. Create a committed backtrack transaction
    const before = prepareRoundTransaction("bt-recover", 5, []);
    const committed: RoundTransactionSnapshot = {
      ...before,
      phase: "committed",
      attempt: 1,
      afterEvidence: [],
      roundEvidence: [],
      evaluation: continuingEvaluation(),
      result: {
        action: "backtrack",
        backtrackTarget: 2,
        backtrackPrompt: "## Backtrack — Round 5 → Restored to Round 2",
        backtrackTriggerRule: "progress_stall",
        backtrackSkippedDiscoveries: [],
        backtrackSkippedFiles: [],
        roundSuccess: false,
        gateContradicted: false,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: false,
        verificationFlags: [],
      },
      updatedAt: Date.now(),
    };

    // Write the committed transaction to the backend
    engine.autoFeedback(
      committed.evaluation!,
      "bt-recover",
      5,
      "test task",
      {
        schema_version: 1,
        round_id: committed.roundId,
        snapshot: committed,
        result: committed.result!,
      },
    );

    // 2. Recover via new coordinator (simulating crash restart)
    const recovered = coordinator.recover(before);
    assert.ok(recovered !== null,
      "recover must find the committed backtrack transaction");
    assert.equal(recovered!.replayed, true);
    assert.equal(recovered!.result.action, "backtrack");
    assert.equal(recovered!.result.backtrackTarget, 2);
    assert.equal(recovered!.result.backtrackTriggerRule, "progress_stall");
  });
});
