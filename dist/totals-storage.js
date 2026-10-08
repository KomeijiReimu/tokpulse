import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { addTokenCounts, emptyTokenCounts, normalizeTokenCounts } from "./core.js";
import { GENERATION_BASIS_VERSION, coerceCompletionUpdate, coerceSpeedContribution, coerceSpeedTotals, emptySpeedTotals, isNewerCompletionUpdate, mergeRecordSpeed, sameSpeedContribution, updateSpeedTotals } from './statistics.js';
import { normalizeAgentName, normalizeAgentNames } from "./agent-names.js";
import { coerceScopeEvidence, isSessionScopeExcluded, mergeScopeEvidence } from "./scope.js";
export const TOTALS_VERSION = 1;
export { GENERATION_BASIS_VERSION } from './statistics.js';
export const DEFAULT_TOTALS_FILENAME = "totals.json";
const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];

/**
 * Cumulative direct usage per session. History keeps only a detail window;
 * once an exact contribution leaves that window it is dropped from `open`
 * and must not be subtracted from the session totals.
 */

const pathQueues = new Map();

/** Explicit totalsPath wins. Otherwise the ledger sits beside history as totals.json. */
export function resolveTotalsPath(input) {
  const historyPath = input.historyPath;
  const explicitPath = input.totalsPath;
  if (typeof explicitPath === "string" && explicitPath.length > 0) {
    if (isAbsolute(explicitPath) || typeof historyPath !== "string" || historyPath.length === 0) {
      return explicitPath;
    }
    return join(dirname(historyPath), explicitPath);
  }
  if (typeof historyPath === "string" && historyPath.length > 0) {
    return join(dirname(historyPath), DEFAULT_TOTALS_FILENAME);
  }
  throw new TypeError("Provide historyPath or an explicit totalsPath");
}
export function createTotalsStorage(pathOrOptions) {
  const path = typeof pathOrOptions === "string" ? requireExplicitPath(pathOrOptions) : resolveTotalsPath(pathOrOptions);
  return {
    path,
    apply: (record, options = {}) => enqueuePath(path, async () => {
      const ledger = await loadLedger(path);
      applyRecord(ledger, record, options);
      return persistLedger(path, ledger);
    }),
    applyMany: (records, options = {}) => enqueuePath(path, async () => {
      if (!Array.isArray(records)) throw new TypeError("Totals apply records must be an array");
      const ledger = await loadLedger(path);
      for (const record of records) applyOpenRecord(ledger, record);
      freezeRetained(ledger, options.retainedMessageIDs);
      return persistLedger(path, ledger);
    }),
    seed: records => enqueuePath(path, () => seedLedger(path, records)),
    backfillSpeed: records => enqueuePath(path, async () => {
      if (!Array.isArray(records)) throw new TypeError("Totals backfill records must be an array");
      const ledger = await loadLedger(path);
      // Compatibility entry point only. Old history cannot reconstruct the new
      // observation basis, nor introduce guessed response timing.
      return cloneLedger(ledger);
    }),
    read: () => enqueuePath(path, () => loadLedger(path)),
    setSessionScope: (sessionID, evidence) => enqueuePath(path, async () => {
      const proof = coerceScopeEvidence(evidence);
      if (!sessionID || !proof || proof.sourceScope === "magic-message") throw new TypeError("Invalid session scope");
      const ledger = await loadLedger(path);
      ledger.sessionScopes ??= {};
      ledger.sessionScopes[sessionID] = mergeScopeEvidence(ledger.sessionScopes[sessionID], proof);
      return persistLedger(path, ledger);
    }),
    setSessionAgent: (sessionID, agent) => enqueuePath(path, async () => {
      const ledger = await loadLedger(path);
      if (!rememberSessionAgent(ledger, sessionID, agent)) return cloneLedger(ledger);
      return persistLedger(path, ledger);
    }),
    excludeMessage: (messageID, scopeProof) => enqueuePath(path, async () => {
      const proof = coerceScopeEvidence(scopeProof);
      if (!messageID || !proof || !["magic-message", "magic-session"].includes(proof.sourceScope)) throw new TypeError("Invalid message exclusion");
      const ledger = await loadLedger(path);
      excludeContribution(ledger, messageID, proof);
      return persistLedger(path, ledger);
    }),
    quarantine: () => enqueuePath(path, () => quarantineFile(path))
  };
}

