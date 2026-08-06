/** Verification Gate — Layer 1 cross-round consistency checks.
 *
 * Pure-function module. Validates an agent's SelfEvaluation against the
 * loop's own lineage before it enters the compiler.
 *
 * Verdict semantics:
 * - trusted:      all checks passed; flags are informational only.
 * - suspect:      one or more warn-level flags; flags become warnings in
 *                 the next prompt so the agent can clarify.
 * - contradicted: one or more error-level flags; the success flag for
 *                 this round is excluded from the success trend (NOT
 *                 modified). Flags become hard constraints — the agent
 *                 must respond in the next round.
 */
import { getPolicy } from "./policy.js";
import { makeVerificationFlag, makeVerificationResult } from "./protocol.js";
import { jaccardSimilarity, entryRound as sharedEntryRound } from "./token-utils.js";
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
/** Extract the round number from a vault entry's loop_lineage.
 *  Returns 0 if the entry has no lineage or no round field.
 *  In practice, persistLoopLineage always writes round ≥ 1, so 0
 *  unambiguously means "not a valid round entry" in this context.
 *  Exported for reuse by enforcement-gate.ts. */
export function entryRound(entry) {
    return sharedEntryRound(entry);
}
/** Read constraint_violations from a vault entry (entry-level, stored from
 *  the previous round's last_round_result at persist time). */
