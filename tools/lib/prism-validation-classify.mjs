// tools/lib/prism-validation-classify.mjs
// C1 — classify a reviewer verdict body into {valid, invalid, partial, unverifiable}.
// Used to sharpen K2's agreement signal beyond raw verdict-token matching.
// Input: a verdict object with { severity?, summary:{total, un_cited, rejected} }.

export function classifyValidation(verdict) {
  const s = verdict?.summary ?? {};
  const total = Number(s.total ?? 0);
  if (total === 0) return { status: 'unverifiable', reason: 'no claims to evaluate' };
  const bad = Number(s.un_cited ?? 0) + Number(s.rejected ?? 0);
  const ratio = bad / total;
  if (ratio === 0) return { status: 'valid', reason: 'all claims evidenced' };
  if (ratio >= 1) return { status: 'invalid', reason: 'no claims evidenced' };
  return { status: 'partial', reason: `${bad}/${total} claims un-cited/rejected` };
}