/** Syntax errors and rejected ledgers only. Ordinary disk failures are not corrupt. */
export function isCorruptTotalsError(error) {
  return error instanceof SyntaxError || error instanceof TypeError && error.message === "Invalid totals ledger";
}
function requireExplicitPath(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("totals path must be a non-empty string");
  }
  return path;
}
async function seedLedger(path, records) {
  if (!Array.isArray(records)) throw new TypeError("Totals seed records must be an array");
  const existing = await readExistingLedger(path);
  if (existing) {
    let changed = migrateGenerationBasis(existing);
    for (const record of records) if (rememberRecordAgent(existing, record)) changed = true;
    if (changed) return persistLedger(path, existing);
    return cloneLedger(existing);
  }
  const ledger = emptyLedger();
  for (const record of records) applyRecord(ledger, record);
  return persistLedger(path, ledger);
}
async function loadLedger(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyLedger();
    throw error;
  }
  const ledger = parseTotalsJson(content);
  if (migrateGenerationBasis(ledger)) return persistLedger(path, ledger);
  return cloneLedger(ledger);
}
async function readExistingLedger(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return parseTotalsJson(content);
}
async function persistLedger(path, ledger) {
  await writeTotalsFile(path, ledger);
  return cloneLedger(ledger);
}
async function quarantineFile(path) {
  const destination = join(dirname(path), `${basename(path)}.corrupt-${Date.now()}`);
  try {
    await rename(path, destination);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}
async function writeTotalsFile(path, ledger) {
  const directory = dirname(path);
  await mkdir(directory, {
    recursive: true
  });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cloneLedger(ledger))}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, {
      force: true
    }).catch(() => undefined);
    throw error;
  }
}
function parseTotalsJson(content) {
  return coerceLedger(JSON.parse(content));
}
function applyRecord(ledger, record, options = {}) {
  applyOpenRecord(ledger, record);
  freezeRetained(ledger, options.retainedMessageIDs);
}
function rememberSessionAgent(ledger, sessionID, agent) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return false;
  const name = normalizeAgentName(agent);
  if (!name) return false;
  const current = ledger.sessionAgents?.[sessionID];
  const next = normalizeAgentNames([...(current ?? []), name]);
  if (current && current.length === next.length && current.every((entry, index) => entry === next[index])) return false;
  ledger.sessionAgents = {
    ...ledger.sessionAgents,
    [sessionID]: next
  };
  return true;
}

/** Names are metadata. Magic exclusions stay on the scope path and are not reclassified here. */
function rememberRecordAgent(ledger, record) {
  const proof = coerceScopeEvidence(record.scope);
  if (proof?.sourceScope === "magic-message" || proof?.sourceScope === "magic-session") return false;
  return rememberSessionAgent(ledger, record.sessionID, record.agent);
}
function applyOpenRecord(ledger, record) {
  const messageID = requireMessageID(record);
  const proof = coerceScopeEvidence(record.scope);
  if (proof?.sourceScope === "magic-message" || proof?.sourceScope === "magic-session") {
    excludeContribution(ledger, messageID, proof);
    return;
  }
  const previous = ledger.open[messageID];
  const prior = ledger.settled[messageID] ?? previous;
  if (prior && prior !== true && prior.excluded) return;
  const contribution = contributionFromRecord(record, prior === true ? undefined : prior);
  if (prior && prior !== true && prior.quality === "exact" && contribution.quality === "provisional") return;
  if (prior && prior !== true) {
    if (contribution.update) {
      if (prior.update && !isNewerCompletionUpdate(contribution.update, prior.update)) return;
    } else if (prior.update && prior.quality === contribution.quality || prior.speedBackfill) return;
  }
  if (!previous) {
    const frozen = ledger.settled[messageID];
    if (frozen === true) return;
    if (frozen) {
      if (sameContribution(frozen, contribution)) {
        rememberRecordAgent(ledger, record);
        return;
      }
      replaceContribution(ledger, frozen, contribution);
      delete ledger.settled[messageID];
      ledger.open[messageID] = contribution;
      rememberRecordAgent(ledger, record);
      return;
    }
    addContribution(ensureSession(ledger, contribution.sessionID), contribution);
    ledger.open[messageID] = contribution;
    rememberRecordAgent(ledger, record);
    return;
  }
  if (!sameContribution(previous, contribution)) {
    replaceContribution(ledger, previous, contribution);
    ledger.open[messageID] = contribution;
  }
  rememberRecordAgent(ledger, record);
}
function excludeContribution(ledger, messageID, proof) {
  const prior = ledger.settled[messageID] ?? ledger.open[messageID];
  if (prior && prior !== true && !prior.excluded) {
    const session = ledger.sessions[prior.sessionID];
    if (session) subtractContribution(session, prior);
    ledger.settled[messageID] = {
      ...cloneContribution(prior),
      excluded: proof
    };
  } else if (!prior || prior === true) {
    // The existing per-message settled scheme is the replay guard; no separate
    // unbounded event cache, and no fabricated amount for legacy true markers.
    ledger.settled[messageID] = true;
    ledger.messageScopes ??= {};
    ledger.messageScopes[messageID] = mergeScopeEvidence(ledger.messageScopes[messageID], proof);
  }
  delete ledger.open[messageID];
}

