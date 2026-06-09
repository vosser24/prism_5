// PRISM State File Module — v3.11.0 Phase B (schema v2)
//
// Owns ./.claude/.prism-state.json (project-local).
// Parent design: docs/prism/adjudications/D001-bootstrap-unification.md §State management
// Locked refinements:  docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md
// v2 sentinels:        docs/prism/adjudications/D004-v4-product-vision.md §4
//
// Schema v2 (locked):
//   schema_version          integer; 2 for current release. v1 files are
//                           migrated transparently on read.
//   prism_version           string, which PRISM wrote this state
//   project_name            string
//   initialized_at          ISO-8601 (UTC, ms-precision Z)
//   last_run                ISO-8601 (most recent /prism-bootstrap or /prism-sync)
//   last_sync_at            ISO-8601 (most recent /prism-sync completion; null until run)
//   next_sync_recommended   ISO-8601 (advisory; null until first sync)
//   phases                  object — keys are the 7 PHASES below.
//                           each entry is a SENTINEL:
//                             { status, started_at, completed_at, artifact_hashes, ...metadata }
//                           where status ∈ {'in-progress', 'complete', 'failed', null}.
//                           null = not started.
//   last_command            string | null  (for crash resume)
//   phase_failures          array, capped at last 10  ({ phase, at, error })
//   checksum                string — sha256 hex of canonical JSON of all OTHER fields
//
// Sentinel semantics (D004 §4):
//   complete    → orchestrator skips
//   in-progress → orchestrator restarts (crash resume)
//   failed      → orchestrator restarts (next-run retry)
//   null        → orchestrator runs
//
// v1 → v2 migration: read-time only. Existing v1 state files load as v2;
// the next write embeds schema_version: 2 + the new sentinel fields. The
// migration preserves any v1 metadata (synthesized, dirs_created, etc).
// New v2-only phases (plugin-validate, project-master) start at status: null.

import {createHash} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {dirname, join} from 'node:path';

export const SCHEMA_VERSION = 2;
export const PRISM_VERSION = '5.5.0';
export const STATE_DIR = '.claude';
export const STATE_FILENAME = '.prism-state.json';
// v2 phase order (D004 §4). v1 had: identity, structure, discovery, roster, health.
// v2 adds: plugin-validate (after structure), project-master (after roster, opt-in only).
export const PHASES = [
  'identity',
  'structure',
  'plugin-validate',
  'discovery',
  'roster',
  'project-master',
  'health',
];
export const MAX_PHASE_FAILURES = 10;
export const PHASE_STATUSES = ['in-progress', 'complete', 'failed'];

// ---------- Path helpers ----------

export function getStateDir(projectRoot) {
  return join(projectRoot, STATE_DIR);
}

export function getStatePath(projectRoot) {
  return join(projectRoot, STATE_DIR, STATE_FILENAME);
}

// ---------- Time ----------

export function nowIso() {
  return new Date().toISOString();
}

// ---------- Initial state ----------

function emptyPhaseEntry() {
  return {
    status: null,
    started_at: null,
    completed_at: null,
    artifact_hashes: [],
  };
}

export function createInitialState(projectName, {now = nowIso()} = {}) {
  const phases = {};
  for (const p of PHASES) phases[p] = emptyPhaseEntry();
  return {
    schema_version: SCHEMA_VERSION,
    prism_version: PRISM_VERSION,
    project_name: String(projectName ?? ''),
    project_slug: null,             // D004 §1: locked once /prism-deep-dive derives it
    initialized_at: now,
    last_run: now,
    last_sync_at: null,
    next_sync_recommended: null,
    phases,
    last_command: null,
    phase_failures: [],
    checksum: null,
  };
}

// ---------- Canonical serialization (deterministic for hashing) ----------

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = canonicalize(value[k]);
  }
  return out;
}

export function computeChecksum(state) {
  const {checksum: _ignore, ...rest} = state;
  const canonical = JSON.stringify(canonicalize(rest));
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------- v1 → v2 migration ----------

// Pure: returns a new state object. Does NOT touch the checksum field; caller
// must recompute on write. Preserves all metadata fields from the v1 phase
// entries (synthesized, dirs_created, conventions_written, etc).
export function migrateV1ToV2(state) {
  if (!state || typeof state !== 'object') return state;
  if (state.schema_version === 2) return state;
  if (state.schema_version !== 1) {
    throw new Error(`cannot migrate: unknown schema_version ${state.schema_version}`);
  }
  const oldPhases = state.phases || {};
  const newPhases = {};
  for (const p of PHASES) {
    const old = oldPhases[p] || {};
    const completed_at = old.completed_at || null;
    const status = completed_at ? 'complete' : null;
    // Preserve all metadata except the original completed_at (we'll re-add it).
    const {completed_at: _drop, ...meta} = old;
    newPhases[p] = {
      ...meta,
      status,
      started_at: completed_at,  // best-effort estimate from v1 data
      completed_at,
      artifact_hashes: Array.isArray(old.artifact_hashes) ? old.artifact_hashes : [],
    };
  }
  return {
    ...state,
    schema_version: 2,
    prism_version: PRISM_VERSION,
    project_slug: state.project_slug ?? null,  // D004 §1: seed v2-only field
    phases: newPhases,
    checksum: null,  // invalidated by migration; caller rewrites
  };
}

// ---------- Validation ----------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isIsoOrNull(v) {
  return v === null || (typeof v === 'string' && ISO_RE.test(v));
}

