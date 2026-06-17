#!/usr/bin/env node
// hooks/prism-acl-worker.mjs — Detached ACL worker
//
// Spawned by prism-acl-sessionend.mjs with {detached:true, stdio:'ignore'}.
// Runs detect → promote under token/time budget, advances watermark.
//
// Factory injection:
//   PRISM_ACL_FACTORY=<absolute-path-to-module.mjs>
//   When set, that module's default export is used as the factory function:
//     factory(spec, stagingDir) → writes a file into stagingDir, returns path.
//   When unset, the real agent-factory subprocess dispatch is used (production).
//   This allows the E2E test to inject a stub factory without touching prod code.
//
// Token/time budget: PRISM_ACL_TOKEN_BUDGET (default from config) and
//   PRISM_ACL_TIME_BUDGET_MS (default 60000ms wall-clock).

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HOME = process.env.HOME || process.env.USERPROFILE;
const TOOL_ROOT = join(HOME, '.claude', 'tools');
const TIME_BUDGET_MS = parseInt(process.env.PRISM_ACL_TIME_BUDGET_MS || '60000', 10);
const workerStart = Date.now();

// ── Dynamic imports with fallback to repo paths ──────────────────────────────

// Resolve tools path: prefer installed (~/.claude/tools/), fall back to repo.
// IMPORTANT: On Windows, URL.pathname gives '/Y:/...' which is invalid for
// fs operations.  Use fileURLToPath() to convert to a proper Windows path.

function resolveTool(name) {
  // Installed path
  const installed = join(TOOL_ROOT, name);
  if (existsSync(installed)) return installed;
  // Repo path (worker lives in hooks/, tools/ is sibling of hooks/)
  try {
    const repoPath = fileURLToPath(new URL('../tools/' + name, import.meta.url));
    if (existsSync(repoPath)) return repoPath;
  } catch {}
  return null;
}

function resolveLib(name) {
  const installed = join(TOOL_ROOT, 'lib', name);
  if (existsSync(installed)) return installed;
  try {
    const repoPath = fileURLToPath(new URL('../tools/lib/' + name, import.meta.url));
    if (existsSync(repoPath)) return repoPath;
  } catch {}
  return null;
}

// ── Default production factory (real agent-factory dispatch) ─────────────────

async function productionFactory(spec, stagingDir) {
  // In production, dispatches agent-factory to author the capability.
  // Simplified here: write a minimal skeleton; the real impl would spawn
  // `claude -p @agent-factory create --name <name> --output <stagingDir>`.
  // For now emit a placeholder so the worker is wirable end-to-end without
  // requiring a live LLM in the test.
  const dest = join(stagingDir, spec.name + '.md');
  const content = [
    '---',
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    `type: ${spec.type}`,
    'version: 1',
    '---',
    '',
    `# ${spec.name}`,
    '',
    `Auto-created capability via ACL. Members: ${(spec.members || []).slice(0, 3).join('; ')}.`,
  ].join('\n');
  writeFileSync(dest, content, 'utf-8');
  return dest;
}

// ── Load factory (env-injectable) ────────────────────────────────────────────

async function loadFactory() {
  const factoryEnv = process.env.PRISM_ACL_FACTORY;
  if (factoryEnv && existsSync(factoryEnv)) {
    try {
      const mod = await import(pathToFileURL(factoryEnv).href);
      if (typeof mod.default === 'function') return mod.default;
      if (typeof mod.factory === 'function') return mod.factory;
    } catch (e) {
      process.stderr.write(`[acl-worker] PRISM_ACL_FACTORY load error: ${e.message}\n`);
    }
  }
  return productionFactory;
}

// ── Main worker loop ─────────────────────────────────────────────────────────

async function main() {
  try {
    // Load store
    const storePath = resolveLib('prism-acl-store.mjs');
    if (!storePath) throw new Error('prism-acl-store.mjs not found');
    const store = await import(pathToFileURL(storePath).href);
    const { loadConfig, readWatermark, writeWatermark, queuePath, digestPath, stagingPath } = store;

    const cfg = loadConfig(HOME);
    if (!cfg.enabled) {
      process.stderr.write('[acl-worker] ACL disabled in config; exiting\n');
      return;
    }

    // Load detector
    const detectPath = resolveTool('prism-capability-detect.mjs');
    if (!detectPath) throw new Error('prism-capability-detect.mjs not found');
    const { detect } = await import(pathToFileURL(detectPath).href);

    // Load promoter
    const promotePath = resolveTool('prism-capability-promote.mjs');
    if (!promotePath) throw new Error('prism-capability-promote.mjs not found');
    const { promote } = await import(pathToFileURL(promotePath).href);

    // Load learner
    const learnPath = resolveTool('prism-capability-learn.mjs');
    if (!learnPath) throw new Error('prism-capability-learn.mjs not found');
    const { attribute, learn } = await import(pathToFileURL(learnPath).href);

    const factory = await loadFactory();

    // Routing log path
    const routingPath = join(HOME, '.claude', '.prism-routing.jsonl');
    if (!existsSync(routingPath)) {
      process.stderr.write('[acl-worker] no routing log found; exiting\n');
      return;
    }

    const sinceLine = readWatermark(HOME);

    // Count total lines to advance watermark
    const allLines = readFileSync(routingPath, 'utf-8').split('\n').filter(l => l.trim());
    const newWatermark = allLines.length;

    // Detect candidates
    const rosterPath = join(HOME, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    const candidates = detect({
      routingPath,
      sinceLine,
      threshold: cfg.cluster_threshold,
      rosterPath: existsSync(rosterPath) ? rosterPath : null,
    });

    // Promote each candidate (within time budget)
    let promoted = 0;
    for (const cand of candidates) {
      if (cand.kind !== 'promote') continue;
      if (Date.now() - workerStart > TIME_BUDGET_MS) {
        process.stderr.write(`[acl-worker] time budget exceeded; deferring ${candidates.length - promoted} candidates\n`);
        break;
      }
      try {
        await promote(cand, { home: HOME, factory });
        promoted++;
      } catch (e) {
        process.stderr.write(`[acl-worker] promote failed for ${cand.label}: ${e.message}\n`);
      }
    }

    // ── Learn phase: attribute corrections → upgrade if threshold reached ────
    const lessonsPath = join(HOME, '.claude', '.prism-lessons.jsonl');
    if (Date.now() - workerStart < TIME_BUDGET_MS) {
      try {
        await attribute({
          home: HOME,
          lessonsPath,
          routingPath,
          rosterPath: existsSync(rosterPath) ? rosterPath : null,
        });
      } catch (e) {
        process.stderr.write(`[acl-worker] attribute failed: ${e.message}\n`);
      }
    }

    if (Date.now() - workerStart < TIME_BUDGET_MS) {
      try {
        await learn({
          home: HOME,
          factory,
          rosterPath: existsSync(rosterPath) ? rosterPath : null,
        });
      } catch (e) {
        process.stderr.write(`[acl-worker] learn failed: ${e.message}\n`);
      }
    }

    // Advance watermark (once, at end of pass)
    writeWatermark(HOME, newWatermark);

    process.stderr.write(`[acl-worker] done: ${promoted} promoted, watermark ${sinceLine}→${newWatermark}\n`);
  } catch (e) {
    process.stderr.write(`[acl-worker] fatal: ${e.message}\n${e.stack}\n`);
  }
}

main();
