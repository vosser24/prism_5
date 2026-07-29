#!/usr/bin/env node
// Task #93 — the mirror PII scan is a GATE, and a gate has to be able to fail.
//
// Before #93 the tool was a pure detector: any match at all exited 1. Once #92
// removed the last true positive a clean tree STILL exited 1, with 30 findings
// that were all classified false positives. "Zero true positives is the gate"
// was therefore not machine-checkable — a human re-derived the same 30-way
// classification from memory each release. The tool now answers a decidable
// question (are there UNACCOUNTED findings?) via the ACCOUNTED[] list.
//
// The whole risk of that change is that a suppression mechanism can turn a
// real gate into a rubber stamp. So these assertions are deliberately weighted
// toward PROVING THE GATE STILL FAILS, not toward proving it passes:
//   * a planted owner value fails, and only because it is TRACKED;
//   * a stale suppression fails LOUDLY instead of covering nothing quietly;
//   * a malformed / stub-reason suppression fails;
//   * a suppression cannot be widened to a DIFFERENT value in the same file;
//   * the #93 pattern narrowings did not cost real detections.
//
// Everything runs against a THROWAWAY git repo under the OS temp dir, driving
// the real tool as a subprocess. No dependency on this repo's contents, on
// $HOME, or on any machine-global fixture home — so it is safe to run
// concurrently with other suite members.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL = join(__dirname, '..', '..', '..', 'tools', 'prism-mirror-pii-scan.mjs');
const TOOL_SRC = readFileSync(TOOL, 'utf8');

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}${detail ? `\n      ${detail}` : ''}`);
}

// Owner values are decoded from the same base64 constants the tool carries, so
// this test file adds no owner plaintext to the tracked tree — the very
// property the tool exists to enforce (task #92).
function b64(s) { return Buffer.from(s, 'base64').toString('utf8'); }
const OWNER_EMAIL = b64('c2Vydm9zeUBwcmFrdGlrZXIuZ3I=');
const OWNER_USERNAME = b64('U2Vydm9zWQ==');
const [OWNER_LOCAL, OWNER_DOMAIN] = OWNER_EMAIL.split('@');

// ── throwaway repo helpers ──────────────────────────────────────────────────

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// Builds a temp repo containing a copy of the real tool whose ACCOUNTED[] is
// replaced by `accountedLiteral`. Patching the list (rather than reimplementing
// the tool) is what lets the stale/malformed paths be exercised at all — they
// are properties of the list, and the shipped list is necessarily non-stale on
// the real tree.
function makeRepo(files, accountedLiteral) {
  const root = mkdtempSync(join(tmpdir(), 'prism-pii-gate-'));
  git(root, ['init', '-q']);
  let src = TOOL_SRC;
  if (accountedLiteral !== undefined) {
    const re = /const ACCOUNTED = \[[\s\S]*?\n\];\n/;
    if (!re.test(src)) throw new Error('could not locate the ACCOUNTED[] literal in the tool source');
    src = src.replace(re, `const ACCOUNTED = ${accountedLiteral};\n`);
  }
  const toolRel = 'tool.mjs';
  writeFileSync(join(root, toolRel), src, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return { root, toolRel };
}

// `track: false` deliberately leaves the fixtures untracked — the trap the #93
// brief calls out, and assertion 2 below pins it.
function runGate(files, { accounted = '[]', track = true } = {}) {
  const { root, toolRel } = makeRepo(files, accounted);
  git(root, ['add', '-N', toolRel, ...(track ? Object.keys(files) : [])]);
  const r = spawnSync(process.execPath, [join(root, toolRel)], { cwd: root, encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A benign file that trips nothing, so a fixture's own boilerplate can never be
// what a "detected" assertion is actually detecting.
const INERT = { 'notes.md': 'Just some ordinary prose with no identifiers in it.\n' };

// ── 1. the gate can be GREEN, and says what it checked ──────────────────────

{
  const { status, out } = runGate(INERT);
  check('1a clean tree exits 0', status === 0, `got exit ${status}`);
  check('1b clean run states the file denominator', /files scanned \.+ \d+/.test(out), out);
  check('1c clean run states the UNACCOUNTED count explicitly (D084: never silently green)',
    /UNACCOUNTED \.+ 0/.test(out), out);
  check('1d clean run states the fragment-sweep denominator',
    /owner fragments swept \.+ \d+ -> 0 hit\(s\)/.test(out), out);
}

// ── 2. THE GATE STILL FAILS on a planted true positive ──────────────────────
// The acceptance property for #93. Also pins the trap that cost a prior cycle:
// the tool enumerates via `git ls-files`, so an UNTRACKED plant is never
// scanned and proves nothing. Same bytes, both ways, so the only variable is
// trackedness.

const PLANT = {
  'leak.txt': [
    `contact: ${OWNER_EMAIL}`,
    `profile: C:\\Users\\${OWNER_USERNAME}\\.claude\\settings.json`,
    '',
  ].join('\n'),
};

{
  const tracked = runGate(PLANT, { track: true });
  check('2a planted owner value in a TRACKED file fails the gate', tracked.status === 1, `got exit ${tracked.status}`);
  check('2b the specific finding is reported, not just a nonzero exit',
    /leak\.txt:1: \[personal_identifier\] Owner email/.test(tracked.out), tracked.out);
  check('2c the planted Windows profile path is reported too',
    /leak\.txt:2: \[machine_local\] Windows user-profile path/.test(tracked.out), tracked.out);
  check('2d the failure is counted as UNACCOUNTED, not silently absorbed',
    /UNACCOUNTED \.+ [1-9]/.test(tracked.out), tracked.out);

  const untracked = runGate(PLANT, { track: false });
  check('2e THE TRAP: the identical plant left UNTRACKED is never scanned and passes',
    untracked.status === 0, `got exit ${untracked.status}`);
}

// ── 3. the escaped form the anchored patterns cannot see (D107) ─────────────
// The task-#92 follow-up wrote the owner's address into the scanner itself in
// regex-escaped form. The literal patterns miss it — a backslash sits between
// characters they expect adjacent — while GitHub code search finds it fine.
// The independent substring sweep is the compensating control, and it is not
// suppressible.

{
  const escaped = { 'notes.mjs': `const RE = /${OWNER_LOCAL}\\.${OWNER_DOMAIN.replace('.', '\\.')}/;\n` };
  const { status, out } = runGate(escaped);
  check('3a regex-escaped owner address fails the gate', status === 1, `got exit ${status}`);
  check('3b it is caught by the fragment sweep specifically',
    /OWNER-FRAGMENT HITS/.test(out) && /notes\.mjs:1/.test(out), out);
  check('3c the anchored owner-email pattern did NOT catch it (this is why the sweep exists)',
    !/\[personal_identifier\] Owner email/.test(out), out);
  check('3d the sweep does not echo the fragment values back into its own output',
    !out.includes(OWNER_LOCAL) && !out.includes(OWNER_DOMAIN), out);

  // Not suppressible: an ACCOUNTED entry cannot silence a fragment hit. Asserted
  // on the REPORTED REASON, not on the exit code — an entry aimed at a fragment
  // hit necessarily matches no finding, so it goes stale and would fail the run
  // by itself. An exit-code-only assertion here would pass even with the sweep
  // deleted (confirmed by mutation testing), which is the D084 trap.
  const withEntry = runGate(escaped, {
    accounted: JSON.stringify([{
      file: 'notes.mjs', label: 'Generic email address', sha256: '0123456789abcdef',
      reason: 'attempting to suppress a fragment hit, which must not be possible',
    }]),
  });
  check('3e a fragment hit cannot be suppressed by an ACCOUNTED entry',
    withEntry.status === 1 && /OWNER-FRAGMENT HITS/.test(withEntry.out) && /notes\.mjs:1/.test(withEntry.out),
    withEntry.out);
}

// ── 4. a STALE suppression fails LOUDLY ────────────────────────────────────
// The failure mode that makes suppression lists dangerous: an entry that has
// quietly stopped covering anything looks identical to a working one.

{
  const { status, out } = runGate(INERT, {
    accounted: JSON.stringify([{
      file: 'gone.mjs', label: 'Y: drive path', sha256: 'aaaaaaaaaaaaaaaa',
      reason: 'entry for a finding that no longer exists anywhere in the tree',
    }]),
  });
  check('4a a suppression matching nothing FAILS rather than passing quietly', status === 1,
    `got exit ${status}`);
  check('4b it is named as STALE, with the entry identified', /STALE suppression entries \(1\)/.test(out)
    && /gone\.mjs/.test(out), out);
  check('4c the per-entry occurrence count is reported on every run (silent widening is visible)',
    /0x\s+gone\.mjs/.test(out), out);
}

// ── 5. a MALFORMED suppression fails ───────────────────────────────────────
// Inherited from task #89's PRISM-CITATION-EXEMPT convention: a marker with no
// real reason is malformed, not merely untidy. Here that discipline is what
// stops the tool's own paste-ready stub from becoming a one-keystroke silencer.

{
  const stub = runGate(PLANT, {
    accounted: JSON.stringify([{
      file: 'leak.txt', label: 'Owner email (reconstructed at load time)', sha256: '0123456789abcdef',
      reason: 'TODO: why this specific value is not PII/a secret',
    }]),
  });
  // Each of these asserts the MALFORMED diagnosis specifically, not just a
  // nonzero exit. A deliberately-broken entry also matches nothing and would
  // therefore fail as STALE regardless — so an exit-code-only assertion here
  // still passes with validation entirely deleted (confirmed by mutation
  // testing). The count line and the message are what actually bind.
  check('5a a pasted stub whose reason is still TODO is rejected as malformed',
    stub.status === 1 && /malformed entries \.+ 1/.test(stub.out), stub.out);
  check('5b the TODO stub is named as the problem', /still a TODO stub/.test(stub.out), stub.out);

  const badHash = runGate(INERT, {
    accounted: JSON.stringify([{
      file: 'notes.md', label: 'Y: drive path', sha256: 'NOT-A-HASH',
      reason: 'a well-written reason attached to a malformed fingerprint field',
    }]),
  });
  check('5c a malformed sha256 field fails, and is diagnosed as malformed',
    badHash.status === 1 && /must be 16 lowercase hex/.test(badHash.out), badHash.out);

  const badLabel = runGate(INERT, {
    accounted: JSON.stringify([{
      file: 'notes.md', label: 'Pattern That Does Not Exist', sha256: '0123456789abcdef',
      reason: 'a label that matches no shipped pattern must be caught at startup',
    }]),
  });
  check('5d a label matching no pattern fails, so renaming a pattern cannot orphan entries silently',
    badLabel.status === 1 && /malformed entries \.+ 1/.test(badLabel.out), badLabel.out);
  check('5e the orphaned label is named', /matches no pattern in PATTERNS/.test(badLabel.out), badLabel.out);
}

// ── 6. a suppression cannot widen to a DIFFERENT value ─────────────────────
// Identity is file + pattern + digest of the matched text. Accounting for one
// placeholder in a file must not blanket-exempt that file or that pattern —
// otherwise a real value dropped next to an accepted one would ship green.

{
  const files = {
    'paths.mjs': [
      '// placeholder in a comment, deliberately accepted:',
      '// C:\\Users\\devuser\\.claude\\settings.json',
      `// and a REAL one added later: C:\\Users\\${OWNER_USERNAME}\\.claude`,
      '',
    ].join('\n'),
  };
  // Digest of the accepted placeholder only, taken from the tool's own stub
  // output so the test cannot drift from the tool's fingerprinting.
  const probe = runGate({ 'paths.mjs': '// C:\\Users\\devuser\\.claude\\settings.json\n' });
  const m = /sha256: '([0-9a-f]{16})'/.exec(probe.out);
  check('6a the tool emits a paste-ready fingerprint for an unaccounted finding', !!m, probe.out);

  if (m) {
    const { status, out } = runGate(files, {
      accounted: JSON.stringify([{
        file: 'paths.mjs', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: m[1],
        reason: 'the generic placeholder username in this comment is not a real account',
      }]),
    });
    check('6b the accepted placeholder is absorbed', /accounted for \.+ 1/.test(out), out);
    // Asserted on the specific surviving finding. The real owner username also
    // trips a SECOND pattern, so a widened entry would still exit 1 via that
    // other pattern — exit-code-only would pass here even with the digest
    // dropped from the entry identity (confirmed by mutation testing).
    check('6c a DIFFERENT value in the SAME file under the SAME pattern still fails',
      status === 1 && /paths\.mjs:3: \[machine_local\] Windows user-profile path/.test(out), out);
    check('6d and the real owner username is separately reported',
      /\[machine_local\] Literal owner username/.test(out), out);
  } else {
    check('6b the accepted placeholder is absorbed', false, 'skipped: no fingerprint');
    check('6c a DIFFERENT value in the SAME file under the SAME pattern still fails', false, 'skipped');
    check('6d and the real owner username is separately reported', false, 'skipped');
  }
}

