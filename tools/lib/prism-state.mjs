// PRISM State File Module — v3.10.0 Phase 1
//
// Owns ./.claude/.prism-state.json (project-local).
// Parent design: docs/prism/adjudications/D001-bootstrap-unification.md §State management
// Locked refinements:  docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md
//
// Schema (locked):
//   schema_version          integer, starts at 1, decoupled from product version
//   prism_version           string, which PRISM wrote this state
//   project_name            string
//   initialized_at          ISO-8601 (UTC, ms-precision Z)
//   last_run                ISO-8601 (most recent /prism-bootstrap or /prism-sync)
//   last_sync_at            ISO-8601 (most recent /prism-sync completion; null until run)
//   next_sync_recommended   ISO-8601 (advisory; null until first sync)
//   phases                  object — keys: identity, structure, discovery, roster, health
//                           each { completed_at: ISO-8601 | null, ...metadata }
//   last_command            string | null  (for crash resume — value during a run, cleared on success)
//   phase_failures          array, capped at last 10  ({ phase, at, error })
//   checksum                string — sha256 hex of canonical JSON of all OTHER fields
//
// Ephemeral, NOT persisted: drift_signals — computed fresh by /prism-sync each invocation.
//
// Atomic write strategy: serialize to temp file in same directory, fsync, rename.
// On crash mid-write: temp file may exist but real state is intact (rename is atomic on
// POSIX same-volume; Windows fs.renameSync replaces target).
//
// Detect-and-adopt: synthesizeFromFilesystem() inspects .claude/ subtree to back-fill
// state when migrating from v3.8.9 (which had no state file).

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

export const SCHEMA_VERSION = 1;
export const PRISM_VERSION = '3.10.0';
export const STATE_DIR = '.claude';
export const STATE_FILENAME = '.prism-state.json';
export const PHASES = ['identity', 'structure', 'discovery', 'roster', 'health'];
export const MAX_PHASE_FAILURES = 10;

// ---------- Path helpers ----------

export function getStateDir(projectRoot) {
  return join(projectRoot, STATE_DIR);
}

export function getStatePath(projectRoot) {
  return join(projectRoot, STATE_DIR, STATE_FILENAME);
}

// ---------- Time ----------

export function nowIso() {
  // ms-precision UTC; consistent across platforms
  return new Date().toISOString();
}

// ---------- Initial state ----------

export function createInitialState(projectName, {now = nowIso()} = {}) {
  const phases = {};
  for (const p of PHASES) phases[p] = {completed_at: null};
  return {
    schema_version: SCHEMA_VERSION,
    prism_version: PRISM_VERSION,
    project_name: String(projectName ?? ''),
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
  // Hash everything EXCEPT the checksum field itself.
  const {checksum: _ignore, ...rest} = state;
  const canonical = JSON.stringify(canonicalize(rest));
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------- Validation ----------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isIsoOrNull(v) {
  return v === null || (typeof v === 'string' && ISO_RE.test(v));
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
    for (const p of PHASES) {
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

export function verifyChecksum(state) {
  if (typeof state?.checksum !== 'string') return false;
  return computeChecksum(state) === state.checksum;
}

// ---------- Read ----------

// Result shape: { state, status, errors, raw }
//   status = 'ok' | 'missing' | 'unreadable' | 'invalid_json' | 'invalid_schema' | 'checksum_mismatch'
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

// Writes UTF-8 (no BOM, LF line endings) via temp + rename.
// Sets checksum based on payload before write.
export function writeStateAtomic(projectRoot, state) {
  const v = validateState(state);
  if (!v.ok) {
    throw new Error('refusing to write invalid state: ' + v.errors.join('; '));
  }
  const dir = getStateDir(projectRoot);
  const path = getStatePath(projectRoot);
  mkdirSync(dir, {recursive: true});

  // Compute checksum on a copy with checksum=null then embed the result.
  const stamped = {...state, checksum: null};
  stamped.checksum = computeChecksum(stamped);

  // Pretty-print for human inspection; trailing LF.
  const body = JSON.stringify(stamped, null, 2) + '\n';

  // Temp file in same directory so rename is same-volume.
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
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return {path, checksum: stamped.checksum};
}

// ---------- Mutators (return new state; pure) ----------

export function markPhaseCompleted(state, phaseName, metadata = {}, {now = nowIso()} = {}) {
  if (!PHASES.includes(phaseName)) {
    throw new Error(`unknown phase: ${phaseName}`);
  }
  const next = {
    ...state,
    last_run: now,
    phases: {
      ...state.phases,
      [phaseName]: {
        ...(state.phases?.[phaseName] || {}),
        ...metadata,
        completed_at: now,
      },
    },
  };
  // Idempotent: clear last_command if it referred to this phase.
  if (next.last_command && next.last_command.includes(phaseName)) {
    next.last_command = null;
  }
  return next;
}

export function markPhaseFailed(state, phaseName, errorMessage, {now = nowIso()} = {}) {
  const failures = Array.isArray(state.phase_failures) ? state.phase_failures.slice() : [];
  failures.push({phase: String(phaseName), at: now, error: String(errorMessage ?? '')});
  while (failures.length > MAX_PHASE_FAILURES) failures.shift();
  return {
    ...state,
    last_run: now,
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

export function isPhaseCompleted(state, phaseName) {
  return Boolean(state?.phases?.[phaseName]?.completed_at);
}

// ---------- Detect-and-adopt (v3.8.9 → v3.10.0 migration) ----------

// Given a project root that already has a partially-populated .claude/ tree from
// v3.8.9 but no state file, synthesize a best-effort state object marking the
// phases whose filesystem evidence is present. Caller decides whether to write it.
export function synthesizeFromFilesystem(projectRoot, {now = nowIso(), projectName} = {}) {
  const claudeDir = join(projectRoot, STATE_DIR);
  const exists = (...parts) => existsSync(join(projectRoot, ...parts));
  const dirHasFiles = (rel) => {
    const p = join(projectRoot, rel);
    if (!existsSync(p)) return false;
    try {
      const s = statSync(p);
      if (!s.isDirectory()) return false;
      // node:fs readdirSync via child — keep this module dependency-light;
      // we use existsSync on common children below.
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
  // synthesized state is older — initialized_at is "unknown but no later than now"
  if (hasIdentity) state.phases.identity = {completed_at: now, synthesized: true};
  if (hasStructure) state.phases.structure = {completed_at: now, synthesized: true};
  if (hasDiscovery) state.phases.discovery = {completed_at: now, synthesized: true};
  if (hasRoster) state.phases.roster = {completed_at: now, synthesized: true};
  if (hasHealth) state.phases.health = {completed_at: now, synthesized: true};
  return state;
}

function deriveProjectName(projectRoot) {
  const parts = projectRoot.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'project';
}
