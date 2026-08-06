/** Enforcement Gate — Layer 2 round-boundary runtime enforcement (v1.13).
 *
 * Pure-function module. Receives the verification gate's findings plus
 * round-level context and decides whether to accept the round, reject it
 * (force the agent to redo), or terminate the loop.
 *
 * This is the "runtime" that prompt-only constraint systems lack.
 * Verification gate detects WHAT is wrong; enforcement gate decides
 * what to DO about it.
 *
 * Decision semantics:
 * - accept:    round passes all checks; advance to next round as normal.
 * - reject:    agent's self-evaluation or round output is invalid; the
 *              agent receives a rejection prompt and must redo the SAME
 *              round. Round counter does NOT increment.
 * - terminate: loop has reached an unrecoverable state; stop immediately
 *              with stopReason "enforcement_terminated".
 */

import type { VaultEntry } from "./backends/interface.js";
import type {
  EnforcementResult,
  SelfEvaluation,
  VerificationFlag,
  VerificationResult,
} from "./protocol.js";
import { makeEnforcementResult } from "./protocol.js";
import { entryRound } from "./verification-gate.js";
import { getPolicy } from "./policy.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract progress_estimate from a vault entry's execution_evidence.
 *  Returns null if no execution evidence is available. */
function entryProgress(entry: VaultEntry): number | null {
  const evidence = entry.execution_evidence as Record<string, unknown> | undefined;
  if (!evidence) return null;
  const pe = evidence.progress_estimate;
  return typeof pe === "number" ? pe : null;
}

/** Collect progress estimates from vault entries into a round→estimate map.
 *  Shared by R4 (progress_stall) and R5 (progress_stall_terminal). */
function collectProgressByRound(
  vaultEntries: VaultEntry[],
  currentRound: number,
): Map<number, number> {
  const progressByRound = new Map<number, number>();
  for (const entry of vaultEntries) {
    const rnd = entryRound(entry);
    if (rnd < 1 || rnd >= currentRound) continue;
    const pe = entryProgress(entry);
    if (pe !== null) progressByRound.set(rnd, pe);
  }
  return progressByRound;
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Backtrack helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Check whether a vault entry represents a "clean" round that can serve
 *  as a safe restore point. A clean round was accepted (not rejected)
 *  and had no error-level verification flags. */
function isCleanRound(entry: VaultEntry): boolean {
  const lineage = entry.loop_lineage as Record<string, unknown> | undefined;
  // Rejected rounds are not clean
  const success = typeof entry.success === "boolean"
    ? entry.success
    : typeof lineage?.success === "boolean" ? lineage.success : undefined;
  if (success === false) return false;
  // Rounds with error-level verification flags are not clean
  const flags = entry.verification_flags as unknown;
  if (Array.isArray(flags)) {
    for (const f of flags) {
      if (
        f !== null && typeof f === "object" &&
        (f as Record<string, unknown>).severity === "error"
      ) return false;
    }
  }
  return true;
}

/** Scan backwards from currentRound to find the most recent clean round.
 *  Collects discovered_constraints from skipped rounds along the way.
 *  Returns null when no clean round is found within maxDepth. */
export function findSafeRestorePoint(
  currentRound: number,
  vaultEntries: VaultEntry[],
  maxDepth: number,
): { round: number; skippedDiscoveries: string[] } | null {
  const completed = vaultEntries
    .filter((e) => {
      const rnd = entryRound(e);
      return rnd >= 1 && rnd < currentRound;
    })
    .sort((a, b) => entryRound(b) - entryRound(a)); // newest first

  const skippedDiscoveries: string[] = [];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const targetRound = currentRound - depth;
    if (targetRound < 1) break;
    const entry = completed.find((e) => entryRound(e) === targetRound);
    if (!entry) continue;

    // Collect discoveries from rounds we're about to skip (depth > 1)
    if (depth > 1) {
      for (let d = 1; d < depth; d++) {
        const skippedRound = currentRound - d;
        const skippedEntry = completed.find((e) => entryRound(e) === skippedRound);
        if (skippedEntry) {
          const discovered = Array.isArray(skippedEntry.discovered_constraints)
            ? skippedEntry.discovered_constraints.filter((v: unknown) => typeof v === "string")
            : [];
          for (const item of discovered) {
            if (!skippedDiscoveries.includes(item)) skippedDiscoveries.push(item);
          }
        }
      }
    }

    if (isCleanRound(entry)) {
      return { round: targetRound, skippedDiscoveries };
    }
  }

  return null;
}