function entryViolations(entry) {
    const viols = entry.constraint_violations;
    if (Array.isArray(viols))
        return viols.filter((v) => typeof v === "string");
    return [];
}
// ═══════════════════════════════════════════════════════════════════════════
// Individual checks — each returns a VerificationFlag or null
// ═══════════════════════════════════════════════════════════════════════════
function checkProgressRegression(selfEval, prevSelfEval) {
    if (!prevSelfEval?.execution_evidence)
        return null;
    if (!selfEval.execution_evidence)
        return null;
    const prevProgress = prevSelfEval.execution_evidence.progress_estimate;
    const currProgress = selfEval.execution_evidence.progress_estimate;
    if (typeof prevProgress !== "number" || typeof currProgress !== "number")
        return null;
    // Use delta with epsilon to avoid IEEE 754 rounding issues (0.8 - 0.2 > 0.6 in float)
    if (prevProgress - currProgress <= 0.2 + 1e-10)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "progress_estimate",
        check: "progress_regression",
        detail: `Progress dropped from ${prevProgress.toFixed(2)} to ` +
            `${currProgress.toFixed(2)} (delta: ${(currProgress - prevProgress).toFixed(2)})`,
    });
}
function checkEmptyChangeWithPassing(selfEval) {
    const ev = selfEval.execution_evidence;
    if (!ev)
        return null;
    const filesEmpty = ev.files_changed.length === 0;
    const testsAllPass = ev.test_results !== null &&
        ev.test_results.failed === 0 &&
        ev.test_results.passed > 0;
    if (!filesEmpty || !testsAllPass || !selfEval.success)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "execution_evidence",
        check: "empty_change_with_passing",
        detail: "Agent claims success with no files changed and all tests passing — " +
            "verify that work was actually performed",
    });
}
function checkSuccessWithRemainingCriteria(selfEval) {
    if (!selfEval.success)
        return null;
    const remaining = selfEval.execution_evidence?.success_criteria_remaining;
    if (!remaining || remaining.length === 0)
        return null;
    return makeVerificationFlag({
        severity: "error",
        field: "success",
        check: "success_with_remaining_criteria",
        detail: `Agent claims success but ${remaining.length} criteria remain unmet: ` +
            remaining.slice(0, 3).join("; "),
    });
}
function checkDuplicateConstraintDiscovery(selfEval, prevSelfEval, olderViolations) {
    const discovered = selfEval.discovered_constraints;
    if (!discovered || discovered.length === 0)
        return null;
    // Collect all previously-known constraints
    const known = new Set();
    for (const v of olderViolations)
        known.add(v.toLowerCase().trim());
    if (prevSelfEval) {
        for (const d of prevSelfEval.discovered_constraints ?? []) {
            known.add(d.toLowerCase().trim());
        }
        // Also treat previous violations as implicitly discovered
        for (const v of prevSelfEval.constraint_violations) {
            known.add(v.toLowerCase().trim());
        }
    }
    for (const d of discovered) {
        if (known.has(d.toLowerCase().trim())) {
            return makeVerificationFlag({
                severity: "warn",
                field: "discovered_constraints",
                check: "duplicate_constraint_discovery",
                detail: `Constraint "${d}" was already known from a previous round`,
            });
        }
    }
    return null;
}
function checkRecurringViolation(selfEval, prevSelfEval, vaultEntries, currentRound) {
    const currViols = selfEval.constraint_violations;
    if (!currViols || currViols.length === 0)
        return null;
    // Build the violation history: [round N-2, round N-1, round N]
    const violationsByRound = [];
    // Round N-2 violations come from the vault entry for round N-1
    // (persistLoopLineage stores the PREVIOUS round's violations on each entry)
    if (currentRound >= 3) {
        const entryNMinus1 = vaultEntries.find((e) => entryRound(e) === currentRound - 1);
        if (entryNMinus1) {
            const viols = entryViolations(entryNMinus1);
            if (viols.length)
                violationsByRound.push(viols.map((v) => v.toLowerCase().trim()));
        }
    }
    // Round N-1 violations from prevSelfEval
    if (prevSelfEval) {
        const prevViols = prevSelfEval.constraint_violations;
        violationsByRound.push(prevViols.map((v) => v.toLowerCase().trim()));
    }
    // Round N violations from current selfEval
    violationsByRound.push(currViols.map((v) => v.toLowerCase().trim()));
    // Need at least 3 rounds of data
    if (violationsByRound.length < 3)
        return null;
    // Check each current violation against the previous 2 rounds
    const [rNMinus2, rNMinus1, rN] = violationsByRound.slice(-3);
    for (const v of rN) {
        if (rNMinus1.includes(v) && rNMinus2.includes(v)) {
            return makeVerificationFlag({
                severity: "error",
                field: "constraint_violations",
                check: "recurring_violation",
                detail: `Constraint violation "${v}" has appeared in 3 consecutive rounds ` +
                    `(rounds ${currentRound - 2}–${currentRound}) without resolution`,
            });
        }
    }
    return null;
}
function checkRetractFreshConstraint(selfEval, prevSelfEval, currentRound) {
    const retracted = selfEval.retracted_constraints;
    if (!retracted || retracted.length === 0)
        return null;
    if (!prevSelfEval)
        return null;
    const lastRoundDiscoveries = new Set();
    for (const d of prevSelfEval.discovered_constraints ?? []) {
        lastRoundDiscoveries.add(d.toLowerCase().trim());
    }
    for (const r of retracted) {
        if (lastRoundDiscoveries.has(r.toLowerCase().trim())) {
            return makeVerificationFlag({
                severity: "warn",
                field: "retracted_constraints",
                check: "retract_fresh_constraint",
                detail: `Retracting constraint "${r}" that was just discovered in round ` +
                    `${currentRound - 1} — may indicate rapid flip-flopping`,
            });
        }
    }
    return null;
}
/** v1.18: Cross-validate agent-reported files_changed against git evidence
 *  from the configured evidence providers (ProviderSnapshot array). */
