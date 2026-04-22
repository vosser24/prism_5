#!/usr/bin/env python
"""ATLAS Monitor — live dashboard for Claude Code sessions.

Usage:
  python atlas-monitor.py              # live dashboard (default)
  python atlas-monitor.py --daily      # daily summary
  python atlas-monitor.py --agents     # agent roster
  python atlas-monitor.py --mcps       # MCP usage
  python atlas-monitor.py --costs      # cost breakdown
  python atlas-monitor.py --export     # export today as JSON
  python atlas-monitor.py --plan max5  # override plan (pro/max5/max20)
  python atlas-monitor.py --once       # render once, don't loop
"""
from __future__ import annotations
import sys
import time
import argparse
import json
import os
from pathlib import Path

# Force UTF-8 output on Windows (handles emoji rendering under cp1253 etc.)
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# Make sibling modules importable when running as a script
sys.path.insert(0, str(Path(__file__).parent))

from rich.console import Console
from rich.live import Live

from config import DEFAULT_PLAN, REFRESH_SECONDS, MONITOR_LOG, LOG_DIR
from dashboard import render_dashboard
from views import daily_view, agents_view, mcps_view, costs_view, export_json
from metrics import compute_session_metrics
from data_reader import current_session_file, project_dir_for_cwd


def _log_exit_summary() -> None:
    """Append a one-line summary to ~/.claude/logs/monitor-daily.jsonl."""
    try:
        proj = project_dir_for_cwd()
        session = current_session_file(proj)
        if not session:
            return
        m = compute_session_metrics(session)
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        entry = {
            "date": (m["first_ts"] or session.stat()).strftime("%Y-%m-%d") if m["first_ts"]
                    else time.strftime("%Y-%m-%d"),
            "session_file": session.name,
            "session_duration_min": round(m["duration_min"], 1),
            "total_tokens": m["total_tokens"],
            "estimated_cost": round(m["cost"], 4),
            "turns": m["turns"],
            "agents_used": list(m["agent_calls"].keys()),
            "mcp_calls": sum(v["calls"] for v in m["mcp_calls"].values()),
            "model_distribution": {k: round(v, 3) for k, v in m["model_mix"].items()},
        }
        with open(MONITOR_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Never crash on exit


def _live_dashboard(plan: str) -> None:
    console = Console()
    try:
        with Live(render_dashboard(plan), console=console,
                  refresh_per_second=1 / REFRESH_SECONDS,
                  screen=False) as live:
            while True:
                time.sleep(REFRESH_SECONDS)
                live.update(render_dashboard(plan))
    except KeyboardInterrupt:
        console.print("[dim]Exiting…[/]")
    finally:
        _log_exit_summary()


def main() -> int:
    p = argparse.ArgumentParser(prog="atlas-monitor", description=__doc__)
    group = p.add_mutually_exclusive_group()
    group.add_argument("--daily", action="store_true", help="daily summary table")
    group.add_argument("--agents", action="store_true", help="agent roster detail")
    group.add_argument("--mcps", action="store_true", help="MCP usage detail")
    group.add_argument("--costs", action="store_true", help="cost breakdown by model")
    group.add_argument("--export", action="store_true", help="export today as JSON to stdout")
    p.add_argument("--plan", default=DEFAULT_PLAN, choices=["pro", "max5", "max20"],
                   help="plan token limit (default: max20)")
    p.add_argument("--once", action="store_true", help="render dashboard once, don't loop")
    args = p.parse_args()

    console = Console()

    # Banner
    from datetime import datetime
    console.print(
        f"[bold blue]⚡ ATLAS Monitor[/]  "
        f"[dim]v1.0  |  {datetime.now().strftime('%Y-%m-%d %H:%M')}  "
        f"|  project: {Path.cwd().name}[/]"
    )

    try:
        if args.daily:
            console.print(daily_view())
        elif args.agents:
            console.print(agents_view())
        elif args.mcps:
            console.print(mcps_view())
        elif args.costs:
            console.print(costs_view())
        elif args.export:
            data = export_json()
            console.print_json(json.dumps(data, default=str))
        elif args.once:
            console.print(render_dashboard(args.plan))
            _log_exit_summary()
        else:
            _live_dashboard(args.plan)
    except Exception as e:
        console.print(f"[red]Error:[/] {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
