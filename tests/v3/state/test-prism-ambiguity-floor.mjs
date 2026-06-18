#!/usr/bin/env node
// WS-2 (v5.10.0) — tier-router ambiguity floor (D017 deferred option).
//
// keyword-floor scores terse, context-referencing prompts ("execute it",
// "fix all", "@docs/x.md run it") at 0 → haiku, forcing ~10 conversation-model
// overrides per session. D017 locked "keep keyword-floor, reject LLM classifier"
// but named this deterministic split as the deferred option.
//
// Rule: a score-0 prompt that would route haiku and is IMPERATIVE (leading
// ACTION verb) and/or REFERENCES A FILE (@path or a path/filename token) routes
// to SONNET instead. Clear trivia (interrogative / read-verb / approval) stays
// Haiku; clear-complexity stays Opus. Zero added LLM cost, deterministic.
//
// Run: node tests/v3/state/test-prism-ambiguity-floor.mjs

import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-opus-classifier.mjs');
const {classifyPrompt} = await import(pathToFileURL(LIB).href);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

// skipCache so fixtures never collide with a warm 24h cache entry.
const tier = async (p) => (await classifyPrompt({prompt: p, skipCache: true})).tier;

// --- score-0 imperative / file-ref → sonnet (the fix) ----------------------
check('"execute it" → sonnet', await tier('execute it') === 'sonnet');
check('"fix all and retest" → sonnet', await tier('fix all and retest') === 'sonnet');
check('"run it" → sonnet', await tier('run it') === 'sonnet');
check('"@docs/x.md run it" → sonnet', await tier('@docs/x.md run it') === 'sonnet');
check('"apply the change in hooks/foo.mjs" → sonnet', await tier('apply the change in hooks/foo.mjs') === 'sonnet');

// --- clear trivia stays haiku (guards against over-firing) ------------------
check('"what does SIGTERM mean" → haiku (interrogative)', await tier('what does SIGTERM mean') === 'haiku');
check('"show me the config" → haiku (read verb)', await tier('show me the config') === 'haiku');
check('"ok" → haiku (approval, no action verb)', await tier('ok') === 'haiku');
// "list all files in the repo" scores 1 (HAIKU_SIGNAL "list all"), so it is NOT
// in the score-0 bucket — the floor must not touch it.
check('"list all files in the repo" → haiku (scored, not score-0)', await tier('list all files in the repo') === 'haiku');

// --- clear complexity still routes opus ------------------------------------
check('novel architecture stays opus', await tier('architect a new system and plan all phases with tradeoffs') === 'opus');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