function checkEvidenceIntegrity(selfEval, evidenceSnapshots) {
    if (!selfEval.execution_evidence)
        return null;
    if (evidenceSnapshots.length === 0)
        return null;
    const gitSnap = evidenceSnapshots.find((s) => s.provider === "git");
    if (!gitSnap)
        return null;
    const reported = [...selfEval.execution_evidence.files_changed].sort();
    const actual = [...gitSnap.files].sort();
    if (reported.length === 0 && actual.length === 0)
        return null;
    if (reported.length === 0 && actual.length > 0) {
        return makeVerificationFlag({
            severity: "warn",
            field: "files_changed",
            check: "evidence_integrity",
            detail: `Agent reported no files changed but evidence shows: ${actual.join(", ")}`,
        });
    }
    const ghostFiles = reported.filter((f) => !actual.includes(f));
    const missedFiles = actual.filter((f) => !reported.includes(f));
    if (ghostFiles.length > 0 || missedFiles.length > 0) {
        const parts = [];
        if (ghostFiles.length > 0)
            parts.push(`unconfirmed: [${ghostFiles.join(", ")}]`);
        if (missedFiles.length > 0)
            parts.push(`unreported: [${missedFiles.join(", ")}]`);
        return makeVerificationFlag({
            severity: "warn",
            field: "files_changed",
            check: "evidence_integrity",
            detail: `Agent files_changed doesn't match evidence: ${parts.join("; ")}`,
        });
    }
    return null;
}
/** A required, explicitly configured verification command is authoritative
 * when the Agent claims success. Optional commands remain observational. */
function checkRequiredCommandEvidence(selfEval, evidenceSnapshots) {
    if (!selfEval.success)
        return null;
    for (const snapshot of evidenceSnapshots) {
        if (snapshot.data.kind !== "command")
            continue;
        if (snapshot.data.phase !== "after" || snapshot.data.required !== true)
            continue;
        const status = snapshot.data.status;
        if (status === "passed")
            continue;
        const name = typeof snapshot.data.commandName === "string"
            ? snapshot.data.commandName
            : snapshot.provider;
        const exitCode = typeof snapshot.data.exitCode === "number"
            ? ` (exit ${snapshot.data.exitCode})`
            : "";
        return makeVerificationFlag({
            severity: "error",
            field: "execution_evidence",
            check: "required_command_failed",
            detail: `Agent claims success but required command "${name}" ${String(status)}${exitCode}`,
        });
    }
    return null;
}
// ── Test output parsing ────────────────────────────────────────────────────
// jaccardSimilarity() imported from token-utils.ts (v2.1 — intent-action drift detection)
/** v2.1 (check 11): Compare the previous round's declared next_action with
 *  the current round's actual output_summary. Detect when the agent says it
 *  will do X but then does Y — silent drift without explanation.
 *
 *  Only fires when both next_action and output_summary are non-empty.
 *  Uses configurable Jaccard token similarity threshold from policy. */
function checkIntentDrift(selfEval, prevSelfEval) {
    if (!prevSelfEval?.next_action?.trim())
        return null;
    if (!selfEval.output_summary.trim())
        return null;
    const intent = prevSelfEval.next_action.trim();
    const actual = selfEval.output_summary.trim();
    const score = jaccardSimilarity(intent, actual);
    const threshold = getPolicy().evolution.intent_drift_threshold;
    if (score >= threshold)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "output_summary",
        check: "intent_drift",
        detail: `Declared intent was "${intent.slice(0, 120)}" ` +
            `but actual output "${actual.slice(0, 120)}" — ` +
            `similarity ${(score * 100).toFixed(0)}% below threshold ${(threshold * 100).toFixed(0)}%`,
    });
}
/** Best-effort parse of test counts from common test-runner output formats.
 *
 *  Scans the last 2000 characters of stdout (where summary lines typically
 *  appear) and tries patterns in descending specificity order. Returns null
 *  when the output format is unrecognized, stdout is empty, or a confident
 *  parse cannot be made.
 *
 *  Recognized formats: Jest verbose/compact, Mocha, pytest/unittest, Go test,
 *  and PHPUnit OK summaries. */
