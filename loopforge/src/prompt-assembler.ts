/** Single-pass prompt renderer for canonical LoopForge state.
 *
 * L0/L1/L2 control state density only. Reasoning strategy belongs to the
 * external Agent. Mandatory task, hard-constraint, and verification sections
 * are never truncated; budgets are soft and overflow is recorded.
 */

import { createHash } from "node:crypto";
import type { CanonicalLoopState } from "./canonical-state.js";
import { hashCanonicalState } from "./canonical-state.js";
import type { PromptArtifact, PromptRequests } from "./protocol.js";
import type {
  PromptLevel,
  PromptLevelReason,
} from "./prompt-policy.js";
import { jaccardSimilarity } from "./token-utils.js";
import { getPolicy } from "./policy.js";

export const PROMPT_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const BASE_PROMPT_VERSION = "2.0.0";

export type InjectionMode = "adaptive" | "full" | "pointer";

export interface PromptBudgets {
  l0: number;
  l1: number;
  l2: number;
}

export const DEFAULT_PROMPT_BUDGETS: PromptBudgets = {
  l0: 3000,
  l1: 7000,
  l2: 18000,
};

export interface PromptAssemblyInput {
  state: CanonicalLoopState;
  level: PromptLevel;
  reasons: PromptLevelReason[];
  mode?: InjectionMode;
  budgets?: Partial<PromptBudgets>;
  attempt?: number;
  selfEvaluationBlock: string;
  fullStateMarkdown?: string;
  /** v2.9: Model's information needs for this prompt. L0: ignored. */
  promptRequests?: PromptRequests;
}

interface Section {
  id: string;
  text: string;
  mandatory: boolean;
}

function section(title: string, body: string): string {
  return body.trim() ? `### ${title}\n${body.trim()}\n\n` : "";
}

function bullets(values: string[], prefix = "- "): string {
  return values.map((value) => `${prefix}${value}`).join("\n");
}

/** v2.11: Derive a stable item ID from text content.
 *  Same hash strategy as computeGoalTextHash in loop-compiler.ts. */