/** Build the backtrack prompt injected at the top of the restored round.
 *
 *  v2.13: Includes concrete workspace restore instructions with affected
 *  file lists from skipped rounds. The agent must restore the working tree
 *  to the clean round's state before proceeding. */
export function buildBacktrackPrompt(
  fromRound: number,
  toRound: number,
  triggerRule: string,
  skippedDiscoveries: string[],
  /** v2.13: Files changed in the skipped rounds (from evidence snapshots).
   *  Used to show the agent exactly what needs to be reverted. */
  skippedFiles: string[] = [],
  /** v2.13: Git HEAD commit hash at the backtrack point (current HEAD).
   *  The agent must discard work back to the clean round's state. */
  _gitHead?: string,
): string {
  const lines: string[] = [
    `## ⛔ Backtrack — Round ${fromRound} → Restored to Round ${toRound}`,
    "",
  ];

  // ── Why This Happened ────────────────────────────────────────────────
  if (triggerRule === "progress_stall") {
    lines.push(
      "### Why This Happened",
      "",
      `Progress stalled over rounds ${toRound + 1}–${fromRound}. ` +
      `The work done in those rounds produced no verifiable progress — ` +
      `no new files changed, no criteria met.`,
      "",
      "The approach used in those rounds **did not work**. It should not be repeated.",
      "",
    );
  } else if (triggerRule === "progress_stall_terminal") {
    lines.push(
      "### Why This Happened",
      "",
      `Progress was completely flat for multiple rounds leading up to Round ${fromRound}. ` +
      `The agent made **zero forward motion** — the task is not advancing.`,
      "",
      "A **radically different** strategy is needed. The previous approach produced nothing.",
      "",
    );
  }

  // ── v2.13: Workspace Restore ──────────────────────────────────────────
  lines.push(
    "### ⚠️ Workspace Restore Required",
    "",
    `Your working directory still contains changes from the **failed** ` +
    `rounds (${toRound + 1}–${fromRound}). You MUST discard those changes ` +
    `before starting Round ${toRound + 1}. Working on top of stale changes ` +
    `will cause the verification gate to reject your next submission.`,
    "",
  );

  if (skippedFiles.length > 0) {
    lines.push(
      "**Files modified in skipped rounds (must be reverted):**",
      "",
    );
    for (const f of skippedFiles.slice(0, 15)) {
      lines.push(`- \`${f}\``);
    }
    if (skippedFiles.length > 15) {
      lines.push(`- … and ${skippedFiles.length - 15} more files`);
    }
    lines.push("");
  }

  lines.push(
    "**To restore a clean workspace, run:**",
    "",
    "```bash",
    "# Option A: Discard all uncommitted changes (recommended)",
    "git checkout -- .",
    "git clean -fd",
    "",
    "# Option B: If you have unrelated work to keep",
    `git stash push -m "backtrack-safety-net-round-${fromRound}"`,
    "git checkout -- .",
    "git clean -fd",
    "```",
    "",
    `**If git is unavailable**, manually revert the files listed above ` +
    `to their state at Round ${toRound}. Re-read the state file below — ` +
    `it reflects the correct state at Round ${toRound}.`,
    "",
    "> 🛡️ **Verification:** The next round's evidence check will verify that " +
    "> your workspace no longer contains the failed changes. Submissions " +
    "> with unrestored files will be **rejected**.",
    "",
  );

  // ── What Must Change ──────────────────────────────────────────────────
  lines.push(
    "### What Must Change",
    "",
    "- Do **NOT** repeat the approach used in the skipped rounds.",
    "- Try a **different** task decomposition or technique.",
    "- If the current sub-goal is stuck, consider canceling it " +
      "(`canceled_subtasks`) and working on a different one.",
    "- Use the `prompt_requests.confusion_points` field in your self-evaluation " +
      "to flag anything you don't understand about the task or the blockage.",
    "",
  );

  // ── Preserved Discoveries ─────────────────────────────────────────────
  if (skippedDiscoveries.length > 0) {
    lines.push(
      "### Preserved Discoveries",
      "",
      "These were discovered in the skipped rounds and remain valid:",
      "",
    );
    for (const d of skippedDiscoveries) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  // ── Instructions ──────────────────────────────────────────────────────
  lines.push(
    "### Instructions",
    "",
    `You have been rolled back to Round ${toRound}. ` +
    `You are now starting **Round ${toRound + 1}** with the lessons above.`,
    "",
    "1. **First**: restore your workspace using the commands above.",
    "2. Read the restored state below — it reflects Round " + toRound + ".",
    "3. The discoveries from skipped rounds (if any) have been merged " +
      "into the active constraints.",
    "4. Do NOT retrace the steps that led to the stall. Choose a new path.",
    "",
  );

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Individual enforcement rules — each returns EnforcementResult | null
// Rules are ordered by priority. The first non-null result wins.
// ═══════════════════════════════════════════════════════════════════════════

/** R1: Agent claims success but success_criteria_remaining has items.
 *  This is a lie — the agent must either finish the criteria or
 *  set success=false honestly. Triggered by the verification gate's
 *  "success_with_remaining_criteria" error flag. */
function enforceSuccessWithRemainingCriteria(
  flags: VerificationFlag[],
): EnforcementResult | null {
  const flag = flags.find(
    (f) => f.check === "success_with_remaining_criteria" && f.severity === "error",
  );
  if (!flag) return null;

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "You set success=true but success criteria remain unmet. " +
      "Either: (a) complete the remaining criteria and re-submit your self-evaluation, " +
      "or (b) set success=false and honestly report what remains to be done.",
    check: "success_with_remaining_criteria",
  });
}

