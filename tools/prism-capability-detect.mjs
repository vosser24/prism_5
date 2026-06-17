// tools/prism-capability-detect.mjs — ACL incremental capability detector
//
// KB-reuse decision: uses tokenize() from tools/lib/prism-bm25.mjs (cleanly
// exported, pure, no I/O). Pairwise clustering uses Jaccard similarity over
// token sets (cosine of binary token-set vectors) with threshold 0.25. This is
// lighter than full BM25 scoring (no corpus stats needed) and sufficient for
// the ~10-token descriptions that populate the routing log.

import { readFileSync, existsSync } from 'node:fs';
import { tokenize } from './lib/prism-bm25.mjs';

// ── Jaccard similarity over token sets ───────────────────────────────────────
const JACCARD_THRESHOLD = 0.25;

function jaccard(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Roster match: returns true if the cluster seems well covered ──────────────
function hasStrongRosterMatch(clusterTokenSet, rosterEntries) {
  for (const entry of rosterEntries) {
    const nameTokens = tokenize(entry.name || '');
    const kwTokens = (entry.keywords || []).flatMap(k => tokenize(k));
    const entryTokens = [...nameTokens, ...kwTokens];
    if (!entryTokens.length) continue;
    const j = jaccard([...clusterTokenSet], entryTokens);
    if (j >= 0.35) return true;
  }
  return false;
}

// ── Clustering (greedy single-link) ──────────────────────────────────────────
function cluster(entries) {
  const clusters = [];
  const assigned = new Array(entries.length).fill(false);

  for (let i = 0; i < entries.length; i++) {
    if (assigned[i]) continue;
    const group = [i];
    assigned[i] = true;
    for (let j = i + 1; j < entries.length; j++) {
      if (assigned[j]) continue;
      // Check similarity against ANY member already in this group (single-link)
      for (const gi of group) {
        const sim = jaccard(entries[gi].tokens, entries[j].tokens);
        if (sim >= JACCARD_THRESHOLD) {
          group.push(j);
          assigned[j] = true;
          break;
        }
      }
    }
    clusters.push(group);
  }
  return clusters;
}

// ── Label: most-common content tokens across cluster members ──────────────────
const STOP = new Set(['process', 'service', 'new', 'create', 'build', 'implement',
  'set', 'up', 'the', 'for', 'and', 'that', 'with', 'add', 'run', 'make']);

function clusterLabel(members) {
  const freq = new Map();
  for (const m of members) {
    for (const t of new Set(m.tokens)) {
      if (STOP.has(t) || t.length <= 2) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 3).map(([t]) => t).join('-') || 'unnamed-cluster';
}

// ── Verb-lexicon classifier ───────────────────────────────────────────────────
const SKILL_VERBS = new Set([
  'set', 'configure', 'scaffold', 'setup', 'install', 'create', 'build',
  'write', 'generate', 'run', 'deploy', 'add', 'update', 'fix', 'implement',
  'migrate', 'init', 'initialize', 'bootstrap', 'seed', 'format', 'lint',
]);

const AGENT_VERBS = new Set([
  'design', 'evaluate', 'decide', 'assess', 'review', 'analyze', 'analyse',
  'recommend', 'advise', 'determine', 'judge', 'plan', 'strategize', 'compare',
  'select', 'choose', 'consider', 'investigate', 'research',
]);

export function classifyCapabilityType(members) {
  let skillScore = 0;
  let agentScore = 0;
  for (const m of members) {
    const text = typeof m === 'string' ? m : (m.description || '');
    const tokens = tokenize(text);
    for (const t of tokens) {
      if (SKILL_VERBS.has(t)) skillScore++;
      if (AGENT_VERBS.has(t)) agentScore++;
    }
  }
  return agentScore > skillScore ? 'agent' : 'skill'; // tie-break → 'skill'
}

// ── detect: pure function, all paths injected ─────────────────────────────────
export function detect({ routingPath, sinceLine = 0, threshold = 3, rosterPath = null }) {
  // Read routing JSONL
  if (!existsSync(routingPath)) return [];
  const raw = readFileSync(routingPath, 'utf-8');
  const allLines = raw.split('\n').filter(l => l.trim());

  // Extract lines after sinceLine
  const lines = allLines.slice(sinceLine);

  // Parse entries with meaningful description
  const entries = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const text = obj.description || obj.prompt || '';
    if (!text.trim()) continue;
    const tokens = tokenize(text);
    if (!tokens.length) continue;
    entries.push({
      text,
      tokens,
      session_id: obj.session_id || 'anon',
      ts: obj.ts || '',
    });
  }

  if (entries.length < threshold) return [];

  // Load roster entries for strong-fit check
  let rosterEntries = [];
  if (rosterPath && existsSync(rosterPath)) {
    try {
      const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
      for (const [name, data] of Object.entries(r.agents || {})) {
        rosterEntries.push({ name, keywords: data.keywords || [] });
      }
      for (const [name, data] of Object.entries(r.skills || {})) {
        rosterEntries.push({ name, keywords: data.keywords || [] });
      }
    } catch { /* malformed roster — ignore */ }
  }

  // Cluster
  const groups = cluster(entries);

  const candidates = [];
  for (const group of groups) {
    if (group.length < threshold) continue;

    const members = group.map(i => entries[i]);
    const sessions = members.map(m => m.session_id);
    const distinctSessions = new Set(sessions).size;

    if (distinctSessions < 2) continue;

    // Build combined token set for roster match
    const allTokens = members.flatMap(m => m.tokens);
    const clusterTokenSet = new Set(allTokens);

    // Check for strong roster match
    if (hasStrongRosterMatch(clusterTokenSet, rosterEntries)) continue;

    const label = clusterLabel(members);
    const suggestedType = classifyCapabilityType(members.map(m => m.text));

    candidates.push({
      kind: 'promote',
      label,
      members: members.map(m => m.text),
      sessions,
      suggestedType,
    });
  }

  return candidates;
}
