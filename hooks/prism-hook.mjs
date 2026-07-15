#!/usr/bin/env node
// PRISM v2.1.24 Hook — UserPromptSubmit
// Stdout from this hook is added as context Claude sees.
//
// v2.1.24 (2026-04-20): gap-closure pass
//   - GLOBAL turn counter (session-id keyed) so /clear reminders survive
//     project switches within a session. Project-local state kept for
//     backward compat with /prism-plan & /prism-discover.
//   - Trivial-work cost advisory: if N consecutive turns pass with no
//     INVOCATION pattern hit, suggest Sonnet/Haiku to reduce spend.
//   - Expanded trigger patterns: trivial edits → Haiku, implementation →
//     Sonnet subagent, performance, refactor-cleanup, explicit delegation.

import {readFileSync as r, writeFileSync as w, existsSync as e, mkdirSync as mk} from 'fs';
import {join as j} from 'path';
// Phase 1.3 + v5.2.1: KB router and pasted-content classifier loaded in parallel
// (E-P1: serial cold-start ≈380ms → parallel cold-start ≈190ms).
// Each import degrades gracefully if the lib is absent — the outer try/catch
// covers both; variable defaults ensure fallthrough behaviour is unchanged.
let routeQuery = null, formatRouterHint = null;
let stripPastedContent = (s) => s, pastedRatio = () => 0;
try {
  const [router, tc] = await Promise.all([
    import(new URL('./lib/prism-router.mjs', import.meta.url).href),
    import(new URL('../tools/lib/prism-tier-classify.mjs', import.meta.url).href),
  ]);
  routeQuery = router.routeQuery;
  formatRouterHint = router.formatRouterHint;
  if (typeof tc.stripPastedContent === 'function') stripPastedContent = tc.stripPastedContent;
  if (typeof tc.pastedRatio === 'function') pastedRatio = tc.pastedRatio;
} catch {}