/** R2: Same constraint violation appears in 3 consecutive rounds.
 *  The agent is repeating the same mistake. Triggered by the verification
 *  gate's "recurring_violation" error flag. */
function enforceRecurringViolation(
  flags: VerificationFlag[],
): EnforcementResult | null {
  const flag = flags.find(
    (f) => f.check === "recurring_violation" && f.severity === "error",
  );
  if (!flag) return null;

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "The same constraint violation has appeared in 3 consecutive rounds. " +
      "You must: (a) explain WHY this violation keeps occurring, " +
      "and (b) propose a DIFFERENT approach than what you used in the last 3 rounds. " +
      "Do NOT retry the same strategy — it has failed 3 times.",
    check: "recurring_violation",
  });
}

/** R3: Agent claims success but did nothing verifiable.
 *  v1.17: execution_evidence is now MANDATORY for structured self-evaluations.
 *  Missing evidence when success=true → reject (agent must provide evidence).
 *  Empty evidence (no files + no tests) when success=true → reject. */
function enforceEmptySuccess(
  selfEval: SelfEvaluation,
  _flags: VerificationFlag[],
  skipEvidenceRules = false,
): EnforcementResult | null {
  if (skipEvidenceRules) return null; // Requires execution_evidence
  if (!selfEval.success) return null;

  const ev = selfEval.execution_evidence;

  // v1.17: Missing evidence when claiming success → reject.
  // The agent MUST provide execution_evidence to back up a success claim.
  if (!ev) {
    return makeEnforcementResult({
      action: "reject",
      reason:
        "Agent claims success but provided no execution_evidence. " +
        "Every successful round MUST include execution_evidence with " +
        "files_changed, test_results, and progress_estimate.",
      fix_instructions:
        "You must provide execution_evidence in your self-evaluation: " +
        "(a) list the files you changed in execution_evidence.files_changed, " +
        "(b) run tests and report results in execution_evidence.test_results, " +
        "(c) estimate your progress in execution_evidence.progress_estimate. " +
        "If you genuinely completed the task without file changes or tests, " +
        "explain why in detail in your output_summary.",
      check: "empty_success",
    });
  }

  const filesEmpty = ev.files_changed.length === 0;
  const testsNotRun = ev.test_results === null;

  if (!filesEmpty || !testsNotRun) return null;

  return makeEnforcementResult({
    action: "reject",
    reason:
      "Agent claims success but execution_evidence shows no files changed " +
      "and no tests were run. There is no verifiable evidence of work.",
    fix_instructions:
      "You must provide verifiable evidence: " +
      "(a) list the files you changed in execution_evidence.files_changed, " +
      "and (b) run tests and report results in execution_evidence.test_results. " +
      "If you genuinely completed the task without file changes or tests, " +
      "explain why in detail in your output_summary.",
    check: "empty_success",
  });
}

