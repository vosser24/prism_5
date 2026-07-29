#!/usr/bin/env node
// prism-mirror-pii-scan.mjs — dependency-free PII/secret scan for the prism_5
// public-mirror release gate (task #72 / D044 §e "Gap to close next").
//
// D044 (docs/prism/adjudications/D044-prism5-mirror-pii-gate.md, Locked) found
// two leak paths on the v6.3.0 mirror: a shipped test fixture carrying a real
// employer name + OneDrive path, and 26 docs/prism/ files that predated the
// /docs/ gitignore rule and so stayed tracked (a gitignore rule is NOT
// retroactive — it only stops NEW files from being added, it does not untrack
// files git already has in its index). That gate was ad hoc; this script is
// the standing check D044 asked for.
//
// SCOPE: this scans the set of files `git ls-files` returns — i.e. every
// TRACKED file in the current tree, regardless of what .gitignore says today.
// That is deliberate and mirrors the D044 finding above: `docs/` and
// `.claude/references/` are gitignored, but gitignore does not retroactively
// untrack anything, so any file that slipped into the index before those
// rules existed is still tracked, still flows into `main^{tree}`, and is
// still exactly what the mirror runbook pushes (see
// docs/prism/smoke/smoke-prism5-release-mirror.md: `TREE=$(git rev-parse
// main^{tree})`). Scanning `git ls-files` is therefore the correct proxy for
// "what would be pushed" — NOT the whole working directory (which would flood
// the report with docs/ and .claude/references/ false-"positives" that never
// actually reach the mirror) and NOT a hardcoded exclude-list (which would
// silently re-introduce the exact D044 blind spot: gitignored-but-tracked
// files hiding from review because a scanner assumed the ignore rule meant
// "excluded").
//
// Usage:
//   node tools/prism-mirror-pii-scan.mjs                  # scan `git ls-files` under --root (default cwd)
//   node tools/prism-mirror-pii-scan.mjs --root <path>    # run git ls-files against a different repo root
//   node tools/prism-mirror-pii-scan.mjs --files-from <listfile>   # scan an explicit newline-delimited file list instead
//
// ── THE GATE (task #93) ─────────────────────────────────────────────────────
// Until task #93 this tool was a pure DETECTOR: every raw match was printed and
// any match at all exited 1. After task #92 removed the last true positive, a
// clean tree still exited 1 with 30 findings — all classified false positives.
// That made the stated release gate ("ZERO true positives") un-machine-checkable:
// the tool could not express "clean", so a human had to re-derive the same
// 30-way classification from memory every release. Three failure modes, all
// already observed here in other forms:
//   1. A check that ALWAYS fails teaches people to wave it through.
//   2. The classification drifts because it lives in memory, not an artifact —
//      it already did (a prior handoff's false-positive list omitted 5 hits).
//   3. A NEW true positive is camouflaged among 30 familiar false positives.
//
// So this tool now answers a decidable question: are there any UNACCOUNTED
// findings? Every deliberately-accepted finding has a durable, individually
// justified entry in ACCOUNTED[] below, keyed on a stable identity that is
// NOT a line number and NOT the literal matched text (see that block for why).
//
// Exit 0 requires ALL of:
//   - zero unaccounted findings,
//   - zero STALE ACCOUNTED[] entries (an entry matching nothing is reported
//     loudly and fails — a suppression that silently covers nothing is worse
//     than no suppression at all),
//   - zero MALFORMED ACCOUNTED[] entries,
//   - zero owner-fragment hits from the independent substring sweep (below).
// Exit 1 on any of those, or on a usage/IO error.
//
// It still does not auto-redact or auto-remediate anything, and it still
// prints its full denominator on EVERY run including the vacuous 0-file case
// (D084: a check must never be silently green).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

function parseArgs(argv) {
  const args = { root: process.cwd(), filesFrom: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) { args.root = argv[++i]; }
    else if (argv[i] === '--files-from' && argv[i + 1]) { args.filesFrom = argv[++i]; }
    else if (argv[i] === '--help' || argv[i] === '-h') { args.help = true; }
  }
  return args;
}

