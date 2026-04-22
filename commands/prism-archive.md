---
name: atlas-archive
description: Consolidate agent learnings into RAG-queryable sources
---

Persistence + RAG for agent knowledge:

Every agent query saves its answer as a NOTE in the agent's notebook
(via --save-as-note flag, automatic). Over time, each agent builds up
dozens of notes.

/prism-archive consolidates those notes into a single source document
and adds it to the notebook as a NEW source. This makes the accumulated
learnings RAG-queryable — future agent queries can ground answers in
both original research sources AND consolidated past learnings.

USAGE:
  /prism-archive                    → consolidate all agents with >=5 notes
  /prism-archive @agent-name        → consolidate specific agent's notes
  /prism-archive --list             → show which agents have notes pending
  /prism-archive --threshold 10     → only consolidate agents with 10+ notes

PROTOCOL:

1. Read roster.json, find agents with notebooklm_notebook_id set.

2. For each agent (or the specified one):
   a. Run: notebooklm use <notebook_id>
   b. Run: notebooklm note list --json
      Parse notes that have been accumulating since last archive.
   
3. Filter notes:
   - Only include notes created by agents (title starts with "@<agent>:")
   - Exclude notes already consolidated (tracked in archive-log.json)
   - Require minimum threshold (default: 5 notes per agent)

4. For each agent with enough notes:
   a. Read note contents via: notebooklm note read <note-id> for each
   b. Build a consolidated markdown document:
      
      # {agent-name} — Learnings Archive {YYYY-MM-DD}
      
      Covering {N} research queries from {date-range}.
      
      ## {topic-1}
      Q: {question}
      A: {answer}
      
      ## {topic-2}
      ...
   
   c. Write to: ~/.claude/agents/{name}/archives/{YYYY-MM-DD}.md
   
   d. Add as source: notebooklm source add <path-to-archive>.md --notebook <id>
      This makes the consolidated learnings part of the RAG index.
   
   e. Update archive-log.json with:
      - agent_name
      - archive_date
      - notes_consolidated
      - source_id (returned by source add)

5. Optional cleanup (if --cleanup flag):
   - Delete original notes now that they're consolidated into a source
   - Notes remain visible in NotebookLM UI for audit trail

6. Report:
   "Archived {N} learnings from @{agent}. 
    Future queries to this agent will RAG over:
      · {original-sources-count} research sources
      · {archive-count} consolidated learning archives
    Total knowledge in notebook: {total} sources."

WHY THIS MATTERS:

Without /prism-archive:
  · Every agent query answer accumulates as ephemeral notes
  · Notes are NOT in the RAG index
  · Agent cannot build on past answers when answering new questions
  · Knowledge exists but is not compounding

With /prism-archive:
  · Notes periodically get promoted to queryable sources
  · Agent's RAG index grows with its accumulated experience
  · New queries benefit from synthesized past learnings
  · True knowledge compounding over weeks/months

WHEN TO RUN:
  · Weekly (quick check on active agents)
  · After major project completion (capture project learnings)
  · Before retiring an agent (preserve what it learned)
  · When roster.json shows high task counts on specific agents

NOT TO BE CONFUSED WITH:
  · /prism-retire (archives the AGENT itself)
  · /prism-update (runs scheduled system updates)
  This command archives LEARNINGS, not agents.