function isStatusOrNull(v) {
  return v === null || PHASE_STATUSES.includes(v);
}

export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {ok: false, errors: ['state is not an object']};
  }
  if (!Number.isInteger(state.schema_version) || state.schema_version < 1) {
    errors.push('schema_version must be a positive integer');
  }
  if (typeof state.prism_version !== 'string' || !state.prism_version) {
    errors.push('prism_version must be a non-empty string');
  }
  if (typeof state.project_name !== 'string') {
    errors.push('project_name must be a string');
  }
  if (typeof state.initialized_at !== 'string' || !ISO_RE.test(state.initialized_at)) {
    errors.push('initialized_at must be ISO-8601');
  }
  if (typeof state.last_run !== 'string' || !ISO_RE.test(state.last_run)) {
    errors.push('last_run must be ISO-8601');
  }
  if (!isIsoOrNull(state.last_sync_at)) {
    errors.push('last_sync_at must be ISO-8601 or null');
  }
  if (!isIsoOrNull(state.next_sync_recommended)) {
    errors.push('next_sync_recommended must be ISO-8601 or null');
  }
  if (!state.phases || typeof state.phases !== 'object') {
    errors.push('phases must be an object');
  } else {
    const isV2 = state.schema_version >= 2;
    for (const p of PHASES) {
      const ph = state.phases[p];
      if (!ph || typeof ph !== 'object') {
        errors.push(`phases.${p} missing`);
        continue;
      }
      if (!('completed_at' in ph) || !isIsoOrNull(ph.completed_at)) {
        errors.push(`phases.${p}.completed_at must be ISO-8601 or null`);
      }
      if (isV2) {
        if (!('status' in ph) || !isStatusOrNull(ph.status)) {
          errors.push(`phases.${p}.status must be one of ${PHASE_STATUSES.join('|')} or null`);
        }
        if (!('started_at' in ph) || !isIsoOrNull(ph.started_at)) {
          errors.push(`phases.${p}.started_at must be ISO-8601 or null`);
        }
        if (!('artifact_hashes' in ph) || !Array.isArray(ph.artifact_hashes)) {
          errors.push(`phases.${p}.artifact_hashes must be an array`);
        }
      }
    }
  }
  if (state.last_command !== null && typeof state.last_command !== 'string') {
    errors.push('last_command must be string or null');
  }
  if (!Array.isArray(state.phase_failures)) {
    errors.push('phase_failures must be an array');
  } else if (state.phase_failures.length > MAX_PHASE_FAILURES) {
    errors.push(`phase_failures exceeds cap of ${MAX_PHASE_FAILURES}`);
  }
  if (state.checksum !== null && typeof state.checksum !== 'string') {
    errors.push('checksum must be string or null');
  }
  return {ok: errors.length === 0, errors};
}

// v1 validator — used by readState() only, before migration. Checks the
// shape that v1 actually wrote: 5 phases, each with `completed_at`, no
// sentinel fields. Sealed semantics — never extended.
const V1_PHASES = ['identity', 'structure', 'discovery', 'roster', 'health'];
function validateStateV1(state) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {ok: false, errors: ['state is not an object']};
  }
  if (state.schema_version !== 1) {
    errors.push('expected schema_version=1');
  }
  if (typeof state.prism_version !== 'string' || !state.prism_version) {
    errors.push('prism_version must be a non-empty string');
  }
  if (typeof state.project_name !== 'string') {
    errors.push('project_name must be a string');
  }
  if (typeof state.initialized_at !== 'string' || !ISO_RE.test(state.initialized_at)) {
    errors.push('initialized_at must be ISO-8601');
  }
  if (typeof state.last_run !== 'string' || !ISO_RE.test(state.last_run)) {
    errors.push('last_run must be ISO-8601');
  }
  if (!state.phases || typeof state.phases !== 'object') {
    errors.push('phases must be an object');
  } else {
    for (const p of V1_PHASES) {
      const ph = state.phases[p];
      if (!ph || typeof ph !== 'object') {
        errors.push(`phases.${p} missing`);
        continue;
      }
      if (!('completed_at' in ph) || !isIsoOrNull(ph.completed_at)) {
        errors.push(`phases.${p}.completed_at must be ISO-8601 or null`);
      }
    }
  }
  if (!Array.isArray(state.phase_failures)) {
    errors.push('phase_failures must be an array');
  }
  return {ok: errors.length === 0, errors};
}

