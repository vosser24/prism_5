// tools/lib/prism-failure-taxonomy.mjs
// C2 — classify WHY a verdict was UN-CITED/REJECTED into a structured taxonomy.
// Aggregated by K0 to show which failure modes dominate (feeds v5.0 A5).
// Modes: missing_evidence, wrong_evidence_class, scope_drift, hallucinated_resource,
//        stale_reference, other.

const RULES = [
  ['hallucinated_resource', /\b(does ?not exist|no such (file|function|symbol)|hallucinat|fabricat|invented)\b/i],
  ['stale_reference',       /\b(stale|out of date|outdated|renamed|moved|no longer (exists|present))\b/i],
  ['scope_drift',           /\b(out of scope|scope (drift|creep)|unrelated|beyond the (task|panel))\b/i],
  ['wrong_evidence_class',  /\b(wrong (class|kind) of evidence|cited .* but needed|class mismatch)\b/i],
  ['missing_evidence',      /\b(no (citation|evidence)|uncited|un-?cited|unsubstantiated|not (cited|backed))\b/i],
];

export function classifyFailureMode(reasonText) {
  const t = String(reasonText ?? '');
  for (const [mode, re] of RULES) { if (re.test(t)) return { mode, matched: re.source }; }
  return { mode: 'other', matched: null };
}

export const FAILURE_MODES = RULES.map(r => r[0]).concat('other');
