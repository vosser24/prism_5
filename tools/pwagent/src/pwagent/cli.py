"""argparse CLI entrypoint. The global --session / --json flags are accepted in
ANY position (before OR after the subcommand): they are pre-extracted by a small
standalone parser, sidestepping the argparse parents=/subparser default-clobber
gotcha entirely."""

from __future__ import annotations

import argparse
import os
import sys

from . import __version__, actions
from .errors import PwagentError


def _resolve_headed(args) -> bool:
    if getattr(args, "headless", False):
        return False
    if getattr(args, "headed", False):
        return True
    env = os.environ.get("PWAGENT_HEADED", "").strip().lower()
    if env in {"0", "false", "no"}:
        return False
    if env in {"1", "true", "yes"}:
        return True
    return True  # default: visible for interactive use


def _extract_globals(argv: list[str]) -> tuple[str, bool, list[str]]:
    """Pull --session / --json from ANY position and return
    (session, as_json, remaining_args). Position-independent and robust across
    argparse versions — avoids the parents=/subparser default-clobber gotcha."""
    pre = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    pre.add_argument("--session", default="default")
    pre.add_argument("--json", action="store_true", dest="as_json", default=False)
    ns, rest = pre.parse_known_args(argv)
    return ns.session, ns.as_json, rest


def build_parser() -> argparse.ArgumentParser:
    # --session / --json are listed here purely for --help discoverability; their
    # values are resolved by _extract_globals (position-independent), not here.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--session", default="default", help="named session (default: 'default')")
    common.add_argument("--json", action="store_true", dest="as_json", help="emit machine-readable JSON")

    p = argparse.ArgumentParser(
        prog="pwagent",
        description="Playwright agent: keep a Chromium alive across CLI calls and dump DOM / a11y snapshot / network.",
        parents=[common],
    )
    p.add_argument("--version", action="version", version=f"pwagent {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("open", help="launch-if-needed + navigate; keep browser alive", parents=[common])
    sp.add_argument("url")
    g = sp.add_mutually_exclusive_group()
    g.add_argument("--headed", action="store_true", help="visible window (default)")
    g.add_argument("--headless", action="store_true", help="no window")
    sp.add_argument("--port", type=int, default=0,
                    help="remote-debugging port (0 = auto-allocate a free port; default)")

    sp = sub.add_parser("dom", help="dump full HTML or a selector's outerHTML", parents=[common])
    sp.add_argument("--selector", help="CSS selector; omit for full document")
    sp.add_argument("--out", help="write HTML to file")

    sp = sub.add_parser("text", help="visible rendered text (body.innerText)", parents=[common])
    sp.add_argument("--out", help="write text to file")

    sp = sub.add_parser("snapshot", help="accessibility tree (ARIA)", parents=[common])
    sp.add_argument("--out", help="write snapshot to file")

    sp = sub.add_parser("network", help="list requests captured on a reload", parents=[common])
    sp.add_argument("--out", help="write requests JSON to file")

    sp = sub.add_parser("screenshot", help="capture a PNG", parents=[common])
    sp.add_argument("--full", action="store_true", help="full-page screenshot")
    sp.add_argument("--out", help="output path (default out/<session>.png)")

    sp = sub.add_parser("close", help="kill the browser + delete session state", parents=[common])
    sp.add_argument("--purge", action="store_true", help="also delete the session's Chromium profile + log")

    sub.add_parser("list", help="list known sessions and whether each is alive", parents=[common])
    sub.add_parser("selftest", help="run the full acceptance flow headless; report pass/fail", parents=[common])
    return p


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    session, as_json, rest = _extract_globals(argv)
    args = build_parser().parse_args(rest)
    # globals from the position-independent pre-parse are authoritative
    args.session = session
    args.as_json = as_json
    try:
        if args.command == "open":
            return actions.cmd_open(args.session, args.url, _resolve_headed(args), args.port, args.as_json)
        if args.command == "dom":
            return actions.cmd_dom(args.session, args.selector, args.out, args.as_json)
        if args.command == "text":
            return actions.cmd_text(args.session, args.out, args.as_json)
        if args.command == "snapshot":
            return actions.cmd_snapshot(args.session, args.out, args.as_json)
        if args.command == "network":
            return actions.cmd_network(args.session, args.out, args.as_json)
        if args.command == "screenshot":
            return actions.cmd_screenshot(args.session, args.full, args.out, args.as_json)
        if args.command == "close":
            return actions.cmd_close(args.session, args.purge, args.as_json)
        if args.command == "list":
            return actions.cmd_list(args.as_json)
        if args.command == "selftest":
            return actions.cmd_selftest(args.as_json)
    except PwagentError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.code
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
