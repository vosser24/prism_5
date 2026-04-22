# Skill Research Effectiveness Ledger

Tracks @agent-factory --skill-research recommendations and outcomes.

## Scoring rubric (0-7)

FIT (0-3):     Direct=3, Close=2, Adjacent=1, Stretch=0
MATURITY (0-2): 10k+ stars AND <30d commits=2, 1-10k or <90d=1, else=0
INSTALL (0-1): Single command=1, multi-step=0
LICENSE (0-1): MIT/Apache/BSD/ISC=1, restrictive/unclear=0

Cutoff: 3/7. Present top 3 above cutoff.

## Auto-promotion (ALL required)
- 3+ different intent contexts
- 2+ installs
- 14+ days since first rec
- Score > 5/7
- Permissive license
- Last commit < 90 days

Demotion: 3+ consecutive declines, same-need re-ask within 7 days after install,
flagged by /prism-audit, manual removal.

---

## Log Entries

<!-- Template:
### YYYY-MM-DD
**Need (verbatim):** "..."
**Detected via:** intent-hook | orchestrator | explicit
**Research tier:** 0 | 1 | 2 | 3
**Cost:** $X.XX
**Candidates scored:**
  - name1 (repo): Fit X/3, Maturity X/2, Install X/1, License X/1 = X/7
**Recommended:** {name}
**User chose:** {name | declined | deferred}
**Install command:** {command}
**Follow-up status:** pending | success | failure
**Notes:** ...
-->


---

## Promotion Candidates
*(Auto-populated as entries accumulate.)*


---

## Deprecated Entries
*(Logged when registry entry rotates out due to dying tool.)*


---

## Template Leaderboard
*(Running stats per intent category.)*


---

## Weekly Tool Health Check Results
*(Scheduled checks on registry entries.)*


---

## Meta-learning notes
*(Patterns observed over time that might refine the rubric.)*