/** R4: Progress has stalled for 3+ consecutive rounds.
 *  Detected by checking progress_estimate deltas across vault entries.
 *  First occurrence → REJECT (agent must change approach).
 *  Second consecutive occurrence → TERMINATE (agent cannot recover). */
function enforceProgressStall(
  _selfEval: SelfEvaluation,
  _flags: VerificationFlag[],
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number,
  skipEvidenceRules = false,
): EnforcementResult | null {
  if (skipEvidenceRules) return null; // Requires execution_evidence
  // Need at least 3 rounds of history
  if (currentRound < 3) return null;

  const progressByRound = collectProgressByRound(vaultEntries, currentRound);
  if (progressByRound.size < 3) return null;

  const sortedRounds = [...progressByRound.keys()].sort((a, b) => a - b);
  const last3 = sortedRounds.slice(-3);

  // Require all three data points to be within [currentRound-3, currentRound-1].
  const expectedMin = currentRound - 3;
  if (last3[0] < expectedMin || last3[2] > currentRound - 1) return null;

  const p1 = progressByRound.get(last3[0])!;
  const p2 = progressByRound.get(last3[1])!;
  const p3 = progressByRound.get(last3[2])!;

  const stallThreshold = getPolicy().evolution.progress_stall_threshold;
  const delta12 = p2 - p1;
  const delta23 = p3 - p2;

  // Both deltas must be below threshold AND not near completion
  const isStalling =
    delta12 < stallThreshold &&
    delta23 < stallThreshold &&
    p3 < 0.95;

  if (!isStalling) return null;

  const escalation = getPolicy().engine.enforcement_escalation_enabled;

  // v2.7: When escalation is enabled, give one extra rejection round with a
  // "Seek Human Guidance" notice before terminating. This lets the agent
  // course-correct with human input rather than being killed immediately.
  if (consecutiveRejections >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Progress stalled for 3+ rounds ` +
        `(${(p1 * 100).toFixed(0)}% → ${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}%) ` +
        `and agent did not resolve after escalation. Terminating loop.`,
      check: "progress_stall",
    });
  }

  if (consecutiveRejections >= 1 && escalation) {
    // v2.10: When backtrack is enabled, escalate to backtrack instead of
    // reject. The agent is rolled back to the last clean round with lessons
    // injected, rather than redoing the same round with an escalation notice.
    if (getPolicy().engine.backtrack_enabled) {
      return makeEnforcementResult({
        action: "backtrack",
        reason:
          `Progress has stalled: ${(p1 * 100).toFixed(0)}% → ` +
          `${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}% over the ` +
          `last 3 rounds (delta < ${(stallThreshold * 100).toFixed(0)}% each round).`,
        fix_instructions:
          "Your progress has been flat for 3 rounds. You are being rolled back " +
          "to the last clean round. Do NOT repeat the approach that led to the stall. " +
          "Choose a different technique or task decomposition.",
        check: "progress_stall",
      });
    }
    return makeEnforcementResult({
      action: "reject",
      reason:
        `Progress has stalled: ${(p1 * 100).toFixed(0)}% → ` +
        `${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}% over the ` +
        `last 3 rounds (delta < ${(stallThreshold * 100).toFixed(0)}% each round).`,
      fix_instructions:
        "Your progress has been flat for 3 rounds. You must: " +
        "(a) explain what is blocking progress, " +
        "(b) propose a DIFFERENT technique or task decomposition, and " +
        "(c) set a concrete, verifiable goal for the redo of this round. " +
        "Do NOT repeat the same approach — it has not moved progress forward." +
        buildEscalationNotice(),
      check: "progress_stall",
    });
  }

  if (consecutiveRejections >= 1) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Progress stalled for 3+ rounds ` +
        `(${(p1 * 100).toFixed(0)}% → ${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}%) ` +
        `and agent did not resolve after previous rejection. Terminating loop.`,
      check: "progress_stall",
    });
  }

  return makeEnforcementResult({
    action: "reject",
    reason:
      `Progress has stalled: ${(p1 * 100).toFixed(0)}% → ` +
      `${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}% over the ` +
      `last 3 rounds (delta < ${(stallThreshold * 100).toFixed(0)}% each round).`,
    fix_instructions:
      "Your progress has been flat for 3 rounds. You must: " +
      "(a) explain what is blocking progress, " +
      "(b) propose a DIFFERENT technique or task decomposition, and " +
      "(c) set a concrete, verifiable goal for the redo of this round. " +
      "Do NOT repeat the same approach — it has not moved progress forward.",
    check: "progress_stall",
  });
}

