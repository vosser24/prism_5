#!/usr/bin/env node
// tests/v3/hooks/test-updatedinput-key-collision-guard.mjs
//
// STRUCTURAL guard (same species as
// tests/v3/hooks/test-session-start-async-audit.mjs — grep/parse the source,
// no runtime needed) that FAILS LOUDLY when two or more hooks registered on
// the SAME hooks/prism-pretooluse-dispatcher.mjs ROUTE independently rewrite
// the SAME hookSpecificOutput.updatedInput key.
//
// WHY THIS EXISTS: consolidate() in prism-pretooluse-dispatcher.mjs merges
// per-guard updatedInput objects by DISJOINT KEY, first-writer-wins on a
// same-key conflict (see its own doc comment). If two independent hooks each
// compute their own single-field rewrite for the same key, only the FIRST one
// (in ROUTES array order) survives the merge — the second is SILENTLY
// dropped. No error, no denial; only a `updatedinput_conflict` line appended
// to .prism-routing.jsonl that nobody is prompted to go read. This is exactly
// the shape of bug prism-dispatch-preamble.mjs and prism-anti-nesting-inject.mjs
// hit and fixed by COMPOSING (one hook imports + calls the other's exported
// run() and layers its own change on top) — see
// docs/prism/lessons/2026-07-14-dispatch-preamble-session.md. A doc does not
// stop the NEXT hook author from re-introducing this; only a mechanical check
// does.
//
// WHAT THIS DOES NOT DO: it does not touch hooks/prism-pretooluse-dispatcher.mjs
// (ROUTES is not exported, and this test is deliberately read-only against
// source — see the parseRoutes() comment). It is pure static analysis: parse
// the ROUTES table and each referenced hook's source text; no hooks are
// imported or executed.
//
// Run: node tests/v3/hooks/test-updatedinput-key-collision-guard.mjs

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const DISPATCHER_PATH = join(HOOKS, 'prism-pretooluse-dispatcher.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n${indent(e.message || String(e))}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function indent(s) { return String(s).split('\n').map(l => '        ' + l).join('\n'); }

// ─── Core static-analysis primitives (also unit-tested below on fixtures) ──

// Extract the substring from `src[start]` (which MUST be '{') through its
// matching closing '}', by brace-depth counting. Returns null if unbalanced.
function extractBalanced(src, start) {
  assert(src[start] === '{', `extractBalanced: src[${start}] is not '{'`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// Parse `const ROUTES = { Name: ['a.mjs', PARENT, ...], ... };` out of the
// dispatcher's source TEXT (not import — ROUTES is not exported, and this
// test must not add an export to a file another agent is concurrently
// editing). Returns { routeName: ['hook-a.mjs', 'hook-b.mjs', ...] }.
export function parseRoutes(dispatcherSrc) {
  const marker = 'const ROUTES = {';
  const start = dispatcherSrc.indexOf(marker);
  assert(start !== -1, 'parseRoutes: could not find "const ROUTES = {" in dispatcher source');
  const braceIdx = start + marker.length - 1; // index of the '{'
  const block = extractBalanced(dispatcherSrc, braceIdx);
  assert(block, 'parseRoutes: could not balance the ROUTES object literal');

  const parentMatch = dispatcherSrc.match(/const PARENT\s*=\s*'([^']+)'/);
  const PARENT = parentMatch ? parentMatch[1] : null;

  const routes = {};
  const routeRe = /(\w+):\s*\[([^\]]*)\]/g;
  let m;
  while ((m = routeRe.exec(block))) {
    const [, routeName, itemsRaw] = m;
    const items = [];
    const itemRe = /'([^']+)'|(\bPARENT\b)/g;
    let im;
    while ((im = itemRe.exec(itemsRaw))) {
      if (im[1]) items.push(im[1]);
      else if (im[2] && PARENT) items.push(PARENT);
    }
    routes[routeName] = items;
  }
  return routes;
}

