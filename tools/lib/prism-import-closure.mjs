// tools/lib/prism-import-closure.mjs
//
// Dep-free static analysis: extract relative (./ or ../) import/export
// specifiers from an ESM source file, and walk the transitive closure of
// local imports starting from a set of seed files.
//
// Extracted from tests/v3/install-manifest-completeness.test.mjs so the same
// closure-walk is not re-implemented for a second consumer. Two current
// consumers:
//   - tests/v3/install-manifest-completeness.test.mjs (repo-side: is every
//     transitively-imported file ALSO in tools/install-manifest.json?)
//   - tools/prism-installer.mjs verify (installed-side: does every
//     transitively-imported file ALSO exist in the installed CLAUDE_DIR?)
//
// `buildImportClosure` is deliberately base-dir-agnostic: callers pass a
// `toAbsPath(relPath) -> absPath` resolver so the same walk works against
// the repo tree or an arbitrary installed target tree.

import { readFileSync, existsSync } from 'node:fs';
import { posix as posixPath } from 'node:path';

// Crude comment stripper — good enough for this repo's own source (no JS
// parser dependency, stays dep-free). Only ever drops a trailing `//`
// comment on a line; none of the string literals scanned for (bare `.mjs`
// filenames, `./`/`../` import specifiers) contain `//`, so a false-strip
// here can only remove prose, never a filename reference we need to catch.
export function stripLineComments(src) {
  return src.split('\n').map(line => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

// Matches real ES import/export syntax with a relative specifier:
//   import {x} from './y.mjs'   import y from '../y.mjs'   export * from './y.mjs'
//   import('./y.mjs')            (static string literal dynamic import only)
const STATIC_IMPORT_RE = /\b(?:import|export)\s*(?:[\w*{}\s,]+\s*from\s*)?['"](\.\.?\/[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

export function extractLocalImportSpecs(fileAbsPath) {
  const src = stripLineComments(readFileSync(fileAbsPath, 'utf-8'));
  const specs = new Set();
  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  return specs;
}

export function resolveSpecToRepoPath(fromFileRelPath, spec) {
  const fromDir = posixPath.dirname(fromFileRelPath);
  return posixPath.normalize(posixPath.join(fromDir, spec));
}

// Walks the local-import graph starting from `seeds` (posix, base-relative
// paths). `toAbsPath(relPath)` resolves a relative path to an absolute one
// under whichever base dir the caller cares about (repo root, installed
// CLAUDE_DIR, ...). A seed/resolved file that doesn't exist on disk is still
// added to `visited` (so callers can report it as missing) but is not
// recursed into (its imports can't be read).
//
// Returns {visited: Set<relPath>, dependents: Map<relPath, Set<relPath>>}.
export function buildImportClosure(seeds, toAbsPath) {
  const visited = new Set();
  const dependents = new Map(); // resolvedPath -> Set(files that import it)
  const queue = [...seeds];
  while (queue.length) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    visited.add(rel);
    const abs = toAbsPath(rel);
    if (!existsSync(abs)) continue; // exists-but-missing is a different bug; caller's job to report
    const specs = extractLocalImportSpecs(abs);
    for (const spec of specs) {
      const resolvedRel = resolveSpecToRepoPath(rel, spec);
      if (!dependents.has(resolvedRel)) dependents.set(resolvedRel, new Set());
      dependents.get(resolvedRel).add(rel);
      if (!visited.has(resolvedRel)) queue.push(resolvedRel);
    }
  }
  return { visited, dependents };
}
