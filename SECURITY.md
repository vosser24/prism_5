# Security Policy

## PRISM's security posture

PRISM is **local-first**. Its core — deterministic Node hooks + JSON manifests — makes **no network calls**, requires **no API keys**, and sends **no telemetry** off your machine. Telemetry is opt-in and local-only. PRISM influences which model tier your existing agentic CLI uses; it does not make model calls itself.

Optional tiers that *can* reach the network are clearly marked and opt-in:
- the cross-project research tier (NotebookLM / `gh`),
- the bundled `pwagent` Playwright tool (downloads Chromium on first run, only after you enable it with `--with-pwagent`).

Nothing reaches the network unless you explicitly opt in.

## Reporting a vulnerability

If you find a security issue — especially anything that causes PRISM to exfiltrate data, execute unexpected code, or weaken one of its safety guards — please report it privately:

- Use **GitHub's "Report a vulnerability"** (Security tab → Report a vulnerability) on this repository, **or**
- open a minimal issue asking for a private contact channel (do **not** include exploit details in a public issue).

Please include: the affected file/hook, reproduction steps, and the impact. We aim to acknowledge reports within a few days.

## Scope

In scope: the hooks, tools, installer, and the safety/dispatch/mutation guards. Out of scope: vulnerabilities in third-party tools you choose to install (Node, Playwright, NotebookLM, `gh`) — report those upstream.
