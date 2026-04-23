// PRISM Opus Context Classifier (v2.2.0)
//
// Replaces the keyword-score tier router. The classifier calls the Anthropic
// Messages API with Opus primary, Sonnet fallback. If both API calls fail,
// falls back to the legacy keyword classifier so PRISM still routes something
// rather than hard-failing.
//
// Public API
//   classifyPrompt({prompt, cwd, branch, recentCommits, stagedFiles,
//                   activeSkills, apiKey, timeoutMs, model, cachePath})
//     -> {tier, summon_panel, rationale, source, force_opus, cache_key}
//
//   Shape contract:
//     tier:          'haiku' | 'sonnet' | 'opus'
//     summon_panel:  boolean  — true on novel architectural decisions
//     rationale:     string   — short one-line explanation (<200 chars)
//     source:        'allowlist' | 'force-opus' | 'cache' | 'opus'
//                    | 'sonnet-fallback' | 'keyword-floor'
//     force_opus:    boolean  — set when prompt contained '!opus-force:'
//     cache_key:     string   — sha256(prompt|branch|head|dirty) or '' if N/A
//
// Cache
//   Location: opts.cachePath, default ~/.claude/.prism-tier-cache.json
//   Schema:   { entries: { [cacheKey]: {tier, summon_panel, rationale,
//                                        source:'opus'|'sonnet-fallback',
//                                        ts:ISO, expires_at:ISO} } }
//   TTL:      24h. Expired entries are evicted on read.
//   Key:      sha256(prompt + '|' + branch + '|' + head_sha + '|' + dirty_bool)
//
// Fallback chain (in order)
//   1. `!opus-force:` prefix            -> {tier:'opus', force_opus:true, source:'force-opus'}
//   2. Slash-command allowlist match    -> {tier:'opus', source:'allowlist'}
//   3. Cache hit (<24h)                 -> cached entry with source:'cache'
//   4. Opus API call                    -> API response with source:'opus'
//   5. Sonnet API call (on Opus error)  -> API response with source:'sonnet-fallback'
//   6. Keyword floor (on all failures)  -> legacy lib result, source:'keyword-floor'
//
// Emergencies
//   If no ANTHROPIC_API_KEY env var is set AND no opts.apiKey is passed,
//   skip the API calls entirely and go straight to the keyword floor.
//   No network calls fire from an unconfigured install.
//
// Imports from shared lib for the keyword floor only.

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {classifyWithScore} from '../../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE || homedir();
const DEFAULT_CACHE_PATH = join(H, '.claude', '.prism-tier-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MODEL = 'claude-opus-4-7';
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Slash-command allowlist — PRISM orchestration commands that require
// opus-tier context regardless of prompt shape. These are always routed to
// opus with zero API cost, zero latency. Extend with care: any command
// added here bypasses the classifier entirely.
export const OPUS_ORCHESTRATION_COMMANDS = new Set([
  '/prism-init',
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

function buildSystemPrompt() {
  return [
    "You are a routing classifier for Claude Code prompts. Classify the incoming prompt into a tier so the orchestrator knows which model to use.",
    "",
    "Return a single JSON object exactly matching this schema:",
    '  {"tier": "haiku"|"sonnet"|"opus", "summon_panel": boolean, "rationale": "<string, <=180 chars>"}',
    "",
    "Rules:",
    "- Use 'opus' for any write to shared state (git push/merge/force-push/deploy, destructive ops, architecture changes, multi-step release engineering, multi-verb chains that end in a write).",
    "- Use 'sonnet' for standard engineering work: implement a feature, write tests, fix a bug, refactor a module.",
    "- Use 'haiku' ONLY for read-only lookups, status checks, simple formatting, single-variable renames, typo fixes.",
    "- summon_panel=true for novel architectural decisions that need expert-panel debate (rare; default false).",
    "- When uncertain between two tiers, choose the HIGHER tier. Overpay < retry.",
    "- Prompts containing '!opus-force:' prefix are already handled upstream — you will not see them.",
    "",
    "Respond with ONLY the JSON object, no prose, no code fence.",
  ].join('\n');
}

function buildUserMessage({prompt, cwd, branch, recentCommits, stagedFiles, activeSkills}) {
  const parts = [`PROMPT:\n${String(prompt || '').slice(0, 4000)}`];
  if (cwd) parts.push(`CWD: ${cwd}`);
  if (branch) parts.push(`BRANCH: ${branch}`);
  if (Array.isArray(recentCommits) && recentCommits.length) {
    parts.push(`RECENT_COMMITS:\n${recentCommits.slice(0, 5).join('\n')}`);
  }
  if (Array.isArray(stagedFiles) && stagedFiles.length) {
    parts.push(`STAGED_FILES:\n${stagedFiles.slice(0, 20).join('\n')}`);
  }
  if (Array.isArray(activeSkills) && activeSkills.length) {
    parts.push(`ACTIVE_SKILLS: ${activeSkills.slice(0, 10).join(', ')}`);
  }
  return parts.join('\n\n');
}

async function callMessagesAPI({apiKey, model, system, user, timeoutMs}) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch not available in this Node runtime');
  }
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system,
        messages: [{role: 'user', content: user}],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`messages api ${model} status=${res.status} body=${errText.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    return body;
  } finally {
    clearTimeout(to);
  }
}

function extractJsonFromText(text) {
  if (!text) return null;
  const s = String(text).trim();
  // Handle code-fenced output even though we told the model not to.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fence ? fence[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch { return null; }
}

function normalizeClassification(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const tier = String(parsed.tier || '').toLowerCase();
  if (!['haiku', 'sonnet', 'opus'].includes(tier)) return null;
  const summon_panel = !!parsed.summon_panel;
  const rationale = String(parsed.rationale || '').slice(0, 200);
  return {tier, summon_panel, rationale};
}

async function tryApiClassify({apiKey, model, system, user, timeoutMs}) {
  const body = await callMessagesAPI({apiKey, model, system, user, timeoutMs});
  const text = (body && Array.isArray(body.content))
    ? (body.content.find(c => c.type === 'text') || {}).text
    : null;
  const parsed = extractJsonFromText(text);
  const norm = normalizeClassification(parsed);
  if (!norm) {
    throw new Error(`could not parse classifier JSON from ${model}: ${String(text || '').slice(0, 200)}`);
  }
  return norm;
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
// dispatch-guard panel demand. In real use (esp. when API was unreachable
// so the keyword floor ran on every prompt), this was every prompt about
// using PRISM itself. Now requires release-like CONTEXT around the token:
// "release PRISM", "deploy v2.x.x", "ship PRISM v2.8", etc. Bare mentions
// like "configure PRISM" or "PRISM documentation" no longer trip it.
const RELEASE_SAFETY_RE = /\b(push\s+(to|origin)|merge\s+(to|into|main|master)|force[-\s]?push|git\s+push|deploy(ment)?|release|ship(ping)?|tier\s+router|(release|deploy|ship|upgrade|publish|bump)\s+(PRISM|v?\d+\.\d+\.\d+)|PRISM\s+(release|deploy|update|upgrade|v\d|v?\d+\.\d+)|v?\d+\.\d+\.\d+\s+(release|deploy|ship))\b/i;
const MULTI_VERB_CHAIN_RE = /\b(test|check|verify|retest)\b.*\b(and|then)\b.*\b(push|deploy|merge|release|ship)\b/i;

function releaseSafetyScreen(prompt) {
  const s = String(prompt || '');
  if (RELEASE_SAFETY_RE.test(s)) return 'release/meta-work token';
  if (MULTI_VERB_CHAIN_RE.test(s)) return 'multi-verb chain ending in write';
  return null;
}

function keywordFloor(prompt) {
  // Emergency floor — if Opus and Sonnet both fail and we have no cache,
  // still route *something* so downstream consumers work. Lean conservative:
  // promote sonnet+ and leave haiku as explicit signal only.
  // Release/meta-work tokens always promote to opus even in floor mode —
  // shipping a broken release from a haiku-classified prompt is the exact
  // failure mode that motivated the 2.2.0 overhaul.
  //
  // v2.7.0: keyword floor now derives `summon_panel` from PANEL_SIGNALS,
  // compound-verb chains on opus tier, and ≥3 OPUS_SIGNALS hits. Offline
  // users and no-API-key installs still get the orchestrator gate.
  const release = releaseSafetyScreen(prompt);
  if (release) {
    return {
      tier: 'opus',
      summon_panel: true,   // release on opus+sonnet-unreachable = panel-worthy
      rationale: `keyword-floor release-screen: ${release} (opus+sonnet unreachable)`,
    };
  }
  const c = classifyWithScore(prompt || '', '');
  const tier = c.tier_by_score === 'haiku' && c.score > 0
    ? 'haiku'
    : (c.tier_by_score || 'sonnet');
  return {
    tier,
    summon_panel: !!c.summon_panel,
    rationale: `keyword-floor score=${c.score} summon_panel=${!!c.summon_panel} (opus+sonnet unreachable)`,
  };
}

export async function classifyPrompt(opts = {}) {
  const {
    prompt = '',
    cwd = '',
    branch = '',
    headSha = '',
    dirty = false,
    recentCommits = [],
    stagedFiles = [],
    activeSkills = [],
    apiKey: apiKeyArg,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    model = DEFAULT_MODEL,
    fallbackModel = FALLBACK_MODEL,
    cachePath = DEFAULT_CACHE_PATH,
    skipCache = false,
  } = opts;

  const str = String(prompt || '');

  // 1. Force-opus override — highest priority, no API call.
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

  // 4. API classify (Opus primary, Sonnet fallback).
  const apiKey = apiKeyArg || process.env.ANTHROPIC_API_KEY || '';
  if (apiKey) {
    const system = buildSystemPrompt();
    const user = buildUserMessage({prompt: str, cwd, branch, recentCommits, stagedFiles, activeSkills});

    // Collect API errors for the sentinel's `api_errors` field — v2.8.0.
    // Previously the Sonnet fallback `catch { /* fall through */ }` swallowed
    // errors without trace, making it impossible to tell whether the floor
    // fired because of 401 (bad key), 429 (rate limit), 529 (overloaded), or
    // a network timeout. Now we capture both failure reasons for observability.
    const apiErrors = [];
    try {
      const norm = await tryApiClassify({apiKey, model, system, user, timeoutMs});
      const out = {
        tier: norm.tier,
        summon_panel: norm.summon_panel,
        rationale: norm.rationale || 'opus classified',
        source: 'opus',
        force_opus: false,
        cache_key: key,
      };
      if (!skipCache) cachePut(cachePath, key, {tier: out.tier, summon_panel: out.summon_panel, rationale: out.rationale, source: 'opus'});
      return out;
    } catch (primaryErr) {
      apiErrors.push({model, status: primaryErr.status || null, message: String(primaryErr.message || primaryErr).slice(0, 150)});
      // 5. Sonnet fallback.
      try {
        const norm = await tryApiClassify({apiKey, model: fallbackModel, system, user, timeoutMs});
        const out = {
          tier: norm.tier,
          summon_panel: norm.summon_panel,
          rationale: `${norm.rationale || 'sonnet classified'} [opus unavailable: ${primaryErr.status || primaryErr.message || 'err'}]`.slice(0, 200),
          source: 'sonnet-fallback',
          force_opus: false,
          cache_key: key,
          api_errors: apiErrors,
        };
        if (!skipCache) cachePut(cachePath, key, {tier: out.tier, summon_panel: out.summon_panel, rationale: out.rationale, source: 'sonnet-fallback'});
        return out;
      } catch (fallbackErr) {
        apiErrors.push({model: fallbackModel, status: fallbackErr.status || null, message: String(fallbackErr.message || fallbackErr).slice(0, 150)});
        // Fall through to keyword floor — apiErrors attached below.
      }
    }

    // 6. Keyword floor with API error context — last resort.
    const floorWithErrs = keywordFloor(str);
    return {
      tier: floorWithErrs.tier,
      summon_panel: floorWithErrs.summon_panel,
      rationale: floorWithErrs.rationale,
      source: 'keyword-floor',
      force_opus: false,
      cache_key: key,
      api_errors: apiErrors,
    };
  }

  // 6. Keyword floor — last resort (no API key path, no errors to attach).
  const floor = keywordFloor(str);
  return {
    tier: floor.tier,
    summon_panel: floor.summon_panel,
    rationale: floor.rationale,
    source: 'keyword-floor',
    force_opus: false,
    cache_key: key,
  };
}

// Convenience helper for hooks: synchronous-ish wrapper that returns a
// sentinel-shaped result compatible with the pre-2.2.0 prompt-tier-router
// sentinel. Preserves the {tier, force_opus, dispatched, ...} shape so
// prism-parent-dispatch-guard.mjs keeps working without schema changes.
export function toSentinel(classification, extra = {}) {
  return {
    ts: new Date().toISOString(),
    tier: classification.tier,
    // Legacy score fields are retained but meaningless with the new
    // classifier. Downstream readers treat them as display-only and
    // should not make routing decisions from them. New readers prefer
    // `rationale` + `source`.
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
