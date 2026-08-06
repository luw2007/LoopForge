/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */

import { createHash } from "node:crypto";
import { getPolicy } from "./policy.js";
import {
  AgentStatus,
  makeLoopCompileResponse,
  makeLoopHealth,
  makeLoopObjective,
  makeConstraintMeta,
  makeMilestoneSummary,
  makeRollingSummary,
  makeSubGoal,
  makeTaskAlignment,
  type ConstraintMeta,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopHealth,
  type LoopObjective,
  type LoopRoundResult,
  type MilestoneSummary,
  type RollingSummary,
  type SubGoal,
  type TaskAlignment,
  type VerificationFlag,
} from "./protocol.js";
import {
  createCanonicalLoopState,
  renderCanonicalStateMarkdown,
} from "./canonical-state.js";
import { assemblePromptArtifact } from "./prompt-assembler.js";
import {
  decidePromptLevel,
  type PromptLevelDecision,
} from "./prompt-policy.js";
import { jaccardSimilarity, unique, entryRound } from "./token-utils.js";

type Entry = Record<string, unknown>;

export interface PreviousRound {
  round: number;
  goal_id: string;
  goal_text_hash: string;
  success: boolean;
  task: string;
  constraints_active: string[];
  output_summary: string;
}

function contextEntries(context: Record<string, unknown> | null): Entry[] {
  if (!context || !Array.isArray(context.results)) return [];
  return context.results.filter(
    (value): value is Entry => value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

function lineage(entry: Entry): Entry {
  const value = entry.loop_lineage ?? entry.lineage;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Entry
    : {};
}

function loopEntries(loopId: string, context: Record<string, unknown> | null): Entry[] {
  return contextEntries(context)
    .filter((entry) => entry.loop_id === loopId || lineage(entry).loop_id === loopId)
    .sort((a, b) => entryRound(a) - entryRound(b));
}

export function computeGoalTextHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function deriveGoalId(loopId: string, task: string, explicit = ""): string {
  return explicit.trim() || `${loopId}:${task.trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || computeGoalTextHash(task)}`;
}

export function getPreviousRound(
  loopId: string,
  round: number,
  context: Record<string, unknown> | null,
): PreviousRound | null {
  const entry = [...loopEntries(loopId, context)].reverse()
    .find((candidate) => entryRound(candidate) === round);
  if (!entry) return null;
  const data = lineage(entry);
  return {
    round,
    goal_id: typeof data.goal_id === "string" ? data.goal_id : "",
    goal_text_hash: typeof data.goal_text_hash === "string" ? data.goal_text_hash : "",
    success: typeof entry.success === "boolean"
      ? entry.success
      : typeof data.success === "boolean" ? data.success : false,
    task: typeof data.task === "string"
      ? data.task
      : typeof entry.task === "string" ? entry.task : "",
    constraints_active: Array.isArray(data.constraints_active)
      ? data.constraints_active.filter((value): value is string => typeof value === "string")
      : [],
    output_summary: typeof entry.output_summary === "string"
      ? entry.output_summary
      : typeof data.output_summary === "string" ? data.output_summary : "",
  };
}

function latestObjective(
  loopId: string,
  context: Record<string, unknown> | null,
): LoopObjective | null {
  const candidates = loopEntries(loopId, context).reverse();
  for (const entry of candidates) {
    const raw = entry.loop_objective;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Entry;
    return makeLoopObjective({
      objective: typeof value.objective === "string" ? value.objective : "",
      success_criteria: Array.isArray(value.success_criteria)
        ? value.success_criteria.filter((item): item is string => typeof item === "string")
        : [],
      hard_constraints: Array.isArray(value.hard_constraints)
        ? value.hard_constraints.filter((item): item is string => typeof item === "string")
        : [],
      created_at_round: typeof value.created_at_round === "number" ? value.created_at_round : 1,
      loop_id: loopId,
      version: typeof value.version === "number" ? value.version : 1,
      refinement_history: Array.isArray(value.refinement_history)
        ? value.refinement_history.filter((item): item is string => typeof item === "string")
        : [],
    });
  }
  return null;
}

function evolveObjective(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): LoopObjective {
  const current = request.loop_objective ?? latestObjective(request.loop_id, context) ??
    makeLoopObjective({
      objective: request.task,
      success_criteria: ["Task goal achieved with verifiable evidence"],
      hard_constraints: unique(request.constraints_from_plan),
      created_at_round: 1,
      loop_id: request.loop_id,
    });
  const last = request.last_round_result;
  const history = [...(current.refinement_history ?? [])];
  let objective = current.objective || request.task;
  let version = current.version ?? 1;
  if (last?.objective_refinement?.trim()) {
    const refinement = last.objective_refinement.trim();
    history.push(refinement);
    objective = `${objective}\nRefinement: ${refinement}`;
    version++;
  }
  const revisions = new Map(
    (last?.revised_success_criteria ?? []).map((item) => [item.old, item.new]),
  );
  return makeLoopObjective({
    ...current,
    objective,
    version,
    refinement_history: history.slice(-getPolicy().evolution.max_objective_versions),
    success_criteria: unique(current.success_criteria.map((item) => revisions.get(item) ?? item)),
    hard_constraints: unique(current.hard_constraints),
    loop_id: request.loop_id,
  });
}

function evolveConstraints(
  request: LoopCompileRequest,
  objective: LoopObjective,
  previous: PreviousRound | null,
): { active: string[]; retired: string[] } {
  const retired = unique(request.last_round_result?.retracted_constraints ?? []);
  const retiredSet = new Set(retired);
  const discovered = unique(request.last_round_result?.discovered_constraints ?? [])
    .slice(0, getPolicy().evolution.max_discovered_constraints_per_round);
  const active = unique([
    ...(previous?.constraints_active ?? []),
    ...request.constraints_from_plan,
    ...objective.hard_constraints,
    ...objective.success_criteria,
    ...discovered,
  ]).filter((item) => !retiredSet.has(item))
    .slice(0, getPolicy().evolution.max_active_constraints);
  return { active, retired };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hierarchical Summary (v2.1)
// ═══════════════════════════════════════════════════════════════════════════

/** Extract execution_evidence from a vault entry, handling both direct-field
 *  and lineage-nested shapes. Returns null when absent. */
function entryExecutionEvidence(entry: Entry): Record<string, unknown> | null {
  const direct = entry.execution_evidence;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const lin = lineage(entry);
  const nested = lin.execution_evidence;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return null;
}

/** Read success_criteria_met from an entry's execution_evidence. */
function entryCriteriaMet(entry: Entry): string[] {
  const ev = entryExecutionEvidence(entry);
  if (!ev) return [];
  const arr = ev.success_criteria_met;
  return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
}

/** v2.11: Match two criterion references for deduplication.
 *  If either is a criterion ID (cr-XXXXXXXX), uses exact ID comparison.
 *  Otherwise falls back to Jaccard similarity. */
function criteriaMatch(a: string, b: string): boolean {
  const aIsId = isCriterionId(a);
  const bIsId = isCriterionId(b);
  // Both are IDs — exact string comparison
  if (aIsId && bIsId) return a === b;
  // One is an ID — derive ID from the other and compare
  if (aIsId) return a === deriveCriterionId(b);
  if (bIsId) return deriveCriterionId(a) === b;
  // Neither is an ID — Jaccard fallback
  return jaccardSimilarity(a, b) >= getPolicy().evolution.criteria_dedup_threshold;
}

/** Detect newly met criteria by comparing the current entry's
 *  success_criteria_met against the previous entry's.
 *  v2.11: ID-first matching (cr-XXXXXXXX) with Jaccard similarity
 *  fallback for backward compatibility.
 *  Returns empty array when there is no previous entry — the first
 *  entry's criteria are the baseline, not a "new" event. */
function detectNewCriteria(current: Entry, previous: Entry | null): string[] {
  const currMet = entryCriteriaMet(current);
  if (currMet.length === 0) return [];
  if (!previous) {
    // First round with criteria is the baseline — not a milestone trigger.
    return [];
  }
  const prevMet = entryCriteriaMet(previous);
  if (prevMet.length === 0) return currMet;
  return currMet.filter((curr) =>
    prevMet.every((prev) => !criteriaMatch(curr, prev)),
  );
}

/** Read constraints_active from an entry's lineage. */
function entryActiveConstraints(entry: Entry): string[] {
  const lin = lineage(entry);
  const arr = lin.constraints_active;
  return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
}

/** Read retracted_constraints from an entry. */
function entryRetractedConstraints(entry: Entry): string[] {
  const direct = entry.retracted_constraints;
  if (Array.isArray(direct)) return direct.filter((v): v is string => typeof v === "string");
  const lin = lineage(entry);
  const nested = lin.retracted_constraints;
  if (Array.isArray(nested)) return nested.filter((v): v is string => typeof v === "string");
  return [];
}

/** Read progress_estimate from an entry's execution_evidence. */
function entryProgressEstimate(entry: Entry): number {
  const ev = entryExecutionEvidence(entry);
  if (!ev) return 0;
  const pe = ev.progress_estimate;
  return typeof pe === "number" ? pe : 0;
}

/** Build a single MilestoneSummary from a range of completed round entries. */
function buildMilestoneFromEntries(
  phaseEntries: Entry[],
  startRound: number,
  endRound: number,
  label: string,
  kind: MilestoneSummary["kind"],
): MilestoneSummary {
  const last = phaseEntries.at(-1);
  const outcomeRaw = last
    ? (typeof last.output_summary === "string" ? last.output_summary : "")
    : "";
  const outcomeMax = getPolicy().checkpoint.outcome_max_chars;
  const outcome = outcomeRaw.length > outcomeMax
    ? outcomeRaw.slice(0, outcomeMax) + "…"
    : outcomeRaw;

  const carried = last ? entryActiveConstraints(last) : [];
  const resolved = unique(
    phaseEntries.flatMap((e) => entryRetractedConstraints(e)),
  );
  const progress = last ? entryProgressEstimate(last) : 0;

  return makeMilestoneSummary({
    label,
    round_range: { start: startRound, end: endRound },
    outcome,
    carried_constraints: carried,
    resolved_constraints: resolved,
    progress_at_boundary: progress,
    kind,
    generated_at_round: endRound,
  });
}

export function buildRollingSummary(
  loopId: string,
  currentRound: number,
  context: Record<string, unknown> | null,
  sinceRound = 0,
): RollingSummary | null {
  const policy = getPolicy().summary;
  const allEntries = loopEntries(loopId, context);

  // ── Phase 1: Recent Window (preserves existing behavior) ──
  const windowEntries = allEntries
    .filter((entry) => {
      const round = entryRound(entry);
      return round >= sinceRound && round < currentRound;
    })
    .slice(-policy.window);
  const outcomes: string[] = [];
  const issues: string[] = [];
  for (const entry of windowEntries) {
    const data = lineage(entry);
    const round = entryRound(entry);
    const success = entry.success ?? data.success;
    const summary = typeof entry.output_summary === "string"
      ? entry.output_summary
      : typeof data.output_summary === "string" ? data.output_summary : "";
    if (summary) outcomes.push(`[R${round}] ${success === false ? "failed" : "accepted"}: ${summary}`);
    const violations = Array.isArray(entry.constraint_violations)
      ? entry.constraint_violations
      : Array.isArray(data.constraint_violations) ? data.constraint_violations : [];
    issues.push(...violations.filter((item): item is string => typeof item === "string"));
  }

  // ── Phase 2: Milestone Accumulation ──
  // Scan all completed entries in round order. For each entry, check three
  // trigger signals in priority order: agent_declared > criteria_milestone > auto.
  const completedEntries = allEntries.filter(
    (entry) => entryRound(entry) >= 1 && entryRound(entry) < currentRound,
  );

  const milestones: MilestoneSummary[] = [];
  let lastMilestoneRound = 0;

  for (let i = 0; i < completedEntries.length; i++) {
    const entry = completedEntries[i];
    const rnd = entryRound(entry);
    const lin = lineage(entry);

    // Signal 1: Agent-declared checkpoint
    const isAgentCheckpoint = lin.compression_checkpoint === true;

    // Signal 2: New criteria met (compare with previous vault entry)
    const prev = i > 0 ? completedEntries[i - 1] : null;
    const newCriteria = detectNewCriteria(entry, prev);

    if (isAgentCheckpoint || newCriteria.length > 0) {
      const startRound = lastMilestoneRound + 1;
      const phaseEntries = completedEntries.filter(
        (e) => {
          const er = entryRound(e);
          return er >= startRound && er <= rnd;
        },
      );

      const kind: MilestoneSummary["kind"] = isAgentCheckpoint
        ? "agent_declared"
        : "criteria_milestone";

      const label = isAgentCheckpoint
        ? (typeof lin.checkpoint_label === "string" && lin.checkpoint_label.trim()
            ? lin.checkpoint_label.trim()
            : `Round ${rnd}`)
        : `Completed: ${newCriteria.join(", ")}`;

      milestones.push(
        buildMilestoneFromEntries(phaseEntries, startRound, rnd, label, kind),
      );
      lastMilestoneRound = rnd;
    }
  }

  // Signal 3: Safety net — auto milestone when gap exceeds milestone_interval
  const gapSinceLast = (currentRound - 1) - lastMilestoneRound;
  if (
    lastMilestoneRound > 0 &&
    gapSinceLast >= policy.milestone_interval &&
    completedEntries.length > 0
  ) {
    const startRound = lastMilestoneRound + 1;
    const endRound = currentRound - 1;
    const phaseEntries = completedEntries.filter(
      (e) => {
        const er = entryRound(e);
        return er >= startRound && er <= endRound;
      },
    );
    if (phaseEntries.length > 0) {
      milestones.push(
        buildMilestoneFromEntries(
          phaseEntries,
          startRound,
          endRound,
          `Rounds ${startRound}–${endRound}`,
          "auto",
        ),
      );
    }
  }

  const cappedMilestones = milestones.slice(-policy.max_milestones);

  // ── Phase 3: Loop Synthesis (formulaic) ──
  let loopSynthesis = "";
  if (policy.enable_loop_synthesis && currentRound > 1) {
    const totalRounds = currentRound - 1;
    const phaseCount = cappedMilestones.length;
    const lastProgress = completedEntries.length > 0
      ? entryProgressEstimate(completedEntries[completedEntries.length - 1])
      : 0;
    const activeCount = completedEntries.length > 0
      ? entryActiveConstraints(completedEntries[completedEntries.length - 1]).length
      : 0;
    const totalResolved = cappedMilestones.reduce(
      (sum, m) => sum + m.resolved_constraints.length,
      0,
    );
    loopSynthesis =
      `Loop spans ${totalRounds} rounds across ${phaseCount} phases. ` +
      `Overall progress: ${(lastProgress * 100).toFixed(0)}%. ` +
      `${activeCount} active constraints, ${totalResolved} resolved across all phases.`;
  }

  if (windowEntries.length === 0 && cappedMilestones.length === 0) return null;

  return makeRollingSummary({
    key_outcomes: unique(outcomes),
    recurring_issues: unique(issues),
    rounds_sampled: windowEntries.length,
    generated_at_round: currentRound,
    failed_patterns: [],
    milestones: cappedMilestones,
    loop_synthesis: loopSynthesis || undefined,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-Goal Structured Tracking (v2.2)
// ═══════════════════════════════════════════════════════════════════════════

/** Derive a stable sub-goal ID from its description hash. */
function deriveSubGoalId(description: string): string {
  return "sg-" + computeGoalTextHash(description).slice(0, 8);
}

/** v2.11: Derive a stable constraint ID from its text hash (c-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
function deriveConstraintId(text: string): string {
  return "c-" + computeGoalTextHash(text).slice(0, 8);
}

/** v2.11: Derive a stable criterion ID from its text hash (cr-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
function deriveCriterionId(text: string): string {
  return "cr-" + computeGoalTextHash(text).slice(0, 8);
}

/** v2.11: Check whether a user-provided reference looks like a constraint ID.
 *  Matches the pattern c-XXXXXXXX where X is a hex digit. */
function isConstraintId(ref: string): boolean {
  return /^c-[a-f0-9]{8}$/.test(ref);
}

/** v2.11: Check whether a user-provided reference looks like a criterion ID.
 *  Matches the pattern cr-XXXXXXXX where X is a hex digit. */
function isCriterionId(ref: string): boolean {
  return /^cr-[a-f0-9]{8}$/.test(ref);
}

/** Read emerged_subtasks from a vault entry (handles direct + lineage nesting). */
function entryEmergedSubtasks(entry: Entry): string[] {
  const direct = entry.emerged_subtasks;
  if (Array.isArray(direct)) return direct.filter((v): v is string => typeof v === "string");
  const lin = lineage(entry);
  const nested = lin.emerged_subtasks;
  if (Array.isArray(nested)) return nested.filter((v): v is string => typeof v === "string");
  return [];
}

/** Read completed_subtasks from an entry. */
function entryCompletedSubtasks(entry: Entry): string[] {
  const direct = entry.completed_subtasks;
  if (Array.isArray(direct)) return direct.filter((v): v is string => typeof v === "string");
  return [];
}

/** Read blocked_subtasks from an entry. */
function entryBlockedSubtasks(entry: Entry): string[] {
  const direct = entry.blocked_subtasks;
  if (Array.isArray(direct)) return direct.filter((v): v is string => typeof v === "string");
  return [];
}

/** Read canceled_subtasks from an entry. */
function entryCanceledSubtasks(entry: Entry): string[] {
  const direct = entry.canceled_subtasks;
  if (Array.isArray(direct)) return direct.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Match a user-provided sub-task reference against existing SubGoals.
 *
 * Tries exact SubGoal ID match first (e.g. "sg-a3f2b1c0"), then falls
 * back to Jaccard token similarity on descriptions. Returns the index
 * of the best-matching SubGoal, or -1 when no match reaches threshold.
 */
function matchSubGoal(
  target: string,
  subGoals: SubGoal[],
  threshold: number,
): number {
  const trimmed = target.trim();
  // Phase 1: Exact ID match
  for (let i = 0; i < subGoals.length; i++) {
    if (subGoals[i].id === trimmed) return i;
  }
  // Phase 2: Jaccard fallback on description text
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < subGoals.length; i++) {
    const score = jaccardSimilarity(trimmed, subGoals[i].description);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestScore >= threshold ? bestIdx : -1;
}

/**
 * Manage the full sub-goal lifecycle across rounds.
 *
 * Accumulates sub-goals from all prior vault entries, processes the current
 * round's declarations, derives status changes, and returns the complete
 * structured SubGoal list.
 *
 * Status derivation priority (compiler-driven):
 *   1. Agent declared done/canceled/blocked → explicit status change
 *   2. next_action match → auto in_progress
 *   3. success_criteria_met match → auto done
 */
function manageSubGoals(
  loopId: string,
  currentRound: number,
  lastRoundResult: LoopRoundResult | null,
  vaultContext: Record<string, unknown> | null,
): SubGoal[] {
  const policy = getPolicy().evolution;
  const allEntries = loopEntries(loopId, vaultContext);
  const completedEntries = allEntries.filter(
    (e) => entryRound(e) >= 1 && entryRound(e) < currentRound,
  );
  const subGoals: SubGoal[] = [];

  // Phase 1 — Accumulate historical sub-goals from vault entries
  for (const entry of completedEntries) {
    const rnd = entryRound(entry);
    const emerged = entryEmergedSubtasks(entry);
    for (const desc of emerged) {
      const id = deriveSubGoalId(desc);
      // Dedup: skip if an existing sub-goal is too similar
      if (matchSubGoal(desc, subGoals, policy.subgoal_dedup_threshold) >= 0) continue;
      subGoals.push(makeSubGoal({
        id,
        description: desc.trim(),
        status: "pending",
        declared_at_round: rnd,
        status_changed_at_round: rnd,
        priority: subGoals.length,
      }));
    }
  }

  // Phase 2 — Process current round's sub-task declarations
  if (lastRoundResult) {
    const rnd = lastRoundResult.round || (currentRound - 1);

    // New sub-goals from this round
    const emerged = lastRoundResult.emerged_subtasks ?? [];
    for (const desc of emerged) {
      if (matchSubGoal(desc, subGoals, policy.subgoal_dedup_threshold) >= 0) continue;
      subGoals.push(makeSubGoal({
        id: deriveSubGoalId(desc),
        description: desc.trim(),
        status: "pending",
        declared_at_round: rnd,
        status_changed_at_round: rnd,
        priority: subGoals.length,
      }));
    }

    // Completed sub-goals
    const completed = lastRoundResult.completed_subtasks ?? [];
    for (const desc of completed) {
      const idx = matchSubGoal(desc, subGoals, policy.subgoal_match_threshold);
      if (idx >= 0 && subGoals[idx].status !== "done" && subGoals[idx].status !== "canceled") {
        subGoals[idx].status = "done";
        subGoals[idx].status_changed_at_round = rnd;
        subGoals[idx].completed_at_round = rnd;
      }
    }

    // Blocked sub-goals
    const blocked = lastRoundResult.blocked_subtasks ?? [];
    for (const desc of blocked) {
      const idx = matchSubGoal(desc, subGoals, policy.subgoal_match_threshold);
      if (idx >= 0 && subGoals[idx].status !== "done" && subGoals[idx].status !== "canceled") {
        subGoals[idx].status = "blocked";
        subGoals[idx].status_changed_at_round = rnd;
      }
    }

    // Canceled sub-goals
    const canceled = lastRoundResult.canceled_subtasks ?? [];
    for (const desc of canceled) {
      const idx = matchSubGoal(desc, subGoals, policy.subgoal_match_threshold);
      if (idx >= 0 && subGoals[idx].status !== "done" && subGoals[idx].status !== "canceled") {
        subGoals[idx].status = "canceled";
        subGoals[idx].status_changed_at_round = rnd;
      }
    }

    // Phase 3 — Auto-derive: next_action match → in_progress
    const nextAction = lastRoundResult.next_action?.trim();
    if (nextAction) {
      for (const sg of subGoals) {
        if (sg.status === "pending") {
          if (jaccardSimilarity(nextAction, sg.description) >= policy.subgoal_auto_in_progress_threshold) {
            sg.status = "in_progress";
            sg.status_changed_at_round = rnd;
            break; // Only one sub-goal can be in_progress at a time
          }
        }
      }
    }

    // Phase 4 — Auto-complete: new criteria match → done
    const newCriteria = lastRoundResult.execution_evidence?.success_criteria_met ?? [];
    if (newCriteria.length > 0) {
      for (const sg of subGoals) {
        if (sg.status === "pending" || sg.status === "in_progress") {
          for (const crit of newCriteria) {
            if (jaccardSimilarity(crit, sg.description) >= policy.subgoal_auto_complete_threshold) {
              sg.status = "done";
              sg.status_changed_at_round = rnd;
              sg.completed_at_round = rnd;
              break;
            }
          }
        }
      }
    }
  }

  // Sort for display: in_progress first, then pending by age desc, then blocked, then done, then canceled
  subGoals.sort((a, b) => {
    const rank = (s: SubGoal) => {
      switch (s.status) {
        case "in_progress": return 0;
        case "pending": return 1;
        case "blocked": return 2;
        case "done": return 3;
        case "canceled": return 4;
      }
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Within same status: pending by oldest first, done by most recent first
    if (a.status === "pending") return (currentRound - a.declared_at_round) - (currentRound - b.declared_at_round);
    if (a.status === "done") return (b.completed_at_round ?? 0) - (a.completed_at_round ?? 0);
    return a.declared_at_round - b.declared_at_round;
  });

  return subGoals;
}

// ═══════════════════════════════════════════════════════════════════════════
// Time-Aware Constraint Management (v2.3)
// ═══════════════════════════════════════════════════════════════════════════

/** Determine the source of a constraint by matching against known sources. */
function constraintSource(
  text: string,
  objective: LoopObjective,
  constraintsFromPlan: string[],
): "hard" | "plan" | "criteria" | "discovered" {
  const norm = text.toLowerCase().trim();
  if (objective.hard_constraints.some((c) => c.toLowerCase().trim() === norm)) return "hard";
  if (constraintsFromPlan.some((c) => c.toLowerCase().trim() === norm)) return "plan";
  if (objective.success_criteria.some((c) => c.toLowerCase().trim() === norm)) return "criteria";
  return "discovered";
}

/** Find the earliest round a constraint was discovered by scanning vault entries.
 *  v2.11: ID-first matching. Checks exact constraint ID match (c-XXXXXXXX)
 *  against the derived ID of each vault entry's discovered_constraints, then
 *  falls back to Jaccard similarity on text. */
function findDiscoveredRound(
  text: string,
  vaultEntries: Entry[],
): number {
  const targetId = deriveConstraintId(text);
  let earliest = 0;
  for (const entry of vaultEntries) {
    const rnd = entryRound(entry);
    if (rnd < 1) continue;
    const discovered = Array.isArray(entry.discovered_constraints)
      ? entry.discovered_constraints.filter((v: unknown) => typeof v === "string")
      : [];
    for (const d of discovered) {
      // Phase 1: exact ID match (v2.11)
      if (d === targetId || deriveConstraintId(d) === targetId) {
        if (earliest === 0 || rnd < earliest) earliest = rnd;
        break;
      }
      // Phase 2: Jaccard fallback (backward compatibility)
      if (jaccardSimilarity(text, d) >= getPolicy().evolution.constraint_match_threshold) {
        if (earliest === 0 || rnd < earliest) earliest = rnd;
        break;
      }
    }
  }
  return earliest;
}

/** Find the latest round a constraint was violated by scanning vault entries.
 *  v2.11: ID-first matching. Checks exact constraint ID match (c-XXXXXXXX)
 *  against the derived ID of each vault entry's constraint_violations, then
 *  falls back to Jaccard similarity on text. Returns 0 if never violated. */
function findLastViolatedRound(
  text: string,
  vaultEntries: Entry[],
): number {
  const targetId = deriveConstraintId(text);
  let latest = 0;
  for (const entry of vaultEntries) {
    const rnd = entryRound(entry);
    if (rnd < 1) continue;
    const violations = Array.isArray(entry.constraint_violations)
      ? entry.constraint_violations.filter((v: unknown) => typeof v === "string")
      : [];
    for (const v of violations) {
      // Phase 1: exact ID match (v2.11)
      if (v === targetId || deriveConstraintId(v) === targetId) {
        if (rnd > latest) latest = rnd;
        break;
      }
      // Phase 2: Jaccard fallback (backward compatibility)
      if (jaccardSimilarity(text, v) >= getPolicy().evolution.constraint_match_threshold) {
        if (rnd > latest) latest = rnd;
        break;
      }
    }
  }
  return latest;
}

/**
 * Manage constraint lifecycle with time-aware decay.
 *
 * Discovered constraints that haven't been violated for N rounds are demoted
 * to inactive — removed from prompts but kept in state. Hard/plan/criteria
 * constraints never auto-decay. Inactive constraints are auto-reactivated
 * if violated again in the current round.
 */
function manageConstraintLifecycle(
  active: string[],
  objective: LoopObjective,
  constraintsFromPlan: string[],
  vaultContext: Record<string, unknown> | null,
  currentRound: number,
): { active: string[]; inactive: string[]; metadata: ConstraintMeta[] } {
  const policy = getPolicy().evolution;
  const allEntries = loopEntries(
    objective.loop_id || "",
    vaultContext,
  );
  const completedEntries = allEntries.filter(
    (e) => entryRound(e) >= 1 && entryRound(e) < currentRound,
  );

  const metadata: ConstraintMeta[] = [];

  for (const text of active) {
    const source = constraintSource(text, objective, constraintsFromPlan);

    // Structural constraints never decay
    if (source === "hard" || source === "plan" || source === "criteria") {
      metadata.push(makeConstraintMeta({
        id: deriveConstraintId(text),
        text,
        discovered_at_round: objective.created_at_round || 1,
        last_violated_at_round: findLastViolatedRound(text, completedEntries),
        source,
        status: "active",
      }));
      continue;
    }

    // Discovered constraints: check for inactivity
    const discoveredAt = findDiscoveredRound(text, completedEntries);
    const lastViolated = findLastViolatedRound(text, completedEntries);
    const roundsSinceRelevant = lastViolated > 0
      ? currentRound - lastViolated
      : currentRound - (discoveredAt || currentRound);

    const status: "active" | "inactive" =
      roundsSinceRelevant > policy.constraint_inactive_rounds
        ? "inactive"
        : "active";

    metadata.push(makeConstraintMeta({
      id: deriveConstraintId(text),
      text,
      discovered_at_round: discoveredAt || 0,
      last_violated_at_round: lastViolated,
      source: "discovered",
      status,
    }));
  }

  const newActive = metadata
    .filter((m) => m.status === "active")
    .map((m) => m.text);

  const inactive = metadata
    .filter((m) => m.status === "inactive")
    .map((m) => m.text);

  return { active: newActive, inactive, metadata };
}

export function alignTask(
  proposedTask: string,
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): TaskAlignment {
  const objective = request.loop_objective ?? latestObjective(request.loop_id, context);
  if (!objective) return makeTaskAlignment();
  const score = jaccardSimilarity(
    proposedTask,
    [objective.objective, ...objective.success_criteria, ...objective.hard_constraints].join(" "),
  );
  return makeTaskAlignment({
    is_aligned: score >= 0.3,
    alignment_score: Number(score.toFixed(2)),
    warning: score < 0.3 ? "Current task may be drifting from the loop objective." : "",
    escalation: score < 0.3 ? "warn" : "none",
  });
}

export function checkLoopHealth(
  loopId: string,
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): LoopHealth {
  const previous = getPreviousRound(loopId, request.round - 1, context);
  const alignment = alignTask(request.task, request, context);
  const violations = request.last_round_result?.constraint_violations.length ?? 0;
  const integrity = Math.max(0, 1 - violations * 0.2);
  const continuity = previous ? jaccardSimilarity(previous.task, request.task) : 1;
  const drift = alignment.alignment_score < 0.3 || continuity < 0.2;
  return makeLoopHealth({
    goal_alignment: alignment.alignment_score,
    constraint_integrity: integrity,
    drift_detected: drift,
    strategy_stability: true,
    task_continuity: Number(continuity.toFixed(2)),
    escalation_recommended: drift || integrity < 0.6 ? "l2" : "none",
  });
}

function levelDecision(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): PromptLevelDecision {
  const previous = getPreviousRound(request.loop_id, request.round - 1, context);
  const last = request.last_round_result;
  const hasNewInformation = Boolean(
    request.new_since_last_round.trim() ||
    last?.discovered_constraints?.length ||
    last?.objective_refinement?.trim() ||
    last?.emerged_subtasks?.length ||
    last?.retracted_constraints?.length ||
    last?.revised_success_criteria?.length ||
    last?.wrong_assumptions?.length,
  );
  const lastFullRound = loopEntries(request.loop_id, context)
    .filter((entry) => lineage(entry).recompile_level === "l2")
    .map(entryRound)
    .filter((round) => round < request.round)
    .at(-1) ?? 1;
  return decidePromptLevel({
    round: request.round,
    attempt: request.attempt,
    forceLevel: request.force_level,
    hasPlanSource: Boolean(request.plan_source),
    checkpointBoundary: last?.compression_checkpoint === true,
    goalChanged: previous !== null && previous.goal_id !== deriveGoalId(
      request.loop_id,
      request.task,
      request.goal_id,
    ),
    previousStateMissing: request.round > 1 && previous === null,
    previousFailedWithoutNewInformation: last?.success === false && !hasNewInformation,
    verificationContradicted: (request.verification_flags ?? [])
      .some((flag) => flag.severity === "error"),
    consecutiveRejections: request.consecutive_rejections,
    fullRefreshInterval: getPolicy().prompt.full_refresh_interval,
    lastFullRound,
  });
}

export function decideLevel(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): "l0" | "l1" | "l2" {
  return levelDecision(request, context).level;
}

export function buildSelfEvalBlock(
  round: number,
  prevDriftFlags?: VerificationFlag[],
): string {
  const hasIntentDrift = prevDriftFlags?.some(f => f.check === "intent_drift") ?? false;
  const hasSubGoalDrift = prevDriftFlags?.some(f => f.check === "subgoal_drift") ?? false;
  const needsClarification = hasIntentDrift || hasSubGoalDrift;

  const evalObj: Record<string, unknown> = {
    success: false,
    output_summary: `<verified result of round ${round}>`,
    constraint_violations: ["<c-XXXXXXXX or text>"],
    should_continue: true,
    discovered_constraints: ["<new constraint>"],
    emerged_subtasks: [],
    execution_evidence: {
      files_changed: [],
      test_results: { passed: 0, failed: 0, skipped: 0 },
      success_criteria_met: ["<cr-XXXXXXXX or text>"],
      success_criteria_remaining: ["<cr-XXXXXXXX or text>"],
      progress_estimate: 0,
    },
    wrong_assumptions: [],
    next_action: "<next concrete action, or empty when complete>",
    completed_subtasks: ["<sg-XXXXXXXX or text>"],
    blocked_subtasks: ["<sg-XXXXXXXX or text>"],
    canceled_subtasks: ["<sg-XXXXXXXX or text>"],
  };

  // v2.8: Inject drift clarification field when previous round had drift flags
  if (needsClarification) {
    const flagTypes = [
      hasIntentDrift ? "intent_drift" : "",
      hasSubGoalDrift ? "subgoal_drift" : "",
    ].filter(Boolean).join(" / ");
    evalObj.drift_clarification =
      `<explain why your Round ${round} actions diverged from your stated plan ` +
      `(${flagTypes} detected in previous round). ` +
      `Leave empty if no divergence occurred>`;
  }

  const lines = [
    "### LoopForge Evaluation (Required)",
    "",
    `After completing Round ${round}, replace the placeholder values below`,
    "with your actual results and submit via `loopforge_next`.",
  ];

  if (needsClarification) {
    lines.push(
      "",
      "> ⚠️ **Drift Detected:** The verification gate detected that your previous",
      "> round's declared intent (next_action) did not match your actual output.",
      "> Please explain the pivot in the `drift_clarification` field below.",
      "> An honest explanation helps the enforcement gate distinguish intentional",
      "> course corrections from unacknowledged drift.",
    );
  }

  lines.push("---loopforge-eval");
  lines.push(JSON.stringify(evalObj, null, 2));
  lines.push("---end-loopforge-eval");
  lines.push("");
  lines.push("IMPORTANT: Replace every <placeholder> with your actual data.");
  lines.push("Set success=true only when the full goal and ALL hard constraints are verified.");
  lines.push("Use IDs for exact matching: c-XXXXXXXX, cr-XXXXXXXX, sg-XXXXXXXX.");
  lines.push("For subtasks, use sub-goal IDs from the Sub-Goal Dashboard above.");

  return lines.join("\n");
}

// v2.5: checkpoint() removed — agent_declared milestones from
// compression_checkpoint supersede the separate CheckpointSummary.
// See buildRollingSummary() signal 1.

export function compileLoop(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): LoopCompileResponse {
  const decision = levelDecision(request, context);
  const previous = getPreviousRound(request.loop_id, request.round - 1, context);
  const objective = evolveObjective(request, context);
  const constraints = evolveConstraints(request, objective, previous);
  const constraintLifecycle = manageConstraintLifecycle(
    constraints.active,
    objective,
    request.constraints_from_plan,
    context,
    request.round,
  );
  const rolling = buildRollingSummary(request.loop_id, request.round, context);
  const subGoals = manageSubGoals(
    request.loop_id,
    request.round,
    request.last_round_result,
    context,
  );
  const alignment = alignTask(request.task, request, context);
  const health = checkLoopHealth(request.loop_id, { ...request, loop_objective: objective }, context);
  const warnings = unique([
    alignment.warning,
    health.escalation_recommended !== "none"
      ? `Loop health recommends ${health.escalation_recommended}.`
      : "",
  ]);

  // ── v2.5: Agent trust score ──────────────────────────────────────────
  const flags = request.verification_flags ?? [];
  const errors = flags.filter((f) => f.severity === "error").length;
  const warns = flags.filter((f) => f.severity === "warn").length;
  const trustScore = Math.max(0, Math.min(1, 1.0 - (errors * 0.15) - (warns * 0.03)));

  // Trend — derive from vault entries (violation counts per round as proxy).
  // No new persistence; reconstructed same as milestones/sub-goals.
  const completedEntries = loopEntries(request.loop_id, context)
    .filter((e) => entryRound(e) >= 1 && entryRound(e) < request.round);
  const trend: number[] = [];
  for (const entry of completedEntries.slice(-10)) {
    const viols = Array.isArray(entry.constraint_violations)
      ? entry.constraint_violations.filter((v: unknown) => typeof v === "string")
      : [];
    // Simple proxy: no violations = perfect trust, each violation = -0.1
    const score = Math.max(0, 1.0 - viols.length * 0.1);
    trend.push(Number(score.toFixed(2)));
  }

  const response = makeLoopCompileResponse({
    status: AgentStatus.OK,
    recompile_level: decision.level,
    diff_from_previous: decision.reasons.join(","),
    lineage: [`${request.loop_id}:r${request.round}`],
    constraints_active: constraintLifecycle.active,
    constraints_retired: constraints.retired,
    constraints_inactive: constraintLifecycle.inactive,
    constraint_metadata: constraintLifecycle.metadata,
    loop_id: request.loop_id,
    round: request.round,
    goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
    goal_text_hash: computeGoalTextHash(request.task),
    loop_objective: objective,
    loop_health: health,
    task_alignment: alignment,
    rolling_summary: rolling,
    sub_goals: subGoals,
    agent_trust_score: request.round > 1 ? Number(trustScore.toFixed(2)) : undefined,
    agent_trust_trend: request.round > 1 ? trend : [],
    suggested_next_task: request.last_round_result?.next_action?.trim() ||
      request.last_round_result?.emerged_subtasks?.[0] || "",
    plan_source: request.plan_source,
    warnings,
  });
  const policy = getPolicy();
  const statePath = `${policy.state_file.directory}/${request.loop_id}-state.md`;
  const state = createCanonicalLoopState(request, response, statePath);
  const markdown = renderCanonicalStateMarkdown(state);

  // v2.4–v2.5: Adaptive L2 budget — scales with loop complexity
  const adaptiveL2 = policy.prompt.l2_adaptive_enabled
    ? Math.min(
        policy.prompt.l2_max_chars
          + (request.round * policy.prompt.l2_adaptive_round_factor)
          + ((rolling?.milestones?.length ?? 0) * policy.prompt.l2_adaptive_milestone_factor)
          + (subGoals.length * policy.prompt.l2_adaptive_subgoal_factor),
        policy.prompt.l2_adaptive_max_chars,
      )
    : policy.prompt.l2_max_chars;

  // v2.8: L2 pointer mode — when enabled, skip the monolithic markdown blob.
  // Structured L2 sections (milestones, sub-goals, trust, progress) still
  // render. The state file on disk is the durable source of truth.
  const l2Pointer = policy.prompt.l2_pointer_enabled && decision.level === "l2";

  const artifact = assemblePromptArtifact({
    state,
    level: decision.level,
    reasons: decision.reasons,
    mode: policy.prompt.injection_mode,
    budgets: {
      l0: policy.prompt.l0_max_chars,
      l1: policy.prompt.l1_max_chars,
      l2: adaptiveL2,
    },
    attempt: request.attempt,
    selfEvaluationBlock: buildSelfEvalBlock(request.round, request.verification_flags),
    fullStateMarkdown: l2Pointer ? undefined : markdown,
    // v2.9: Model's information needs from the previous round's SelfEvaluation
    promptRequests: request.last_round_result?.prompt_requests,
  });
  response.prompt = artifact.renderedPrompt;
  response.prompt_artifact = artifact;
  response.state_file_content = policy.state_file.enabled ? markdown : undefined;
  return response;
}