// Which updatedInput KEYS does this hook's source ever write? Finds every
// `updatedInput: { ... }` object literal (balanced-brace, handles nested
// structures) and collects `identifier:` keys inside it. Spread entries
// (`...ti`) have no colon and are correctly excluded.
export function extractUpdatedInputKeys(src) {
  const keys = new Set();
  const markerRe = /updatedInput\s*:\s*\{/g;
  let m;
  while ((m = markerRe.exec(src))) {
    const braceIdx = src.indexOf('{', m.index);
    const block = extractBalanced(src, braceIdx);
    if (!block) continue;
    const inner = block.slice(1, -1);
    const keyRe = /([A-Za-z_$][\w$]*)\s*:/g;
    let km;
    while ((km = keyRe.exec(inner))) keys.add(km[1]);
  }
  return keys;
}

// Which sibling hook file(s) does this hook COMPOSE with — i.e. statically
// import `run` (bare or aliased) from a relative './x.mjs' AND actually CALL
// it (not just import it unused)? Returns a Set of the sibling filenames.
export function extractComposesWith(src) {
  const edges = new Set();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/([^'"]+\.mjs)['"]/g;
  let m;
  while ((m = importRe.exec(src))) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const targetFile = m[2];
    for (const n of names) {
      const asMatch = n.match(/^run\s+as\s+([A-Za-z_$][\w$]*)$/);
      const localName = asMatch ? asMatch[1] : (n === 'run' ? 'run' : null);
      if (!localName) continue;
      const callRe = new RegExp(`\\b${localName}\\s*\\(`);
      if (callRe.test(src)) edges.add(targetFile);
    }
  }
  return edges;
}

// Given `routes` (from parseRoutes) and a `readHookSrc(filename) -> string|null`
// loader, return {violations, orderViolations, missingFiles} — the actual
// detection logic, factored out so it can be driven against BOTH the real
// hooks/ directory and synthetic fixtures (below).
export function detectCollisions(routes, readHookSrc) {
  const infoCache = new Map();
  function info(file) {
    if (infoCache.has(file)) return infoCache.get(file);
    const src = readHookSrc(file);
    const v = src == null
      ? {missing: true, keys: new Set(), composesWith: new Set()}
      : {missing: false, keys: extractUpdatedInputKeys(src), composesWith: extractComposesWith(src)};
    infoCache.set(file, v);
    return v;
  }

  const violations = [];       // un-composed same-key writers
  const orderViolations = [];  // composed pair registered in the wrong order
  const missingFiles = [];     // ROUTES references a file that doesn't exist

  for (const [routeName, hookList] of Object.entries(routes)) {
    const writers = new Map(); // key -> [{file, idx}]
    hookList.forEach((file, idx) => {
      const i = info(file);
      if (i.missing) { missingFiles.push({route: routeName, file}); return; }
      for (const key of i.keys) {
        if (!writers.has(key)) writers.set(key, []);
        writers.get(key).push({file, idx});
      }
    });
    for (const [key, list] of writers) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const aInfo = info(a.file), bInfo = info(b.file);
          const aComposesB = aInfo.composesWith.has(b.file);
          const bComposesA = bInfo.composesWith.has(a.file);
          if (!aComposesB && !bComposesA) {
            violations.push({route: routeName, key, a: a.file, b: b.file});
            continue;
          }
          if (aComposesB && a.idx > b.idx) {
            orderViolations.push({route: routeName, key, composer: a.file, composee: b.file, composerIdx: a.idx, composeeIdx: b.idx});
          }
          if (bComposesA && b.idx > a.idx) {
            orderViolations.push({route: routeName, key, composer: b.file, composee: a.file, composerIdx: b.idx, composeeIdx: a.idx});
          }
        }
      }
    }
  }
  return {violations, orderViolations, missingFiles};
}

