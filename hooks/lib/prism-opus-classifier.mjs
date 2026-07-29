// PRISM Opus Context Classifier (v3.2.0)
//
// v3.2.0: API classifier path removed. Keyword-floor regex is the sole
// classification mechanism. Conversation model can self-override via the
// next-turn sentinel-write mechanism (see prism-prompt-tier-router.mjs for
// the override directive).
//
// Public API
//   classifyPrompt({prompt, cwd, branch, recentCommits, stagedFiles,
//                   activeSkills, cachePath, ...})
//     -> {tier, summon_panel, rationale, source, force_opus, cache_key}
//
//   Shape contract (UNCHANGED from v2.x — callers depend on it):
//     tier:          'haiku' | 'sonnet' | 'opus'
//     summon_panel:  boolean  — true on novel architectural decisions
//     rationale:     string   — short one-line explanation (<200 chars)
//     source:        'allowlist' | 'force-opus' | 'cache' | 'keyword-floor'
//                    (NOTE: 'opus' / 'sonnet-fallback' no longer emitted in v3.2.0)
//     force_opus:    boolean  — set when prompt was PREFIXED with '!opus-force:'
//     force_gp:      boolean  — set when prompt was PREFIXED with '!gp-force:' (v5.12.0);
//                    orthogonal to tier — overrides the specialist-routing-guard
//                    only, riding the sentinel so the PreToolUse/Agent hook (which
//                    cannot see the turn prompt) can honor it.
//     cache_key:     string   — sha256(prompt|branch|head) or '' if N/A
//
// Cache (KEPT — speeds up repeated identical prompts within a session)
//   Location: opts.cachePath, default ~/.claude/.prism-tier-cache.json
//   Schema:   { entries: { [cacheKey]: {tier, summon_panel, rationale,
//                                        source:'keyword-floor', ts:ISO, expires_at:ISO} } }
//   TTL:      24h. Expired entries are evicted on read.
//   Key:      sha256(prompt + '|' + branch + '|' + head_sha)
//
// Decision chain (in order)
//   1. `!opus-force:` prefix            -> {tier:'opus', force_opus:true, source:'force-opus'}
//   2. Slash-command allowlist match    -> {tier:'opus', source:'allowlist'}
//   3. Cache hit (<24h)                 -> cached entry with source:'cache'
//   4. Keyword-floor regex              -> regex/score result with source:'keyword-floor'
//
// summon_panel detection (regex/keyword-derived) is preserved — see
// classifyWithScore() in tools/lib/prism-tier-classify.mjs and the
// release-safety screen below.
//
// No network calls fire from this module. No external API key is consulted.

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {classifyWithScore, PANEL_MIN_WORDS, EXPLICIT_PANEL_RE, stripPastedContent, hasTranscriptPaste, trailingOwnWords} from '../../tools/lib/prism-tier-classify.mjs';
import {prismHome} from './prism-home.mjs';

