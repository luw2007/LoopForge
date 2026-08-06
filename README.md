# LoopForge

**A context window is not memory. Memory needs a runtime.**

> **v2.11.0** — `npm install -g loopforge`. Node.js ≥ 18. Zero runtime dependencies.
> [中文文档](./README.zh-CN.md)

---

## The real problems with long-horizon tasks

Any AI coding agent, given a long enough task, hits three walls. Not because
the model isn't smart enough. Not because the context window isn't large
enough. These are **architectural** problems.

### Problem 1: The summary cascade

Context fills up → compress. Fills up again → compress again. The third
compression is a summary of a summary of a summary. Every cycle evaporates
information — critical constraints get silently deleted because the summarizer
judged them "no longer relevant." Researchers found that after 3–4 summary
cycles, constraint violation rates spike from 0% to 59%. The agent doesn't
know what it forgot, because the forgetting itself was compressed away.

**This is what happens when you treat cognitive state as context. The bucket
always leaks.**

### Problem 2: Self-correction doesn't work

Google DeepMind's conclusion is clear: models cannot reliably improve
themselves through introspection. They talk themselves out of correct answers.
Effective recovery requires an **external verifier** — an independent observer
that doesn't share the agent's context, doesn't participate in its reasoning,
and only looks at inputs and outputs. The verifier must never be the same
context that made the mistake.

### Problem 3: Compound error (p^N)

If each step succeeds with probability p, N sequential steps succeed with
probability p^N. METR found that frontier agents nail nearly 100% of tasks
a human finishes in under 4 minutes, then crater to under 10% on tasks taking
more than 4 hours. Small errors at each step become the correct input for the
next step. The agent builds on errors, each step looking locally reasonable,
while the entire trajectory is fiction.

**These three problems amplify each other. The summary cascade loses
information → lost information becomes errors → the agent can't self-correct
because those errors look reasonable within its own context.**

---

## What LoopForge does about it

LoopForge runs **outside** the agent. It provides a typed vault that survives
context compression, an external verification-and-enforcement pipeline the
agent cannot self-provide, and a recovery system that walks back from dead
ends without human intervention.

### 1. Vault → compile, not summary → summary

Each round's self-evaluation is written to a **typed JSON vault**. The next
round's prompt is not a compressed version of the previous prompt — it's
**recompiled from the vault**. Milestones are recomputed from raw vault
entries, not chained from prior summaries. Constraints, criteria, and
sub-goals carry stable hash-derived IDs (`c-` / `cr-` / `sg-XXXXXXXX`) for
exact matching across rounds. Delete the state file and it regenerates from
the vault.

```
❌ Traditional: prompt → summary → next prompt → re-summarize → …
✅ LoopForge:  prompt → vault entry → next prompt (recompiled from vault)
```

### 2. External verification & enforcement

The **verification gate** (11 cross-checks) compares every agent claim
against independent evidence — Git snapshots, test runner output, explicit
verification commands. The **enforcement gate** (7 rules) decides what to do.
Its focus is not "did the agent violate constraint X" — it detects what the
agent cannot self-diagnose:

- R1: Claimed success but criteria remain unmet → **self-deception**
- R3: Claimed success with no verifiable evidence → **empty claim**
- R4: Flat progress for 3 rounds → **stalled without knowing it**
- R5: Zero forward motion → **going through the motions**
- R7: Said X, did Y → **intent and actions disconnected**

**The agent is the system that produced those narratives. It cannot detect
these patterns from the inside.**

### 3. Recovery: reject, backtrack, resume

**Zero-commit rejection** — a rejected round writes nothing to the vault. The
round ID stays stable, the attempt counter increments, and the next prompt
includes a diagnostic gap showing exactly what didn't match.

**Backtrack** — when progress stalls (R4/R5), the loop rolls back to the last
clean round instead of terminating. A diagnosis of why the path failed is
injected. The backtrack prompt includes workspace restore commands with
affected file lists; the next submission is rejected if the workspace wasn't
restored. Valid discoveries from skipped rounds are preserved.

**Pause / Resume / Replay** — cross-process session leases. Idempotent resume
after interruption. Time-travel queries over committed rounds.

---

## What LoopForge is not

