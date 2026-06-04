# Contributing to PRISM

Thanks for your interest in improving PRISM. This is a small, focused project — issues and pull requests are welcome.

## Ground rules

- **PRISM is local-first and dep-free at its core.** Don't add network calls, telemetry, or third-party runtime dependencies to the hooks/tools without a strong reason and an opt-in switch. The whole value proposition is "nothing leaves your machine unless you ask."
- **Determinism over cleverness.** The hooks and the bootstrap state machine are deterministic Node — keep them that way. LLM-driven behavior lives in the skills/agents, not the hooks.
- **Windows-first.** Code must run on Windows (PowerShell + Git Bash) as well as macOS/Linux. Use `fs.mkdirSync`, not `spawnSync('mkdir', …)`; write clean UTF-8 (no BOM); avoid POSIX-only idioms in shipped scripts.

## Development setup

```bash
git clone https://github.com/vosser24/prism_5.git
cd prism_5
node tools/prism-installer.mjs verify   # sanity-check a local install
```

## Before you open a PR

1. **Run the test suite** — every assertion must pass:
   ```bash
   # all state suites
   for f in tests/v3/state/test-prism-*.mjs; do node "$f"; done
   # the synthetic end-to-end audit
   node tools/prism-audit-runner.mjs
   ```
   (On Windows PowerShell: `Get-ChildItem tests/v3/state/test-prism-*.mjs | ForEach-Object { node $_.FullName }`.)
2. **Add a test** for any behavior change. PRISM is test-driven — a fix without a regression test will be asked to add one.
3. **Update `CHANGELOG.md`** with a dated entry describing the change and its root cause.
4. **Bump the version** (`.claude-plugin/plugin.json` + `tools/install-manifest.json`) for anything that ships.

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and the relevant `PRISM …` hook output if any. Include your OS/shell (PowerShell, Git Bash, etc.) and Node version.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
