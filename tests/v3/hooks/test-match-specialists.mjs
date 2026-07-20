#!/usr/bin/env node
// T3 — Fix 1b unit: matchSpecialists() plural matcher (panel fit-list source).
// Pure function (roster passed as arg — no file I/O, no HOME dependency), so this
// imports the guard and drives matchSpecialists directly.
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-specialist-routing-guard.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const mod = await import(pathToFileURL(HOOK).href);
assert(typeof mod.matchSpecialists === 'function', 'must export matchSpecialists');

const roster = {agents: {
  a: {core_domains: ['greek-ecommerce'], status: 'available'},
  b: {core_domains: ['html-email'], status: 'available'},
}};

await test('fire: matches the greek-ecommerce agent, not the unrelated one', async () => {
  const fits = mod.matchSpecialists('improve the greek-ecommerce checkout copy', roster);
  assert(fits.length >= 1, 'expected at least one fit');
  assert(fits[0].name === 'a', `top fit should be a, got ${JSON.stringify(fits)}`);
  assert(!fits.some(f => f.name === 'b'), 'unrelated agent b must NOT match');
});

await test('quiet: unrelated text returns []', async () => {
  const fits = mod.matchSpecialists('reboot the printer', roster);
  assert(Array.isArray(fits) && fits.length === 0, `expected [], got ${JSON.stringify(fits)}`);
});

await test('includes-analysis-agent: build_class:false is NOT dropped (unlike matchSpecialist)', async () => {
  const r2 = {agents: {
    recon: {core_domains: ['scraping-recon'], build_class: false, status: 'available'},
  }};
  const fits = mod.matchSpecialists('audit the scraping-recon pipeline', r2);
  assert(fits.some(f => f.name === 'recon'), 'a build_class:false analysis agent must still be returned for a panel');
  // Prove the divergence: the singular matchSpecialist DOES drop it.
  const single = mod.matchSpecialist('audit the scraping-recon pipeline', r2);
  assert(single === null, 'matchSpecialist (singular) must still drop build_class:false');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
