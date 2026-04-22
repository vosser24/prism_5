# Legacy — monolithic installer archive

This directory preserves the previous single-file installer format for reference.

## `prism_pro_210.py`

The original 894 KB monolithic PRISM installer. Every file that ends up in
`~/.claude/` was embedded as a Python string literal inside a single `CONTENT`
dict. Running `python prism_pro_210.py` wrote all 64 files, patched
`settings.json`, applied hotfixes A–G, and ran a 126-test verification suite.

**Superseded** (2026-04-22) by the modular repo layout at the project root:

| What | Monolithic | Modular |
|---|---|---|
| Single-file deploy | ✓ | one `git clone` command |
| Offline install | ✓ | ✗ (needs network once) |
| Edit/customize one file | escaping nightmare | edit, commit, done |
| Diffable updates | 894 KB blob | real `git diff` |
| Version history | — | git log |
| Hotfix patching | runtime string replace | files ship correct |

The modular layout ships post-hotfix state directly — no step_21b runtime
patching needed. Patches F + G (P2.24 prompt rewrite + skip-safety) are baked
into `tools/test-prism-gaps.mjs` at rest.

Kept here so the history isn't lost. Not maintained going forward — bug fixes
and features land in the modular files.
