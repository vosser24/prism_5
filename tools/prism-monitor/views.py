"""Alternative views for PRISM monitor: --daily, --agents, --mcps, --costs."""
from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

from rich.table import Table
from rich.console import Console
from rich.panel import Panel

from config import PRICING, CACHE_READ_MULT, CACHE_WRITE_MULT, COLORS, classify_model
from metrics import compute_session_metrics, roster_summary
from data_reader import find_session_files, iter_jsonl, parse_ts


def _fmt_num(n: float) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return f"{n:.0f}"


def daily_view() -> Table:
    """Per-day aggregation across all session files."""
    all_files = find_session_files()
    by_day: dict[str, dict] = defaultdict(lambda: {
        "tokens": 0, "cost": 0.0, "sessions": 0, "turns": 0,
        "agents": set(), "mcps": 0
    })
    for f in all_files:
        try:
            m = compute_session_metrics(f)
        except Exception:
            continue
        day = (m["first_ts"] or datetime.fromtimestamp(f.stat().st_mtime)).strftime("%Y-%m-%d")
        bucket = by_day[day]
        bucket["tokens"] += m["total_tokens"]
        bucket["cost"] += m["cost"]
        bucket["sessions"] += 1
        bucket["turns"] += m["turns"]
        bucket["mcps"] += sum(v["calls"] for v in m["mcp_calls"].values())
        for a in m["agent_calls"]:
            bucket["agents"].add(a)

    table = Table(title="PRISM — Daily Summary", show_lines=False)
    table.add_column("Date", style="cyan")
    table.add_column("Sessions", justify="right")
    table.add_column("Tokens", justify="right")
    table.add_column("Cost", justify="right", style="green")
    table.add_column("Agents", justify="right")
    table.add_column("MCPs", justify="right")
    table.add_column("Turns", justify="right")

    days = sorted(by_day.keys(), reverse=True)[:14]
    for d in days:
        b = by_day[d]
        table.add_row(
            d, str(b["sessions"]), _fmt_num(b["tokens"]),
            f"${b['cost']:.2f}", str(len(b["agents"])),
            str(b["mcps"]), str(b["turns"]),
        )

    if days:
        avg_tok = sum(by_day[d]["tokens"] for d in days) / len(days)
        avg_cost = sum(by_day[d]["cost"] for d in days) / len(days)
        table.add_section()
        table.add_row(
            "Avg", "—", _fmt_num(avg_tok), f"${avg_cost:.2f}", "—", "—", "—",
            style="bold"
        )
    return table


def agents_view() -> Table | Panel:
    """Per-agent usage breakdown."""
    roster = roster_summary()
    agents = roster["agents"]
    if not agents:
        return Panel(
            "[yellow]No agents in the PRISM roster yet.[/]\n\n"
            "[dim]Agents are created on-demand by @agent-factory when the "
            "master-orchestrator assembles a team. Run a FULL ORCHESTRATION task "
            "to populate the roster.[/]",
            title="[bold blue]PRISM — Agent Roster[/]",
            border_style="blue",
        )

    table = Table(title="PRISM — Agent Roster")
    table.add_column("Agent", style="cyan")
    table.add_column("Model")
    table.add_column("Tasks", justify="right")
    table.add_column("Corrections", justify="right")
    table.add_column("Projects", justify="right")
    table.add_column("Version", justify="right")
    table.add_column("Status")

    for name, data in sorted(agents.items()):
        corrections = data.get("total_corrections_received", 0)
        corr_style = "yellow" if corrections >= 3 else ""
        status = data.get("status", "available")
        status_style = {
            "available": "green", "active": "cyan", "upgrade_needed": "yellow"
        }.get(status, "")
        table.add_row(
            f"@{name}",
            data.get("default_model", "sonnet"),
            str(data.get("total_tasks_completed", 0)),
            f"[{corr_style}]{corrections}" + (" ⚠" if corrections >= 3 else "") + "[/]",
            str(len(data.get("projects_worked", []))),
            str(data.get("version", 1)),
            f"[{status_style}]{status}[/]",
        )
    return table