function formatCollisionMessage(v) {
  return (
    `Route "${v.route}": "${v.a}" and "${v.b}" BOTH write hookSpecificOutput.updatedInput.${v.key} ` +
    `without composing.\n` +
    `  Dispatcher merge (consolidate() in prism-pretooluse-dispatcher.mjs) is first-writer-wins PER KEY: ` +
    `one of these two rewrites will be SILENTLY DROPPED on every real "${v.route}" dispatch.\n` +
    `  FIX: pick one hook as the composer. It should:\n` +
    `    1. import {run as siblingRun} from './<the-other-hook>.mjs' and CALL siblingRun(input) to get\n` +
    `       the sibling's rewrite, then layer its own change on top of that result instead of computing\n` +
    `       an independent rewrite for the same key (see hooks/prism-dispatch-preamble.mjs for a worked\n` +
    `       example composing with hooks/prism-anti-nesting-inject.mjs).\n` +
    `    2. be registered BEFORE the sibling hook in ROUTES.${v.route} in\n` +
    `       hooks/prism-pretooluse-dispatcher.mjs, so consolidate()'s first-writer-wins keeps the\n` +
    `       composed (superset) rewrite, not the sibling's now-redundant single-field one.`
  );
}

function formatOrderMessage(v) {
  return (
    `Route "${v.route}": "${v.composer}" composes with "${v.composee}" (imports + calls its run()) for ` +
    `updatedInput.${v.key}, but is registered AFTER it in ROUTES.${v.route} (index ${v.composerIdx} vs ` +
    `${v.composeeIdx}).\n` +
    `  consolidate() keeps the FIRST writer per key — the composer's superset rewrite must win the merge, ` +
    `so it must be registered BEFORE the sibling it composes with. Swap their order in ROUTES.${v.route} ` +
    `in hooks/prism-pretooluse-dispatcher.mjs.`
  );
}

// ─── 1. FIXTURE tests: prove the detector actually fires (not vacuous) ──────

test('fixture: parseRoutes reads a minimal ROUTES block, incl. the PARENT const and comments between entries', () => {
  const src = `
const PARENT = 'parent-guard.mjs';
const ROUTES = {
  Bash: ['a.mjs', PARENT],
  // a comment sitting between two route entries must not break parsing
  Agent: ['b.mjs', 'c.mjs', PARENT],
};
`;
  const routes = parseRoutes(src);
  assert(JSON.stringify(routes.Bash) === JSON.stringify(['a.mjs', 'parent-guard.mjs']), `Bash=${JSON.stringify(routes.Bash)}`);
  assert(JSON.stringify(routes.Agent) === JSON.stringify(['b.mjs', 'c.mjs', 'parent-guard.mjs']), `Agent=${JSON.stringify(routes.Agent)}`);
});

test('fixture: extractUpdatedInputKeys finds keys, ignores spread entries', () => {
  const src = `
    const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: augmented, model: 'sonnet'}}};
  `;
  const keys = extractUpdatedInputKeys(src);
  assert(keys.has('prompt') && keys.has('model') && !keys.has('ti') && keys.size === 2,
    `keys=${JSON.stringify([...keys])}`);
});

test('fixture: extractComposesWith detects an aliased import + real call, ignores an unused import', () => {
  const used = `import {run as siblingRun} from './sibling-a.mjs';\nconst x = siblingRun(input);\n`;
  const unused = `import {run} from './sibling-b.mjs';\n// never called\n`;
  assert(extractComposesWith(used).has('sibling-a.mjs'), 'used import not detected as composed');
  assert(!extractComposesWith(unused).has('sibling-b.mjs'), 'unused import incorrectly counted as composed');
});

test('fixture: detectCollisions FLAGS two un-composed hooks writing the same key on the same route', () => {
  const fixtureRoutes = {FakeRoute: ['hook-a.mjs', 'hook-b.mjs']};
  const src = {
    'hook-a.mjs': `const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: 'A: ' + prompt}}};`,
    'hook-b.mjs': `const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: 'B: ' + prompt}}};`,
  };
  const {violations} = detectCollisions(fixtureRoutes, (f) => src[f] ?? null);
  assert(violations.length === 1, `expected exactly 1 violation, got ${violations.length}: ${JSON.stringify(violations)}`);
  assert(violations[0].key === 'prompt' && violations[0].route === 'FakeRoute',
    `violation=${JSON.stringify(violations[0])}`);
  // Message must actually teach the fix, not just say "conflict".
  const msg = formatCollisionMessage(violations[0]);
  assert(msg.includes('SILENTLY DROPPED'), 'message must explain the failure mode');
  assert(msg.includes("import {run as siblingRun}"), 'message must show the concrete fix pattern');
  assert(msg.includes('registered BEFORE'), 'message must explain the ordering requirement');
});

