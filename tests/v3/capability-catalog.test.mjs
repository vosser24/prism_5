// Package G — capability-catalog tests (dep-free node).
// Exercises hooks/lib/prism-capability-catalog.mjs against a synthetic roster
// fixture. Asserts: (a) every capability NAME appears; (b) grouped headers;
// (c) single-line `- name — purpose` rows; (d) missing/empty roster → '' no-throw;
// (e) malformed roster → no-throw; (f) deterministic ordering across two calls;
// plus the PRISM_DISABLE_CAPABILITY_CATALOG env-flag gate.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', 'hooks', 'lib', 'prism-capability-catalog.mjs');
const { buildCapabilityCatalog, capabilityCatalogEnabled } = await import(new URL('file://' + LIB.replace(/\\/g, '/')).href);

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// ── Synthetic fixture: a few of each capability class ────────────────────────
const fixture = {
  agents: {
    'zeta-agent': { description: 'Adversarial architecture authority for event sourcing and CQRS decisions.', status: 'available' },
    'alpha-agent': { core_domains: ['greek-ecommerce', 'availability-ux'], status: 'available' },
    'archived-agent': { description: 'Should NOT appear.', status: 'archived' },
    'flagged-archived': { description: 'Also should NOT appear.', archived: true, status: 'available' },
    'active-status-agent': { description: 'Live agent whose status is active, not available.', status: 'active' },
    'upgrade-needed-agent': { description: 'Live agent mid-upgrade.', status: 'upgrade_needed' },
    'dead-status-agent': { description: 'Should NOT appear — unknown/dead status.', status: 'deprecated' },
    '_schema_example_agent': { description: 'schema doc — must be skipped' },
  },
  skills: {
    'prism-plan': { description: 'Multi-step planning with expert agent teams.', source: 'prism' },
    'redeploy-readiness': { description: 'Audit and fix laptop-side redeploy plumbing.', source: 'user' },
    'brainstorming': { description: 'Explore intent before implementation.', source: 'plugin:superpowers' },
    'firecrawl-scrape': { description: 'Extract clean markdown from any URL.', source: 'plugin:firecrawl' },
    '_schema_example_skill': { description: 'schema doc — must be skipped', source: 'prism' },
  },
  tools: {
    'superpowers': { domains: ['development', 'testing'], install_status: 'installed', tier: '1' },
    'browser-use': { domains: ['browser-automation'], install_status: 'available', tier: '2' },
  },
  mcps: {
    'playwright': { description: 'Drive a real browser for UI automation.', status: 'connected' },
    'supabase': { domains: ['database', 'auth'], status: 'configured' },
  },
};

const out = buildCapabilityCatalog(fixture);

// ── (a) every fixture capability NAME appears (except intentionally excluded) ─
const mustAppear = [
  'zeta-agent', 'alpha-agent',
  'prism-plan', 'redeploy-readiness',
  'brainstorming', 'firecrawl-scrape',
  'superpowers', 'browser-use',
  'playwright', 'supabase',
];
for (const n of mustAppear) ok(`(a) name present: ${n}`, out.includes(`- ${n} —`), n);

// F46 (task #63): an "active"/"upgrade_needed"-status agent (e.g. claude-master)
// must reach the catalog — this is the regression the old bare `=== 'available'`
// predicate silently broke. Pinned here so a future re-duplication trips a RED.
for (const n of ['active-status-agent', 'upgrade-needed-agent']) {
  ok(`(a) F46 live-status agent present: ${n}`, out.includes(`- ${n} —`), n);
}

const mustNotAppear = ['archived-agent', 'flagged-archived', 'dead-status-agent', '_schema_example_agent', '_schema_example_skill'];
for (const n of mustNotAppear) ok(`(a') excluded absent: ${n}`, !out.includes(`- ${n} `) && !out.includes(`- ${n}\n`), n);

// F46 census: the dead-status agent must be COUNTED and NAMED, not silently
// dropped (D046 loud-census requirement). 'archived-agent' also legitimately
// appears here — its exclusion is via a `status: 'archived'` STRING literal,
// distinct from the `archived: true` boolean flag ('flagged-archived' uses that).
{
  const censusLine = out.match(/_\(agents:.*\)_/)?.[0] || '';
  ok('(a\'\') census line present', !!censusLine, censusLine);
  ok('(a\'\') census names "deprecated" status literal', /excluded by status:.*\bdeprecated\b/.test(censusLine), censusLine);
}