export async function run(payload, ctx = {}) {
  try {
  const input = payload || {};
  const prompt = (input.prompt || '');
  const promptLC = prompt.toLowerCase().trim();
  // v5.2.1: skill/MCP/router NUDGE matching runs on the user's OWN words. When the
  // prompt is dominated by pasted/quoted transcript content (a /prism-* result
  // paste), strip it so pasted vocabulary doesn't fire TDD/debug/worktree/MCP/
  // router nudges. Extends the v5.1.7 panel-summon dampening to this hook.
  const ownPrompt = pastedRatio(prompt) >= 0.6 ? stripPastedContent(prompt) : prompt;
  const ownPromptLC = ownPrompt.toLowerCase().trim();
  const sessionId = input.session_id || 'no-session';
  const H = process.env.HOME || process.env.USERPROFILE;
  let messages = [];

  // ── Project-local turn-counter state ──
  // MUST be .prism-turn-state.json, NOT .prism-state.json — the latter is the
  // bootstrap state machine (tools/lib/prism-state.mjs). Sharing the filename
  // polluted/clobbered bootstrap state (v5.1.3 UAT fix).
  const sf = j(process.cwd(), '.claude', '.prism-turn-state.json');
  let state = {turns: 0, session_start: new Date().toISOString(), recent_suggestions: {}};
  try { if (e(sf)) state = JSON.parse(r(sf, 'utf-8')); } catch {}
  state.turns = (state.turns || 0) + 1;
  state.recent_suggestions = state.recent_suggestions || {};

  // ── Global session state (Gap 3) ──
  const gsf = j(H, '.claude', '.prism-global-state.json');
  let gstate = {sessions: {}};
  try { if (e(gsf)) gstate = JSON.parse(r(gsf, 'utf-8')); } catch {}
  gstate.sessions = gstate.sessions || {};
  const gs = gstate.sessions[sessionId] || {
    session_start: new Date().toISOString(),
    turns: 0,
    projects_visited: [],
    trivial_streak: 0,
    last_invocation_turn: 0,
    cost_budget_warned_at: 0,
  };
  gs.turns = (gs.turns || 0) + 1;
  const cwdName = (process.cwd().split(/[/\\]/).pop()) || 'unknown';
  if (!gs.projects_visited.includes(cwdName)) gs.projects_visited.push(cwdName);
  gstate.sessions[sessionId] = gs;
  const turn = gs.turns;  // global turn is authoritative for /clear reminders

  const shouldSuggest = (key, cooldown = 5) => ((turn - (state.recent_suggestions[key] || -999)) > cooldown);
  const recordSuggestion = (key) => { state.recent_suggestions[key] = turn; gs.last_invocation_turn = turn; };

  // ── First-prompt checks ──
  if (turn === 1) {
    try {
      const lp = j(H, '.claude', 'skills', 'prism-plan', 'references', 'update-log.json');
      if (e(lp)) {
        const log = JSON.parse(r(lp, 'utf-8'));
        if (log.next_scheduled_update && new Date() >= new Date(log.next_scheduled_update))
          messages.push('PRISM NOTICE: Update is due. Run /prism-update when ready.');
      }
    } catch {}
    try {
      const pcmd = j(process.cwd(), 'CLAUDE.md');
      if (!e(pcmd)) messages.push('PRISM NOTICE: No project CLAUDE.md found. Run /prism-bootstrap to set up project identity.');
    } catch {}
  }

  // ── /clear reminders (global turn) ──
  if (turn === 15) messages.push('PRISM NOTICE: Session at 15 turns. Run /clear for fresh context.');
  else if (turn === 20) messages.push('PRISM NOTICE: Session at 20 turns. Strongly recommend /clear.');
  else if (turn >= 30 && (turn % 10 === 0)) messages.push(`PRISM NOTICE: Session at ${turn} turns. /clear is overdue — context may be degrading.`);

  // ── Discovery hint (existing) ──
  if (/\b(read my database|scan.*codebase|map.*api|discover|index.*schema)\b/i.test(ownPrompt) && shouldSuggest('discovery_skill', 10)) {
    messages.push('PRISM NOTICE: This looks like a discovery operation. The prism-discover skill should be used.');
    recordSuggestion('discovery_skill');
  }

  // ── False-positive suppression for content-ABOUT-topic ──
  const contentAbout = /\b(write|draft|create|compose|generate)\s+(a|an|the)?\s*(blog|post|article|tutorial|guide|essay|explanation|overview|intro|summary|doc|documentation)\b/i.test(ownPrompt)
    || /\b(what is|explain|tell me about|overview of|intro to)\b/i.test(ownPromptLC);

  let matchedInvocation = false;

  if (!contentAbout) {
    // ─── TIER 1 — SUPERPOWERS ───
    const tdd_strong = /\b(test.?driven|\bTDD\b|red.?green|write tests? first|tests? first|with proper tests?|properly tested|test coverage|production.?ready)\b/i;
    if (tdd_strong.test(ownPrompt) && shouldSuggest('superpowers_tdd')) {
      messages.push("PRISM: Test-driven work — superpowers is installed, invoke its test-driven-development skill.");
      recordSuggestion('superpowers_tdd'); matchedInvocation = true;
    }

    const debug_strong = /\b(debug(ging)?|root cause|systematic debug|can.?t figure (it )?out|don.?t know what.?s (wrong|happening)|why (is|isn.?t|won.?t) this|keeps (crashing|failing)|intermittent)\b/i;
    const debug_stuck = /\b(been (trying|stuck|debugging)|for (hours?|days?))\b/i;
    if ((debug_strong.test(ownPrompt) || debug_stuck.test(ownPrompt)) && shouldSuggest('superpowers_debug')) {
      messages.push("PRISM: Debugging work — superpowers is installed, invoke its systematic-debugging skill (4-phase root cause).");
      recordSuggestion('superpowers_debug'); matchedInvocation = true;
    }

    const review_strong = /\b(code review|review (my|this) code|check my code|before (I )?(ship|commit|push|PR)|PR review|refactor this|clean (this )?up)\b/i;
    const review_lang = /\b(typescript|python|go\s+code|java|kotlin|rust|swift|php|perl|c\+\+|ruby)\b/i;
    if (review_strong.test(ownPrompt) && !review_lang.test(ownPrompt) && shouldSuggest('superpowers_review')) {
      messages.push("PRISM: Code review — superpowers is installed, invoke its requesting-code-review skill.");
      recordSuggestion('superpowers_review'); matchedInvocation = true;
    }

    const worktree = /\b(git worktree|parallel branches?|isolate this branch|worktree)\b/i;
    if (worktree.test(ownPrompt) && shouldSuggest('superpowers_worktree')) {
      messages.push("PRISM: Git worktree work — superpowers is installed, invoke its using-git-worktrees skill.");
      recordSuggestion('superpowers_worktree'); matchedInvocation = true;
    }

    // ─── TIER 2 (conditional) — ECC ───
    const ecc_langs = /\breview (my )?(typescript|python|go|java|kotlin|rust|swift|php|perl|c\+\+|ruby) code\b/i;
    const ecc_lang_general = /\b(typescript|python|go|java|kotlin|rust|swift|php|perl|c\+\+|ruby) (code review|lint)\b/i;
    if ((ecc_langs.test(ownPrompt) || ecc_lang_general.test(ownPrompt)) && shouldSuggest('ecc_lang_reviewer')) {
      const m = ownPrompt.match(/\b(typescript|python|go|java|kotlin|rust|swift|php|perl|c\+\+|ruby)\b/i);
      const lang = m ? m[0].toLowerCase() : 'language';
      messages.push(`PRISM: ${lang} review — if ECC is installed, invoke @${lang}-reviewer. Otherwise dispatch a Sonnet subagent with explicit ${lang}-specific review criteria.`);
      recordSuggestion('ecc_lang_reviewer'); matchedInvocation = true;
    }

    const security = /\b(security (scan|audit)|check for vulnerabilities?|OWASP|CVE|secrets in my config|exposed credentials|vulnerabilit(y|ies))\b/i;
    if (security.test(ownPrompt) && shouldSuggest('ecc_security')) {
      messages.push("PRISM: Security audit — run /prism-audit for built-in PRISM hygiene (grep-based secret scan, MCP endpoint check). For deeper OWASP/CVE coverage, ECC's AgentShield is Tier 2 — install via /prism-recommend only if needed.");
      recordSuggestion('ecc_security'); matchedInvocation = true;
    }

    // ─── TIER 1 — UI-UX-PRO-MAX ───
    const design_strong = /\b(design system|component library|landing page|dashboard design|mobile (app )?UI|mobile (app )?design|color palette|color scheme|typography|font pairing|what (colors?|fonts?).+(should|to use)|style guide)\b/i;
    const design_styles = /\b(glassmorphism|neumorphism|claymorphism|brutalism|bento (grid|box)|minimalism)\b/i;
    const design_reference = /\b(similar to|like) (notion|linear|stripe|apple|airbnb|figma|vercel|arc browser)\b/i;
    const design_visual = /\b(make (it|this) look (good|nice|professional|beautiful|modern|polished)|polish the (UI|design)|make it (look )?(prettier|sleek|stylish))\b/i;
    if ((design_strong.test(ownPrompt) || design_styles.test(ownPrompt) || design_reference.test(ownPrompt) || design_visual.test(ownPrompt)) && shouldSuggest('uiux_design')) {
      messages.push("PRISM: Design task — if ui-ux-pro-max is installed (Tier 1 companion), invoke its design engine (161 industry rules → pattern + palette + typography + anti-patterns). Otherwise run /prism-recommend to consider installation, or dispatch a Sonnet subagent with explicit design-system criteria.");
      recordSuggestion('uiux_design'); matchedInvocation = true;
    }

    // ─── TIER 2 (conditional) — BROWSER-USE ───
    const browser_form = /\b(fill (out|in) (this|the) (form|application)|submit (this|the) form|apply for (this|the )?(job|position|loan))\b/i;
    const browser_shop = /\b(book (a|the) (flight|hotel|appointment|reservation|table)|buy .+ online|order .+ online|shop(ping)? for .+ online)\b/i;
    const browser_scrape = /\b(scrape (the |this |a )?(site|website|page)|extract data from .+ (site|website|page)|find all .+ on .+ site)\b/i;
    const browser_auto = /\b(automate (a |the )?(browser|website)|browser automation|log into .+ and)\b/i;
    if ((browser_form.test(ownPrompt) || browser_shop.test(ownPrompt) || browser_scrape.test(ownPrompt) || browser_auto.test(ownPrompt)) && shouldSuggest('browseruse')) {
      messages.push("PRISM: Browser automation — if browser-use is installed, use Agent() + ChatBrowserUse(). Otherwise install via /prism-recommend (Tier 2, ~400 MB chromium) or use Playwright MCP.");
      recordSuggestion('browseruse'); matchedInvocation = true;
    }

    // ─── NEW: TRIVIAL-EDIT → HAIKU ROUTING (Gap enhancement) ───
    const trivial = /\b(fix (a |the )?typo|add (a )?comment|rename (this|the|a) (var|variable|function|method|class)|add (a )?docstring|delete (the |this )?(line|comment|var)|remove (the |this )?(comment|line|unused (import|var|variable))|one.?line (fix|change)|tweak (the )?(format|spacing)|adjust (the )?(indent|margin|padding)|change (the |this )?(string|label|title) to)\b/i;
    if (trivial.test(ownPrompt) && shouldSuggest('trivial_haiku', 8)) {
      messages.push("PRISM: Trivial edit detected — consider /model haiku (~15× cheaper than Opus) OR spawn a Haiku subagent via Agent() with model='haiku'. Parent Opus 4.7 is overkill here.");
      recordSuggestion('trivial_haiku'); matchedInvocation = true;
    }

    // ─── NEW: IMPLEMENTATION → SONNET SUBAGENT ROUTING ───
    const implementation = /\b(implement (this|a|the)|build (a|this|the) (feature|endpoint|function|script|module|helper)|add (a |the )?(endpoint|route|feature|function)|create (a |the )?(script|module|function|endpoint|component|helper)|write (a |the )?(function|script|module|helper|class))\b/i;
    if (implementation.test(ownPrompt) && shouldSuggest('impl_sonnet', 10)) {
      messages.push("PRISM: Implementation work — delegate to a Sonnet subagent via Agent(subagent_type='general-purpose', model='sonnet'). Keeps parent Opus free for orchestration (~5× cheaper for the implementation).");
      recordSuggestion('impl_sonnet'); matchedInvocation = true;
    }

    // ─── NEW: PERFORMANCE OPTIMIZATION ───
    const perf = /\b(optimize (this|the|performance)|make (it|this) (faster|quicker)|profile (the |this )?code|benchmark (this|the)|reduce (the )?(bundle size|memory|latency)|(this|it) (is|runs) slow|speed (this|it) up|N\+1 (problem|queries?)|slow SQL|slow query)\b/i;
    if (perf.test(ownPrompt) && shouldSuggest('perf_opt', 10)) {
      messages.push("PRISM: Performance work — dispatch a Sonnet subagent with an explicit profiling plan (measure → identify hotspot → optimize → re-measure). If ECC is installed, its @performance-optimizer agent is also available.");
      recordSuggestion('perf_opt'); matchedInvocation = true;
    }

    // ─── NEW: REFACTOR / DEAD-CODE CLEANUP ───
    const refactor_cleanup = /\b(remove dead code|find (dead|unused) code|dead.?code (cleanup|removal)|unused (imports?|dependencies|vars?)|find duplicates|consolidate (duplicate|similar) (code|functions?)|refactor (duplicates?|similar))\b/i;
    if (refactor_cleanup.test(ownPrompt) && shouldSuggest('refactor_clean', 10)) {
      messages.push("PRISM: Dead-code cleanup — dispatch a Sonnet subagent to run `knip`/`depcheck`/`ts-prune` directly. If ECC is installed, its @refactor-cleaner agent wraps these.");
      recordSuggestion('refactor_clean'); matchedInvocation = true;
    }

    // ─── NEW: EXPLICIT DELEGATION / PARALLEL ───
    const delegate = /\b(spawn (a |the )?subagent|delegate (this|it|the) to|run (these|them) in parallel|parallel (agents?|subagents?)|use a (haiku|sonnet|opus) (agent|subagent))\b/i;
    if (delegate.test(ownPrompt) && shouldSuggest('delegate', 3)) {
      messages.push("PRISM: Explicit delegation detected — use Agent() tool. Multiple independent subtasks → send in a single message with multiple Agent tool uses to parallelize.");
      recordSuggestion('delegate'); matchedInvocation = true;
    }

    // ─── NEW v2.7.1: PARALLEL-OPPORTUNITY DETECTOR ───
    // Detect obviously parallelizable patterns that aren't already caught by
    // the explicit-delegation block above. Nudges toward batched Agent()
    // dispatch in ONE assistant message (N parallel subagents, wall-clock =
    // max(each), not sum(each)). 5-turn cooldown.
    const parallel_enum     = /\b(these|each (of )?(the )?|all (of )?(the )?|both (of )?(the )?|every)\s*\d*\s*(files?|packages?|modules?|components?|tests?|endpoints?|repos?|PRs?|directories|services|functions?|classes|tables?|views?|queries|requests?|pages?|routes?|migrations?|scripts?)\b/i;
    // Broadened verb set (v5.3.1): everyday build/fix/refactor work over multiple
    // targets is just as parallelizable as scan/review work.
    const parallel_multi    = /\b(run|scan|read|index|analyze|review|test|check|verify|process|audit|validate|benchmark|profile|implement|build|write|create|fix|update|refactor|add|migrate|convert|generate|translate|format|lint|document|rename)\s+[^.?!]{0,80}\b(across|for each|for all|for every|on each|in each|over (all|each|every)|in (all|both))\b/i;
    const parallel_compare  = /\b(compare|contrast|A\/B|evaluate|benchmark)\s+[^.?!]{0,80}\b(vs\.?|versus|against)\b/i;
    const parallel_list     = /\b(research|investigate|explore|look into|evaluate)\s+[A-Z][a-z]+(,\s+[A-Z][a-z]+){1,}(,?\s+(and|or)\s+[A-Z][a-z]+)?\b/;
    const parallel_explicit = /\b(in parallel|concurrent(ly)?|simultaneously|at (the )?same time|side.?by.?side|one(-| )shot all)\b/i;
    // Two or more distinct file references in one prompt (v5.3.1): a strong
    // everyday signal that the same operation applies to independent files →
    // batchable. Soft nudge only; occasional over-fire is harmless.
    const fileExt = '(?:mjs|js|jsx|ts|tsx|py|md|json|ya?ml|toml|css|scss|less|html|go|rs|java|kt|rb|php|sql|sh|ps1|c|cpp|h|cs|swift)';
    const parallel_files    = new RegExp('\\b[\\w./-]+\\.' + fileExt + '\\b[\\s\\S]{0,140}?\\b[\\w./-]+\\.' + fileExt + '\\b', 'i');
    if (
      (parallel_enum.test(ownPrompt) || parallel_multi.test(ownPrompt) || parallel_compare.test(ownPrompt) || parallel_list.test(ownPrompt) || parallel_explicit.test(ownPrompt) || parallel_files.test(ownPrompt)) &&
      !delegate.test(ownPrompt) &&   // avoid double-firing with the explicit-delegation nudge
      shouldSuggest('parallel_opportunity', 2)
    ) {
      messages.push("PRISM: Parallelizable work detected. Dispatch as MULTIPLE Agent() tool uses in a SINGLE assistant message — they run concurrently (wall-clock = max(each), not sum(each)). Sequential Agent() calls are strictly slower. Recipe: one assistant message with N Agent() tool_use blocks, one per independent subtask, each with the minimum model that clears the bar (haiku for scan/extract, sonnet for implement/review, opus only for architecture).");
      recordSuggestion('parallel_opportunity'); matchedInvocation = true;
    }

    // ─── NEW v5.3.1: PLAN-FIRST / TASK-LIST DETECTOR ───
    // Medium-band multi-step work (3+ steps) that doesn't trip prism-plan's
    // narrow triggers tends to "go full ladder" — execute with no visible plan.
    // Nudge toward a task list first so progress is visible and steps aren't
    // skipped. Names the Task* tracking tools this build ships (TaskCreate /
    // TaskUpdate) AND keeps TodoWrite for builds that still expose that name —
    // the v5.3.1 nudge originally said only "TodoWrite", which is inert on builds
    // where the harness renamed it to Task* (no bullets ever rendered). Naming
    // both families keeps it working across machines (v5.7.1). Conservative:
    // fires only on clear multi-step markers. 3-turn cooldown. Soft (advice only).
    const plan_then     = /\b(first\b[\s\S]{0,120}?\bthen\b|then\b[\s\S]{0,100}?\b(then|after that|finally|lastly)\b)/i;
    const plan_numbered = /(^|\n)\s*1[.)]\s+\S[\s\S]{0,300}?\n\s*2[.)]\s+\S/;
    const plan_explicit = /\b(multi[- ]?step|several steps|step[- ]by[- ]step|a (few|couple|number) of (things|steps|tasks)|then (also )?(add|build|write|create|set up|wire|update))\b/i;
    if (
      (plan_then.test(ownPrompt) || plan_numbered.test(ownPrompt) || plan_explicit.test(ownPrompt)) &&
      shouldSuggest('plan_first', 3)
    ) {
      messages.push("PRISM: Multi-step work detected — before executing, lay out a task list (one item per step) using your task-tracking tool — TaskCreate to add each item, TaskUpdate to mark it done (or TodoWrite on builds that expose that name) — so progress is visible, steps aren't skipped, and you can be redirected mid-flight. Mark each item done as you go. Independent steps in the list → batch them as parallel Agent() dispatches.");
      recordSuggestion('plan_first'); matchedInvocation = true;
    }

    // ─── TIER 2 — MID tone ───
    const context7_intent = /\b(latest docs for|use the .+ API|how does .+ (v\d|version \d)|deprecated in)\b/i;
    if (context7_intent.test(ownPrompt) && shouldSuggest('context7', 10)) {
      messages.push("PRISM: Up-to-date library docs are Context7's strength. If not installed: add @upstash/context7-mcp to settings.json.");
      recordSuggestion('context7'); matchedInvocation = true;
    }

    const playwright_intent = /\b(visual regression|screenshot this page|click through this flow|navigate to .+ and verify)\b/i;
    if (playwright_intent.test(ownPrompt) && shouldSuggest('playwright_mcp', 10)) {
      messages.push("PRISM: Direct browser control works with @playwright/mcp. Useful for app-expert workflows needing per-step reliability.");
      recordSuggestion('playwright_mcp'); matchedInvocation = true;
    }

    const github_mcp_intent = /\b(list issues|create PR|review (the |this )?PR|search github for)\b/i;
    if (github_mcp_intent.test(ownPrompt) && shouldSuggest('github_mcp', 10)) {
      messages.push("PRISM: GitHub operations run faster with the official GitHub MCP server. Install: add mcpServers entry to settings.json.");
      recordSuggestion('github_mcp'); matchedInvocation = true;
    }
  }

  // ── Gap 4: trivial-work streak advisory ──
  if (matchedInvocation) {
    gs.trivial_streak = 0;
  } else {
    gs.trivial_streak = (gs.trivial_streak || 0) + 1;
  }
  const canCostWarn = !gs.cost_budget_warned_at || (turn - gs.cost_budget_warned_at) >= 10;
  if (!matchedInvocation && gs.trivial_streak >= 5 && canCostWarn) {
    messages.push(`PRISM NOTICE: ${gs.trivial_streak} consecutive turns without an expert-task signal. If you're doing routine edits, consider /model sonnet (~5×) or /model haiku (~15×) cheaper than Opus.`);
    gs.cost_budget_warned_at = turn;
  }

  // ── Phase 1.3 + 2.6: KB-index router fallback (two-band) ──
  // [WHY] Hardcoded regex patterns above cover ~15 canonical intents, but
  // PRISM has 244+ indexed skills/agents/commands. Two bands:
  //   High confidence (score >= 5.0): emit direct invocation hint (Phase 1.3)
  //   Low confidence  (1.0 <= score < 3.0): emit Tier-2 cloud-search hint
  //     pointing at prism-kb-query.mjs (Phase 2.6). NotebookLM has richer
  //     semantic recall than the local scorer — user can run the command
  //     explicitly to reach it, avoiding per-prompt cloud latency.
  // Cooldown: once per 5 turns — these are hints, not commands.
  if (!matchedInvocation && routeQuery && shouldSuggest('router_fallback', 5)) {
    try {
      const idxPath = j(H, '.claude', '.prism-kb-index.json');
      const metaPath = j(H, '.claude', '.prism-kb-meta.json');
      if (e(idxPath)) {
        const idx = JSON.parse(r(idxPath, 'utf-8'));
        // Use a low floor so we can see borderline matches too.
        const hits = routeQuery(ownPrompt, idx, { limit: 3, minScore: 1.0, includeDisabled: true });
        if (hits.length > 0) {
          const top = hits[0];
          if (top.score >= 5.0) {
            // High confidence — direct invocation hint (unchanged behaviour)
            const hint = formatRouterHint([top]);
            if (hint) { messages.push(hint); recordSuggestion('router_fallback'); matchedInvocation = true; }
          } else if (top.score >= 1.0 && top.score < 3.0) {
            // Low confidence — Tier-2 hint (only meaningful if cloud is set up)
            if (e(metaPath)) {
              let meta = null;
              try { meta = JSON.parse(r(metaPath, 'utf-8')); } catch {}
              const hasCloud = meta && meta.notebooks && Object.keys(meta.notebooks).length > 0;
              if (hasCloud) {
                const domains = Array.from(new Set(hits.map(h => h.entry.domain).filter(Boolean))).slice(0, 2);
                const domHint = domains.length ? ` (likely domain${domains.length > 1 ? 's' : ''}: ${domains.join(', ')})` : '';
                const safePrompt = String(ownPrompt).replace(/"/g, '\\"').slice(0, 200);
                messages.push(`PRISM TIER-2: Weak local match (top score ${top.score.toFixed(1)})${domHint}. For cloud semantic search run: node ~/.claude/tools/prism-kb-query.mjs "${safePrompt}"`);
                recordSuggestion('router_fallback');
                matchedInvocation = true;
              }
            }
          }
        }
      }
    } catch {}
  }

  // ── Persist state ──
  try {
    mk(j(process.cwd(), '.claude'), {recursive: true});
    w(sf, JSON.stringify(state));
  } catch {}
  try {
    mk(j(H, '.claude'), {recursive: true});
    w(gsf, JSON.stringify(gstate));
  } catch {}

  // Output
  return {exit: 0, stdout: messages.length > 0 ? messages.join('\n') : '', stderr: ''};
  } catch { return {exit: 0, stdout: '', stderr: ''}; }
}

import {basename as _basename} from 'path';
const invokedDirectly = process.argv[1] && _basename(process.argv[1]) === 'prism-hook.mjs';
if (invokedDirectly) {
  (async () => {
    let payload = {};
    try { payload = JSON.parse(r(0, 'utf-8') || '{}'); } catch {}
    const res = await run(payload);
    if (res.stdout) process.stdout.write(res.stdout);
    process.exit(res.exit || 0);
  })();
}
