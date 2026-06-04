# Design — Bootstrap project venv + embed pwagent in the PRISM install

**Status:** Draft (awaiting user review)
**Date:** 2026-06-04
**Author:** PRISM dev session (brainstormed + approved 2026-06-04)
**Scope:** Two features added to PRISM ≥ v5.2.14.

---

## 1. Goals

1. **Project venv on bootstrap.** `/prism-bootstrap` ensures a project-root `.venv` exists for Python projects, and that Python work in the project "always runs under the venv."
2. **Embed `pwagent`.** Vendor the existing `~/.claude/tools/pwagent/` Playwright CLI into the PRISM repo + installer so a fresh PRISM install on any machine gets it, with its dependencies provisioned on consent.

## 2. Key constraints (verified)

- **No persistent shell activation.** Each Claude Code Bash/PowerShell tool call is a fresh shell — there is no durable `activate`. "Always under venv" is achieved by (a) convention and (b) PATH wiring, not by a one-time activate.
- **PATH-injection is environment-dependent** (claude-master, cited `code.claude.com/docs/en/{settings,hooks}`):
  - The documented, committable, project-relative mechanism is a **SessionStart hook** that appends `export PATH="$CLAUDE_PROJECT_DIR/.venv/Scripts:$PATH"` to `$CLAUDE_ENV_FILE`. **Works only for Git Bash sessions.**
  - On the **PowerShell tool** session, `CLAUDE_ENV_FILE` does not apply; fallback is `settings.local.json` `env` with an **absolute** venv path (machine-specific → gitignored, generated locally by bootstrap). `${PATH}` expansion inside `env` is undocumented/unverified.
  - **Convention is the guaranteed baseline** regardless of shell.
- **A `.venv` cannot be shipped** (absolute paths + platform binaries). It is created on the target machine. For pwagent this is already handled by `pwagent.ps1`'s self-bootstrap.

## 3. Feature A — project `.venv` on `/prism-bootstrap`

### A1 · Detection
Treat the project as Python when any of these exist at root (or one level deep): `requirements.txt`, `pyproject.toml`, `Pipfile`, `setup.py`, `setup.cfg`, `manage.py`, or any `*.py`.

### A2 · Greenfield "I'm about to write Python" case
When **no** Python signal is found, bootstrap **asks once** (interactive): *"No Python detected. Will this be a Python project? Create a `.venv` and govern Python under it?"* Non-interactive flags: `--python` / `--no-python`. The answer is **recorded in `.claude/.prism-state.json`** (`python_project: true|false`), so once chosen it persists across sessions even while the folder is still empty. Re-runs read the recorded value (idempotent; never re-prompt once set).

### A3 · Create
If Python (detected or chosen) and `.venv` absent: `python -m venv .venv` in project root (resolve `python`/`py -3` from PATH; fail-soft with a printed manual step if no Python). Append `.venv/` to the project `.gitignore` (create if missing; no duplicate entry).

### A4 · Enforcement — convention + PATH (both, per user)
1. **Convention (always):** ensure the CLAUDE.md `## PRISM Operating Rules` carry a venv rule — *"This project uses `.venv`. Run Python via `.venv\Scripts\python` (Windows) / `.venv/bin/python` (POSIX); do not use system Python."* Plus a one-line SessionStart reminder when a project `.venv` exists.
2. **Git-Bash PATH hook (committable):** write a `SessionStart` hook into the project `.claude/settings.json` that appends the venv `Scripts` (POSIX-converted via `cygpath`) to `$CLAUDE_ENV_FILE` using `${CLAUDE_PROJECT_DIR}`. Single-line command, no CRLF.
3. **PowerShell fallback (gitignored):** when bootstrap can resolve the absolute venv path locally, write `.claude/settings.local.json` `env.PATH` = `<abs>\.venv\Scripts;<existing system path segments>`. `settings.local.json` is gitignored (machine-specific). Skipped if it would clobber an existing user PATH unsafely — convention still covers it.

> Mechanisms 2 & 3 are best-effort accelerators; mechanism 1 is the guarantee. If hook/env wiring proves unsupported on the live Claude Code build, A4 degrades cleanly to convention-only.

## 4. Feature B — embed `pwagent`

