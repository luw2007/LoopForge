/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */

import { createHash } from "node:crypto";
import type {
  ConstraintMeta,
  LoopCompileRequest,
  LoopCompileResponse,
  MilestoneSummary,
  SubGoal,
  VerificationFlag,
} from "./protocol.js";
import { unique } from "./token-utils.js";
import { getPolicy } from "./policy.js";

export const CANONICAL_STATE_SCHEMA_VERSION = 1 as const;

export interface CanonicalLoopState {
  schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
  loopId: string;
  round: number;
  maxRounds: number;
  goalId: string;
  objective: string;
  objectiveVersion: number;
  currentTask: string;
  successCriteria: string[];
  hardConstraints: string[];
  activeConstraints: string[];
  retiredConstraints: string[];
  /** v2.3: Constraints demoted to inactive after prolonged inactivity. */
  inactiveConstraints: string[];
  /** v2.3: Per-constraint lifecycle metadata. */
  constraintMetadata: ConstraintMeta[];
  changesSinceLastRound: string[];
  remainingCriteria: string[];
  blockers: string[];
  verificationFlags: VerificationFlag[];
  discoveries: string[];
  nextAction: string;
  rollingOutcomes: string[];
  recurringIssues: string[];
  failedPatterns: string[];
  /** v2.6: derived from agent_declared milestones. */
  checkpoints: Array<{ label: string; declared_at_round: number; outcome: string; carried_constraints: string[]; resolved_constraints: string[] }>;
  /** v2.1: Phase-boundary milestone summaries that survive window eviction. */
  milestones: MilestoneSummary[];
  /** v2.1: Single-paragraph loop-level synthesis (formulaic). */
  loopSynthesis: string;
  /** v2.2: Structured sub-goals with compiler-managed lifecycle. */
  subGoals: SubGoal[];
  /** v2.5: Agent trust score [0, 1] from verification flags. */
  agentTrustScore: number | undefined;
  /** v2.5: Trust trend over last 10 rounds. */
  agentTrustTrend: number[];
  suggestedNextTask: string;
  externalContext: string;
  stateFilePath: string;
  progress: {
    estimate: number | null;
    criteriaMet: string[];
    criteriaRemaining: string[];
    filesChanged: string[];
    tests: { passed: number; failed: number; skipped: number } | null;
  };
}

// unique() imported from token-utils.ts

/** Deterministic JSON serialization used by state and prompt hashes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(",")}}`;
}

export function hashCanonicalState(state: CanonicalLoopState): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

function addList(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`## ${title}`, "");
  for (const value of values) lines.push(`- ${value}`);
  lines.push("");
}

/** v2.11: Derive a stable 8-char hex ID from text using SHA-256.
 *  Same hash strategy as computeGoalTextHash in loop-compiler.ts. */
function deriveItemId(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex").slice(0, 8);
}

/** v2.11: Render a list with ID prefixes when constraint_id_enabled is true.
 *  Each item gets a [prefix-XXXXXXXX] tag derived from its text hash.
 *  Items that already look like IDs (e.g. "cr-a3f2b1c0") are rendered as-is. */
function addListWithIds(
  lines: string[],
  title: string,
  values: string[],
  prefix: string,
): void {
  if (values.length === 0) return;
  const idEnabled = getPolicy().evolution.constraint_id_enabled;
  lines.push(`## ${title}`, "");
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    // If the value is already an ID, render it as-is
    const idRegex = /^(c|cr|sg)-[a-f0-9]{8}$/;
    if (idRegex.test(trimmed)) {
      lines.push(`- [\`${trimmed}\`] ${trimmed}`);
    } else if (idEnabled) {
      const id = prefix + "-" + deriveItemId(trimmed);
      lines.push(`- [\`${id}\`] ${trimmed}`);
    } else {
      lines.push(`- ${trimmed}`);
    }
  }
  lines.push("");
}

/** Human/Agent-readable materialized view. It is always reproducible from the
 * canonical state and is never consulted as transaction truth. */
