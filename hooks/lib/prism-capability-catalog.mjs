// PRISM capability catalog (Package G) — builds a compact NAME + one-line-purpose
// index of every installed agent, skill, plugin skill, external tool, and MCP
// from roster.json's unified resource-index. Emitted by prism-session-start.mjs
// as SessionStart additionalContext so the orchestrator always KNOWS what
// capabilities exist and routes tasks to an existing one instead of building new
// on the fly. Rides independent of the native skill-listing budget (which
// silently drops least-used skill descriptions), so the inventory stays COMPLETE.
//
// Pure, dependency-free, and FAIL-OPEN: any missing/malformed input yields '' (or
// just the groups that parsed) and NEVER throws.

// F46 (task #63, 2026-07-28): the agent-status filter below used to be its own
// single-literal `status === 'available'` check — a SECOND, independently
// duplicated copy of the exact status-vocabulary bug task #54 fixed in
// prism-specialist-routing-guard.mjs (F37). A live roster agent has status
// 'active' or 'upgrade_needed' as well as 'available' (see LIVE_STATUSES'
// header comment in that file for the full census). Importing the one
// allow-list here — instead of re-deriving a second literal set — is the
// D096 fix-class: ONE explicit live-state predicate, single-sourced, so a
// future vocabulary drift can only diverge in one place, not two.
import { isLiveStatus, statusCensus } from '../prism-specialist-routing-guard.mjs';

// Generous defensive cap. Normal case injects the whole inventory well under this.
const MAX_BYTES = 32 * 1024;

// Emission gate. Inject UNLESS PRISM_DISABLE_CAPABILITY_CATALOG === '1'.
export function capabilityCatalogEnabled(env) {
  const e = env || {};
  return e.PRISM_DISABLE_CAPABILITY_CATALOG !== '1';
}

// Collapse whitespace and truncate to one line at ~max chars (ellipsis on cut).
function oneLine(s, max = 120) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Trim a dangling partial word for readability, then ellipsize.
  return flat.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd() + '…';
}

// Resolve a one-line purpose for an agent/skill entry:
// description → core_domains → domains → '' (caller falls back to a placeholder).
function purposeFrom(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.description === 'string' && entry.description.trim()) return oneLine(entry.description);
  if (Array.isArray(entry.core_domains) && entry.core_domains.length) return oneLine(entry.core_domains.join(', '));
  if (Array.isArray(entry.domains) && entry.domains.length) return oneLine(entry.domains.join(', '));
  return '';
}

// Turn a resource-index section object into sorted `- name — purpose` rows.
// Skips `_`-prefixed schema-example keys. Deterministic (lexicographic sort).
function collectRows(obj, filterFn, purposeFn) {
  if (!obj || typeof obj !== 'object') return [];
  const rows = [];
  for (const name of Object.keys(obj)) {
    if (name.startsWith('_')) continue; // schema-example / doc keys
    const entry = obj[name];
    if (typeof filterFn === 'function' && !filterFn(name, entry)) continue;
    const purpose = purposeFn(entry) || '(no description)';
    rows.push(`- ${name} — ${purpose}`);
  }
  rows.sort();
  return rows;
}