function deriveItemId(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

/** v2.11: Render a bullet list with ID prefixes for constraints/criteria.
 *  Each item gets a [prefix-XXXXXXXX] tag. Items that already look like IDs
 *  are rendered as-is. When constraint_id_enabled is false, renders plain bullets. */
function bulletsWithIds(values: string[], prefix: string): string {
  const idEnabled = getPolicy().evolution.constraint_id_enabled;
  if (!idEnabled) return bullets(values);
  const idRegex = /^(c|cr|sg)-[a-f0-9]{8}$/;
  return values.map((v) => {
    const trimmed = v.trim();
    if (idRegex.test(trimmed)) {
      return `- [\`${trimmed}\`] ${trimmed}`;
    }
    const id = prefix + "-" + deriveItemId(trimmed);
    return `- [\`${id}\`] ${trimmed}`;
  }).join("\n");
}

function verificationText(state: CanonicalLoopState): string {
  const lines = state.verificationFlags.map((flag) => {
    const icon = flag.severity === "error"
      ? "🚫"
      : flag.severity === "warn" ? "⚠️" : "ℹ️";
    return `- ${icon} [${flag.check}] ${flag.detail}`;
  });
  if (state.verificationFlags.some((flag) => flag.severity === "error")) {
    lines.push(
      "- Gate Verdict: CONTRADICTED — resolve every error before claiming success.",
    );
  }
  return lines.join("\n");
}

function activeNonHardConstraints(state: CanonicalLoopState): string[] {
  const hard = new Set(state.hardConstraints);
  return state.activeConstraints.filter((value) => !hard.has(value));
}

function commonMandatorySections(
  state: CanonicalLoopState,
  /** v2.11: L0 skips ID rendering to stay within tight budget. */
  level?: "l0" | "l1" | "l2",
): Section[] {
  const sections: Section[] = [
    {
      id: "objective",
      text: section("Objective", state.objective),
      mandatory: true,
    },
    {
      id: "current_task",
      text: section("Current Task", state.currentTask),
      mandatory: true,
    },
  ];

  if (state.hardConstraints.length > 0) {
    // v2.11: L0 uses plain bullets (tight budget); L1/L2 show constraint IDs
    const body = level === "l0"
      ? bullets(state.hardConstraints)
      : bulletsWithIds(state.hardConstraints, "c");
    sections.push({
      id: "hard_constraints",
      text: section("Active Hard Constraints", body),
      mandatory: true,
    });
  }
  if (state.verificationFlags.length > 0) {
    sections.push({
      id: "verification",
      text: section("Verification Gate", verificationText(state)),
      mandatory: true,
    });
  }
  return sections;
}

function l0Sections(state: CanonicalLoopState): Section[] {
  const retryRequirements = [
    ...state.blockers,
    ...state.verificationFlags.map((flag) => flag.detail),
  ];
  const sections = commonMandatorySections(state, "l0");
  if (retryRequirements.length > 0) {    sections.push({
      id: "retry_requirements",
      text: section("Retry Requirements", bullets(retryRequirements)),
      mandatory: true,
    });
  }
  if (state.changesSinceLastRound.length > 0) {
    sections.push({
      id: "changes",
      text: section("New Evidence / Changes", bullets(state.changesSinceLastRound)),
      mandatory: false,
    });
  }
  return sections;
}

function l1Sections(state: CanonicalLoopState): Section[] {
  const sections = commonMandatorySections(state, "l1");
  const active = activeNonHardConstraints(state);
  if (state.changesSinceLastRound.length > 0) {
    sections.push({
      id: "changes",
      text: section("Changes Since Last Round", bullets(state.changesSinceLastRound)),
      mandatory: false,
    });
  }
  if (active.length > 0) {
    sections.push({
      id: "active_constraints",
      text: section("Active Constraints / Success Criteria", bulletsWithIds(active, "c")),
      mandatory: false,
    });
  }
  if (state.remainingCriteria.length > 0) {
    sections.push({
      id: "remaining",
      text: section("Remaining", bulletsWithIds(state.remainingCriteria, "cr")),
      mandatory: false,
    });
  }
  if (state.blockers.length > 0) {
    sections.push({
      id: "blockers",
      text: section("Blockers", bullets(state.blockers)),
      mandatory: false,
    });
  }
  // v2.2: Sub-Goal Dashboard (compact — L1)
  const activeSubs = state.subGoals.filter((sg) =>
    sg.status === "in_progress" || sg.status === "pending");
  if (activeSubs.length > 0) {
    const maxShow = 5;
    const items = activeSubs.slice(0, maxShow).map((sg) => {
      const icon = sg.status === "in_progress" ? "🔄" : "⏳";
      return `${icon} [\`${sg.id}\`] ${sg.description}`;
    });
    if (activeSubs.length > maxShow) {
      items.push(`... and ${activeSubs.length - maxShow} more`);
    }
    sections.push({
      id: "sub_goals",
      text: section("Active Sub-Goals", items.join("\n")),
      mandatory: false,
    });
  }
  if (state.discoveries.length > 0) {
    sections.push({
      id: "discoveries",
      text: section("New Discoveries", bullets(state.discoveries)),
      mandatory: false,
    });
  }
  if (state.rollingOutcomes.length > 0) {
    sections.push({
      id: "rolling_outcomes",
      text: section("Recent Rounds", bullets(state.rollingOutcomes)),
      mandatory: false,
    });
  }
  if (state.recurringIssues.length > 0) {
    sections.push({
      id: "recurring_issues",
      text: section("Recurring Issues", bullets(state.recurringIssues)),
      mandatory: false,
    });
  }
  if (state.nextAction) {
    sections.push({
      id: "next_action",
      text: section("Next Action", state.nextAction),
      mandatory: false,
    });
  }
  return sections;
}

function l2Sections(
  state: CanonicalLoopState,
  fullStateMarkdown?: string,
): Section[] {
  const sections = commonMandatorySections(state, "l2");
  const fullState = fullStateMarkdown?.trim();
  if (fullState) {
    sections.push({
      id: "full_state",
      text: section("Full Rehydrated State", fullState),
      mandatory: false,
    });
    return sections;
  }

  // v2.11: Groups with an idPrefix use ID-aware rendering; others use plain bullets.
  const groups: Array<[string, string, string[], string | null]> = [
    ["success_criteria", "Success Criteria", state.successCriteria, "cr"],
    ["active_constraints", "Active Constraints", activeNonHardConstraints(state), "c"],
    ["changes", "Changes Since Last Round", state.changesSinceLastRound, null],
    ["remaining", "Remaining", state.remainingCriteria, "cr"],
    ["blockers", "Blockers", state.blockers, null],
    ["discoveries", "Discoveries", state.discoveries, null],
    ["rolling_outcomes", "Cross-Round Outcomes", state.rollingOutcomes, null],
    ["recurring_issues", "Recurring Issues", state.recurringIssues, null],
    ["failed_patterns", "Failed Patterns", state.failedPatterns, null],
  ];
  for (const [id, title, values, idPrefix] of groups) {
    if (values.length > 0) {
      const body = idPrefix
        ? bulletsWithIds(values, idPrefix)
        : bullets(values);
      sections.push({ id, text: section(title, body), mandatory: false });
    }
  }
  if (state.milestones.length > 0) {
    const milestoneText = state.milestones
      .map((m) => {
        const kindIcon = m.kind === "agent_declared"
          ? "🏁"
          : m.kind === "criteria_milestone" ? "✅" : "📍";
        const lines = [
          `**${kindIcon} ${m.label}** (Rounds ${m.round_range.start}–${m.round_range.end}, ${(m.progress_at_boundary * 100).toFixed(0)}%)`,
          `  Outcome: ${m.outcome}`,
        ];
        if (m.resolved_constraints.length > 0) {
          lines.push(`  Resolved: ${m.resolved_constraints.slice(0, 3).join("; ")}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
    sections.push({
      id: "milestones",
      text: section("Phase History", milestoneText),
      mandatory: false,
    });
  }
  if (state.subGoals.length > 0) {
    const lines: string[] = [];
    // In progress
    const inProgress = state.subGoals.filter((sg) => sg.status === "in_progress");
    for (const sg of inProgress) {
      lines.push(`🔄 [\`${sg.id}\`] ${sg.description} (since R${sg.status_changed_at_round})`);
    }
    // Pending (by age)
    const pending = state.subGoals.filter((sg) => sg.status === "pending");
    const shownPending = pending.slice(0, 10);
    for (const sg of shownPending) {
      const age = state.round - sg.declared_at_round;
      const stale = age >= 10 ? " ⚠️ stale" : "";
      lines.push(`⏳ [\`${sg.id}\`] ${sg.description} (pending ${age} rounds)${stale}`);
    }
    if (pending.length > 10) {
      lines.push(`... and ${pending.length - 10} more pending`);
    }
    // Blocked
    const blocked = state.subGoals.filter((sg) => sg.status === "blocked");
    for (const sg of blocked) {
      lines.push(`🚫 [\`${sg.id}\`] ${sg.description} (blocked since R${sg.status_changed_at_round})`);
    }
    // Recently done
    const done = state.subGoals.filter((sg) => sg.status === "done");
    const recentDone = done.slice(0, 5);
    for (const sg of recentDone) {
      lines.push(`✅ [\`${sg.id}\`] ${sg.description} (done R${sg.completed_at_round ?? sg.status_changed_at_round})`);
    }
    if (done.length > 5) {
      lines.push(`... and ${done.length - 5} more completed`);
    }
    // Stats line
    const total = state.subGoals.length;
    const doneCount = done.length;
    const canceledCount = state.subGoals.filter((sg) => sg.status === "canceled").length;
    const activeCount = inProgress.length + pending.length + blocked.length;
    lines.push(`─── ${total} total: ${activeCount} active, ${doneCount} done, ${canceledCount} canceled`);

    sections.push({
      id: "sub_goals_full",
      text: section("Sub-Goal Dashboard", lines.join("\n")),
      mandatory: false,
    });
  }
  if (state.loopSynthesis) {
    sections.push({
      id: "loop_synthesis",
      text: section("Loop Summary", state.loopSynthesis),
      mandatory: false,
    });
  }
  if (state.nextAction) {
    sections.push({
      id: "next_action",
      text: section("Next Action", state.nextAction),
      mandatory: false,
    });
  }
  if (state.externalContext) {
    sections.push({
      id: "external_context",
      text: section("External Context", state.externalContext),
      mandatory: false,
    });
  }

  // ── v2.8: Path B gap fills (previously only in full state markdown) ──

  // Progress Dashboard
  if (
    state.progress.estimate !== null ||
    state.progress.criteriaMet.length > 0 ||
    state.progress.criteriaRemaining.length > 0 ||
    state.progress.filesChanged.length > 0 ||
    state.progress.tests !== null
  ) {
    const lines: string[] = [];
    const total = state.progress.criteriaMet.length + state.progress.criteriaRemaining.length;
    if (total > 0) {
      lines.push(`**Criteria**: ${state.progress.criteriaMet.length}/${total} met`);
    }
    if (state.progress.estimate !== null) {
      lines.push(`**Estimated Completion**: ${(state.progress.estimate * 100).toFixed(0)}%`);
    }
    if (state.progress.tests) {
      lines.push(
        `**Tests**: ${state.progress.tests.passed} passed, ` +
        `${state.progress.tests.failed} failed, ${state.progress.tests.skipped} skipped`,
      );
    }
    if (state.progress.filesChanged.length > 0) {
      lines.push("**Files Changed**:");
      for (const f of state.progress.filesChanged.slice(0, 10)) lines.push(`- ${f}`);
      if (state.progress.filesChanged.length > 10) {
        lines.push(`- ... and ${state.progress.filesChanged.length - 10} more`);
      }
    }
    sections.push({
      id: "progress",
      text: section("Progress Dashboard", lines.join("\n")),
      mandatory: false,
    });
  }

  // Retired Constraints
  if (state.retiredConstraints.length > 0) {
    const lines = state.retiredConstraints.map((c) => `- ~${c}~ (retired)`);
    sections.push({
      id: "retired_constraints",
      text: section("Retired Constraints", lines.join("\n")),
      mandatory: false,
    });
  }

  // Inactive Constraints (with decay metadata)
  if (state.inactiveConstraints.length > 0) {
    const lines: string[] = [
      "> Demoted after prolonged inactivity. Auto-reactivated if violated again.",
      "",
    ];
    for (const c of state.inactiveConstraints) {
      const meta = state.constraintMetadata.find((m) => m.text === c);
      const age = meta
        ? state.round - (meta.last_violated_at_round || meta.discovered_at_round || 0)
        : "?";
      const lastV = meta?.last_violated_at_round
        ? `last violated R${meta.last_violated_at_round}`
        : "never violated";
      lines.push(`- ${c} (${lastV}, ${age} rounds inactive)`);
    }
    sections.push({
      id: "inactive_constraints",
      text: section("Inactive Constraints", lines.join("\n")),
      mandatory: false,
    });
  }

  // Agent Trust Score + Trend
  if (state.agentTrustScore !== undefined) {
    const barLen = 10;
    const filled = Math.round(state.agentTrustScore * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const lines = [
      `${bar} ${(state.agentTrustScore * 100).toFixed(0)}%`,
    ];
    if (state.agentTrustTrend.length > 0) {
      const avg = (state.agentTrustTrend.reduce((a, b) => a + b, 0)
        / state.agentTrustTrend.length).toFixed(2);
      lines.push(
        `Trend (last ${state.agentTrustTrend.length}): ${state.agentTrustTrend.join(" → ")}`,
      );
      lines.push(`Average: ${avg}`);
    }
    sections.push({
      id: "agent_trust",
      text: section("Agent Trust", lines.join("\n")),
      mandatory: false,
    });
  }

  return sections;
}

function selectSections(input: PromptAssemblyInput): Section[] {
  if (input.mode === "full") {
    return l2Sections(input.state, input.fullStateMarkdown);
  }
  if (input.level === "l0") return l0Sections(input.state);
  if (input.level === "l1") return l1Sections(input.state);
  return l2Sections(input.state, input.fullStateMarkdown);
}

function renderWithinBudget(
  sections: Section[],
  fixedText: string,
  budget: number,
): { rendered: string; included: string[] } {
  const mandatory = sections.filter((item) => item.mandatory);
  const optional = sections.filter((item) => !item.mandatory);
  let rendered = fixedText + mandatory.map((item) => item.text).join("");
  const included = mandatory.filter((item) => item.text).map((item) => item.id);

  for (const item of optional) {
    if (!item.text) continue;
    if (rendered.length + item.text.length <= budget) {
      rendered += item.text;
      included.push(item.id);
    }
  }
  return { rendered, included };
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.9: Prompt Requests — model-expressed information needs
// ═══════════════════════════════════════════════════════════════════════════

/** Match a free-text emphasis target against state items.
 *  v2.11: ID-first matching. When a target is an ID (c-/cr-/sg-XXXXXXXX),
 *  candidates that derive to the same ID get score 1.0. Falls back to
 *  Jaccard similarity otherwise. */
function matchEmphasize(
  targets: string[],
  candidates: string[],
  cap: number,
): string[] {
  if (targets.length === 0 || candidates.length === 0) return [];
  const idRegex = /^(c|cr|sg)-[a-f0-9]{8}$/;
  const scored = candidates.map((c) => {
    let best = 0;
    for (const t of targets) {
      let s = 0;
      // Phase 1: exact ID match (v2.11)
      const idMatch = t.match(idRegex);
      if (idMatch) {
        const candidateId = idMatch[1] + "-" + deriveItemId(c);
        if (candidateId === t) s = 1.0;
      }
      // Phase 2: Jaccard fallback
      if (s === 0) s = jaccardSimilarity(t, c);
      if (s > best) best = s;
    }
    return { text: c, score: best };
  });
  return scored
    .filter((e) => e.score >= getPolicy().evolution.constraint_match_threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((e) => e.text);
}

/** Render the "Confusion Alerts" section that appears at the prompt top.
 *  Compiler auto-matches each confusion point against state sections. */
function renderConfusionAlerts(
  points: string[],
  state: CanonicalLoopState,
  expandAll: boolean,
): string {
  if (points.length === 0) return "";
  const lines: string[] = [
    "## ⚠️ Confusion Alerts",
    "",
    "You flagged these as confusing in the previous round.",
    "Address each before proceeding — the state file has full context.",
    "",
  ];
  const sections: Array<{ keyword: string; label: string; ref: string }> = [
    { keyword: "milestone", label: "Phase History", ref: "## Phase History" },
    { keyword: "sub-goal", label: "Sub-Goal Dashboard", ref: "## Sub-Goal Dashboard" },
    { keyword: "constraint", label: "Active Constraints / Constraint Lifecycle", ref: "## Active Constraints" },
    { keyword: "trust", label: "Agent Trust", ref: "## Agent Trust" },
    { keyword: "progress", label: "Progress Dashboard", ref: "## Progress Dashboard" },
    { keyword: "criteria", label: "Success Criteria", ref: "## Success Criteria" },
    { keyword: "phase", label: "Phase History", ref: "## Phase History" },
    { keyword: "objective", label: "Loop Objective", ref: "## Loop Objective" },
    { keyword: "loop", label: "Loop Summary", ref: "## Loop Summary" },
  ];

  const shown = expandAll ? points : points.slice(0, 1);
  for (const point of shown) {
    const truncated = point.length > 200 ? point.slice(0, 197) + "…" : point;
    // Find best-matching state section
    let bestSection: typeof sections[0] | null = null;
    let bestScore = 0;
    for (const sec of sections) {
      const score = jaccardSimilarity(truncated.toLowerCase(), sec.keyword);
      if (score > bestScore) { bestScore = score; bestSection = sec; }
    }
    const pointer = bestSection && bestScore >= 0.15
      ? `→ Check **${bestSection.label}** (\`${bestSection.ref}\`) in the state file.`
      : "→ Read the full state file for relevant context.";
    lines.push(`- **"${truncated}"**`);
    lines.push(`  ${pointer}`);
    lines.push("");
  }

  if (!expandAll && points.length > 1) {
    lines.push(`*… and ${points.length - 1} more confusion point(s) — see state file.*`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Render the "Critical Context" section — items the model emphasized.
 *  Pulled from active constraints, discoveries, and blocking issues. */
function renderCriticalContext(
  emphasized: string[],
  state: CanonicalLoopState,
): string {
  if (emphasized.length === 0) return "";
  const lines: string[] = [
    "## 🔴 Critical Context",
    "",
    "You flagged these as important for this round. Prioritize them.",
    "",
  ];
  for (const item of emphasized) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Expand a specific section to L2-level detail within a L1 prompt.
 *  Returns the expanded section text, or empty string if the section
 *  has no content to expand. */
function renderExpandedSection(
  sectionName: NonNullable<PromptRequests["expand"]>[number],
  state: CanonicalLoopState,
): string {
  switch (sectionName) {
    case "milestones": {
      if (state.milestones.length === 0) return "";
      const text = state.milestones
        .map((m) => {
          const icon = m.kind === "agent_declared" ? "🏁" : m.kind === "criteria_milestone" ? "✅" : "📍";
          const lines = [
            `**${icon} ${m.label}** (R${m.round_range.start}–R${m.round_range.end}, ${(m.progress_at_boundary * 100).toFixed(0)}%)`,
            `  Outcome: ${m.outcome}`,
          ];
          if (m.carried_constraints.length > 0) lines.push(`  Carried: ${m.carried_constraints.slice(0, 3).join("; ")}`);
          if (m.resolved_constraints.length > 0) lines.push(`  Resolved: ${m.resolved_constraints.slice(0, 3).join("; ")}`);
          return lines.join("\n");
        })
        .join("\n\n");
      return section("Expanded Phase History", text);
    }
    case "sub_goals": {
      if (state.subGoals.length === 0) return "";
      const lines: string[] = [];
      for (const sg of state.subGoals) {
        const icon =
          sg.status === "in_progress" ? "🔄" :
          sg.status === "done" ? "✅" :
          sg.status === "blocked" ? "🚫" :
          sg.status === "canceled" ? "❌" : "⏳";
        const stale = sg.status === "pending" && state.round - sg.declared_at_round >= 10 ? " ⚠️ stale" : "";
        const detail = sg.status === "done" && sg.completed_at_round
          ? ` (done, R${sg.completed_at_round})`
          : sg.status === "in_progress" ? ` (since R${sg.status_changed_at_round})`
          : sg.status === "pending" ? ` (since R${sg.declared_at_round})`
          : sg.status === "blocked" ? ` (blocked R${sg.status_changed_at_round})`
          : ` (canceled R${sg.status_changed_at_round})`;
        lines.push(`- ${icon} [\`${sg.id}\`] ${sg.description}${detail}${stale}`);
      }
      return section("Expanded Sub-Goal Dashboard", lines.join("\n"));
    }
    case "constraint_lifecycle": {
      if (state.inactiveConstraints.length === 0 && state.retiredConstraints.length === 0) return "";
      const lines: string[] = [];
      if (state.inactiveConstraints.length > 0) {
        lines.push("**Inactive (auto-decayed):**");
        for (const c of state.inactiveConstraints) {
          const meta = state.constraintMetadata.find((m) => m.text === c);
          const age = meta ? state.round - (meta.last_violated_at_round || meta.discovered_at_round || 0) : "?";
          lines.push(`- ${c} (${age} rounds inactive)`);
        }
      }
      if (state.retiredConstraints.length > 0) {
        lines.push("**Retired:**");
        for (const c of state.retiredConstraints) lines.push(`- ~${c}~`);
      }
      return section("Constraint Lifecycle", lines.join("\n"));
    }
    case "agent_trust": {
      if (state.agentTrustScore === undefined) return "";
      const barLen = 10;
      const filled = Math.round(state.agentTrustScore * barLen);
      const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
      const lines = [
        `${bar} ${(state.agentTrustScore * 100).toFixed(0)}%`,
      ];
      if (state.agentTrustTrend.length > 0) {
        lines.push(`Trend: ${state.agentTrustTrend.join(" → ")}`);
      }
      return section("Agent Trust (Expanded)", lines.join("\n"));
    }
    case "progress": {
      const p = state.progress;
      if (p.estimate === null && p.criteriaMet.length === 0 && p.criteriaRemaining.length === 0) return "";
      const lines: string[] = [];
      const total = p.criteriaMet.length + p.criteriaRemaining.length;
      if (total > 0) lines.push(`**Criteria**: ${p.criteriaMet.length}/${total} met`);
      if (p.estimate !== null) lines.push(`**Estimate**: ${(p.estimate * 100).toFixed(0)}%`);
      if (p.tests) lines.push(`**Tests**: ${p.tests.passed} passed, ${p.tests.failed} failed, ${p.tests.skipped} skipped`);
      if (p.filesChanged.length > 0) {
        lines.push("**Files Changed**:");
        for (const f of p.filesChanged.slice(0, 10)) lines.push(`- ${f}`);
      }
      return section("Progress Dashboard (Expanded)", lines.join("\n"));
    }
    case "loop_synthesis": {
      if (!state.loopSynthesis) return "";
      return section("Loop Summary", state.loopSynthesis);
    }
    default:
      return "";
  }
}

export function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact {
  const mode = input.mode ?? "adaptive";
  const budgets = { ...DEFAULT_PROMPT_BUDGETS, ...input.budgets };
  const budget = budgets[input.level];
  const stateHash = hashCanonicalState(input.state);
  const attempt = Math.max(1, input.attempt ?? 1);
  // ── State file reference + conditional read instruction ────────────
  // L2 rounds (full rehydration), recovery, rejection, drift, and pointer
  // mode all benefit from the model reading the durable state file rather
  // than relying on potentially-compacted conversation history.
  const fullContextReasons = new Set([
    "first_round", "plan_boundary", "checkpoint_boundary", "goal_changed",
    "missing_previous_state", "verification_contradicted",
    "rejection_rehydrate", "recovery_boundary", "state_drift",
    "periodic_refresh",
  ]);
  const needsFullContext = input.level === "l2"
    || input.mode === "pointer"
    || input.reasons.some((r) => fullContextReasons.has(r));

  const stateFilePath = input.state.stateFilePath;
  const stateFileRef = stateFilePath
    ? `📄 Full state: \`${stateFilePath}\`\n`
    : "";
  const readInstruction = needsFullContext && stateFilePath
    ? [
        "",
        "> ⚠️ **Read the full state file before acting.** The summary below is a",
        "> capsule. The durable state file contains complete phase history,",
        "> sub-goal dashboard, constraint lifecycle, and agent trust data.",
        "> Conversation history may be incomplete after compaction or session",
        "> resume — the state file is the source of truth.",
        "",
      ].join("\n")
    : "";

  const header = [
    `## LoopForge Round ${input.state.round}`,
    `State: ${stateHash.slice(0, 12)} | Level: ${input.level.toUpperCase()} | Attempt: ${attempt}`,
    stateFileRef,
    readInstruction,
    "",
  ].join("\n");

  const sections = selectSections(input);
  const pointer = stateFilePath
    ? section("Full State", stateFilePath)
    : "";
  const evaluation = input.selfEvaluationBlock.trim()
    ? `${input.selfEvaluationBlock.trim()}\n`
    : "";
  const howToRespond = [
    "## How to Complete This Round",
    "",
    "1. Execute the task described above. Do NOT generate another prompt or plan — act.",
    "2. When finished, call the MCP tool **`loopforge_next`** with these parameters:",
    "   - `sessionId`: the session ID from `loopforge_start`.",
    "   - `evaluation`: a structured self-assessment object (see schema below).",
    "",
    "### Evaluation Rules",
    "",
    "- `success`: Set to **`true` ONLY** when ALL hard constraints are met AND",
    "  the task goal is fully achieved. If anything remains incomplete, set `false`.",
    "- `should_continue`: Set to **`false` ONLY** when the ENTIRE loop task is done.",
    "  Partial progress or completed subtasks → `true`.",
    "- `constraint_violations`: Be honest. List every constraint you actually violated.",
    "- `execution_evidence.files_changed`: List files you modified — used for verification.",
    "- `execution_evidence.test_results`: Report actual test runner output.",
    "- `progress_estimate`: A number 0.0–1.0 reflecting overall task completion.",
    "",
    "### If the Prompt Says \"REJECTED\"",
    "",
    "- Re-execute the **same round**. Do NOT advance the round counter.",
    "- Read the Required Fix section, address every issue, then submit again.",
    "- Use `loopforge_next` with a corrected evaluation.",
    "",
    evaluation,
  ].join("\n");

  const footer = [pointer, howToRespond].join("");

  // ── v2.9: Prompt Requests — model-expressed information needs ──────────
  const pr = input.promptRequests;
  const levelIsL0 = input.level === "l0";
  const levelIsL1 = input.level === "l1";
  const levelIsL2 = input.level === "l2";

  // Confusion alerts: L1/L2 only, rendered at the top (before mandatory sections)
  const confusionText = (!levelIsL0 && pr?.confusion_points?.length)
    ? renderConfusionAlerts(pr.confusion_points, input.state, levelIsL2)
    : "";

  // Emphasize: L1/L2 only, matched against active state items
  const policy = getPolicy().prompt;
  const emphasizeCap = levelIsL2 ? policy.max_emphasize_l2 : policy.max_emphasize_l1;
  const emphasized = (!levelIsL0 && pr?.emphasize?.length)
    ? matchEmphasize(
        pr.emphasize,
        [
          ...input.state.activeConstraints,
          ...input.state.discoveries,
          ...input.state.blockers,
          ...input.state.changesSinceLastRound,
        ],
        emphasizeCap,
      )
    : [];
  const criticalContextText = renderCriticalContext(emphasized, input.state);

  // Expand: L1 only, max 1 section (L2 already expanded, L0 ignored)
  const expandCap = levelIsL1 ? policy.max_expand_l1 : 0;
  const expandedSection = (pr?.expand?.length && expandCap > 0)
    ? renderExpandedSection(pr.expand[0], input.state)
    : "";

  // Inject confusion alerts into the header area (before mandatory sections)
  const fixedText = header + confusionText;

  // Inject critical context as a mandatory section
  let augmentedSections = sections;
  if (criticalContextText) {
    augmentedSections = [
      {
        id: "critical_context",
        text: criticalContextText,
        mandatory: true,
      },
      ...sections,
    ];
  }

  const selected = mode === "pointer"
    ? renderWithinBudget(
        augmentedSections.filter((item) => item.mandatory),
        fixedText,
        budget,
      )
    : renderWithinBudget(augmentedSections, fixedText, budget - footer.length - expandedSection.length);
  const renderedPrompt = selected.rendered + expandedSection + footer;
  const includedSections = [
    ...selected.included,
    ...(confusionText ? ["confusion_alerts"] : []),
    ...(criticalContextText ? ["critical_context"] : []),
    ...(expandedSection ? [`expand:${pr?.expand?.[0] ?? ""}`] : []),
    ...(pointer ? ["state_pointer"] : []),
    ...(evaluation ? ["self_evaluation"] : []),
  ];
  const promptHash = createHash("sha256").update(renderedPrompt).digest("hex");

  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: `loop:${input.state.loopId}:round:${input.state.round}`,
    attempt,
    level: input.level,
    levelReasons: [...input.reasons],
    renderedPrompt,
    promptHash,
    stateHash,
    basePromptVersion: BASE_PROMPT_VERSION,
    includedSections,
    budgetChars: budget,
    charCount: renderedPrompt.length,
    budgetExceeded: renderedPrompt.length > budget,
    generatedAt: Date.now(),
  };
}