export function renderCanonicalStateMarkdown(state: CanonicalLoopState): string {
  const lines = [
    `# LoopForge State — ${state.loopId}`,
    "",
    `**Schema**: ${state.schemaVersion}`,
    `**Round**: ${state.round}/${state.maxRounds}`,
    `**Goal ID**: ${state.goalId}`,
    "",
    "## Loop Objective",
    "",
    state.objective,
    "",
    "## Current Task",
    "",
    state.currentTask,
    "",
  ];
  // v2.11: Success Criteria and Constraints render with stable IDs for exact agent matching
  addListWithIds(lines, "Success Criteria", state.successCriteria, "cr");
  addListWithIds(lines, "Hard Constraints", state.hardConstraints, "c");
  addListWithIds(lines, "Active Constraints", state.activeConstraints, "c");
  addList(lines, "Changes Since Last Round", state.changesSinceLastRound);
  if (
    state.progress.estimate !== null ||
    state.progress.criteriaMet.length > 0 ||
    state.progress.criteriaRemaining.length > 0 ||
    state.progress.filesChanged.length > 0 ||
    state.progress.tests !== null
  ) {
    const total = state.progress.criteriaMet.length + state.progress.criteriaRemaining.length;
    lines.push("## Progress Dashboard", "");
    if (total > 0) {
      lines.push(`**Criteria**: ${state.progress.criteriaMet.length}/${total}`);
    }
    if (state.progress.estimate !== null) {
      lines.push(`**Estimated Completion**: ${(state.progress.estimate * 100).toFixed(0)}%`);
    }
    if (state.progress.tests) {
      lines.push(
        `**Tests**: ${state.progress.tests.passed} passed, ` +
        `${state.progress.tests.failed} failed, ${state.progress.tests.skipped} skipped`,
      );
    }
    if (state.progress.filesChanged.length > 0) {
      lines.push("", "**Files Changed**:");
      for (const file of state.progress.filesChanged) lines.push(`- ${file}`);
    }
    lines.push("");
  }
  addListWithIds(lines, "Remaining", state.remainingCriteria, "cr");
  addList(lines, "Blockers", state.blockers);
  addList(lines, "Discoveries", state.discoveries);
  addList(lines, "Cross-Round Outcomes", state.rollingOutcomes);
  addList(lines, "Recurring Issues", state.recurringIssues);
  addList(lines, "Failed Patterns", state.failedPatterns);
  addList(lines, "Retired Constraints", state.retiredConstraints);
  if (state.inactiveConstraints.length > 0) {
    lines.push("## Inactive Constraints", "");
    lines.push(
      "> Demoted after prolonged inactivity. Removed from prompts ",
      "but kept here. Auto-reactivated if violated again.",
      "",
    );
    const idEnabled = getPolicy().evolution.constraint_id_enabled;
    for (const c of state.inactiveConstraints) {
      const meta = state.constraintMetadata.find((m) => m.text === c);
      const age = meta
        ? state.round - (meta.last_violated_at_round || meta.discovered_at_round || 0)
        : "?";
      const lastV = meta?.last_violated_at_round
        ? `last violated R${meta.last_violated_at_round}`
        : "never violated";
      const idLabel = idEnabled && meta?.id
        ? `[\`${meta.id}\`] `
        : "";
      lines.push(`- ${idLabel}${c} (${lastV}, ${age} rounds inactive)`);
    }
    lines.push("");
  }
  if (state.nextAction) {
    lines.push("## Next Action", "", state.nextAction, "");
  }
  if (state.verificationFlags.length > 0) {
    lines.push("## Verification", "");
    for (const flag of state.verificationFlags) {
      lines.push(`- [${flag.severity}] [${flag.check}] ${flag.detail}`);
    }
    lines.push("");
  }
  if (state.milestones.length > 0) {
    lines.push("## Phase History", "");
    for (const m of state.milestones) {
      const kindIcon = m.kind === "agent_declared"
        ? "🏁"
        : m.kind === "criteria_milestone" ? "✅" : "📍";
      lines.push(
        `### ${kindIcon} ${m.label}`,
        `Rounds ${m.round_range.start}–${m.round_range.end} | ` +
        `Progress: ${(m.progress_at_boundary * 100).toFixed(0)}%`,
        "",
        `**Outcome**: ${m.outcome}`,
        "",
      );
      if (m.carried_constraints.length > 0) {
        lines.push("**Carried Constraints**:");
        for (const c of m.carried_constraints) lines.push(`- ${c}`);
        lines.push("");
      }
      if (m.resolved_constraints.length > 0) {
        lines.push("**Resolved During Phase**:");
        for (const c of m.resolved_constraints) lines.push(`- ${c}`);
        lines.push("");
      }
    }
  }
  if (state.subGoals.length > 0) {
    lines.push("## Sub-Goal Dashboard", "");
    for (const sg of state.subGoals) {
      const statusIcon =
        sg.status === "in_progress" ? "🔄" :
        sg.status === "done" ? "✅" :
        sg.status === "blocked" ? "🚫" :
        sg.status === "canceled" ? "❌" : "⏳";
      const stale = sg.status === "pending" &&
        state.round - sg.declared_at_round >= 10 ? " ⚠️ stale" : "";
      const detail = sg.status === "done" && sg.completed_at_round
        ? ` (done, R${sg.completed_at_round})`
        : sg.status === "in_progress"
        ? ` (since R${sg.status_changed_at_round})`
        : sg.status === "pending"
        ? ` (since R${sg.declared_at_round})`
        : sg.status === "blocked"
        ? ` (blocked R${sg.status_changed_at_round})`
        : ` (canceled R${sg.status_changed_at_round})`;
      lines.push(`- ${statusIcon} [\`${sg.id}\`] ${sg.description}${detail}${stale}`);
    }
    lines.push("");
  }
  if (state.agentTrustScore !== undefined) {
    const barLen = 10;
    const filled = Math.round(state.agentTrustScore * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const avg = state.agentTrustTrend.length > 0
      ? (state.agentTrustTrend.reduce((a, b) => a + b, 0) / state.agentTrustTrend.length).toFixed(2)
      : "—";
    lines.push(
      "## Agent Trust", "",
      `${bar} ${(state.agentTrustScore * 100).toFixed(0)}%`,
      `Trend (last ${state.agentTrustTrend.length}): ${state.agentTrustTrend.join(" → ")}`,
      `Average: ${avg}`,
      "",
    );
  }
  if (state.loopSynthesis) {
    lines.push("## Loop Summary", "", state.loopSynthesis, "");
  }
  if (state.externalContext) {
    lines.push("## External Context", "", state.externalContext, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function createCanonicalLoopState(
  request: LoopCompileRequest,
  response: LoopCompileResponse,
  stateFilePath: string,
): CanonicalLoopState {
  const last = request.last_round_result;
  const objective = response.loop_objective;
  const verificationFlags = request.verification_flags ?? [];
  const rolling = response.rolling_summary;
  const executionEvidence = last?.execution_evidence;

  const changes = unique([
    request.new_since_last_round,
    last?.output_summary,
    ...(last?.wrong_assumptions ?? []).map((value) =>
      `Corrected assumption: ${value}`,
    ),
  ]);

  const discoveries = unique([
    ...(last?.discovered_constraints ?? []),
    ...(last?.emerged_subtasks ?? []),
  ]);

  const blockers = unique([
    ...(last?.constraint_violations ?? []),
    last?.manual_fixes_needed,
    request.rejection_notice,
    ...response.warnings,
  ]);

  return {
    schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
    loopId: response.loop_id || request.loop_id,
    round: response.round || request.round,
    maxRounds: request.max_rounds ?? 20,
    goalId: response.goal_id,
    objective: objective?.objective || request.task,
    objectiveVersion: objective?.version ?? 1,
    currentTask: request.task,
    successCriteria: unique(objective?.success_criteria ?? []),
    hardConstraints: unique(objective?.hard_constraints ?? []),
    activeConstraints: unique(response.constraints_active),
    retiredConstraints: unique(response.constraints_retired),
    inactiveConstraints: unique(response.constraints_inactive ?? []),
    constraintMetadata: response.constraint_metadata ?? [],
    changesSinceLastRound: changes,
    remainingCriteria: unique(
      last?.execution_evidence?.success_criteria_remaining ?? [],
    ),
    blockers,
    verificationFlags,
    discoveries,
    nextAction: last?.next_action?.trim() || response.suggested_next_task,
    rollingOutcomes: unique(rolling?.key_outcomes ?? []),
    recurringIssues: unique(rolling?.recurring_issues ?? []),
    failedPatterns: unique(rolling?.failed_patterns ?? []),
    // v2.5: checkpoints derived from agent_declared milestones (unified)
    checkpoints: (rolling?.milestones ?? [])
      .filter((m) => m.kind === "agent_declared")
      .map((m) => ({
        label: m.label,
        declared_at_round: m.generated_at_round,
        outcome: m.outcome,
        carried_constraints: m.carried_constraints,
        resolved_constraints: m.resolved_constraints,
      })),
    milestones: rolling?.milestones ?? [],
    loopSynthesis: rolling?.loop_synthesis ?? "",
    subGoals: response.sub_goals ?? [],
    agentTrustScore: response.agent_trust_score,
    agentTrustTrend: response.agent_trust_trend ?? [],
    suggestedNextTask: response.suggested_next_task,
    externalContext: request.external_context?.trim() ?? "",
    stateFilePath,
    progress: {
      estimate: executionEvidence?.progress_estimate ?? null,
      criteriaMet: unique(executionEvidence?.success_criteria_met ?? []),
      criteriaRemaining: unique(
        executionEvidence?.success_criteria_remaining ?? [],
      ),
      filesChanged: unique(executionEvidence?.files_changed ?? []),
      tests: executionEvidence?.test_results ?? null,
    },
  };
}