// ── 7. the #93 pattern narrowings did not cost real detections ─────────────
// Two patterns were narrowed rather than suppressed. A narrowing is only
// defensible if the signal it drops is not signal, so each is pinned in BOTH
// directions: the artifact stops firing AND the real thing still does.

{
  // (a) POSIX home-dir: prose listing slash-separated words matched as a path
  //     because the preceding word's last letter sat against the slash.
  const prose = runGate({ 'c.mjs': '// dangerous targets (root/home/glob/traversal/abs) BLOCK.\n' });
  check('7a prose that merely contains the word "home" between slashes no longer fires',
    prose.status === 0, prose.out);

  // MUST-FIRE fixture values are assembled from pieces rather than written as
  // literals. This file is itself tracked and therefore scanned, and a literal
  // here would trip the very patterns it is asserting — leaving the gate red on
  // its own regression test. Same trick, same reason, as the split Slack token
  // at tests/v3/state/test-prism-kb-knowledge-indexer.mjs:93-95. The runtime
  // strings are byte-identical to the literals, so the assertions are unchanged.
  const HOME_PATH = `/${'home'}/builder/.cache/prism`;
  const realHome = runGate({ 'c.mjs': `const p = "${HOME_PATH}";\n` });
  check('7b a genuine POSIX home path STILL fires', realHome.status === 1, realHome.out);
  check('7c ...and is reported under the home-dir pattern',
    /POSIX home-dir path/.test(realHome.out), realHome.out);

  // (b) UUIDs: only structurally-non-random placeholders are excluded.
  const placeholderUuid = runGate({
    'f.mjs': [
      '// session deadbeef-0000-4000-8000-000000000001',
      '// nil      00000000-0000-0000-0000-000000000000',
      '',
    ].join('\n'),
  });
  check('7d deadbeef- and nil placeholder UUIDs no longer fire', placeholderUuid.status === 0,
    placeholderUuid.out);

  // Split for the same reason as HOME_PATH above.
  const REAL_UUID = `3f2a91c4-7b6e-${'4d18'}-9a02-5c8e1f7b3d40`;
  const realUuid = runGate({ 'f.mjs': `// session ${REAL_UUID}\n` });
  check('7e a real-looking session UUID STILL fires', realUuid.status === 1, realUuid.out);
  check('7f ...and is reported under the UUID pattern',
    /UUID-shaped identifier/.test(realUuid.out), realUuid.out);

  // A near-miss guard: the exclusion is anchored to the FIRST group, so
  // "deadbeef" appearing later must not exempt anything.
  const NEAR_MISS_UUID = `3f2a91c4-dead-${'beef'}-9a02-5c8e1f7b3d40`;
  const notPrefixed = runGate({ 'f.mjs': `// id ${NEAR_MISS_UUID}\n` });
  check('7g the placeholder exclusion is anchored to the first group only',
    notPrefixed.status === 1, notPrefixed.out);
}

