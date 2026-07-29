// tests/v3/lib/make-fixture-home.mjs
//
// F38 (task #55/#66) — shared ephemeral-$HOME fixture builder.
//
// PROBLEM: 27 test files under tests/v3/ (measured via
//   `grep -rl "function makeHome\|const makeHome\|makeHome(" tests/v3/ --include="*.mjs" | grep -v "/bench/"`,
//   2026-07-29) each hand-roll their own mkdtempSync + copyFileSync fixture,
// copying only the NAMED dependency files a production hook/tool needs. When
// that production file gains a new transitive `./`/`../` lib import, the
// fixture silently under-populates and Node's static ESM resolution throws
// before test logic runs (or, in the worse #66 case below, the error gets
// SWALLOWED by a "never throws" catch and the test sees a plausible-looking
// empty result instead of any error at all).
//
// Fired twice, both reproduced:
//   1. Task #22 (prismHome migration): 4 tests went red at once with an
//      opaque ERR_MODULE_NOT_FOUND because none of their fixtures copied the
//      newly-added `prism-home.mjs` transitive dep. Cost a full diagnostic
//      pass to establish it was a fixture gap, not a behavioural bug.
//   2. THE #66 INCIDENT (2026-07-28) — decisive evidence, cite this one.
//      Task #63 added `import {isLiveStatus, statusCensus} from
//      '../prism-specialist-routing-guard.mjs'` to
//      hooks/lib/prism-capability-catalog.mjs. tests/v3/hooks/
//      test-payload-cut-session-start.mjs provisioned only the catalog file.
//      The chain was TWO LEVELS DEEP: prism-specialist-routing-guard.mjs
//      itself imports `./lib/prism-home.mjs`. Worse than case 1:
//      buildCapabilityCatalog is documented "Never throws", so it SWALLOWED
//      the module-resolution error and returned '' — the test saw a
//      plausible EMPTY catalog, not a loud failure. Fixed in c45782670.
//
// OWNER DECISION (settled, do not re-litigate): explicit dependency list
// (option a) — this module takes an explicit `{src, dest}` array, a
// mechanical drop-in for what the 27 fixtures already do by hand, no
// behaviour change, low risk. It centralises the list so the next migration
// updates one place instead of N. Rejected: auto-scan-and-copy of the
// transitive import graph (option b) — decided against even knowing plain
// (a) does not by itself close the bug class (a forgotten `deps` entry still
// breaks silently, and #66 would still have failed under plain (a) alone).
//
// CHAIR REFINEMENT (adopted, see verdict below): keep the explicit list as
// the SOLE source of truth for what gets copied (no auto-copy — so there is
// no "which deps should deliberately not be copied" ambiguity), but at
// build time STATICALLY SCAN each declared dep's `./`/`../` import graph and
// THROW a clear, named error if any transitively-reached local file is
// absent from the declared list. This converts silent under-population into
// a loud, self-describing failure without adopting (b)'s copy semantics —
// the list still decides what gets copied; the scan only checks the list is
// COMPLETE. Verdict: HOLDS UP for the bug class this file exists to catch
// (static relative-import chains, including the #66 two-level shape, and
// `export * from` / `export {..} from` re-exports). Two known, safe-direction
// limitations, both documented at the call sites below:
//   - Cannot see a RUNTIME-COMPUTED dynamic import path (e.g. a hook that
//     builds `join(HOME, '.claude', 'hooks', 'lib', 'x.mjs')` from the fake
//     HOME env var at run time, as hooks/prism-session-start.mjs does for
//     the catalog lib). That link must still be identified by a human once
//     and seeded as a `deps` entry; the scan then reliably walks everything
//     STATICALLY reachable from that seed.
//   - Will flag a file that is imported unconditionally in source even if
//     the specific test scenario never exercises that code path (i.e. it
//     can be over-inclusive). This is the SAFE direction — it fails closed
//     (forces an unnecessary-but-harmless copy) rather than open (silent
//     gap) — so it is accepted, not a disqualifier.
//
// ADOPTION POLICY (do NOT migrate all 27 at once): adopt this helper for
// NEW tests going forward. Leave existing hand-rolled fixtures alone unless
// they break again (then migrate that one file as you fix it). Incremental
// migration keeps the blast radius small and lets the design prove itself
// on real cases before 27 files depend on it.
//
// ─────────────────────────────────────────────────────────────────────────
// API
//
//   makeFixtureHome(deps, opts?) -> {home, cleanup}
//     deps: Array<{src: string, dest: string}>
//       src  — absolute path to the real repo source file to copy in.
//       dest — path relative to the fixture's fake HOME root, e.g.
//              '.claude/hooks/lib/prism-capability-catalog.mjs'.
//     opts.label  — string used in the mkdtemp prefix (default 'fixture').
//     opts.scan   — set false to skip the completeness scan (default true;
//                   turning this off reopens the exact #66 failure mode —
//                   only do this with a comment explaining why).
//     Throws before touching the filesystem if `scan` finds a transitively-
//     imported local file missing from `deps`.
//
//   scanForMissingDeps(deps) -> Array<{from, specifier, resolved}>
//     Runs just the scan (no filesystem writes) — exported so callers/tests
//     can assert on the scan result directly.
//
// ─────────────────────────────────────────────────────────────────────────