- ❌ **Not a memory system** — the state file is a derived view. The vault is
  truth. No RAG, no vector DB.
- ❌ **Not a context compressor** — doesn't compress prompts or do smart
  summarization. Recompiles from vault, not from the previous prompt.
- ❌ **Not a constraint tracker** — constraints are one signal the verification
  gate monitors. The core value is external judgment.
- ❌ **Not a replacement for the agent** — the agent still reads code, edits
  files, runs tools, and decides how to reason. LoopForge owns the **round
  boundary**.

---

## Install

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

Works with Claude Code, Codex CLI, or any MCP-compatible client.

The MCP server path (`loopforge mcp`) is the primary integration. It provides
the full cognitive infrastructure: verification gate, enforcement gate,
backtrack, evidence collection, and crash recovery. The engine is also
available as a library for custom integrations — see the
[API reference](./loopforge/README.md).

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Agent executes round                 │
│  Reads code · Edits files · Runs tools · Reasons      │
└──────────────────────┬──────────────────────────────┘
                       │ Agent submits SelfEvaluation
                       ▼
┌─────────────────────────────────────────────────────┐
│               LoopForge round boundary                │
│                                                       │
│  Evidence → Verify → Enforce → Commit → Compile       │
│  (Git/cmd) (11 checks) (7 rules) (vault)  (next)     │
│                                                       │
│  accept:    commit state, compile next round           │
│  reject:    retry same round, zero state mutation      │
│  backtrack: roll back, restore workspace, inject diag  │
│  terminate: persist terminal state                     │
└──────────────────────┬──────────────────────────────┘
                       │ Recompile prompt from vault
                       ▼
┌─────────────────────────────────────────────────────┐
│             Vault (typed JSON persistence)            │
│  loops/<id>/rounds/<n>.json · session.json · policy   │
│  Source of truth. Not a summary chain.                 │
└─────────────────────────────────────────────────────┘
```

---

## Core capabilities

### Durable cognitive state

Every round's self-evaluation is written to the vault. The next prompt is
recompiled from vault entries — milestones aren't "summaries of summaries,"
sub-goal states aren't "compressed then compressed again." Stable IDs
(`c-` / `cr-` / `sg-XXXXXXXX`) enable exact matching of constraints,
criteria, and sub-goals across rounds — no Jaccard false positives.

The compiler tracks sub-goals through a five-state lifecycle (pending →
in_progress → done / blocked / canceled), manages constraint decay
(discovered constraints demote to inactive after prolonged irrelevance, then
auto-reactivate on violation), and builds hierarchical summaries with
phase-boundary milestones that survive rolling-window eviction.

### External verification & enforcement

The verification gate runs 11 cross-checks against independent evidence:
progress regression, empty-change-with-passing, success-with-remaining-criteria,
duplicate constraint discovery, recurring violations, retract-fresh-constraint,
evidence integrity (Git), required command evidence, command evidence mismatch,
intent-action drift, and sub-goal drift.

The enforcement gate's 7 rules detect cognitive integrity failures: fake
success (R1), recurring violations (R2), empty success (R3), progress stall
(R4), terminal flatline (R5), max rejections (R6), and intent drift (R7).
R7 accepts intentional pivots only when the drift clarification references
concrete IDs or file paths — three consecutive weak clarifications without
anchors terminate the loop.

### Recovery

Rejected rounds commit nothing. Stalled progress triggers backtrack to the
last clean round with a diagnosis injected. The backtrack prompt includes
workspace restore instructions; the next submission is verified for workspace
cleanliness. Sessions survive process restarts via renewable cross-process
leases — resume picks up exactly where you left off.

### Agent autonomy

L0 (retry) / L1 (continuation) / L2 (full rehydration) control state density
only — reasoning strategy belongs to the agent. Each round, the agent can
express information needs via `prompt_requests` (emphasize, expand,
confusion_points). The compiler reorders the prompt within safety boundaries;
mandatory sections are never removed.

Nine MCP tools (`start` · `next` · `status` · `stop` · `pause` · `list` ·
`replay` · `resume` · `health`) with typed `structuredContent`. Zero runtime
dependencies — Node.js stdlib only. All thresholds, budgets, and intervals
live in `loop_policy.json`. 491 tests.

---

## License

MIT