export function parseTestOutput(stdout) {
    if (!stdout)
        return null;
    const tail = stdout.length > 2000 ? stdout.slice(-2000) : stdout;
    let match;
    // 1. Jest verbose: "Tests: 1 failed, 8 passed, 9 total"
    match = tail.match(/Tests:\s*(\d+)\s+failed,\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
    if (match) {
        return { failed: Number(match[1]), passed: Number(match[2]), total: Number(match[3]), skipped: 0 };
    }
    // 2. Jest compact: "Tests: 8 passed, 9 total"
    match = tail.match(/Tests:\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
    if (match) {
        const passed = Number(match[1]);
        const total = Number(match[2]);
        return { passed, failed: total - passed, total, skipped: 0 };
    }
    // 3. Mocha: "8 passing" + optional "2 failing"
    const mochaPass = tail.match(/(\d+)\s+passing/i);
    if (mochaPass) {
        const mochaFail = tail.match(/(\d+)\s+failing/i);
        const passed = Number(mochaPass[1]);
        const failed = mochaFail ? Number(mochaFail[1]) : 0;
        return { passed, failed, total: passed + failed, skipped: 0 };
    }
    // 4. Go test: count "--- PASS:" and "--- FAIL:" lines
    const goPassCount = (tail.match(/---\s+PASS:/g) || []).length;
    const goFailCount = (tail.match(/---\s+FAIL:/g) || []).length;
    if (goPassCount > 0 || goFailCount > 0) {
        return { passed: goPassCount, failed: goFailCount, total: goPassCount + goFailCount, skipped: 0 };
    }
    // 5. pytest / unittest: "8 passed, 1 failed" or "8 passed"
    match = tail.match(/(\d+)\s+passed[,;\s]+(\d+)\s+failed/i);
    if (match) {
        return { passed: Number(match[1]), failed: Number(match[2]), total: Number(match[1]) + Number(match[2]), skipped: 0 };
    }
    // pytest compact: "8 passed" (with a reasonable context hint)
    match = tail.match(/(?:=\s+test session|\b(?:passed|failed)\b)/i);
    if (match) {
        const pCount = tail.match(/(\d+)\s+passed/i);
        const fCount = tail.match(/(\d+)\s+failed/i);
        if (pCount || fCount) {
            const passed = pCount ? Number(pCount[1]) : 0;
            const failed = fCount ? Number(fCount[1]) : 0;
            return { passed, failed, total: passed + failed, skipped: 0 };
        }
    }
    // 6. PHPUnit: "OK (8 tests, 16 assertions)"
    match = tail.match(/OK\s*\((\d+)\s+tests?/i);
    if (match) {
        const total = Number(match[1]);
        return { passed: total, failed: 0, total, skipped: 0 };
    }
    return null;
}
/** Cross-validate agent-reported test_results against command evidence output.
 *
 *  For each command provider whose status is "passed" and output is not
 *  truncated, attempts to parse test counts from stdout. Mismatched counts
 *  produce a warn-level flag; failures hidden by the agent (reported 0 failed
 *  when the command shows >0) produce an error-level flag.
 *
 *  Non-command evidence providers are skipped (no structural cross-check is
 *  defined for them yet). */
function checkCommandEvidenceIntegrity(selfEval, evidenceSnapshots) {
    const reported = selfEval.execution_evidence?.test_results;
    if (!reported)
        return null;
    for (const snapshot of evidenceSnapshots) {
        if (snapshot.data.kind !== "command")
            continue;
        if (snapshot.data.status !== "passed")
            continue;
        if (snapshot.data.truncated === true)
            continue;
        const stdout = typeof snapshot.data.stdout === "string" ? snapshot.data.stdout : "";
        const parsed = parseTestOutput(stdout);
        if (!parsed)
            continue;
        const mismatches = [];
        if (parsed.passed !== reported.passed) {
            mismatches.push(`passed: reported ${reported.passed}, command shows ${parsed.passed}`);
        }
        if (parsed.failed !== reported.failed) {
            mismatches.push(`failed: reported ${reported.failed}, command shows ${parsed.failed}`);
        }
        if (mismatches.length === 0) {
            // Counts match exactly — evidence supports the agent's claim.
            continue;
        }
        const name = typeof snapshot.data.commandName === "string"
            ? snapshot.data.commandName
            : snapshot.provider;
        // Agent hides failures → error. Other mismatch → warn.
        const severity = parsed.failed > 0 && reported.failed === 0 ? "error" : "warn";
        return makeVerificationFlag({
            severity,
            field: "test_results",
            check: "command_evidence_mismatch",
            detail: `Agent test_results don't match "${name}" output: ${mismatches.join("; ")}`,
        });
    }
    return null;
}
/** v2.2: Check if the agent's declared next_action aligns with any pending
 *  or in_progress sub-goal. When 3+ pending sub-goals exist but the agent
 *  plans work unrelated to any of them, it may indicate task drift.
 *  This is a warn-level advisory — the agent always owns prioritization. */
function checkSubGoalDrift(selfEval, prevSelfEval, vaultEntries, currentRound) {
    const nextAction = selfEval.next_action?.trim();
    if (!nextAction)
        return null;
    // Reconstruct pending sub-goal descriptions from vault entries
    const pendingSubGoals = new Set();
    const completedOrCanceled = new Set();
    for (const entry of vaultEntries) {
        const emerged = Array.isArray(entry.emerged_subtasks)
            ? entry.emerged_subtasks.filter((v) => typeof v === "string")
            : [];
        for (const desc of emerged) {
            pendingSubGoals.add(desc.trim());
        }
        const done = Array.isArray(entry.completed_subtasks)
            ? entry.completed_subtasks.filter((v) => typeof v === "string")
            : [];
        for (const desc of done) {
            completedOrCanceled.add(desc.trim());
        }
        const canceled = Array.isArray(entry.canceled_subtasks)
            ? entry.canceled_subtasks.filter((v) => typeof v === "string")
            : [];
        for (const desc of canceled) {
            completedOrCanceled.add(desc.trim());
        }
    }
    // Also process current selfEval
    for (const desc of selfEval.emerged_subtasks ?? []) {
        pendingSubGoals.add(desc.trim());
    }
    for (const desc of selfEval.completed_subtasks ?? []) {
        completedOrCanceled.add(desc.trim());
    }
    for (const desc of selfEval.canceled_subtasks ?? []) {
        completedOrCanceled.add(desc.trim());
    }
    // Remove completed/canceled from pending
    for (const desc of completedOrCanceled) {
        pendingSubGoals.delete(desc);
    }
    // Need at least 3 pending sub-goals for the check to be meaningful
    if (pendingSubGoals.size < 3)
        return null;
    // Check if next_action aligns with any pending sub-goal
    let aligns = false;
    for (const sg of pendingSubGoals) {
        const score = jaccardSimilarity(nextAction, sg);
        if (score >= getPolicy().evolution.subgoal_drift_alignment_threshold) {
            aligns = true;
            break;
        }
    }
    if (!aligns) {
        const sample = [...pendingSubGoals].slice(0, 3).join(", ");
        return makeVerificationFlag({
            severity: "warn",
            field: "next_action",
            check: "subgoal_drift",
            detail: `Agent's next_action doesn't align with any of ${pendingSubGoals.size} pending sub-goals. ` +
                `Pending: ${sample}… Consider completing existing sub-goals before starting new work, ` +
                `or cancel outdated sub-goals via canceled_subtasks.`,
        });
    }
    return null;
}
/** v2.13: After a backtrack, check that the agent restored the workspace
 *  before working. If the agent's files_changed overlaps with files from
 *  skipped (failed) rounds, the workspace was likely not clean. */
function checkBacktrackWorkspaceRestore(selfEval, backtrackSkippedFiles) {
    if (backtrackSkippedFiles.length === 0)
        return null;
    const ev = selfEval.execution_evidence;
    if (!ev || ev.files_changed.length === 0)
        return null;
    // Check overlap: files the agent changed vs. files from skipped rounds
    const overlap = ev.files_changed.filter((f) => backtrackSkippedFiles.some((sf) => sf === f || f.endsWith(sf) || sf.endsWith(f)));
    if (overlap.length === 0)
        return null;
    // Agent is modifying files that were part of failed rounds without
    // having properly restored the workspace first.
    if (overlap.length >= 3 || overlap.length === ev.files_changed.length) {
        return makeVerificationFlag({
            severity: "error",
            field: "files_changed",
            check: "backtrack_workspace_not_restored",
            detail: `Agent modified ${overlap.length} file(s) that were part of ` +
                `the skipped (failed) rounds: ${overlap.slice(0, 5).join(", ")}. ` +
                `The workspace was likely not restored before working.`,
        });
    }
    // Minor overlap — warn only
    return makeVerificationFlag({
        severity: "warn",
        field: "files_changed",
        check: "backtrack_workspace_not_restored",
        detail: `Agent modified files that overlap with skipped rounds: ` +
            `${overlap.join(", ")}. Verify the workspace was restored.`,
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════
/** Verify a SelfEvaluation against the loop's cross-round lineage.
 *
 * @param selfEval             The agent's self-evaluation for the current round.
 * @param currentRound         The current round number (1-based).
 * @param vaultEntries         Vault entries for this loop (non-feedback only).
 * @param prevSelfEval         The agent's self-evaluation from the previous round
 *                             (null for round 1).
 * @param evidenceSnapshots    v1.18: Evidence snapshots from configured providers.
 *                             Used by checkEvidenceIntegrity for multi-provider
 *                             cross-validation. Defaults to empty array. */
export function verifySelfEvaluation(selfEval, currentRound, vaultEntries, prevSelfEval = null, evidenceSnapshots = [], 
/** v2.13: Files from skipped backtrack rounds. If the agent's
 *  files_changed overlaps significantly with these, the workspace
 *  was not properly restored before working. */
backtrackSkippedFiles = []) {
    const flags = [];
    // Collect violations from all previous vault entries for duplicate-discovery
    // and other checks that need deeper history.
    const olderViolations = [];
    for (const entry of vaultEntries) {
        for (const v of entryViolations(entry))
            olderViolations.push(v);
    }
    // Run all checks
    const checks = [
        () => checkProgressRegression(selfEval, prevSelfEval),
        () => checkEmptyChangeWithPassing(selfEval),
        () => checkSuccessWithRemainingCriteria(selfEval),
        () => checkDuplicateConstraintDiscovery(selfEval, prevSelfEval, olderViolations),
        () => checkRecurringViolation(selfEval, prevSelfEval, vaultEntries, currentRound),
        () => checkRetractFreshConstraint(selfEval, prevSelfEval, currentRound),
        // v1.18: Cross-validate agent-reported files_changed against git evidence
        () => checkEvidenceIntegrity(selfEval, evidenceSnapshots),
        () => checkRequiredCommandEvidence(selfEval, evidenceSnapshots),
        // v2.0: Cross-validate agent-reported test_results against command output
        () => checkCommandEvidenceIntegrity(selfEval, evidenceSnapshots),
        // v2.1: Detect intent-action drift — agent said X but did Y
        () => checkIntentDrift(selfEval, prevSelfEval),
        // v2.2: Detect sub-goal drift — next_action doesn't align with pending sub-goals
        () => checkSubGoalDrift(selfEval, prevSelfEval, vaultEntries, currentRound),
        // v2.13: Post-backtrack workspace restore check
        () => checkBacktrackWorkspaceRestore(selfEval, backtrackSkippedFiles),
    ];
    for (const run of checks) {
        const flag = run();
        if (flag)
            flags.push(flag);
    }
    // Determine verdict from the most severe flag present
    const hasError = flags.some((f) => f.severity === "error");
    const hasWarn = flags.some((f) => f.severity === "warn");
    let verdict;
    if (hasError) {
        verdict = "contradicted";
    }
    else if (hasWarn) {
        verdict = "suspect";
    }
    else {
        verdict = "trusted";
    }
    return makeVerificationResult({ verdict, flags });
}
//# sourceMappingURL=verification-gate.js.map