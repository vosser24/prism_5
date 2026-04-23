// PRISM KB Domain Classifier (v2.1.26 Phase 2.1)
//
// Deterministic rule-based classifier + keyword-centroid fallback.
// Maps each KB index entry to one of ~12 domains (or 'misc' catch-all).
// Pure functions — no I/O, no filesystem, no network. Easy to test.
//
// export DOMAINS                 -> ordered list of domain keys
// export DOMAIN_TITLES           -> {key: "PRISM-KB: <human title>"}
// export classifyEntry(entry)    -> {domain, confidence, reason}
// export summarize(entries)      -> {byDomain: {k: n}, lowConfidence: [...]}

export const DOMAINS = [
  'prism-core',
  'dev-languages',
  'dev-frameworks',
  'dev-testing-quality',
  'dev-debug-perf',
  'dev-infra-data',
  'dev-security',
  'design-ui',
  'content-creative',
  'ops-business-domain',
  'ai-agents-infra',
  'project-rules',
  'misc',
];

export const DOMAIN_TITLES = {
  'prism-core':         'PRISM-KB: prism-core',
  'dev-languages':      'PRISM-KB: dev-languages',
  'dev-frameworks':     'PRISM-KB: dev-frameworks',
  'dev-testing-quality':'PRISM-KB: dev-testing-quality',
  'dev-debug-perf':     'PRISM-KB: dev-debug-perf',
  'dev-infra-data':     'PRISM-KB: dev-infra-data',
  'dev-security':       'PRISM-KB: dev-security',
  'design-ui':          'PRISM-KB: design-ui',
  'content-creative':   'PRISM-KB: content-creative',
  'ops-business-domain':'PRISM-KB: ops-business',
  'ai-agents-infra':    'PRISM-KB: ai-agents-infra',
  'project-rules':      'PRISM-KB: project-rules',
  'misc':               'PRISM-KB: misc',
};