/** R5: Progress completely stalled (delta = 0) for N consecutive rounds.
 *  Stricter than R4 (which triggers on delta < 5%). R4 gives the agent a chance
 *  to change approach via reject; this rule fires when progress has been exactly
 *  flat — the agent is making zero forward motion.
 *
 *  v2.7: When enforcement_escalation_enabled is true, the first occurrence
 *  issues a rejection with an escalation notice instead of terminating.
 *  Termination only happens on the second consecutive flatline detection.
 *
 *  Uses the engine.max_circuit_breaker policy value as the lookback window. */
function enforceProgressStallTerminal(
  _selfEval: SelfEvaluation,
  _flags: VerificationFlag[],
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number,
  skipEvidenceRules = false,
): EnforcementResult | null {
  if (skipEvidenceRules) return null; // Requires execution_evidence
  const breakerSize = getPolicy().engine.max_circuit_breaker;
  if (currentRound < breakerSize || vaultEntries.length < breakerSize) return null;

  const progressByRound = collectProgressByRound(vaultEntries, currentRound);
  if (progressByRound.size < breakerSize) return null;

  const sortedRounds = [...progressByRound.keys()].sort((a, b) => a - b);
  const recent = sortedRounds.slice(-breakerSize);

  // Check that progress values are ALL identical (delta = 0).
  // Use epsilon comparison — JSON round-trips can produce float drift
  // (e.g. 0.3 vs 0.30000000000000004) that would defeat strict === .
  const EPSILON = 1e-10;
  const first = progressByRound.get(recent[0])!;
  const allFlat = recent.every((r) => Math.abs((progressByRound.get(r) ?? 0) - first) < EPSILON);

  if (!allFlat || first >= 0.95) return null;

  const escalation = getPolicy().engine.enforcement_escalation_enabled;

  // v2.7: When escalation is enabled, give one rejection round with a
  // "Seek Human Guidance" notice before terminating.
  if (consecutiveRejections >= 1) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Progress has been completely flat at ${(first * 100).toFixed(0)}% ` +
        `for ${breakerSize} consecutive rounds and agent did not resolve ` +
        `after escalation. The agent is making zero forward motion.`,
      check: "progress_stall_terminal",
    });
  }

  if (escalation) {
    // v2.10: When backtrack is enabled, escalate to backtrack instead of
    // reject. The agent is rolled back to the last clean round with a
    // "radically different strategy" lesson injected.
    if (getPolicy().engine.backtrack_enabled) {
      return makeEnforcementResult({
        action: "backtrack",
        reason:
          `Progress has been completely flat at ${(first * 100).toFixed(0)}% ` +
          `for ${breakerSize} consecutive rounds. The agent is making zero ` +
          `forward motion.`,
        fix_instructions:
          "Your progress has been exactly flat — zero forward motion. " +
          "You are being rolled back to the last clean round. " +
          "Choose a RADICALLY different approach. The previous one produced nothing.",
        check: "progress_stall_terminal",
      });
    }
    return makeEnforcementResult({
      action: "reject",
      reason:
        `Progress has been completely flat at ${(first * 100).toFixed(0)}% ` +
        `for ${breakerSize} consecutive rounds. The agent is making zero ` +
        `forward motion.`,
      fix_instructions:
        "Your progress has been exactly flat — you are making zero forward " +
        "motion. You must: (a) explain what is fundamentally blocking you, " +
        "(b) propose a radically different approach, and " +
        "(c) set a concrete verifiable goal. " +
        "Do NOT resubmit the same output." +
        buildEscalationNotice(),
      check: "progress_stall_terminal",
    });
  }

  return makeEnforcementResult({
    action: "terminate",
    reason:
      `Progress has been completely flat at ${(first * 100).toFixed(0)}% ` +
      `for ${breakerSize} consecutive rounds. The agent is making zero ` +
      `forward motion and cannot recover.`,
    check: "progress_stall_terminal",
  });
}

/** R6: Two consecutive rejections → escalate (v2.7) or terminate.
 *
 *  v2.7: When enforcement_escalation_enabled is true, the second consecutive
 *  rejection issues an escalated rejection with a "Seek Human Guidance" notice
 *  instead of terminating immediately. Termination occurs on the third
 *  consecutive rejection. When the flag is disabled, behavior is unchanged
 *  (terminate at ≥2 rejections). */
function enforceMaxRejections(
  consecutiveRejections: number,
): EnforcementResult | null {
  const escalation = getPolicy().engine.enforcement_escalation_enabled;

  if (escalation) {
    if (consecutiveRejections >= 3) {
      return makeEnforcementResult({
        action: "terminate",
        reason:
          `${consecutiveRejections} consecutive enforcement rejections for the ` +
          `same issue without resolution. The agent has been unable to correct ` +
          `the identified issue even after escalation. Terminating loop.`,
        check: "max_rejections",
      });
    }

    if (consecutiveRejections >= 2) {
      return makeEnforcementResult({
        action: "reject",
        reason:
          `${consecutiveRejections} consecutive enforcement rejections for the ` +
          `same issue without resolution.`,
        fix_instructions:
          "You have been rejected multiple times for the same issue. " +
          "You must address ALL items in the Evidence Gap section above. " +
          "If you do not understand why you are being rejected, explain " +
          "your confusion explicitly and ask for clarification." +
          buildEscalationNotice(),
        check: "max_rejections",
      });
    }

    return null;
  }

  if (consecutiveRejections < 2) return null;

  return makeEnforcementResult({
    action: "terminate",
    reason:
      `${consecutiveRejections} consecutive enforcement rejections for the ` +
      `same issue without resolution. The agent has been unable to correct the identified issue.`,
    check: "max_rejections",
  });
}

/** v2.12: Check if a drift_clarification contains at least one semantic
 *  anchor — a constraint/criterion/sub-goal ID (v2.11) or a file-path-like
 *  reference. This distinguishes genuine explanations from filler text that
 *  just happens to be ≥ 20 characters. */
function hasSemanticAnchor(clarification: string): boolean {
  // v2.11: Constraint / criterion / sub-goal ID patterns
  if (/[c]r?-[a-f0-9]{8}/.test(clarification)) return true;
  if (/sg-[a-f0-9]{8}/.test(clarification)) return true;
  // File path references (e.g. "src/auth/login.ts", "lib/utils.go")
  if (/[\w./-]+\.[a-z]{2,6}\b/i.test(clarification)) return true;
  return false;
}

/** Build a stronger rejection notice as the clarification streak grows. */
function buildClarificationRejectionNotice(streak: number): string {
  const base =
    "Your declared next_action from the previous round does not match " +
    "what you actually did this round. You must either: " +
    "(a) explain why you pivoted in the drift_clarification field, " +
    "mentioning specific constraint/criterion/sub-goal IDs or file paths " +
    "that prompted the change, or " +
    "(b) redo this round and do what you said you would do.";

  if (streak >= 2) {
    return (
      base +
      "\n\n### ⚠️ Repeated Weak Clarification\n\n" +
      `You have submitted drift_clarification without concrete references ` +
      `for ${streak} consecutive rounds. Your explanation MUST include at ` +
      `least one of: a constraint ID (c-XXXXXXXX), criterion ID (cr-XXXXXXXX), ` +
      `sub-goal ID (sg-XXXXXXXX), or a file path you changed.\n\n` +
      `🚨 If the next clarification also lacks concrete anchors, the loop ` +
      `will be terminated.`
    );
  }

  return base;
}

/** R7: Agent declared a next_action but did something unrelated.
 *
 *  v2.8: When the agent provides a substantive drift_clarification (≥ 20
 *  characters), the rejection is waived — the agent has acknowledged and
 *  explained the pivot. An empty or absent clarification still triggers
 *  the normal reject/terminate path.
 *
 *  v2.12: Clarification now requires a semantic anchor (constraint/criterion/
 *  sub-goal ID or file path) in addition to the ≥ 20 char minimum. Weak
 *  clarifications (no anchors) increment a streak counter; 3 consecutive
 *  weak clarifications terminate the loop.
 *
 *  First occurrence → reject (agent must explain the gap or realign).
 *  Second consecutive → terminate (agent cannot/will not follow its own plan). */
function enforceIntentDrift(
  flags: VerificationFlag[],
  selfEval: SelfEvaluation,
  consecutiveRejections: number,
  driftClarificationStreak: number = 0,
): EnforcementResult | null {
  const flag = flags.find((f) => f.check === "intent_drift");
  if (!flag) return null;

  const clarification = selfEval.drift_clarification?.trim();

  // v2.12: Semantic anchor detection — requires concrete references
  const hasAnchor = clarification ? hasSemanticAnchor(clarification) : false;

  // v2.12: Substantive clarification = length check + semantic anchor
  const isSubstantive = clarification
    && clarification.length >= 20
    && hasAnchor;

  if (isSubstantive) {
    // Genuine explanation with concrete references → accept the pivot
    return makeEnforcementResult({
      action: "accept",
      reason: "",
      fix_instructions: "",
      check: "intent_drift",
      clarification_accepted: true,
    });
  }

  // v2.12: Clarification present but weak (no semantic anchors)
  if (clarification && clarification.length >= 20 && !hasAnchor) {
    const maxStreak = getPolicy().engine.drift_clarification_max_streak;

    // When maxStreak is 0, disable the check (pre-v2.12 behavior)
    if (maxStreak <= 0) {
      return makeEnforcementResult({
        action: "accept",
        reason: "",
        fix_instructions: "",
        check: "intent_drift",
        clarification_accepted: true,
      });
    }

    const newStreak = driftClarificationStreak + 1;
    if (newStreak >= maxStreak) {
      return makeEnforcementResult({
        action: "terminate",
        reason:
          `Agent has submitted weak drift_clarification (no concrete IDs or ` +
          `file references) for ${newStreak} consecutive rounds. The agent ` +
          `systematically avoids following its own plan without substantive ` +
          `explanation.`,
        check: "intent_drift",
      });
    }

    return makeEnforcementResult({
      action: "reject",
      reason: flag.detail,
      fix_instructions: buildClarificationRejectionNotice(newStreak),
      check: "intent_drift",
    });
  }

  // No clarification or too short — original behavior
  if (consecutiveRejections >= 1) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Agent was warned about intent-action drift but continues to do ` +
        `work unrelated to its declared next_action without explanation. ` +
        `The agent cannot or will not follow its own plan — terminating loop.`,
      check: "intent_drift",
    });
  }

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "Your declared next_action from the previous round does not match " +
      "what you actually did this round. You must either: " +
      "(a) explain why you pivoted and what you learned in the " +
      "drift_clarification field, or " +
      "(b) redo this round and do what you said you would do. " +
      "If you intentionally changed direction, update your objective_refinement " +
      "and set a new next_action that reflects the new plan.",
    check: "intent_drift",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Escalation notice builder (v2.7)
