# Bootstrap venv + embed pwagent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/prism-bootstrap` provision a project-root `.venv` for Python projects (and govern Python under it), and vendor the existing `pwagent` Playwright CLI into the PRISM repo + installer so a fresh install ships and provisions it.

**Architecture:** Two independent phases. **Phase A** adds a deterministic `ensure-venv` subcommand to `tools/prism-bootstrap.mjs` (detect/ask-and-remember/create + wire enforcement), invoked by the `/prism-bootstrap` slash command. **Phase B** vendors `tools/pwagent/**` (source only, no `.venv`), lists it in the install manifest, and adds a consent-gated `setup-pwagent` step to `tools/prism-installer.mjs` (PATH add + warm via the tool's own self-bootstrap). Each phase ships independently.

**Tech Stack:** Node ESM (`.mjs`) helpers, JSON state/manifest, Windows-first (PowerShell/cmd launchers), Python 3.12 venv, Playwright. Tests are plain-node assertion suites under `tests/v3/state/`.

**Spec:** `docs/superpowers/specs/2026-06-04-venv-pwagent-bootstrap-design.md`

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `tools/prism-bootstrap.mjs` | Modify (new `ensure-venv` case @ `switch(cmd)` L564; helpers near top) | Detect Python / honor `--python`/`--no-python` / record `python_project` in state / create `.venv` / update `.gitignore` / write SessionStart venv hook + local PATH fallback |
| `commands/prism-bootstrap.md` | Modify (add venv phase + Operating-Rule text) | LLM-facing: when to call `ensure-venv`, the greenfield question, the CLAUDE.md venv rule |
| `tests/v3/state/test-prism-bootstrap.mjs` | Modify | TDD for `ensure-venv` (detect/greenfield/idempotent/gitignore/state) |
| `tools/pwagent/**` | Create (vendored) | The Playwright CLI source + launchers (no `.venv`) |
| `tools/pwagent/.gitignore` | Create | Ignore `.venv/`, `__pycache__/`, `*.pyc`, `out/` |
| `tools/install-manifest.json` | Modify | Declare the 9 pwagent source files to ship |
| `tools/prism-installer.mjs` | Modify (new `setupPwagent()`; `setup-pwagent` case @ `switch(subcommand)` L1052; call from `install()` L591 + `runUpdate()` L864) | PATH add (idempotent) + warm via `pwagent.cmd selftest`, consent-gated; `--with-pwagent` non-interactive |
| `tests/v3/state/test-prism-pwagent-install.mjs` | Create | TDD for manifest coverage + `setupPwagent` idempotent/dry-run/decline |
| `.claude-plugin/plugin.json`, `tools/install-manifest.json` (version), `CHANGELOG.md` | Modify | v5.2.15 bump + entry |

---

## PHASE A — project `.venv` on bootstrap

### Task A1: `ensure-venv` decides + records `python_project` (no venv yet)

**Files:**
- Modify: `tools/prism-bootstrap.mjs` (add `detectPython(root)` helper near other helpers; add `case 'ensure-venv'` in `switch(cmd)` at L564)
- Test: `tests/v3/state/test-prism-bootstrap.mjs`

- [ ] **Step 1: Write failing tests** (append to the test file, before the summary IIFE)

```js
test('ensure-venv: detects a Python project and records python_project=true', () => {
  const root = makeTestbed('venv-detect');
  try {
    writeFileSync(join(root, 'requirements.txt'), 'django\n');
    const r = run(root, 'ensure-venv', 'tb', '--no-create');
    assertEq(r.status, 0, r.stderr);
    const state = readStateFile(root);
    assertEq(state.python_project, true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('ensure-venv: greenfield + --python records true; --no-python records false', () => {
  const a = makeTestbed('venv-green-yes');
  const b = makeTestbed('venv-green-no');
  try {
    assertEq(run(a, 'ensure-venv', 'tb', '--python', '--no-create').status, 0);
    assertEq(readStateFile(a).python_project, true);
    assertEq(run(b, 'ensure-venv', 'tb', '--no-python', '--no-create').status, 0);
    assertEq(readStateFile(b).python_project, false);
  } finally { rmSync(a, {recursive:true,force:true}); rmSync(b, {recursive:true,force:true}); }
});

test('ensure-venv: greenfield with no flag exits "needs-prompt" (3) and records nothing', () => {
  const root = makeTestbed('venv-green-ask');
  try {
    const r = run(root, 'ensure-venv', 'tb', '--no-create');
    assertEq(r.status, 3, 'should signal needs-prompt');
    assert(/needs-prompt|will this be a python/i.test(r.stdout + r.stderr));
    assertEq(readStateFile(root).python_project, undefined);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('ensure-venv: idempotent — re-run reads recorded python_project, never re-prompts', () => {
  const root = makeTestbed('venv-idem');
  try {
    run(root, 'ensure-venv', 'tb', '--no-python', '--no-create');
    const r = run(root, 'ensure-venv', 'tb', '--no-create'); // no flag, but state set
    assertEq(r.status, 0, 'recorded false → no prompt');
    assertEq(readStateFile(root).python_project, false);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/v3/state/test-prism-bootstrap.mjs`
Expected: the four `ensure-venv:` tests FAIL (unknown command / status 2).

- [ ] **Step 3: Implement `detectPython` + the `ensure-venv` case**

Add near the top-of-file helpers:

```js
import {existsSync, readdirSync} from 'node:fs'; // ensure these are imported
function detectPython(root) {
  const markers = ['requirements.txt','pyproject.toml','Pipfile','setup.py','setup.cfg','manage.py'];
  if (markers.some((m) => existsSync(join(root, m)))) return true;
  try { if (readdirSync(root).some((f) => f.endsWith('.py'))) return true; } catch {}
  // one level deep (e.g. backend/)
  try {
    for (const d of readdirSync(root, {withFileTypes: true})) {
      if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') {
        const sub = join(root, d.name);
        if (markers.some((m) => existsSync(join(sub, m)))) return true;
      }
    }
  } catch {}
  return false;
}
```

In `switch (cmd)` (after the `init-state-if-missing` case), add:

```js
case 'ensure-venv': {
  const projectName = positional[0] || basename(root);
  const wantFlag = flags.includes('--python') ? true : flags.includes('--no-python') ? false : null;
  const noCreate = flags.includes('--no-create');
  const state = loadOrInitState(root, projectName); // reuse the init-state path
  let isPy = state.python_project;
  if (isPy === undefined) {
    if (wantFlag !== null) isPy = wantFlag;
    else if (detectPython(root)) isPy = true;
    else {
      stdout.write('needs-prompt: no Python detected — will this be a Python project? Re-invoke with --python or --no-python.\n');
      process.exit(3);
    }
  }
  state.python_project = isPy;
  saveState(root, state); // reuse existing state-write helper
  stdout.write(`ensure-venv: python_project=${isPy}\n`);
  if (!isPy) process.exit(0);
  // venv creation + wiring handled in A2/A3/A4 (guarded by !noCreate)
  process.exit(0);
}
```

> NOTE for implementer: use the SAME state load/save helpers the `init-state-if-missing` case uses (read its body at L610). `positional`/`flags` parsing already exists for `--root`; mirror it. `basename` from `node:path`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `node tests/v3/state/test-prism-bootstrap.mjs`
Expected: all `ensure-venv:` tests PASS; previously-green tests still PASS (39+/0).

- [ ] **Step 5: Commit**

```bash
git add tools/prism-bootstrap.mjs tests/v3/state/test-prism-bootstrap.mjs
git commit -F .git/PRISM_COMMIT_MSG.tmp   # msg: "feat(bootstrap): ensure-venv decides+records python_project"
```

### Task A2: `.gitignore` gets `.venv/`; venv created when not `--no-create`

**Files:** Modify `tools/prism-bootstrap.mjs` (extend the `ensure-venv` case); Test: same file.

- [ ] **Step 1: Failing test**

```js
test('ensure-venv: appends .venv/ to .gitignore exactly once', () => {
  const root = makeTestbed('venv-ignore');
  try {
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
    run(root, 'ensure-venv', 'tb', '--no-create');
    run(root, 'ensure-venv', 'tb', '--no-create'); // second run must not duplicate
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    const count = (gi.match(/^\.venv\/?$/gm) || []).length;
    assertEq(count, 1, 'exactly one .venv entry');
  } finally { rmSync(root, {recursive:true,force:true}); }
});
```

- [ ] **Step 2: Run — expect FAIL** (`.gitignore` not written). `node tests/v3/state/test-prism-bootstrap.mjs`

- [ ] **Step 3: Implement** — in the `ensure-venv` case, after `state.python_project=true`, before exit:

```js
// .gitignore hygiene
const giPath = join(root, '.gitignore');
let gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
if (!/^\.venv\/?$/m.test(gi)) {
  gi = gi.replace(/\s*$/, '') + (gi.trim() ? '\n' : '') + '.venv/\n';
  writeFileSync(giPath, gi);
}
// venv creation (skipped by tests via --no-create)
const venvDir = join(root, '.venv');
if (!noCreate && !existsSync(venvDir)) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const res = spawnSync(py, ['-m', 'venv', venvDir], {cwd: root, encoding: 'utf8'});
  if (res.status !== 0) stdout.write(`ensure-venv: WARN could not create .venv (${(res.stderr||'').trim()}); create it manually: ${py} -m venv .venv\n`);
}
```

- [ ] **Step 4: Run — expect PASS.** `node tests/v3/state/test-prism-bootstrap.mjs`
- [ ] **Step 5: Commit** (`feat(bootstrap): ensure-venv writes .gitignore + creates .venv`)

### Task A3: SessionStart venv PATH hook (Git Bash) + local PATH fallback

**Files:** Modify `tools/prism-bootstrap.mjs` (extend `ensure-venv`); Test: same file.

- [ ] **Step 1: Failing test**

```js
test('ensure-venv: writes a SessionStart venv PATH hook into project settings.json', () => {
  const root = makeTestbed('venv-hook');
  try {
    writeFileSync(join(root, 'manage.py'), '# django\n');
    run(root, 'ensure-venv', 'tb', '--no-create');
    const s = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
    const cmds = JSON.stringify(s.hooks?.SessionStart || []);
    assert(/CLAUDE_ENV_FILE/.test(cmds) && /\.venv/.test(cmds), 'hook wires .venv onto PATH via CLAUDE_ENV_FILE');
  } finally { rmSync(root, {recursive:true,force:true}); }
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — in `ensure-venv` (python branch), merge a SessionStart hook into `.claude/settings.json` (create dir/file if missing; do not duplicate the hook):

```js
const settingsPath = join(root, '.claude', 'settings.json');
mkdirSync(join(root, '.claude'), {recursive: true});
let st = {};
try { st = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
st.hooks = st.hooks || {};
st.hooks.SessionStart = st.hooks.SessionStart || [];
const venvHookCmd = 'if [ -n "$CLAUDE_ENV_FILE" ] && [ -d "$CLAUDE_PROJECT_DIR/.venv/Scripts" ]; then echo "export PATH=\\"$(cygpath -u \\"$CLAUDE_PROJECT_DIR\\")/.venv/Scripts:$PATH\\"" >> "$CLAUDE_ENV_FILE"; fi';
const already = JSON.stringify(st.hooks.SessionStart).includes('CLAUDE_ENV_FILE');
if (!already) st.hooks.SessionStart.push({hooks: [{type: 'command', command: venvHookCmd}]});
writeFileSync(settingsPath, JSON.stringify(st, null, 2) + '\n');
```

> The PowerShell absolute-PATH fallback (`settings.local.json`) is intentionally NOT auto-written here (machine-specific, clobber-risk). The slash command surfaces it as an optional manual step. Convention (CLAUDE.md rule, Task A4) is the guarantee.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(bootstrap): ensure-venv wires SessionStart venv PATH hook (Git Bash)`)

### Task A4: slash-command wiring + CLAUDE.md venv Operating Rule

**Files:** Modify `commands/prism-bootstrap.md` (no test — doc/LLM-facing).

- [ ] **Step 1:** In `commands/prism-bootstrap.md`, in the phase that writes/updates the project, add a **venv phase**: "Run `node ${helper} ensure-venv <slug> --root <root>`. If it exits 3 (needs-prompt), ask the user *'Will this be a Python project? Create a `.venv` and run Python under it?'* and re-invoke with `--python`/`--no-python`."
- [ ] **Step 2:** In the **Canonical CLAUDE.md template** `## PRISM Operating Rules`, add a rule: *"### N. Python env — This project uses a project-root `.venv`. Run Python via `.venv\\Scripts\\python` (Windows) / `.venv/bin/python` (POSIX). Never use system Python. (Auto-created by `/prism-bootstrap`.)"* — only when `python_project` is true.
- [ ] **Step 3: Commit** (`docs(bootstrap): document venv phase + Operating Rule`)

---

## PHASE B — embed pwagent

### Task B1: vendor pwagent source into the repo

**Files:** Create `tools/pwagent/**` (copy from `~/.claude/tools/pwagent/`, source only) + `tools/pwagent/.gitignore`.

- [ ] **Step 1:** Copy these EXACT files (use the Read tool to read each source, Write tool to write into the repo — clean UTF-8, no BOM). EXCLUDE `.venv/`, `__pycache__/`, `out/`:
  - `pwagent.cmd`, `pwagent.ps1`, `requirements.txt`
  - `src/pwagent/__init__.py`, `__main__.py`, `cli.py`, `actions.py`, `session.py`, `errors.py`
- [ ] **Step 2:** Create `tools/pwagent/.gitignore`:

```
.venv/
__pycache__/
*.pyc
out/
```

- [ ] **Step 3:** Sanity — byte-compile the vendored package with any Python to catch copy corruption:

Run: `python -m py_compile tools/pwagent/src/pwagent/*.py`
Expected: exit 0, no output.

- [ ] **Step 4: Commit** (`feat(pwagent): vendor pwagent 0.2.0 source (no venv) into tools/pwagent`)

### Task B2: add pwagent files to the install manifest

**Files:** Modify `tools/install-manifest.json`; Test: `tests/v3/state/test-prism-pwagent-install.mjs` (new).

- [ ] **Step 1: Failing test** (new file; mirror the harness style of `test-prism-git-hygiene.mjs`)

```js
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..','..','..');
let pass=0, fail=0;
function t(n,f){try{f();pass++;process.stdout.write(`  ok  ${n}\n`);}catch(e){fail++;process.stdout.write(`  FAIL ${n}\n    ${e.message}\n`);}}
const man = JSON.parse(readFileSync(join(REPO,'tools','install-manifest.json'),'utf8'));
const srcs = man.files.map(f=>f.src.replace(/\\/g,'/'));

t('manifest ships all pwagent source files', () => {
  for (const f of ['tools/pwagent/pwagent.cmd','tools/pwagent/pwagent.ps1','tools/pwagent/requirements.txt',
    'tools/pwagent/src/pwagent/__init__.py','tools/pwagent/src/pwagent/__main__.py','tools/pwagent/src/pwagent/cli.py',
    'tools/pwagent/src/pwagent/actions.py','tools/pwagent/src/pwagent/session.py','tools/pwagent/src/pwagent/errors.py'])
    if(!srcs.includes(f)) throw new Error('missing from manifest: '+f);
});
t('manifest never ships a pwagent .venv', () => {
  if (srcs.some(s=>s.includes('pwagent/.venv'))) throw new Error('.venv must not be shipped');
});
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
```

- [ ] **Step 2: Run — expect FAIL** (files not in manifest). `node tests/v3/state/test-prism-pwagent-install.mjs`
- [ ] **Step 3: Implement** — add 9 entries to `tools/install-manifest.json` `files` array, e.g.:

```json
{"src": "tools/pwagent/pwagent.cmd", "dst": "tools/pwagent/pwagent.cmd", "executable": false},
{"src": "tools/pwagent/pwagent.ps1", "dst": "tools/pwagent/pwagent.ps1", "executable": false},
{"src": "tools/pwagent/requirements.txt", "dst": "tools/pwagent/requirements.txt", "executable": false},
{"src": "tools/pwagent/src/pwagent/__init__.py", "dst": "tools/pwagent/src/pwagent/__init__.py", "executable": false},
{"src": "tools/pwagent/src/pwagent/__main__.py", "dst": "tools/pwagent/src/pwagent/__main__.py", "executable": false},
{"src": "tools/pwagent/src/pwagent/cli.py", "dst": "tools/pwagent/src/pwagent/cli.py", "executable": false},
{"src": "tools/pwagent/src/pwagent/actions.py", "dst": "tools/pwagent/src/pwagent/actions.py", "executable": false},
{"src": "tools/pwagent/src/pwagent/session.py", "dst": "tools/pwagent/src/pwagent/session.py", "executable": false},
{"src": "tools/pwagent/src/pwagent/errors.py", "dst": "tools/pwagent/src/pwagent/errors.py", "executable": false}
```

- [ ] **Step 4: Run — expect PASS.** Also run the installer's own manifest-integrity check if present: `node tools/prism-installer.mjs verify`.
- [ ] **Step 5: Commit** (`feat(pwagent): ship pwagent source via install manifest`)

### Task B3: `setupPwagent()` + `setup-pwagent` subcommand (PATH add + warm), idempotent & fail-soft

**Files:** Modify `tools/prism-installer.mjs` (new `async function setupPwagent({autoYes,dryRun})`; `case 'setup-pwagent'` at `switch(subcommand)` L1052); Test: `tests/v3/state/test-prism-pwagent-install.mjs`.

- [ ] **Step 1: Failing tests** (append to the new test file before the summary)

```js
import {spawnSync} from 'node:child_process';
const INST = join(REPO,'tools','prism-installer.mjs');
t('setup-pwagent --dry-run reports PATH+warm actions without performing them', () => {
  const r = spawnSync(process.execPath,[INST,'setup-pwagent','--dry-run'],{encoding:'utf8'});
  if (r.status!==0) throw new Error('exit '+r.status+': '+r.stderr);
  if (!/pwagent/i.test(r.stdout)) throw new Error('no pwagent setup output');
  if (!/PATH/i.test(r.stdout)) throw new Error('should mention PATH action');
});
```

- [ ] **Step 2: Run — expect FAIL** (unknown subcommand). `node tests/v3/state/test-prism-pwagent-install.mjs`

- [ ] **Step 3: Implement** `setupPwagent` and the subcommand. Behavior:
  - Resolve `dir = join(CLAUDE_DIR, 'tools', 'pwagent')`; `cmd = join(dir, 'pwagent.cmd')`.
  - **PATH add (idempotent):** read User PATH (`process.env` + on win32 `reg query "HKCU\\Environment" /v Path`); if `dir` not already a segment, append via `setx PATH "<old>;<dir>"` (or PowerShell `[Environment]::SetEnvironmentVariable('Path', ..., 'User')`). Skip + log if present.
  - **Warm:** run `cmd selftest` (triggers the tool's self-bootstrap: venv + Chromium). Fail-soft: if `pwagent.cmd` missing or Python absent, log a manual step and return 0.
  - `--dry-run`: print the PATH command + warm command, perform neither, exit 0.
  - `--with-pwagent`/`autoYes`: perform without prompting. Interactive (no flag): print the consent line and, if `process.stdin.isTTY`, read y/N; else default to "files only" + print steps.

```js
async function setupPwagent({autoYes = false, dryRun = false} = {}) {
  const dir = join(CLAUDE_DIR, 'tools', 'pwagent');
  const cmd = join(dir, 'pwagent.cmd');
  const onPath = (process.env.PATH || '').split(/[;:]/).some((p) => p && p.replace(/\\/g,'/').toLowerCase() === dir.replace(/\\/g,'/').toLowerCase());
  const pathCmd = process.platform === 'win32'
    ? `[Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ';${dir}'), 'User')`
    : `# add ${dir} to PATH in your shell rc`;
  if (dryRun) {
    log(`[pwagent] would add to User PATH: ${dir}`);
    log(`[pwagent] would warm: "${cmd}" selftest`);
    return 0;
  }
  if (!autoYes && !(process.stdin.isTTY)) {
    log(`[pwagent] shipped to ${dir}. To enable: add it to PATH and run "${cmd}" selftest (creates venv + downloads Chromium ~150MB).`);
    return 0;
  }
  // (interactive y/N omitted here for brevity — see executing notes; default safe)
  if (!onPath && process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile','-Command', pathCmd], {encoding:'utf8'});
    log(r.status === 0 ? `[pwagent] added to User PATH (new shells): ${dir}` : `[pwagent] WARN PATH add failed; add manually: ${dir}`);
  } else if (onPath) { log(`[pwagent] already on PATH: ${dir}`); }
  if (existsSync(cmd)) {
    log('[pwagent] warming venv + Chromium (first run, ~150MB)...');
    const w = spawnSync(cmd, ['selftest'], {encoding:'utf8', stdio:'inherit'});
    if (w.status !== 0) log('[pwagent] WARN warm failed (Python 3.12 / network?). Run "'+cmd+' selftest" later.');
  } else { log('[pwagent] WARN pwagent.cmd missing; reinstall PRISM.'); }
  return 0;
}
```

Add to `switch (subcommand)` (L1052):

```js
case 'setup-pwagent':
  process.exit(await setupPwagent({autoYes: restArgs.includes('--with-pwagent') || restArgs.includes('--yes'), dryRun: restArgs.includes('--dry-run')}));
  break;