import {mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';

// Best-effort comment strip — not a full JS parser. Sufficient for this
// repo's consistent semicolon-terminated ESM import/export style (verified
// against hooks/lib/prism-capability-catalog.mjs, hooks/prism-specialist-
// routing-guard.mjs, hooks/lib/prism-home.mjs). Avoids matching import-like
// text that appears only inside a comment.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// Bounded by `[^;]` (not `[\s\S]`) so a match cannot cross a statement
// terminator into the NEXT import/export statement — safe for this repo's
// convention of one semicolon-terminated import per statement, unsafe in
// general for semicolon-free (ASI-only) source.
const LOCAL_IMPORT_PATTERNS = [
  /\bimport\s+[^;]*?\sfrom\s+['"]([^'"]+)['"]/g,   // import {..}/x from '...'
  /\bimport\s+['"]([^'"]+)['"]/g,                   // import '...' (side-effect)
  /\bexport\s+[^;]*?\sfrom\s+['"]([^'"]+)['"]/g,    // export * / {..} from '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,         // import('...') — STRING LITERAL only;
];                                                    // a runtime-computed path is invisible here.

function extractLocalImportSpecifiers(source) {
  const cleaned = stripComments(source);
  const specifiers = new Set();
  for (const re of LOCAL_IMPORT_PATTERNS) {
    let m;
    while ((m = re.exec(cleaned))) {
      const spec = m[1];
      // node:/bare package specifiers are deliberately ignored — only a
      // relative specifier can be a transitive FIXTURE dependency.
      if (spec.startsWith('./') || spec.startsWith('../')) specifiers.add(spec);
    }
  }
  return [...specifiers];
}

// BFS the local (relative-import) dependency graph starting from every
// declared `src`. Reads files straight off disk (not from the declared
// list) so a two-level chain like #66 (A declares only the catalog; catalog
// imports the routing guard; routing guard imports prism-home) is walked in
// full regardless of what's in `deps` — that's what lets the scan catch a
// gap the declared list doesn't yet know about.
function walkLocalDepGraph(entryAbsPaths) {
  const visited = new Set();
  const queue = entryAbsPaths.map((p) => resolve(p));
  const edges = [];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch (e) {
      throw new Error(`make-fixture-home: cannot read "${file}" while scanning the import graph: ${e.message}`);
    }
    for (const spec of extractLocalImportSpecifiers(content)) {
      const resolved = resolve(dirname(file), spec);
      edges.push({from: file, specifier: spec, resolved});
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return edges;
}

export function scanForMissingDeps(deps) {
  const declaredSrc = new Set(deps.map((d) => resolve(d.src)));
  const edges = walkLocalDepGraph(deps.map((d) => d.src));
  const missing = [];
  const seenResolved = new Set();
  for (const e of edges) {
    if (!declaredSrc.has(e.resolved) && !seenResolved.has(e.resolved)) {
      seenResolved.add(e.resolved);
      missing.push(e);
    }
  }
  return missing;
}

export function makeFixtureHome(deps, opts = {}) {
  const {label = 'fixture', scan = true} = opts;
  if (!Array.isArray(deps) || deps.length === 0) {
    throw new Error('make-fixture-home: deps must be a non-empty array of {src, dest}');
  }
  if (scan) {
    const missing = scanForMissingDeps(deps);
    if (missing.length) {
      const lines = missing.map(
        (m) => `  - "${m.specifier}" (imported by ${m.from}) resolves to ${m.resolved}, which is NOT in the declared deps list`,
      );
      throw new Error(
        `make-fixture-home: declared deps list is INCOMPLETE for fixture "${label}".\n` +
        `The following transitively-imported local file(s) are missing:\n${lines.join('\n')}\n` +
        `Add a {src, dest} entry for each, or pass {scan:false} with a comment explaining why ` +
        `(see F38/#66 in this file's header before doing that).`,
      );
    }
  }
  const home = mkdtempSync(join(tmpdir(), `${label}-home-`));
  for (const {src, dest} of deps) {
    const destAbs = join(home, dest);
    mkdirSync(dirname(destAbs), {recursive: true});
    copyFileSync(src, destAbs);
  }
  return {
    home,
    cleanup() {
      rmSync(home, {recursive: true, force: true});
    },
  };
}