// ═══════════════════════════════════════════════════════════════════════════

/** Build an escalation notice urging the agent to seek human guidance.
 *
 *  Appended to fix_instructions when a rule would otherwise terminate.
 *  Gives the agent one final chance to correct course with human input
 *  before the loop is irreversibly stopped. */
function buildEscalationNotice(): string {
  return [
    "",
    "### 🆘 Escalation — Seek Human Guidance",
    "",
    "You have been rejected multiple times for the same issue. " +
      "Before retrying, pause and ask a human for help:",
    "",
    "1. Explain what you've tried so far and why each approach failed.",
    "2. Ask the human for specific guidance on what to try next.",
    "3. Incorporate their feedback before re-submitting your self-evaluation.",
    "",
    "⚠️ If this round is rejected again, the loop will be **terminated**. " +
      "Do NOT resubmit without meaningful changes.",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Diagnostic gap builder (v2.7)
// ═══════════════════════════════════════════════════════════════════════════

/** Build a diagnostic gap section from verification flags.
 *
 *  Translates each error/warn-level VerificationFlag into a concrete
 *  claim-vs-evidence mismatch statement. Info-level flags are excluded
 *  because they are purely informational and do not represent gaps.
 *
 *  Returns an empty string when there are no diagnostic flags to report. */
function buildDiagnosticGap(flags: VerificationFlag[]): string {
  const diagnosticFlags = flags.filter(
    (f) => f.severity === "error" || f.severity === "warn",
  );
  if (diagnosticFlags.length === 0) return "";

  const lines: string[] = [
    "### Evidence Gap",
    "",
    "The enforcement gate detected mismatches between your claims and the evidence. " +
      "Each item below shows a specific discrepancy — address every one before re-submitting.",
    "",
  ];

  for (const flag of diagnosticFlags) {
    const icon = flag.severity === "error" ? "🚫" : "⚠️";
    lines.push(`- ${icon} **[${flag.check}]** \`${flag.field}\` — ${flag.detail}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/** Enforce round-boundary rules based on the verification gate's findings
 *  and the agent's self-evaluation integrity.
 *
 *  Rules run in priority order (R1 → R5). The first rule that fires wins.
 *
 * @param selfEval              The agent's self-evaluation for the current round.
 * @param verifyResult          The verification gate's output (from verifySelfEvaluation).
 * @param currentRound          Current round number (1-based, BEFORE increment).
 * @param vaultEntries          Vault entries for this loop (used for progress tracking).
 * @param consecutiveRejections How many consecutive rounds have already been rejected.
 *                              Starts at 0; increments on each reject; resets on accept.
 */
export function enforceRound(
  selfEval: SelfEvaluation,
  verifyResult: VerificationResult,
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number = 0,
  skipEvidenceRules = false,
  /** v2.12: Current clarification streak for R7 escalation. */
  driftClarificationStreak: number = 0,
): EnforcementResult {
  const { flags } = verifyResult;

  // Run enforcement rules in priority order.
  // Earlier rules take higher precedence.
  const rules: Array<() => EnforcementResult | null> = [
    () => enforceSuccessWithRemainingCriteria(flags),
    () => enforceRecurringViolation(flags),
    () => enforceEmptySuccess(selfEval, flags, skipEvidenceRules),
    () => enforceProgressStall(selfEval, flags, currentRound, vaultEntries, consecutiveRejections, skipEvidenceRules),
    () => enforceProgressStallTerminal(selfEval, flags, currentRound, vaultEntries, consecutiveRejections, skipEvidenceRules),
    () => enforceMaxRejections(consecutiveRejections),
    () => enforceIntentDrift(flags, selfEval, consecutiveRejections, driftClarificationStreak),
  ];

  for (const rule of rules) {
    const result = rule();
    if (result) return result;
  }

  // All rules passed — accept the round
  return makeEnforcementResult({
    action: "accept",
    reason: "",
    fix_instructions: "",
  });
}

/** Build a rejection prompt for the agent.
 *
 *  The prompt clearly states the round was rejected, why, what the agent
 *  must fix, and that the agent must redo the SAME round (not advance).
 *
 *  v2.7: Accepts verificationFlags to render a diagnostic "Evidence Gap"
 *  section. Each error/warn flag becomes a concrete claim-vs-evidence
 *  mismatch statement so the agent knows exactly what to correct rather
 *  than retrying blindly.
 *
 * @param currentRound      The round number that was rejected (NOT incremented).
 * @param task              The original loop task description.
 * @param enforceResult     The enforcement decision with reason and fix instructions.
 * @param verificationFlags The verification gate's findings for this round.
 *                          Used to build the Evidence Gap section. */
export function buildRejectionPrompt(
  currentRound: number,
  task: string,
  enforceResult: EnforcementResult,
  verificationFlags: VerificationFlag[] = [],
): string {
  const lines: string[] = [
    "## ⛔ Round " + currentRound + " — REJECTED",
    "",
    "Your self-evaluation for Round " + currentRound +
    " was **rejected** by the enforcement gate.",
    "",
    "### Reason",
    "",
    enforceResult.reason,
    "",
  ];

  // v2.7: Diagnostic gap — show the agent exactly what doesn't match.
  const gap = buildDiagnosticGap(verificationFlags);
  if (gap) {
    lines.push(gap);
  }

  if (enforceResult.fix_instructions) {
    lines.push("### Required Fix");
    lines.push("");
    lines.push(enforceResult.fix_instructions);
    lines.push("");
  }

  lines.push("### Your Task (Round " + currentRound + " — Retry)");
  lines.push("");
  lines.push(task);
  lines.push("");

  lines.push("### Instructions");
  lines.push("");
  lines.push(
    "1. Read and address each issue in **Required Fix** above.",
    "2. Re-execute **Round " + currentRound +
    "** — do NOT advance to the next round.",
    "3. Submit a corrected self-evaluation via `loopforge_next`.",
    "4. Be honest in your self-evaluation — " +
    "claiming success when criteria are unmet will be rejected again.",
    "5. If you believe this rejection is incorrect, " +
    "explain why in your output_summary and the enforcement gate will re-evaluate.",
  );

  return lines.join("\n");
}