// Build the full catalog block from a parsed roster.json object.
// Returns '' when nothing usable is present. Never throws.
export function buildCapabilityCatalog(roster) {
  try {
    if (!roster || typeof roster !== 'object') return '';

    // Agents — exclude archived / dead-status. F46: reuse the single-sourced
    // isLiveStatus() allow-list (LIVE_STATUSES: available/active/upgrade_needed,
    // absent/null/'' also live) instead of the old bare `=== 'available'` check,
    // which silently dropped e.g. claude-master (status:'active').
    const agentRows = collectRows(
      roster.agents,
      (_n, e) => e && e.archived !== true && isLiveStatus(e),
      purposeFrom,
    );

    // D046/D096 loud census: count what this filter actually threw away, and
    // NAME the offending status literal(s) — a silent count of 0 excluded looks
    // identical to "the filter is broken and excludes everything", so this must
    // always be visible on the card, not just logged when non-zero.
    const agentCensus = statusCensus(roster);
    const agentsSeen = (roster.agents && typeof roster.agents === 'object')
      ? Object.keys(roster.agents).filter((n) => !n.startsWith('_')).length
      : 0;

    // Skills split into plugin (source starts "plugin:") vs the rest (prism/user).
    const isPlugin = (e) => !!(e && typeof e.source === 'string' && e.source.startsWith('plugin:'));
    const skillRows = collectRows(roster.skills, (_n, e) => !isPlugin(e), purposeFrom);
    const pluginRows = collectRows(roster.skills, (_n, e) => isPlugin(e), purposeFrom);

    // External tools (tools-registry.md): no description field — synthesize a
    // one-liner from domains + install status/tier.
    const toolRows = collectRows(roster.tools, null, (e) => {
      if (!e || typeof e !== 'object') return '';
      const dom = Array.isArray(e.domains) && e.domains.length ? e.domains.join(', ') : 'external tool';
      const status = e.install_status ? ` [${e.install_status}${e.tier ? ', tier ' + e.tier : ''}]` : '';
      return oneLine(dom + status);
    });

    // MCP servers/tools: prefer description, else domains + status.
    const mcpRows = collectRows(roster.mcps, null, (e) => {
      if (!e || typeof e !== 'object') return '';
      if (typeof e.description === 'string' && e.description.trim()) return oneLine(e.description);
      const dom = Array.isArray(e.domains) && e.domains.length ? e.domains.join(', ') : 'MCP server';
      const status = e.status ? ` [${e.status}]` : '';
      return oneLine(dom + status);
    });

    // Archived count, computed the same way the routing guard's census does
    // (name-prefix-skipped, archived===true), so "kept + archived + excluded
    // by status" reconciles against agentsSeen without a silent remainder.
    const archivedCount = (roster.agents && typeof roster.agents === 'object')
      ? Object.entries(roster.agents).filter(([n, e]) => !n.startsWith('_') && e && e.archived === true).length
      : 0;
    const agentCensusLine = `_(agents: ${agentRows.length}/${agentsSeen} kept` +
      (archivedCount > 0 ? `, ${archivedCount} archived` : '') +
      (agentCensus.excluded_by_status > 0 ? `, ${agentCensus.excluded_by_status} excluded by status: ${agentCensus.excluded_statuses.join(', ')}` : '') +
      ')_';

    const sections = [];
    if (agentRows.length) sections.push('## Agents\n' + agentRows.join('\n') + '\n' + agentCensusLine);
    if (skillRows.length) sections.push('## Skills\n' + skillRows.join('\n'));
    if (pluginRows.length) sections.push('## Plugin skills\n' + pluginRows.join('\n'));
    if (toolRows.length) sections.push('## Tools\n' + toolRows.join('\n'));
    if (mcpRows.length) sections.push('## MCP tools\n' + mcpRows.join('\n'));

    if (!sections.length) return '';

    const header =
      'CAPABILITY CATALOG (all installed agents/skills/tools — ROUTE to an ' +
      'existing one before building anything new; read its SKILL.md/agent file ' +
      'on demand for detail):';
    let out = header + '\n\n' + sections.join('\n\n');

    // Defensive size cap: truncate on a line boundary with a trailing marker.
    if (Buffer.byteLength(out, 'utf8') > MAX_BYTES) {
      const lines = out.split('\n');
      const kept = [];
      let bytes = 0;
      let i = 0;
      for (; i < lines.length; i++) {
        const b = Buffer.byteLength(lines[i] + '\n', 'utf8');
        if (bytes + b > MAX_BYTES - 80) break;
        bytes += b;
        kept.push(lines[i]);
      }
      const dropped = lines.length - i;
      out = kept.join('\n') + `\n…(+${dropped} more — run /prism-index)`;
    }

    return out;
  } catch {
    return '';
  }
}
