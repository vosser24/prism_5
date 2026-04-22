# ATLAS Monitor

Live dashboard for Claude Code sessions with ATLAS system awareness.

Reads Claude Code's JSONL session logs directly — no API calls, no cost — and
surfaces token usage, cost, model mix, agent activity, MCP calls, context
health, and task progress.

## Install

```bash
pip install rich
```

No install needed beyond that — all files live under `~/.claude/tools/atlas-monitor/`.

## Usage

From any directory:

```bash
python ~/.claude/tools/prism-monitor/prism-monitor.py           # live dashboard
python ~/.claude/tools/prism-monitor/prism-monitor.py --once    # one-shot render
python ~/.claude/tools/prism-monitor/prism-monitor.py --daily   # daily summary
python ~/.claude/tools/prism-monitor/prism-monitor.py --agents  # agent roster
python ~/.claude/tools/prism-monitor/prism-monitor.py --mcps    # MCP usage
python ~/.claude/tools/prism-monitor/prism-monitor.py --costs   # cost breakdown
python ~/.claude/tools/prism-monitor/prism-monitor.py --export  # export as JSON
```

Optional flags:

```
--plan pro|max5|max20     # token limit for progress bar (default: max20)
--once                    # render once, don't loop
```

## Recommended alias

Add to `~/.bashrc`:

```bash
alias atlas='python ~/.claude/tools/prism-monitor/prism-monitor.py'
```

Then just: `atlas`, `atlas --agents`, `atlas --daily`, etc.

## Files

| File | Purpose |
|------|---------|
| `atlas-monitor.py` | CLI entry point |
| `config.py` | Paths, pricing, plan limits, color scheme |
| `data_reader.py` | JSONL parsing, roster/todo reading |
| `metrics.py` | Token/cost/depth/context calculations |
| `dashboard.py` | Rich live dashboard layout |
| `views.py` | Alternative views (daily/agents/mcps/costs) |

## What it reads

- `~/.claude/projects/*/*.jsonl` — session logs (auto-detects current project)
- `~/.claude/agents/_meta/roster.json` — ATLAS agent registry
- `tasks/todo.md` — current project execution plan
- `.claude/references/*-index.md` — project intelligence indexes

All reads are defensive — missing files just skip that section.

## Exit logging

On exit (Ctrl+C or after `--once`), appends one JSONL summary line to
`~/.claude/logs/monitor-daily.jsonl` for trend tracking:

```json
{
  "date": "2026-04-11",
  "session_duration_min": 47.2,
  "total_tokens": 83686,
  "estimated_cost": 1.23,
  "turns": 41,
  "agents_used": [...],
  "model_distribution": {"opus": 0.08, "sonnet": 0.87, "haiku": 0.05}
}
```

## Pricing used

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|-----------|-------------|
| Opus 4.6 | $5 | $25 | $0.50 | $6.25 |
| Sonnet 4.6 | $3 | $15 | $0.30 | $3.75 |
| Haiku 4.5 | $1 | $5 | $0.10 | $1.25 |

(per million tokens; cache_read = 10% of input; cache_write = 125% of input)

## Notes

- Context % is a rough turn-count heuristic — Claude Code doesn't expose
  actual window usage to outside tools. Adjust if your sessions run longer
  or shorter than the default assumption.
- Depth gate counts are pattern-matched from user prompts (DIRECT/LIGHTWEIGHT/
  FULL/DISCOVERY), mirroring `skill-rules.json`.
- Session identification = most recently modified JSONL in the current
  project's directory.
- Refresh cadence: 3 seconds.
- Windows-native paths throughout (pathlib).
