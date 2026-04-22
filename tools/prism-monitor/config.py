"""ATLAS Monitor configuration — paths, pricing, plan limits."""
from __future__ import annotations
from pathlib import Path
import os

HOME = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or Path.home())
CLAUDE_DIR = HOME / ".claude"
PROJECTS_DIR = CLAUDE_DIR / "projects"
ROSTER_PATH = CLAUDE_DIR / "agents" / "_meta" / "roster.json"
UPDATE_LOG_PATH = CLAUDE_DIR / "agents" / "_meta" / "update-log.json"
LOG_DIR = CLAUDE_DIR / "logs"
MONITOR_LOG = LOG_DIR / "monitor-daily.jsonl"

# Pricing per million tokens (USD)
PRICING = {
    "opus":   {"input": 5.00, "output": 25.00},
    "sonnet": {"input": 3.00, "output": 15.00},
    "haiku":  {"input": 1.00, "output":  5.00},
}
CACHE_READ_MULT = 0.10   # 10% of input rate
CACHE_WRITE_MULT = 1.25  # 125% of input rate

# Plan token limits per 5h window (rough)
PLAN_LIMITS = {
    "pro":    44_000,
    "max5":   88_000,
    "max20": 220_000,
}
DEFAULT_PLAN = "max20"

# Session reset window (hours)
SESSION_WINDOW_HOURS = 5

# Refresh cadence
REFRESH_SECONDS = 3.0

# Color scheme
COLORS = {
    "opus":   "magenta",
    "sonnet": "cyan",
    "haiku":  "green",
    "healthy":  "green",
    "warning":  "yellow",
    "critical": "red",
    "header":   "bold blue",
    "dim":      "grey50",
}

# Context thresholds (%) for health indicator
CTX_HEALTHY = 50
CTX_WARNING = 65
CTX_CRITICAL = 80


def classify_model(model_id: str) -> str:
    """Map Claude model id to family (opus/sonnet/haiku)."""
    if not model_id:
        return "sonnet"
    m = model_id.lower()
    if "opus" in m:
        return "opus"
    if "haiku" in m:
        return "haiku"
    return "sonnet"