// Rule table: ordered. First strong match wins. score weights the confidence.
// Pattern applies to `${name} ${description}` lowercased.
const RULES = [
  // v2.2.0: rebrand — prism-* is the legacy prefix, prism-* is current.
  // Keep both matching so historical indexes and current installs both
  // classify correctly. Fixes P2.11 (command:prism-recall → misc).
  {domain: 'prism-core', score: 10, pattern: /\b(prism|prism)[-:]?(plan|discover|init|audit|health|roster|archive|recommend|retire|app-expert|update|router|kb|recall)\b/},
  {domain: 'prism-core', score: 9,  pattern: /\b(master-orchestrator|agent-factory|(prism|prism)-updater|claude-code-guide)\b/},
  {domain: 'prism-core', score: 9,  pattern: /\b(claude-code-expert|claude-md-improver|claude-md-management)\b/},
  {domain: 'prism-core', score: 7,  pattern: /\bexpert panel|expertise gap|agent roster|prism notice\b/},

  {domain: 'dev-security', score: 9, pattern: /\b(security-(review|reviewer|scan|bounty|hunter)|owasp|vulnerabilit|phi-compliance|hipaa|healthcare-phi|defi-amm|secrets-scan|agent-payment|llm-trading-agent-security|laravel-security|django-security|springboot-security|perl-security)\b/},

  {domain: 'dev-testing-quality', score: 9, pattern: /\b(tdd|test-driven|e2e|e2e-testing|playwright|santa-loop|santa-method|gan-(generator|evaluator|planner|style-harness|harness)|code-review(er)?|plankton|verification-loop|canary-watch|eval-harness|ai-regression-testing|codebase-onboarding|click-path-audit|verify|testing-patterns|python-testing|golang-testing|kotlin-testing|rust-testing|cpp-testing|csharp-testing|perl-testing|springboot-tdd|django-tdd|laravel-tdd|healthcare-eval-harness|skill-stocktake|skill-comply|skill-health|agent-eval|browser-qa|ui-demo)\b/},

  {domain: 'dev-debug-perf', score: 9, pattern: /\b(build-(error-)?resolver|build-resolver|cpp-build|go-build|rust-build|kotlin-build|java-build|flutter-build|gradle-build|pytorch-build|dart-build|performance-optimizer|refactor-cleaner|benchmark|agent-introspection|debugging|systematic-debug|strategic-compact|using-git-worktrees)\b/},

  {domain: 'dev-infra-data', score: 9, pattern: /\b(postgres|clickhouse|supabase|docker|deployment|database-migration|database-migrations|database-reviewer|postgres-patterns|docker-patterns|deployment-patterns|api-design|api-connector-builder|content-hash-cache|backend-patterns|kotlin-exposed|jpa-patterns|videodb|regex-vs-llm-structured-text|laravel-plugin-discovery|android-clean-architecture|pytorch-patterns|git-workflow|github-ops)\b/},

  {domain: 'dev-languages', score: 8, pattern: /\b(python-(reviewer|patterns|testing)|python-review|typescript-reviewer|typescript-review|golang-patterns|go-reviewer|go-review|go-test|rust-(reviewer|review|patterns|test)|kotlin-(reviewer|review|patterns|coroutines|testing|exposed|ktor)|kotlin-coroutines-flows|java-(reviewer|review|coding-standards)|csharp-reviewer|dotnet-patterns|flutter-reviewer|flutter-review|dart-flutter-patterns|cpp-(reviewer|review|coding-standards|testing)|perl-(patterns|testing|security)|swift(ui)?-patterns|swift-concurrency-6-2|swift-actor-persistence|swift-protocol-di-testing|foundation-models-on-device|bun-runtime|nodejs-keccak256|evm-token-decimals|kotlin-build-resolver)\b/},

  {domain: 'dev-frameworks', score: 8, pattern: /\b(react|nextjs|nextjs-turbopack|nuxt4-patterns|django-(patterns|verification|security)|springboot-(patterns|verification|security)|laravel-(patterns|verification|tdd|security|plugin-discovery)|nestjs-patterns|flutter-(reviewer|review|test|build|dart-code-review)|swiftui-patterns|compose-multiplatform-patterns|hexagonal-architecture|frontend-patterns|frontend-design|remotion|figma)\b/},

  {domain: 'ai-agents-infra', score: 9, pattern: /\b(claude-api|agent-(harness|eval|payment|introspection|sort)|autonomous-(loops|agent-harness|loop)|continuous-learning|continuous-agent-loop|mcp-server-patterns|loop-operator|harness-optimizer|gan-(style-)?harness|prompt-optim|prompt-optimizer|dmux-workflows|claude-devfleet|ralphinho-rfc-pipeline|enterprise-agent-ops|cost-aware-llm-pipeline|team-builder|iterative-retrieval|token-budget-advisor|context-budget|strategic-compact|blueprint|agentic-engineering|ai-first-engineering|agent-harness-construction)\b/},
  {domain: 'ai-agents-infra', score: 9, pattern: /\b(brainstorming|dispatching-parallel-agents|executing-plans|subagent-driven-development|using-superpowers|writing-plans|verification-before-completion|finishing-a-development-branch)\b/},
  {domain: 'ai-agents-infra', score: 9, pattern: /\b(council|nanoclaw-repl|openclaw-persona-forge|configure-ecc|safety-guard|gateguard|knowledge-ops|ck\b|claude-mem|knowledge-agent|mem-search|smart-explore|timeline-report|make-plan|claude-code-plugin-release|version-bump|do\b)/},
  {domain: 'ai-agents-infra', score: 8, pattern: /\b(hookify-rules|hookify|rules-distill|coding-standards|architecture-decision-records|code-tour|repo-scan|skill-(creator|health|comply|stocktake))\b/},

  {domain: 'design-ui', score: 9, pattern: /\b(ui[-/ ]?ux|ui-ux-pro-max|frontend-design|frontend-slides|liquid-glass|accessibility|design-system|create-design-system-rules|implement-design|code-connect-components|playground)\b/},

  {domain: 'content-creative', score: 9, pattern: /\b(video-production|video-editing|remotion-(video-creation|best-practices)|manim|article-writing|content-engine|brand-voice|crosspost|connections-optimizer|social-graph-ranker|investor-(outreach|materials)|lead-intelligence|market-research|ui-demo|visa-doc-translate|notebooklm|fal-ai-media|nutrient-document-processing|x-api)\b/},

  {domain: 'ops-business-domain', score: 9, pattern: /\b(customs-trade-compliance|logistics-exception-management|carrier-relationship-management|production-scheduling|inventory-demand-planning|returns-reverse-logistics|quality-nonconformance|energy-procurement|finance-billing-ops|customer-billing-ops|lead-intelligence|investor-outreach|investor-materials|customs|logistics|billing-ops|competitive-intelligence-specialist|demand-forecasting-specialist|greek-ecommerce-seo-specialist|healthcare-reviewer|healthcare-emr-patterns|healthcare-cdss-patterns|product-lens|product-capability)\b/},
  {domain: 'ops-business-domain', score: 8, pattern: /\b(seo\b|jira-integration|email-ops|messages-ops|google-workspace-ops|project-flow-ops|unified-notifications-ops|automation-audit-ops|ecc-tools-cost-audit|workspace-surface-audit|terminal-ops|research-ops|deep-research|exa-search|opensource-pipeline|opensource-forker|opensource-packager|opensource-sanitizer|search-first|dashboard-builder)\b/},
];

