/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */
import { randomUUID } from "node:crypto";
import { LoopForgeEngine, extractSelfEvaluation } from "../engine.js";
import { checkLoopHealth } from "../loop-compiler.js";
import { getPolicy } from "../policy.js";
import { Mode, makeLoopCompileRequest, makeLoopRoundResult } from "../protocol.js";
import { ReplayBackend } from "../replay.js";
import { FileLoopStore, LoopStoreBackend, VaultBackendLoopStore } from "../loop-store.js";
import { EvidenceCollector } from "../evidence-provider.js";
import { parseRoundTransactionSnapshot, prepareRoundTransaction, } from "../round-transaction.js";
import { RoundDriver } from "../round-driver.js";
import { logEvent } from "../observability.js";
import { policyMetrics } from "../policy-metrics.js";
import { SessionLeaseConflictError, VaultSessionStateStore, } from "../storage.js";
// ── Helpers ────────────────────────────────────────────────────────────────
function buildLoopRequest(session, lastEval, verificationFlags) {
    const req = {
        task: session.task,
        mode: Mode.LOOP_COMPILE,
        feedback: null,
        skill_name: null,
        task_id: null,
        loop_id: session.loopId,
        round: session.currentRound,
        max_rounds: session.maxRounds,
        verification_flags: verificationFlags ?? [],
    };
    if (lastEval) {
        req.last_round_result = makeLoopRoundResult({
            round: session.currentRound - 1,
            success: lastEval.success,
            output_summary: lastEval.output_summary,
            constraint_violations: lastEval.constraint_violations,
            manual_fixes_needed: "",
            // P0–P2: Forward evolution fields to next compile
            // Merge sub-agent discovered constraints into the active set
            discovered_constraints: [
                ...new Set([
                    ...(lastEval.discovered_constraints ?? []),
                    ...(lastEval.worker_results ?? []).flatMap((w) => w.discoveredConstraints ?? []).filter((c) => c.length > 0),
                ]),
            ],
            objective_refinement: lastEval.objective_refinement ?? "",
            emerged_subtasks: lastEval.emerged_subtasks ?? [],
            // P4: Execution evidence
            execution_evidence: lastEval.execution_evidence ?? undefined,
            // P5: Self-correction
            retracted_constraints: lastEval.retracted_constraints ?? [],
            revised_success_criteria: lastEval.revised_success_criteria ?? [],
            wrong_assumptions: lastEval.wrong_assumptions ?? [],
            // Multi-agent: Forward delegation results to next compile
            worker_results: lastEval.worker_results ?? [],
            // v1.10: Checkpoint boundary
            compression_checkpoint: lastEval.compression_checkpoint ?? false,
            checkpoint_label: lastEval.checkpoint_label ?? "",
            // v1.16: Agent's declared next action
            next_action: lastEval.next_action,
            // v2.2: Sub-goal lifecycle
            completed_subtasks: lastEval.completed_subtasks ?? [],
            blocked_subtasks: lastEval.blocked_subtasks ?? [],
            canceled_subtasks: lastEval.canceled_subtasks ?? [],
            // v2.8: Drift clarification
            drift_clarification: lastEval.drift_clarification,
            // v2.9: Model's information needs for the next prompt
            prompt_requests: lastEval.prompt_requests,
        });
    }
    return req;
}
// ── SessionManager ─────────────────────────────────────────────────────────
export class SessionManager {
    sessions = new Map();
    /** Serializes state transitions for each session. */
    sessionQueues = new Map();
    backend;
    sessionStore;
    ownerId = `${process.pid}:${randomUUID()}`;
    leaseMs;
    leaseRenewIntervalMs;
    leaseTimer = null;
    /** Explicit context provider; never auto-discovered. */
    contextProvider;
    terminalSinks = new Set();
    constructor(storeOrBackend, sessionStore) {
        const isLoopStore = (v) => "readSession" in v && typeof v.readSession === "function";
        const store = storeOrBackend
            ? isLoopStore(storeOrBackend)
                ? storeOrBackend
                : new VaultBackendLoopStore(storeOrBackend)
            : new FileLoopStore(getPolicy().backend.root_dir);
        this.backend = storeOrBackend && !isLoopStore(storeOrBackend)
            ? storeOrBackend
            : new LoopStoreBackend(store);
        this.sessionStore = sessionStore ?? new VaultSessionStateStore(store);
        const mcpPolicy = getPolicy().mcp;
        this.leaseMs = Math.max(1, mcpPolicy.session_lease_ms);
        this.leaseRenewIntervalMs = Math.max(1, Math.min(mcpPolicy.session_lease_renew_interval_ms, this.leaseMs));
        if (this.sessionStore?.renewLease) {
            this.leaseTimer = setInterval(() => this.renewOwnedLeases(), this.leaseRenewIntervalMs);
            this.leaseTimer.unref?.();
        }
    }
    /** Stable process-local owner token used for cross-process session leases. */
    getOwnerId() {
        return this.ownerId;
    }
    addTerminalSink(sink) {
        this.terminalSinks.add(sink);
        return () => this.terminalSinks.delete(sink);
    }
    /** Release owned sessions and stop lease maintenance. */
    close() {
        if (this.leaseTimer)
            clearInterval(this.leaseTimer);
        this.leaseTimer = null;
        for (const session of this.sessions.values()) {
            this.sessionStore?.releaseLease?.(session.loopId, this.ownerId);
        }
    }
    findSessionEntry(loopId) {
        return this.sessionStore?.load(loopId);
    }
    claimSessionEntry(loopId) {
        if (this.sessionStore?.acquireLease) {
            return this.sessionStore.acquireLease(loopId, this.ownerId, this.leaseMs);
        }
        return this.findSessionEntry(loopId);
    }
    renewSessionLease(loopId) {
        if (!this.sessionStore?.renewLease)
            return true;
        try {
            return this.sessionStore.renewLease(loopId, this.ownerId, this.leaseMs);
        }
        catch {
            return false;
        }
    }
    renewOwnedLeases() {
        for (const session of this.sessions.values()) {
            if (session.status === "running")
                this.renewSessionLease(session.loopId);
        }
    }
    leaseConflictResult(loopId, entry) {
        const lineage = (entry?.loop_lineage ?? {});
        return {
            sessionId: "",
            round: typeof lineage.current_round === "number" ? lineage.current_round : 0,
            prompt: null,
            stopReason: `session_owned_elsewhere:${loopId}`,
            stopDetail: `Another process (PID ${entry?.loop_lineage ? entry.loop_lineage.lease_owner ?? "unknown" : "unknown"}) holds the lease for loop "${loopId}". Wait for the lease to expire or stop the other process.`,
        };
    }
    async withSessionQueue(sessionId, work) {
        const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        this.sessionQueues.set(sessionId, tail);
        await previous;
        try {
            return await work();
        }
        finally {
            release();
            if (this.sessionQueues.get(sessionId) === tail) {
                this.sessionQueues.delete(sessionId);
            }
        }
    }
    async create(input) {
        const sessionId = randomUUID();
        const loopId = input.loopId ?? randomUUID();
        const engine = new LoopForgeEngine(this.backend);
        const maxRounds = input.maxRounds ?? getPolicy().engine.max_rounds;
        // Populate extra fields for the first round
        const request = buildLoopRequest({
            sessionId, loopId, task: input.task, engine, currentRound: 1,
            maxRounds, successTrajectory: [], status: "running", createdAt: Date.now(),
            consecutiveRejections: 0,
            lastRejectionCheck: "",
            driftClarificationStreak: 0,
            backtrackSkippedFiles: [],
            evidenceBaseline: [],
        });
        request.domain = input.domain ?? "";
        request.plan_source = input.planSource ?? null;
        request.constraints_from_plan = input.constraints ?? [];
        // Explicit context is requested by the MCP embedding; no auto-discovery.
        if (this.contextProvider) {
            try {
                const ctx = {
                    loopId,
                    round: 1,
                    task: input.task,
                    domain: input.domain ?? "",
                };
                const rawContext = await this.contextProvider(ctx);
                if (rawContext?.trim()) {
                    request.external_context = rawContext.trim();
                    logEvent("external_context_loaded", {
                        loopId, round: 1,
                        contextLength: request.external_context.length,
                    });
                }
            }
            catch {
                // Provider failures are isolated from session creation.
                logEvent("context_provider_error", { loopId, round: 1 });
            }
        }
        const prepared = await new RoundDriver(engine, this.backend).prepare(request, loopId, 1);
        const initialPrompt = prepared?.prompt ?? null;
        const initialLevel = prepared?.level ?? "l2";
        const evidenceBaseline = prepared?.evidenceBaseline ?? [];
        const session = {
            sessionId, loopId, task: input.task, engine,
            currentRound: 1, maxRounds, successTrajectory: [],
            status: "running", createdAt: Date.now(),
            // v1.13: Enforcement gate state
            consecutiveRejections: 0,
            lastRejectionCheck: "",
            driftClarificationStreak: 0,
            backtrackSkippedFiles: [],
            evidenceBaseline,
            roundSnapshot: prepared?.snapshot ?? prepareRoundTransaction(loopId, 1, evidenceBaseline),
            currentPrompt: initialPrompt,
            currentLevel: initialLevel,
            currentWarnings: prepared?.warnings ?? [],
        };
        this.sessions.set(sessionId, session);
        policyMetrics.recordStrategy(loopId, initialLevel);
        // Persist to vault for cross-process recovery
        this.save(session);
        logEvent("session_start", {
            sessionId,
            loopId,
            task: input.task.slice(0, 80),
            maxRounds,
        });
        return {
            sessionId,
            round: 1,
            roundId: session.roundSnapshot?.roundId,
            prompt: initialPrompt,
            level: initialLevel,
            roundSuccess: false,
            warnings: prepared?.warnings ?? [],
        };
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    getLeaseStatus(loopId) {
        const entry = this.findSessionEntry(loopId);
        if (!entry)
            return null;
        const lineage = (entry.loop_lineage ?? {});
        const owner = typeof lineage.lease_owner === "string"
            ? lineage.lease_owner
            : "";
        const ownerPid = owner.match(/^(\d+):/)?.[1];
        return {
            ownedByThisProcess: owner === this.ownerId,
            ownerPid: ownerPid ? Number(ownerPid) : null,
            expiresAt: typeof lineage.lease_expires_at === "number"
                ? new Date(lineage.lease_expires_at).toISOString()
                : null,
            epoch: typeof lineage.lease_epoch === "number"
                ? lineage.lease_epoch
                : 0,
        };
    }
    delete(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        session.status = "stopped";
        this.save(session);
        void this.notifyTerminal(session, "cancelled");
        this.sessions.delete(sessionId);
        this.sessionQueues.delete(sessionId);
        logEvent("session_end", {
            sessionId,
            loopId: session.loopId,
            stopReason: "cancelled",
            roundsCompleted: session.currentRound,
        });
        return true;
    }
    /** v1.18: Pause a running session. The session state is persisted to
     *  vault so it survives process restarts. Returns the session status.
     *  Paused sessions cannot be advanced — they must be resumed first. */
    pause(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return { sessionId, round: 0, status: "not_found" };
        if (session.status !== "running") {
            return { sessionId, round: session.currentRound, status: session.status };
        }
        session.status = "paused";
        this.save(session);
        logEvent("session_paused", {
            sessionId,
            loopId: session.loopId,
            round: session.currentRound,
        });
        return { sessionId, round: session.currentRound, status: "paused" };
    }
    restoredPromptResult(session) {
        if (!session.currentPrompt)
            return null;
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: session.currentPrompt,
            level: session.currentLevel ?? "l2",
            roundSuccess: undefined,
            warnings: (session.currentWarnings ?? []),
        };
    }
    /** Reconcile the crash window where feedback committed but session_state
     *  still points at the old prompt. Returns null when no commit is pending. */
    reconcileCommittedRound(session) {
        if (!session.roundSnapshot)
            return null;
        const recovered = new RoundDriver(session.engine, this.backend).recover(session.roundSnapshot);
        if (!recovered)
            return null;
        const pr = recovered.result;
        session.roundSnapshot = recovered.snapshot;
        // Replay the committed counter — but with per-rule tracking.
        if (pr.action === "reject" && pr.rejectionCheck) {
            session.consecutiveRejections =
                pr.rejectionCheck === session.lastRejectionCheck
                    ? pr.newConsecutiveRejections
                    : 1;
            session.lastRejectionCheck = pr.rejectionCheck;
        }
        else {
            session.consecutiveRejections = pr.newConsecutiveRejections;
            if (pr.action !== "reject")
                session.lastRejectionCheck = "";
        }
        if (pr.newLastSelfEval)
            session.lastSelfEval = pr.newLastSelfEval;
        if (pr.shouldPushSuccessTrajectory &&
            session.successTrajectory.length < session.currentRound) {
            session.successTrajectory.push(pr.roundSuccess);
        }
        session.currentPrompt = null;
        if (pr.action === "stop" || pr.action === "terminate") {
            const reason = pr.action === "terminate"
                ? "enforcement_terminated"
                : pr.stopReason ?? "stalled";
            session.status = reason === "stalled" ? "stalled" : "stopped";
            this.save(session);
            void this.notifyTerminal(session, reason);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                roundId: recovered.snapshot.roundId,
                prompt: null,
                stopReason: reason,
                stopDetail: reason === "completed"
                    ? "Task completed successfully — the agent declared should_continue=false with success=true."
                    : reason === "blocked"
                        ? "Agent cannot proceed under current constraints. The task may need revised constraints or human intervention."
                        : reason === "failed"
                            ? "Agent declared should_continue=false with success=false — the task was not achieved."
                            : `Loop stopped: ${reason}.`,
                roundSuccess: pr.roundSuccess,
            };
        }
        if (pr.action === "backtrack") {
            // Backtrack committed but prompt not delivered (crash window).
            // Reset round counter to the restore target + 1 so the next
            // resume / unpause compiles from the correct restored state.
            const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
            session.currentRound = restoreTarget + 1;
            session.consecutiveRejections = 0;
            session.lastRejectionCheck = "";
            session.driftClarificationStreak = 0;
            session.lastSelfEval = undefined;
            session.currentPrompt = null;
            this.save(session);
            // Return null — caller (resume/unpause) will recompile normally
            return null;
        }
        if (pr.action !== "continue")
            return null;
        session.currentRound++;
        const request = buildLoopRequest(session, pr.newLastSelfEval, pr.verificationFlags);
        const prepared = new RoundDriver(session.engine, this.backend).prepareSync(request, session.loopId, session.currentRound);
        if (!prepared) {
            session.status = "stalled";
            this.save(session);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "RoundDriver.prepareSync returned null — prompt compilation failed during crash recovery. The session state may be inconsistent.",
            };
        }
        const prompt = prepared.prompt;
        session.evidenceBaseline = prepared.evidenceBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = prompt;
        session.currentLevel = prepared.level;
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, session.currentLevel);
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt,
            level: session.currentLevel,
            roundSuccess: pr.roundSuccess,
            warnings: (session.currentWarnings ?? []),
        };
    }
    /** v1.18: Resume a paused session. Reconstructs from vault state and
     *  compiles the next prompt. Returns null if no paused session exists
     *  for this loopId. */
    async unpause(loopId) {
        const persistedEntry = this.findSessionEntry(loopId);
        if (!persistedEntry)
            return null;
        const lineage = (persistedEntry.loop_lineage ?? {});
        const status = lineage.status ?? "running";
        if (status !== "paused")
            return null;
        const sessionEntry = this.claimSessionEntry(loopId);
        if (!sessionEntry)
            return this.leaseConflictResult(loopId, persistedEntry);
        const session = this.reconstructSession(sessionEntry, true);
        if (!session)
            return null;
        // Set to running so advance() works
        session.status = "running";
        this.sessions.set(session.sessionId, session);
        // Replace the sync-fallback evidence baseline with async evidence
        // so resumed sessions don't silently drop async provider data.
        try {
            const asyncEvidence = await EvidenceCollector.fromPolicy().collectAsync({
                loopId: session.loopId,
                phase: "before",
            });
            if (asyncEvidence.length > 0) {
                session.evidenceBaseline = asyncEvidence;
                if (!session.roundSnapshot?.beforeEvidence?.length) {
                    session.roundSnapshot = prepareRoundTransaction(session.loopId, session.currentRound, asyncEvidence);
                }
            }
        }
        catch {
            // Async evidence is best-effort; fall back to sync baseline.
        }
        const reconciled = this.reconcileCommittedRound(session);
        if (reconciled)
            return reconciled;
        const restored = this.restoredPromptResult(session);
        if (restored) {
            this.save(session);
            return restored;
        }
        // Compile the next prompt from the current round state
        const lcr = makeLoopCompileRequest({
            loop_id: session.loopId,
            round: session.currentRound,
            goal_id: "",
            task: session.task,
            domain: undefined,
            plan_source: null,
            constraints_from_plan: [],
            health_check_interval: 1,
        });
        const compileRequest = {
            task: session.task,
            mode: Mode.LOOP_COMPILE,
            feedback: null,
            skill_name: null,
            task_id: null,
            loop_id: lcr.loop_id,
            round: lcr.round,
            goal_id: lcr.goal_id,
            domain: lcr.domain ?? "",
            plan_source: lcr.plan_source ?? null,
            constraints_from_plan: lcr.constraints_from_plan ?? [],
            health_check_interval: lcr.health_check_interval,
            max_rounds: session.maxRounds,
        };
        const prepared = await new RoundDriver(session.engine, this.backend).prepare(compileRequest, session.loopId, session.currentRound);
        if (!prepared) {
            session.status = "stopped";
            this.save(session);
            void this.notifyTerminal(session, "stalled");
            return { sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "RoundDriver.prepare returned null during unpause — the compiler could not produce a prompt." };
        }
        const prompt = prepared.prompt;
        const level = prepared.level;
        session.evidenceBaseline = prepared.evidenceBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = prompt;
        session.currentLevel = level;
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, level);
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt,
            level,
            roundSuccess: undefined,
            warnings: [],
        };
    }
    /** Persist session state to vault for cross-process recovery.
     *  The filtered vault and replacement entry are written once under the
     *  backend lock, so recovery never observes the old two-write gap. */
    save(session) {
        if (!this.sessionStore)
            return;
        const leaseActive = session.status === "running";
        const sessionEntry = {
            task_id: `loop:${session.loopId}:session`,
            task_type: "session_state",
            timestamp: new Date().toISOString(),
            loop_id: session.loopId,
            task: session.task,
            loop_lineage: {
                session_id: session.sessionId,
                current_round: session.currentRound,
                max_rounds: session.maxRounds,
                success_trajectory: session.successTrajectory,
                status: session.status,
                created_at: session.createdAt,
                // v1.13: Enforcement gate state
                consecutive_rejections: session.consecutiveRejections,
                last_rejection_check: session.lastRejectionCheck,
                // v2.12: Clarification streak
                drift_clarification_streak: session.driftClarificationStreak,
                // v2.13: Backtrack skipped files for workspace restore check
                backtrack_skipped_files: session.backtrackSkippedFiles,
                // v1.19: durable round transaction state
                round_snapshot: session.roundSnapshot ?? null,
                last_self_eval: session.lastSelfEval ?? null,
                current_prompt: session.currentPrompt ?? null,
                current_level: session.currentLevel ?? "",
                // v1.20: cross-process single-owner lease
                lease_owner: leaseActive ? this.ownerId : "",
                lease_expires_at: leaseActive ? Date.now() + this.leaseMs : 0,
            },
        };
        this.sessionStore.save(sessionEntry, {
            expectedLeaseOwner: this.ownerId,
        });
    }
    /** Reconstruct a McpSession from a vault session_state entry.
     *  Returns null if the entry is not "running" status.
     *  Shared by resume() and autoResumeAll(). */
    reconstructSession(entry, allowPaused = false) {
        const lineage = (entry.loop_lineage ?? {});
        const status = lineage.status ?? "running";
        if (status !== "running" && !(allowPaused && status === "paused")) {
            return null;
        }
        const loopId = entry.loop_id;
        const currentRound = lineage.current_round ?? 1;
        const successTrajectory = lineage.success_trajectory ?? lineage.quality_trajectory ?? [];
        const task = entry.task ?? "";
        const maxRounds = lineage.max_rounds ?? getPolicy().engine.max_rounds;
        const roundSnapshot = parseRoundTransactionSnapshot(lineage.round_snapshot);
        const fallbackEvidence = EvidenceCollector.fromProviderNames(getPolicy().evidence.providers).collect();
        const persistedEval = lineage.last_self_eval;
        const lastSelfEval = persistedEval !== null &&
            typeof persistedEval === "object" &&
            !Array.isArray(persistedEval) &&
            typeof persistedEval.success === "boolean" &&
            typeof persistedEval.output_summary === "string"
            ? persistedEval
            : undefined;
        const engine = new LoopForgeEngine(this.backend);
        return {
            sessionId: typeof lineage.session_id === "string" && lineage.session_id
                ? lineage.session_id
                : randomUUID(),
            loopId, task, engine,
            currentRound, maxRounds, successTrajectory,
            status: status,
            createdAt: lineage.created_at ?? Date.now(),
            consecutiveRejections: lineage.consecutive_rejections ?? 0,
            lastRejectionCheck: typeof lineage.last_rejection_check === "string"
                ? lineage.last_rejection_check
                : "",
            driftClarificationStreak: lineage.drift_clarification_streak ?? 0,
            backtrackSkippedFiles: lineage.backtrack_skipped_files ?? [],
            evidenceBaseline: roundSnapshot?.beforeEvidence ?? fallbackEvidence,
            roundSnapshot: roundSnapshot ?? prepareRoundTransaction(loopId, currentRound, fallbackEvidence),
            lastSelfEval,
            currentPrompt: typeof lineage.current_prompt === "string"
                ? lineage.current_prompt
                : null,
            currentLevel: typeof lineage.current_level === "string"
                ? lineage.current_level
                : undefined,
        };
    }
    /** Resume a loop from vault state.
     *  Reconstructs the session and compiles the prompt for the next round.
     *  Returns null if no session_state entry exists for this loopId. */
    resume(loopId) {
        const persistedEntry = this.findSessionEntry(loopId);
        if (!persistedEntry)
            return null;
        const persistedLineage = (persistedEntry.loop_lineage ?? {});
        const persistedStatus = persistedLineage.status ?? "running";
        const sessionEntry = persistedStatus === "running"
            ? this.claimSessionEntry(loopId)
            : persistedEntry;
        if (!sessionEntry)
            return this.leaseConflictResult(loopId, persistedEntry);
        const session = this.reconstructSession(sessionEntry);
        if (!session) {
            // was not "running" — return stopped/stalled status
            const lineage = (sessionEntry.loop_lineage ?? {});
            const currentRound = lineage.current_round ?? 1;
            const status = lineage.status ?? "stopped";
            return {
                sessionId: "",
                round: currentRound,
                prompt: null,
                stopReason: status,
                stopDetail: `Loop is not running (status: ${status}). It may have already completed or been stopped.`,
            };
        }
        this.sessions.set(session.sessionId, session);
        const reconciled = this.reconcileCommittedRound(session);
        if (reconciled)
            return reconciled;
        const restored = this.restoredPromptResult(session);
        if (restored)
            return restored;
        // Legacy session without a stored prompt: compile once, then persist it.
        const request = buildLoopRequest(session);
        const prepared = new RoundDriver(session.engine, this.backend).prepareSync(request, session.loopId, session.currentRound);
        const prompt = prepared?.prompt ?? null;
        session.evidenceBaseline = prepared?.evidenceBaseline ?? [];
        session.roundSnapshot = prepared?.snapshot ?? prepareRoundTransaction(session.loopId, session.currentRound, []);
        session.currentPrompt = prompt;
        session.currentLevel = prepared?.level ?? "l2";
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, session.currentLevel);
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt,
            level: session.currentLevel,
            roundSuccess: false,
            warnings: (session.currentWarnings ?? []),
        };
    }
    /** Auto-resume all "running" sessions from vault on server startup.
     *  Scans vault for session_state entries, reconstructs each as an in-memory
     *  McpSession (without compiling — the next loopforge_next will do that).
     *  Returns the number of sessions resumed. */
    autoResumeAll() {
        if (!this.sessionStore)
            return 0;
        const entries = this.sessionStore.list();
        // Build set of already-active loopIds
        const activeLoopIds = new Set();
        for (const s of this.sessions.values()) {
            activeLoopIds.add(s.loopId);
        }
        let count = 0;
        for (const entry of entries) {
            if (entry.task_type !== "session_state")
                continue;
            const lid = entry.loop_id;
            if (!lid || activeLoopIds.has(lid))
                continue;
            const lineage = (entry.loop_lineage ?? {});
            const status = lineage.status ?? "running";
            if (status !== "running" && status !== "paused")
                continue;
            const claimedEntry = this.claimSessionEntry(lid);
            if (!claimedEntry)
                continue;
            const session = this.reconstructSession(claimedEntry, true);
            if (session) {
                this.sessions.set(session.sessionId, session);
                activeLoopIds.add(lid);
                count++;
            }
        }
        return count;
    }
    list() {
        const seen = new Set();
        const result = [];
        // In-memory sessions first (take priority)
        for (const s of this.sessions.values()) {
            seen.add(s.loopId);
            result.push({
                sessionId: s.sessionId,
                loopId: s.loopId,
                round: s.currentRound,
                status: s.status,
            });
        }
        // Merge persisted sessions not already in memory
        if (this.sessionStore) {
            const entries = this.sessionStore.list();
            for (const e of entries) {
                if (e.task_type !== "session_state")
                    continue;
                const lid = e.loop_id ?? "";
                if (!lid || seen.has(lid))
                    continue;
                seen.add(lid);
                const lineage = (e.loop_lineage ?? {});
                result.push({
                    sessionId: "",
                    loopId: lid,
                    round: lineage.current_round ?? 1,
                    status: (lineage.status || "running"),
                });
            }
        }
        return result;
    }
    /** Get loop health for a loop (in-memory or vault).
     *  Computes goal alignment, constraint integrity, drift, strategy stability. */
    getHealth(loopId) {
        // Find the task — check in-memory sessions first, then vault
        let task = "";
        let goalId = loopId;
        for (const s of this.sessions.values()) {
            if (s.loopId === loopId) {
                task = s.task;
                if (s.engine.state?.task_id) {
                    goalId = s.engine.state.task_id;
                }
                break;
            }
        }
        // Fall back to vault for task
        if (!task) {
            const sessionEntry = this.findSessionEntry(loopId);
            if (sessionEntry) {
                task = sessionEntry.task ?? "";
            }
        }
        if (!task)
            return null;
        // Hydrate vault context
        const engine = new LoopForgeEngine(this.backend);
        const vaultContext = engine.hydrateLoopContext(loopId);
        // Build a minimal request for health check
        const request = makeLoopCompileRequest({
            task,
            loop_id: loopId,
            goal_id: goalId,
            round: 1, // round doesn't matter for health check
        });
        const health = checkLoopHealth(loopId, request, vaultContext);
        return {
            loopId,
            goal_alignment: health.goal_alignment,
            constraint_integrity: health.constraint_integrity,
            drift_detected: health.drift_detected,
            strategy_stability: health.strategy_stability,
            task_continuity: health.task_continuity,
            policy_metrics: policyMetrics.snapshot(loopId),
        };
    }
    /** Core cycle: extract self-eval → record feedback → check stop → compile next.
     *  @param preExtractedEval Optional pre-built SelfEvaluation from MCP tool parameter.
     *    When provided (MCP path with evaluation parameter), skips regex extraction.
     *    When undefined (runtime/CLI path), falls back to regex extraction from output. */
    async advance(sessionId, output, preExtractedEval) {
        return this.withSessionQueue(sessionId, async () => {
            const session = this.sessions.get(sessionId);
            if (session?.status === "running" &&
                !this.renewSessionLease(session.loopId)) {
                return this.leaseConflictResult(session.loopId, this.findSessionEntry(session.loopId));
            }
            try {
                return await this.advanceUnlocked(sessionId, output, preExtractedEval);
            }
            catch (error) {
                if (error instanceof SessionLeaseConflictError) {
                    return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
                }
                throw error;
            }
        });
    }
    // ── advanceUnlocked pipeline ───────────────────────────────────────────
    //
    // The method is split into focused private helpers so each phase of the
    // round-boundary decision loop is independently readable and testable.
    //
    // Pipeline: validate → extract → execute transaction → route disposition
    //           → advance to next round (continue) or return terminal result.
    /** Extract a SelfEvaluation from agent output.
     *  Structured param preferred → regex extraction → heuristic fallback.
     *  Returns null only when both regex and heuristic returned null. */
    extractEvaluation(output, preExtractedEval) {
        if (preExtractedEval) {
            return { selfEval: preExtractedEval, extractionFailed: false };
        }
        const structured = extractSelfEvaluation(output);
        if (!structured)
            return null;
        return { selfEval: structured, extractionFailed: false };
    }
    /** Execute the round transaction and apply per-rule rejection tracking.
     *  MUTATES: session.roundSnapshot, session.consecutiveRejections,
     *           session.lastRejectionCheck, session.lastSelfEval,
     *           session.successTrajectory, session.driftClarificationStreak */
    async executeRoundTransaction(session, selfEval, extractionFailed) {
        const snapshot = session.roundSnapshot ?? prepareRoundTransaction(session.loopId, session.currentRound, session.evidenceBaseline ?? []);
        const completed = await new RoundDriver(session.engine, this.backend).complete({
            snapshot,
            loopId: session.loopId,
            task: session.task,
            maxRounds: session.maxRounds,
            selfEval,
            extractionSucceeded: !extractionFailed,
            lastSelfEval: session.lastSelfEval,
            consecutiveRejections: session.consecutiveRejections,
            successTrajectory: session.successTrajectory,
            driftClarificationStreak: session.driftClarificationStreak,
            backtrackSkippedFiles: session.backtrackSkippedFiles,
        });
        const outcome = completed.outcome;
        const actualEvidence = completed.actualEvidence;
        session.roundSnapshot = outcome.snapshot;
        const pr = outcome.result;
        policyMetrics.recordStrategyOutcome(session.loopId, session.currentLevel, pr, outcome.replayed);
        // v2.12: Clarification streak tracking — independent of rejection tracking.
        // Reset on rounds without intent_drift; track substantive vs weak clarifications.
        this.updateClarificationStreak(session, pr);
        // Per-rule rejection tracking: same-check rejections accumulate;
        // a different rejection reason resets the counter.
        if (pr.action === "reject" && pr.rejectionCheck) {
            session.consecutiveRejections =
                pr.rejectionCheck === session.lastRejectionCheck
                    ? pr.newConsecutiveRejections
                    : 1;
            session.lastRejectionCheck = pr.rejectionCheck;
        }
        else {
            session.consecutiveRejections = pr.newConsecutiveRejections;
            if (pr.action !== "reject")
                session.lastRejectionCheck = "";
        }
        if (pr.newLastSelfEval)
            session.lastSelfEval = pr.newLastSelfEval;
        if (pr.shouldPushSuccessTrajectory) {
            session.successTrajectory.push(pr.roundSuccess);
        }
        return { pr, verificationFlags: pr.verificationFlags, actualEvidence };
    }
    /** v2.12: Update the clarification streak based on the round result.
     *  - Substantive clarification (anchors present): keep streak — genuine pivot.
     *  - No intent_drift this round: reset streak to 0.
     *  - Weak clarification rejected by R7: streak was already consumed by
     *    enforceIntentDrift to decide reject vs terminate; staleness is handled
     *    on the enforcement side. We sync the persisted counter for crash recovery.
     *  MUTATES: session.driftClarificationStreak */
    updateClarificationStreak(session, pr) {
        const hasIntentDrift = pr.verificationFlags.some((f) => f.check === "intent_drift");
        if (!hasIntentDrift) {
            // No drift this round — reset streak
            session.driftClarificationStreak = 0;
            return;
        }
        // v2.12: Clarification accepted with anchors → substantive pivot.
        // Keep streak as-is (don't increment for genuine explanations).
        if (pr.clarificationAccepted) {
            return;
        }
        // R7 rejected (weak or no clarification). The enforcement gate
        // already used the streak to decide reject vs terminate.
        // Increment the persisted counter so crash recovery sees it.
        session.driftClarificationStreak += 1;
    }
    /** Build a rejection result: compile a retry prompt, persist, return.
     *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
    async buildRejectionResult(sessionId, session, pr, verificationFlags) {
        const retryRequest = buildLoopRequest(session, undefined, verificationFlags);
        const preparedRetry = await new RoundDriver(session.engine, this.backend).prepareRetry(retryRequest, session.roundSnapshot, pr.rejectionPrompt ?? "", session.consecutiveRejections);
        if (!preparedRetry) {
            session.status = "stalled";
            session.currentPrompt = null;
            this.save(session);
            return {
                sessionId,
                round: session.currentRound,
                roundId: session.roundSnapshot?.roundId,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "RoundDriver.prepareRetry returned null — the retry prompt could not be compiled.",
            };
        }
        session.roundSnapshot = preparedRetry.snapshot;
        session.currentPrompt = preparedRetry.prompt;
        session.currentLevel = preparedRetry.level;
        session.currentWarnings = preparedRetry.warnings ?? [];
        this.save(session);
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt: preparedRetry.prompt,
            level: preparedRetry.level,
            enforcementAction: "reject",
            enforcementReason: pr.enforcementReason,
        };
    }
    /** v2.10: Build a backtrack result — roll back to last clean round.
     *  Resets the round counter to the restore target + 1, merges preserved
     *  discoveries, compiles from the restored state, and injects the
     *  backtrack prompt at the top.
     *  MUTATES: session.currentRound, session.roundSnapshot,
     *           session.currentPrompt, session.currentLevel,
     *           session.consecutiveRejections, session.lastSelfEval */
    async buildBacktrackResult(sessionId, session, pr) {
        const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
        const newRound = restoreTarget + 1;
        logEvent("session_backtrack", {
            sessionId,
            loopId: session.loopId,
            fromRound: session.currentRound,
            toRound: newRound,
            triggerRule: pr.backtrackTriggerRule ?? "",
            skippedDiscoveries: (pr.backtrackSkippedDiscoveries ?? []).length,
        });
        // Reset session to the restored round
        session.currentRound = newRound;
        session.consecutiveRejections = 0;
        session.lastRejectionCheck = "";
        session.driftClarificationStreak = 0;
        session.backtrackSkippedFiles = pr.backtrackSkippedFiles ?? [];
        session.lastSelfEval = undefined; // force L2 recompile from vault state
        session.currentPrompt = null;
        // Preserve discoveries from skipped rounds as constraints_from_plan
        // so they survive the compilation and re-enter active constraints.
        const preservedDiscoveries = pr.backtrackSkippedDiscoveries ?? [];
        // Compile the restored prompt — use a fresh request with the restored round
        const request = {
            task: session.task,
            mode: Mode.LOOP_COMPILE,
            feedback: null,
            skill_name: null,
            task_id: null,
            loop_id: session.loopId,
            round: newRound,
            max_rounds: session.maxRounds,
            verification_flags: pr.verificationFlags,
            constraints_from_plan: preservedDiscoveries,
        };
        const prepared = await new RoundDriver(session.engine, this.backend).prepare(request, session.loopId, newRound);
        if (!prepared || !prepared.prompt) {
            session.status = "stalled";
            session.currentPrompt = null;
            this.save(session);
            return {
                sessionId,
                round: newRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "Backtrack failed: RoundDriver.prepare returned null — could not compile from restore point.",
                enforcementAction: "backtrack",
                enforcementReason: pr.enforcementReason,
            };
        }
        // Inject backtrack prompt at the top of the compiled prompt
        const backtrackHeader = pr.backtrackPrompt ?? "";
        const fullPrompt = backtrackHeader
            ? backtrackHeader + "\n" + (prepared.prompt ?? "")
            : prepared.prompt ?? "";
        session.evidenceBaseline = prepared.evidenceBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = fullPrompt;
        session.currentLevel = prepared.level;
        session.currentWarnings = prepared?.warnings ?? [];
        this.save(session);
        return {
            sessionId,
            round: newRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: fullPrompt,
            level: prepared.level,
            enforcementAction: "backtrack",
            enforcementReason: pr.enforcementReason,
            warnings: prepared?.warnings ?? [],
        };
    }
    /** Build a termination result: persist stopped status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    buildTerminationResult(sessionId, session, pr) {
        session.status = "stopped";
        session.currentPrompt = null;
        this.save(session);
        void this.notifyTerminal(session, "enforcement_terminated");
        logEvent("session_end", {
            sessionId, loopId: session.loopId,
            stopReason: "enforcement_terminated", round: session.currentRound,
        });
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: null,
            stopReason: "enforcement_terminated",
            stopDetail: pr.enforcementReason ?? "The enforcement gate terminated the loop.",
            enforcementAction: "terminate",
            enforcementReason: pr.enforcementReason,
        };
    }
    /** Build a stop result: persist stopped/stalled status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    buildStopResult(sessionId, session, pr) {
        const reason = pr.stopReason ?? "stalled";
        session.status = reason === "stalled" ? "stalled" : "stopped";
        session.currentPrompt = null;
        this.save(session);
        void this.notifyTerminal(session, reason);
        logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: reason, round: session.currentRound });
        return {
            sessionId, round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: null, stopReason: reason,
            stopDetail: pr.stopReason === "circuit_breaker"
                ? `${pr.roundSuccess ? "No" : "All"} recent rounds failed, triggering the circuit breaker.`
                : pr.stopReason === "max_rounds"
                    ? "The configured maximum number of rounds has been reached."
                    : `Loop stopped: ${reason}.`,
            roundSuccess: pr.roundSuccess,
        };
    }
    /** Compile the next round's prompt and advance the session.
     *  Includes the commit fence (pause/delete race guard) and context provider.
     *  MUTATES: session.currentRound, session.currentPrompt, session.currentLevel,
     *           session.evidenceBaseline, session.roundSnapshot */
    async advanceToNextRound(sessionId, session, selfEval, pr, verificationFlags, actualEvidence) {
        const roundSuccess = pr.roundSuccess;
        session.currentRound++;
        session.currentPrompt = null;
        // v2.13: Clear backtrack skipped files after advancing past the restore round
        session.backtrackSkippedFiles = [];
        // v1.8: Memory injection — tier-aware external context.
        let externalCtx = "";
        if (this.contextProvider) {
            try {
                externalCtx = (await this.contextProvider({
                    loopId: session.loopId,
                    round: session.currentRound,
                    task: session.task,
                    domain: "",
                    lastEvaluation: selfEval,
                })).trim();
            }
            catch {
                logEvent("context_provider_error", {
                    loopId: session.loopId,
                    round: session.currentRound,
                });
            }
        }
        // Commit fence: pause()/delete() may have run while the context provider
        // was awaited. Do not compile if the session is no longer running.
        if (this.sessions.get(sessionId) !== session || session.status !== "running") {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: session.status,
                stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the context provider was running.`,
                roundSuccess,
            };
        }
        const request = buildLoopRequest(session, selfEval, verificationFlags);
        if (externalCtx) {
            request.external_context = externalCtx;
        }
        const prepared = await new RoundDriver(session.engine, this.backend).prepare(request, session.loopId, session.currentRound);
        const nextPrompt = prepared?.prompt ?? null;
        const nextLevel = prepared?.level ?? "l2";
        const nextBaseline = prepared?.evidenceBaseline ?? actualEvidence;
        session.evidenceBaseline = nextBaseline;
        session.roundSnapshot = prepared?.snapshot ?? prepareRoundTransaction(session.loopId, session.currentRound, nextBaseline);
        session.currentPrompt = nextPrompt;
        session.currentLevel = nextLevel;
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, nextLevel);
        this.save(session);
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt: nextPrompt,
            level: nextLevel,
            roundSuccess,
            warnings: prepared?.warnings ?? [],
        };
    }
    async advanceUnlocked(sessionId, output, preExtractedEval) {
        // ── 1. Validate session ──────────────────────────────────────────────
        const session = this.sessions.get(sessionId);
        if (!session)
            return { sessionId, round: 0, prompt: null, stopReason: "session_not_found", stopDetail: "No session exists with this ID. It may have expired, been deleted, or never existed." };
        if (session.status !== "running") {
            return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status, stopDetail: `Session is ${session.status}. Use loopforge_resume to restart a paused session, or loopforge_start for a new task.` };
        }
        // ── 2. Extract self-evaluation ───────────────────────────────────────
        const extracted = this.extractEvaluation(output, preExtractedEval);
        if (!extracted) {
            session.status = "stalled";
            this.save(session);
            void this.notifyTerminal(session, "stalled");
            logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "stalled", round: session.currentRound });
            return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "Self-evaluation could not be extracted from agent output. Both structured regex and heuristic fallback returned null.", roundSuccess: false };
        }
        const { selfEval, extractionFailed } = extracted;
        // ── 3. Execute round transaction ─────────────────────────────────────
        const tx = await this.executeRoundTransaction(session, selfEval, extractionFailed);
        // ── 4. Route disposition ─────────────────────────────────────────────
        if (tx.pr.action === "reject") {
            return this.buildRejectionResult(sessionId, session, tx.pr, tx.verificationFlags);
        }
        // ── v2.10: Backtrack — roll back to last clean round ──────────────────
        if (tx.pr.action === "backtrack") {
            return this.buildBacktrackResult(sessionId, session, tx.pr);
        }
        // Accepted rounds advance the before-snapshot baseline. Rejected rounds
        // retain the original baseline so their retry remains zero-commit.
        session.evidenceBaseline = tx.actualEvidence;
        if (tx.pr.action === "terminate") {
            return this.buildTerminationResult(sessionId, session, tx.pr);
        }
        if (tx.pr.action === "stop") {
            return this.buildStopResult(sessionId, session, tx.pr);
        }
        // ── 5. Continue — compile next round ─────────────────────────────────
        return this.advanceToNextRound(sessionId, session, selfEval, tx.pr, tx.verificationFlags, tx.actualEvidence);
    }
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    async notifyTerminal(session, stopReason) {
        if (this.terminalSinks.size === 0)
            return;
        const event = {
            loopId: session.loopId,
            task: session.task,
            success: stopReason === "completed",
            stopReason: stopReason,
            roundsCompleted: session.currentRound,
            successTrajectory: [...session.successTrajectory],
            lastEvaluation: session.lastSelfEval,
        };
        await Promise.allSettled([...this.terminalSinks].map((sink) => Promise.resolve(sink(event))));
    }
    /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
    replayTimeline(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        const replay = new ReplayBackend(this.backend);
        return replay.timeline(session.loopId);
    }
}
//# sourceMappingURL=session.js.map