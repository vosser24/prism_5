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
//     force_opus:    boolean  — set when prompt contained '!opus-force:'
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
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {classifyWithScore} from '../../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE || homedir();
const DEFAULT_CACHE_PATH = join(H, '.claude', '.prism-tier-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Slash-command allowlist — PRISM orchestration commands that require
// opus-tier context regardless of prompt shape. These are always routed to
// opus with zero API cost, zero latency. Extend with care: any command
// added here bypasses the classifier entirely.
export const OPUS_ORCHESTRATION_COMMANDS = new Set([
  '/prism-plan',
  '/prism-app-expert',
  '/prism-update',
  '/prism-recommend',
  '/prism-archive',
  '/prism-audit',
  '/prism-health',
  '/prism-roster',
  '/prism-retire',
  '/prism-recall',
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
  if (release) {
    return {
      tier: 'opus',
      summon_panel: !!c.summon_panel,
      rationale: `keyword-floor release-screen: ${release} (opus; panel=${!!c.summon_panel} from signals)`,
    };
  }
  const tier = c.tier_by_score === 'haiku' && c.score > 0
    ? 'haiku'
    : (c.tier_by_score || 'sonnet');
  return {
    tier,
    summon_panel: !!c.summon_panel,
    rationale: `keyword-floor score=${c.score} summon_panel=${!!c.summon_panel}`,
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

  // 1. Force-opus override — highest priority.
  const forceOpus = str.includes('!opus-force:');
  if (forceOpus) {
    return {
      tier: 'opus',
      summon_panel: false,
      rationale: 'force-opus override',
      source: 'force-opus',
      force_opus: true,
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
    cache_key: key,
  };
  if (!skipCache) {
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
  return {
    ts: new Date().toISOString(),
    tier: classification.tier,
    // Legacy score fields retained as zeros for compatibility; new readers
    // prefer `rationale` + `source`.
    score: 0,
    h: 0, s: 0, o: 0,
    compound: false,
    force_opus: !!classification.force_opus,
    dispatched: false,
    summon_panel: !!classification.summon_panel,
    rationale: classification.rationale || '',
    source: classification.source || 'unknown',
    ...extra,
  };
}
