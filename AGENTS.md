# LoopForge

LoopForge is a cognitive state runtime for external AI coding Agents. It keeps
objectives, constraints, evidence, decisions, and recovery state stable across
Agent-driven rounds. It does not provide a model or unattended executor.

## Design philosophy

Long-horizon agent tasks face three mutually-reinforcing failure modes:

1. **Summary cascade** — each compression cycle loses information silently.
   After 3–4 cycles the agent's "memory" is a summary of a summary of a summary.
   LoopForge severs this chain: prompts are recompiled from typed vault entries,
   not from the previous prompt's summary.

2. **Self-correction failure** — models cannot reliably improve themselves
   through introspection (Google DeepMind). Effective recovery requires an
   external verifier that never shares the agent's context. LoopForge provides
   this via the verification gate (11 evidence cross-checks) and enforcement
   gate (7 cognitive-integrity rules).

3. **Compound error (p^N)** — each step's error becomes the next step's input.
   LoopForge partially addresses this via backtrack (v2.10: roll back to last
   clean round with lessons injected) and enforcement (stop before errors
   compound into catastrophe). Full solution requires in-execution guards,
   which is future work.

LoopForge is NOT a memory system, a context compressor, or a constraint tracker.
It is an **external cognitive infrastructure** — the perspective the agent
cannot provide for itself.

## Project rules

- TypeScript only.
- Node.js 18 or newer.
- Zero runtime dependencies.
- The npm package is in `loopforge/` and is currently `2.11.0`.
- Preserve user changes in a dirty worktree.
- Edit `src/protocol.ts`, then run the build to regenerate
  `loopforge-protocol.json`.
- Do not restore MCP Tasks, prompt-technique routing, automatic memory discovery,
  PromptCraft vault writes, or Markdown lineage fallback.

## Commands

```bash
cd LoopForge
npm run check
npm run build
npm test
npm pack --dry-run --json
```

Run the full test suite in a temporary mirror when generated files in the active
worktree must remain untouched.

## Current architecture

```text
LoopForge/src/
  canonical-state.ts    CanonicalLoopState and deterministic hashing
  token-utils.ts        Shared Jaccard similarity, dedup, entry helpers (v2.5)
  prompt-policy.ts      L0/L1/L2 view selection
  prompt-assembler.ts   Single-pass PromptArtifact renderer
                        (v2.9: prompt_requests — model-expressed information needs)
  loop-compiler.ts      State evolution and prompt compilation
                        (v2.1: hierarchical summary with milestones)
                        (v2.2: sub-goal structured tracking with 5-state lifecycle)
                        (v2.3: time-aware constraint decay + auto-reactivation)
                        (v2.4–v2.5: adaptive L2 budget scaling)
                        (v2.5: agent trust score — derived from verification flags)
  engine.ts             Engine state, feedback, and lineage projection
  round-driver.ts       Shared Runtime and MCP round preparation/completion
  round-transaction.ts  Stable round ID, attempts, evidence, commit recovery
  round-coordinator.ts  Verify, enforce, backtrack, and stop decision pipeline
                        (v2.10: backtrack action — roll back to last clean round)
  verification-gate.ts  Cross-round and evidence consistency checks
                        (v2.2: subgoal_drift; v2.10: safe restore point detection)
  enforcement-gate.ts   Accept, reject, backtrack, or terminate rules (7 rules)
                        (v2.10: R4/R5 escalate to backtrack instead of terminate)
  loop-store.ts         Typed, atomic per-loop JSON persistence and migration
  evidence-provider.ts  Git, custom async, and explicit command evidence
  replay.ts             Typed round timeline and diff queries
  policy.ts             Runtime policy and safe derived state-file writes
  observability.ts      Structured tracing
  policy-metrics.ts     Verification and round outcome metrics
  cli.ts                Unified loopforge command
  mcp/
    session.ts          Durable leased MCP sessions
                        (v2.10: backtrack result builder + crash recovery)
    tools.ts            Ten validated tools and output schemas
                        (v2.9: prompt_requests in loopforge_next schema)
    server.ts           Synchronous JSON-RPC stdio server
```

### Long-Horizon Protocol Types (v2.1–v2.10)