// ── (b) grouped with expected headers ────────────────────────────────────────
for (const h of ['## Agents', '## Skills', '## Plugin skills', '## Tools', '## MCP tools']) {
  ok(`(b) header present: ${h}`, out.includes(h), h);
}
ok('(b) imperative header present', out.startsWith('CAPABILITY CATALOG'));
// Plugin skills go under Plugin skills, NOT under plain Skills.
{
  const skillsIdx = out.indexOf('## Skills');
  const pluginIdx = out.indexOf('## Plugin skills');
  const brainstormIdx = out.indexOf('- brainstorming —');
  ok('(b) brainstorming filed under Plugin skills', brainstormIdx > pluginIdx, `plugin@${pluginIdx} < item@${brainstormIdx}`);
  // prism-plan (non-plugin) sits in the Skills block (before Plugin skills header).
  const planIdx = out.indexOf('- prism-plan —');
  ok('(b) prism-plan filed under Skills', planIdx > skillsIdx && planIdx < pluginIdx, `skills@${skillsIdx} < plan@${planIdx} < plugin@${pluginIdx}`);
}

// ── (c) each item is a single line `- name — purpose` ────────────────────────
{
  const itemLines = out.split('\n').filter((l) => l.startsWith('- '));
  ok('(c) at least 10 item lines', itemLines.length >= 10, `count=${itemLines.length}`);
  const bad = itemLines.filter((l) => !/^- \S.* — \S/.test(l) || l.includes('\n'));
  ok('(c) every item matches `- name — purpose`', bad.length === 0, bad.length ? `offending: ${bad[0]}` : '');
  // one-line guarantee: no item line is empty-purpose
  const empty = itemLines.filter((l) => / — $/.test(l));
  ok('(c) no empty-purpose rows', empty.length === 0, empty.length ? empty[0] : '');
  // fallback-domain purpose works (alpha-agent has no description)
  ok('(c) core_domains fallback rendered', /- alpha-agent — greek-ecommerce, availability-ux/.test(out));
}

// ── (d) missing / empty roster → '' and no throw (fail-open) ──────────────────
for (const [label, input] of [['undefined', undefined], ['null', null], ['empty object', {}], ['no-known-sections', { foo: 1 }], ['empty sections', { agents: {}, skills: {}, tools: {}, mcps: {} }]]) {
  let res, threw = false;
  try { res = buildCapabilityCatalog(input); } catch { threw = true; }
  ok(`(d) fail-open ${label} → '' no-throw`, !threw && res === '', threw ? 'THREW' : JSON.stringify(res));
}

// ── (e) malformed roster (bad shapes) → no throw ─────────────────────────────
for (const [label, input] of [
  ['agents is array', { agents: ['x'] }],
  ['agents entry is string', { agents: { a: 'not-an-object' } }],
  ['agents entry null', { agents: { a: null } }],
  ['skills numeric', { skills: 42 }],
  ['tools with weird entry', { tools: { t: { domains: 'not-array', install_status: 5 } } }],
  ['deeply weird', { agents: { a: { description: 12345 } }, skills: { s: { source: 99 } } }],
]) {
  let threw = false;
  try { buildCapabilityCatalog(input); } catch { threw = true; }
  ok(`(e) malformed no-throw: ${label}`, !threw, threw ? 'THREW' : '');
}

// ── (f) deterministic ordering across two calls ──────────────────────────────
{
  const a = buildCapabilityCatalog(fixture);
  const b = buildCapabilityCatalog(fixture);
  ok('(f) identical output across calls', a === b);
  // Also verify alphabetical within a group: alpha-agent before zeta-agent.
  ok('(f) alphabetical within Agents', out.indexOf('- alpha-agent —') < out.indexOf('- zeta-agent —'));
  // Shuffled key insertion order still yields same result.
  const shuffled = { mcps: fixture.mcps, tools: fixture.tools, skills: fixture.skills, agents: fixture.agents };
  ok('(f) key-order independent', buildCapabilityCatalog(shuffled) === out);
}

// ── env-flag gate ────────────────────────────────────────────────────────────
ok('gate: default (unset) → enabled', capabilityCatalogEnabled({}) === true);
ok('gate: other value → enabled', capabilityCatalogEnabled({ PRISM_DISABLE_CAPABILITY_CATALOG: '0' }) === true);
ok('gate: "1" → disabled', capabilityCatalogEnabled({ PRISM_DISABLE_CAPABILITY_CATALOG: '1' }) === false);
ok('gate: null env → enabled', capabilityCatalogEnabled(null) === true);

// ── size cap (defensive) ─────────────────────────────────────────────────────
{
  const big = { agents: {} };
  for (let i = 0; i < 4000; i++) big.agents['agent-' + String(i).padStart(5, '0')] = { description: 'x'.repeat(200), status: 'available' };
  const capped = buildCapabilityCatalog(big);
  ok('size cap: output under 32KB+marker', Buffer.byteLength(capped, 'utf8') <= 32 * 1024 + 200);
  ok('size cap: truncation marker present', /…\(\+\d+ more — run \/prism-index\)$/.test(capped));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
