#!/usr/bin/env node
import { detect, classifyCapabilityType } from '../../../tools/prism-capability-detect.mjs';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'prism-acl-detect-test-'));

try {
  // ── F1.2 fixture ──────────────────────────────────────────────────────────
  // 4 watchdog/health-monitor prompts across 2 sessions + 5 unrelated prompts
  const routingLines = [
    // Session A — health/watchdog cluster
    { event: 'dispatch_cap', session_id: 'sess-A', description: 'build a watchdog process to monitor service health', ts: '2026-06-17T10:00:00Z' },
    { event: 'dispatch_cap', session_id: 'sess-A', description: 'create an uptime checker that pings endpoints', ts: '2026-06-17T10:05:00Z' },
    // Session B — same cluster, different session
    { event: 'dispatch_cap', session_id: 'sess-B', description: 'implement health monitor to track process uptime', ts: '2026-06-17T11:00:00Z' },
    { event: 'dispatch_cap', session_id: 'sess-B', description: 'set up process supervisor for service watchdog', ts: '2026-06-17T11:05:00Z' },
    // Unrelated prompts (5)
    { event: 'dispatch_cap', session_id: 'sess-A', description: 'write unit tests for the parser module', ts: '2026-06-17T10:10:00Z' },
    { event: 'dispatch_cap', session_id: 'sess-B', description: 'refactor database connection pooling logic', ts: '2026-06-17T11:10:00Z' },
    { event: 'dispatch_cap', session_id: 'sess-C', description: 'update README with installation instructions', ts: '2026-06-17T12:00:00Z' },
    { event: 'dispatch_cap', session_id: 'sess-C', description: 'configure webpack bundler for production build', ts: '2026-06-17T12:05:00Z' },
    { event: 'dispatch_cap', session_id: 'sess-C', description: 'fix CSS flex layout in the header component', ts: '2026-06-17T12:10:00Z' },
  ];

  const routingPath = join(tmpDir, 'routing.jsonl');
  writeFileSync(routingPath, routingLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

  const rosterPath = join(tmpDir, 'roster.json');
  writeFileSync(rosterPath, JSON.stringify({ agents: {}, skills: {} }), 'utf-8');

  const cands = detect({ routingPath, sinceLine: 0, threshold: 3, rosterPath });

  // Should find exactly one promote candidate
  const promotes = cands.filter(c => c.kind === 'promote');
  assert.strictEqual(promotes.length, 1, `Expected 1 promote candidate, got ${promotes.length}; all: ${JSON.stringify(cands.map(c=>({kind:c.kind,label:c.label,m:c.members.length})))}`);

  const cand = promotes[0];
  assert.ok(cand.members.length >= 3, `Expected members >= 3, got ${cand.members.length}`);
  assert.ok(new Set(cand.sessions).size >= 2, `Expected >= 2 distinct sessions, got ${new Set(cand.sessions).size}`);

  // Unrelated prompts must NOT form a candidate
  const unrelatedLabels = promotes.filter(c =>
    c.label && (c.label.includes('parser') || c.label.includes('database') ||
      c.label.includes('readme') || c.label.includes('webpack') || c.label.includes('css'))
  );
  assert.strictEqual(unrelatedLabels.length, 0, 'Unrelated prompts must not form a candidate');

  // ── F1.3 classifier tests ─────────────────────────────────────────────────
  // Procedure cluster → 'skill'
  const procedureMembers = [
    'set up a CI/CD pipeline for the project',
    'configure GitHub Actions workflow',
    'scaffold a new deployment script',
    'set up linting and formatting tools',
  ];
  const procedureType = classifyCapabilityType(procedureMembers);
  assert.strictEqual(procedureType, 'skill', `Procedure cluster: expected 'skill', got '${procedureType}'`);

  // Judgment cluster → 'agent'
  const judgmentMembers = [
    'design the system architecture for the new service',
    'evaluate trade-offs between REST and GraphQL',
    'decide on the database technology stack',
    'assess security risks in the authentication flow',
  ];
  const judgmentType = classifyCapabilityType(judgmentMembers);
  assert.strictEqual(judgmentType, 'agent', `Judgment cluster: expected 'agent', got '${judgmentType}'`);

  // Ambiguous → 'skill' (tie-break)
  const ambiguousMembers = [
    'help with the monitoring system',
    'work on health checks',
    'handle the watchdog process',
  ];
  const ambiguousType = classifyCapabilityType(ambiguousMembers);
  assert.strictEqual(ambiguousType, 'skill', `Ambiguous cluster: expected 'skill' (tie-break), got '${ambiguousType}'`);

  // F1.3 wired into detect: check suggestedType on the watchdog candidate
  assert.ok(['skill', 'agent'].includes(cand.suggestedType), `suggestedType must be 'skill' or 'agent', got '${cand.suggestedType}'`);

  console.log('ok');
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