def mcps_view() -> Table:
    """MCP server usage breakdown from latest session."""
    files = find_session_files()
    if not files:
        return Table(title="PRISM — No sessions found")
    m = compute_session_metrics(files[0])

    by_server: dict[str, dict] = defaultdict(lambda: {"tools": {}, "calls": 0, "tokens": 0})
    for key, val in m["mcp_calls"].items():
        if "::" in key:
            server, tool = key.split("::", 1)
        else:
            server, tool = key, "?"
        b = by_server[server]
        b["tools"][tool] = b["tools"].get(tool, {"calls": 0, "tokens": 0})
        b["tools"][tool]["calls"] += val["calls"]
        b["tools"][tool]["tokens"] += val["tokens"]
        b["calls"] += val["calls"]
        b["tokens"] += val["tokens"]

    table = Table(title="PRISM — MCP Usage (current session)")
    table.add_column("Server", style="cyan")
    table.add_column("Tool")
    table.add_column("Calls", justify="right")
    table.add_column("Tokens", justify="right")
    table.add_column("Avg/Call", justify="right")

    total_calls = 0
    total_tokens = 0
    for server in sorted(by_server.keys()):
        for tool, t in sorted(by_server[server]["tools"].items(), key=lambda x: -x[1]["calls"]):
            avg = t["tokens"] / t["calls"] if t["calls"] else 0
            warn = " ⚠" if avg > 4000 else ""
            table.add_row(server, tool, str(t["calls"]), _fmt_num(t["tokens"]),
                          f"{avg:.0f}{warn}")
            total_calls += t["calls"]
            total_tokens += t["tokens"]
    if total_calls:
        table.add_section()
        avg = total_tokens / total_calls
        table.add_row("TOTAL", "", str(total_calls), _fmt_num(total_tokens),
                      f"{avg:.0f}", style="bold")
    return table


def costs_view() -> Table:
    """Cost breakdown by model for the current session."""
    files = find_session_files()
    if not files:
        return Table(title="PRISM — No sessions found")
    m = compute_session_metrics(files[0])

    table = Table(title="PRISM — Cost Breakdown")
    table.add_column("Model", style="cyan")
    table.add_column("Calls", justify="right")
    table.add_column("Input", justify="right")
    table.add_column("Output", justify="right")
    table.add_column("Cache R", justify="right")
    table.add_column("Cache W", justify="right")
    table.add_column("Cost", justify="right", style="green")

    total = 0.0
    for family, b in sorted(m["by_model"].items()):
        cost = m["model_costs"].get(family, 0.0)
        total += cost
        table.add_row(
            family.title(),
            str(b["calls"]),
            _fmt_num(b["input"]),
            _fmt_num(b["output"]),
            _fmt_num(b["cache_read"]),
            _fmt_num(b["cache_write"]),
            f"${cost:.4f}",
        )
    table.add_section()
    table.add_row("TOTAL", "", "", "", "", "", f"${total:.4f}", style="bold")
    return table


def export_json(path: Path | None = None) -> dict:
    """Export today's data as JSON."""
    import json
    files = find_session_files()
    today = datetime.now().strftime("%Y-%m-%d")
    data = {"date": today, "sessions": []}
    for f in files:
        m = compute_session_metrics(f)
        if m["first_ts"] and m["first_ts"].strftime("%Y-%m-%d") == today:
            data["sessions"].append({
                "file": f.name,
                "tokens": m["total_tokens"],
                "cost": round(m["cost"], 4),
                "turns": m["turns"],
                "model_mix": m["model_mix"],
                "mcp_calls": sum(v["calls"] for v in m["mcp_calls"].values()),
            })
    data["totals"] = {
        "sessions": len(data["sessions"]),
        "tokens": sum(s["tokens"] for s in data["sessions"]),
        "cost": sum(s["cost"] for s in data["sessions"]),
    }
    if path:
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data
