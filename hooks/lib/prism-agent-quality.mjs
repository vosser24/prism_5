// PRISM Agent Quality scorer (v1.0.0) — pure, side-effect-free logic for the
// Agent Quality Gate (hooks/prism-agent-quality-gate.mjs) and, later,
// /prism-roster --quality. No fs/network here — callers pass in the agent body,
// roster, and skill-domain map. Everything is unit-testable in isolation.
//
// The keeper idea (mention ≠ equip): a skill counts as WIRED only when it is in
// the agent's `skills:` frontmatter AND referenced in the operating protocol
// (body). A `composes_with`-only entry, or a prose mention with no `skills:`
// entry, FAILS — that is the exact failure that motivated the proposal.
//
// quality_score is 1–5 to match the convention already documented in
// agents/agent-factory.md:323 ("quality_score: 1-5 from quality gate").

// ── frontmatter ──────────────────────────────────────────────────────────────
// Split `---\n…\n---\n<body>`. Returns {fmText, body}. No YAML lib — we read a
// small fixed set of fields (scalars + simple lists).
export function splitFrontmatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---')) return {fmText: '', body: s};
  const end = s.indexOf('\n---', 3);
  if (end === -1) return {fmText: '', body: s};
  return {fmText: s.slice(3, end), body: s.slice(end + 4)};
}

// Parse a list field that is either inline (`skills: [a, b]`) or a YAML block:
//   skills:
//     - a
//     - b
export function parseListField(fmText, field) {
  const lines = String(fmText || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^(\\s*)${field}\\s*:\\s*(.*?)\\s*$`));
    if (!m) continue;
    const indent = m[1].length;
    const inline = m[2];
    if (inline && inline !== '') {
      // inline array `[a, b]` or a single scalar `x`
      const arr = inline.replace(/^\[|\]$/g, '').split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      return arr;
    }
    // block list on following more-indented `- item` lines
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const cl = lines[j].match(/^(\s*)-\s+(.*?)\s*$/);
      if (!cl || cl[1].length <= indent) break;
      out.push(cl[2].trim().replace(/^['"]|['"]$/g, ''));
    }
    return out;
  }
  return out;
}

export function parseScalarField(fmText, field) {
  const m = String(fmText || '').match(new RegExp(`^\\s*${field}\\s*:\\s*(.*?)\\s*$`, 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : '';
}

// Last name segment of a (possibly namespaced) skill, e.g.
// "superpowers:frontend-design" → "frontend-design".
function skillTail(name) {
  const s = String(name || '');
  return s.includes(':') ? s.split(':').pop() : s;
}

// A skill is WIRED iff it is declared in `skills:` frontmatter AND its name (or
// last segment) is referenced in the body (the operating protocol), not merely
// in `composes_with` / prose.
export function isSkillWired(skillName, fmSkills, body) {
  const declared = (fmSkills || []).some(s => s === skillName || skillTail(s) === skillTail(skillName));
  if (!declared) return false;
  const tail = skillTail(skillName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const full = String(skillName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])(${full}|${tail})([^a-z0-9]|$)`, 'i');
  return re.test(String(body || ''));
}

// Role: explicit frontmatter `role:` wins; else heuristic. A domain specialist
// that builds/edits defaults to 'builder' (the full-bar role). Pure recon/search
// agents and consistency enforcers carry a lower bar.
export function inferRole(fmText, body, name) {
  const explicit = parseScalarField(fmText, 'role').toLowerCase();
  if (['builder', 'recon', 'consistency-enforcer'].includes(explicit)) return explicit;
  const n = String(name || '').toLowerCase();
  const b = String(body || '').toLowerCase();
  if (/\b(recon|search|explore|read-only|investigat)/.test(n + ' ' + b) && !/\b(build|implement|create|edit|refactor)\b/.test(b)) return 'recon';
  return 'builder';
}

// Match the agent's domain: explicit frontmatter core_domains first, else
// keyword match of the map's domain keys + recommended skills against the text.
export function matchAgentDomain(fmText, body, name, skillDomainMap) {
  const map = skillDomainMap || {};
  const coreDomains = parseListField(fmText, 'core_domains').map(d => d.toLowerCase());
  for (const dk of Object.keys(map)) {
    if (coreDomains.includes(dk.toLowerCase())) return dk;
  }
  const text = `${name || ''} ${fmText || ''} ${body || ''}`.toLowerCase();
  let best = null, bestScore = 0;
  for (const [dk, spec] of Object.entries(map)) {
    let score = 0;
    const terms = [dk, ...(spec.skills || []), ...(spec.depth_refs || [])];
    for (const term of terms) {
      const t = String(term).toLowerCase();
      if (t.length < 3) continue;
      const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      if (re.test(text)) score++;
    }
    if (score > bestScore) { bestScore = score; best = dk; }
  }
  // Require ≥2 signals to claim a domain (avoid a single generic keyword).
  return bestScore >= 2 ? best : null;
}

