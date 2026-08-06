/** Externalized LoopForge runtime policy. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
export const DEFAULT_POLICY = {
    version: "2",
    constraints: { retire_window: 3 },
    summary: { window: 5, health_check_interval: 1, milestone_interval: 20, max_milestones: 10, enable_loop_synthesis: true },
    engine: { feedback_flush_interval: 5, max_circuit_breaker: 3, max_rounds: 20, enforcement_escalation_enabled: true, backtrack_enabled: true, backtrack_max_depth: 3, backtrack_preserve_discoveries: true, drift_clarification_max_streak: 3, backtrack_auto_restore: false },
    prompt: {
        injection_mode: "adaptive",
        full_refresh_interval: 0,
        l0_max_chars: 3000,
        l1_max_chars: 7000,
        l2_max_chars: 18000,
        l2_adaptive_enabled: true,
        l2_adaptive_round_factor: 200,
        l2_adaptive_milestone_factor: 1000,
        l2_adaptive_max_chars: 40000,
        l2_adaptive_subgoal_factor: 100,
        l2_pointer_enabled: true,
        max_emphasize_l2: 5,
        max_emphasize_l1: 3,
        max_expand_l1: 1,
        max_confusion_points: 3,
        base_prompt_version: "2.0.0",
    },
    backend: { root_dir: ".loopforge" },
    evolution: {
        max_discovered_constraints_per_round: 5,
        max_active_constraints: 15,
        max_objective_versions: 10,
        progress_stall_threshold: 0.05,
        progress_stall_rounds: 2,
        progress_mismatch_threshold: 0.3,
        intent_drift_threshold: 0.15,
        criteria_dedup_threshold: 0.45,
        subgoal_dedup_threshold: 0.6,
        subgoal_match_threshold: 0.5,
        subgoal_auto_in_progress_threshold: 0.4,
        subgoal_auto_complete_threshold: 0.4,
        constraint_match_threshold: 0.5,
        subgoal_drift_alignment_threshold: 0.3,
        subgoal_stale_rounds: 10,
        max_subgoals_in_prompt: 10,
        max_done_subgoals_in_prompt: 5,
        constraint_inactive_rounds: 15,
        constraint_id_enabled: true,
    },
    checkpoint: { max_carried_constraints: 10, outcome_max_chars: 200 },
    state_file: {
        enabled: true,
        directory: ".loopforge/state",
        max_checkpoints: 5,
        max_summary_rounds: 5,
    },
    evidence: { providers: ["git"], timeout_ms: 120_000, commands: [] },
    mcp: {
        session_lease_ms: 30_000,
        session_lease_renew_interval_ms: 10_000,
    },
};
/** Write a full default `loop_policy.json` to the target directory.
 *
 *  The written file contains every configurable key and its default value
 *  so users can discover and tune the system without reading source code.
 *  Skip creation when the file already exists unless `force` is true.
 *
 * @returns The resolved file path and whether it was freshly created.
 */
export function writeDefaultPolicy(targetDir, force = false) {
    const target = resolve(targetDir, "loop_policy.json");
    if (existsSync(target) && !force) {
        return { path: target, created: false };
    }
    writeFileSync(target, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", "utf8");
    return { path: target, created: true };
}
function deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
        const current = result[key];
        const incoming = overrides[key];
        if (key in result && current !== null && incoming !== null &&
            typeof current === "object" && !Array.isArray(current) &&
            typeof incoming === "object" && !Array.isArray(incoming)) {
            result[key] = deepMerge(current, incoming);
        }
        else if (key in result) {
            result[key] = incoming;
        }
        else {
            // Warn on unknown keys — a typo like "max_round" instead of
            // "max_rounds" would otherwise be silently ignored.
            console.warn(`loopforge: ignoring unknown policy key "${key}". Check loop_policy.json for typos.`);
        }
    }
    return result;
}
export function loadPolicy(path) {
    const candidates = [path, "loop_policy.json"].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const raw = JSON.parse(readFileSync(resolve(candidate), "utf8"));
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                return deepMerge(DEFAULT_POLICY, raw);
            }
        }
        catch {
            // Try the next candidate.
        }
    }
    return structuredClone(DEFAULT_POLICY);
}
let policy = null;
export function getPolicy(path) {
    // Explicit path: always (re)load from that file.
    // No path: cache the default lookup so loadPolicy only runs once.
    if (path)
        return loadPolicy(path);
    policy ??= loadPolicy();
    return policy;
}
export function resetPolicy() {
    policy = null;
}
const LOOP_ID_RE = /^[a-zA-Z0-9][-a-zA-Z0-9_:.]{0,127}$/;
export function validateLoopId(loopId) {
    if (typeof loopId !== "string" || !loopId) {
        throw new Error("Invalid loopId: must be a non-empty string");
    }
    if (loopId.includes(".."))
        throw new Error('Invalid loopId: ".." is not allowed');
    if (loopId.includes("/") || loopId.includes("\\")) {
        throw new Error("Invalid loopId: path separators are not allowed");
    }
    if (!LOOP_ID_RE.test(loopId)) {
        throw new Error("Invalid loopId: use at most 128 alphanumeric, hyphen, underscore, colon, or dot characters");
    }
}
export function resolveStateDirectory(workspaceRoot, configuredDirectory) {
    const lexicalRoot = resolve(workspaceRoot);
    const lexicalTarget = resolve(lexicalRoot, configuredDirectory);
    const lexicalRelative = relative(lexicalRoot, lexicalTarget);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(lexicalRelative)) {
        throw new Error("State file directory must stay within the workspace");
    }
    const realRoot = realpathSync(lexicalRoot);
    let ancestor = lexicalTarget;
    while (!existsSync(ancestor)) {
        const parent = resolve(ancestor, "..");
        if (parent === ancestor)
            break;
        ancestor = parent;
    }
    const projected = resolve(realpathSync(ancestor), relative(ancestor, lexicalTarget));
    const realRelative = relative(realRoot, projected);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) ||
        isAbsolute(realRelative)) {
        throw new Error("State file directory resolves outside the workspace");
    }
    return lexicalTarget;
}
export function writeStateFile(loopId, content) {
    if (!content)
        return;
    validateLoopId(loopId);
    const config = getPolicy().state_file;
    if (!config.enabled)
        return;
    const directory = resolveStateDirectory(process.cwd(), config.directory);
    mkdirSync(directory, { recursive: true });
    const verifiedDirectory = resolveStateDirectory(process.cwd(), config.directory);
    const target = resolve(verifiedDirectory, `${loopId}-state.md`);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error("State file target must not be a symbolic link");
    }
    const temporary = resolve(verifiedDirectory, `.${loopId}-state.${process.pid}.${randomUUID()}.tmp`);
    try {
        writeFileSync(temporary, content, "utf8");
        renameSync(temporary, target);
    }
    finally {
        try {
            rmSync(temporary, { force: true });
        }
        catch { /* best effort */ }
    }
}
//# sourceMappingURL=policy.js.map