const H = prismHome();
const DEFAULT_CACHE_PATH = join(H, '.claude', '.prism-tier-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Item 2b, D025: Short prompts are cheap to re-classify and their referent
// ("it", "this") changes between turns, so caching them is actively harmful —
// a cached panel tier from "architecture review" fired repeatedly on every
// "fix it" follow-up in the same session. Re-use PANEL_MIN_WORDS (same
// threshold as the panel-floor) so the two guards are consistent.
// Cache READs are unaffected — only the PUT is skipped for short prompts.
const SHORT_PROMPT_WORDS = PANEL_MIN_WORDS;

// Slash-command allowlist — PRISM orchestration commands that require
// opus-tier context regardless of prompt shape. These are always routed to
// opus with zero API cost, zero latency. Extend with care: any command
// added here bypasses the classifier entirely.
export const OPUS_ORCHESTRATION_COMMANDS = new Set([
  '/prism-plan',
  '/prism-update',
  '/prism-recommend',
  '/prism-archive',
  '/prism-audit',
  '/prism-health',
  '/prism-roster',
  '/prism-retire',
  '/prism-recall',
  // Parent-driven state-machine commands (v5.1 UAT fix). The conversation
  // model runs their deterministic node helpers (git guard, init-state,
  // phase-* subcommands) + LLM-judged phases DIRECTLY — not subagent work.
  // Without opus routing, the parent-dispatch-guard blocks their own git/node
  // calls (e.g. /prism-bootstrap Step 0 git guard was denied on fresh projects).
  '/prism-bootstrap',
  '/prism-sync',
  '/prism-deep-dive',
  '/prism-fresh',
  '/prism-clean',
  '/prism-doctor',
  '/prism-index',
  '/prism-deps',
  '/prism-validate-plugins',
  '/prism-audit-full',
  '/prism-telemetry',
  '/prism-uninstall-cleanup',
]);

// v2.7.0: cache key drops `dirty` (too volatile — every file save flipped
// the cache). Git branch + HEAD SHA still scope the key so release-sensitive
// work re-classifies on commit. Prompt-iteration cache hit rate improves ~5×
// with this change.
export function cacheKey(prompt, branch, headSha, _dirty) {
  const payload = `${String(prompt || '')}|${String(branch || '')}|${String(headSha || '')}`;
  return createHash('sha256').update(payload).digest('hex');
}

function loadCache(path) {
  try {
    if (!existsSync(path)) return {entries: {}};
    const raw = readFileSync(path, 'utf-8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || !obj.entries) return {entries: {}};
    return obj;
  } catch { return {entries: {}}; }
}

function saveCache(path, obj) {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(obj, null, 2));
  } catch {}
}

function cacheGet(path, key) {
  const c = loadCache(path);
  const hit = c.entries[key];
  if (!hit) return null;
  if (!hit.expires_at) return null;
  if (Date.parse(hit.expires_at) < Date.now()) {
    // Expired — evict.
    delete c.entries[key];
    saveCache(path, c);
    return null;
  }
  return hit;
}

function cachePut(path, key, value) {
  const c = loadCache(path);
  c.entries[key] = {
    ...value,
    ts: new Date().toISOString(),
    expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
  };
  saveCache(path, c);
}

function parseFirstSlashCommand(prompt) {
  const trimmed = String(prompt || '').trim();
  if (!trimmed.startsWith('/')) return null;
  // Take everything up to first whitespace or end.
  const m = trimmed.match(/^\/[\w-]+/);
  return m ? m[0].toLowerCase() : null;
}

function matchesOrchestrationCommand(prompt) {
  const cmd = parseFirstSlashCommand(prompt);
  if (!cmd) return null;
  return OPUS_ORCHESTRATION_COMMANDS.has(cmd) ? cmd : null;
}

// Release/meta-work safety screen used by the keyword floor. Any prompt
// matching these patterns is promoted to opus regardless of keyword score.
// Covers the release regression cases the user flagged:
//   - git-write verbs (push to main, merge, force-push, deploy)
//   - meta-work tokens (PRISM, tier router, ship, release, 2.2.0)
//   - /prism-* orchestration commands (also caught by allowlist, but safe belt)
//   - multi-verb chains ending in a write verb
// v2.8.0: tighter pattern. The v2.2.0 version matched bare `PRISM` and
// `2.2.0` tokens, which caused every prompt mentioning PRISM by name or
// quoting a version to fire the release-safety screen → summon_panel →
// dispatch-guard panel demand. Now requires release-like CONTEXT around the token.
// v5.0.x A3: the bare `ship(ping)?` alternative had no context anchor, so
// common e-commerce domain phrasing ("shipping address", "shipping cost",
// "shipping options") over-fired to opus. The negative lookahead carves out
// those domain nouns while keeping every real release form ("ship v5",
// "ship the release", "ship to origin", "ready to ship?", "shipping the
// release"). The trailing \b on the group rejects "shipping <domain>" because
// the no-"ping" backtrack lands mid-word.
const RELEASE_SAFETY_RE = /\b(push\s+(to|origin)|merge\s+(to|into|main|master)|force[-\s]?push|git\s+push|deploy(ment)?|release|ship(?:ping)?(?!\s+(?:address(?:es)?|cost|costs|option|options|method|methods|fee|fees|rate|rates|label|labels|info|information|carrier|carriers|date|dates|status|zone|zones|polic(?:y|ies)|estimate|estimates|details|provider|providers|partner|partners|calculator|tracking|number))|tier\s+router|(release|deploy|ship|upgrade|publish|bump)\s+(PRISM|v?\d+\.\d+\.\d+)|PRISM\s+(release|deploy|update|upgrade|v\d|v?\d+\.\d+)|v?\d+\.\d+\.\d+\s+(release|deploy|ship))\b/i;
const MULTI_VERB_CHAIN_RE = /\b(test|check|verify|retest)\b.*\b(and|then)\b.*\b(push|deploy|merge|release|ship)\b/i;

