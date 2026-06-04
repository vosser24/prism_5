"""Command implementations. Each connects to the live (externally-owned)
Chromium over CDP, performs one action, then DISCONNECTS without closing the
browser — Browser.close() over connect_over_cdp only terminates the connection,
so the window stays alive for the next call."""

from __future__ import annotations

import json
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from . import session as sess
from .errors import NavigationTimeout, NoSessionError, SelectorNotFound


def _pick_page(context):
    """Prefer a real, non-devtools tab; fall back to opening one."""
    for pg in context.pages:
        if not pg.url.startswith("devtools://"):
            return pg
    return context.pages[0] if context.pages else context.new_page()


@contextmanager
def connect(session: str):
    """Yield (page, context, browser) connected to the live Chromium. Retries the
    CDP attach once for a transient drop. Never closes the remote browser."""
    st = sess.load_state(session)
    if st is None or not sess.is_running(session):
        raise NoSessionError(
            f"No live session '{session}'. Run `pwagent --session {session} open <url>` first."
        )

    from playwright.sync_api import sync_playwright

    p = sync_playwright().start()
    try:
        browser = None
        last: Exception | None = None
        for _attempt in range(2):
            try:
                browser = p.chromium.connect_over_cdp(st.cdp_url)
                break
            except Exception as e:  # transient CDP drop
                last = e
                time.sleep(0.4)
        if browser is None:
            raise RuntimeError(f"could not attach over CDP to {st.cdp_url}: {last}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = _pick_page(context)
        try:
            yield page, context, browser
        finally:
            # CDP: this only drops the connection, the browser keeps running.
            browser.close()
    finally:
        p.stop()


def _settle(page) -> None:
    """Best-effort wait so we never extract a half-rendered page."""
    try:
        page.wait_for_load_state("load", timeout=5_000)
    except Exception:
        pass


def _goto(page, url: str) -> None:
    from playwright.sync_api import TimeoutError as PWTimeout

    try:
        page.goto(url, wait_until="load", timeout=60_000)
    except PWTimeout as e:
        raise NavigationTimeout(f"navigation to {url} timed out") from e


def _emit(payload: dict, out: str | None, as_json: bool, body_key: str | None = None) -> None:
    """Write the result body to `out` if given; print metadata to stdout."""
    if out and body_key:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        body = payload[body_key]
        text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False, indent=2)
        Path(out).write_text(text, encoding="utf-8")
        payload = {k: v for k, v in payload.items() if k != body_key}
        payload["out"] = out
    if as_json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        for k, v in payload.items():
            print(f"{k}: {v}")


def cmd_open(session: str, url: str, headed: bool, port: int, as_json: bool) -> int:
    t0 = time.perf_counter()
    relaunched = not sess.is_running(session)
    sess.launch(session, headed=headed, port=port)
    with connect(session) as (page, _ctx, _br):
        _goto(page, url)
        title = page.title()
    ms = round((time.perf_counter() - t0) * 1000)
    _emit({
        "session": session, "url": url, "title": title,
        "headed": headed, "cold_start": relaunched, "ms": ms,
    }, out=None, as_json=as_json)
    return 0


def cmd_dom(session: str, selector: str | None, out: str | None, as_json: bool) -> int:
    t0 = time.perf_counter()
    with connect(session) as (page, _ctx, _br):
        _settle(page)
        if selector:
            el = page.query_selector(selector)
            if el is None:
                raise SelectorNotFound(f"selector not found: {selector}")
            html = el.evaluate("e => e.outerHTML")
        else:
            html = page.content()
    ms = round((time.perf_counter() - t0) * 1000)
    _emit({
        "session": session, "selector": selector or "(full document)",
        "chars": len(html), "approx_tokens": len(html) // 4, "ms": ms, "html": html,
    }, out=out, as_json=as_json, body_key="html")
    return 0


def cmd_text(session: str, out: str | None, as_json: bool) -> int:
    """Visible rendered text (document.body.innerText) — the cleanest input for
    copy/translation review (no markup, only what a human reads)."""
    t0 = time.perf_counter()
    with connect(session) as (page, _ctx, _br):
        _settle(page)
        text = page.evaluate("() => document.body ? document.body.innerText : ''")
    ms = round((time.perf_counter() - t0) * 1000)
    _emit({
        "session": session, "chars": len(text), "approx_tokens": len(text) // 4,
        "ms": ms, "text": text,
    }, out=out, as_json=as_json, body_key="text")
    return 0


def cmd_snapshot(session: str, out: str | None, as_json: bool) -> int:
    t0 = time.perf_counter()
    with connect(session) as (page, _ctx, _br):
        _settle(page)
        snap = _accessibility_snapshot(page)
    blob = snap if isinstance(snap, str) else json.dumps(snap, ensure_ascii=False, indent=2)
    ms = round((time.perf_counter() - t0) * 1000)
    _emit({
        "session": session, "chars": len(blob), "approx_tokens": len(blob) // 4,
        "ms": ms, "snapshot": snap,
    }, out=out, as_json=as_json, body_key="snapshot")
    return 0


def _accessibility_snapshot(page):
    """Playwright ARIA snapshot — the compact tree MCP's browser_snapshot uses.
    Falls back to the (verbose) raw CDP AX tree only if aria_snapshot is absent."""
    try:
        return page.locator("body").aria_snapshot()
    except Exception:
        pass
    cdp = page.context.new_cdp_session(page)
    try:
        cdp.send("Accessibility.enable")
        return cdp.send("Accessibility.getFullAXTree")
    finally:
        cdp.detach()


