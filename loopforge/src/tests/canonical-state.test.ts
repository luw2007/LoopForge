/** Tests for canonical-state — state creation and Markdown rendering. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCanonicalLoopState,
  renderCanonicalStateMarkdown,
  hashCanonicalState,
  stableStringify,
  CANONICAL_STATE_SCHEMA_VERSION,
} from "../canonical-state.js";
import {
  makeLoopCompileRequest,
  makeLoopCompileResponse,
  makeLoopObjective,
  type LoopCompileRequest,
  type LoopCompileResponse,
} from "../protocol.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function request(overrides: Partial<LoopCompileRequest> = {}): LoopCompileRequest {
  return makeLoopCompileRequest({
    loop_id: "test-loop",
    round: 2,
    task: "Fix bugs in auth module",
    max_rounds: 20,
    ...overrides,
  });
}

function response(overrides: Partial<LoopCompileResponse> = {}): LoopCompileResponse {
  return makeLoopCompileResponse({
    loop_id: "test-loop",
    round: 2,
    goal_id: "goal-1",
    loop_objective: makeLoopObjective({
      objective: "Fix bugs in auth module",
      success_criteria: ["all tests pass", "no regressions"],
      hard_constraints: ["no external deps"],
      loop_id: "test-loop",
    }),
    constraints_active: ["no external deps", "all tests pass"],
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// stableStringify
// ═══════════════════════════════════════════════════════════════════════════

describe("stableStringify", () => {
  it("produces deterministic output for object keys", () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    assert.equal(a, b);
  });

  it("handles arrays", () => {
    const result = stableStringify([3, 1, 2]);
    assert.equal(result, "[3,1,2]");
  });

  it("handles nested objects", () => {
    const result = stableStringify({ z: { b: 2, a: 1 }, y: 3 });
    assert.ok(result.includes('"a":1'));
    assert.ok(result.includes('"b":2'));
  });

  it("handles null", () => {
    assert.equal(stableStringify(null), "null");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// hashCanonicalState
// ═══════════════════════════════════════════════════════════════════════════

describe("hashCanonicalState", () => {
  it("produces same hash for equivalent state", () => {
    const req = request();
    const res = response();
    const state1 = createCanonicalLoopState(req, res, "test.md");
    const state2 = createCanonicalLoopState(req, res, "test.md");
    assert.equal(hashCanonicalState(state1), hashCanonicalState(state2));
  });

  it("produces different hash for different state", () => {
    const req = request();
    const state1 = createCanonicalLoopState(req, response(), "a.md");
    const state2 = createCanonicalLoopState(req, response({ round: 3 }), "b.md");
    assert.notEqual(hashCanonicalState(state1), hashCanonicalState(state2));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createCanonicalLoopState
// ═══════════════════════════════════════════════════════════════════════════

describe("createCanonicalLoopState", () => {
  it("sets schema version", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    assert.equal(state.schemaVersion, CANONICAL_STATE_SCHEMA_VERSION);
  });

  it("propagates loopId and round", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    assert.equal(state.loopId, "test-loop");
    assert.equal(state.round, 2);
  });

  it("propagates objective from response", () => {
    const state = createCanonicalLoopState(request(), response({
      loop_objective: makeLoopObjective({
        objective: "Complete all subtasks",
        success_criteria: ["c1", "c2"],
        hard_constraints: ["h1"],
        loop_id: "test-loop",
      }),
    }), "test.md");
    assert.equal(state.objective, "Complete all subtasks");
    assert.deepEqual(state.successCriteria, ["c1", "c2"]);
    assert.deepEqual(state.hardConstraints, ["h1"]);
  });

  it("falls back to task when objective is missing", () => {
    const state = createCanonicalLoopState(request(), response({
      loop_objective: null,
    }), "test.md");
    assert.equal(state.objective, "Fix bugs in auth module");
  });

  it("propagates constraints from response", () => {
    const state = createCanonicalLoopState(request(), response({
      constraints_active: ["c1", "c2"],
      constraints_retired: ["old"],
      constraints_inactive: ["stale"],
    }), "test.md");
    assert.deepEqual(state.activeConstraints, ["c1", "c2"]);
    assert.deepEqual(state.retiredConstraints, ["old"]);
    assert.deepEqual(state.inactiveConstraints, ["stale"]);
  });

  it("propagates rolling summary data", () => {
    const state = createCanonicalLoopState(request(), response({
      rolling_summary: {
        key_outcomes: ["[R1] accepted: fixed bug"],
        recurring_issues: ["flakey test"],
        rounds_sampled: 1,
        generated_at_round: 2,
        milestones: [],
        loop_synthesis: "Loop spans 1 round.",
      },
    }), "test.md");
    assert.ok(state.rollingOutcomes.length > 0);
    assert.ok(state.recurringIssues.length > 0);
  });

  it("propagates sub-goals", () => {
    const state = createCanonicalLoopState(request(), response({
      sub_goals: [
        { id: "sg-1", description: "Task A", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 0 },
      ],
    }), "test.md");
    assert.equal(state.subGoals.length, 1);
    assert.equal(state.subGoals[0].description, "Task A");
  });

  it("uses maxRounds from request when provided", () => {
    const state = createCanonicalLoopState(request({ max_rounds: 50 }), response(), "test.md");
    assert.equal(state.maxRounds, 50);
  });

  it("defaults maxRounds to 20", () => {
    const state = createCanonicalLoopState(request({ max_rounds: undefined }), response(), "test.md");
    assert.equal(state.maxRounds, 20);
  });

  it("propagates verification flags", () => {
    const state = createCanonicalLoopState(request({
      verification_flags: [
        { severity: "warn", field: "test", check: "c1", detail: "detail" },
      ],
    }), response(), "test.md");
    assert.equal(state.verificationFlags.length, 1);
  });

  it("handles empty state without errors", () => {
    const state = createCanonicalLoopState(request({
      last_round_result: null,
    }), response({
      loop_objective: null,
      rolling_summary: null,
    }), "test.md");
    assert.ok(state.objective);
    assert.equal(state.progress.estimate, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderCanonicalStateMarkdown
// ═══════════════════════════════════════════════════════════════════════════

describe("renderCanonicalStateMarkdown", () => {
  it("renders objective and current task", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Loop Objective"));
    assert.ok(md.includes("Current Task"));
    assert.ok(md.includes(state.objective));
  });

  it("renders success criteria", () => {
    const state = createCanonicalLoopState(request(), response({
      loop_objective: makeLoopObjective({
        objective: "test",
        success_criteria: ["c1", "c2"],
        hard_constraints: [],
        loop_id: "test-loop",
      }),
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Success Criteria"));
    assert.ok(md.includes("c1"));
    assert.ok(md.includes("c2"));
  });

  it("renders progress dashboard when estimate is set", () => {
    const req = request({
      last_round_result: {
        round: 1,
        success: true,
        output_summary: "done",
        constraint_violations: [],
        manual_fixes_needed: "",
        execution_evidence: {
          files_changed: ["a.ts"],
          test_results: { passed: 8, failed: 1, skipped: 0 },
          success_criteria_met: ["c1"],
          success_criteria_remaining: ["c2"],
          progress_estimate: 0.5,
        },
      },
    });
    const state = createCanonicalLoopState(req, response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Progress Dashboard"));
    assert.ok(md.includes("50%"));
    assert.ok(md.includes("8 passed"));
    assert.ok(md.includes("1 failed"));
  });

  it("renders milestone phase history", () => {
    const state = createCanonicalLoopState(request(), response({
      rolling_summary: {
        key_outcomes: [],
        recurring_issues: [],
        rounds_sampled: 1,
        generated_at_round: 2,
        milestones: [{
          label: "Phase 1: Auth done",
          round_range: { start: 1, end: 5 },
          outcome: "Completed auth module",
          carried_constraints: ["no deps"],
          resolved_constraints: [],
          progress_at_boundary: 0.3,
          kind: "agent_declared",
          generated_at_round: 5,
        }],
      },
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Phase History"));
    assert.ok(md.includes("Phase 1: Auth done"));
  });

  it("renders sub-goal dashboard", () => {
    const state = createCanonicalLoopState(request(), response({
      sub_goals: [
        { id: "sg-1", description: "Task A", status: "done", declared_at_round: 1, status_changed_at_round: 3, completed_at_round: 3, priority: 0 },
      ],
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Sub-Goal Dashboard"));
    // v2.8: Sub-goal IDs are rendered in the state file
    assert.ok(md.includes("`sg-1`"), "should render sub-goal ID in state file");
  });

  it("renders verification flags", () => {
    const state = createCanonicalLoopState(request({
      verification_flags: [
        { severity: "warn", field: "x", check: "test", detail: "detail text" },
      ],
    }), response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Verification"));
    assert.ok(md.includes("detail text"));
  });

  it("renders agent trust when score is available", () => {
    const state = createCanonicalLoopState(request(), response({
      agent_trust_score: 0.85,
      agent_trust_trend: [0.9, 0.85, 0.8],
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Agent Trust"));
    assert.ok(md.includes("85%"));
    assert.ok(md.includes("0.9 → 0.85 → 0.8"));
  });

  it("always ends with a newline", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.endsWith("\n"));
  });
});
