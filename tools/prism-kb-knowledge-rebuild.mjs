#!/usr/bin/env node
// PRISM KB Knowledge Rebuild — drain-at-Stop refresher (v5.0 F4 Phase E)
//
// Drains the dedicated ~/.claude/.prism-kb-knowledge-dirty flag and rebuilds the
// cross-project knowledge index (~/.claude/../.prism-kb/knowledge-index.json) for
// each project that changed during the session. Mirrors prism-kb-rebuild.mjs's
// --sync/--quiet CLI shape and the resource-index Stop-drain pattern
// (prism-session-end.mjs), but targets the F4 knowledge corpus, not the resource
// descriptor index.
//
// Design reference: docs/prism/plans/2026-05-29-F4-design.md §5 (freshness/sync):
//   "Drain at Stop, identical pattern to today: detached background
//    prism-kb-knowledge-rebuild (--sync --quiet). Zero per-turn latency."
//
// Dep-free: Node core + the synchronous buildKnowledgeIndex primitive. No async,
// no network. Windows/SMB safe (atomic write lives in the indexer; we only read
// the flag + unlink it).
//
// Usage:
//   node ~/.claude/tools/prism-kb-knowledge-rebuild.mjs              # rebuild changed project(s)
//   node ~/.claude/tools/prism-kb-knowledge-rebuild.mjs --sync       # (alias; the index IS the sync target — no cloud push)
//   node ~/.claude/tools/prism-kb-knowledge-rebuild.mjs --sync --quiet  # scheduled / detached drain

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';

import { buildKnowledgeIndex } from './prism-kb-knowledge-indexer.mjs';

// ── exported path helper ──────────────────────────────────────────────────────
// The dedicated knowledge dirty flag lives next to the resource-index dirty flag,
// under ~/.claude/, but is SEPARATE so the two rebuilds never couple (§5).
export function knowledgeDirtyFlagPath(home) {
  return join(home, '.claude', '.prism-kb-knowledge-dirty');
}

// ── readDirtyPaths ────────────────────────────────────────────────────────────
// Reads the dirty flag, returns the non-blank path lines. [] if absent/unreadable.
export function readDirtyPaths(flagPath) {
  if (!flagPath || !existsSync(flagPath)) return [];
  let raw;
  try { raw = readFileSync(flagPath, 'utf-8'); } catch { return []; }
  return raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

// ── deriveProjectRoots ────────────────────────────────────────────────────────
// Walk up from each dirty path to the nearest ancestor that carries a
// .prism-kb-share.json marker — the authoritative project root for sharing.
// Only shared projects contribute to the index, and autosync only marks dirty
// for shared corpus types, so the changed project always has a marker. Paths with
// no marked ancestor (e.g. home-global verdict logs under ~/.claude) yield nothing
// and are dropped. Deduped, insertion-ordered.
export function deriveProjectRoots(paths, existsFn = existsSync) {
  const seen = new Set();
  const roots = [];
  for (const p of paths || []) {
    let dir = dirname(String(p));
    let prev = null;
    // Bounded walk to filesystem root.
    while (dir && dir !== prev) {
      if (existsFn(join(dir, '.prism-kb-share.json'))) {
        if (!seen.has(dir)) { seen.add(dir); roots.push(dir); }
        break;
      }
      prev = dir;
      dir = dirname(dir);
    }
  }
  return roots;
}

// ── runKnowledgeRebuild ────────────────────────────────────────────────────────
// SYNCHRONOUS. Determines the target project root(s), then rebuilds the knowledge
// index once per root (buildKnowledgeIndex merges per project_id + always refreshes
// the home-global verdicts each call). Drains the dirty flag afterward.
//   opts.roots         — explicit roots (skip derivation); used by tests + callers
//   opts.dirtyFlagPath — flag to read + clear (default: knowledgeDirtyFlagPath(home))
//   opts.now           — frozen indexed_at for deterministic tests
//   opts.clearFlag     — default true; unlink the flag after draining
// Returns {roots, index} where index is the final merged index object.
export function runKnowledgeRebuild({ home, roots, dirtyFlagPath, now, clearFlag = true } = {}) {
  const flagPath = dirtyFlagPath || knowledgeDirtyFlagPath(home);

  let targetRoots = Array.isArray(roots) && roots.length ? roots.slice() : null;
  if (!targetRoots) {
    targetRoots = deriveProjectRoots(readDirtyPaths(flagPath));
  }
  // Fallback: nothing derived (verdict-only change, or marker since removed) — still
  // rebuild once against cwd so the always-on verdicts refresh. cwd may share nothing
  // (default-deny), which is fine: the project contributes 0 entries, verdicts refresh.
  if (!targetRoots.length) targetRoots = [process.cwd()];

  let index = null;
  for (const root of targetRoots) {
    index = buildKnowledgeIndex({ home, projectRoot: root, now });
  }

  if (clearFlag && existsSync(flagPath)) {
    try { unlinkSync(flagPath); } catch { /* best-effort drain */ }
  }

  return { roots: targetRoots, index };
}

// ── CLI entry ──────────────────────────────────────────────────────────────────
// Guard on the exact basename so importing the same-suffixed test file does NOT
// trigger it. --sync/--quiet accepted for parity with prism-kb-rebuild.mjs; the
// local JSON index IS the sync target (no cloud push), so --sync is a no-op alias.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-kb-knowledge-rebuild.mjs';
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const home = process.env.HOME || process.env.USERPROFILE;
  const { roots, index } = runKnowledgeRebuild({ home });
  if (!quiet) {
    console.log(`PRISM knowledge index rebuilt: ${index ? index.doc_count : 0} entries across ${roots.length} project root(s).`);
    console.log(`Roots: ${roots.map(r => basename(r)).join(', ')}`);
  }
}
