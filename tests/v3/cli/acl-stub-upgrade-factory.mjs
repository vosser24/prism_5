// tests/v3/cli/acl-stub-upgrade-factory.mjs — Stub upgrade factory for Phase-2 E2E
//
// Used by PRISM_ACL_FACTORY=<path-to-this-file> in the detached worker for
// Phase-2 tests. Handles BOTH create (no spec.upgrade) and upgrade (spec.upgrade)
// cases so the worker's full detect→promote→learn pass can run without a real LLM.
//
// Export: default function factory(spec, stagingDir) → stagingFilePath

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function factory(spec, stagingDir) {
  const name = spec.name || 'unknown-builder';
  const isUpgrade = spec.upgrade === true;
  const version = isUpgrade ? (spec.toVersion || 2) : 1;
  const desc = spec.description || `Auto-stub for ${name}`;
  const dest = join(stagingDir, name + '.md');

  const content = [
    '---',
    `name: ${name}`,
    `description: ${desc}${isUpgrade ? ' (upgraded)' : ''}`,
    `type: ${spec.type || 'skill'}`,
    `version: ${version}`,
    '---',
    '',
    `# ${name} v${version}`,
    '',
    isUpgrade
      ? `Stub-upgraded skill for Phase-2 E2E testing (v${spec.fromVersion || 1}→v${version}).`
      : `Stub-created skill for E2E testing. Members: ${(spec.members || []).slice(0, 3).join('; ')}.`,
  ].join('\n');

  writeFileSync(dest, content, 'utf-8');
  return dest;
}
