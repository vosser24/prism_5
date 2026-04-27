# RFC-0: PRISM RFC Discipline

**Status:** Active doctrine
**Applies to:** every PRISM RFC (rfc-1 onward)
**Last updated:** 2026-04-27

## Why this exists

The v3.8.5 → v3.8.9 release sequence shipped 5 patches in a single session due to bugs that should have been caught upfront:
- v3.8.5: PS 7-only `??` operator missed in code review
- v3.8.6: Inline `$($_.X)` subexpression caused PS 5.1 parser failure
- v3.8.7: Ten more `$()` interpolations cascaded the same failure pattern
- v3.8.8: `$PSVersionTable.Platform` missing on PS 5.1 under StrictMode
- v3.8.9: install scripts cloned the wrong default branch

Every one of these was preventable with stricter pre-ship discipline. RFC-0 makes that discipline mandatory.

## The 7 mandatory sections

Every PRISM RFC must include these sections (in order):

### 1. Frontmatter
```yaml
status: draft | review | accepted | shipped
version-against: v3.X.Y       # the PRISM version the RFC was written against
severity: trivial | minor | major | critical
dependencies: [rfc-N, rfc-M]  # other RFCs that must ship first
breaks-back-compat: yes | no
estimated-loc: N
```

### 2. Reproduction story
A concrete artifact (file path, command output, or transcript snippet) demonstrating the failure mode. RFCs without reproduction = guesses. No exceptions.

### 3. Risk inventory
Table of every plausible failure mode the RFC introduces, with severity + mitigation. Format:

| Risk | Severity | Mitigation |
|------|----------|-----------|
| ... | ... | ... |

Minimum 3 risks. If you can't think of 3, you haven't thought hard enough.

### 4. Feature flag
Every change ships behind an env var, OFF by default, for at least one release cycle. Name format: `PRISM_<RFC_SLUG>=1`.

Example: RFC-1 ships behind `PRISM_ROSTER_SCHEMA_V2=1`. Code paths must check the flag and fall back to legacy behavior when off.

### 5. Acceptance criteria
Numbered list. Each criterion must be:
- Independently verifiable (can be checked by running a command or reading a file)
- Includes at least ONE runtime test in `tests/v3/run-runtime.sh` (not just static checks)

### 6. Telemetry signal
How will we know in production that the feature is working? At minimum, append a JSONL event to `~/.claude/.prism-routing.jsonl` that `/prism-telemetry` can aggregate. RFCs without telemetry = blind shipping.

### 7. Out-of-scope
Explicit list of related work that this RFC deliberately excludes. Future-RFC pointers welcome. The point is to prevent scope creep at PR review time.

## Implementation discipline

### One RFC per release
A PRISM release ships at most ONE accepted RFC + bug fixes. Multi-RFC releases compound risk and obscure root cause when something breaks.

### Release-candidate before main
Every RFC ships first as `vX.Y.Z-rcN` to a single dogfood project (currently: ServosY's Nexus Tasks). Telemetry runs for ≥1 week. Only after a clean week does the RC promote to vX.Y.Z on main.

### Runtime tests are mandatory
Every RFC's PR must include at least one new test in `tests/v3/run-runtime.sh` that:
- Synthesizes input
- Runs the changed hook/code
- Asserts expected behavior

PRs that only update `tests/v3/run-static.sh` (file existence + brace balance) are insufficient. Static checks would have caught zero of v3.8.5–v3.8.9.

### Cross-platform validation
Any change touching `*.ps1`, `*.sh`, or hook code that shells out must be validated on:
- Windows PowerShell 5.1 (StrictMode default)
- PowerShell 7+
- bash (Linux + Mac)

The PR description must include a "tested on" list. PRs without this list are not ready for review.

### Surface decisions upfront
If during implementation a decision is made that diverges from the RFC (e.g., serial execution instead of parallel dispatch, or fallback path activated), it must be surfaced in the PR description before merge. Quiet divergence from the RFC = surprise for the maintainer.

## Anti-patterns (caught examples)

### "Even when Agent IS available, for sub-30-line patches the overhead loses"
Asserted without measurement. Anti-pattern. Either measure (hook performance baseline) and cite the number, or follow the RFC.

### "PRISM v2.7.1 dispatch-advisor explicitly says..."
Citing stale doctrine. Anti-pattern. Always cite against current HEAD; if the doctrine changed, the citation is invalid.

### "I'll fix it serially, ~3 min remaining" (without surfacing the divergence)
Quiet downgrade from RFC's intent. Anti-pattern. Surface the change, get user/maintainer ack, then proceed.

## Telemetry RFC for RFC-0 itself

This document is itself subject to telemetry: track how many RFCs land that follow vs skip the 7 mandatory sections. Goal: 100% follow within 3 release cycles.

## Maintenance

RFC-0 is the only RFC that can be updated in-place after acceptance. Update notes go in a `## Changelog` section at the bottom. All other RFCs are write-once-then-amend-by-new-RFC.

## Changelog

_(no entries yet)_