def cmd_network(session: str, out: str | None, as_json: bool) -> int:
    """Capture the resource requests the page issues on a reload. Under Option A
    (CDP-reconnect) request history is not retained across calls, so we record a
    fresh reload — representative of the page's network footprint."""
    from playwright.sync_api import TimeoutError as PWTimeout

    t0 = time.perf_counter()
    requests: list[dict] = []
    with connect(session) as (page, _ctx, _br):
        def on_request(req):
            requests.append({"method": req.method, "url": req.url, "resource_type": req.resource_type})
        page.on("request", on_request)
        try:
            page.reload(wait_until="load", timeout=60_000)
        except PWTimeout as e:
            raise NavigationTimeout("reload timed out") from e
        try:
            page.wait_for_load_state("networkidle", timeout=8_000)
        except Exception:
            pass
        page.remove_listener("request", on_request)
    blob = json.dumps(requests, ensure_ascii=False, indent=2)
    ms = round((time.perf_counter() - t0) * 1000)
    _emit({
        "session": session, "count": len(requests), "chars": len(blob),
        "approx_tokens": len(blob) // 4, "ms": ms, "requests": requests,
    }, out=out, as_json=as_json, body_key="requests")
    return 0


def cmd_screenshot(session: str, full: bool, out: str | None, as_json: bool) -> int:
    t0 = time.perf_counter()
    path = out or f"out/{session}.png"
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(session) as (page, _ctx, _br):
        _settle(page)
        page.screenshot(path=path, full_page=full)
    ms = round((time.perf_counter() - t0) * 1000)
    _emit({"session": session, "out": path, "full_page": full, "ms": ms},
          out=None, as_json=as_json)
    return 0


def cmd_close(session: str, purge: bool, as_json: bool) -> int:
    existed = sess.close(session, purge=purge)
    _emit({"session": session, "closed": existed, "purged": purge}, out=None, as_json=as_json)
    return 0


def cmd_list(as_json: bool) -> int:
    rows = sess.list_sessions()
    if as_json:
        print(json.dumps(rows, ensure_ascii=False))
        return 0
    if not rows:
        print("(no sessions)")
        return 0
    print(f"{'SESSION':<18} {'PORT':>6} {'PID':>8} {'HEADED':>7} {'ALIVE':>6}")
    for r in rows:
        print(f"{r['session']:<18} {r['port']:>6} {r['pid']:>8} {str(r['headed']):>7} {str(r['alive']):>6}")
    return 0


def cmd_selftest(as_json: bool) -> int:
    """Run the full acceptance flow headless against example.com and report
    pass/fail per step — a one-command regression check after any dep bump."""
    name = "__selftest__"
    steps: list[dict] = []
    ok = True
    tmp = Path(tempfile.mkdtemp(prefix="pwagent_selftest_"))

    def record(step: str, cond, detail: str = "") -> None:
        nonlocal ok
        ok = ok and bool(cond)
        steps.append({"step": step, "ok": bool(cond), "detail": detail})

    sess.close(name, purge=True)  # start clean
    try:
        relaunched = not sess.is_running(name)
        sess.launch(name, headed=False, port=0)
        with connect(name) as (page, _c, _b):
            _goto(page, "https://example.com")
            title = page.title()
        record("open", ("Example" in title) and relaunched, f"title={title!r}")

        st = sess.load_state(name)
        record("state_file", st is not None and st.port > 0, f"port={getattr(st, 'port', None)}")

        with connect(name) as (page, _c, _b):
            _settle(page)
            txt = page.evaluate("() => document.body ? document.body.innerText : ''")
        record("text_reconnect", "Example Domain" in txt, f"chars={len(txt)}")

        with connect(name) as (page, _c, _b):
            _settle(page)
            html = page.content()
        record("dom", "<html" in html.lower(), f"chars={len(html)}")

        with connect(name) as (page, _c, _b):
            snap = page.locator("body").aria_snapshot()
        record("snapshot", "Example Domain" in snap, f"chars={len(snap)}")

        reqs: list[str] = []
        with connect(name) as (page, _c, _b):
            page.on("request", lambda r: reqs.append(r.url))
            page.reload(wait_until="load", timeout=60_000)
        record("network", len(reqs) >= 1, f"requests={len(reqs)}")

        shot = tmp / "selftest.png"
        with connect(name) as (page, _c, _b):
            page.screenshot(path=str(shot))
        record("screenshot", shot.exists() and shot.stat().st_size > 0,
               f"bytes={shot.stat().st_size if shot.exists() else 0}")
    except Exception as e:  # noqa: BLE001
        record("exception", False, repr(e))
    finally:
        closed = sess.close(name, purge=True)
        record("close", closed, "")

    if as_json:
        print(json.dumps({"ok": ok, "steps": steps}, ensure_ascii=False, indent=2))
    else:
        for s in steps:
            print(f"[{'PASS' if s['ok'] else 'FAIL'}] {s['step']:<16} {s['detail']}")
        print(f"\n{'ALL PASS' if ok else 'FAILURES PRESENT'}")
    return 0 if ok else 1
