#!/usr/bin/env node
// Tests for v5.x FIX-D — routine implementation work must route to SONNET.
// Stress-test finding #7: the sonnet tier was never selected (0/623 events)
// because common routine phrasings ("add unit tests", "implement a debounce
// function") narrowly missed the SONNET_SIGNALS (an intervening word broke the
// regex), scoring 0 → haiku. The cheap middle tier was effectively dead.
//
// Run: node tests/v3/state/test-prism-sonnet-routing.mjs

import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'tools', 'lib', 'prism-tier-classify.mjs');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

const {classifyWithScore} = await import(pathToFileURL(LIB).href);
const tier = (p) => classifyWithScore(p, '').tier_by_score;

// routine implementation → sonnet
check('implement a <adj> function + add unit tests → sonnet', tier('implement a debounce function with leading and trailing edge control and add unit tests') === 'sonnet');
check('add unit tests → sonnet', tier('add unit tests for the parser module') === 'sonnet');
check('implement a new export feature → sonnet', tier('implement a new export feature') === 'sonnet');

// guards: must NOT pull the extremes
check('trivial lookup stays haiku', tier('list all files in the repo') === 'haiku');
check('novel architecture stays opus', tier('architect a new system and plan all phases with tradeoffs') === 'opus');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
