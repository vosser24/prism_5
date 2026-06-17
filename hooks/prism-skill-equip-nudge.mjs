#!/usr/bin/env node
// prism-skill-equip-nudge.mjs — advisory (non-blocking) guard (D1 / F9).
// On every Agent dispatch, checks whether the dispatch prompt contains keywords
// that match a roster skill but does NOT reference the skill by name. If so,
// emits an additionalContext nudge reminding the orchestrator to equip the
// worker IN ITS PROMPT per phase-1-execution.md:124-133.
//
// Contract: ALWAYS exit 0, ALWAYS allow — purely advisory, never blocks.
// Pure-read, no side-effects, order-independent (safe for parallel Agent route).

import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const H = process.env.USERPROFILE || process.env.HOME || '';

export async function run(payload) {
  const allow = (ctx) => ({
    exit: 0,
    stdout: ctx
      ? JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: ctx}})
      : '',
    stderr: '',
  });

  // Only act on Agent dispatches
  if (!payload || payload.tool_name !== 'Agent') return allow('');

  const rawPrompt = (payload.tool_input && payload.tool_input.prompt) || '';
  const prompt = rawPrompt.toLowerCase();

  // Read roster — fail-open on any error
  let roster = null;
  try {
    const rosterPath = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    if (!existsSync(rosterPath)) return allow('');
    roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  } catch {
    return allow('');
  }

  if (!roster || !roster.skills) return allow('');

  const missing = [];
  for (const [skillName, entry] of Object.entries(roster.skills)) {
    // Collect keyword terms from domains + keywords arrays + skill name's last segment
    const terms = [];
    if (Array.isArray(entry.domains)) terms.push(...entry.domains);
    if (Array.isArray(entry.keywords)) terms.push(...entry.keywords);
    // Last segment of the skill name (e.g. "test-driven-development" from "superpowers:test-driven-development")
    const lastSegment = skillName.includes(':') ? skillName.split(':').pop() : skillName;
    terms.push(lastSegment);

    const termMatched = terms.some(t => t && prompt.includes(t.toLowerCase()));
    const skillInPrompt = rawPrompt.includes(skillName);

    if (termMatched && !skillInPrompt) {
      missing.push(skillName);
    }
  }

  if (missing.length === 0) return allow('');

  const msg = `PRISM skill-equip advisory (F9): the worker task matches roster skill(s) ${missing.join(', ')}, but the dispatch prompt does not reference them. Per phase-1-execution.md:124-133, equip the worker IN ITS PROMPT (inject the discipline / SKILL.md path) — do NOT tell the worker to "invoke the skill". Advisory only; dispatch proceeds.`;
  return allow(msg);
}

// Standalone mode (called directly, not via dispatcher)
if (process.argv[1] && process.argv[1].endsWith('prism-skill-equip-nudge.mjs')) {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf-8') || '{}');
    const result = await run(payload);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exit);
  } catch {
    process.exit(0);
  }
}
