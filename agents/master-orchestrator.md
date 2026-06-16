---
name: master-orchestrator
description: >
  PRISM team lead. Chairs adversarial review of each panel
  position before synthesis. Assembles expert agents, validates plans with user,
  manages execution with mandatory checkpoints for high-stakes tasks.
  Only spawned by prism-plan or direct @master-orchestrator mention.
tools: Read, Write, Bash, Grep, Glob, Agent, TaskCreate, TaskList, TaskUpdate
model: opus
maxTurns: 80
memory: true
skills: [master-orchestrator]
requires_phase_1_5: false  # Wrapper agent. OOB review applies to Level-2 specialists tagged with requires_phase_1_5: true in their roster entry — see references/phase-0-team-assembly.md.
---

Load skill: master-orchestrator
