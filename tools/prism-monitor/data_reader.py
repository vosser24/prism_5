"""Reads Claude Code JSONL session logs, roster, and todo.md."""
from __future__ import annotations
import json
import time
from pathlib import Path
from datetime import datetime, timezone
from typing import Iterator

from config import PROJECTS_DIR, ROSTER_PATH, CLAUDE_DIR


def iter_jsonl(path: Path) -> Iterator[dict]:
    """Yield dicts from a JSONL file, skipping malformed lines."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except (FileNotFoundError, PermissionError, OSError):
        return


def find_session_files(project_dir: Path | None = None) -> list[Path]:
    """Return JSONL session files, newest first. If project_dir is None, scan all."""
    files: list[Path] = []
    try:
        roots = [project_dir] if project_dir else list(PROJECTS_DIR.iterdir())
    except (FileNotFoundError, PermissionError):
        return []
    for root in roots:
        if not root.is_dir():
            continue
        try:
            for f in root.glob("*.jsonl"):
                if f.is_file():
                    files.append(f)
        except (PermissionError, OSError):
            continue
    files.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    return files


def project_dir_for_cwd(cwd: Path | None = None) -> Path | None:
    """Find the Claude Code project dir matching the current working directory."""
    cwd = cwd or Path.cwd()
    # Claude Code encodes the path as C--Users-ServosY-...
    if not PROJECTS_DIR.exists():
        return None
    candidate = str(cwd).replace("\\", "-").replace("/", "-").replace(":", "-")
    # Case-insensitive match
    try:
        for entry in PROJECTS_DIR.iterdir():
            if entry.is_dir() and entry.name.lower() == candidate.lower():
                return entry
    except (FileNotFoundError, PermissionError):
        return None
    return None


def current_session_file(project_dir: Path | None = None) -> Path | None:
    """Most recently modified JSONL — assumed to be the active session."""
    files = find_session_files(project_dir)
    return files[0] if files else None


def load_roster() -> dict:
    """Load ATLAS agent roster. Returns {} if missing."""
    try:
        with open(ROSTER_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, PermissionError):
        return {}


def load_todo(cwd: Path | None = None) -> str:
    """Load tasks/todo.md content. Returns '' if missing."""
    cwd = cwd or Path.cwd()
    path = cwd / "tasks" / "todo.md"
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError):
        return ""


def list_references(cwd: Path | None = None) -> list[str]:
    """List *-index.md files in .claude/references/."""
    cwd = cwd or Path.cwd()
    refs = cwd / ".claude" / "references"
    if not refs.exists():
        return []
    try:
        return [p.stem.replace("-index", "") for p in refs.glob("*-index.md")]
    except (PermissionError, OSError):
        return []


def parse_ts(ts: str) -> datetime | None:
    """Parse an ISO timestamp from a JSONL record."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def session_is_active(path: Path, max_idle_seconds: int = 300) -> bool:
    """True if file was modified within max_idle_seconds."""
    try:
        return (time.time() - path.stat().st_mtime) < max_idle_seconds
    except (FileNotFoundError, OSError):
        return False
