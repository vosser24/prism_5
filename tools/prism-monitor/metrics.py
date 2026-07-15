"""Compute session metrics from JSONL + PRISM state."""
from __future__ import annotations
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone, timedelta
import re

from config import (PRICING, CACHE_READ_MULT, CACHE_WRITE_MULT,
                    PLAN_LIMITS, DEFAULT_PLAN, SESSION_WINDOW_HOURS,
                    classify_model)
from data_reader import (iter_jsonl, parse_ts, load_roster, load_todo,
                          list_references)


def compute_session_metrics(jsonl_path: Path) -> dict:
    """Extract tokens, costs, model mix, tools, depth distribution from a session."""
    by_model = defaultdict(lambda: {
        "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
        "calls": 0
    })
    mcp_calls = defaultdict(lambda: {"calls": 0, "tokens": 0})
    depth_counts = defaultdict(int)  # DIRECT, LIGHTWEIGHT, FULL, DISCOVERY
    agent_calls = defaultdict(int)
    turns = 0
    first_ts: datetime | None = None
    last_ts: datetime | None = None

    for rec in iter_jsonl(jsonl_path):
        rtype = rec.get("type")
        ts = parse_ts(rec.get("timestamp", ""))
        if ts:
            if first_ts is None:
                first_ts = ts
            last_ts = ts

        if rtype == "user":
            turns += 1
            # Depth gate detection from prompt content
            try:
                content = rec.get("message", {}).get("content", "")
                if isinstance(content, str):
                    _detect_depth(content, depth_counts)
            except (AttributeError, TypeError):
                pass
        elif rtype == "assistant":
            msg = rec.get("message", {}) or {}
            model = msg.get("model", "")
            family = classify_model(model)
            usage = msg.get("usage", {}) or {}
            bucket = by_model[family]
            bucket["input"] += usage.get("input_tokens", 0) or 0
            bucket["output"] += usage.get("output_tokens", 0) or 0
            bucket["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
            bucket["cache_write"] += usage.get("cache_creation_input_tokens", 0) or 0
            bucket["calls"] += 1

            # Tool-use detection in content array
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use":
                        name = block.get("name", "")
                        if name.startswith("mcp__"):
                            parts = name.split("__", 2)
                            if len(parts) >= 3:
                                server = parts[1]
                                tool = parts[2]
                                key = f"{server}::{tool}"
                            else:
                                key = name
                            mcp_calls[key]["calls"] += 1
                            mcp_calls[key]["tokens"] += (
                                usage.get("output_tokens", 0) or 0
                            )
                        elif name == "Agent" or name == "Task":
                            # Subagent dispatch
                            inp = block.get("input", {}) or {}
                            agent = inp.get("subagent_type") or inp.get("description", "agent")
                            agent_calls[str(agent)[:30]] += 1

    # Totals and cost
    total_input = sum(b["input"] for b in by_model.values())
    total_output = sum(b["output"] for b in by_model.values())
    total_cache_read = sum(b["cache_read"] for b in by_model.values())
    total_cache_write = sum(b["cache_write"] for b in by_model.values())
    # "Fresh" tokens — what counts against plan limits (excludes cache hits)
    fresh_tokens = total_input + total_output
    # Total tokens including cache, for reporting
    total_tokens = fresh_tokens + total_cache_read + total_cache_write
    total_calls = sum(b["calls"] for b in by_model.values())

    cost = 0.0
    model_costs = {}
    for family, b in by_model.items():
        price = PRICING.get(family, PRICING["sonnet"])
        c = (
            b["input"]        * price["input"]  / 1_000_000
            + b["output"]     * price["output"] / 1_000_000
            + b["cache_read"] * price["input"]  * CACHE_READ_MULT  / 1_000_000
            + b["cache_write"]* price["input"]  * CACHE_WRITE_MULT / 1_000_000
        )
        model_costs[family] = c
        cost += c

    # Model distribution (by calls)
    model_mix = {}
    if total_calls > 0:
        for family, b in by_model.items():
            model_mix[family] = b["calls"] / total_calls

    # Burn / cost rate (5-min rolling estimate via first→last timestamps)
    duration_min = 0.0
    if first_ts and last_ts:
        duration_min = max(1.0, (last_ts - first_ts).total_seconds() / 60.0)
    burn_rate = fresh_tokens / duration_min if duration_min > 0 else 0.0
    cost_rate = cost / duration_min if duration_min > 0 else 0.0

    # Session reset time (first_ts + 5 hours)
    reset_ts = (first_ts + timedelta(hours=SESSION_WINDOW_HOURS)) if first_ts else None

    return {
        "turns": turns,
        "total_input": total_input,
        "total_output": total_output,
        "cache_read": total_cache_read,
        "cache_write": total_cache_write,
        "fresh_tokens": fresh_tokens,
        "total_tokens": total_tokens,
        "cost": cost,
        "model_costs": model_costs,
        "by_model": dict(by_model),
        "model_mix": model_mix,
        "burn_rate": burn_rate,
        "cost_rate": cost_rate,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "duration_min": duration_min,
        "reset_ts": reset_ts,
        "mcp_calls": dict(mcp_calls),
        "depth_counts": dict(depth_counts),
        "agent_calls": dict(agent_calls),
    }


_DEPTH_PATTERNS = [
    (re.compile(r"\b(read my database|scan|map|discover|explore|what tables|show schema|list all)\b", re.I), "DISCOVERY"),
    (re.compile(r"\b(build|implement|create|deploy|migrate|automate|refactor|design)\b", re.I), "FULL"),
    (re.compile(r"\b(fix|update|change|add|tweak|adjust)\b", re.I), "LIGHTWEIGHT"),
]


def _detect_depth(prompt: str, counts: dict) -> None:
    """Heuristic depth gate classification (matches skill-rules.json)."""
    if not prompt:
        return
    for pattern, label in _DEPTH_PATTERNS:
        if pattern.search(prompt):
            counts[label] = counts.get(label, 0) + 1
            return
    counts["DIRECT"] = counts.get("DIRECT", 0) + 1


def context_percent(turns: int, avg_tokens_per_turn: float = 0.0,
                    plan: str = DEFAULT_PLAN) -> float:
    """Rough context estimate from turn count."""
    limit = PLAN_LIMITS.get(plan, PLAN_LIMITS[DEFAULT_PLAN])
    if avg_tokens_per_turn <= 0:
        # Turn-based heuristic from claude-optimization skill
        return min(100.0, turns * 1.7)
    used = turns * avg_tokens_per_turn
    return min(100.0, 100.0 * used / limit)


def context_health(pct: float) -> tuple[str, str]:
    """Return (status_label, color) for context %"""
    from config import CTX_HEALTHY, CTX_WARNING, CTX_CRITICAL
    if pct < CTX_HEALTHY:
        return ("✅ Healthy", "green")
    if pct < CTX_WARNING:
        return ("⚠ Consider checkpoint", "yellow")
    if pct < CTX_CRITICAL:
        return ("🟠 Suggest /clear soon", "orange1")
    return ("🔴 Critical — /clear now", "red")


def parse_todo_progress(cwd: Path | None = None) -> dict:
    """Parse tasks/todo.md for step states."""
    content = load_todo(cwd)
    if not content:
        return {"done": 0, "pending": 0, "interrupted": 0, "failed": 0,
                "total": 0, "checkpoints": 0, "corrections": 0}
    done = len(re.findall(r"^\s*[-*]\s*\[x\]", content, re.M))
    pending = len(re.findall(r"^\s*[-*]\s*\[ \]", content, re.M))
    interrupted = len(re.findall(r"^\s*[-*]\s*\[~\]", content, re.M))
    failed = len(re.findall(r"^\s*[-*]\s*\[!\]", content, re.M))
    checkpoints = len(re.findall(r"(?i)checkpoint", content))
    corrections = len(re.findall(r"(?i)correction|redo|re-delegat", content))
    return {
        "done": done, "pending": pending, "interrupted": interrupted,
        "failed": failed, "total": done + pending + interrupted + failed,
        "checkpoints": checkpoints, "corrections": corrections,
    }


def roster_summary() -> dict:
    """Summarize PRISM roster state."""
    roster = load_roster()
    agents = roster.get("agents", {}) or {}
    total = len(agents)
    pending = sum(1 for a in agents.values() if a.get("pending_upgrade"))
    today = datetime.now().strftime("%Y-%m-%d")
    active_today = []
    for name, data in agents.items():
        last = data.get("last_research_date") or ""
        if last.startswith(today):
            active_today.append(name)
    return {
        "total": total,
        "pending_upgrade": pending,
        "active_today": active_today,
        "agents": agents,
    }
