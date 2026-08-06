/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import type { ConstraintMeta, LoopCompileRequest, LoopCompileResponse, MilestoneSummary, SubGoal, VerificationFlag } from "./protocol.js";
export declare const CANONICAL_STATE_SCHEMA_VERSION: 1;
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
    checkpoints: Array<{
        label: string;
        declared_at_round: number;
        outcome: string;
        carried_constraints: string[];
        resolved_constraints: string[];
    }>;
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
        tests: {
            passed: number;
            failed: number;
            skipped: number;
        } | null;
    };
}
/** Deterministic JSON serialization used by state and prompt hashes. */
export declare function stableStringify(value: unknown): string;
export declare function hashCanonicalState(state: CanonicalLoopState): string;
/** Human/Agent-readable materialized view. It is always reproducible from the
 * canonical state and is never consulted as transaction truth. */
export declare function renderCanonicalStateMarkdown(state: CanonicalLoopState): string;
export declare function createCanonicalLoopState(request: LoopCompileRequest, response: LoopCompileResponse, stateFilePath: string): CanonicalLoopState;
//# sourceMappingURL=canonical-state.d.ts.map