"""Persistence (Option A): launch a detached Chromium with a remote-debugging
port that owns its own window/lifecycle, and reconnect to it over CDP on every
subsequent CLI call. State (port, pid, profile dir) is persisted under
%LOCALAPPDATA%\\pwagent\\<session>.json so calls survive across processes.

v0.2: per-session auto-allocated debugging port, image-verified liveness,
detached-browser stderr captured to a per-session log, and a session lister."""

from __future__ import annotations

import contextlib
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path

DEFAULT_PORT = 9333  # retained for back-compat; port=0 means "auto-allocate" (preferred)


def state_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    d = Path(base) / "pwagent"
    d.mkdir(parents=True, exist_ok=True)
    (d / "profiles").mkdir(exist_ok=True)
    (d / "logs").mkdir(exist_ok=True)
    return d


def state_path(session: str) -> Path:
    return state_dir() / f"{session}.json"


def profile_dir(session: str) -> Path:
    p = state_dir() / "profiles" / session
    p.mkdir(parents=True, exist_ok=True)
    return p


def log_path(session: str) -> Path:
    return state_dir() / "logs" / f"{session}.log"


@dataclass
class SessionState:
    session: str
    port: int
    pid: int
    headed: bool
    ws_endpoint: str
    profile: str

    @property
    def cdp_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def load_state(session: str) -> SessionState | None:
    p = state_path(session)
    if not p.exists():
        return None
    try:
        return SessionState(**json.loads(p.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, TypeError):
        return None


def save_state(st: SessionState) -> None:
    state_path(st.session).write_text(json.dumps(asdict(st), indent=2), encoding="utf-8")


def _free_port() -> int:
    """Ask the OS for an unused TCP port on the loopback interface."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _pid_alive(pid: int) -> bool:
    """True only if a *Chromium* process with this pid is running. Filtering by
    image name avoids the substring / PID-reuse false positives of a bare match."""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FI", "IMAGENAME eq chrome.exe", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return False
    return "chrome.exe" in out.lower()


def _chromium_executable() -> str:
    """Path to the Playwright-managed Chromium. Resolved once per call."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        return p.chromium.executable_path


def _probe_cdp(port: int, timeout_s: float = 30.0) -> str:
    """Poll http://127.0.0.1:<port>/json/version until the browser answers with a
    webSocketDebuggerUrl. Returns the ws endpoint."""
    deadline = time.time() + timeout_s
    last_err: Exception | None = None
    url = f"http://127.0.0.1:{port}/json/version"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                ws = data.get("webSocketDebuggerUrl")
                if ws:
                    return ws
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            last_err = e
        time.sleep(0.2)
    raise RuntimeError(f"CDP endpoint on port {port} never became ready: {last_err}")


def is_running(session: str) -> bool:
    st = load_state(session)
    if st is None:
        return False
    if not _pid_alive(st.pid):
        return False
    # confirm the port still answers
    try:
        _probe_cdp(st.port, timeout_s=2.0)
        return True
    except RuntimeError:
        return False


def launch(session: str, headed: bool, port: int = 0) -> SessionState:
    """Launch a detached Chromium owning a remote-debugging port and persist state.
    Idempotent + self-healing: a live session is returned unchanged; stale state
    (browser gone) is relaunched and overwritten. port=0 auto-allocates a free
    port so independent named sessions never collide."""
    existing = load_state(session)
    if existing and is_running(session):
        return existing

    if not port:
        port = _free_port()

    exe = _chromium_executable()
    prof = profile_dir(session)
    args = [
        exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={prof}",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
    ]
    if not headed:
        args.append("--headless=new")

    # Detach so the browser is independent of this Python process.
    flags = (
        subprocess.DETACHED_PROCESS
        | subprocess.CREATE_NEW_PROCESS_GROUP
        | getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0)
    )
    # Capture the detached browser's own stdout/stderr to a per-session log so
    # launch failures are diagnosable instead of vanishing into DEVNULL.
    logf = open(log_path(session), "wb")
    try:
        proc = subprocess.Popen(
            args,
            creationflags=flags,
            stdin=subprocess.DEVNULL,
            stdout=logf,
            stderr=logf,
            close_fds=True,
        )
    finally:
        logf.close()  # the child keeps its own duplicated handle

    try:
        ws = _probe_cdp(port)
    except RuntimeError as e:
        tail = ""
        with contextlib.suppress(Exception):
            tail = log_path(session).read_text(encoding="utf-8", errors="replace")[-800:]
        raise RuntimeError(f"{e}\n--- chromium log tail ---\n{tail}") from e

    st = SessionState(
        session=session, port=port, pid=proc.pid, headed=headed,
        ws_endpoint=ws, profile=str(prof),
    )
    save_state(st)
    return st


def close(session: str, purge: bool = False) -> bool:
    """Kill the detached Chromium process tree and delete the state file.
    With purge=True also remove the session's Chromium profile + log.
    Returns True if a session existed."""
    st = load_state(session)
    if st is None:
        return False
    with contextlib.suppress(Exception):
        subprocess.run(
            ["taskkill", "/PID", str(st.pid), "/T", "/F"],
            capture_output=True, text=True, timeout=15,
        )
    state_path(session).unlink(missing_ok=True)
    if purge:
        import shutil
        shutil.rmtree(profile_dir(session), ignore_errors=True)
        with contextlib.suppress(OSError):
            log_path(session).unlink(missing_ok=True)
    return True


def list_sessions() -> list[dict]:
    """Enumerate every persisted session and whether it is currently live."""
    rows: list[dict] = []
    for f in sorted(state_dir().glob("*.json")):
        st = load_state(f.stem)
        if st is None:
            continue
        rows.append({
            "session": st.session,
            "port": st.port,
            "pid": st.pid,
            "headed": st.headed,
            "alive": is_running(st.session),
        })
    return rows
