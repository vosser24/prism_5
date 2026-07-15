#!/usr/bin/env python3
"""
Subagent summary for Claude Code statusline.

Parses the current transcript JSONL format:
  * Agent tool_use entries give us subagent_type (+ optional model override)
  * Paired tool_result entries carry a `<usage>total_tokens:N; duration_ms:M;
    tool_uses:K</usage>` text block with whatever metrics Claude Code exposes.

When the parent doesn't pass an explicit `model:` to the Agent call, the
subagent inherits the model from its YAML frontmatter in ~/.claude/agents/.
We resolve that here so the statusline can show the real model for dedicated
agents (e.g. master-orchestrator = opus, greek-seo = sonnet).

Output format (one line per subagent run, newest first, at most --max lines):
  <subagent_type>|<model_short>|<tokens>|<duration>

Example:
  master-orchestrator|opus 4.7|120k|1m5s
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

AGENTS_DIRS = [
    Path.home() / ".claude" / "agents",
]


def model_short(raw: str) -> str:
    """Normalize 'claude-opus-4-7-20260101' or 'opus' -> 'opus 4.7'."""
    if not raw:
        return "?"
    r = raw.replace("claude-", "").lower()
    parts = r.split("-")
    if parts and parts[-1].isdigit() and len(parts[-1]) == 8:
        parts = parts[:-1]
    parts = [p for p in parts if not re.fullmatch(r"\[?1m\]?", p)]
    if not parts:
        return "?"
    family = parts[0]
    if len(parts) >= 3:
        return f"{family} {parts[1]}.{parts[2]}"
    if len(parts) == 2:
        return f"{family} {parts[1]}"
    return family


PLUGINS_CACHE = Path.home() / ".claude" / "plugins" / "cache"


def _candidate_agent_files(bare: str):
    """Yield candidate .md paths for a subagent name, newest-first for plugins."""
    for root in AGENTS_DIRS:
        yield root / f"{bare}.md"
        yield root / bare / f"{bare}.md"
        yield root / bare / "agent.md"
    if PLUGINS_CACHE.is_dir():
        # plugins/cache/<source>/<plugin>/<version>/agents/<name>.md
        hits = list(PLUGINS_CACHE.glob(f"*/*/*/agents/{bare}.md"))
        hits.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        for p in hits:
            yield p


def resolve_model_from_frontmatter(subagent_type: str) -> str:
    """Look up agent definition and extract `model:` from YAML frontmatter.
    Returns '' if not found (caller will display 'inherited').
    """
    if not subagent_type:
        return ""
    bare = subagent_type.split(":")[-1]
    for p in _candidate_agent_files(bare):
        try:
            if not p.is_file():
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        if not text.startswith("---"):
            continue
        end = text.find("\n---", 3)
        if end < 0:
            continue
        fm = text[3:end]
        for line in fm.splitlines():
            m = re.match(r"\s*model\s*:\s*([^\s#]+)", line)
            if m:
                return m.group(1).strip().strip("\"'")
    return ""


def extract_usage(text: str):
    """Return (total_tokens:int, duration_ms:int) from a <usage>...</usage>
    blob embedded in a tool_result text. Returns (0,0) if not found.
    """
    if not text:
        return 0, 0
    tok = 0
    dur = 0
    m = re.search(r"total_tokens:\s*(\d+)", text)
    if m:
        tok = int(m.group(1))
    m = re.search(r"duration_ms:\s*(\d+)", text)
    if m:
        dur = int(m.group(1))
    return tok, dur


def iter_content_blocks(msg):
    if not isinstance(msg, dict):
        return
    c = msg.get("content")
    if isinstance(c, list):
        for item in c:
            if isinstance(item, dict):
                yield item


def tool_result_text(block) -> str:
    c = block.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for item in c:
            if isinstance(item, dict) and item.get("type") == "text":
                out.append(item.get("text", ""))
        return "\n".join(out)
    return ""


def parse_transcript(path: str):
    agent_calls = {}
    results = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line_idx, raw in enumerate(fh):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except Exception:
                    continue
                msg = obj.get("message")
                for block in iter_content_blocks(msg):
                    btype = block.get("type")
                    if btype == "tool_use" and block.get("name") == "Agent":
                        tid = block.get("id")
                        inp = block.get("input") or {}
                        if tid:
                            agent_calls[tid] = {
                                "subagent_type": inp.get("subagent_type")
                                or inp.get("description")
                                or "agent",
                                "model": inp.get("model") or "",
                                "idx": line_idx,
                            }
                    elif btype == "tool_result":
                        tid = block.get("tool_use_id")
                        if tid and tid in agent_calls and tid not in results:
                            tok, dur = extract_usage(tool_result_text(block))
                            results[tid] = (tok, dur, line_idx)
    except FileNotFoundError:
        return

    for tid, call in agent_calls.items():
        tok, dur, r_idx = results.get(tid, (0, 0, call["idx"]))
        yield {
            "id": tid,
            "idx": r_idx,
            "subagent_type": call["subagent_type"],
            "model": call["model"],
            "tokens": tok,
            "duration_ms": dur,
        }


def tk_fmt(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1000:
        return f"{n // 1000}k"
    return str(n)


def dur_fmt(ms: int) -> str:
    if ms <= 0:
        return "—"
    s = ms // 1000
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60}s"
    h = s // 3600
    m = (s % 3600) // 60
    return f"{h}h{m}m"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("--max", type=int, default=5)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    runs = list(parse_transcript(args.transcript))

    # Aggregate by (subagent_type, resolved_model) so repeat invocations of the
    # same agent+model collapse into a single row. Sum tokens + duration,
    # track newest idx for ordering, and count runs so we can suffix "×N".
    groups: dict = {}
    for r in runs:
        stype = (r["subagent_type"] or "agent")[:40]
        model_raw = r["model"] or resolve_model_from_frontmatter(stype)
        model_disp = model_short(model_raw) if model_raw else "inherited"
        key = (stype, model_disp)
        g = groups.get(key)
        if g is None:
            groups[key] = {
                "stype": stype,
                "model": model_disp,
                "tokens": r["tokens"],
                "duration_ms": r["duration_ms"],
                "idx": r["idx"],
                "count": 1,
            }
        else:
            g["tokens"] += r["tokens"]
            g["duration_ms"] += r["duration_ms"]
            g["count"] += 1
            if r["idx"] > g["idx"]:
                g["idx"] = r["idx"]

    ranked = sorted(groups.values(), key=lambda g: -g["idx"])[: args.max]

    out_lines = []
    for g in ranked:
        label = g["stype"] + (f" ×{g['count']}" if g["count"] > 1 else "")
        tok = tk_fmt(g["tokens"])
        dur = dur_fmt(g["duration_ms"])
        out_lines.append(f"{label}|{g['model']}|{tok}|{dur}")

    payload = "\n".join(out_lines) + ("\n" if out_lines else "")
    if args.out:
        tmp = args.out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp, args.out)
    else:
        sys.stdout.write(payload)


if __name__ == "__main__":
    main()