const CENTROIDS = {
  'prism-core':         ['prism','plan','orchestrator','agent-factory','panel','expertise','discover','kb','router','health'],
  'dev-languages':      ['python','typescript','javascript','go','golang','rust','kotlin','java','swift','dart','perl','cpp','ruby','ownership','coroutine','async','generics','idiomatic'],
  'dev-frameworks':     ['react','nextjs','nuxt','vite','django','rails','spring','laravel','nestjs','flutter','swiftui','compose','hono','remotion','figma','component','widget'],
  'dev-testing-quality':['test','tests','tdd','coverage','pytest','junit','jest','playwright','fixtures','mocks','fuzzing','benchmark','verification','review'],
  'dev-debug-perf':     ['debug','debugging','profiling','bottleneck','optimize','latency','memory','leak','bundle','render','allocation','flamegraph','traces'],
  'dev-infra-data':     ['postgres','sql','schema','migration','docker','compose','deploy','supabase','clickhouse','kafka','pipeline','index','partition'],
  'dev-security':       ['security','vulnerability','owasp','csrf','xss','injection','cve','secrets','crypto','auth','authn','authz','sandbox','audit','phi','hipaa'],
  'design-ui':          ['design','accessibility','wcag','palette','typography','token','component','glass','bento','figma','layout'],
  'content-creative':   ['video','remotion','manim','podcast','article','blog','post','brand','voice','crosspost','slide','deck','marketing','promo'],
  'ops-business-domain':['inventory','forecast','demand','supply','logistics','customs','tariff','billing','refund','carrier','warehouse','erp','production','scheduling','seo'],
  'ai-agents-infra':    ['agent','agents','harness','tool','tools','loop','orchestrator','subagent','mcp','anthropic','openai','rag','embedding','retrieval','prompt','caching'],
  'project-rules':      ['rule','rules','standards','convention','policy','guideline'],
};

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

function centroidScore(entryKws, centroid) {
  if (!entryKws || !entryKws.length) return 0;
  const es = new Set(entryKws);
  let hits = 0;
  for (const k of centroid) if (es.has(k)) hits++;
  return hits / Math.max(1, Math.min(entryKws.length, centroid.length));
}

export function classifyEntry(entry) {
  if (!entry) return {domain: 'misc', confidence: 0, reason: 'null entry'};

  if (entry.type === 'rule') {
    return {domain: 'project-rules', confidence: 1.0, reason: 'type=rule'};
  }

  const hay = `${entry.name || ''} ${entry.description || ''}`.toLowerCase();

  for (const r of RULES) {
    if (r.pattern.test(hay)) {
      return {
        domain: r.domain,
        confidence: Math.min(1.0, r.score / 10),
        reason: `rule:${r.domain}`,
      };
    }
  }

  const kws = Array.isArray(entry.keywords_top10) ? entry.keywords_top10 : tokenize(hay).slice(0, 10);
  let best = null;
  for (const [dom, kwList] of Object.entries(CENTROIDS)) {
    const s = centroidScore(kws, kwList);
    if (!best || s > best.score) best = {domain: dom, score: s};
  }
  if (best && best.score >= 0.25) {
    return {domain: best.domain, confidence: best.score, reason: `centroid:${best.domain}:${best.score.toFixed(2)}`};
  }

  if (entry.type === 'agent') {
    return {domain: 'prism-core', confidence: 0.3, reason: 'fallback:agent->prism-core'};
  }

  return {domain: 'misc', confidence: 0, reason: 'no-match'};
}

export function summarize(entries) {
  const byDomain = {};
  const lowConfidence = [];
  for (const e of entries || []) {
    const d = e.domain || 'misc';
    byDomain[d] = (byDomain[d] || 0) + 1;
    if ((e.domain_confidence || 0) < 0.3 && d !== 'project-rules') {
      lowConfidence.push({id: e.id, name: e.name, domain: d, reason: e.domain_reason});
    }
  }
  return {byDomain, lowConfidence};
}
