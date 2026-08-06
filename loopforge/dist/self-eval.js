/** Self-evaluation extraction and parsing — pure functions.
 *
 * These functions parse an Agent's raw output into a structured
 * SelfEvaluation. They have no dependency on Engine state, file I/O,
 * or external services. They are shared by both the MCP tool handler
 * (which receives structured JSON directly) and the legacy invoke
 * path (which regex-scans free-text Agent output).
 */
import { makeExecutionEvidence, makeSelfEvaluation, SELF_EVAL_REGEX, } from "./protocol.js";
// ── Raw parsing helpers ───────────────────────────────────────────────────
/** Parse ExecutionEvidence from a raw JSON object. */
export function parseExecutionEvidence(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const testResults = raw.test_results;
    return makeExecutionEvidence({
        files_changed: Array.isArray(raw.files_changed)
            ? raw.files_changed.filter((v) => typeof v === "string")
            : [],
        test_results: testResults && typeof testResults.passed === "number"
            ? {
                passed: testResults.passed,
                failed: testResults.failed ?? 0,
                skipped: testResults.skipped ?? 0,
            }
            : null,
        success_criteria_met: Array.isArray(raw.success_criteria_met)
            ? raw.success_criteria_met.filter((v) => typeof v === "string")
            : [],
        success_criteria_remaining: Array.isArray(raw.success_criteria_remaining)
            ? raw.success_criteria_remaining.filter((v) => typeof v === "string")
            : [],
        progress_estimate: typeof raw.progress_estimate === "number"
            ? Math.max(0, Math.min(1, raw.progress_estimate))
            : 0.0,
    });
}
/** Parse CriterionRevision[] from a raw JSON array. */
export function parseCriterionRevisions(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((v) => typeof v === "object" && v !== null &&
        typeof v.old === "string" &&
        typeof v.new === "string")
        .map((v) => {
        const r = v;
        return { old: r.old, new: r.new };
    });
}
/** Parse WorkerResult[] from a raw JSON array. */
export function parseWorkerResults(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((v) => typeof v === "object" && v !== null &&
        typeof v.agentId === "string" &&
        typeof v.subTask === "string" &&
        typeof v.resultSummary === "string")
        .map((v) => {
        const w = v;
        return {
            agentId: w.agentId,
            subAgentType: typeof w.subAgentType === "string" ? w.subAgentType : "general-purpose",
            subTask: w.subTask,
            resultSummary: w.resultSummary,
            success: typeof w.success === "boolean" ? w.success : false,
            discoveredConstraints: Array.isArray(w.discoveredConstraints)
                ? w.discoveredConstraints.filter((c) => typeof c === "string")
                : [],
        };
    });
}
// ── Self-evaluation extraction ───────────────────────────────────────────
/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-eval block is found.
 *  The agent is instructed to output JSON between the delimiters. */
export function extractSelfEvaluation(text) {
    const match = text.match(SELF_EVAL_REGEX);
    if (!match)
        return null;
    try {
        const raw = JSON.parse(match[1]);
        if (typeof raw.success !== "boolean")
            return null;
        if (typeof raw.output_summary !== "string")
            return null;
        if (!Array.isArray(raw.constraint_violations))
            return null;
        if (typeof raw.should_continue !== "boolean")
            return null;
        return buildSelfEvaluation(raw);
    }
    catch {
        return null;
    }
}
/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. */
export function buildSelfEvaluation(raw) {
    const executionEvidence = parseExecutionEvidence(raw.execution_evidence);
    const retractedConstraints = Array.isArray(raw.retracted_constraints)
        ? raw.retracted_constraints.filter((v) => typeof v === "string")
        : [];
    const revisedCriteria = parseCriterionRevisions(raw.revised_success_criteria);
    const wrongAssumptions = Array.isArray(raw.wrong_assumptions)
        ? raw.wrong_assumptions.filter((v) => typeof v === "string")
        : [];
    const workerResults = parseWorkerResults(raw.worker_results);
    return makeSelfEvaluation({
        success: typeof raw.success === "boolean" ? raw.success : false,
        output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
        constraint_violations: Array.isArray(raw.constraint_violations)
            ? raw.constraint_violations.filter((v) => typeof v === "string")
            : [],
        should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
        discovered_constraints: Array.isArray(raw.discovered_constraints)
            ? raw.discovered_constraints.filter((v) => typeof v === "string")
            : [],
        objective_refinement: typeof raw.objective_refinement === "string"
            ? raw.objective_refinement
            : "",
        emerged_subtasks: Array.isArray(raw.emerged_subtasks)
            ? raw.emerged_subtasks.filter((v) => typeof v === "string")
            : [],
        execution_evidence: executionEvidence,
        retracted_constraints: retractedConstraints,
        revised_success_criteria: revisedCriteria,
        wrong_assumptions: wrongAssumptions,
        worker_results: workerResults,
        compression_checkpoint: typeof raw.compression_checkpoint === "boolean" ? raw.compression_checkpoint : false,
        checkpoint_label: typeof raw.checkpoint_label === "string" ? raw.checkpoint_label : "",
        next_action: typeof raw.next_action === "string" ? raw.next_action : undefined,
        completed_subtasks: Array.isArray(raw.completed_subtasks)
            ? raw.completed_subtasks.filter((v) => typeof v === "string")
            : [],
        blocked_subtasks: Array.isArray(raw.blocked_subtasks)
            ? raw.blocked_subtasks.filter((v) => typeof v === "string")
            : [],
        canceled_subtasks: Array.isArray(raw.canceled_subtasks)
            ? raw.canceled_subtasks.filter((v) => typeof v === "string")
            : [],
        stop_reason: raw.stop_reason === "gave_up" || raw.stop_reason === "blocked" || raw.stop_reason === "needs_human_input"
            ? raw.stop_reason
            : undefined,
        drift_clarification: typeof raw.drift_clarification === "string" ? raw.drift_clarification : undefined,
        prompt_requests: parsePromptRequests(raw.prompt_requests),
    });
}
/** Parse a PromptRequests object from raw JSON input.
 *  Lenient: missing or invalid fields get sensible defaults.
 *  Returns undefined if the raw value is absent or not an object,
 *  so makeSelfEvaluation can distinguish "not set" from "empty". */
function parsePromptRequests(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const obj = raw;
    const emphasize = Array.isArray(obj.emphasize)
        ? obj.emphasize.filter((v) => typeof v === "string").slice(0, 10)
        : [];
    const validExpands = new Set([
        "milestones", "sub_goals", "constraint_lifecycle",
        "agent_trust", "progress", "loop_synthesis",
    ]);
    const expand = Array.isArray(obj.expand)
        ? obj.expand.filter((v) => typeof v === "string" && validExpands.has(v))
        : [];
    const confusionPoints = Array.isArray(obj.confusion_points)
        ? obj.confusion_points.filter((v) => typeof v === "string").slice(0, 5)
        : [];
    // Return undefined when all fields are empty — semantically equivalent
    // to "not set", avoids carrying an empty object through the pipeline.
    if (emphasize.length === 0 && expand.length === 0 && confusionPoints.length === 0) {
        return undefined;
    }
    return { emphasize, expand, confusion_points: confusionPoints };
}
// v2.6: heuristicSelfEvaluation removed — if structured extraction fails,
// the round is stalled. The 20-line keyword heuristic was dead weight; an
// agent that can't produce a structured self-evaluation is genuinely stuck.
//# sourceMappingURL=self-eval.js.map