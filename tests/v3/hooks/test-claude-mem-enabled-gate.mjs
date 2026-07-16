#!/usr/bin/env node
// tests/v3/hooks/test-claude-mem-enabled-gate.mjs
//
// D042 — claude-mem guard/detector must respect a user-disabled plugin
// (enabledPlugins["claude-mem@*"] === false in settings.json) and treat it
// as ABSENT everywhere, while still alerting for a genuinely
// enabled-but-unhealthy install. Zero prior coverage for either path.
//
// Uses a temp HOME (os.tmpdir()) fixture per case — never reads the real
// ~/.claude.

import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

import {claudeMemInstalled, claudeMemHealthy, claudeMemPluginDisabled} from '../../../hooks/lib/prism-claude-mem-detect.mjs';
import {healClaudeMem} from '../../../hooks/lib/prism-claude-mem-guard.mjs';
import {readFileSync} from 'node:fs';

// Runs the real memory-save-nudge hook (env-driven HOME) and returns every
// memory_save_nudge routing-log entry it appended (empty array if it never
// wrote — the native path only logs on the two claude-mem branches, or once
// a nudge threshold turn is hit), so we assert the actual dispatched action —
// not just the detector primitives it's built on.
async function runMemorySaveNudge(home, sessionId) {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`../../../hooks/prism-memory-save-nudge.mjs?t=${Date.now()}-${Math.random()}`);
    await mod.run({session_id: sessionId});
    const logPath = join(home, '.claude', '.prism-routing.jsonl');
    let raw = '';
    try { raw = readFileSync(logPath, 'utf8'); } catch { return []; }
    return raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function makeHome(label) {
  const home = mkdtempSync(join(tmpdir(), `prism-cm-gate-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}

function writeSettings(home, enabledPlugins) {
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({enabledPlugins}, null, 2)
  );
}

function writeClaudeMemArtifacts(home, {consecutiveFailures = 5} = {}) {
  const dataDir = join(home, '.claude-mem');
  mkdirSync(join(dataDir, 'state'), {recursive: true});
  writeFileSync(
    join(dataDir, 'state', 'hook-failures.json'),
    JSON.stringify({consecutiveFailures, lastFailureAt: Date.now()})
  );
}

function writePluginCacheHooks(home) {
  // Mirrors resolveClaudeMem()'s real lookup: installed_plugins.json points
  // at a versioned cache dir containing hooks/hooks.json. Needed so the
  // guard has a genuine installPath+root to find if the disabled-gate did
  // NOT short-circuit it (proves case (a) short-circuits, not "nothing to find").
  const installPath = join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '13.11.0');
  mkdirSync(join(installPath, 'hooks'), {recursive: true});
  writeFileSync(
    join(installPath, 'hooks', 'hooks.json'),
    JSON.stringify({hooks: {SessionStart: [{hooks: [{type: 'command', command: "$($SHELL -lc 'echo $PATH' 2>/dev/null) noop"}]}]}})
  );
  const pluginsDir = join(home, '.claude', 'plugins');
  mkdirSync(pluginsDir, {recursive: true});
  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'claude-mem@thedotmack': [{scope: 'user', installPath, version: '13.11.0'}],
      },
    })
  );
}

async function run() {
  console.log('--- Case (a): DISABLED (enabled:false, dir + artifacts present) ---');
  {
    const home = makeHome('disabled');
    writeSettings(home, {'claude-mem@thedotmack': false});
    writeClaudeMemArtifacts(home, {consecutiveFailures: 5});
    writePluginCacheHooks(home);

    const disabled = claudeMemPluginDisabled(home);
    check('claudeMemPluginDisabled() === true', disabled === true, `got ${disabled}`);

    const installed = claudeMemInstalled(home);
    check('claudeMemInstalled() === false (treated as absent)', installed === false, `got ${installed}`);

    const {notices} = await healClaudeMem({home});
    check('healClaudeMem() emits zero notices (no probe, no :37790 alert)', notices.length === 0, JSON.stringify(notices));
    const portMention = notices.some(n => /37790|worker not responding/.test(n));
    check('no notice mentions the worker port / health alert', !portMention, JSON.stringify(notices));

    const nudgeLogs = await runMemorySaveNudge(home, 'sess-disabled');
    const badActions = nudgeLogs.filter(l => l.action === 'fallback-claude-mem-unhealthy' || l.action === 'standdown-claude-mem-healthy');
    check(
      'memory-save-nudge takes the native path (no fallback-claude-mem-unhealthy, no standdown-claude-mem-healthy log entries)',
      badActions.length === 0,
      JSON.stringify(nudgeLogs)
    );

    rmSync(home, {recursive: true, force: true});
  }

  console.log('--- Case (b): ENABLED-BUT-UNHEALTHY (enabled:true, dead port) ---');
  {
    const home = makeHome('unhealthy-enabled');
    writeSettings(home, {'claude-mem@thedotmack': true});
    writeClaudeMemArtifacts(home, {consecutiveFailures: 5});
    writePluginCacheHooks(home);
    // Pin a worker port far from any real listener so the health probe fails fast.
    mkdirSync(join(home, '.claude-mem'), {recursive: true});
    writeFileSync(join(home, '.claude-mem', 'settings.json'), JSON.stringify({CLOUD: 1}));

    const disabled = claudeMemPluginDisabled(home);
    check('claudeMemPluginDisabled() === false', disabled === false, `got ${disabled}`);

    const installed = claudeMemInstalled(home);
    check('claudeMemInstalled() === true (still installed)', installed === true, `got ${installed}`);

    const healthy = claudeMemHealthy(home);
    check('claudeMemHealthy() === false (consecutiveFailures=5)', healthy === false, `got ${healthy}`);

    const {notices} = await healClaudeMem({home});
    // First call also pins a fresh worker port (changed:true) — the health
    // alert only fires once the config is stable, matching existing guard
    // behavior (see prism-claude-mem-guard.mjs step 3 comment). Call twice
    // to reach the stable-config branch and assert the alert fires there.
    const {notices: notices2} = await healClaudeMem({home});
    const allNotices = [...notices, ...notices2];
    const alerted = allNotices.some(n => /not responding|:\d{4,5}/.test(n));
    check('health alert IS preserved for enabled-but-unhealthy install', alerted, JSON.stringify(allNotices));

    const nudgeLogs = await runMemorySaveNudge(home, 'sess-unhealthy-enabled');
    const fellBack = nudgeLogs.some(l => l.action === 'fallback-claude-mem-unhealthy');
    check('memory-save-nudge STILL fires fallback-claude-mem-unhealthy for enabled-but-unhealthy install', fellBack, JSON.stringify(nudgeLogs));

    rmSync(home, {recursive: true, force: true});
  }

  console.log('--- Case (c): ABSENT (no claude-mem record at all) ---');
  {
    const home = makeHome('absent');
    writeSettings(home, {'some-other-plugin@publisher': true});

    const disabled = claudeMemPluginDisabled(home);
    check('claudeMemPluginDisabled() === false (no claude-mem key)', disabled === false, `got ${disabled}`);

    const installed = claudeMemInstalled(home);
    check('claudeMemInstalled() === false (no dir, no settings match)', installed === false, `got ${installed}`);

    const {notices} = await healClaudeMem({home});
    check('healClaudeMem() emits zero notices (nothing to heal)', notices.length === 0, JSON.stringify(notices));

    rmSync(home, {recursive: true, force: true});
  }

  console.log('--- Case (a2): fail-open on unreadable/absent settings.json ---');
  {
    const home = mkdtempSync(join(tmpdir(), 'prism-cm-gate-nosettings-'));
    // No .claude dir at all — settings.json read must throw and be caught.
    const disabled = claudeMemPluginDisabled(home);
    check('claudeMemPluginDisabled() fails open to false on missing settings.json', disabled === false, `got ${disabled}`);
    rmSync(home, {recursive: true, force: true});
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