// ── 8. the vacuous case is declared, not passed off as clean (D084) ────────

{
  const { root, toolRel } = makeRepo({}, '[]');
  const r = spawnSync(process.execPath, [join(root, toolRel)], { cwd: root, encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('8a a scan over zero files still prints its denominator', /files scanned \.+ 0/.test(out), out);
  check('8b ...and says outright that the run proves nothing', /VACUOUS/.test(out), out);
}

// ── 9. the tool never becomes a manifest of what it hunts for ──────────────
// The #92 defect was the scanner's own source carrying the values. The
// ACCOUNTED[] list is new surface with exactly that hazard, so it is pinned:
// the shipped tool must stay clean under its own scan.

{
  check('9a the shipped tool source contains no owner plaintext',
    !TOOL_SRC.includes(OWNER_LOCAL) && !TOOL_SRC.includes(OWNER_DOMAIN) && !TOOL_SRC.includes(OWNER_USERNAME),
    'owner value found verbatim in tools/prism-mirror-pii-scan.mjs');
  check('9b ACCOUNTED[] stores digests, not the matched values',
    /sha256: '[0-9a-f]{16}'/.test(TOOL_SRC), 'expected 16-hex digest fields in ACCOUNTED[]');
  check('9c the tool source has no NUL bytes (a NUL makes isBinary() skip it from its own scan)',
    !TOOL_SRC.includes('\u0000'), 'NUL byte present in the tool source');
}

console.log(`\n${pass} passed, ${total - pass} failed (${total} total)`);
process.exit(pass === total ? 0 : 1);
