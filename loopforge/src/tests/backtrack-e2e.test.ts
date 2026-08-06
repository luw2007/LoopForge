/** End-to-end backtrack lifecycle test.
 *
 * Drives a complete backtrack cycle through the SessionManager API directly
 * (no subprocess) so that crash recovery can be simulated by destroying and
 * recreating the SessionManager with the same FileLoopStore backend.
 *
 * Flow: start → 3× flat progress → backtrack → verify prompt → simulated
 * crash → resume → verify recovery → continue loop.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FileLoopStore } from "../loop-store.js";
import { SessionManager } from "../mcp/session.js";
import type { McpSession } from "../mcp/session.js";
import { verifyBacktrackPrompt } from "./_backtrack-asserts.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** A flat-progress self-evaluation that will eventually trigger
 *  progress_stall after 3 consecutive rounds. */
function stalledEval(round: number, progress: number, files: string[]) {
  return {
    success: false as const,
    output_summary: `Round ${round}: reviewed ${files.join(", ")}, no new progress.`,
    should_continue: true as const,
    constraint_violations: [] as string[],
    execution_evidence: {
      files_changed: files,
      test_results: { passed: 0, failed: 0, skipped: 0 },
      success_criteria_met: [] as string[],
      success_criteria_remaining: ["Complete the task"],
      progress_estimate: progress,
    },
  };
}

/** Create a SessionManager wired to a temp directory. */
function createSessionManager(storeDir: string): SessionManager {
  return new SessionManager(
    new FileLoopStore(join(storeDir, ".loopforge")),
  );
}

describe("E2E backtrack lifecycle", () => {
  let storeDir: string;
  let mgr: SessionManager;
  let sessionId: string;
  let loopId: string;

  before(() => {
    storeDir = join(tmpdir(), `loopforge-backtrack-${randomUUID()}`);
    mgr = createSessionManager(storeDir);
  });

  after(() => {
    mgr.close();
    try { rmSync(storeDir, { recursive: true }); } catch { /* best effort */ }
  });

  // ── Step 1: Start ──────────────────────────────────────────────────────

  it("step 1 — start compiles the first prompt", async () => {
    const result = await mgr.create({
      task: "Write unit tests for all public functions. Run npm test after each change.",
      maxRounds: 10,
      constraints: ["Do not skip tests", "Run npm test before claiming success"],
    });

    assert.ok(!result.prompt?.includes("error"), `unexpected error in prompt`);
    assert.equal(result.round, 1);
    assert.ok(typeof result.sessionId === "string" && result.sessionId.length > 0);
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 100);

    sessionId = result.sessionId;
    const session = mgr.get(sessionId)!;
    loopId = session.loopId;
    assert.ok(loopId.length > 0, "loopId must be non-empty");
  });

  // ── Step 2–5: Four flat-progress rounds → backtrack ───────────────────
  // R4 needs 3 data points in vault. Round 1 goes to vault after advance,
  // so we need rounds 1,2,3 in vault + round 4 triggering enforcement.

  it("step 2 — round 1 flat progress (0.3)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 1 output",
      stalledEval(1, 0.3, ["src/a.ts"]),
    );
    assert.ok(!result.enforcementAction || result.enforcementAction === "accept");
    assert.equal(result.round, 2);
  });

  it("step 3 — round 2 flat progress (0.3)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 2 output",
      stalledEval(2, 0.3, ["src/b.ts"]),
    );
    assert.ok(!result.enforcementAction || result.enforcementAction === "accept");
    assert.equal(result.round, 3);
  });

  it("step 4 — round 3 flat progress (0.3)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 3 output",
      stalledEval(3, 0.3, ["src/c.ts"]),
    );
    assert.ok(!result.enforcementAction || result.enforcementAction === "accept");
    assert.equal(result.round, 4);
  });

  it("step 5 — round 4 triggers progress_stall REJECT (first occurrence)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 4 output",
      stalledEval(4, 0.3, ["src/d.ts"]),
    );

    // First stall detection → reject (gives agent a chance to change approach)
    assert.equal(
      result.enforcementAction,
      "reject",
      `expected enforcementAction=reject (first stall), got ${result.enforcementAction} (reason: ${result.enforcementReason ?? "none"})`,
    );
    assert.equal(result.round, 4, "reject must not advance the round counter");
  });

  it("step 6 — round 4 retry triggers BACKTRACK (second consecutive stall)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 4 retry output — same stalled approach",
      stalledEval(4, 0.3, ["src/d.ts"]),
    );

    // Second consecutive stall → backtrack (escalation + backtrack_enabled)
    assert.equal(
      result.enforcementAction,
      "backtrack",
      `expected enforcementAction=backtrack, got ${result.enforcementAction} (reason: ${result.enforcementReason ?? "none"})`,
    );

    // Prompt must reference Backtrack, Workspace Restore, and NO literal ${...}
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 50);
    assert.ok(
      !result.prompt!.includes("${"),
      "backtrack prompt must not contain un-interpolated ${...} literals",
    );
    assert.ok(result.prompt!.includes("Backtrack"),
      "prompt must contain Backtrack header");
    assert.ok(result.prompt!.includes("Workspace Restore"),
      "prompt must contain Workspace Restore section");
    assert.ok(result.prompt!.includes("Round"),
      "prompt must reference round numbers");
  });

  // ── Step 7: Simulate crash and recover ─────────────────────────────────

  it("step 7 — crash recovery via new SessionManager resumes correctly", async () => {
    // Capture state before crash
    const sessionBefore = mgr.get(sessionId)!;
    const roundBefore = sessionBefore.currentRound;

    // Simulate crash: close old manager, create new one with same store
    mgr.close();
    mgr = createSessionManager(storeDir);

    // Auto-resume all vault sessions (as McpServer.start() does)
    const resumed = mgr.autoResumeAll();
    assert.ok(resumed >= 1, `autoResumeAll must find >=1 sessions, got ${resumed}`);

    // Find the resumed session
    const sessions = mgr.list();
    const resumedSession = sessions.find((s) => s.loopId === loopId);
    assert.ok(resumedSession, "resumed session must appear in list");

    // Resume to get the prompt
    const result = await mgr.resume(loopId);
    assert.ok(result !== null, "resume must return a result");
    assert.ok(
      result!.round === roundBefore ||
      result!.round === roundBefore + 1,
      `resumed round (${result!.round}) should be near pre-crash round (${roundBefore})`,
    );
    assert.ok(
      typeof result!.prompt === "string" && result!.prompt!.length > 50,
      "resume must return a valid prompt",
    );

    // Update sessionId to the new one
    sessionId = result!.sessionId;
  });

  // ── Step 8: Verify loop is alive after backtrack ───────────────────────
  // The vault still holds the old flat-progress entries, so submitting
  // another round would re-trigger progress_stall. What matters is that
  // the backtrack completed successfully and the loop is still running.

  it("step 8 — session is still running after backtrack + crash recovery", async () => {
    const session = mgr.get(sessionId);
    assert.ok(session, "session must still exist after backtrack recovery");
    assert.equal(
      session!.status, "running",
      `session must be running, got ${session!.status}`,
    );

    // Verify the session list still includes this loop
    const sessions = mgr.list();
    const found = sessions.find((s) => s.loopId === loopId);
    assert.ok(found, "loop must appear in session list after backtrack recovery");
  });
});