### B1 · Vendor source into repo (`tools/pwagent/`)
Copy from `~/.claude/tools/pwagent/`, **excluding `.venv/`, `__pycache__/`, `out/`**:
- `pwagent.cmd`, `pwagent.ps1`
- `requirements.txt` (`playwright==1.60.0`, `openpyxl==3.1.5`)
- `src/pwagent/{__init__,__main__,cli,actions,session,errors}.py`
- new `tools/pwagent/.gitignore` → `.venv/`, `__pycache__/`, `*.pyc`, `out/`

(No `pyproject.toml` and no `tests/` exist on disk — the user's original list was aspirational; `tests/` is excluded per the user regardless. Both launchers — `pwagent.cmd` → `pwagent.ps1` — do exist and are vendored. Tool version `0.2.0`.)

### B2 · Install manifest
Add the B1 files to `tools/install-manifest.json` so `prism-installer` copies them to `~/.claude/tools/pwagent/`. **Do not** manifest `.venv/`.

### B3 · Self-provisioning is already built in
`pwagent.ps1` is idempotent and self-bootstrapping: on first invocation it creates `.venv` (Python 3.12 from `C:\Program Files\Python312` or PATH), upgrades pip, installs requirements, runs `playwright install chromium` (~150 MB), `pip check`, and records a `requirements`-hash guard; later runs reinstall only on requirements drift. The CLI always runs via the venv python with `PYTHONPATH=src`. **The installer therefore does not re-implement any of this.**

### B4 · Installer responsibilities (consent-gated, full-auto per user)
On `install`/`update`, after laying down files, if pwagent is present and not yet on PATH, **prompt**: *"Set up pwagent now? Adds it to your User PATH and warms its venv (creates `.venv`, installs deps + downloads Chromium ~150MB on first run)."*
- **Accept →** (a) add `~/.claude/tools/pwagent` to **User PATH** (idempotent — skip if already present; takes effect in new shells); (b) **warm** by running `pwagent.cmd selftest` once so the venv + Chromium are ready (fail-soft: if Python 3.12 absent, print the manual step and continue).
- **Decline / non-interactive →** ship files only; print the one-liner (`<path>\pwagent.cmd selftest` + the PATH add command).
- **Non-interactive opt-in:** `--with-pwagent` flag or `node tools/prism-installer.mjs setup-pwagent` subcommand performs the Accept path without prompting.

## 5. Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `tools/prism-bootstrap.mjs` (`ensure-venv` step) | Detect/ask/create `.venv`, write `.gitignore`, persist `python_project` in state, wire enforcement | `prism-state` |
| `commands/prism-bootstrap.md` | Document the venv phase + the Operating-Rule text the LLM writes | — |
| `tools/pwagent/**` (vendored) | The Playwright CLI itself (unchanged logic) | Python 3.12 + Playwright (self-provisioned) |
| `tools/install-manifest.json` | Declares pwagent files to ship | — |
| `tools/prism-installer.mjs` (`setup-pwagent`) | PATH add + warm + consent prompt; `--with-pwagent` | manifest copy step |

## 6. Testing

- `test-prism-bootstrap`: (a) Python detected → `.venv` intent recorded + `.gitignore` updated; (b) greenfield + `--python` → recorded `python_project:true`; (c) `--no-python` → no venv, recorded false; (d) idempotent re-run does not re-prompt. **Mock `python -m venv`** (don't build a real venv in CI) — assert the command/intent + state, not a materialized venv.
- `test-prism-installer` (or a new `test-prism-pwagent-install`): manifest includes the 9 pwagent source files and **excludes** `.venv`; `setup-pwagent` is idempotent on PATH (no double-add); decline path prints manual steps; absent-Python path fails soft.
- Manifest integrity: every `tools/pwagent/**` source file in the repo is listed (and no `.venv`).
- Full suite stays green (53/53) + audit 29/29.

## 7. Out of scope / risks

- **Non-Windows pwagent**: ships `.cmd`/`.ps1`; POSIX launcher is future work. Windows-first, matching the tool's current state.
- **Network + executable side effects** (pip, Chromium download, PATH edit) run **only** behind explicit consent or an explicit flag — aligns with PRISM's safety posture.
- **PATH-injection (A4.2/A4.3)** may degrade to convention-only on some Claude Code builds; acceptable by design.
- Live Claude Code session must restart to pick up a newly-written SessionStart venv hook (event already fired).

## 8. Rollout

Single patch series. Version bump (5.2.15) + CHANGELOG. Ship via `git push` + `node tools/prism-installer.mjs update`. Implementation proceeds via the writing-plans skill → TDD per unit.