export function verifyChecksum(state) {
  if (typeof state?.checksum !== 'string') return false;
  return computeChecksum(state) === state.checksum;
}

// ---------- Read ----------

// Status: 'ok' | 'missing' | 'unreadable' | 'invalid_json' | 'invalid_schema' | 'checksum_mismatch'
//
// v1 migration: if the parsed object has schema_version=1, the checksum is
// verified against the v1 shape first, then the state is migrated to v2
// in memory. The returned state has schema_version=2 and migrated:true so
// callers know to rewrite. Status remains 'ok' on a successful migration.
export function readState(projectRoot) {
  const path = getStatePath(projectRoot);
  if (!existsSync(path)) {
    return {state: null, status: 'missing', errors: [], raw: null};
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return {state: null, status: 'unreadable', errors: [String(e.message || e)], raw: null};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {state: null, status: 'invalid_json', errors: [String(e.message || e)], raw};
  }
  // Schema-version dispatch. v1 files use v1 validation (looser — no sentinel
  // requirement) so a legitimately-saved v1 file can be migrated cleanly. v2
  // files get the strict v2 validation.
  if (parsed && parsed.schema_version === 1) {
    const v = validateStateV1(parsed);
    if (!v.ok) {
      return {state: parsed, status: 'invalid_schema', errors: v.errors, raw};
    }
    if (!verifyChecksum(parsed)) {
      return {state: parsed, status: 'checksum_mismatch', errors: ['checksum mismatch'], raw};
    }
    const migrated = migrateV1ToV2(parsed);
    return {state: migrated, status: 'ok', errors: [], raw, migrated: true};
  }
  const v = validateState(parsed);
  if (!v.ok) {
    return {state: parsed, status: 'invalid_schema', errors: v.errors, raw};
  }
  if (!verifyChecksum(parsed)) {
    return {state: parsed, status: 'checksum_mismatch', errors: ['checksum mismatch'], raw};
  }
  return {state: parsed, status: 'ok', errors: [], raw};
}

// ---------- Write (atomic) ----------

// Retry an atomic rename across transient Windows/SMB locks (EPERM/EBUSY) where
// a file-watcher/AV momentarily holds the target. renameFn lets tests inject failures.
export function renameWithRetry(renameFn, tmp, dst, { retries = 5, delayMs = 25 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { renameFn(tmp, dst); return; }
    catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!transient || attempt >= retries) throw e;
      // synchronous backoff (this is a sync function): Atomics.wait on a throwaway buffer
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt); } catch { /* fallback: busy spin */ }
    }
  }
}

