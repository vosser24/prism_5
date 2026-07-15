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
// Invocation shape (CORRECTED — see audit findings):
//
//   <claudeBin> \
//     --agent agent-factory \
//     --settings '{"disableAllHooks":true}' \
//     --dangerously-skip-permissions \
//     --max-turns 5 \
//     --output-format json \
//     --no-session-persistence \
//     -p "<prompt>"
//
//   • `--agent agent-factory` runs the session AS the agent-factory agent (correct).
//     Subagents cannot be invoked via `claude -p` directly; there is no `--subagent`
//     flag. `--agent` is the proper way to load and run a named agent headlessly.
//   • `--settings '{"disableAllHooks":true}'` replaces the earlier `--bare`, which
//     was found (live, 2026-06-17) to strip OAuth → "Not logged in". disableAllHooks
//     sandboxes the factory from PRISM's own blocking PreToolUse guards while
//     preserving credentials.
//   • `--name` and `--output-dir` are NOT real Claude CLI flags and were removed.
//     They were silently ignored by the real CLI, doing nothing.
//   • Output location is controlled via the PROMPT TEXT and the STAGING_DIR /
//     PRISM_ACL_STAGING_DIR environment variables set on the child process.
//   • The prompt explicitly instructs agent-factory to write to
//     <stagingDir>/<name>.md and NOT to the default ~/.claude/agents/ location.
//
// POST-RUN FALLBACK (robustness):
//   After a 0-exit, if <stagingDir>/<name>.md is absent, agent-factory may have
//   written to its default CREATE PROTOCOL path instead:
//     ~/.claude/agents/<name>/<name>.md   (directory form — DUAL FILE REQUIREMENT)
//     ~/.claude/agents/<name>.md          (flat file — Claude Code loads this)
//   If found at either default location, the file is MOVED into stagingDir.
//   If still no file → return null (graceful skip).
//
// PRODUCTION CORRECTNESS NOTE (VERIFIED 2026-06-17 via live CLI smoke-test):
//   `--agent agent-factory` loads and runs the agent headlessly. The original
//   `--bare` flag broke this in two ways, both reproduced live:
//     1. `claude --bare ...` returns "Not logged in · Please run /login" (cost 0)
//        — --bare skips OAuth/credential loading.
//     2. Even without --bare, the headless session inherits ~/.claude/settings.json,
//        so PRISM's own PreToolUse guards block agent-factory's Write/Bash
//        ("environment deadlock — Write and Bash writes are blocked").
//   The fix (this file): drop --bare, add `--settings '{"disableAllHooks":true}'`.
//   Validated end-to-end: agent-factory authenticated, ran, and wrote a capability
//   .md with valid frontmatter to the staging dir. ($0.03, 2 turns.)
//
// PRISM_ACL_CLAUDE_BIN supports a space-separated value such as
//   "node /absolute/path/to/stub.mjs"
// in which case the string is split on spaces: first token = executable,
// remaining tokens are prepended to argv before the flags.
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

  // Agent-factory's default CREATE PROTOCOL output path (DUAL FILE REQUIREMENT):
  //   ~/.claude/agents/<name>/<name>.md  (directory form — for PRISM)
  //   ~/.claude/agents/<name>.md         (flat form — for Claude Code @agent loading)
  // Re-read HOME each call so tests can override it at runtime.
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const defaultAgentsDir = join(homeDir, '.claude', 'agents');
  const defaultFlatFile = join(defaultAgentsDir, name + '.md');
  const defaultDirFile  = join(defaultAgentsDir, name, name + '.md');

  // Build the prompt: explicitly instruct agent-factory to write to stagingDir,
  // NOT to the default ~/.claude/agents/ location.
  const prompt = [
    `@agent-factory Create a ${type} capability named ${name}.`,
    `Description: ${description}.`,
    `Write the capability markdown to the absolute path ${expectedFile}`,
    `(read STAGING_DIR env). Do NOT use ~/.claude/agents or any default location.`,
    `Include valid YAML frontmatter with these fields: name, description, type, version: 1.`,
    `Members of this cluster: ${(spec.members || []).slice(0, 5).join(', ')}.`,
  ].join(' ');

  // Corrected argv (v5.9.4 — LIVE-VALIDATED 2026-06-17, see CORRECTNESS NOTE below):
  //   • --agent agent-factory: run the headless session AS the agent-factory agent.
  //   • --bare was REMOVED. `--bare` strips OAuth credential loading, so every
  //     real headless dispatch failed with "Not logged in · Please run /login"
  //     and produced no file. (`--bare`'s intent was to skip hooks so PRISM's own
  //     guards don't block the factory — but it ALSO killed auth.)
  //   • --settings '{"disableAllHooks":true}' REPLACES --bare: it disables ALL
  //     hooks for the factory subprocess WITHOUT touching auth, so PRISM's own
  //     PreToolUse guards (parent-dispatch + mutation) cannot block agent-factory's
  //     Write/Bash file creation. This is exactly what --bare was reaching for,
  //     minus the credential breakage.
  //   • --name and --output-dir are NOT real Claude CLI flags (removed earlier).
  const args = [
    ...claudePrefixArgs,
    '--agent', 'agent-factory',
    '--settings', '{"disableAllHooks":true}',
    '--dangerously-skip-permissions',
    '--max-turns', '5',
    '--output-format', 'json',
    '--no-session-persistence',
    '-p', prompt,
  ];

  // Child env: inherit process.env plus staging dir overrides so agent-factory
  // (or test stubs) can locate the target directory without parsing the prompt.
  const childEnv = {
    ...process.env,
    STAGING_DIR: stagingDir,
    PRISM_ACL_STAGING_DIR: stagingDir,
  };

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
        env: childEnv,
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

      // Success path: check staging file first
      if (existsSync(expectedFile)) {
        finish(expectedFile);
        return;
      }

      // Post-run fallback: agent-factory may have written to its default location.
      // Check flat file first (Claude Code loads from flat .md), then directory form.
      let fallbackSrc = null;
      if (existsSync(defaultFlatFile)) {
        fallbackSrc = defaultFlatFile;
      } else if (existsSync(defaultDirFile)) {
        fallbackSrc = defaultDirFile;
      }

      if (fallbackSrc) {
        try {
          // Ensure staging dir exists (it should already)
          mkdirSync(stagingDir, { recursive: true });
          // Read + write to staging (cross-device safe — renameSync fails across volumes)
          const content = readFileSync(fallbackSrc, 'utf-8');
          writeFileSync(expectedFile, content, 'utf-8');
          // Remove source files to avoid leaving stale agents in the default location
          try { unlinkSync(fallbackSrc); } catch {}
          // Also remove the other form if it exists
          const otherSrc = fallbackSrc === defaultFlatFile ? defaultDirFile : defaultFlatFile;
          try { if (existsSync(otherSrc)) unlinkSync(otherSrc); } catch {}
          process.stderr.write(
            `[acl-worker] productionFactory: fallback-move ${fallbackSrc} → ${expectedFile}\n`,
          );
          finish(expectedFile);
        } catch (moveErr) {
          process.stderr.write(
            `[acl-worker] productionFactory: fallback-move failed: ${moveErr.message}\n`,
          );
          finish(null);
        }
        return;
      }

      // No file found anywhere → graceful skip
      process.stderr.write(
        `[acl-worker] productionFactory: no file produced at ${expectedFile} for ${name}\n`,
      );
      finish(null);
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
