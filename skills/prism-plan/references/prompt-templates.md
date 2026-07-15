# NotebookLM Prompt Templates
# Used by @agent-factory for three-tier research
# This file EVOLVES — factory appends new templates after successful agent creation

## HOW TO USE TEMPLATES
1. Find the closest matching domain template below
2. If exact match: adapt Q1-Q5 with specific context
3. If partial match: BLEND 2 templates (take relevant Qs from each)
4. If no match: write custom Q1-Q5 following the pattern, then SAVE as new template
5. NEVER send generic questions — always inject project context, tech stack, constraints

## Template: Technical Implementation
Use for: coding, architecture, infrastructure, DevOps, tooling
Q1: Production-grade architecture for {tech} in {context}. Components, data flow, trade-offs.
Q2: Top libraries/frameworks — compare by maturity, performance, compatibility with {stack}.
Q3: Implementation patterns: init, config, error handling, testing, deployment. Code examples.
Q4: Production failure modes, scaling limits, security vulnerabilities, operational gotchas.
Q5: Performance benchmarks and optimization techniques at our scale ({volume, users}).

## Template: Analytical/Data
Use for: statistics, ML, data science, forecasting, modeling
Q1: Compare methodologies {A} vs {B} vs {C} for {data description} with {constraints}.
Q2: Deep dive on {best method}: formulation, assumptions, violation diagnostics.
Q3: Python pipeline using {libraries}: data prep → model → validation → visualization.
Q4: Validation: statistical tests, business sense checks, baselines. "Good enough" criteria.
Q5: Presenting results to {audience}: key visualizations, narrative structure, caveats.

## Template: Business/Strategy
Use for: market analysis, competitive intelligence, business planning, pricing
Q1: Current landscape of {industry} in {market/geography}: players, trends, regulation.
Q2: Proven strategies and case studies for {problem} in {similar companies/markets}.
Q3: Financial modeling: key variables, sensitivity analysis, scenario planning.
Q4: Risk assessment: probability, impact, mitigation for {strategy}. Market-specific risks.
Q5: Implementation roadmap: phases, milestones, resource requirements, success metrics.

## Template: Legal/Contract
Use for: contracts, compliance, regulatory, GDPR, licensing
Q1: Legal framework for {contract type} in {jurisdiction}. Key regulations, recent changes.
Q2: Clause-by-clause best practices: what to include, avoid, negotiate.
Q3: Risk analysis: liability exposure, indemnification, termination, dispute resolution.
Q4: Compliance requirements for {industry} in {jurisdiction}: data protection, certifications.
Q5: Negotiation strategy: market standard vs negotiable. Benchmarks for {value range}.

## Template: Marketing/SEO/Content
Use for: SEO, content strategy, digital marketing, social media, CRM, email marketing
Q1: Current best practices for {marketing domain} in {industry/market} as of 2026.
Q2: Tools and platforms for {marketing task}: compare top 3-5 by features, pricing, ROI.
Q3: Implementation: setup, configuration, tracking, attribution models for {channel}.
Q4: Measurement: KPIs, benchmarks, A/B testing methodology, reporting for {audience}.
Q5: Common mistakes and anti-patterns in {marketing domain}. What experienced practitioners avoid.

## Template: Design/UX
Use for: UI design, UX research, accessibility, design systems, prototyping
Q1: Current design patterns and conventions for {product type} in {industry} as of 2026.
Q2: UX research methods for {context}: user interviews, A/B testing, heuristic evaluation.
Q3: Design system components needed for {product}: typography, color, spacing, components.
Q4: Accessibility requirements (WCAG 2.2) for {product type} in {jurisdiction/market}.
Q5: Tools and workflow: Figma patterns, handoff to developers, design tokens for {stack}.

## Template: Operations/Supply Chain
Use for: logistics, warehouse, replenishment, procurement, demand planning
Q1: Operational best practices for {process} in {industry/market}: proven frameworks.
Q2: Technology stack for {operations domain}: ERP integration, automation, IoT, WMS.
Q3: Optimization models: {specific problem} — mathematical formulation, constraints, solvers.
Q4: KPIs and benchmarks for {operations domain} in {industry}. Monitoring and alerting.
Q5: Common failure modes: stockouts, bullwhip effect, supplier risks. Mitigation strategies.

## Template: Finance/Accounting
Use for: financial analysis, budgeting, forecasting, reporting, tax, audit
Q1: Financial analysis framework for {decision type} in {industry}: methods, standards.
Q2: Modeling: {financial model type} with {variables}. Sensitivity analysis, scenarios.
Q3: Reporting requirements in {jurisdiction}: standards (IFRS/GAAP), regulatory obligations.
Q4: Tools for {financial task}: Excel models vs Python vs BI platforms. When to use each.
Q5: Audit and control: internal controls, risk indicators, compliance checks for {domain}.

## Template: Product Management
Use for: product strategy, roadmapping, feature prioritization, user research, go-to-market
Q1: Product strategy frameworks for {product type} in {market}: prioritization, discovery.
Q2: User research methods for {context}: jobs-to-be-done, surveys, analytics-driven insights.
Q3: Roadmap planning: quarterly planning, stakeholder alignment, dependency management.
Q4: Metrics: north star metric, feature adoption, retention, engagement for {product type}.
Q5: Go-to-market: launch playbook, beta testing, rollout strategy, feedback loops.

## Template: Security/Compliance
Use for: cybersecurity, penetration testing, secure coding, compliance frameworks
Q1: Security architecture for {system type}: threat model, attack surfaces, defense layers.
Q2: Compliance frameworks applicable to {industry} in {jurisdiction}: SOC2, ISO27001, GDPR.
Q3: Secure coding practices for {stack}: OWASP top 10, input validation, auth patterns.
Q4: Testing methodology: SAST, DAST, penetration testing tools and procedures for {stack}.
Q5: Incident response: playbook structure, escalation, communication, post-mortem for {org type}.

## Template: DevOps/Infrastructure
Use for: CI/CD, cloud architecture, containerization, monitoring, IaC
Q1: Infrastructure architecture for {workload} on {cloud/on-prem}: components, scaling, cost.
Q2: CI/CD pipeline design for {stack}: tools, stages, quality gates, deployment strategies.
Q3: Containerization and orchestration: Docker, Kubernetes patterns for {workload type}.
Q4: Monitoring and observability: metrics, logging, tracing, alerting for {system type}.
Q5: Cost optimization: right-sizing, reserved capacity, spot instances, FinOps for {cloud}.

---

## Quality Scoring (after each NotebookLM response)
RELEVANCE (0-2): addresses our specific context?
DEPTH (0-2): expert-level with edge cases?
ACTIONABLE (0-2): could build from this today?
CURRENT (0-1): references 2025-2026 practices?
>= 5: PASS | 3-4: follow-up prompt (free) | < 3: Tier 2 Opus

## Template Evolution Rules
After EVERY agent creation, the factory MUST:
1. Review which template was used and how it was adapted
2. If a NEW domain was created (custom Q1-Q5, no template matched):
   → APPEND a new ## Template: {Domain} section to this file
   → Include the Q1-Q5 that worked (scored 5+/7)
3. If an existing template was ADAPTED with better questions:
   → APPEND a ### Variant: {specific use case} subsection
   → Example: "### Variant: Greek e-commerce SEO" under Marketing/SEO
4. If questions scored poorly (<3/7) and needed Tier 2 rescue:
   → Note what was weak in a ### Lessons subsection
   → Improve the template wording for next time
5. Log all template changes to prompt-effectiveness.md
