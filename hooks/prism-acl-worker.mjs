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
//
// Production factory binary:
//   PRISM_ACL_CLAUDE_BIN — overrides the 'claude' CLI binary.
//     May be a space-separated string like "node /path/to/stub.mjs" for testing.
//     Default: 'claude'
//   PRISM_ACL_FACTORY_TIMEOUT_MS — per-invocation hard timeout (default: 120000ms).
//     Kills the child process if it exceeds this wall-clock limit.

import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

// ── Per-factory hard timeout ──────────────────────────────────────────────────
// Derived from PRISM_ACL_FACTORY_TIMEOUT_MS env (re-read each call so tests can
// override it at runtime without re-importing the module).
// Default: 120 000 ms (2 minutes).  Exported so tests can introspect the default.
export const FACTORY_TIMEOUT_MS = 120000;

// ── Default production factory (real agent-factory dispatch) ─────────────────
//
// Invocation shape (ASSUMPTION — documented here):
//   <claudeBin> -p "@agent-factory Create a <type> capability named <name>.
//     Description: <description>.
//     Write the capability markdown file to the directory: <stagingDir>.
//     Output the file as <stagingDir>/<name>.md with valid YAML frontmatter
//     (name, description, type, version: 1)." \
//     --name <name> --output-dir <stagingDir>
//
//   • `-p` / `--print` is the Claude CLI headless/non-interactive flag.
//   • The prompt text tells @agent-factory what to create and WHERE to write it.
//   • `--name` and `--output-dir` are also passed as separate structured args
//     so that test stubs can parse them cheaply without interpreting the prompt.
//
// PRISM_ACL_CLAUDE_BIN supports a space-separated value such as
//   "node /absolute/path/to/stub.mjs"
// in which case the string is split on spaces: first token = executable,
// remaining tokens are prepended to argv before the -p flag.
//
// Graceful failure contract:
//   Returns null (never throws) on: timeout, non-zero exit, no file produced.
//   Cleans up any partial file written to stagingDir before returning null.
//   The caller (promote loop) try/catches per-candidate, so null causes a skip.
//
export async function productionFactory(spec, stagingDir) {
  // Read per-factory timeout from env each time (allows test override at runtime)
  const factoryTimeoutMs = parseInt(
    process.env.PRISM_ACL_FACTORY_TIMEOUT_MS || String(FACTORY_TIMEOUT_MS),
    10,
  );

  // Resolve binary: support "node /path/to/stub.mjs" space-split form for testing
  const claudeBinRaw = (process.env.PRISM_ACL_CLAUDE_BIN || 'claude').trim();
  const claudeBinParts = claudeBinRaw.split(/\s+/);
  const claudeExe = claudeBinParts[0];
  const claudePrefixArgs = claudeBinParts.slice(1); // may be empty in production

  const { name, description, type } = spec;
  const expectedFile = join(stagingDir, name + '.md');

  // Build the prompt for agent-factory
  const prompt = [
    `@agent-factory Create a ${type} capability named ${name}.`,
    `Description: ${description}.`,
    `Write the capability markdown file to the directory: ${stagingDir}.`,
    `The file MUST be written as: ${expectedFile}`,
    `Include valid YAML frontmatter with these fields: name, description, type, version: 1.`,
    `Members of this cluster: ${(spec.members || []).slice(0, 5).join(', ')}.`,
  ].join(' ');

  // argv: [<prefixArgs...>, '-p', <prompt>, '--name', <name>, '--output-dir', <stagingDir>]
  const args = [
    ...claudePrefixArgs,
    '-p', prompt,
    '--name', name,
    '--output-dir', stagingDir,
  ];

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let child;
    try {
      child = spawn(claudeExe, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Inherit env so the subprocess gets PATH etc., but don't pass factory-specific
        // env vars that could confuse a real Claude invocation
        env: process.env,
      });
    } catch (spawnErr) {
      process.stderr.write(`[acl-worker] productionFactory spawn error: ${spawnErr.message}\n`);
      finish(null);
      return;
    }

    // Hard timeout: kill child if it exceeds budget
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `[acl-worker] productionFactory timeout (${factoryTimeoutMs}ms) for ${name}; killing child\n`,
      );
      try { child.kill('SIGTERM'); } catch {}
      // Give the process 2s to die gracefully before SIGKILL
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 2000);
      // Clean up any partial file
      try { if (existsSync(expectedFile)) unlinkSync(expectedFile); } catch {}
      finish(null);
    }, factoryTimeoutMs);

    // Collect stderr for diagnostics (stdout is the capability content if any)
    const stderrChunks = [];
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`[acl-worker] productionFactory child error: ${err.message}\n`);
      try { if (existsSync(expectedFile)) unlinkSync(expectedFile); } catch {}
      finish(null);
    });

    child.on('close', (code) => {
      if (timedOut) return; // timeout already settled
      clearTimeout(timer);

      if (code !== 0) {
        const errText = Buffer.concat(stderrChunks).toString('utf-8').trim();
        process.stderr.write(
          `[acl-worker] productionFactory exited ${code} for ${name}` +
          (errText ? `: ${errText.slice(0, 200)}` : '') + '\n',
        );
        // Clean up any partial file
        try { if (existsSync(expectedFile)) unlinkSync(expectedFile); } catch {}
        finish(null);
        return;
      }

      // Non-zero or missing file → null
      if (!existsSync(expectedFile)) {
        process.stderr.write(
          `[acl-worker] productionFactory: no file produced at ${expectedFile} for ${name}\n`,
        );
        finish(null);
        return;
      }

      finish(expectedFile);
    });
  });
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

// Only run main() when this file is executed directly (not imported as a module).
// This allows test files to import productionFactory without triggering the worker loop.
// Both fileURLToPath(import.meta.url) and process.argv[1] return OS-native paths.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
