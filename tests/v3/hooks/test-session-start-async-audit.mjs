#!/usr/bin/env node
// E-P4: Test that prism-session-start.mjs uses detached fire-and-forget spawn
// (not blocking spawnSync) for the context-audit run.
//
// Lessons from E-P1/E-P2/E-P3:
//   - Node startup floor on this machine is ~82-100ms; "< 150ms" for the whole
//     subprocess would be impossible. We use a generous 600ms subprocess bound
//     alongside an 800ms stub that makes the BLOCKING path take ~800ms+.
//   - Primary proof is STRUCTURAL (source grep), not timing.
//   - All three detached flags (detached:true, stdio:'ignore', .unref()) must
//     be present.
//
// Module does NOT export run() — pure script. Subprocess timing only.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const HOOK = join(HOOKS, 'prism-session-start.mjs');
const SRC = readFileSync(HOOK, 'utf-8');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// Helper: make a minimal fake HOME the hook will accept.
function makeHome(label) {
  const home = mkdtempSync(join(tmpdir(), `ep4-ss-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(home, '.claude', 'tools'), {recursive: true});
  mkdirSync(join(home, '.claude', 'hooks', 'lib'), {recursive: true});
  return home;
}

// Helper: run the hook as a subprocess with a given HOME.
// Returns {status, stdout, stderr, elapsed}.
function runHook(home, extraEnv = {}) {
  const payload = JSON.stringify({session_id: 'test-ep4', cwd: home});
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PRISM_DISABLE_FRESHNESS_SWEEP: '1',
      PRISM_DISABLE_PARALLEL_REMINDER: '1',
      PRISM_DISABLE_CLAUDE_MEM_GUARD: '1',
      ...extraEnv,
    },
  });
  const elapsed = Date.now() - t0;
  return {...r, elapsed};
}

// ─── 1. STRUCTURAL GUARDS (deterministic primary proof) ─────────────────────

await test('source has no blocking spawnSync call for the audit', () => {
  // The audit block used: spawnSync('node', [AUDIT_TOOL, '--json', '--cache'], ...)
  // After the fix this must be gone. We check for spawnSync( appearing in the
  // audit context (the import may remain if used elsewhere — we check usage).
  // Strategy: count how many times spawnSync( appears in the source;
  // if it appears only in an import but not as a call, fail.
  const callMatches = [...SRC.matchAll(/spawnSync\s*\(/g)];
  // Must have zero runtime calls to spawnSync for the audit path
  assert(callMatches.length === 0,
    `Found ${callMatches.length} spawnSync( call(s) in source — blocking call must be removed. ` +
    `Found at offsets: ${callMatches.map(m => m.index).join(', ')}`);
});

await test('source imports or uses spawn (non-sync) for detached child', () => {
  // Either a static import or dynamic `await import('node:child_process')` for spawn
  const hasSpawnImport = /\bspawn\b/.test(SRC);
  assert(hasSpawnImport, 'No spawn reference found in source — detached spawn is missing');
});

await test('source contains detached:true flag for the audit child', () => {
  assert(SRC.includes('detached:true') || SRC.includes("detached: true"),
    'Missing detached:true in source');
});

await test("source contains stdio:'ignore' for the audit child", () => {
  assert(SRC.includes("stdio:'ignore'") || SRC.includes('stdio: "ignore"') || SRC.includes("stdio: 'ignore'"),
    "Missing stdio:'ignore' in source");
});

await test('source contains .unref() call for the audit child', () => {
  assert(SRC.includes('.unref()'),
    'Missing .unref() in source — child will keep parent alive (HANG risk)');
});

// ─── 2. TIMING — subprocess with 800ms stub audit ────────────────────────────
// Plant an 800ms stub AUDIT_TOOL at ~/.claude/tools/prism-context-audit.mjs.
// Blocking path (old spawnSync) → hook takes ≥800ms.
// Fire-and-forget path (new) → hook returns in ~node-startup-floor ms.
// Generous threshold: < 600ms. Node startup floor on this machine: ~82-100ms.

await test('hook does NOT block on the audit (fire-and-forget; machine-relative timing)', () => {
  // Absolute-ms bounds are unreliable on slow/SMB dev boxes — node-startup floor
  // here can be ~700-800ms, so a fixed "< 600ms" is unwinnable even for a correct
  // fire-and-forget hook (the structural guards above are the PRIMARY proof). So
  // measure THIS machine's floor in-run (a not-due run spawns nothing), then assert
  // the due+800ms-stub run did NOT wait the stub: fire-and-forget adds << stub,
  // a blocking regression adds the FULL stub. Speed-independent; still catches it.
  const stubMs = 800;

  // (a) floor: not-due run — reads cache, spawns no audit child → pure node floor.
  const floorHome = makeHome('floor');
  let floor;
  try {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(floorHome, '.claude', '.prism-context-audit.last'), String(now));
    writeFileSync(join(floorHome, '.claude', '.prism-context-audit.json'),
      JSON.stringify({total_tokens_est: 0, total_cost_opus_usd: '0.00', top_suggestion: null}));
    floor = runHook(floorHome).elapsed;
  } finally {
    rmSync(floorHome, {recursive: true, force: true});
  }

  // (b) due + 800ms stub audit tool.
  const home = makeHome('timing');
  try {
    writeFileSync(join(home, '.claude', 'tools', 'prism-context-audit.mjs'), `
import {setTimeout as delay} from 'node:timers/promises';
await delay(${stubMs});
process.stdout.write(JSON.stringify({total_tokens_est:0,total_cost_opus_usd:'0.00',top_suggestion:null}));
process.exit(0);
`);
    // Do NOT write LAST_FILE → dueForFreshAudit=true (last=0, diff > 24h)
    const r = runHook(home);
    const budget = floor + stubMs / 2; // fire-forget adds << stub; blocking adds the full stub
    console.log(`    [timing] floor=${floor}ms due+stub=${r.elapsed}ms budget=${budget}ms (stub ${stubMs}ms)`);
    if (r.status !== 0) console.log(`    [timing] stderr: ${r.stderr}`);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    assert(r.elapsed < budget,
      `Hook took ${r.elapsed}ms vs budget ${budget}ms (floor ${floor}ms + half the ${stubMs}ms stub). ` +
      `A blocking spawnSync would be ~floor+${stubMs}ms; this suggests the audit is still blocking.`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── 3. BEHAVIORAL — audit tool absent → no crash ───────────────────────────

await test('hook exits 0 when AUDIT_TOOL is absent (no ~/.claude/tools/prism-context-audit.mjs)', () => {
  const home = makeHome('no-audit-tool');
  try {
    // AUDIT_TOOL doesn't exist at all → hook must not crash
    const r = runHook(home);
    assert(r.status === 0,
      `hook exited ${r.status} when audit tool absent. stderr=${r.stderr}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── 4. BEHAVIORAL — pre-existing CACHE_FILE is read for notice path ─────────

await test('hook exits 0 when CACHE_FILE pre-exists (not-due path reads cache without blocking)', () => {
  const home = makeHome('cache-read');
  try {
    // Write LAST_FILE with recent timestamp (within 24h) → dueForFreshAudit=false
    const LAST_FILE = join(home, '.claude', '.prism-context-audit.last');
    const CACHE_FILE = join(home, '.claude', '.prism-context-audit.json');
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(LAST_FILE, String(now));  // just ran
    writeFileSync(CACHE_FILE, JSON.stringify({
      total_tokens_est: 50000,
      total_cost_opus_usd: '0.15',
      top_suggestion: 'disable plugin X to save 20k tokens',
    }));
    const r = runHook(home);
    assert(r.status === 0, `hook exited ${r.status}. stderr=${r.stderr}`);
    // No audit tool planted — if it tried to spawn it, it would fail. The not-due
    // path must only read CACHE_FILE (readFileSync), not spawn anything.
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── 5. BEHAVIORAL — normal SessionStart produces valid JSON output ──────────

await test('hook exits 0 and produces valid stdout (or empty) on a normal cold start', () => {
  const home = makeHome('normal');
  try {
    const r = runHook(home);
    assert(r.status === 0, `hook exited ${r.status}. stderr=${r.stderr}`);
    if (r.stdout && r.stdout.trim()) {
      // If it emits JSON, it must be valid
      let parsed;
      try { parsed = JSON.parse(r.stdout); } catch (e) {
        throw new Error(`stdout is not valid JSON: ${r.stdout.slice(0, 200)}`);
      }
      // Check structural shape
      assert(parsed.hookSpecificOutput || parsed.hookEventName !== undefined || typeof parsed === 'object',
        'unexpected stdout shape');
    }
    // If stdout empty, also fine (PRISM_DISABLE_PARALLEL_REMINDER=1 suppressed most notices)
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
