/** Tests for prompt-assembler — single-pass prompt rendering. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemblePromptArtifact, DEFAULT_PROMPT_BUDGETS } from "../prompt-assembler.js";
import type { PromptAssemblyInput } from "../prompt-assembler.js";
import type { CanonicalLoopState } from "../canonical-state.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function minimalState(overrides: Partial<CanonicalLoopState> = {}): CanonicalLoopState {
  return {
    schemaVersion: 1 as const,
    loopId: "test-loop",
    round: 1,
    maxRounds: 20,
    goalId: "goal-1",
    objective: "Test the assembler",
    objectiveVersion: 1,
    currentTask: "Write tests for the assembler",
    successCriteria: ["all tests pass"],
    hardConstraints: ["no runtime deps"],
    activeConstraints: ["no runtime deps", "all tests pass"],
    retiredConstraints: [],
    inactiveConstraints: [],
    constraintMetadata: [],
    changesSinceLastRound: [],
    remainingCriteria: [],
    blockers: [],
    verificationFlags: [],
    discoveries: [],
    nextAction: "",
    rollingOutcomes: [],
    recurringIssues: [],
    failedPatterns: [],
    checkpoints: [],
    milestones: [],
    loopSynthesis: "",
    subGoals: [],
    suggestedNextTask: "",
    externalContext: "",
    agentTrustScore: undefined,
    agentTrustTrend: [],
    stateFilePath: ".loopforge/state/test.md",
    progress: {
      estimate: null,
      criteriaMet: [],
      criteriaRemaining: [],
      filesChanged: [],
      tests: null,
    },
    ...overrides,
  };
}

function input(overrides: Partial<PromptAssemblyInput> = {}): PromptAssemblyInput {
  return {
    state: minimalState(),
    level: "l2",
    reasons: ["first_round"],
    mode: "adaptive",
    attempt: 1,
    selfEvaluationBlock: "",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// L0 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L0", () => {
  it("includes mandatory objective and task sections", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(artifact.renderedPrompt.includes("Current Task"));
    assert.equal(artifact.level, "l0");
  });

  it("includes retry requirements when blockers present", () => {
    const state = minimalState({
      blockers: ["fix progress regression"],
      verificationFlags: [
        { severity: "warn", field: "test", check: "test_flag", detail: "flag detail" },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l0", state }));
    assert.ok(artifact.renderedPrompt.includes("Retry Requirements"));
  });

  it("respects L0 budget of 3000 characters", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.equal(artifact.budgetChars, 3000);
  });

  it("records included sections", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.ok(artifact.includedSections.includes("objective"));
    assert.ok(artifact.includedSections.includes("current_task"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L1 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L1", () => {
  it("includes mandatory sections", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(artifact.renderedPrompt.includes("Current Task"));
    assert.equal(artifact.level, "l1");
  });

  it("respects L1 budget of 7000 characters", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.equal(artifact.budgetChars, 7000);
  });

  it("includes sub-goals when present (compact, max 5)", () => {
    const state = minimalState({
      subGoals: [
        { id: "sg-1", description: "Task A", status: "in_progress", declared_at_round: 1, status_changed_at_round: 2, priority: 0 },
        { id: "sg-2", description: "Task B", status: "pending", declared_at_round: 2, status_changed_at_round: 2, priority: 1 },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l1", state }));
    assert.ok(artifact.renderedPrompt.includes("Active Sub-Goals"));
    // v2.8: Sub-goal IDs are rendered for exact matching
    assert.ok(artifact.renderedPrompt.includes("`sg-1`"), "should render sub-goal ID sg-1");
    assert.ok(artifact.renderedPrompt.includes("`sg-2`"), "should render sub-goal ID sg-2");
  });

  it("shows recent rounds when outcomes exist", () => {
    const state = minimalState({
      rollingOutcomes: ["[R1] accepted: fixed auth"],
    });
    const artifact = assemblePromptArtifact(input({ level: "l1", state }));
    assert.ok(artifact.renderedPrompt.includes("Recent Rounds"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L2 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L2", () => {
  it("includes full state when fullStateMarkdown is provided", () => {
    const md = "# Full State\nThe complete state content.";
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      fullStateMarkdown: md,
    }));
    assert.ok(artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("includes milestones section when milestones exist", () => {
    const state = minimalState({
      milestones: [{
        label: "Phase 1",
        round_range: { start: 1, end: 5 },
        outcome: "completed core",
        carried_constraints: ["no deps"],
        resolved_constraints: [],
        progress_at_boundary: 0.5,
        kind: "auto",
        generated_at_round: 5,
      }],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Phase History"));
  });

  it("includes sub-goal dashboard when sub-goals exist", () => {
    const state = minimalState({
      subGoals: [
        { id: "sg-1", description: "Task A", status: "done", declared_at_round: 1, status_changed_at_round: 3, completed_at_round: 3, priority: 0 },
        { id: "sg-2", description: "Task B", status: "in_progress", declared_at_round: 2, status_changed_at_round: 4, priority: 1 },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Sub-Goal Dashboard"));
    assert.ok(artifact.renderedPrompt.includes("done"));
    // v2.8: Sub-goal IDs are rendered for exact matching
    assert.ok(artifact.renderedPrompt.includes("`sg-1`"), "should render sub-goal ID sg-1");
    assert.ok(artifact.renderedPrompt.includes("`sg-2`"), "should render sub-goal ID sg-2");
  });

  it("includes failed patterns when present", () => {
    const state = minimalState({
      failedPatterns: ["repeated auth failure pattern"],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Failed Patterns"));
  });

  it("respects L2 budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l2" }));
    assert.equal(artifact.budgetChars, DEFAULT_PROMPT_BUDGETS.l2);
  });

  // ── v2.8: L2 pointer mode — path B structured rendering ──────────────

  it("renders structured sections (not blob) when fullStateMarkdown is absent", () => {
    const state = minimalState({
      milestones: [{
        label: "Phase 1", round_range: { start: 1, end: 5 },
        outcome: "done", carried_constraints: [], resolved_constraints: [],
        progress_at_boundary: 0.5, kind: "auto" as const, generated_at_round: 5,
      }],
      subGoals: [
        { id: "sg-1", description: "Task A", status: "done" as const,
          declared_at_round: 1, status_changed_at_round: 3,
          completed_at_round: 3, priority: 0 },
      ],
      inactiveConstraints: ["old-constraint"],
      constraintMetadata: [{
        id: "c-oldcons", text: "old-constraint", discovered_at_round: 1,
        last_violated_at_round: 0, source: "discovered" as const,
        status: "inactive" as const,
      }],
      agentTrustScore: 0.85,
      agentTrustTrend: [0.9, 0.85],
      progress: {
        estimate: 0.6, criteriaMet: ["auth"], criteriaRemaining: ["api"],
        filesChanged: ["src/auth.ts"],
        tests: { passed: 42, failed: 0, skipped: 0 },
      },
      retiredConstraints: ["old-rule"],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      fullStateMarkdown: undefined, // ← pointer mode
      state,
    }));
    // Path B structured rendering
    assert.ok(artifact.renderedPrompt.includes("Phase History"));
    assert.ok(artifact.renderedPrompt.includes("Sub-Goal Dashboard"));
    // v2.8 gap fills
    assert.ok(artifact.renderedPrompt.includes("Progress Dashboard"));
    assert.ok(artifact.renderedPrompt.includes("60%"));
    assert.ok(artifact.renderedPrompt.includes("Inactive Constraints"));
    assert.ok(artifact.renderedPrompt.includes("Agent Trust"));
    assert.ok(artifact.renderedPrompt.includes("85%"));
    assert.ok(artifact.renderedPrompt.includes("Retired Constraints"));
    // Must NOT contain the monolithic blob header
    assert.ok(!artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("renders full state blob when fullStateMarkdown is provided (backward compat)", () => {
    const md = "# Full State\nThe complete cognitive state.";
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      fullStateMarkdown: md,
    }));
    assert.ok(artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("includes read instruction for L2 pointer mode reasons", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      reasons: ["periodic_refresh"],
      fullStateMarkdown: undefined,
    }));
    assert.ok(artifact.renderedPrompt.includes("Read the full state file before acting"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Artifact metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — metadata", () => {
  it("includes schema version", () => {
    const artifact = assemblePromptArtifact(input());
    assert.equal(artifact.schemaVersion, 1);
  });

  it("generates a prompt hash", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.promptHash.length > 0);
    assert.equal(typeof artifact.promptHash, "string");
  });

  it("generates a state hash", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.stateHash.length > 0);
  });

  it("produces deterministic hashes for identical input", () => {
    const a = assemblePromptArtifact(input());
    const b = assemblePromptArtifact(input());
    assert.equal(a.promptHash, b.promptHash);
    assert.equal(a.stateHash, b.stateHash);
  });

  it("records budget exceeded when applicable", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      budgets: { l0: 10 },
    }));
    assert.ok(artifact.budgetExceeded);
  });

  it("includes how-to-complete footer", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.renderedPrompt.includes("How to Complete This Round"));
  });

  it("includes level reasons", () => {
    const artifact = assemblePromptArtifact(input({ reasons: ["first_round", "plan_boundary"] }));
    assert.ok(artifact.levelReasons.includes("first_round"));
    assert.ok(artifact.levelReasons.includes("plan_boundary"));
  });

  it("mandatory sections are always included even under budget", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      budgets: { l0: 50 },
    }));
    // objective and current_task should still be included
    assert.ok(artifact.renderedPrompt.includes("Objective"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.9: prompt_requests rendering
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — prompt_requests L2", () => {
  it("renders confusion alerts at the top when present", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: {
        confusion_points: ["I don't understand milestone tracking"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(artifact.renderedPrompt.includes("I don't understand milestone tracking"));
    // Confusion alerts should appear before the Objective
    const alertIdx = artifact.renderedPrompt.indexOf("⚠️ Confusion Alerts");
    const objIdx = artifact.renderedPrompt.indexOf("Objective");
    assert.ok(alertIdx < objIdx, "confusion alerts should come before objective");
  });

  it("renders critical context with emphasized items", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["use SafeERC20 for all external calls"],
        discoveries: ["timelock has minimum delay of 2 days"],
      }),
      promptRequests: {
        emphasize: ["use SafeERC20 for external calls"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.ok(artifact.renderedPrompt.includes("SafeERC20"));
  });

  it("includes confusion_alerts and critical_context in includedSections", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["no runtime deps", "all tests pass"],
        discoveries: ["SafeERC20 required for all external contract calls"],
      }),
      promptRequests: {
        confusion_points: ["confused about X"],
        emphasize: ["SafeERC20 required for external calls"],
      },
    }));
    assert.ok(artifact.includedSections.includes("confusion_alerts"));
    assert.ok(artifact.includedSections.includes("critical_context"));
  });

  it("ignores expand in L2 (already expanded)", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({ milestones: [{ label: "Phase 1", round_range: { start: 1, end: 5 }, outcome: "done", carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.5, kind: "agent_declared", generated_at_round: 5 }] }),
      promptRequests: {
        expand: ["milestones"],
      },
    }));
    // Should NOT have an "expand:" entry in includedSections for L2
    const expandEntries = artifact.includedSections.filter((s) => s.startsWith("expand:"));
    assert.equal(expandEntries.length, 0);
  });
});

describe("assemblePromptArtifact — prompt_requests L1", () => {
  it("renders confusion alerts with first entry only", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      promptRequests: {
        confusion_points: ["confused about A", "also confused about B"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("confused about A"));
    // Second confusion point should be collapsed
    assert.ok(artifact.renderedPrompt.includes("1 more confusion point"));
    assert.ok(!artifact.renderedPrompt.includes("also confused about B"));
  });

  it("expands a single section when requested", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        loopSynthesis: "Loop spans 15 rounds across 3 phases.",
      }),
      promptRequests: {
        expand: ["loop_synthesis"],
      },
    }));
    assert.ok(artifact.includedSections.some((s) => s === "expand:loop_synthesis"));
    assert.ok(artifact.renderedPrompt.includes("Loop spans"));
  });

  it("only expands first section when multiple requested in L1", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        milestones: [{ label: "P1", round_range: { start: 1, end: 3 }, outcome: "ok", carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.3, kind: "auto", generated_at_round: 3 }],
        loopSynthesis: "Synthesis text.",
      }),
      promptRequests: {
        expand: ["milestones", "loop_synthesis"],
      },
    }));
    // Only the first expand entry should be rendered
    const expandEntries = artifact.includedSections.filter((s) => s.startsWith("expand:"));
    assert.equal(expandEntries.length, 1);
    assert.equal(expandEntries[0], "expand:milestones");
  });

  it("caps emphasize at L1 limit (3)", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        activeConstraints: ["A", "B", "C", "D", "E"],
      }),
      promptRequests: {
        emphasize: ["A", "B", "C", "D", "E"],
      },
    }));
    // Should only show at most 3 (L1 cap)
    const criticalSection = artifact.renderedPrompt.indexOf("🔴 Critical Context");
    assert.ok(criticalSection >= 0);
  });
});

describe("assemblePromptArtifact — prompt_requests L0", () => {
  it("ignores all prompt_requests in L0", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      promptRequests: {
        confusion_points: ["I am confused"],
        emphasize: ["important constraint"],
        expand: ["milestones"],
      },
    }));
    assert.ok(!artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.ok(!artifact.renderedPrompt.includes("I am confused"));
  });
});

describe("assemblePromptArtifact — prompt_requests backward compatibility", () => {
  it("renders normally when promptRequests is undefined", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: undefined,
    }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(!artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
  });

  it("renders normally with empty prompt_requests fields", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: { emphasize: [], expand: [], confusion_points: [] },
    }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(!artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
  });
});