test('fixture: detectCollisions does NOT flag a genuinely composed pair (correct order)', () => {
  const fixtureRoutes = {FakeRoute: ['composer.mjs', 'composee.mjs']};
  const src = {
    'composer.mjs': `
      import {run as siblingRun} from './composee.mjs';
      const sibling = siblingRun(input);
      const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: sibling.prompt + ' + mine'}}};
    `,
    'composee.mjs': `const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: 'base'}}};`,
  };
  const {violations, orderViolations} = detectCollisions(fixtureRoutes, (f) => src[f] ?? null);
  assert(violations.length === 0, `expected 0 violations, got ${JSON.stringify(violations)}`);
  assert(orderViolations.length === 0, `expected 0 order violations, got ${JSON.stringify(orderViolations)}`);
});

test('fixture: detectCollisions FLAGS a composed pair registered in the WRONG order', () => {
  // composer.mjs composes with composee.mjs but is listed AFTER it — the
  // composer's superset write would lose the first-writer-wins race.
  const fixtureRoutes = {FakeRoute: ['composee.mjs', 'composer.mjs']};
  const src = {
    'composer.mjs': `
      import {run as siblingRun} from './composee.mjs';
      const sibling = siblingRun(input);
      const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: sibling.prompt + ' + mine'}}};
    `,
    'composee.mjs': `const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: 'base'}}};`,
  };
  const {violations, orderViolations} = detectCollisions(fixtureRoutes, (f) => src[f] ?? null);
  assert(violations.length === 0, `expected 0 plain violations (they ARE composed), got ${JSON.stringify(violations)}`);
  assert(orderViolations.length === 1, `expected 1 order violation, got ${JSON.stringify(orderViolations)}`);
  const msg = formatOrderMessage(orderViolations[0]);
  assert(msg.includes('registered BEFORE'), 'order message must say what to do');
});

test('fixture: detectCollisions ignores a third, unrelated key on the same route', () => {
  const fixtureRoutes = {FakeRoute: ['hook-a.mjs', 'hook-c.mjs']};
  const src = {
    'hook-a.mjs': `const out = {hookSpecificOutput: {updatedInput: {...ti, prompt: 'x'}}};`,
    'hook-c.mjs': `const out = {hookSpecificOutput: {updatedInput: {...ti, model: 'sonnet'}}};`,
  };
  const {violations} = detectCollisions(fixtureRoutes, (f) => src[f] ?? null);
  assert(violations.length === 0, `disjoint keys must not be flagged, got ${JSON.stringify(violations)}`);
});

// ─── 2. REAL scan: the actual hooks/ + prism-pretooluse-dispatcher.mjs today ─

test('real dispatcher: every hook referenced in ROUTES exists on disk', () => {
  const dispatcherSrc = readFileSync(DISPATCHER_PATH, 'utf-8');
  const routes = parseRoutes(dispatcherSrc);
  const readHookSrc = (f) => {
    const p = join(HOOKS, f);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };
  const {missingFiles} = detectCollisions(routes, readHookSrc);
  assert(missingFiles.length === 0,
    `ROUTES references file(s) that do not exist on disk: ${JSON.stringify(missingFiles)}`);
});

test('real dispatcher: no un-composed same-key updatedInput collision on ANY route today', () => {
  const dispatcherSrc = readFileSync(DISPATCHER_PATH, 'utf-8');
  const routes = parseRoutes(dispatcherSrc);
  const routeCount = Object.keys(routes).length;
  assert(routeCount >= 8, `sanity: expected >=8 parsed routes, got ${routeCount} — parseRoutes may be broken`);
  const readHookSrc = (f) => {
    const p = join(HOOKS, f);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };
  const {violations} = detectCollisions(routes, readHookSrc);
  if (violations.length) {
    throw new Error('\n' + violations.map(formatCollisionMessage).join('\n\n'));
  }
});