function usage() {
  return [
    'Usage: node tools/prism-mirror-pii-scan.mjs [--root <path>] [--files-from <listfile>]',
    '',
    '  --root <path>        Repo root to run `git ls-files` against (default: cwd).',
    '  --files-from <path>  Scan this newline-delimited file list instead of `git ls-files`.',
    '                       Paths are resolved relative to --root (or absolute).',
    '',
    'Exit 0 = no UNACCOUNTED findings, no stale/malformed ACCOUNTED[] entries,',
    'and no owner-fragment hits. Exit 1 on any of those, or on an error.',
    '',
    'A finding is "accounted for" only if ACCOUNTED[] in this file carries an',
    'entry with a written justification for that exact file+pattern+value. The',
    'tool prints a ready-to-paste stub for anything unaccounted, but the stub is',
    'deliberately rejected until someone replaces its TODO reason. Nothing is',
    'ever auto-fixed or auto-redacted — triage TRUE/FALSE positive by hand.',
  ].join('\n');
}

// ── Self-scan avoidance (task #92) ──────────────────────────────────────────
// This file is itself `git ls-files`-tracked and ships into the exact
// prism_5 mirror it exists to protect (see D044). A plaintext regex literal
// for the owner's email address IS the leak, shipped with a certificate of
// authenticity from the tool meant to catch it — the scanner would flag
// itself, which is exactly what happened (task #92 finding). NOTE: do not
// re-add the literal here even as an "example" — an escaped form (a
// backslash before the dot, as a regex literal naturally has) is invisible
// to this scanner's own patterns while staying fully readable to a human
// and greppable by GitHub code search. That gap is exactly how the literal
// ended up back in this comment once already (task #92 follow-up) — see
// the tracked-tree fragment-grep note in the release procedure, which is
// the compensating control for this class of miss.
//
// The 5 project-owner values below are reconstructed from base64 at load
// time instead of hand-maintained as regex literals. This is NOT an attempt
// at cryptographic secrecy — base64 is trivially reversible by anyone
// reading this file, and a targeted reader has other legitimate ways to
// learn the owner's identity anyway. It defeats the actual threat this gate
// exists for: a PUBLIC mirror carrying the literal string in a form that
// grep, GitHub code search, and search-engine indexing pick up directly.
//
// Chosen over the two alternatives considered (see task #92 report for the
// full trade-off writeup):
//   (b) gitignored local config the scanner loads if present, and
//   (c) a separate non-shipped pattern-set file
// Both (b)/(c) mean a fresh clone (a teammate, a reinstall, the mirror
// itself) scans with FEWER patterns by default — an environment-dependent
// control that goes quietly weaker is the same failure shape D044 already
// diagnosed once here (a gitignore rule that silently stopped covering
// already-tracked files). The base64-reconstruction approach keeps the full
// pattern set byte-identical in every clone with no environment dependency,
// so there is nothing that can silently go missing and no fail-closed/loud-
// reporting machinery is needed to guard against that class of failure.
function b64(s) { return Buffer.from(s, 'base64').toString('utf8'); }
function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const OWNER_EMAIL = b64('c2Vydm9zeUBwcmFrdGlrZXIuZ3I=');
const OWNER_EMAIL_DOMAIN = OWNER_EMAIL.split('@')[1];
const EMPLOYER_NAME = b64('UHJha3Rpa2VyIEhlbGxhcw==');
const [EMPLOYER_WORD_1, EMPLOYER_WORD_2] = EMPLOYER_NAME.split(' ');
const OWNER_USERNAME = b64('U2Vydm9zWQ==');
const PRIVATE_REPO_NAME = b64('cHJpc21fbWFzdGVy');
const INTERNAL_HOSTNAME = b64('Z3JocWVjb21t');

const OWNER_EMAIL_RE = new RegExp(reEscape(OWNER_EMAIL), 'gi');
const OWNER_DOMAIN_RE = new RegExp(`[A-Za-z0-9._%+-]+@${reEscape(OWNER_EMAIL_DOMAIN)}`, 'gi');
const EMPLOYER_NAME_RE = new RegExp(`${reEscape(EMPLOYER_WORD_1)}\\s*${reEscape(EMPLOYER_WORD_2)}`, 'gi');
const OWNER_USERNAME_RE = new RegExp(`\\b${reEscape(OWNER_USERNAME)}\\b`, 'g');
const PRIVATE_REPO_NAME_RE = new RegExp(`\\b${reEscape(PRIVATE_REPO_NAME)}\\b`, 'g');
const INTERNAL_HOSTNAME_RE = new RegExp(`\\b${reEscape(INTERNAL_HOSTNAME)}\\w*\\b`, 'gi');

