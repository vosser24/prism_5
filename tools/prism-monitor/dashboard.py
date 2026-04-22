"""Rich live dashboard layout."""
from __future__ import annotations
from datetime import datetime
from pathlib import Path

from rich.console import Console, Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.progress import Progress, BarColumn, TextColumn
from rich.columns import Columns

from config import (PLAN_LIMITS, DEFAULT_PLAN, COLORS, CTX_HEALTHY,
                    CTX_WARNING, CTX_CRITICAL)
from metrics import (compute_session_metrics, context_percent, context_health,
                     parse_todo_progress, roster_summary)
from data_reader import (current_session_file, project_dir_for_cwd,
                          list_references)


def _bar(pct: float, width: int = 16, fill: str = "█", empty: str = "░") -> str:
    pct = max(0.0, min(100.0, pct))
    filled = int(round(width * pct / 100.0))
    return f"{fill * filled}{empty * (width - filled)}"


def _fmt_num(n: float) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return f"{n:.0f}"


def _color_for_pct(pct: float) -> str:
    if pct < CTX_HEALTHY:  return "green"
    if pct < CTX_WARNING:  return "yellow"
    if pct < CTX_CRITICAL: return "orange1"
    return "red"


def render_dashboard(plan: str = DEFAULT_PLAN) -> Panel:
    """Build the Rich panel that makes up the dashboard."""
    proj_dir = project_dir_for_cwd()
    session_file = current_session_file(proj_dir)

    if not session_file:
        return Panel(
            Text("No active Claude Code session detected.\n"
                 f"Looked in: {proj_dir or 'all projects'}",
                 style="yellow"),
            title="[bold blue]ATLAS Monitor[/]",
            border_style="blue"
        )

    m = compute_session_metrics(session_file)
    progress = parse_todo_progress()
    roster = roster_summary()
    refs = list_references()

    # ── Header: session file + plan ──
    header = Text.assemble(
        ("📋 ", ""),
        (f"Session: {session_file.name[:32]}  ", "dim"),
        ("| Plan: ", "dim"),
        (plan.upper(), "bold cyan"),
        ("  | Project: ", "dim"),
        (Path.cwd().name, "bold"),
    )

    # ── Token progress (fresh tokens = what counts against plan limit) ──
    limit = PLAN_LIMITS.get(plan, PLAN_LIMITS[DEFAULT_PLAN])
    token_pct = 100.0 * m["fresh_tokens"] / limit if limit else 0.0
    token_color = _color_for_pct(token_pct)
    token_line = Text.assemble(
        ("🎯 Fresh Tokens: ", ""),
        (f"{_fmt_num(m['fresh_tokens'])} / {_fmt_num(limit)}  ", "bold"),
        (f"[{_bar(token_pct)}] ", token_color),
        (f"{token_pct:.0f}%", token_color),
    )
    breakdown = Text(
        f"   In: {_fmt_num(m['total_input'])}  "
        f"Out: {_fmt_num(m['total_output'])}  "
        f"CacheR: {_fmt_num(m['cache_read'])}  "
        f"CacheW: {_fmt_num(m['cache_write'])}  "
        f"(total: {_fmt_num(m['total_tokens'])})",
        style="dim"
    )

    # ── Turns ──
    avg = m["total_tokens"] / m["turns"] if m["turns"] else 0
    turns_line = Text(
        f"💬 Turns: {m['turns']} (avg {_fmt_num(avg)} tokens/turn)",
        style=""
    )

    # ── Cost ──
    cost_line = Text.assemble(
        ("💰 Est. Cost: ", ""),
        (f"${m['cost']:.2f}   ", "bold green"),
        *[
            Text.assemble(
                (f"{fam.title()}: ${cost:.2f}  ", COLORS.get(fam, "white"))
            ).append_text(Text(""))
            for fam, cost in m["model_costs"].items() if cost > 0
        ][:3] if m["model_costs"] else [Text("")]
    )

    # ── Burn rate ──
    burn_icon = "🚀" if m["burn_rate"] > 1000 else "🔥"
    burn_line = Text(
        f"{burn_icon} Burn Rate: {m['burn_rate']:.0f} tokens/min   "
        f"💵 Cost Rate: ${m['cost_rate']:.4f}/min",
        style="yellow"
    )

    # ── Model mix ──
    mix_parts = []
    for fam, pct in sorted(m["model_mix"].items(), key=lambda x: -x[1]):
        c = COLORS.get(fam, "white")
        mix_parts.append(Text.assemble(
            (f"{fam.title()} ", c),
            (f"{pct*100:.0f}%  ", c),
        ))
    mix_line = Text("🤖 Model Mix: ")
    for p in mix_parts:
        mix_line.append_text(p)
    if not mix_parts:
        mix_line.append(" (no data)", style="dim")

    # ── ATLAS Intelligence section ──
    atlas_header = Text("── ATLAS Intelligence ", style="bold blue")
    atlas_header.append("─" * 40, style="dim")

    depth = m["depth_counts"]
    depth_line = Text(
        f"📊 Depth Gate: DIRECT: {depth.get('DIRECT',0)}  "
        f"LIGHT: {depth.get('LIGHTWEIGHT',0)}  "
        f"FULL: {depth.get('FULL',0)}  "
        f"DISC: {depth.get('DISCOVERY',0)}"
    )

    # Agents
    warn = f"  {roster['pending_upgrade']} need upgrade ⚠" if roster["pending_upgrade"] else ""
    agent_active = ", ".join(f"@{n}" for n in roster["active_today"][:4]) or "(none today)"
    agent_line = Text.assemble(
        ("👥 Agents: ", ""),
        (agent_active, "cyan"),
        (f"   Roster: {roster['total']} total{warn}", "dim" if not warn else "yellow"),
    )

    # MCP
    mcp_total = sum(v["calls"] for v in m["mcp_calls"].values())
    mcp_by_server = {}
    for key, val in m["mcp_calls"].items():
        server = key.split("::", 1)[0]
        mcp_by_server[server] = mcp_by_server.get(server, 0) + val["calls"]
    mcp_summary = "  ".join(f"{s}: {c}" for s, c in sorted(mcp_by_server.items(), key=lambda x: -x[1])[:4])
    mcp_line = Text(
        f"🔌 MCP Calls: {mcp_summary or '(none)'}   total: {mcp_total}"
    )

    # References
    refs_line = Text(
        f"📁 Project Refs: {len(refs)} indexes"
        + (f" ({', '.join(refs[:4])})" if refs else "")
    )

    # Task progress
    total_steps = progress["total"]
    done_pct = 100.0 * progress["done"] / total_steps if total_steps else 0.0
    task_line = Text.assemble(
        ("📋 Task Progress: ", ""),
        (f"[{_bar(done_pct, 12)}] ", "green"),
        (f"{progress['done']}/{total_steps} ✓  ", "bold"),
        (f"Checkpoints: {progress['checkpoints']}  ", "dim"),
        (f"Corrections: {progress['corrections']}", "yellow" if progress["corrections"] else "dim"),
    )

    # ── Context health ──
    ctx_header = Text("── Context Health ", style="bold blue")
    ctx_header.append("─" * 45, style="dim")
    ctx_pct = context_percent(m["turns"])
    ctx_status, ctx_col = context_health(ctx_pct)
    ctx_line = Text.assemble(
        ("📐 Context Est: ", ""),
        (f"[{_bar(ctx_pct)}] ", ctx_col),
        (f"~{ctx_pct:.0f}%   ", ctx_col),
        (ctx_status, ctx_col),
    )

    # ── Predictions ──
    pred_header = Text("── Predictions ", style="bold blue")
    pred_header.append("─" * 48, style="dim")
    remaining_tokens = max(0, limit - m["total_tokens"])
    if m["burn_rate"] > 0:
        minutes_left = remaining_tokens / m["burn_rate"]
        exhaust_time = datetime.now().strftime("%H:%M") if minutes_left < 60 * 24 else "—"
    else:
        minutes_left = 0
        exhaust_time = "—"
    reset_str = m["reset_ts"].strftime("%H:%M") if m["reset_ts"] else "—"
    pred_line = Text(
        f"⏰ Tokens exhaust in ~{minutes_left:.0f}m   "
        f"Session resets: {reset_str}",
        style="dim" if minutes_left > 60 else ("yellow" if minutes_left > 30 else "red")
    )

    # ── Footer ──
    now = datetime.now().strftime("%H:%M:%S")
    footer = Text(f"🕐 {now}   📡 Live   Ctrl+C to exit", style="dim")

    body = Group(
        header, Text(""),
        token_line, breakdown,
        Text(""),
        turns_line, cost_line, burn_line, mix_line,
        Text(""),
        atlas_header,
        depth_line, agent_line, mcp_line, refs_line, task_line,
        Text(""),
        ctx_header, ctx_line,
        Text(""),
        pred_header, pred_line,
        Text(""),
        footer,
    )

    return Panel(
        body,
        title="[bold blue]⚡ ATLAS Monitor[/]",
        subtitle="[dim]--daily --agents --mcps --costs[/]",
        border_style="blue",
        padding=(1, 2),
    )