function releaseSafetyScreen(prompt) {
  const s = String(prompt || '');
  if (RELEASE_SAFETY_RE.test(s)) return 'release/meta-work token';
  if (MULTI_VERB_CHAIN_RE.test(s)) return 'multi-verb chain ending in write';
  return null;
}

// v5.2.4 — META-QUESTION SCREEN. An interrogative/explanatory prompt ("why did
// X happen?", "am I right that…", "explain…", "I don't understand…") is a
// request for EXPLANATION, not a novel-architecture build request — even when
// it name-drops architecture vocab (skills, design, coordinate). It must not
// force the master-orchestrator design panel (DOCTRINE: a question about the
// system != a task on the system). Clears summon_panel ONLY (tier is left to
// the score — a question can still warrant opus for a good answer). Suppressed
// when an imperative build verb is co-present ("design X and explain why" is
// still real work). Live-repro 2026-06-04: "i dont understand why was through
// master orchestrator… am i wrong?" wrongly forced a panel.
const META_QUESTION_RE = /\b(why|how come|what makes|is it (right|correct|true|normal|expected)|am i (right|wrong|correct|missing)|are you sure|can you explain|could you explain|explain (why|how|what|the)|i (don'?t|do not) understand|help me understand|isn'?t it|shouldn'?t it)\b/i;
const BUILD_VERB_RE = /\b(design|build|implement|create|architect|refactor|migrate|add|write|fix|set\s?up|scaffold|generate|integrate|optimi[sz]e|rewrite|port|upgrade)\b/i;
function isMetaQuestion(prompt) {
  const s = String(prompt || '');
  return META_QUESTION_RE.test(s) && !BUILD_VERB_RE.test(s);
}

// WS-2 (v5.10.0) — AMBIGUITY FLOOR (D017 deferred option, now adopted).
// keyword-floor scores terse, context-referencing prompts ("execute it",
// "fix all", "@docs/x.md run it") at 0 → haiku, forcing ~10 conversation-model
// overrides per session. Such a prompt is almost always a continuation of real
// work whose complexity the brief phrasing hides. So a SCORE-0 prompt that would
// route haiku and is IMPERATIVE (leading ACTION verb) and/or REFERENCES A FILE
// is promoted to SONNET. Deterministic, zero LLM cost, no network. Read verbs
// ("list", "show", "print") and interrogatives stay haiku; clear-complexity is
// already opus by the time we get here. ONLY upgrades haiku→sonnet — never
// downgrades a stakes/security/panel result.
const IMPERATIVE_ACTION_VERBS = new Set([
  'execute', 'run', 'rerun', 'retest', 'redo', 'fix', 'patch', 'apply',
  'implement', 'build', 'create', 'make', 'refactor', 'rewrite', 'migrate',
  'port', 'deploy', 'ship', 'release', 'add', 'write', 'update', 'change',
  'edit', 'rename', 'move', 'remove', 'delete', 'wire', 'integrate', 'generate',
  'scaffold', 'finish', 'complete', 'do', 'continue', 'proceed', 'resume',
  'retry', 'revert', 'merge', 'commit', 'install', 'configure', 'enable',
  'disable', 'bump', 'upgrade', 'downgrade', 'split', 'extract', 'inline',
  'optimize', 'optimise', 'harden', 'validate', 'verify',
]);
// @path mention, a slashed/backslashed path with extension, or a bare filename
// with a known code/config extension.
const FILE_REF_RE = /(?:^|\s)@[\w./\\-]+|\b[\w-]+(?:[/\\][\w.-]+)+\.\w{1,6}\b|\b[\w-]+\.(?:md|mjs|cjs|js|jsx|ts|tsx|json|jsonc|py|sh|cmd|bat|ps1|yaml|yml|toml|ini|env|txt|sql|go|rs|rb|java|c|h|cpp)\b/i;
const INTERROGATIVE_LEAD_RE = /^(what|why|how|when|where|who|which|whose|is|are|am|was|were|does|did|can|could|should|would|will|may|might|shall|have|has|had)\b/i;

function ambiguityFirstWord(prompt) {
  // Strip leading whitespace/quotes/@/punctuation, then grab the first word.
  const m = String(prompt || '').trim().replace(/^[^\w@]+/, '').match(/^[a-z][a-z'-]*/i);
  return m ? m[0].toLowerCase() : '';
}
function isImperativeAction(prompt) {
  return IMPERATIVE_ACTION_VERBS.has(ambiguityFirstWord(prompt));
}
function isInterrogative(prompt) {
  const s = String(prompt || '').trim();
  return /\?\s*$/.test(s) || INTERROGATIVE_LEAD_RE.test(s);
}
function referencesFile(prompt) {
  return FILE_REF_RE.test(String(prompt || ''));
}
function ambiguityFloorApplies(prompt) {
  // Imperative action OR a (non-interrogative) file reference. Interrogatives —
  // even file-referencing ones ("what's in config.json?") — stay haiku per spec.
  return isImperativeAction(prompt) || (referencesFile(prompt) && !isInterrogative(prompt));
}

function keywordFloor(prompt) {
  // Sole classification path in v3.2.0.
  // Release/meta-work tokens promote to opus TIER — shipping a broken release
  // from a haiku-classified prompt is the failure mode that motivated the
  // screen. But the DESIGN PANEL is decoupled (v5.0.x): a ship/release token
  // alone — especially in a readiness QUESTION ("are we ready to ship?") or a
  // plain ship ACTION — is execution/verification, NOT novel architecture, and
  // should not force the master-orchestrator design panel. summon_panel is set
  // ONLY by the genuine novel-architecture signal path (PANEL_SIGNALS, compound-
  // verb chains on opus tier, stakes, ≥3 OPUS_SIGNALS — see classifyWithScore),
  // so a real "re-architect + release" prompt still summons it, while a
  // readiness check does not.
  const c = classifyWithScore(prompt || '', '');
  const release = releaseSafetyScreen(prompt);
  // A16/D034 fix: the explicit-panel test MUST run against the user's OWN words,
  // not the raw prompt. On a pasted-dominated prompt (a transcript/report the
  // user pasted), panel language inside the pasted block ("summon the adversarial
  // panel", "expert panel", "re-architect the platform") is NOT the user's
  // request. detectSummonPanel() already strips it (tools/lib/prism-tier-classify
  // .mjs:409-412) so c.summon_panel is correctly suppressed — but this local
  // `explicit` flag previously tested the RAW prompt and OVERRODE that
  // suppression (`panel = explicit ? true : ...` below), re-firing the panel from
  // pasted vocabulary and defeating the D034 safeguard.
  //
  // D068 residual fix: the original mirror of detectSummonPanel() only stripped
  // when pastedRatio(prompt) >= 0.6 (pasted-DOMINANT). A MINORITY paste — a
  // single quoted transcript line ("summon the adversarial panel...") embedded
  // in an otherwise much longer own-words prompt — has a low pastedRatio and
  // was falling through to the RAW, unstripped prompt here too, so the quoted
  // panel language still matched EXPLICIT_PANEL_RE and re-summoned the panel.
  // stripPastedContent() is a no-op on genuine typed prose (no paste markers to
  // strip), so it is now called UNCONDITIONALLY — no ratio gate — matching the
  // equivalent fix in summonPanelCore() (tools/lib/prism-tier-classify.mjs).
  //
  // D068-follow-up CORRECTED (2026-07-24): position-aware. A pasted CC/CLI
  // transcript (>=3 strong transcript markers) means an explicit phrase
  // BEFORE the transcript's first strong marker (a leading pre-transcript
  // block — e.g. "run the panel: <question>" immediately followed by the
  // pasted CLI run it produced) is the input that generated the paste, not a
  // fresh request, and must NOT summon. An explicit phrase AFTER the
  // transcript's last strong marker (genuine trailing own-words — the LOCKED
  // v5.2.6/D034 guarantee) must still summon. trailingOwnWords() falls back
  // to the unchanged stripPastedContent() when the prompt is not transcript-
  // dominated, so every other path (fenced/minority pastes, plain prose) is
  // untouched — see tools/lib/prism-tier-classify.mjs for the shared helper.
  const _rawPrompt = String(prompt || '');
  const _ownWords = hasTranscriptPaste(_rawPrompt) ? trailingOwnWords(_rawPrompt) : stripPastedContent(_rawPrompt);
  const explicit = EXPLICIT_PANEL_RE.test(_ownWords);
  const meta = isMetaQuestion(prompt);
  const panel = explicit ? true : (meta ? false : !!c.summon_panel);
  if (release) {
    return {
      tier: 'opus',
      summon_panel: panel,
      rationale: `keyword-floor release-screen: ${release} (opus; panel=${panel}${meta ? ' meta-question' : ''})`,
    };
  }
  const tier0 = c.tier_by_score === 'haiku' && c.score > 0
    ? 'haiku'
    : (c.tier_by_score || 'sonnet');
  // WS-2 ambiguity floor: a score-0 haiku prompt that is imperative/file-ref
  // → sonnet. Only ever upgrades haiku; never touches sonnet/opus results.
  let tier = tier0;
  let ambiguityFloor = false;
  if (tier0 === 'haiku' && c.score === 0 && ambiguityFloorApplies(prompt)) {
    tier = 'sonnet';
    ambiguityFloor = true;
  }
  return {
    tier,
    summon_panel: panel,
    rationale: `keyword-floor score=${c.score} summon_panel=${panel}${meta ? ' (meta-question screen)' : ''}${ambiguityFloor ? ' (ambiguity-floor: score-0 imperative/file-ref → sonnet)' : ''}`,
  };
}

// Async signature preserved so existing `await classifyPrompt(...)` callers
// (prism-prompt-tier-router, prism-agent-model-guard, prism-task-tier-advisor)
// continue to work without modification, even though no awaitable work
// remains in v3.2.0.
export async function classifyPrompt(opts = {}) {
  const {
    prompt = '',
    branch = '',
    headSha = '',
    dirty = false,
    cachePath = DEFAULT_CACHE_PATH,
    skipCache = false,
  } = opts;

  const str = String(prompt || '');

  // v5.12.0: specialist-routing override. `!gp-force:` is an ORTHOGONAL axis to
  // tier — it does not change the model/tier decision, it tells the
  // specialist-routing-guard to allow a generic (general-purpose) dispatch for
  // build-class work this turn. Computed once here and carried on EVERY return
  // path (incl. cache hits, which never store it) so prism-prompt-tier-router →
  // toSentinel → the guard can read sentinel.force_gp. (red-team C1: a
  // PreToolUse/Agent hook cannot see the turn prompt; the flag must ride the
  // sentinel, exactly as force_opus does.)
  //
  // prefix-anchored (F16 2026-07-27): an unanchored .includes let pasted PRISM
  // guard text ('prefix your prompt with !opus-force:') self-grant the bypass.
  const forceGp = str.trimStart().startsWith('!gp-force:');

  // 1. Force-opus override — highest priority.
  const forceOpus = str.trimStart().startsWith('!opus-force:');
  if (forceOpus) {
    return {
      tier: 'opus',
      summon_panel: false,
      rationale: 'force-opus override',
      source: 'force-opus',
      force_opus: true,
      force_gp: forceGp,
      cache_key: '',
    };
  }

  // 2. Slash-command allowlist — zero cost, zero latency.
  const matched = matchesOrchestrationCommand(str);
  if (matched) {
    return {
      tier: 'opus',
      summon_panel: false,
      rationale: `orchestration command ${matched}`,
      source: 'allowlist',
      force_opus: false,
      force_gp: forceGp,
      cache_key: '',
    };
  }

  // 3. Cache lookup.
  const key = cacheKey(str, branch, headSha, dirty);
  if (!skipCache) {
    const hit = cacheGet(cachePath, key);
    if (hit) {
      return {
        tier: hit.tier,
        summon_panel: !!hit.summon_panel,
        rationale: hit.rationale || '(cached)',
        source: 'cache',
        force_opus: false,
        force_gp: forceGp,
        cache_key: key,
      };
    }
  }

  // 4. Keyword floor — sole classification path in v3.2.0.
  const floor = keywordFloor(str);
  const out = {
    tier: floor.tier,
    summon_panel: floor.summon_panel,
    rationale: floor.rationale,
    source: 'keyword-floor',
    force_opus: false,
    force_gp: forceGp,
    cache_key: key,
  };
  // Item 2b, D025: skip cache write for short prompts. Their referent changes
  // every turn ("it", "this") making a 24h cache entry actively harmful. Long
  // prompts that carry real architectural context are still cached normally.
  const promptWordCount = str.trim().split(/\s+/).filter(Boolean).length;
  const isShortPrompt = promptWordCount < SHORT_PROMPT_WORDS;
  if (!skipCache && !isShortPrompt) {
    cachePut(cachePath, key, {
      tier: out.tier,
      summon_panel: out.summon_panel,
      rationale: out.rationale,
      source: 'keyword-floor',
    });
  }
  return out;
}

// Convenience helper for hooks: returns a sentinel-shaped result compatible
// with the pre-2.2.0 prompt-tier-router sentinel. Preserves the
// {tier, force_opus, dispatched, ...} shape so prism-parent-dispatch-guard.mjs
// keeps working without schema changes.
export function toSentinel(classification, extra = {}) {
  const tier = classification.tier;
  const forceOpus = !!classification.force_opus;
  // v6.0.0 routine turn-collapse schema fields (schema + reset slice only —
  // the gate that reads these is a later slice; no deny/nudge logic here).
  //
  // dispatch_count: integer initialized to 0 on EVERY new turn. The future
  //   gate increments this during the turn; the next call to toSentinel()
  //   (or the inherit-reset path in the router) always resets it to 0.
  //
  // routine_bypass: true when the tier is haiku or sonnet AND force_opus is
  //   not set. Flags turns eligible for single-pass (no multi-turn re-dispatch
  //   loop). Lightweight/routine tiers map to haiku/sonnet.
  const dispatch_count = 0;
  const routine_bypass = (tier === 'haiku' || tier === 'sonnet') && !forceOpus;
  return {
    ts: new Date().toISOString(),
    tier,
    // Legacy score fields retained as zeros for compatibility; new readers
    // prefer `rationale` + `source`.
    score: 0,
    h: 0, s: 0, o: 0,
    compound: false,
    force_opus: forceOpus,
    force_gp: !!classification.force_gp,
    dispatched: false,
    summon_panel: !!classification.summon_panel,
    rationale: classification.rationale || '',
    source: classification.source || 'unknown',
    dispatch_count,
    routine_bypass,
    ...extra,
  };
}