// ── Pattern catalogue ───────────────────────────────────────────────────────
// Each pattern: { category, label, re } — re must be global for matchAll.
const PATTERNS = [
  // -- secrets / credentials --
  { category: 'secret', label: 'OpenAI-style key (sk-...)', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { category: 'secret', label: 'GitHub PAT (ghp_...)', re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { category: 'secret', label: 'GitHub fine-grained PAT (github_pat_...)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { category: 'secret', label: 'AWS access key ID (AKIA...)', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { category: 'secret', label: 'Slack token (xox[baprs]-...)', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { category: 'secret', label: 'PEM private key header', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { category: 'secret', label: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9\-_.]{20,}\b/g },
  { category: 'secret', label: '.env-shaped credential assignment', re: /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*=\s*['"][^'"\s]{8,}['"]/g },
  { category: 'secret', label: 'Credential in a connection-string URL', re: /\b\w+:\/\/[A-Za-z0-9._%+-]+:[^@\/\s'"]{4,}@[A-Za-z0-9.-]+/g },

  // -- personal identifiers -- (values reconstructed above, not hardcoded)
  { category: 'personal_identifier', label: 'Owner email (reconstructed at load time)', re: OWNER_EMAIL_RE },
  { category: 'personal_identifier', label: 'Any address on the owner\'s email domain', re: OWNER_DOMAIN_RE },
  { category: 'personal_identifier', label: 'Employer name (reconstructed at load time)', re: EMPLOYER_NAME_RE },
  { category: 'personal_identifier', label: 'Generic email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },

  // -- machine-local leakage --
  { category: 'machine_local', label: 'Windows user-profile path (C:\\Users\\<name>)', re: /C:\\Users\\[A-Za-z0-9_.-]+/g },
  { category: 'machine_local', label: 'Literal owner username (reconstructed at load time)', re: OWNER_USERNAME_RE },
  { category: 'machine_local', label: 'Y: drive path', re: /\bY:[\\/]/g },
  // The `(?<![A-Za-z0-9_])` lookbehind is a task-#93 narrowing, not a
  // loosening: a real POSIX home path is never preceded by an identifier
  // character. Without it, ordinary English prose containing the word "home"
  // between slashes matched — measured case, still in the tree:
  // `tests/v3/state/test-prism-safety-overfire.mjs:89`, a comment listing the
  // dangerous rm-target classes as a slash-separated run of words. The `t`
  // ending the preceding word sat immediately before the slash, so a
  // three-word fragment of that prose parsed as a home path. It is not a path
  // at all, and no accountable finding is lost by excluding it: a home path
  // preceded by a quote, an `=`, whitespace, a line start, or the third slash
  // of a `file://` URL all still match, since none of those characters is in
  // the excluded class. (Literal example paths are deliberately NOT written
  // out in this comment — this file is scanned by its own patterns, and prose
  // in the scanner that trips the scanner is how the false-positive pile that
  // task #93 exists to eliminate got built in the first place.)
  { category: 'machine_local', label: 'POSIX home-dir path (/home/<user>/)', re: /(?<![A-Za-z0-9_])\/home\/[a-z_][a-z0-9_-]{2,}\//g },

  // -- session / telemetry identifiers --
  { category: 'session_telemetry', label: 'UUID-shaped identifier', re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  // NOTE: deliberately NOT matching bare `.prism-*` filename patterns (e.g.
  // `.prism-turn-tier-*.json`, `.prism-sessions/`) as a standalone category.
  // This project's own source vocabulary IS these filenames — every hook and
  // doc that describes PRISM's runtime-state schema mentions them by name,
  // which is documentation, not a leaked value. Measured: an earlier version
  // of this pattern produced 614 of 625 session_telemetry hits across the
  // tracked tree, none an actual leaked identifier — pure structural noise
  // that would drown the real signal. The UUID pattern above and the
  // transcript-temp-dir pattern below catch an actual EMBEDDED VALUE (a real
  // session id, a real machine-specific temp path); a schema-name mention on
  // its own is not evidence of one.
  { category: 'session_telemetry', label: 'Transcript temp-dir path', re: /AppData\\Local\\Temp\\claude/g },

  // -- internal-only references --
  { category: 'internal_reference', label: 'Private repo name (reconstructed at load time)', re: PRIVATE_REPO_NAME_RE },
  { category: 'internal_reference', label: 'RFC1918 internal IP literal', re: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/g },
  { category: 'internal_reference', label: 'Known internal hostname (reconstructed at load time)', re: INTERNAL_HOSTNAME_RE },
];

// Placeholder/test domains that should NOT trip the generic-email pattern —
// these are conventional non-routable/test addresses used throughout the
// test suite (e.g. golden-master@example.invalid, admin@db.example.com in a
// fixture connection string), not real PII.
const EMAIL_ALLOW_DOMAINS = /@([a-z0-9.-]*\.)?(example|test|invalid|localhost)(\.(com|org|net|invalid|test))?$/i;

// Structurally-non-random placeholder UUIDs that should NOT trip the
// UUID-shaped-identifier pattern (task #93). This is the same reasoning the
// EMAIL_ALLOW_DOMAINS block directly above already applies to
// example/test/invalid/localhost addresses — a conventional fake value is not
// PII — and it is consistent with what the UUID pattern's own NOTE (above)
// says that pattern is FOR: catching "an actual EMBEDDED VALUE (a real
// session id ...)". A nil UUID and a `deadbeef`-prefixed UUID are by
// construction not real session ids; no generator emits them.
//
// Why a pattern-level exclusion rather than 10 ACCOUNTED[] entries: measured,
// all 10 UUID findings on the current tree are deliberate fixture
// placeholders (1 nil + 9 `deadbeef-…`), spread over 6 files. Keyed
// per-(file,value) they would need ~10 near-identical entries, and every
// future test fixture that coins a new `deadbeef-…` id would fail the gate
// until someone added another one — a recurring tax on an already-conventional
// fake value, paid by whoever is least likely to understand it. That is the
// "a check that always fails teaches people to wave it through" dynamic this
// task exists to remove, reintroduced at a smaller scale.
//
// This is deliberately NARROW. It does not exempt "UUIDs in test files" or
// "UUIDs that look synthetic" — only these two structural forms. A real
// session id appearing anywhere, including inside a fixture, still fires.
const NIL_UUID_RE = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const PLACEHOLDER_UUID_PREFIX_RE = /^deadbeef-/i;
function isPlaceholderUuid(s) {
  return NIL_UUID_RE.test(s) || PLACEHOLDER_UUID_PREFIX_RE.test(s);
}

// ── ACCOUNTED findings (task #93) ───────────────────────────────────────────
// Every finding this gate deliberately accepts, with an individual written
// justification. This list — not anyone's memory, and not a paragraph in a
// handoff — IS the classification. Exit 0 means "no finding outside this
// list"; that is the machine-checkable form of the release gate.
//
// IDENTITY = file + label + sha256(matched text)[0..16]. Each part is chosen:
//   - NOT the line number: an entry keyed on a line rots the moment anything
//     is inserted above it, and it would then either fail spuriously or
//     (worse) drift onto a different line's finding.
//   - NOT the literal matched text: putting the flagged profile paths, the
//     canonical fake AWS key, the PEM header and the credentialed connection
//     string into THIS file would make the scanner's own source a manifest of
//     every value it looks for — a PII/secret manifest that
//     ships into the public mirror — exactly the task-#92 defect, recreated
//     by the fix for #93. A truncated digest carries the identity without the
//     value. 64 bits is far more than enough here: this is a change-detector
//     over ~20 known strings, not a security boundary against a forger who
//     already has write access to this file.
//   - `label`, not `category`: a label is the specific pattern that fired, so
//     an entry cannot silently migrate to a different pattern in the same
//     category. Labels are validated against PATTERNS at startup, so renaming
//     a pattern fails loudly here instead of quietly orphaning an entry.
//
// Consequence worth stating plainly: an entry accounts for a VALUE IN A FILE,
// not an occurrence. If the same already-classified placeholder appears again
// elsewhere in the same file, that occurrence is covered too — a deliberate
// trade, because pinning exact counts would fail the build every time someone
// added one more drive-letter mention to a comment. To keep that from being SILENT
// widening, every run prints the occurrence count per entry, so growth shows
// up in the report rather than being invisible.
//
// Rejected alternative — an inline `PRISM-PII-OK: <reason>` marker at the
// finding site, mirroring task #89's `PRISM-CITATION-EXEMPT` convention (see
// docs/prism/plans/2026-07-29-task89-citation-gate-design.md). Two reasons,
// both specific to this gate rather than to markers in general:
//   1. Several flagged files cannot carry a marker. `tests/v3/audit-scenarios.json`
//      is JSON (no comment syntax), and
//      `tests/v3/hooks/fixtures/t32-specialist-routing-fp/fp-1-git-commit-dispatch.txt`
//      is a verbatim past-dispatch prompt used as byte-significant INPUT to
//      the specialist-routing classifier — injecting a marker line into it
//      edits the test's input.
//   2. #89's scanner is ADVISORY and prints an auditable EXEMPT bucket a human
//      reads; this one is a RELEASE GATE that must return a bare exit code. A
//      marker exempts a LOCATION, so a real value that later replaces the
//      placeholder at that site inherits the exemption silently, and an
//      orphaned marker is invisible. A digest-keyed entry stops matching the
//      moment the value changes, and a non-matching entry is reported as STALE
//      and FAILS — which is the property this task requires and a marker
//      cannot provide.
// What IS inherited from #89, deliberately, so the two do not drift on the
// part that transfers: the reason text is mandatory and a stub/empty reason is
// MALFORMED, not merely untidy.
const ACCOUNTED = [
  // -- generic Windows-path placeholders in documentation/comments --
  {
    file: 'agents/claude-master.md', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: 'e79c60e7d95fd88c',
    reason: 'Placeholder username in the permissions docs illustrating how Claude Code normalises a Windows path; generic, not this machine.',
  },
  {
    file: 'hooks/prism-specialist-routing-guard.mjs', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: '643f06f9661ac84e',
    reason: 'Placeholder username in a comment showing where the roster resolves to on Windows; generic, not this machine.',
  },
  {
    file: 'tests/v3/hooks/test-specialist-routing-guard.mjs', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: '643f06f9661ac84e',
    reason: 'Same placeholder-username comment as the guard it tests, kept verbatim so the two read identically.',
  },
  {
    file: 'tests/v3/hooks/fixtures/t32-specialist-routing-fp/fp-1-git-commit-dispatch.txt', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: '643f06f9661ac84e',
    reason: 'Placeholder username inside a fixture prompt that is byte-significant classifier INPUT; the repo path in it is fictional.',
  },
  {
    file: 'tests/v3/hooks/test-tier-router-sentinel-no-tilde.mjs', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: 'aa551da2cb2f33e3',
    reason: 'Abstract user A in a comment contrasting a wrongly-expanded tilde against the real profile; not a real account.',
  },
  {
    file: 'tests/v3/hooks/test-tier-router-sentinel-no-tilde.mjs', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: 'bae620792a9b7aa5',
    reason: 'Abstract user B in the same comment pair as the entry above; not a real account.',
  },
  {
    file: 'tests/v3/state/test-prism-bootstrap.mjs', label: 'Windows user-profile path (C:\\Users\\<name>)', sha256: '66ae9804fdfebde9',
    reason: 'First-person placeholder in a comment about basename collisions; a generic example path, not this machine.',
  },

  // -- Y: drive references in comments about a Node URL.pathname quirk --
  {
    file: 'hooks/prism-acl-sessionend.mjs', label: 'Y: drive path', sha256: '1d0ab12f32cb9c13',
    reason: 'Comment documenting that URL.pathname yields a leading-slash drive path on Windows; an arbitrary drive letter in an explanation.',
  },
  {
    file: 'hooks/prism-acl-worker.mjs', label: 'Y: drive path', sha256: '1d0ab12f32cb9c13',
    reason: 'Same URL.pathname quirk comment as the sessionend hook; arbitrary drive letter in an explanation.',
  },
  {
    file: 'hooks/prism-lesson-match.mjs', label: 'Y: drive path', sha256: '006f4c9aac7cd321',
    reason: 'Comment naming the ERR_UNSUPPORTED_ESM_URL_SCHEME case; arbitrary drive letter in an explanation.',
  },
  {
    file: 'hooks/prism-userpromptsubmit-dispatcher.mjs', label: 'Y: drive path', sha256: '006f4c9aac7cd321',
    reason: 'Same ERR_UNSUPPORTED_ESM_URL_SCHEME comment as the lesson-match hook; arbitrary drive letter in an explanation.',
  },
  {
    file: 'tools/prism-bootstrap.mjs', label: 'Y: drive path', sha256: '1d0ab12f32cb9c13',
    reason: 'Forward-slash form in the one-line comment about Node mis-resolving a pathname-derived drive path; explanation, not a real path.',
  },
  {
    file: 'tools/prism-bootstrap.mjs', label: 'Y: drive path', sha256: '006f4c9aac7cd321',
    reason: 'Backslash form on that same comment line, which the global pattern matches twice; explanation, not a real path.',
  },

  // -- deliberate secret-shaped literals that are INPUTS to a redaction test --
  {
    file: 'tests/v3/state/test-prism-kb-knowledge-indexer.mjs', label: 'AWS access key ID (AKIA...)', sha256: '743554670c6065b3',
    reason: 'Canonical fake AWS key passed as the argument to scanSecrets() to assert it IS redacted; removing it deletes the assertion.',
  },
  {
    file: 'tests/v3/state/test-prism-kb-knowledge-indexer.mjs', label: 'PEM private key header', sha256: '8bcac7908eb95041',
    reason: 'Bare PEM header string (no key material) passed to scanSecrets() to assert it IS redacted; removing it deletes the assertion.',
  },
  {
    file: 'tests/v3/state/test-prism-kb-knowledge-indexer.mjs', label: 'Credential in a connection-string URL', sha256: 'ca2d1c1021247e3a',
    reason: 'Fake postgres URL on an example.com host passed to scanSecrets() to assert it IS redacted; removing it deletes the assertion.',
  },

  // -- magic-prefix constant that the .env-shaped pattern keys on by name --
  {
    file: 'hooks/prism-specialist-routing-guard.mjs', label: '.env-shaped credential assignment', sha256: '3c53e3deb324b7f3',
    reason: 'A user-typed compose-guard override prefix, not a credential; the pattern fires only because the identifier ends in TOKEN.',
  },
];

// ── Independent owner-fragment sweep (D107 companion check) ─────────────────
// A DIFFERENT MATCHER over the same file set, and the reason it exists is
// specific: the task-#92 follow-up reintroduced the owner's email address into
// this very file in REGEX-ESCAPED form — the address as it appears when
// written as a regex literal, with a backslash before each dot. The anchored
// literal patterns above cannot see that: a backslash sits between the
// characters they expect to be adjacent. GitHub code search, grep and
// search-engine indexing all find it perfectly well. It was caught only by
// sweeping the tracked tree independently of the tool's own patterns.
//
// This sweep then caught the SAME mistake a third time, while task #93 was
// being written: a comment here describing the escaped form quoted it, and
// this check failed the run on its own file. That is the intended behaviour,
// and it is why the description above is prose rather than an example.
//
// D107: a verification scoped to an instrument's own output cannot distinguish
// "clean" from "clean as far as this instrument can see." So that independent
// sweep is not left as a companion command someone has to remember to run —
// remembering to run a check is the same defect class this whole task is
// closing. It runs on every invocation, as plain case-insensitive SUBSTRING
// matching (no regex, no word boundaries), which is what makes it survive
// escaping, quoting and interpolation.
//
// Fragments are derived from the base64-reconstructed values above, so this
// block adds no new plaintext to the file.
//
// These hits are NOT suppressible via ACCOUNTED[] and that is deliberate: the
// correct response to an owner-identity fragment appearing in a public mirror
// is to remove it, never to justify it. Measured on the current tree: 0 hits
// across all 5 fragments.
const OWNER_FRAGMENTS = [
  OWNER_EMAIL.split('@')[0],        // email local part
  OWNER_EMAIL_DOMAIN.split('.')[0], // first label of the email domain
  EMPLOYER_WORD_2,                  // second employer word (first == domain label)
  OWNER_USERNAME,
  PRIVATE_REPO_NAME,
  INTERNAL_HOSTNAME,
];

function fingerprint(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

// Composite map key for an entry / a finding. JSON-encoded rather than joined
// on a separator character: a separator has to be a byte that cannot occur in
// any component, and the obvious choice (NUL) would embed a real 0x00 in this
// file's own bytes — which `isBinary()` above treats as "skip this file
// entirely". That would silently exempt the scanner from its OWN scan, which
// is exactly the self-scan blind spot task #92 was filed for. Encoding
// sidesteps the question instead of answering it carefully once and hoping.
function entryKey(e) {
  return JSON.stringify([e.file, e.label, e.sha256]);
}

// Startup validation of ACCOUNTED[]. A malformed entry FAILS the run — it is
// never skipped, downgraded, or silently ignored, because a suppression list
// nobody can trust is worse than no suppression list.
function validateAccounted(knownLabels) {
  const problems = [];
  const seen = new Set();
  ACCOUNTED.forEach((e, i) => {
    const at = `ACCOUNTED[${i}]`;
    if (typeof e.file !== 'string' || !e.file.trim()) problems.push(`${at}: missing/empty \`file\``);
    if (typeof e.label !== 'string' || !e.label.trim()) problems.push(`${at}: missing/empty \`label\``);
    else if (!knownLabels.has(e.label)) problems.push(`${at}: \`label\` ${JSON.stringify(e.label)} matches no pattern in PATTERNS — renamed or typo'd`);
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{16}$/.test(e.sha256)) problems.push(`${at}: \`sha256\` must be 16 lowercase hex chars`);
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    if (reason.length < 20) problems.push(`${at}: \`reason\` must be a real written justification (>=20 chars), got ${reason.length}`);
    else if (/^todo\b/i.test(reason)) problems.push(`${at}: \`reason\` is still a TODO stub — write the actual justification`);
    const k = entryKey(e);
    if (seen.has(k)) problems.push(`${at}: duplicate of an earlier entry (same file+label+sha256)`);
    seen.add(k);
  });
  return problems;
}

function scanFragments(files, root) {
  const hits = [];
  const needles = OWNER_FRAGMENTS.map((f) => f.toLowerCase());
  for (const rel of files) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue;
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let ln = 0; ln < lines.length; ln++) {
      const lower = lines[ln].toLowerCase();
      for (let fi = 0; fi < needles.length; fi++) {
        if (lower.includes(needles[fi])) hits.push({ file: rel, line: ln + 1, fragmentIndex: fi });
      }
    }
  }
  return hits;
}

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function getTrackedFiles(root) {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

function snippet(line, index, matchLen) {
  const CTX = 40;
  const start = Math.max(0, index - CTX);
  const end = Math.min(line.length, index + matchLen + CTX);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return prefix + line.slice(start, end) + suffix;
}

function scanFile(relPath, root, findings) {
  const abs = resolve(root, relPath);
  if (!existsSync(abs)) return; // deleted-but-still-listed edge case
  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return;
  }
  if (isBinary(buf)) return;
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    for (const { category, label, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (label === 'Generic email address' && EMAIL_ALLOW_DOMAINS.test(m[0])) continue;
        if (label === 'UUID-shaped identifier' && isPlaceholderUuid(m[0])) continue;
        findings.push({
          file: relPath,
          line: ln + 1,
          category,
          label,
          match: m[0],
          fingerprint: fingerprint(m[0]),
          snippet: snippet(line, m.index, m[0].length),
        });
        if (m[0].length === 0) re.lastIndex++; // guard zero-width patterns
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const root = resolve(args.root);

  let files;
  if (args.filesFrom) {
    const listPath = resolve(root, args.filesFrom);
    const raw = readFileSync(listPath, 'utf8');
    files = raw.split(/\r?\n/).filter(Boolean);
  } else {
    try {
      files = getTrackedFiles(root);
    } catch (err) {
      console.error(`prism-mirror-pii-scan: failed to run \`git ls-files\` in ${root}: ${err.message}`);
      process.exit(1);
    }
  }

  // Partial scans (--files-from) legitimately cannot see most of the tree, so
  // an entry matching nothing is expected rather than stale. The check is
  // skipped there and the skip is PRINTED — never quietly dropped, or the
  // gate would report a narrower result than it appears to.
  const fullTree = !args.filesFrom;

  const knownLabels = new Set(PATTERNS.map((p) => p.label));
  const malformed = validateAccounted(knownLabels);

  const findings = [];
  for (const f of files) {
    scanFile(f, root, findings);
  }

  // Attribute every finding to an ACCOUNTED entry, or to nothing.
  const hitCounts = new Map(ACCOUNTED.map((e) => [entryKey(e), 0]));
  const unaccounted = [];
  for (const f of findings) {
    const k = entryKey({ file: f.file, label: f.label, sha256: f.fingerprint });
    if (hitCounts.has(k)) hitCounts.set(k, hitCounts.get(k) + 1);
    else unaccounted.push(f);
  }
  const accountedCount = findings.length - unaccounted.length;
  const stale = fullTree ? ACCOUNTED.filter((e) => hitCounts.get(entryKey(e)) === 0) : [];

  const fragmentHits = scanFragments(files, root);

  // ── denominator, printed unconditionally (D084) ───────────────────────────
  console.log('prism-mirror-pii-scan:');
  console.log(`  files scanned ............ ${files.length}${fullTree ? ' (git ls-files)' : ` (--files-from ${args.filesFrom})`}`);
  console.log(`  patterns applied ......... ${PATTERNS.length}`);
  console.log(`  raw findings ............. ${findings.length}`);
  console.log(`  accounted for ............ ${accountedCount}`);
  console.log(`  UNACCOUNTED .............. ${unaccounted.length}`);
  console.log(`  suppression entries ...... ${ACCOUNTED.length} (${ACCOUNTED.length - stale.length} matched, ${stale.length} stale)`);
  console.log(`  malformed entries ........ ${malformed.length}`);
  console.log(`  owner fragments swept .... ${OWNER_FRAGMENTS.length} -> ${fragmentHits.length} hit(s)`);
  if (files.length === 0) {
    console.log('  NOTE: 0 files scanned — this run is VACUOUS and proves nothing about the tree.');
  }
  if (!fullTree) {
    console.log('  NOTE: partial scan — the STALE-suppression check is SKIPPED (it is only');
    console.log('        meaningful over the full `git ls-files` set).');
  }
  console.log('');

  // Per-entry occurrence counts, every run: an entry silently growing to cover
  // more occurrences than it did last release is visible here rather than not
  // at all (identity is file+label+value, so it can never widen to a DIFFERENT
  // value — only to more sites of the same already-classified one).
  if (ACCOUNTED.length > 0) {
    console.log('Suppression entries (occurrences matched this run):');
    for (const e of ACCOUNTED) {
      const n = hitCounts.get(entryKey(e));
      const flag = fullTree && n === 0 ? '  <-- STALE' : '';
      console.log(`  ${String(n).padStart(3)}x  ${e.file}  [${e.label}]  ${e.sha256}${flag}`);
    }
    console.log('');
  }

  let failed = false;

  if (malformed.length > 0) {
    failed = true;
    console.log(`MALFORMED suppression entries (${malformed.length}) — fix these first, the list cannot be trusted until they are gone:`);
    for (const p of malformed) console.log(`  ${p}`);
    console.log('');
  }

  if (stale.length > 0) {
    failed = true;
    console.log(`STALE suppression entries (${stale.length}) — each of these matched NOTHING on this run.`);
    console.log('A suppression that covers nothing is not harmless: it means the finding it was');
    console.log('written for has moved, changed value, or gone away, and nobody re-checked. Either');
    console.log('delete the entry, or re-derive it from the finding that replaced it.');
    for (const e of stale) {
      console.log(`  ${e.file}  [${e.label}]  ${e.sha256}`);
      console.log(`      reason on file: ${e.reason}`);
    }
    console.log('');
  }

  if (fragmentHits.length > 0) {
    failed = true;
    console.log(`OWNER-FRAGMENT HITS (${fragmentHits.length}) — independent substring sweep, NOT suppressible.`);
    console.log('These are owner-identity fragments found by plain case-insensitive substring');
    console.log('matching, which sees escaped/quoted/interpolated forms the anchored patterns');
    console.log('above cannot (the task-#92 follow-up miss). Remove the fragment; do not');
    console.log('account for it. Fragment values are deliberately not echoed here.');
    for (const h of fragmentHits) {
      console.log(`  ${h.file}:${h.line}  (owner fragment #${h.fragmentIndex})`);
    }
    console.log('');
  }

  if (unaccounted.length > 0) {
    failed = true;
    console.log(`UNACCOUNTED findings (${unaccounted.length}) — triage each as TRUE POSITIVE or FALSE POSITIVE:`);
    for (const f of unaccounted) {
      console.log(`  ${f.file}:${f.line}: [${f.category}] ${f.label} -> ${JSON.stringify(f.snippet)}`);
    }
    console.log('');
    console.log('If — and only if — a finding is a FALSE POSITIVE, account for it by adding an');
    console.log('entry to ACCOUNTED[] in this file. Stubs below; the `reason` is NOT optional');
    console.log('boilerplate, it is the durable record of the classification and a TODO/short');
    console.log('reason is rejected as malformed on the next run:');
    const seenStub = new Set();
    for (const f of unaccounted) {
      const k = entryKey({ file: f.file, label: f.label, sha256: f.fingerprint });
      if (seenStub.has(k)) continue;
      seenStub.add(k);
      console.log(`  { file: ${JSON.stringify(f.file)}, label: ${JSON.stringify(f.label)}, sha256: '${f.fingerprint}',`);
      console.log('    reason: \'TODO: why this specific value is not PII/a secret\' },');
    }
    console.log('');
  }

  if (failed) {
    console.log('prism-mirror-pii-scan: FAIL — the tree is NOT release-clean (see above).');
    process.exit(1);
  }

  console.log(`prism-mirror-pii-scan: OK — 0 unaccounted findings, 0 stale/malformed entries, 0 fragment hits across ${files.length} file(s).`);
  process.exit(0);
}

main();