/** Reset the observation epoch without touching usage or response throughput.
 * The caller persists the marker and reset together with an atomic rename. */
function migrateGenerationBasis(ledger) {
  if (ledger.generationBasisVersion === GENERATION_BASIS_VERSION) return false;
  clearGenerationMeasurements(ledger);
  ledger.generationBasisVersion = GENERATION_BASIS_VERSION;
  return true;
}

/** Read-only TUI projection; legacy generation is hidden without writing or
 * marking the on-disk ledger as migrated. The server owns the atomic reset. */
export function projectTotalsGenerationBasis(ledger) {
  const projected = cloneLedger(ledger);
  if (projected.generationBasisVersion !== GENERATION_BASIS_VERSION) clearGenerationMeasurements(projected);
  return projected;
}
const scopeProjectionCache = new WeakMap();
const messageExclusionCache = new WeakMap();
/** Compact tombstone IDs for history projection, never infer exclusion from
 * an ordinary legacy settled:true marker lacking positive source proof. */
export function getExcludedMessageIDs(ledger) {
  const cached = messageExclusionCache.get(ledger);
  if (cached) return cached;
  const ids = new Set(Object.keys(ledger.messageScopes ?? {}));
  for (const [id, contribution] of Object.entries(ledger.settled)) {
    if (contribution !== true && contribution.excluded) ids.add(id);
  }
  messageExclusionCache.set(ledger, ids);
  return ids;
}
/** Read-only projection. Inputs must be immutable snapshots (including parents).
 * Raw session usage, speed, contributions and generation epoch are untouched. */