test('real dispatcher: every composed pair is registered in the correct (composer-first) order', () => {
  const dispatcherSrc = readFileSync(DISPATCHER_PATH, 'utf-8');
  const routes = parseRoutes(dispatcherSrc);
  const readHookSrc = (f) => {
    const p = join(HOOKS, f);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };
  const {orderViolations} = detectCollisions(routes, readHookSrc);
  if (orderViolations.length) {
    throw new Error('\n' + orderViolations.map(formatOrderMessage).join('\n\n'));
  }
});

// Sanity: prove this test suite is actually looking at the composed pair we
// know about (Agent route), so a future refactor that accidentally makes
// parseRoutes silently return {} still gets caught (the two tests above would
// pass vacuously on an empty route set — this one would not).
test('sanity: the known composed pair (dispatch-preamble -> anti-nesting-inject) is detected as composed, correctly ordered', () => {
  const dispatcherSrc = readFileSync(DISPATCHER_PATH, 'utf-8');
  const routes = parseRoutes(dispatcherSrc);
  assert(Array.isArray(routes.Agent) && routes.Agent.length > 0, 'ROUTES.Agent did not parse');
  const preambleIdx = routes.Agent.indexOf('prism-dispatch-preamble.mjs');
  const antiNestingIdx = routes.Agent.indexOf('prism-anti-nesting-inject.mjs');
  assert(preambleIdx !== -1 && antiNestingIdx !== -1, 'expected both hooks present in ROUTES.Agent');
  assert(preambleIdx < antiNestingIdx, `dispatch-preamble (idx ${preambleIdx}) must precede anti-nesting-inject (idx ${antiNestingIdx})`);

  const preambleSrc = readFileSync(join(HOOKS, 'prism-dispatch-preamble.mjs'), 'utf-8');
  const composes = extractComposesWith(preambleSrc);
  assert(composes.has('prism-anti-nesting-inject.mjs'), 'dispatch-preamble.mjs no longer detected as composing with anti-nesting-inject.mjs — did the import/call pattern change?');
});

// ─── 3. LIVE-FIRE proof against the REAL source (not a toy fixture) ─────────
// Take the ACTUAL dispatcher text, textually swap the two known hooks' order
// (simulating exactly the regression the code comment at that ROUTES line
// warns against), and confirm the detector fires an order violation with a
// teaching message. Proves the "real dispatcher" tests above are not passing
// vacuously because the detector is broken — the same real source, mutated
// one plausible way, DOES get caught. No file on disk is touched.

test('live-fire: reordering the known composed pair in the REAL source text is caught', () => {
  const dispatcherSrc = readFileSync(DISPATCHER_PATH, 'utf-8');
  const regressed = dispatcherSrc.replace(
    // Task #19 (v6.4.0, 0721cd38c) inserted prism-live-work-dedup.mjs and
    // prism-file-lease-guard.mjs between the dedup guard and the preamble; this
    // literal must track hooks/prism-pretooluse-dispatcher.mjs's ROUTES.Agent
    // exactly, or the swap below silently no-ops.
    `'prism-live-work-dedup.mjs', 'prism-file-lease-guard.mjs', 'prism-dispatch-preamble.mjs', 'prism-anti-nesting-inject.mjs', PARENT`,
    `'prism-live-work-dedup.mjs', 'prism-file-lease-guard.mjs', 'prism-anti-nesting-inject.mjs', 'prism-dispatch-preamble.mjs', PARENT`
  );
  assert(regressed !== dispatcherSrc, 'string swap did not match — ROUTES.Agent literal text changed shape; update this fixture');

  const routes = parseRoutes(regressed);
  const readHookSrc = (f) => {
    const p = join(HOOKS, f);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  };
  const {orderViolations} = detectCollisions(routes, readHookSrc);
  assert(orderViolations.length === 1, `expected the reorder to be caught as exactly 1 order violation, got ${JSON.stringify(orderViolations)}`);
  assert(orderViolations[0].composer === 'prism-dispatch-preamble.mjs' && orderViolations[0].composee === 'prism-anti-nesting-inject.mjs',
    `violation=${JSON.stringify(orderViolations[0])}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