```

- [ ] **Step 4: Run — expect PASS.** `node tests/v3/state/test-prism-pwagent-install.mjs`
- [ ] **Step 5: Commit** (`feat(installer): setup-pwagent — idempotent PATH add + warm`)

### Task B4: wire consent into install/update

**Files:** Modify `tools/prism-installer.mjs` (`install()` L591, `runUpdate()` L864).

- [ ] **Step 1:** After the file-copy + version-marker steps in both `install()` and `runUpdate()`, add:

```js
// pwagent: offer setup (consent-gated; honors --with-pwagent for non-interactive)
try { await setupPwagent({autoYes: rawArgs.includes('--with-pwagent')}); } catch (e) { log('[pwagent] setup skipped: ' + e.message); }
```

- [ ] **Step 2:** Manually verify update path stays green and fail-soft:

Run: `node tools/prism-installer.mjs update`
Expected: completes; prints a `[pwagent]` line (either "shipped… to enable…" non-TTY, or warm output); installer still reports success.

- [ ] **Step 3: Commit** (`feat(installer): offer pwagent setup during install/update`)

---

## SHIP

### Task S1: version + changelog + full regression + push

- [ ] **Step 1:** Bump `.claude-plugin/plugin.json` and `tools/install-manifest.json` `prism_version` → `5.2.15`.
- [ ] **Step 2:** Prepend a `## [5.2.15]` CHANGELOG entry (both features, with the PATH-injection + self-bootstrap caveats).
- [ ] **Step 3: Full regression** — MUST be green:

