// tests/v3/cli/acl-stub-factory.mjs — Stub factory for ACL E2E tests
//
// Used by PRISM_ACL_FACTORY=<path-to-this-file> in the detached worker.
// Writes a minimal valid skill markdown into the staging dir without
// dispatching any real LLM / agent-factory subprocess.
//
// Export: default function factory(spec, stagingDir) → stagingFilePath

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function factory(spec, stagingDir) {
  const name = spec.name || 'unknown-builder';
  const desc = spec.description || `Auto-stub for ${name}`;
  const dest = join(stagingDir, name + '.md');

  const content = [
    '---',
    `name: ${name}`,
    `description: ${desc}`,
    `type: ${spec.type || 'skill'}`,
    'version: 1',
    '---',
    '',
    `# ${name}`,
    '',
    `Stub-generated skill for E2E testing. Members: ${(spec.members || []).slice(0, 3).join('; ')}.`,
  ].join('\n');

  writeFileSync(dest, content, 'utf-8');
  return dest;
}