```text
protocol.ts additions:
  MilestoneSummary      Phase-boundary snapshots (agent_declared | criteria_milestone | auto)
  SubGoal               Structured sub-goal with 5-state lifecycle (pending→done/canceled)
  ConstraintMeta        Per-constraint time metadata with source classification
  PromptRequests        Model-expressed information needs for the next prompt (v2.9)
  +3 SelfEvaluation fields: completed_subtasks, blocked_subtasks, canceled_subtasks
  +1 SelfEvaluation field: prompt_requests (v2.9)
  +2 LoopCompileResponse fields: constraints_inactive, constraint_metadata
  +4 RoundProcessResult fields: backtrackPrompt, backtrackTarget,
    backtrackSkippedDiscoveries, backtrackTriggerRule (v2.10)
```

## Invariants

- One canonical state produces one PromptArtifact per attempt.
- L0, L1, and L2 control state density, not reasoning technique.
- Rejection keeps the logical round ID, increments attempt, and commits nothing.
- Backtrack resets the round counter to (last clean round + 1), commits nothing
  from the skipped rounds, preserves valid discoveries from skipped rounds, and
  injects a "why this path failed" diagnosis. Only R4 (progress stall) and R5
  (flat terminal) trigger backtrack. R6 (max rejections) still terminates.
- All round processing goes through the SessionManager → RoundDriver →
  RoundCoordinator path.
- Typed JSON session and round documents are the durable truth.
- `.loopforge/state/<loopId>-state.md` is an optional derived view.
- Session and round writes are atomic and protected by owned locks.
- MCP mutations are serialized per session and fenced by renewable leases.
- The external Agent owns long-running work. LoopForge does not implement MCP
  Tasks or a background Agent.
- Context providers, terminal sinks, trace sinks, and checkpoint sinks are
  explicit. Never auto-discover integrations.
- Command evidence is disabled by default, uses executable plus args with
  `shell: false`, and may only run inside the workspace.
- A required command failure contradicts a success claim before commit.
- prompt_requests is consumed each round — not durable across rounds.
  The Compiler honors requests within safety boundaries (mandatory sections
  are never removed, budget is never bypassed). L0 ignores all requests.

## Storage layout

```text
.loopforge/
  loops/<sha256(loopId)>/
    metadata.json
    session.json
    rounds/<round>.json
  state/<loopId>-state.md
  migrations/
```

Legacy `.promptcraft/prompt_vault.json` is read only by the explicit migration
command. Migration must not delete the source.

## CLI

```bash
loopforge mcp
loopforge init --client claude|codex|generic [--target DIR] [--force]
loopforge doctor [--json]
loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
loopforge migrate [--from PATH] [--json]
```

## Before changing a hotspot

- Prompt changes require PromptArtifact budget, hashing, and same-round retry
  coverage.
- Transaction changes require reject, backtrack, commit replay, concurrent next,
  pause, stop, and restart tests.
- Store changes require prefix isolation, live and stale lock ownership,
  migration idempotence, and cross-process lease tests.
- Evidence changes require timeout, abort, unavailable provider, output cap,
  workspace boundary, and verification contradiction tests.
- MCP changes require primitive JSON, strict arguments, structured output, and
  process-level stdio tests.
- Long-horizon compiler features (milestones, sub-goals, constraint decay,
  adaptive budgets, trust scores, prompt_requests, backtrack) are derived from
  vault entries each round — no new persistence formats.
  - Hard/plan/criteria constraints never auto-decay.
  - Milestone triggers follow priority: agent_declared > criteria_milestone > auto.
  - Sub-goal status is compiler-derived; the agent owns execution.
  - All Jaccard similarity thresholds are policy-driven (v2.5).
  - prompt_requests is transient — consumed each round, not persisted in
    canonical state. Emphasize is pure reorder (zero token overhead). L0 ignores
    all requests.
  - Backtrack safe restore point is computed on-demand from vault entries.
    Max search depth is policy-controlled (default: 3). Only R4 and R5 trigger
    backtrack; R6 still terminates.
- CheckpointSummary is deprecated in v2.5; use MilestoneSummary with
  kind: "agent_declared" instead. The checkpoint_summary field on
  LoopCompileResponse is always null.
- Agent trust score and stop_reason are derived fields — trust from
  verification gate flags, stop_reason from SelfEvaluation. Neither
  requires new persistence.