Run: `node tools/prism-audit-runner.mjs` (29/29) and the full `tests/v3/state/test-prism-*.mjs` sweep (expect 54/54 — 53 prior + new pwagent suite).
- [ ] **Step 4:** Commit via `.git/PRISM_COMMIT_MSG.tmp` + `git commit -F`; clear stale `.git/index.lock` via `node -e "..."` if needed; `git push origin main`; `node tools/prism-installer.mjs update`.

---

## Self-Review (run before execution)

- **Spec coverage:** A1–A4 cover Feature A (detect/greenfield-remember/create/.gitignore/enforcement = convention via A4 doc + Git-Bash hook via A3; PowerShell fallback intentionally manual per spec §3.A4). B1–B4 cover Feature B (vendor/manifest/self-bootstrap-is-builtin/consent PATH+warm/`--with-pwagent`). S1 = rollout. ✓
- **Placeholders:** the interactive y/N in B3 is deliberately summarized — implementer must add a TTY prompt (default = files-only). Flagged, not hidden. All other steps carry real code.
- **Type/name consistency:** `python_project` (state key), `ensure-venv`, `setupPwagent`/`setup-pwagent`, `--with-pwagent`, `--no-create`, `--dry-run` used consistently across tasks. ✓
- **Risk:** A3 hook + A4 PowerShell fallback degrade to convention-only on unsupported builds (spec §2). B3/B4 are fail-soft and consent-gated.
