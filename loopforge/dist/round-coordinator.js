/** RoundCoordinator — Unified round-boundary state machine (v1.17).
 *
 * Encapsulates the shared round processing pipeline used by
 * SessionManager (mcp/session.ts):
 *
 *   verify → enforce → stop decision
 *
 * Before this module, runtime.ts and session.ts each maintained their
 * own copy of the pipeline (~60 lines each). Drift between the two
 * paths (e.g. git verification only wired into one side) was a known
 * risk. The RoundCoordinator is the single source of truth.
 *
 * State transitions:
 *   RoundStarted → EvidenceCaptured → EvaluationSubmitted
 *   → VerificationCompleted → EnforcementDecided
 *
 * Persistence is owned by round-transaction.ts so reject paths remain
 * side-effect free and accepted decisions can be replayed idempotently.
 */
import { verifySelfEvaluation, entryRound } from "./verification-gate.js";
import { enforceRound, buildRejectionPrompt, findSafeRestorePoint, buildBacktrackPrompt, } from "./enforcement-gate.js";
import { logEvent } from "./observability.js";
import { getPolicy } from "./policy.js";
// ── RoundCoordinator ───────────────────────────────────────────────────────
export class RoundCoordinator {
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    /** Process a single round's self-evaluation through the decision pipeline:
     *  verify → enforce → stop decision.
     *
     *  This is the single entry point called by SessionManager.
     *  The caller is responsible for:
     *  - Compiling the next prompt (if action is "continue")
     *  - Managing heartbeat / signal handlers (runtime only)
     *  - Memory injection (both paths, before calling processRound)
     *  - Transactional feedback commit (accepted rounds only)
     *  - State file I/O (both paths, after compiling)
     *
     * @param driftClarificationStreak v2.12: Current clarification streak
     *  from session state. Passed through to enforceRound for R7 escalation. */
    processRound(input, driftClarificationStreak = 0) {
        const { loopId, task, currentRound, maxRounds, selfEval, extractionSucceeded, lastSelfEval, consecutiveRejections, evidenceSnapshots, } = input;
        const roundSuccess = selfEval.success ?? false;
        // ── 1. Query vault entries ──────────────────────────────────────────
        // Lineage entries (constraint violations, output summaries) and feedback
        // entries (execution_evidence, progress estimates) are both needed by
        // the enforcement gate. queryEntries excludes feedback by default, so
        // we issue a second query and merge both result sets.
        const prefix = `loop:${loopId}:r`;
        const vaultEntries = this.backend
            ? [
                ...this.backend.queryEntries({ prefix }),
                ...this.backend.queryEntries({ prefix, feedbackOnly: true }),
            ]
            : [];
        // ── 2. Verification gate ────────────────────────────────────────────
        const verifyResult = verifySelfEvaluation(selfEval, currentRound, vaultEntries, lastSelfEval ?? null, evidenceSnapshots ?? [], input.backtrackSkippedFiles ?? []);
        const verificationFlags = verifyResult.flags;
        const gateContradicted = verifyResult.verdict === "contradicted";
        if (gateContradicted) {
            logEvent("gate_contradicted", {
                loopId,
                round: currentRound,
                flags: verificationFlags.map((f) => f.check),
            });
        }
        // ── 3. Enforcement gate ──────────────────────────────────────────
        // v2.5: heuristic extractions now run partial enforcement. Rules that
        // depend on execution_evidence (R3/R4/R5) self-skip when evidence is
        // missing. Rules that don't need evidence (R1/R2/R6/R7) always run.
        const enforceResult = enforceRound(selfEval, verifyResult, currentRound, vaultEntries, consecutiveRejections, !extractionSucceeded, driftClarificationStreak);
        if (enforceResult.action === "reject") {
            const newRejections = consecutiveRejections + 1;
            const rejectionPrompt = buildRejectionPrompt(currentRound, task, enforceResult, verificationFlags);
            logEvent("enforcement_reject", {
                loopId,
                round: currentRound,
                reason: enforceResult.reason.slice(0, 120),
                check: enforceResult.check ?? "",
                consecutiveRejections: newRejections,
            });
            return {
                action: "reject",
                rejectionPrompt,
                verificationFlags,
                enforcementAction: "reject",
                enforcementReason: enforceResult.reason,
                rejectionCheck: enforceResult.check,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: newRejections,
                // Don't update lastSelfEval on reject — the agent redoes the same round
                newLastSelfEval: undefined,
                shouldPushSuccessTrajectory: false,
            };
        }
        if (enforceResult.action === "terminate") {
            logEvent("session_end", {
                loopId,
                stopReason: "enforcement_terminated",
                round: currentRound,
            });
            return {
                action: "terminate",
                stopReason: "enforcement_terminated",
                verificationFlags,
                enforcementAction: "terminate",
                enforcementReason: enforceResult.reason,
                rejectionCheck: enforceResult.check,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: false,
            };
        }
        // ── v2.10: Backtrack ──────────────────────────────────────────────────
        if (enforceResult.action === "backtrack") {
            const maxDepth = getPolicy().engine.backtrack_max_depth;
            const restorePoint = findSafeRestorePoint(currentRound, vaultEntries, maxDepth);
            if (!restorePoint) {
                // No clean round found within maxDepth — fall through to terminate
                logEvent("session_end", {
                    loopId,
                    stopReason: "enforcement_terminated",
                    round: currentRound,
                });
                return {
                    action: "terminate",
                    stopReason: "enforcement_terminated",
                    verificationFlags,
                    enforcementAction: "terminate",
                    enforcementReason: `${enforceResult.reason} (backtrack failed: no clean restore point within ${maxDepth} rounds)`,
                    rejectionCheck: enforceResult.check,
                    roundSuccess,
                    gateContradicted,
                    newConsecutiveRejections: 0,
                    newLastSelfEval: selfEval,
                    shouldPushSuccessTrajectory: false,
                };
            }
            // v2.13: Collect files changed in skipped rounds for the restore prompt
            const skippedFiles = [];
            for (let r = restorePoint.round + 1; r < currentRound; r++) {
                const entry = vaultEntries.find((e) => entryRound(e) === r);
                if (entry?.execution_evidence) {
                    const ev = entry.execution_evidence;
                    const files = Array.isArray(ev.files_changed)
                        ? ev.files_changed.filter((f) => typeof f === "string")
                        : [];
                    for (const f of files) {
                        if (!skippedFiles.includes(f))
                            skippedFiles.push(f);
                    }
                }
            }
            const backtrackPrompt = buildBacktrackPrompt(currentRound, restorePoint.round, enforceResult.check ?? "progress_stall", getPolicy().engine.backtrack_preserve_discoveries
                ? restorePoint.skippedDiscoveries
                : [], skippedFiles);
            logEvent("enforcement_backtrack", {
                loopId,
                round: currentRound,
                reason: enforceResult.reason.slice(0, 120),
                check: enforceResult.check ?? "",
                backtrackTarget: restorePoint.round,
                skippedDiscoveries: restorePoint.skippedDiscoveries.length,
            });
            return {
                action: "backtrack",
                backtrackPrompt,
                backtrackTarget: restorePoint.round,
                backtrackSkippedDiscoveries: getPolicy().engine.backtrack_preserve_discoveries
                    ? restorePoint.skippedDiscoveries
                    : [],
                backtrackSkippedFiles: skippedFiles,
                backtrackTriggerRule: enforceResult.check,
                verificationFlags,
                enforcementAction: "backtrack",
                enforcementReason: enforceResult.reason,
                rejectionCheck: enforceResult.check,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0, // reset — fresh start
                newLastSelfEval: undefined,
                shouldPushSuccessTrajectory: false,
            };
        }
        // Accept: reset rejection counter
        // (consecutiveRejections reset to 0 — caller persists)
        // ── 4. Auto-feedback (AFTER enforcement, only if accepted) ──────────
        // ── 5. Stop condition checks ────────────────────────────────────────
        // 5a. Extraction failed → stalled
        if (!extractionSucceeded) {
            return {
                action: "stop",
                stopReason: "stalled",
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        // 5b. Agent says stop
        if (!selfEval.should_continue) {
            let reason;
            if (roundSuccess) {
                reason = "completed";
            }
            else if (selfEval.stop_reason === "blocked" || selfEval.stop_reason === "needs_human_input") {
                reason = "blocked";
            }
            else {
                reason = "failed";
            }
            return {
                action: "stop",
                stopReason: reason,
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        // 5c. Max rounds reached
        //
        // NOTE: The binary-success circuit breaker previously at 5c is removed.
        // Genuine agent stalls are now detected by the enforcement gate via
        // enforceProgressStall (R4: delta < 5% → reject → terminate on repeat)
        // and enforceProgressStallTerminal (R5: delta = 0 for N rounds → terminate).
        // These use progress_estimate, not the binary success flag, so they
        // correctly distinguish "task not done yet" from "agent is stuck".
        if (currentRound >= maxRounds) {
            return {
                action: "stop",
                stopReason: "max_rounds",
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        // ── 6. Continue — caller compiles next round ────────────────────────
        return {
            action: "continue",
            verificationFlags,
            enforcementAction: "accept",
            roundSuccess,
            gateContradicted,
            newConsecutiveRejections: 0,
            newLastSelfEval: selfEval,
            shouldPushSuccessTrajectory: !gateContradicted,
            // v2.12: Propagate clarification acceptance signal for streak tracking
            clarificationAccepted: enforceResult.clarification_accepted ?? false,
        };
    }
}
//# sourceMappingURL=round-coordinator.js.map