function bodyHasRef(body, term) {
  const t = String(term || '').toLowerCase();
  if (!t) return false;
  const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
  return re.test(String(body || '').toLowerCase());
}

// ── main scorer ──────────────────────────────────────────────────────────────
// scoreAgent({name, text, roster, skillDomainMap}) → scorecard.
// research_tier: lower is better (1 = external/NotebookLM, 3 = codebase-only).
export function scoreAgent({name, text, roster = null, skillDomainMap = {}}) {
  const {fmText, body} = splitFrontmatter(text);
  const fmSkills = parseListField(fmText, 'skills');
  const role = inferRole(fmText, body, name);
  const domain = matchAgentDomain(fmText, body, name, skillDomainMap);

  // research_tier: agent frontmatter wins, else the roster entry, else unknown.
  const fmTier = parseScalarField(fmText, 'research_tier');
  const rosterEntry = roster && roster.agents && roster.agents[name];
  const researchTier = fmTier ? Number(fmTier)
    : (rosterEntry && rosterEntry.research_tier != null ? Number(rosterEntry.research_tier) : null);

  // Non-builder roles, or builders with no recognized domain, get a low bar:
  // there is nothing domain-specific to enforce. Pass, no gaps.
  if (role !== 'builder' || !domain) {
    return {
      agent: name, role, domain: domain || null,
      skills_expected: [], skills_wired: [], skills_missing: [],
      research_tier: researchTier, research_ok: true,
      depth_refs_expected: [], depth_refs_present: [], depth_refs_missing: [],
      score_ratio: 1, quality_score: 5, pass: true, gaps: [],
      reason: role !== 'builder' ? `role=${role} (low bar)` : 'no recognized domain (low bar)',
    };
  }

  const spec = skillDomainMap[domain] || {};
  const skillsExpected = spec.skills || [];
  const skillsWired = skillsExpected.filter(s => isSkillWired(s, fmSkills, body));
  const skillsMissing = skillsExpected.filter(s => !skillsWired.includes(s));

  const depthExpected = spec.depth_refs || [];
  const depthPresent = depthExpected.filter(r => bodyHasRef(body, r));
  const depthMissing = depthExpected.filter(r => !depthPresent.includes(r));

  const minTier = spec.min_research_tier_for_builder != null ? spec.min_research_tier_for_builder : 1;
  const researchOk = researchTier != null && researchTier <= minTier;

  // Weighted ratio: skills 0.4, research 0.3, depth 0.3.
  const skillsRatio = skillsExpected.length ? skillsWired.length / skillsExpected.length : 1;
  const depthRatio = depthExpected.length ? depthPresent.length / depthExpected.length : 1;
  const scoreRatio = 0.4 * skillsRatio + 0.3 * (researchOk ? 1 : 0) + 0.3 * depthRatio;
  const qualityScore = Math.max(1, Math.min(5, Math.round(1 + scoreRatio * 4)));

  const pass = skillsMissing.length === 0 && researchOk && depthMissing.length === 0;

  const gaps = [];
  if (skillsMissing.length) gaps.push(`skills not wired (in skills: frontmatter + referenced in body): ${skillsMissing.join(', ')}`);
  if (!researchOk) gaps.push(researchTier == null
    ? `research_tier unknown — builders need ≤ tier ${minTier} (external/NotebookLM-grounded)`
    : `research_tier ${researchTier} below bar (need ≤ ${minTier}) — enrich via @agent-factory / NotebookLM`);
  if (depthMissing.length) gaps.push(`domain-depth references missing: ${depthMissing.join(', ')}`);

  return {
    agent: name, role, domain,
    skills_expected: skillsExpected, skills_wired: skillsWired, skills_missing: skillsMissing,
    research_tier: researchTier, research_ok: researchOk,
    depth_refs_expected: depthExpected, depth_refs_present: depthPresent, depth_refs_missing: depthMissing,
    score_ratio: Number(scoreRatio.toFixed(3)), quality_score: qualityScore, pass, gaps,
  };
}