export function projectTotalsMeasurementScope(ledger, parents) {
  const cached = scopeProjectionCache.get(ledger);
  if (cached && cached.parents === parents) return cached.projected;
  const sessions = {};
  for (const [id, session] of Object.entries(ledger.sessions)) {
    if (!isSessionScopeExcluded(id, ledger.sessionScopes, parents)) sessions[id] = cloneSession(session);
  }
  const projected = {
    ...ledger,
    sessions
  };
  scopeProjectionCache.set(ledger, {
    parents,
    projected
  });
  return projected;
}
function clearGenerationMeasurements(ledger) {
  for (const session of Object.values(ledger.sessions)) {
    if (session.speed) session.speed.generation = emptySpeedTotals().generation;
  }
  for (const contribution of [...Object.values(ledger.open), ...Object.values(ledger.settled)]) {
    if (contribution === true || !contribution.speed) continue;
    delete contribution.speed.generation;
    delete contribution.speed.generationEvidence;
    if (!contribution.speed.response) delete contribution.speed;
  }
}
function replaceContribution(ledger, previous, contribution) {
  if (previous.sessionID !== contribution.sessionID) {
    const previousSession = ledger.sessions[previous.sessionID];
    if (previousSession) subtractContribution(previousSession, previous);
    addContribution(ensureSession(ledger, contribution.sessionID), contribution);
    return;
  }
  applyDelta(ensureSession(ledger, contribution.sessionID), previous, contribution);
}
function freezeRetained(ledger, retainedMessageIDs) {
  const retained = retainedSet(retainedMessageIDs);
  if (retained) freezeExact(ledger, retained);
}
function contributionFromRecord(record, previous) {
  if (!isPlainObject(record) || typeof record.sessionID !== "string" || record.sessionID.length === 0) {
    throw new TypeError("Invalid totals record");
  }
  const quality = record.quality === "provisional" ? "provisional" : "exact";
  // Loaded snapshots retain legacy identity and reversible response throughput;
  // newly applied generation must satisfy the shared v3 observation contract.
  // The server has already calibrated explicit live speed snapshots. An
  // explicit live omission is a revocation, not permission to resurrect prior
  // evidence. Corrections without a speed snapshot can still use shared merge.
  const update = coerceCompletionUpdate(record.update);
  const speed = coerceSpeedContribution(mergeRecordSpeed(record, previous, update && record.speed !== undefined && !record.speed.generation ? "invalidated" : "unobserved"));
  return {
    sessionID: record.sessionID,
    quality,
    tokens: normalizeTokenCounts(record.tokens),
    cost: nonNegativeCost(record.cost),
    ...(speed ? {
      speed
    } : {}),
    ...(update ? {
      update
    } : {})
  };
}
function requireMessageID(record) {
  if (!isPlainObject(record) || typeof record.messageID !== "string" || record.messageID.length === 0) {
    throw new TypeError("Invalid totals record");
  }
  return record.messageID;
}
function addContribution(session, contribution) {
  session.tokens = clampTokenCounts(addTokenCounts(session.tokens, contribution.tokens));
  session.cost = clampNonNegative(session.cost + contribution.cost);
  session.responseCount = clampNonNegative(session.responseCount + 1);
  session.speed = updateSpeedTotals(session.speed, contribution.speed, 1);
}
function subtractContribution(session, contribution) {
  session.tokens = subtractTokens(session.tokens, contribution.tokens);
  session.cost = clampNonNegative(session.cost - contribution.cost);
  session.responseCount = clampNonNegative(session.responseCount - 1);
  session.speed = updateSpeedTotals(session.speed, contribution.speed, -1);
}
function applyDelta(session, previous, next) {
  const tokens = emptyTokenCounts();
  for (const field of TOKEN_FIELDS) {
    tokens[field] = clampNonNegative(session.tokens[field] + next.tokens[field] - previous.tokens[field]);
  }
  session.tokens = tokens;
  session.cost = clampNonNegative(session.cost + next.cost - previous.cost);
  session.speed = updateSpeedTotals(updateSpeedTotals(session.speed, previous.speed, -1), next.speed, 1);
}
function freezeExact(ledger, retained) {
  for (const messageID of Object.keys(ledger.open)) {
    const contribution = ledger.open[messageID];
    if (contribution?.quality === "exact" && !retained.has(messageID)) {
      ledger.settled[messageID] = cloneContribution(contribution);
      delete ledger.open[messageID];
    }
  }
}
function retainedSet(value) {
  if (value === undefined) return undefined;
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  throw new TypeError("retainedMessageIDs must be a Set or an array");
}
function ensureSession(ledger, sessionID) {
  const existing = ledger.sessions[sessionID];
  if (existing) return existing;
  const created = emptySession();
  ledger.sessions[sessionID] = created;
  return created;
}
function sameContribution(left, right) {
  return left.sessionID === right.sessionID && left.quality === right.quality && left.cost === right.cost && sameSpeedContribution(left.speed, right.speed) && JSON.stringify(left.update) === JSON.stringify(right.update) && TOKEN_FIELDS.every(field => left.tokens[field] === right.tokens[field]);
}
function subtractTokens(left, right) {
  return {
    input: clampNonNegative(left.input - right.input),
    output: clampNonNegative(left.output - right.output),
    reasoning: clampNonNegative(left.reasoning - right.reasoning),
    cacheRead: clampNonNegative(left.cacheRead - right.cacheRead),
    cacheWrite: clampNonNegative(left.cacheWrite - right.cacheWrite)
  };
}
function clampTokenCounts(tokens) {
  return {
    input: clampNonNegative(tokens.input),
    output: clampNonNegative(tokens.output),
    reasoning: clampNonNegative(tokens.reasoning),
    cacheRead: clampNonNegative(tokens.cacheRead),
    cacheWrite: clampNonNegative(tokens.cacheWrite)
  };
}
function emptyLedger() {
  return {
    version: TOTALS_VERSION,
    generationBasisVersion: GENERATION_BASIS_VERSION,
    sessions: {},
    open: {},
    settled: {}
  };
}
function emptySession() {
  return {
    tokens: emptyTokenCounts(),
    cost: 0,
    responseCount: 0
  };
}
function cloneLedger(ledger) {
  const sessions = {};
  for (const [sessionID, session] of Object.entries(ledger.sessions)) {
    sessions[sessionID] = cloneSession(session);
  }
  const open = {};
  for (const [messageID, contribution] of Object.entries(ledger.open)) {
    open[messageID] = cloneContribution(contribution);
  }
  const sessionAgents = cloneSessionAgents(ledger.sessionAgents);
  return {
    version: TOTALS_VERSION,
    ...(ledger.generationBasisVersion === GENERATION_BASIS_VERSION ? {
      generationBasisVersion: GENERATION_BASIS_VERSION
    } : {}),
    sessions,
    open,
    settled: cloneSettled(ledger.settled),
    ...(ledger.sessionScopes ? {
      sessionScopes: cloneSessionScopes(ledger.sessionScopes)
    } : {}),
    ...(ledger.messageScopes ? {
      messageScopes: cloneMessageScopes(ledger.messageScopes, ledger.settled)
    } : {}),
    ...(sessionAgents ? {
      sessionAgents
    } : {})
  };
}
function cloneSession(session) {
  return {
    tokens: {
      ...session.tokens
    },
    cost: session.cost,
    responseCount: session.responseCount,
    ...(session.speed ? {
      speed: coerceSpeedTotals(session.speed)
    } : {})
  };
}
function cloneContribution(contribution) {
  return {
    sessionID: contribution.sessionID,
    quality: contribution.quality,
    tokens: {
      ...contribution.tokens
    },
    cost: contribution.cost,
    ...(contribution.speed ? {
      speed: coerceSpeedContribution(contribution.speed)
    } : {}),
    ...(contribution.update ? {
      update: coerceCompletionUpdate(contribution.update)
    } : {}),
    ...(contribution.speedBackfill ? {
      speedBackfill: {
        version: 1,
        source: "server"
      }
    } : {}),
    ...(contribution.excluded ? {
      excluded: coerceScopeEvidence(contribution.excluded)
    } : {})
  };
}
function cloneSettled(settled) {
  const copy = {};
  if (!settled) return copy;
  for (const [messageID, value] of Object.entries(settled)) {
    if (value === true) copy[messageID] = true;else copy[messageID] = cloneContribution(value);
  }
  return copy;
}
function coerceLedger(value) {
  if (!isPlainObject(value) || value.version !== TOTALS_VERSION) {
    throw new TypeError("Invalid totals ledger");
  }
  if (!isPlainObject(value.sessions) || !isPlainObject(value.open)) {
    throw new TypeError("Invalid totals ledger");
  }
  const sessions = {};
  for (const [sessionID, sessionValue] of Object.entries(value.sessions)) {
    sessions[sessionID] = coerceSession(sessionValue);
  }
  const open = {};
  for (const [messageID, contributionValue] of Object.entries(value.open)) {
    open[messageID] = coerceContribution(contributionValue);
  }
  const settled = coerceSettled(value.settled);
  return {
    version: TOTALS_VERSION,
    ...(value.generationBasisVersion === GENERATION_BASIS_VERSION ? {
      generationBasisVersion: GENERATION_BASIS_VERSION
    } : {}),
    sessions,
    open,
    settled,
    ...(value.sessionScopes !== undefined ? {
      sessionScopes: cloneSessionScopes(value.sessionScopes)
    } : {}),
    ...(value.messageScopes !== undefined ? {
      messageScopes: cloneMessageScopes(value.messageScopes, settled)
    } : {}),
    ...(cloneSessionAgents(value.sessionAgents) ? {
      sessionAgents: cloneSessionAgents(value.sessionAgents)
    } : {})
  };
}
function cloneSessionAgents(value) {
  if (!isPlainObject(value)) return undefined;
  const sessionAgents = {};
  for (const [sessionID, raw] of Object.entries(value)) {
    if (sessionID.length === 0) continue;
    const names = normalizeAgentNames(raw);
    if (names.length > 0) sessionAgents[sessionID] = names;
  }
  return Object.keys(sessionAgents).length > 0 ? sessionAgents : undefined;
}
function cloneSessionScopes(value) {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  const scopes = {};
  for (const [id, raw] of Object.entries(value)) {
    const proof = coerceScopeEvidence(raw);
    if (!id || !proof || proof.sourceScope === "magic-message") throw new TypeError("Invalid totals ledger");
    scopes[id] = proof;
  }
  return scopes;
}
function cloneMessageScopes(value, settled) {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  const scopes = {};
  for (const [id, raw] of Object.entries(value)) {
    const proof = coerceScopeEvidence(raw);
    if (!id || !proof || !["magic-message", "magic-session"].includes(proof.sourceScope) || settled[id] !== true) throw new TypeError("Invalid totals ledger");
    scopes[id] = proof;
  }
  return scopes;
}
function coerceSettled(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  const settled = {};
  for (const [messageID, marker] of Object.entries(value)) {
    if (messageID.length === 0) throw new TypeError("Invalid totals ledger");
    if (marker === true) {
      settled[messageID] = true;
      continue;
    }
    settled[messageID] = coerceContribution(marker);
  }
  return settled;
}
function coerceSession(value) {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  return {
    tokens: coerceTokens(value.tokens),
    cost: requireNonNegative(value.cost),
    responseCount: requireNonNegative(value.responseCount),
    ...(value.speed !== undefined ? {
      speed: requireSpeedTotals(value.speed)
    } : {})
  };
}
function coerceContribution(value) {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  if (typeof value.sessionID !== "string" || value.sessionID.length === 0) {
    throw new TypeError("Invalid totals ledger");
  }
  if (value.quality !== "provisional" && value.quality !== "exact") {
    throw new TypeError("Invalid totals ledger");
  }
  return {
    sessionID: value.sessionID,
    quality: value.quality,
    tokens: coerceTokens(value.tokens),
    cost: requireNonNegative(value.cost),
    ...(value.speed !== undefined ? {
      speed: requireSpeedContribution(value.speed)
    } : {}),
    ...(value.update !== undefined ? {
      update: requireCompletionUpdate(value.update)
    } : {}),
    ...(value.speedBackfill?.version === 1 && value.speedBackfill?.source === "server" ? {
      speedBackfill: {
        version: 1,
        source: "server"
      }
    } : {}),
    ...(coerceScopeEvidence(value.excluded) ? {
      excluded: coerceScopeEvidence(value.excluded)
    } : {})
  };
}
function coerceTokens(value) {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  return {
    input: requireNonNegative(value.input),
    output: requireNonNegative(value.output),
    reasoning: requireNonNegative(value.reasoning),
    cacheRead: requireNonNegative(value.cacheRead),
    cacheWrite: requireNonNegative(value.cacheWrite)
  };
}
function requireNonNegative(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("Invalid totals ledger");
  }
  return value;
}
function requireSpeedTotals(value) {
  const speed = coerceSpeedTotals(value);
  if (!speed) throw new TypeError("Invalid totals ledger");
  return speed;
}
function requireSpeedContribution(value) {
  const speed = coerceSpeedContribution(value);
  if (!speed) throw new TypeError("Invalid totals ledger");
  return speed;
}
function requireCompletionUpdate(value) {
  const update = coerceCompletionUpdate(value);
  if (!update) throw new TypeError("Invalid totals ledger");
  return update;
}
function nonNegativeCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}
function clampNonNegative(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}
function enqueuePath(path, operation) {
  const key = resolve(path);
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  pathQueues.set(key, result.then(() => undefined, () => undefined));
  return result;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(value) {
  return value instanceof Error || isPlainObject(value);
}
