/** Tests for self-eval — structured extraction and heuristic fallback. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSelfEvaluation,
  buildSelfEvaluation,
  parseExecutionEvidence,
} from "../self-eval.js";

// ═══════════════════════════════════════════════════════════════════════════
// parseExecutionEvidence
// ═══════════════════════════════════════════════════════════════════════════

describe("parseExecutionEvidence", () => {
  it("parses valid execution evidence", () => {
    const result = parseExecutionEvidence({
      files_changed: ["a.ts", "b.ts"],
      test_results: { passed: 8, failed: 1, skipped: 2 },
      success_criteria_met: ["reentrancy fixed"],
      success_criteria_remaining: ["access control"],
      progress_estimate: 0.5,
    });
    assert.ok(result);
    assert.deepEqual(result!.files_changed, ["a.ts", "b.ts"]);
    assert.equal(result!.test_results!.passed, 8);
    assert.equal(result!.progress_estimate, 0.5);
  });

  it("returns undefined for null input", () => {
    assert.equal(parseExecutionEvidence(null), undefined);
  });

  it("returns undefined for undefined input", () => {
    assert.equal(parseExecutionEvidence(undefined), undefined);
  });

  it("clamps progress_estimate to [0, 1]", () => {
    const high = parseExecutionEvidence({ progress_estimate: 1.5 });
    assert.equal(high!.progress_estimate, 1);
    const low = parseExecutionEvidence({ progress_estimate: -0.5 });
    assert.equal(low!.progress_estimate, 0);
  });

  it("defaults missing test_results to null", () => {
    const result = parseExecutionEvidence({});
    assert.equal(result!.test_results, null);
  });

  it("filters non-string from files_changed", () => {
    const result = parseExecutionEvidence({
      files_changed: ["a.ts", 42, "b.ts"],
    });
    assert.deepEqual(result!.files_changed, ["a.ts", "b.ts"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildSelfEvaluation
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSelfEvaluation", () => {
  it("builds from a complete raw object", () => {
    const raw: Record<string, unknown> = {
      success: true,
      output_summary: "Fixed 3 bugs",
      constraint_violations: [],
      should_continue: true,
      discovered_constraints: ["use SafeERC20"],
      objective_refinement: "scope expanded",
      emerged_subtasks: ["audit timelock"],
      execution_evidence: {
        files_changed: ["token.sol"],
        test_results: { passed: 10, failed: 0, skipped: 0 },
        success_criteria_met: ["no reentrancy"],
        success_criteria_remaining: [],
        progress_estimate: 0.3,
      },
      completed_subtasks: ["setup tests"],
      blocked_subtasks: [],
      canceled_subtasks: [],
      next_action: "audit upgrade proxy",
    };
    const result = buildSelfEvaluation(raw);
    assert.equal(result.success, true);
    assert.equal(result.output_summary, "Fixed 3 bugs");
    assert.deepEqual(result.discovered_constraints, ["use SafeERC20"]);
    assert.deepEqual(result.emerged_subtasks, ["audit timelock"]);
    assert.ok(result.execution_evidence);
    assert.equal(result.execution_evidence!.progress_estimate, 0.3);
    assert.deepEqual(result.completed_subtasks, ["setup tests"]);
    assert.equal(result.next_action, "audit upgrade proxy");
  });

  it("uses sensible defaults for missing fields", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.success, false);
    assert.deepEqual(result.discovered_constraints, []);
    assert.equal(result.objective_refinement, "");
    assert.equal(result.next_action, undefined);
  });

  it("handles non-boolean success gracefully", () => {
    const result = buildSelfEvaluation({
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
    });
    assert.equal(result.success, false);
  });

  it("handles non-string output_summary gracefully", () => {
    const result = buildSelfEvaluation({
      success: true,
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.output_summary, "");
  });

  it("parses valid stop_reason", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
      stop_reason: "blocked",
    });
    assert.equal(result.stop_reason, "blocked");
  });

  it("ignores invalid stop_reason values", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
      stop_reason: "invalid_value",
    });
    assert.equal(result.stop_reason, undefined);
  });

  // v2.8: Drift clarification
  it("parses drift_clarification when present", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "fixed css",
      constraint_violations: [],
      should_continue: true,
      drift_clarification: "Pivoted because auth module was already refactored in R3",
    });
    assert.equal(
      result.drift_clarification,
      "Pivoted because auth module was already refactored in R3",
    );
  });

  it("leaves drift_clarification undefined when absent", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "fixed css",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.drift_clarification, undefined);
  });

  it("leaves drift_clarification undefined for non-string values", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      drift_clarification: 123,
    } as Record<string, unknown>);
    assert.equal(result.drift_clarification, undefined);
  });

  // ── v2.9: prompt_requests parsing ──────────────────────────────────────

  it("parses prompt_requests with all fields", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: {
        emphasize: ["SafeERC20", "gas optimization"],
        expand: ["milestones", "sub_goals"],
        confusion_points: ["Why is milestone 3 complete?"],
      },
    });
    assert.ok(result.prompt_requests);
    assert.deepEqual(result.prompt_requests!.emphasize, ["SafeERC20", "gas optimization"]);
    assert.deepEqual(result.prompt_requests!.expand, ["milestones", "sub_goals"]);
    assert.deepEqual(result.prompt_requests!.confusion_points, ["Why is milestone 3 complete?"]);
  });

  it("returns undefined for absent prompt_requests", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.prompt_requests, undefined);
  });

  it("returns undefined for all-empty prompt_requests", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: { emphasize: [], expand: [], confusion_points: [] },
    });
    assert.equal(result.prompt_requests, undefined);
  });

  it("filters invalid expand values", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: { expand: ["milestones", "invalid_section", "sub_goals"] },
    });
    assert.deepEqual(result.prompt_requests!.expand, ["milestones", "sub_goals"]);
  });

  it("ignores non-object prompt_requests", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: "not an object",
    } as Record<string, unknown>);
    assert.equal(result.prompt_requests, undefined);
  });

  it("caps emphasize and confusion_points at reasonable limits", () => {
    const manyItems = Array.from({ length: 20 }, (_, i) => `item ${i}`);
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: {
        emphasize: manyItems,
        confusion_points: manyItems,
      },
    });
    assert.ok(result.prompt_requests!.emphasize!.length <= 10);
    assert.ok(result.prompt_requests!.confusion_points!.length <= 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractSelfEvaluation
// ═══════════════════════════════════════════════════════════════════════════

describe("extractSelfEvaluation", () => {
  const delimiter = "---loopforge-eval\n";
  const endDelim = "\n---end-loopforge-eval";

  it("extracts a valid eval block from agent output", () => {
    const output = `Some agent text\n${delimiter}${
      JSON.stringify({
        success: true,
        output_summary: "all done",
        constraint_violations: [],
        should_continue: false,
      })
    }${endDelim}\nMore text.`;
    const result = extractSelfEvaluation(output);
    assert.ok(result);
    assert.equal(result!.success, true);
    assert.equal(result!.should_continue, false);
  });

  it("returns null when no eval block found", () => {
    const result = extractSelfEvaluation("just some text without delimiters");
    assert.equal(result, null);
  });

  it("returns null for invalid JSON in eval block", () => {
    const result = extractSelfEvaluation(`${delimiter}{not json}${endDelim}`);
    assert.equal(result, null);
  });

  it("returns null when required fields are wrong type", () => {
    const result = extractSelfEvaluation(`${delimiter}${
      JSON.stringify({
        success: "not boolean",
        output_summary: 123,
        constraint_violations: "not array",
        should_continue: "not boolean",
      })
    }${endDelim}`);
    assert.equal(result, null);
  });

  it("returns null when success field is missing", () => {
    const result = extractSelfEvaluation(`${delimiter}${
      JSON.stringify({
        output_summary: "done",
        constraint_violations: [],
        should_continue: false,
      })
    }${endDelim}`);
    assert.equal(result, null);
  });

  it("parses optional fields when present", () => {
    const output = `${delimiter}${
      JSON.stringify({
        success: true,
        output_summary: "done",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: ["new rule"],
        execution_evidence: {
          files_changed: ["a.ts"],
          progress_estimate: 0.7,
        },
      })
    }${endDelim}`;
    const result = extractSelfEvaluation(output);
    assert.ok(result);
    assert.deepEqual(result!.discovered_constraints, ["new rule"]);
    assert.equal(result!.execution_evidence!.progress_estimate, 0.7);
  });
});

// v2.6: heuristicSelfEvaluation removed.