export function writeStateAtomic(projectRoot, state) {
  const v = validateState(state);
  if (!v.ok) {
    throw new Error('refusing to write invalid state: ' + v.errors.join('; '));
  }
  const dir = getStateDir(projectRoot);
  const path = getStatePath(projectRoot);
  mkdirSync(dir, {recursive: true});

  const stamped = {...state, checksum: null};
  stamped.checksum = computeChecksum(stamped);

  const body = JSON.stringify(stamped, null, 2) + '\n';

  const tmp = path + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
  let fd;
  try {
    fd = openSync(tmp, 'w', 0o644);
    writeSync(fd, body, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  try {
    renameWithRetry(renameSync, tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return {path, checksum: stamped.checksum};
}

// ---------- Mutators (return new state; pure) ----------

export function markPhaseStarted(state, phaseName, {now = nowIso()} = {}) {
  if (!PHASES.includes(phaseName)) {
    throw new Error(`unknown phase: ${phaseName}`);
  }
  const prev = state.phases?.[phaseName] || emptyPhaseEntry();
  return {
    ...state,
    last_run: now,
    phases: {
      ...state.phases,
      [phaseName]: {
        ...prev,
        status: 'in-progress',
        started_at: now,
      },
    },
  };
}

export function markPhaseCompleted(state, phaseName, metadata = {}, {now = nowIso()} = {}) {
  if (!PHASES.includes(phaseName)) {
    throw new Error(`unknown phase: ${phaseName}`);
  }
  const prev = state.phases?.[phaseName] || emptyPhaseEntry();
  const meta = {...metadata};
  // artifact_hashes flows through metadata when the caller wants to set it;
  // otherwise we keep the previous value. Don't double-merge.
  const artifact_hashes = Array.isArray(meta.artifact_hashes)
    ? meta.artifact_hashes
    : (Array.isArray(prev.artifact_hashes) ? prev.artifact_hashes : []);
  delete meta.artifact_hashes;

  const next = {
    ...state,
    last_run: now,
    phases: {
      ...state.phases,
      [phaseName]: {
        ...prev,
        ...meta,
        status: 'complete',
        started_at: prev.started_at || now,
        completed_at: now,
        artifact_hashes,
      },
    },
  };
  if (next.last_command && next.last_command.includes(phaseName)) {
    next.last_command = null;
  }
  return next;
}

export function markPhaseFailed(state, phaseName, errorMessage, {now = nowIso()} = {}) {
  const failures = Array.isArray(state.phase_failures) ? state.phase_failures.slice() : [];
  failures.push({phase: String(phaseName), at: now, error: String(errorMessage ?? '')});
  while (failures.length > MAX_PHASE_FAILURES) failures.shift();
  const phases = {...state.phases};
  // Mark the phase entry itself as failed so the orchestrator's planner sees it.
  // Only valid known phases get their entry mutated; unknown names just go in
  // the phase_failures log (defensive — caller may misspell).
  if (PHASES.includes(phaseName)) {
    const prev = phases[phaseName] || emptyPhaseEntry();
    phases[phaseName] = {...prev, status: 'failed'};
  }
  return {
    ...state,
    last_run: now,
    phases,
    phase_failures: failures,
  };
}

export function setLastCommand(state, command, {now = nowIso()} = {}) {
  return {...state, last_command: command === null ? null : String(command), last_run: now};
}

export function setSyncStamps(state, {at = nowIso(), nextRecommended = null} = {}) {
  return {
    ...state,
    last_sync_at: at,
    last_run: at,
    next_sync_recommended: nextRecommended,
  };
}

// D004 §1: lock the project_slug for determinism across re-runs.
// Called once by /prism-deep-dive after the slug is derived.
export function setProjectSlug(state, slug) {
  const trimmed = String(slug || '').trim();
  if (!trimmed) throw new Error('setProjectSlug: slug must be non-empty');
  // Set checksum to null (not undefined) so writeStateAtomic's validator passes
  // and the stamp step recomputes a fresh hash. Stripping the key produced
  // undefined, which the validator rejects (Task 9 follow-up).
  return {...state, project_slug: trimmed, checksum: null};
}

export function isPhaseCompleted(state, phaseName) {
  const ph = state?.phases?.[phaseName];
  if (!ph) return false;
  // v2 preferred path: explicit status. v1-migrated and legacy phases fall
  // back to the completed_at-truthy semantics.
  return ph.status === 'complete' || Boolean(ph.completed_at);
}

// ---------- Detect-and-adopt (v3.8.9 → current migration) ----------

// Given a project root that already has a partially-populated .claude/ tree from
// v3.8.9 but no state file, synthesize a best-effort v2 state object marking the
// phases whose filesystem evidence is present. New v2-only phases (plugin-validate,
// project-master) are NOT auto-synthesized — they have no filesystem signal under
// v3.8.9. Per D004 §4: "Detect-and-adopt marks phases synthesized: true ONLY if
// no sentinel exists AND artifacts are demonstrably present on disk."
export function synthesizeFromFilesystem(projectRoot, {now = nowIso(), projectName} = {}) {
  const exists = (...parts) => existsSync(join(projectRoot, ...parts));
  const dirHasFiles = (rel) => {
    const p = join(projectRoot, rel);
    if (!existsSync(p)) return false;
    try {
      const s = statSync(p);
      if (!s.isDirectory()) return false;
    } catch { return false; }
    return true;
  };

  const hasIdentity = exists('CLAUDE.md');
  const hasStructure =
    exists(STATE_DIR) &&
    (dirHasFiles(`${STATE_DIR}/references`) ||
      dirHasFiles(`${STATE_DIR}/rules`) ||
      dirHasFiles(`${STATE_DIR}/agents`) ||
      dirHasFiles(`${STATE_DIR}/hooks`));
  const hasDiscovery = dirHasFiles(`${STATE_DIR}/references`);
  const hasRoster = exists(`${STATE_DIR}/agents/roster.json`);
  // No reliable filesystem signal for a successful health phase under v3.8.9.
  const hasHealth = false;

  const state = createInitialState(projectName ?? deriveProjectName(projectRoot), {now});
  const adopt = (phase) => {
    state.phases[phase] = {
      status: 'complete',
      started_at: now,
      completed_at: now,
      artifact_hashes: [],
      synthesized: true,
    };
  };
  if (hasIdentity) adopt('identity');
  if (hasStructure) adopt('structure');
  if (hasDiscovery) adopt('discovery');
  if (hasRoster) adopt('roster');
  if (hasHealth) adopt('health');
  // plugin-validate, project-master: never auto-synthesize (D004 §4).
  return state;
}

function deriveProjectName(projectRoot) {
  const parts = projectRoot.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'project';
}
