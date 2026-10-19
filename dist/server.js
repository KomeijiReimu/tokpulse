import { createHash, randomUUID } from "node:crypto";
import { HISTORY_VERSION, normalizeTokenCounts, timeToFirstToken, utf8ByteLength } from "./core.js";
import { ACTIVITY_VERSION, isActiveState, normalizeActivityEvent, replayActivity } from "./activity.js";
import { createActivityLedger } from "./runs-storage.js";
import { cachedContentProgress, coerceCompletionUpdate, createContentMetadataCache, createContentProgress, earliestFirstOutput, isNewerCompletionUpdate, mergeContentProgress, noteStepIdentity, taintContentProgress } from './statistics.js';
import { createHistoryStorage } from "./storage.js";
import { applyFirstResponseSignal, recordContentArrival, thinkingFirstResponseSignal } from "./statistics.js";
import { completeContentMetadata, retireContentMetadata, disposeContentMetadata } from "./statistics.js";
import { createTotalsStorage, isCorruptTotalsError } from "./totals-storage.js";
import { normalizeAgentName } from "./agent-names.js";
import { DEFAULT_HISTORY_PATH, migrateDefaultLedgers } from "./storage-paths.js";
import { createScopeRegistry, coerceScopeEvidence, mergeScopeEvidence } from "./scope.js";
import { createV2EventAdapter, isContentOnlyEvent, isV2ControlEvent, readV2Idle } from "./v2-server.js";
import { prepareLedgerPaths, acquireWriterLease, recoverHistoryFile, createReliableActivityWriter, createUsageCommitter } from "./persistence.js";
const ACTIVITY_EVENT_NAMESPACE = "oc-tps";
const PARENT_LOOKUP_TIMEOUT_MS = 200;
const QUERY_CONCURRENCY = 4;
const QUERY_RETRY_MS = 30_000;
const QUERY_CACHE_LIMIT = 2048;
/** Shared by directory, ancestry and idle queries; slots follow actual RPCs. */
function createQueryBudget(shutdown) {
  let running = 0;
  const jobs = [];
  const pump = () => {
    while (!shutdown.aborted && running < QUERY_CONCURRENCY && jobs.length) jobs.shift()();
  };
  shutdown.addEventListener("abort", () => {
    for (const job of jobs.splice(0)) job();
  }, {
    once: true
  });
  return {
    run(signal, operation) {
      return new Promise((resolve, reject) => {
        if (jobs.length >= QUERY_CACHE_LIMIT) {
          reject(new Error("metadata query budget exhausted"));
          return;
        }
        jobs.push(() => {
          if (signal.aborted || shutdown.aborted) {
            reject(new Error("metadata query aborted"));
            return;
          }
          running++;
          void Promise.resolve().then(operation).then(resolve, reject).finally(() => {
            running--;
            pump();
          });
        });
        pump();
      });
    }
  };
}
function compactSessionMetadata(session) {
  const metadata = asRecord(session.metadata);
  return {
    id: session.id,
    ...(Object.prototype.hasOwnProperty.call(session, "parentID") || Object.prototype.hasOwnProperty.call(session, "parentSessionID") ? {
      parentID: session.parentID ?? session.parentSessionID
    } : {}),
    agent: session.agent,
    title: session.title,
    location: {
      directory: session.location?.directory
    },
    metadata: {
      magic_context: metadata?.magic_context,
      role: metadata?.role
    },
    time: {
      idle: session.time?.idle
    },
    outcome: session.outcome
  };
}
const PENDING_PERSISTENCE_LIMIT = 128;
const PENDING_PERSISTENCE_BYTES = 4 * 1024 * 1024;
const sourcesByRuntime = new WeakMap();
const committersByStorage = new WeakMap();
// Reports, not a guessed SID-local cache: successful upsert/retry can prove
// there is no global backlog. Unknown recovery/admission outcomes still retry.
const pendingUsageByStorage = new WeakMap();
const acceptedUsageByStorage = new WeakMap();
function runDeferred(runtime, job, prioritize = false) {
  if (runtime.signal.aborted || runtime.jobs.length >= QUERY_CACHE_LIMIT) return false;
  if (prioritize) runtime.jobs.unshift(job);else runtime.jobs.push(job);
  runtime.queryStats.peakQueued = Math.max(runtime.queryStats.peakQueued, runtime.jobs.length);
  const pump = () => {
    while (!runtime.signal.aborted && runtime.workers < QUERY_CONCURRENCY && runtime.jobs.length) {
      runtime.workers++;
      const next = runtime.jobs.shift();
      const task = Promise.resolve().then(next).catch(error => warn("background reconciliation failed", error));
      runtime.background.add(task);
      void task.finally(() => {
        runtime.background.delete(task);
        runtime.workers--;
        pump();
        runtime.refillMetadata?.();
        if (!runtime.workers && !runtime.jobs.length && !runtime.refillMetadata) void runtime.flushMetadata?.();
      });
    }
  };
  pump();
  return true;
}
const METADATA_BATCH_SIZE = 128;
const METADATA_PENDING_LIMIT = 256;
function queueSessionMetadata(runtime, sessionID, agents = []) {
  const proof = runtime.scopes.getPersistentEvidence(sessionID);
  const pending = runtime.pendingSessionMetadata.get(sessionID);
  const scope = proof && JSON.stringify(proof) !== runtime.persistedScopes.get(sessionID) ? proof : pending?.scope;
  const known = runtime.persistedAgents.get(sessionID);
  const added = [...new Set([...(pending?.agents ?? []), ...agents])].filter(agent => !known?.has(agent));
  if (!scope && !added.length) return true;
  if (!pending && runtime.pendingSessionMetadata.size >= METADATA_PENDING_LIMIT) {
    runtime.metadataPaused = true;
    runtime.queried.delete(sessionID);
    runtime.scopeDirty.add(sessionID);
    warn("metadata projection admission exhausted; observation remains unconfirmed");
    return false;
  }
  runtime.pendingSessionMetadata.set(sessionID, {
    sessionID,
    ...(scope ? {
      scope: pending?.scope ? mergeScopeEvidence(pending.scope, scope) : scope
    } : {}),
    ...(added.length ? {
      agents: added
    } : {})
  });
  runtime.metadataProjection.peakPending = Math.max(runtime.metadataProjection.peakPending, runtime.pendingSessionMetadata.size);
  return true;
}
async function flushSessionMetadata(runtime, totals) {
  const batch = [...runtime.pendingSessionMetadata.values()].slice(0, METADATA_BATCH_SIZE);
  if (!batch.length) return;
  runtime.metadataProjection.batches++;
  runtime.metadataProjection.maxBatch = Math.max(runtime.metadataProjection.maxBatch, batch.length);
  try {
    const canonical = await totals.setSessionMetadataMany(batch);
    for (const update of batch) {
      const id = update.sessionID;
      if (canonical.sessionScopes && Object.prototype.hasOwnProperty.call(canonical.sessionScopes, id)) {
        runtime.persistedScopes.set(id, JSON.stringify(canonical.sessionScopes[id]));
      }
      if (canonical.sessionAgents && Object.prototype.hasOwnProperty.call(canonical.sessionAgents, id)) {
        runtime.persistedAgents.set(id, new Set(canonical.sessionAgents[id]));
      }
      // A newer correction can have arrived while this batch was in flight.
      if (runtime.pendingSessionMetadata.get(id) === update) runtime.pendingSessionMetadata.delete(id);
    }
    runtime.metadataPaused = false;
    runtime.refillMetadata?.();
  } catch (error) {
    runtime.metadataPaused = true;
    runtime.metadataProjection.failures++;
    warn("metadata batch remains pending", error);
  }
}
async function persistScopeRegistry(runtime, totals, flush = true) {
  for (const id of runtime.scopeDirty) if (queueSessionMetadata(runtime, id)) runtime.scopeDirty.delete(id);
  const batches = flush ? Math.ceil(METADATA_PENDING_LIMIT / METADATA_BATCH_SIZE) : runtime.pendingSessionMetadata.size >= METADATA_BATCH_SIZE ? 1 : 0;
  for (let index = 0; index < batches && runtime.pendingSessionMetadata.size; index++) {
    await flushSessionMetadata(runtime, totals);
    if (runtime.metadataPaused) break;
  }
  for (const id of [...runtime.pendingMessageScopes].slice(0, 32)) {
    const proof = runtime.messageScopes.get(id);
    if (!proof) {
      runtime.pendingMessageScopes.delete(id);
      continue;
    }
    try {
      await totals.excludeMessage(id, proof);
      runtime.pendingMessageScopes.delete(id);
    } catch (error) {
      warn("message scope projection remains pending", error);
      break;
    }
  }
}
function retireResponse(active, messageID, sessionID) {
  const runtime = responseRuntime(active);
  active.delete(messageID);
  if (!runtime.current.has(sessionID) || runtime.current.get(sessionID) === messageID) {
    active.delete(pendingKey(sessionID));
    runtime.current.delete(sessionID);
    runtime.closed.add(sessionID);
    runtime.pendingTaints.delete(sessionID);
  }
  const metadata = runtimeContentMetadata(active);
  completeContentMetadata(metadata, messageID);
  runtime.tainted.delete(messageID);
}
function eligibleSession(runtime, sessionID) {
  // ScopeRegistry delegates inherited identity to the shared scope helper.
  return !runtime.scopes.isExcluded(sessionID);
}
function forgetPendingPersistence(source, messageID) {
  const pending = source.pendingPersistence.get(messageID);
  if (pending) source.pendingBytes -= pending.bytes;
  source.pendingPersistence.delete(messageID);
}
function discardExcludedPersistence(source) {
  for (const [id, pending] of source.pendingPersistence) {
    if (!eligibleSession(source, pending.record.sessionID) || source.messageScopes.has(id) || ["magic-message", "magic-session"].includes(pending.record.scope?.sourceScope ?? "")) {
      const scope = source.messageScopes.get(id) ?? {
        version: 1,
        sourceScope: "magic-session",
        reasons: ["parent-link"]
      };
      // The committer may already own a not-yet-durable snapshot. Keep an
      // exclusion repair obligation instead of forgetting it and later letting
      // a healthy global retry resurrect hidden usage.
      pending.record = {
        ...pending.record,
        scope
      };
    }
  }
}
function retainPendingPersistence(source, record) {
  const prior = source.pendingPersistence.get(record.messageID);
  const bytes = utf8ByteLength(JSON.stringify(record));
  if (!prior && source.pendingPersistence.size >= PENDING_PERSISTENCE_LIMIT || source.pendingBytes - (prior?.bytes ?? 0) + bytes > PENDING_PERSISTENCE_BYTES) {
    // Finite in-memory retry, not a new durable journal. Never silently evict an
    // exact record or restore it as LIVE/provisional under persistent failure.
    warn(`pending completion capacity exceeded; unpersisted message ${record.messageID}`);
    return;
  }
  forgetPendingPersistence(source, record.messageID);
  source.pendingPersistence.set(record.messageID, {
    record,
    bytes
  });
  source.pendingBytes += bytes;
}
async function persistCompletedRecord(source, storage, totals, record) {
  const wrote = await safeUpsert(storage, totals, record);
  if (wrote) forgetPendingPersistence(source, record.messageID);else {
    const accepted = acceptedUsageByStorage.get(storage) === record;
    // Durable accepted facts belong to the committer's protected recovery set;
    // reserve this separate finite budget for unadmitted/history-failure facts.
    const fingerprint = record.update?.fingerprint;
    const durable = accepted && (await storage.readAll().catch(() => [])).some(item => item.messageID === record.messageID && (fingerprint ? item.update?.fingerprint === fingerprint && JSON.stringify(item.scope) === JSON.stringify(record.scope) : stableSerialize(item) === stableSerialize(record)));
    if (durable) forgetPendingPersistence(source, record.messageID);else retainPendingPersistence(source, record);
  }
  return wrote;
}
async function retryPendingPersistence(source, storage, _totals, _sessionID) {
  const committer = committersByStorage.get(storage);
  if (committer) {
    if (pendingUsageByStorage.get(storage) === 0 && source.pendingPersistence.size === 0) return;
    discardExcludedPersistence(source);
    const report = await committer.retryPending();
    pendingUsageByStorage.set(storage, report.pendingCount);
    if (!report.pendingCount) acceptedUsageByStorage.delete(storage);
    for (const [id, pending] of [...source.pendingPersistence].slice(0, 32)) {
      await persistCompletedRecord(source, storage, _totals, pending.record);
      if (source.pendingPersistence.get(id) === pending) {
        source.pendingPersistence.delete(id);
        source.pendingPersistence.set(id, pending);
      }
    }
    return;
  }
  throw new Error("Backend usage committer is not initialized");
}
function scheduleIdleReconciliation(input, source, activity, active, sessionID, messageID, info, epoch) {
  const sessionClient = input.client?.session;
  const status = sessionClient?.status;
  const v2Idle = input.readV2Idle;
  // A tool-call/next-loop completion is never a final-answer candidate.
  if (typeof status !== "function" && typeof v2Idle !== "function" || !["stop", "end_turn"].includes(info.finish) || source.reconciled.has(messageID) || !eligibleSession(source, sessionID)) return;
  // A status result closes only the queried participant. Children keep their
  // own activity intervals; they never suppress an authoritative parent idle.
  const activeOwn = () => [...active.values()].some(state => state.sessionID === sessionID) || [...source.tools.values()].some(tool => tool.pending && tool.sessionID === sessionID);
  const ownership = source.responseExecutions.get(messageID);
  const executionID = ownership?.sessionID === sessionID ? ownership.executionID : undefined;
  const fresh = () => (source.epochs.get(sessionID) ?? 0) === epoch && (!executionID || activity.observations.get(sessionID)?.executionID === executionID) && !source.signal.aborted && source.responses.get(sessionID) === messageID && eligibleSession(source, sessionID) && !activeOwn();
  if (!fresh()) return;
  source.reconciled.add(messageID);
  runDeferred(source, async () => {
    if (!fresh()) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([source.signal, controller.signal]);
    try {
      if (typeof v2Idle === "function") {
        const terminal = await withTimeout(v2Idle(sessionID, signal), PARENT_LOOKUP_TIMEOUT_MS);
        // Older idle watermarks belong to a previous execution, not this step.
        if (!terminal || controller.signal.aborted || !fresh() || terminal.timestamp < (info.time?.completed ?? Infinity)) return;
        await source.enqueue(async () => {
          if (!fresh()) return;
          source.states.set(sessionID, terminal.state);
          await captureActivityForEvent(activity, "session.status", {
            sessionID,
            status: {
              type: terminal.state
            }
          }, {
            executionID
          }, terminal.timestamp);
          await source.retryPersistence(sessionID);
        });
        return;
      }
      const directory = typeof input.directory === "string" && input.directory.length ? input.directory : undefined;
      // One deadline covers status and (only for a missing SID) fresh existence
      // proof. No polling, cached existence, or second independent 200ms wait.
      const confirmed = await withTimeout((async () => {
        const v2 = status.length >= 2;
        const response = await (v2 ? status.call(sessionClient, {
          directory
        }, {
          signal
        }) : status.call(sessionClient, {
          query: {
            directory
          },
          signal
        }));
        const receivedAt = Date.now();
        const receivedMono = performance.now();
        if (controller.signal.aborted || !fresh() || !isRecord(response) || response.error !== undefined) return;
        const envelope = ["data", "error", "request", "response"].some(key => Object.prototype.hasOwnProperty.call(response, key));
        const states = plainSDKRecord(envelope ? response.data : response);
        if (!states) return;
        if (Object.prototype.hasOwnProperty.call(states, sessionID)) {
          const names = statusNames(states[sessionID]);
          if (!names.includes("idle") || names.includes("busy") || names.includes("retry")) return;
          // Keep successful legacy explicit-idle fixtures without HTTP fields.
          if (response.response !== undefined && response.response?.status !== 200) return;
        } else {
          // Official status.list is ACTIVE-ONLY: a missing SID is default-idle
          // only with successful scoped HTTP evidence and fresh same-dir get.
          if (!directory || response.response?.status !== 200 || !Object.values(states).every(value => ["busy", "retry", "idle"].includes(plainSDKRecord(value)?.type)) || reconciliationRequestDirectory(response, directory) !== directory) return;
          const get = sessionClient?.get;
          if (typeof get !== "function" || controller.signal.aborted || !fresh()) return;
          const sessionResponse = await (get.length >= 2 ? get.call(sessionClient, {
            sessionID,
            directory
          }, {
            signal
          }) : get.call(sessionClient, {
            path: {
              id: sessionID
            },
            query: {
              directory
            },
            signal
          }));
          if (controller.signal.aborted || !fresh() || !isRecord(sessionResponse) || sessionResponse.error !== undefined || sessionResponse.response?.status !== 200) return;
          const session = plainSDKRecord(sessionResponse.data);
          if (!session || session.id !== sessionID || plainSDKRecord(session.location)?.directory !== directory || reconciliationRequestDirectory(sessionResponse, directory) !== directory) return;
          // This get is existence proof only, not a second metadata classifier.
          // Existing gated metadata resolution remains the owner of scope facts.
        }
        // Fresh get proves scope/existence only; its wait is not user task time.
        return {
          receivedAt,
          receivedMono
        };
      })(), PARENT_LOOKUP_TIMEOUT_MS);
      if (!confirmed) return;
      const {
        receivedAt,
        receivedMono
      } = confirmed;
      await source.enqueue(async () => {
        if (!fresh()) return;
        // Only an authoritative query boundary closes task activity. Part-end
        // timestamps are not generation-end evidence. This is participant idle,
        // not a force-close of the root's independently active descendants.
        source.states.set(sessionID, "idle");
        await captureActivityForEvent(activity, "session.status", {
          sessionID,
          status: {
            type: "idle"
          },
          observedAt: receivedAt,
          lastObservedAt: receivedAt
        }, {
          executionID
        }, receivedAt);
        await source.retryPersistence(sessionID);
        void receivedMono;
      });
    } catch {/* Unknown/failure/timeout leaves lifecycle unchanged. */} finally {
      controller.abort();
    }
  }, true);
}
function plainSDKRecord(value) {
  if (!isRecord(value)) return;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : undefined;
}

/** Verify the effective request scope, never infer a directory from cwd.
 * An explicit supplied query is fallback proof only if request fields are absent. */
function reconciliationRequestDirectory(result, suppliedDirectory) {
  if (result.request === undefined) return suppliedDirectory;
  const request = asRecord(result.request);
  if (!request || typeof request.url !== "string") return;
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => key.toLowerCase().includes("workspace"))) return;
    const headers = new Headers(request.headers);
    if ([...headers.keys()].some(key => key.toLowerCase().includes("workspace"))) return;
    if (url.searchParams.has("directory")) {
      const directories = url.searchParams.getAll("directory");
      if (directories.length !== 1 || !directories[0]) return;
      // GET rewrite can place an already percent-encoded SDK header into query,
      // so URLSearchParams removes only the outer URL-serialization layer.
      // Preserve a matching plaintext directory (including literal '%' names).
      return directories[0] === suppliedDirectory ? directories[0] : decodeURIComponent(directories[0]);
    }
    const header = headers.get("x-opencode-directory");
    return header ? decodeURIComponent(header) || undefined : undefined;
  } catch {
    return;
  }
}
const activityInitializationQueues = new Map();
const contentMetadataByRuntime = new WeakMap();
const responsesByRuntime = new WeakMap();
function responseRuntime(active) {
  let runtime = responsesByRuntime.get(active);
  if (!runtime) {
    runtime = {
      current: new Map(),
      closed: new Set(),
      pendingTaints: new Map(),
      tainted: new Set(),
      connected: false,
      observedSince: Infinity
    };
    responsesByRuntime.set(active, runtime);
  }
  return runtime;
}
function taintResponse(active, state, reason) {
  state.progress ??= cachedContentProgress(runtimeContentMetadata(active), state.messageID);
  taintContentProgress(state.progress, reason);
  responseRuntime(active).tainted.add(state.messageID);
}
function bindPendingTaint(active, state) {
  if (state.messageID.startsWith("__pending__:")) return;
  const runtime = responseRuntime(active);
  for (const reason of runtime.pendingTaints.get(state.sessionID) ?? []) taintResponse(active, state, reason);
  runtime.pendingTaints.delete(state.sessionID);
}
function recordResponseLifecycle(active, type, properties, event, receivedAt) {
  const runtime = responseRuntime(active);
  const status = typeof properties.status === "string" ? properties.status : properties.status?.type;
  const disruption = type === "server.connected" ? runtime.connected : type.startsWith("workspace.") && (type.includes("status") || type.includes("disposed") || type.includes("deleted"));
  if (type === "server.connected") runtime.connected = true;
  if (disruption) {
    runtime.observedSince = Math.max(runtime.observedSince, receivedAt);
    for (const state of active.values()) taintResponse(active, state, "transport-disruption");
  }
  const failure = status === "retry" || type === "session.step.failed" || type.startsWith("session.next.") && (type.endsWith(".retried") || type.endsWith(".failed")) || type === "session.error" || type.includes("provider.error") || type.includes("provider-error") || eventInfo(properties, event)?.error !== undefined;
  if (!failure) return;
  const sessionID = readSessionIDFromEvent(type, properties, event);
  const current = sessionID ? runtime.current.get(sessionID) : undefined;
  const info = eventInfo(properties, event);
  // Lifecycle info.id often names the SESSION, not an assistant response.
  const explicitMessageID = [properties.messageID, properties.assistantMessageID, properties.part?.messageID, info?.messageID, info?.assistantMessageID, event.messageID, event.assistantMessageID, info?.role === "assistant" ? info.id : undefined].find(id => typeof id === "string" && id.length > 0);
  const messageID = explicitMessageID ?? (current && active.has(current) ? current : undefined) ?? [...active.values()].find(state => state.sessionID === sessionID && !state.messageID.startsWith("__pending__:"))?.messageID;
  const reason = status === "retry" || type.includes("retried") ? "retry" : "failed";
  if (messageID) {
    runtime.tainted.add(messageID);
    const state = active.get(messageID);
    if (state) taintResponse(active, state, reason);
  } else if (sessionID) {
    const pending = runtime.pendingTaints.get(sessionID) ?? new Set();
    pending.add(reason);
    runtime.pendingTaints.set(sessionID, pending);
  }
}
function runtimeContentMetadata(active) {
  let metadata = contentMetadataByRuntime.get(active);
  if (!metadata) {
    metadata = createContentMetadataCache();
    contentMetadataByRuntime.set(active, metadata);
  }
  return metadata;
}
function isSnapshotIngress(event, properties) {
  return event.replay === true || properties.replay === true || [event.source, properties.source].some(source => ["snapshot", "history", "reconnect"].includes(source));
}
/** Two-argument snapshots only cache metadata. Live ingress may attach a signal
 * to an already-owned current assistant, but never creates activity/samples. */
export function recordPartMetadata(active, properties, now, event = {}) {
  const metadata = runtimeContentMetadata(active);
  const part = asRecord(properties.part);
  // Part snapshots repeat the whole text. Speed digests are gone, so do not hash them.
  if (part && typeof part.messageID === "string" && typeof part.role === "string") metadata.roles.set(part.messageID, part.role);
  if (part?.type === "step-start") {
    noteStepIdentity(cachedContentProgress(metadata, part.messageID), part.stepID ?? properties.stepID ?? part.id);
  }
  if (!part || now === undefined || isSnapshotIngress(event, properties)) return;
  const state = active.get(part.messageID);
  if (!state?.liveAssistant || metadata.completed.has(part.messageID)) return;
  const signal = thinkingFirstResponseSignal(part, {
    messageID: state.messageID,
    sessionID: state.sessionID,
    role: metadata.roles.get(state.messageID) ?? "unknown",
    start: state.startedAt,
    now,
    live: true
  });
  if (signal) state.timing = applyFirstResponseSignal(state.timing ?? {
    start: state.startedAt
  }, signal);
}
export const server = async (input, pluginOptions) => {
  const shutdown = new AbortController();
  const externalSignal = input.v2Signal;
  const shutdownSignal = externalSignal ? AbortSignal.any([shutdown.signal, externalSignal]) : shutdown.signal;
  const options = resolveOptions(pluginOptions ?? input.options ?? input.config);
  const baseDirectory = resolveProjectDirectory(input);
  const paths = await prepareLedgerPaths(baseDirectory, options);
  const lease = await acquireWriterLease(paths);
  try {
    const historyPath = paths.historyPath;
    const storage = createHistoryStorage(historyPath, {
      maxRecords: options.maxRecords,
      lease
    });
    const totals = createTotalsStorage({
      historyPath,
      totalsPath: paths.totalsPath,
      lease
    });
    const ledger = createActivityLedger({
      historyPath,
      runsPath: paths.runsPath,
      lease
    });
    const activity = {
      ledger,
      writer: createReliableActivityWriter(ledger, {
        lease
      }),
      instanceID: randomUUID(),
      nextSeq: 1,
      assignments: new Map(),
      writtenFacts: new Set(),
      rawTimestamps: new Map(),
      sessionEpochs: new Map(),
      observations: new Map(),
      invalidExecutions: new Set()
    };
    const usage = createUsageCommitter(storage, totals);
    committersByStorage.set(storage, usage);
    await migrateDefaultLedgers(baseDirectory, {
      historyPath,
      totalsPath: totals.path,
      runsPath: activity.ledger.path
    });
    await recoverHistoryFile(historyPath, lease);
    try {
      await usage.recover();
    } catch (error) {
      if (!isCorruptTotalsError(error)) throw error;
      await totals.quarantine();
      await usage.recover();
    }
    let eventQueue = initializeActivityRuntime(activity);
    await eventQueue;
    const active = new Map();
    const completedMessageIDs = new Set();
    const metadata = runtimeContentMetadata(active);
    const persisted = await totals.read().catch(() => undefined);
    for (const [id, contribution] of Object.entries(persisted?.open ?? {})) {
      if (contribution.quality === "exact") {
        completedMessageIDs.add(id);
        metadata.completed.add(id);
      }
    }
    for (const id of Object.keys(persisted?.settled ?? {})) {
      completedMessageIDs.add(id);
      metadata.completed.add(id);
    }
    const parentSessionCache = new Map();
    const source = {
      signal: shutdownSignal,
      background: new Set(),
      scopes: createScopeRegistry(persisted?.sessionScopes),
      persistedScopes: new Map(Object.entries(persisted?.sessionScopes ?? {}).map(([id, proof]) => [id, JSON.stringify(proof)])),
      scopeDirty: new Set(),
      persistedAgents: new Map(Object.entries(persisted?.sessionAgents ?? {}).map(([id, agents]) => [id, new Set(agents)])),
      pendingSessionMetadata: new Map(),
      metadataPaused: false,
      metadataProjection: {
        peakPending: 0,
        batches: 0,
        maxBatch: 0,
        failures: 0
      },
      messageScopes: new Map(),
      pendingMessageScopes: new Set(),
      metadataGeneration: new Map(),
      queried: new Map(),
      outstanding: new Set(),
      jobs: [],
      workers: 0,
      epochs: new Map(),
      responses: new Map(),
      responseExecutions: new Map(),
      pendingPersistence: new Map(),
      pendingBytes: 0,
      queryStats: {
        admitted: 0,
        settled: 0,
        validResponses: 0,
        unknownResponses: 0,
        skipped: 0,
        rejected: 0,
        peakQueued: 0,
        bootstrapTotal: 0,
        bootstrapVisited: 0,
        bootstrapAdmitted: 0,
        bootstrapSkipped: 0
      },
      states: new Map(),
      tools: new Map(),
      reconciled: new Set(),
      retryPersistence: sessionID => retryPendingPersistence(source, storage, totals, sessionID),
      flushMetadata: () => source.enqueue(() => persistScopeRegistry(source, totals)),
      enqueue: job => {
        const next = eventQueue.then(() => shutdownSignal?.aborted ? undefined : job()).catch(error => warn("reconciliation apply failed", error));
        eventQueue = next;
        return next;
      },
      requestMetadata: (sessionID, prioritize = true, ancestry = false) => {
        const sessionClient = input.client?.session;
        const get = sessionClient?.get;
        if (shutdownSignal?.aborted || typeof get !== "function" || source.scopes.isExcluded(sessionID) || source.outstanding.has(sessionID)) {
          source.queryStats.skipped++;
          return "skipped";
        }
        const now = performance.now();
        if (now - (source.queried.get(sessionID) ?? -Infinity) < QUERY_RETRY_MS) {
          source.queryStats.skipped++;
          return "skipped";
        }
        source.queried.delete(sessionID);
        source.queried.set(sessionID, now);
        while (source.queried.size > QUERY_CACHE_LIMIT) source.queried.delete(source.queried.keys().next().value);
        source.outstanding.add(sessionID);
        const generation = source.metadataGeneration.get(sessionID) ?? 0;
        const queued = runDeferred(source, async () => {
          if (shutdownSignal?.aborted) {
            source.outstanding.delete(sessionID);
            return;
          }
          const controller = new AbortController();
          let validResponse = false;
          try {
            // SDK v1's generated get(options) takes path.id. SDK v2's generated
            // get(parameters, options) takes sessionID; raw fields remain intact.
            const v2 = get.length >= 2;
            const response = await withTimeout(Promise.resolve().then(() => v2 ? get.call(sessionClient, {
              sessionID,
              ...(ancestry ? {
                classificationOnly: true
              } : {})
            }, {
              signal: AbortSignal.any([shutdownSignal, controller.signal])
            }) : get.call(sessionClient, {
              path: {
                id: sessionID
              },
              signal: AbortSignal.any([shutdownSignal, controller.signal])
            })), PARENT_LOOKUP_TIMEOUT_MS);
            const arrivedAt = Date.now();
            if (shutdownSignal?.aborted || !response || response.error) return;
            const raw = asRecord(response.data) ?? asRecord(response);
            const session = asRecord(raw?.session) ?? raw;
            if (!session || session.id !== sessionID) return;
            validResponse = true;
            const sessionAgent = normalizeAgentName(session.agent);
            await source.enqueue(async () => {
              if ((source.metadataGeneration.get(sessionID) ?? 0) !== generation) return;
              source.scopes.observeSessionMetadata(sessionID, session);
              discardExcludedPersistence(source);
              const parent = source.scopes.getEvidence(sessionID)?.parentSessionID;
              if (parent) {
                parentSessionCache.set(sessionID, parent);
                await safeRecordParentFact(activity, "session.metadata.resolved", sessionID, parent, arrivedAt, {}, {});
                source.requestMetadata(parent, true, true);
                // Late ancestry is a separate canonical fact in sessionScopes
                // and runs. Do not forge a newer completion to rewrite history.
              }
              queueSessionMetadata(source, sessionID, sessionAgent ? [sessionAgent] : []);
              await persistScopeRegistry(source, totals, source.states.has(sessionID) || source.responses.has(sessionID));
            });
          } catch {/* SDK failure/404 is unknown, never negative source proof. */} finally {
            controller.abort();
            source.outstanding.delete(sessionID);
            source.queryStats.settled++;
            if (validResponse) source.queryStats.validResponses++;else source.queryStats.unknownResponses++;
          }
        }, prioritize);
        if (!queued) {
          source.outstanding.delete(sessionID);
          source.queried.delete(sessionID);
          source.queryStats.rejected++;
          return "deferred";
        }
        source.queryStats.admitted++;
        return "scheduled";
      }
    };
    sourcesByRuntime.set(active, source);
    for (const [id, raw] of Object.entries(persisted?.messageScopes ?? {})) {
      const proof = coerceScopeEvidence(raw);
      if (proof?.sourceScope === "magic-message") source.messageScopes.set(id, proof);
    }
    for (const [id, contribution] of Object.entries({
      ...persisted?.settled,
      ...persisted?.open
    })) {
      const proof = contribution !== true ? coerceScopeEvidence(contribution.excluded) : undefined;
      if (proof?.sourceScope === "magic-message") source.messageScopes.set(id, proof);
    }
    for (const [id, proof] of Object.entries(source.scopes.serialize())) {
      if (proof.parentSessionID) parentSessionCache.set(id, proof.parentSessionID);
    }
    // The restored SID list is durable business work, not an LRU query cache.
    // Keep only compact IDs behind a cursor and admit a small look-ahead when
    // workers free slots. Submitting the whole list used to silently drop every
    // identity beyond 4 active + 2048 queued, including fresh foreground work.
    const bootstrapIDs = Object.keys(persisted?.sessions ?? {});
    source.queryStats.bootstrapTotal = bootstrapIDs.length;
    let bootstrapIndex = 0;
    let refilling = false;
    source.refillMetadata = () => {
      if (shutdownSignal.aborted) {
        bootstrapIDs.length = 0;
        source.refillMetadata = undefined;
        return;
      }
      if (refilling) return;
      refilling = true;
      try {
        while (!source.metadataPaused && bootstrapIndex < bootstrapIDs.length && source.jobs.length < QUERY_CONCURRENCY) {
          const result = source.requestMetadata(bootstrapIDs[bootstrapIndex], false);
          if (result === "deferred") break; // leave this obligation at the cursor
          bootstrapIndex++;
          source.queryStats.bootstrapVisited++;
          if (result === "scheduled") source.queryStats.bootstrapAdmitted++;else source.queryStats.bootstrapSkipped++;
        }
        if (bootstrapIndex === bootstrapIDs.length) {
          bootstrapIDs.length = 0;
          source.refillMetadata = undefined;
        }
      } finally {
        refilling = false;
      }
    };
    source.refillMetadata();
    // Establish the epoch when ingress is ready, not before asynchronous startup.
    responseRuntime(active).observedSince = Date.now();
    const event = payload => {
      if (shutdownSignal?.aborted) return Promise.resolve();
      const rawEvent = payload?.event;
      const incoming = unwrapIncomingEvent(rawEvent);
      if (isContentOnlyEvent(incoming?.type)) return Promise.resolve();
      if (incoming?.type === "server.instance.disposed") return dispose();
      const receivedAt = Date.now();
      let ingressEpoch = 0;
      if (incoming) {
        const properties = asRecord(incoming.properties) ?? asRecord(incoming.data) ?? {};
        const sid = readSessionIDFromEvent(incoming.type, properties, incoming);
        if (sid && eligibleSession(source, sid)) {
          const info = eventInfo(properties, incoming);
          const id = readMessageID(properties, info ?? {});
          const live = !isSnapshotIngress(incoming, properties);
          const assistantWork = live && info?.role === "assistant" && id && !metadata.completed.has(id);
          const deltaWork = live && (incoming.type.endsWith(".delta") || incoming.type.startsWith("session.next.step.")) && (id ? !metadata.completed.has(id) : responseRuntime(active).current.has(sid));
          const toolWork = live && properties.part?.type === "tool" && !["completed", "error"].includes(properties.part.state?.status);
          if (assistantWork) {
            source.responses.set(sid, id);
            const executionID = incoming.executionID ?? properties.executionID;
            if (typeof executionID === "string") source.responseExecutions.set(id, {
              sessionID: sid,
              executionID
            });
          }
          if (assistantWork || deltaWork || toolWork || lifecycleStateForEvent(incoming.type, properties, incoming)) {
            source.epochs.set(sid, (source.epochs.get(sid) ?? 0) + 1);
          }
          ingressEpoch = source.epochs.get(sid) ?? 0;
        }
      }
      const next = eventQueue.then(async () => {
        if (incoming?.type === "pulse.observation.gap") {
          await isolateObservation(activity, active, incoming.sessionID);
          return;
        }
        const controlID = typeof incoming?.sourceEventID === "string" ? incoming.sourceEventID : incoming?.id;
        if (!controlID || controlID !== source.lastControlID) {
          const report = await activity.writer.flush();
          for (const committed of report.committed) activity.writtenFacts.add(activityFactKey(committed));
          if (report.degraded && report.pendingCount === 0) {
            // A budget rejection permanently poisons that writer's admission.
            // Drain the accepted prefix, then replace BOTH writer and epoch.
            await activity.writer.close();
            activity.writer = createReliableActivityWriter(activity.ledger, {
              lease
            });
            await isolateObservation(activity, active);
            input.onActivityGap?.();
            warn("activity collection resumed in a new observation epoch");
          }
          await persistScopeRegistry(source, totals);
          try {
            await retryPendingPersistence(source, storage, totals, undefined);
          } catch (error) {
            warn("usage retry remains degraded", error);
          }
          source.lastControlID = controlID;
        }
        await handleEvent(rawEvent, input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, receivedAt, ingressEpoch);
        if (incoming?.type === "message.updated" || lifecycleStateForEvent(incoming?.type ?? "", incoming?.properties ?? {}, incoming ?? {})) {
          // Completed history already owns compact canonical contributions;
          // it cannot own live progress. Retiring that transient state needs
          // only current active/pending IDs, never another full history read.
          const retained = new Set([...active.keys(), ...source.pendingPersistence.keys()]);
          retireContentMetadata(metadata, retained);
        }
      }).catch(error => {
        warn("event handling failed", error);
      });
      eventQueue = next;
      return next;
    };
    let disposed;
    const dispose = () => disposed ??= (async () => {
      shutdown.abort();
      source.refillMetadata?.();
      source.jobs.length = 0;
      await Promise.allSettled(source.background);
      await eventQueue;
      try {
        for (let index = 0; index < Math.ceil(METADATA_PENDING_LIMIT / METADATA_BATCH_SIZE); index++) await persistScopeRegistry(source, totals);
        for (let index = 0; index < Math.ceil(PENDING_PERSISTENCE_LIMIT / 32); index++) await retryPendingPersistence(source, storage, totals, undefined);
      } catch (error) {
        warn("shutdown projection retry remains degraded", error);
      }
      await isolateObservation(activity, active);
      const reports = await Promise.allSettled([activity.writer.close(), usage.close()]);
      for (const report of reports) {
        if (report.status === "rejected") warn("shutdown flush failed; facts remain uncommitted", report.reason);else if (report.value.pendingCount) warn("shutdown has uncommitted facts", {
          pendingCount: report.value.pendingCount
        });
      }
      if (source.pendingPersistence.size || source.pendingSessionMetadata.size || source.scopeDirty.size || source.pendingMessageScopes.size) {
        warn("shutdown retains unconfirmed observations", {
          usage: source.pendingPersistence.size,
          metadata: source.pendingSessionMetadata.size,
          scopes: source.scopeDirty.size,
          messages: source.pendingMessageScopes.size
        });
      }
      disposeContentMetadata(metadata);
      await lease.release();
    })();
    input.registerV2Drain?.(dispose);
    return {
      event,
      dispose,
      runtimeStats: () => ({
        activeResponses: active.size,
        retainedProgress: metadata.progress.size,
        retainedRoles: metadata.roles.size,
        durablePending: source.pendingPersistence.size + (pendingUsageByStorage.get(storage) ?? 0),
        sourcePending: source.pendingPersistence.size,
        compactCompleted: completedMessageIDs.size,
        pendingSessionMetadata: source.pendingSessionMetadata.size,
        metadataProjection: {
          ...source.metadataProjection
        },
        pendingTools: source.tools.size,
        compactActivityIdentities: activity.writtenFacts.size,
        pendingMetadata: source.jobs.length + source.workers,
        metadata: {
          ...source.queryStats,
          queued: source.jobs.length,
          workers: source.workers
        }
      })
    };
  } catch (error) {
    shutdown.abort();
    await lease.release();
    throw error;
  }
};
export function resolveProjectDirectory(input) {
  if (typeof input.worktree === "string" && input.worktree.length > 0 && input.worktree !== "/") {
    return input.worktree;
  }
  return input.directory;
}
export function resolveHistoryPath(baseDirectory, configuredPath) {
  if (!configuredPath || configuredPath.trim().length === 0) {
    return joinPath(baseDirectory, DEFAULT_HISTORY_PATH);
  }
  if (configuredPath.startsWith("/")) return configuredPath;
  return joinPath(baseDirectory, configuredPath);
}
function initializeActivityRuntime(runtime) {
  const key = runtime.ledger.path;
  const previous = activityInitializationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(() => initializeActivityRuntimeNow(runtime));
  const settled = result.then(() => undefined, () => undefined);
  activityInitializationQueues.set(key, settled);
  void settled.then(() => {
    if (activityInitializationQueues.get(key) === settled) activityInitializationQueues.delete(key);
  });
  return result;
}
async function initializeActivityRuntimeNow(runtime) {
  const existing = await runtime.ledger.read({
    dedupe: false
  });
  const maxSeqByInstance = new Map();
  const recoveryEventIDs = new Set();
  for (const event of existing) {
    runtime.writtenFacts.add(activityFactKey(event));
    if (event.seq !== undefined) {
      maxSeqByInstance.set(event.instanceID, Math.max(maxSeqByInstance.get(event.instanceID) ?? 0, event.seq));
    }
    if (event.eventID.startsWith(`${ACTIVITY_EVENT_NAMESPACE}:recovery:`)) {
      recoveryEventIDs.add(event.eventID);
    }
  }
  runtime.nextSeq = (maxSeqByInstance.get(runtime.instanceID) ?? 0) + 1;
  const replay = replayActivity(existing);
  const recovery = [];
  for (const timeline of replay.timelines.values()) {
    for (const instance of timeline.instances) {
      if (!instance.open || instance.instanceID === runtime.instanceID) continue;
      const timestamp = reliableInstanceBoundary(instance.events, instance.boundary);
      if (timestamp === undefined) continue;
      const lastEvent = instance.events.at(-1);
      if (!lastEvent) continue;
      const eventID = recoveryEventID(instance.instanceID, instance.sessionID, lastEvent.eventID, timestamp);
      if (recoveryEventIDs.has(eventID)) continue;
      const seq = (maxSeqByInstance.get(instance.instanceID) ?? 0) + 1;
      maxSeqByInstance.set(instance.instanceID, seq);
      const parentSessionID = lastEvent.parentSessionID;
      const normalized = normalizeActivityEvent({
        kind: "lifecycle",
        state: "stopped",
        sessionID: instance.sessionID,
        timestamp,
        observedAt: timestamp,
        instanceID: instance.instanceID,
        seq,
        eventID,
        instanceEndedAt: timestamp,
        lastObservedAt: timestamp,
        ...(parentSessionID ? {
          parentSessionID
        } : {})
      });
      if (normalized?.kind === "lifecycle") recovery.push(normalized);
    }
  }
  if (recovery.length === 0) return;
  try {
    const appended = (await runtime.writer.enqueue(recovery)).committed;
    for (const event of appended) runtime.writtenFacts.add(activityFactKey(event));
  } catch (error) {
    warn("activity recovery write failed", error);
  }
}
async function captureActivityForEvent(runtime, type, properties, event, timestamp) {
  const sessionID = readSessionIDFromEvent(type, properties, event);
  if (!sessionID) return;
  const parentSessionID = readParentSessionIDFromEvent(type, properties, event);
  await safeRecordParentFact(runtime, type, sessionID, parentSessionID, timestamp, properties, event);
  const state = lifecycleStateForEvent(type, properties, event);
  if (!state) return;
  const lifecycleEvent = prepareLifecycleActivityEvent(runtime, type, sessionID, state, timestamp, parentSessionID, properties, event);
  await safeAppendLifecycle(runtime, lifecycleEvent.event);
}
function activityFactKey(event) {
  return JSON.stringify([event.kind, event.eventID, event.sessionID, event.kind === "lifecycle" ? event.state : null, event.parentSessionID ?? null, event.timestamp, event.observedAt, event.instanceID, event.seq ?? null, event.instanceEndedAt ?? null, event.lastObservedAt ?? null]);
}
function recoveryEventID(instanceID, sessionID, lastEventID, timestamp) {
  return `${ACTIVITY_EVENT_NAMESPACE}:recovery:${encodeURIComponent(instanceID)}:${encodeURIComponent(sessionID)}:${encodeURIComponent(lastEventID)}:${timestamp}`;
}
function reliableInstanceBoundary(events, replayBoundary) {
  const boundary = numberOrUndefined(replayBoundary);
  if (boundary !== undefined) return boundary;
  const timestamps = events.map(event => event.timestamp).filter(value => numberOrUndefined(value) !== undefined);
  return timestamps.length === 0 ? undefined : Math.max(...timestamps);
}
function rawEventKey(type, event) {
  const properties = asRecord(event.properties) ?? {};
  const info = eventInfo(properties, event);
  return stableSerialize([type, event.id, event.revision, properties.sessionID, properties.messageID, properties.status, properties.state, properties.parentID, properties.parentSessionID, info?.id, info?.sessionID, info?.role, info?.time, info?.tokens, info?.cost]);
}
function needsActivityIdentity(type, properties, event) {
  if (lifecycleStateForEvent(type, properties, event) !== undefined) return true;
  if (readParentSessionIDFromEvent(type, properties, event) !== undefined) return true;
  if (type !== "message.updated") return false;
  const info = eventInfo(properties, event);
  return info?.role === "assistant" && isCompleted(info, properties, event);
}
function runtimeEventTimestamp(runtime, rawKey, event, properties, receivedAt = Date.now()) {
  const explicit = explicitEventTimestamp(event, properties);
  if (explicit !== undefined) return explicit;
  const previous = runtime.rawTimestamps.get(rawKey);
  if (previous !== undefined) return previous;
  const timestamp = receivedAt;
  runtime.rawTimestamps.set(rawKey, timestamp);
  return timestamp;
}
function prepareLifecycleActivityEvent(runtime, type, sessionID, state, timestamp, parentSessionID, properties, event) {
  const boundary = activityBoundaries(properties, event);
  const observedAt = activityObservedAt(properties, event, timestamp);
  const sourceID = sourceEventID(type, properties, event);
  const assignmentKey = stableSerialize([runtime.sessionEpochs.get(sessionID) ?? runtime.instanceID, "lifecycle", type, sourceID ?? null, sessionID, state, parentSessionID ?? null, timestamp, observedAt, boundary.instanceEndedAt ?? null, boundary.lastObservedAt ?? null]);
  const existing = runtime.assignments.get(assignmentKey);
  if (existing?.kind === "lifecycle") return {
    event: existing,
    assignmentKey
  };
  const base = {
    version: ACTIVITY_VERSION,
    kind: "lifecycle",
    state,
    sessionID,
    timestamp,
    observedAt,
    instanceID: runtime.sessionEpochs.get(sessionID) ?? runtime.instanceID,
    ...(readStringFrom([event, properties], ["executionID"]) ? {
      executionID: readStringFrom([event, properties], ["executionID"])
    } : {}),
    ...(sourceID ? {
      sourceEventID: readStringFrom([event, properties], ["sourceEventID"]) ?? sourceID
    } : {}),
    ...(numberOrUndefined(event.sourceSequence ?? event.durable?.seq) === undefined ? {} : {
      sourceSequence: numberOrUndefined(event.sourceSequence ?? event.durable?.seq)
    }),
    ...(parentSessionID ? {
      parentSessionID
    } : {}),
    ...boundary
  };
  const eventID = sourceID ? namespacedSourceEventID(type, sourceID, "lifecycle") : normalizeActivityEvent(base)?.eventID;
  const normalized = normalizeActivityEvent({
    ...base,
    seq: runtime.nextSeq++,
    ...(eventID ? {
      eventID
    } : {})
  });
  if (!normalized || normalized.kind !== "lifecycle") {
    throw new TypeError("Unable to normalize lifecycle activity event");
  }
  runtime.assignments.set(assignmentKey, normalized);
  return {
    event: normalized,
    assignmentKey
  };
}
function prepareParentActivityEvent(runtime, type, sessionID, parentSessionID, timestamp, properties, event) {
  const boundary = activityBoundaries(properties, event);
  const observedAt = activityObservedAt(properties, event, timestamp);
  const sourceID = sourceEventID(type, properties, event);
  const assignmentKey = stableSerialize([runtime.sessionEpochs.get(sessionID) ?? runtime.instanceID, "parent", type, sourceID ?? null, sessionID, parentSessionID, timestamp, observedAt, boundary.instanceEndedAt ?? null, boundary.lastObservedAt ?? null]);
  const existing = runtime.assignments.get(assignmentKey);
  if (existing?.kind === "parent") return {
    event: existing,
    assignmentKey
  };
  const base = {
    version: ACTIVITY_VERSION,
    kind: "parent",
    sessionID,
    parentSessionID,
    timestamp,
    observedAt,
    instanceID: runtime.instanceID,
    ...(sourceID ? {
      sourceEventID: readStringFrom([event, properties], ["sourceEventID"]) ?? sourceID
    } : {}),
    ...(numberOrUndefined(event.sourceSequence ?? event.durable?.seq) === undefined ? {} : {
      sourceSequence: numberOrUndefined(event.sourceSequence ?? event.durable?.seq)
    }),
    ...boundary
  };
  const eventID = sourceID ? namespacedSourceEventID(type, sourceID, "parent") : normalizeActivityEvent(base)?.eventID;
  const normalized = normalizeActivityEvent({
    ...base,
    seq: runtime.nextSeq++,
    ...(eventID ? {
      eventID
    } : {})
  });
  if (!normalized || normalized.kind !== "parent") {
    throw new TypeError("Unable to normalize parent activity event");
  }
  runtime.assignments.set(assignmentKey, normalized);
  return {
    event: normalized,
    assignmentKey
  };
}
async function safeAppendLifecycle(runtime, event) {
  const factKey = activityFactKey(event);
  if (runtime.writtenFacts.has(factKey)) return;
  try {
    const report = await runtime.writer.enqueue([event]);
    for (const appended of report.committed) runtime.writtenFacts.add(activityFactKey(appended));
    const last = runtime.observations.get(event.sessionID);
    if (!last || event.timestamp >= last.timestamp && (event.sourceSequence === undefined || last.sourceSequence === undefined || event.sourceSequence >= last.sourceSequence)) {
      if (isActiveState(event.state)) runtime.observations.set(event.sessionID, event);else runtime.observations.delete(event.sessionID);
    }
    if (report.degraded) warn("activity persistence degraded", {
      pendingCount: report.pendingCount
    });
  } catch (error) {
    runtime.sessionEpochs.set(event.sessionID, randomUUID());
    runtime.observations.delete(event.sessionID);
    if (event.executionID) runtime.invalidExecutions.add(event.executionID);
    warn("activity lifecycle write failed", error);
  }
}
async function safeAppendParent(runtime, event) {
  const factKey = activityFactKey(event);
  if (runtime.writtenFacts.has(factKey)) return;
  try {
    const report = await runtime.writer.enqueue([event]);
    for (const appended of report.committed) runtime.writtenFacts.add(activityFactKey(appended));
    if (report.degraded) warn("activity persistence degraded", {
      pendingCount: report.pendingCount
    });
  } catch (error) {
    warn("activity parent write failed", error);
  }
}
async function safeRecordParentFact(runtime, type, sessionID, parentSessionID, timestamp, properties, event) {
  if (!parentSessionID || parentSessionID === sessionID) return;
  try {
    const parentEvent = prepareParentActivityEvent(runtime, type, sessionID, parentSessionID, timestamp, properties, event);
    await safeAppendParent(runtime, parentEvent.event);
  } catch (error) {
    warn("parent fact handling failed", error);
  }
}
function sourceEventID(type, properties, event) {
  const explicit = readStringFrom([event, properties, asRecord(event.event), asRecord(properties.event), asRecord(properties.info), asRecord(properties.session), asRecord(event.info), asRecord(event.session)], ["eventID", "eventId"]);
  if (explicit) return explicit;
  const eventID = readStringFrom([event, properties, asRecord(event.event), asRecord(properties.event), asRecord(properties.info), asRecord(properties.session), asRecord(event.info), asRecord(event.session)], ["id"]);
  if (eventID) return eventID;
  return undefined;
}
function namespacedSourceEventID(type, sourceID, kind) {
  return `${ACTIVITY_EVENT_NAMESPACE}:source:${kind}:${encodeURIComponent(type)}:${encodeURIComponent(sourceID)}`;
}

/** Freeze only observed time, never the wall clock on reconnect/overflow. */
async function isolateObservation(runtime, active, sessionID) {
  for (const [id, last] of runtime.observations) {
    if (sessionID && id !== sessionID) continue;
    if (last.executionID) runtime.invalidExecutions.add(last.executionID);
    if (last.kind === "lifecycle" && isActiveState(last.state)) {
      const terminal = normalizeActivityEvent({
        ...last,
        state: "stopped",
        sourceEventID: undefined,
        sourceSequence: undefined,
        seq: runtime.nextSeq++,
        eventID: `${ACTIVITY_EVENT_NAMESPACE}:gap:${randomUUID()}`,
        instanceEndedAt: last.timestamp,
        lastObservedAt: last.timestamp
      });
      if (terminal?.kind === "lifecycle") await safeAppendLifecycle(runtime, terminal);
    }
    runtime.observations.delete(id);
    runtime.sessionEpochs.set(id, randomUUID());
  }
  if (!sessionID) {
    runtime.instanceID = randomUUID();
    runtime.nextSeq = 1;
    runtime.sessionEpochs.clear();
  }
  for (const [id, state] of active) if (!sessionID || state.sessionID === sessionID) active.delete(id);
  const responses = responseRuntime(active);
  if (sessionID) {
    responses.current.delete(sessionID);
    responses.closed.add(sessionID);
  } else {
    responses.current.clear();
    responses.closed.clear();
  }
  responses.observedSince = Date.now();
  const metadata = runtimeContentMetadata(active);
  metadata.progress.clear();
  metadata.roles.clear();
  const source = sourcesByRuntime.get(active);
  if (source) {
    if (sessionID) source.queried.delete(sessionID);else source.queried.clear();
    for (const id of source.outstanding) source.metadataGeneration.set(id, (source.metadataGeneration.get(id) ?? 0) + 1);
    for (const [id, owner] of source.responseExecutions) if (!sessionID || owner.sessionID === sessionID) source.responseExecutions.delete(id);
    for (const [id, tool] of source.tools) if (!sessionID || tool.sessionID === sessionID) source.tools.delete(id);
    if (sessionID) {
      source.states.delete(sessionID);
      source.responses.delete(sessionID);
      source.epochs.set(sessionID, (source.epochs.get(sessionID) ?? 0) + 1);
    } else {
      source.states.clear();
      source.responses.clear();
      for (const [id, epoch] of source.epochs) source.epochs.set(id, epoch + 1);
    }
  }
}
function activityObservedAt(properties, event, timestamp) {
  return numberFromSources([event, properties, asRecord(event.event), asRecord(properties.event), asRecord(properties.info), asRecord(properties.session), asRecord(event.info), asRecord(event.session)], ["observedAt"]) ?? timestamp;
}
function activityBoundaries(properties, event) {
  const sources = [event, properties, asRecord(event.event), asRecord(properties.event), asRecord(properties.info), asRecord(properties.session), asRecord(event.info), asRecord(event.session)];
  const instanceEndedAt = numberFromSources(sources, ["instanceEndedAt", "instanceEndAt"]);
  const lastObservedAt = numberFromSources(sources, ["lastObservedAt"]);
  return {
    ...(instanceEndedAt === undefined ? {} : {
      instanceEndedAt
    }),
    ...(lastObservedAt === undefined ? {} : {
      lastObservedAt
    })
  };
}

/** Session-entity agent only. Assistant message ids are not session ids, and mode/title are ignored. */
function matchingSessionAgent(sessionID, candidates) {
  for (const candidate of candidates) {
    const entity = asRecord(candidate);
    if (!entity || entity.id !== sessionID) continue;
    if (entity.role === "assistant" || entity.role === "user") continue;
    const name = normalizeAgentName(entity.agent);
    if (name) return name;
  }
  return undefined;
}
function readSessionIDFromEvent(type, properties, event) {
  const direct = readStringFrom([properties, event], ["sessionID", "sessionId", "session.id"]);
  if (direct) return direct;
  const sessionObjectID = readStringFrom([asRecord(properties.session), asRecord(event.session), asRecord(properties.event), asRecord(event.event)], ["id"]);
  if (sessionObjectID) return sessionObjectID;
  const nested = [asRecord(properties.part), asRecord(event.part), asRecord(properties.session), asRecord(properties.event), asRecord(event.session), asRecord(event.event), asRecord(properties.info), asRecord(event.info)];
  const sessionID = readStringFrom(nested, ["sessionID", "sessionId", "session.id"]);
  if (sessionID) return sessionID;
  if (type === "session.status" || type.startsWith("session.")) {
    const nestedID = readStringFrom([asRecord(properties.info), asRecord(event.info), asRecord(properties.event), asRecord(event.event)], ["id"]);
    if (nestedID) return nestedID;
    if (type === "session.created" || type === "session.updated") {
      return readStringFrom([properties, event], ["id"]);
    }
  }
  return undefined;
}
function readParentSessionIDFromEvent(type, properties, event) {
  const normalizedType = type.toLowerCase();
  const sources = [properties, event, asRecord(properties.info), asRecord(properties.message), asRecord(properties.event), asRecord(event.info), asRecord(event.message), asRecord(event.event)];
  const explicit = readStringFrom(sources, ["parentSessionID", "parentSessionId"]);
  if (explicit) return explicit;
  const sessionSources = sessionEntitySources([properties, event, asRecord(properties.info), asRecord(event.info), asRecord(properties.event), asRecord(event.event)]);
  if (normalizedType === "session.created" || normalizedType === "session.updated") {
    for (const source of [properties, event, asRecord(properties.info), asRecord(properties.event), asRecord(event.info), asRecord(event.event)]) {
      if (source) sessionSources.push(source);
    }
  }
  return readStringFrom(sessionSources, ["parentID", "parentSessionID", "parentSessionId", "parent.id"]);
}
function sessionEntitySources(sources) {
  const entities = [];
  for (const source of sources) {
    if (!source) continue;
    for (const key of ["session", "data.session", "event.session"]) {
      const entity = asRecord(getPath(source, key));
      if (entity) entities.push(entity);
    }
  }
  return entities;
}
function numberFromSources(sources, keys) {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = numberOrUndefined(getPath(source, key));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
function lifecycleStateForEvent(type, properties, event) {
  const normalizedType = type.toLowerCase();
  const isStatusEvent = normalizedType === "session.status" || normalizedType.endsWith(".status");
  const isTerminalEvent = normalizedType === "session.error" || normalizedType === "session.abort" || normalizedType === "session.aborted" || normalizedType === "session.cancel" || normalizedType === "session.cancelled" || normalizedType === "session.stop" || normalizedType === "session.stopped" || normalizedType === "session.completed";
  const isCanonicalRetry = normalizedType === "session.next.retried";
  const isCanonicalFailure = normalizedType === "session.next.step.failed";
  if (normalizedType !== "session.idle" && !isStatusEvent && !isTerminalEvent && !isCanonicalRetry && !isCanonicalFailure) return undefined;
  const values = [properties.status, properties.state, event.status, event.state, asRecord(properties.info)?.status, asRecord(properties.info)?.state, asRecord(properties.session)?.status, asRecord(properties.session)?.state, asRecord(properties.event)?.status, asRecord(properties.event)?.state, asRecord(event.info)?.status, asRecord(event.info)?.state, asRecord(event.session)?.status, asRecord(event.session)?.state, asRecord(event.event)?.status, asRecord(event.event)?.state];
  const names = values.flatMap(value => statusNames(value));
  const normalized = names.map(value => value.toLowerCase());
  if (normalizedType === "session.idle") return "idle";
  if (normalizedType === "session.error") return "failed";
  if (normalizedType === "session.abort" || normalizedType === "session.aborted") return "aborted";
  if (normalizedType === "session.cancel" || normalizedType === "session.cancelled") return "cancelled";
  if (normalizedType === "session.stop" || normalizedType === "session.stopped") return "stopped";
  if (normalizedType === "session.completed") return "completed";
  if (isCanonicalRetry) return "retry";
  if (isCanonicalFailure) return "failed";
  if (normalized.includes("busy")) return "busy";
  if (normalized.includes("retry")) return "retry";
  if (normalized.includes("idle")) return "idle";
  if (normalized.includes("completed") || normalized.includes("complete") || normalized.includes("done")) return "completed";
  if (normalized.includes("failed") || normalized.includes("failure") || normalized.includes("error")) return "failed";
  if (normalized.includes("aborted") || normalized.includes("abort")) return "aborted";
  if (normalized.includes("cancelled") || normalized.includes("canceled") || normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("stopped") || normalized.includes("stop")) return "stopped";
  return undefined;
}
function statusNames(value, seen = new Set()) {
  if (typeof value === "string") return [value];
  if (!isRecord(value) || seen.has(value)) return [];
  seen.add(value);
  const names = ["status", "state", "type", "name"].flatMap(key => statusNames(value[key], seen));
  seen.delete(value);
  return names;
}
function stableSerialize(value, seen = new Set()) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = `[${value.map(entry => stableSerialize(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  const record = value;
  const result = `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return result;
}
function unwrapIncomingEvent(value) {
  const outer = asRecord(value);
  if (!outer) return undefined;
  if (typeof outer.type === "string") return outer;
  const nested = asRecord(outer.event) ?? asRecord(outer.payload);
  if (nested && typeof nested.type === "string") return nested;
  return outer;
}
async function handleEvent(rawEvent, input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, receivedAt, ingressEpoch) {
  try {
    const event = unwrapIncomingEvent(rawEvent);
    if (!event) return;
    const type = typeof event.type === "string" ? event.type : "";
    const properties = asRecord(event.properties) ?? asRecord(event.data) ?? {};
    const source = sourcesByRuntime.get(active);
    if (type === "pulse.activity") {
      const fact = asRecord(properties.fact);
      if (!fact || typeof fact.sessionID !== "string") return;
      if (fact.kind === "execution-scope" && activity.invalidExecutions.has(fact.executionID)) return;
      const instanceID = activity.sessionEpochs.get(fact.sessionID) ?? activity.instanceID;
      const assignmentKey = stableSerialize([instanceID, fact]);
      const normalized = activity.assignments.get(assignmentKey) ?? normalizeActivityEvent({
        ...fact,
        version: ACTIVITY_VERSION,
        instanceID,
        seq: activity.nextSeq++,
        observedAt: fact.timestamp
      });
      if (!normalized) return;
      activity.assignments.set(assignmentKey, normalized);
      if (activity.writtenFacts.has(activityFactKey(normalized))) return;
      try {
        const report = await activity.writer.enqueue([normalized]);
        for (const committed of report.committed) activity.writtenFacts.add(activityFactKey(committed));
        const last = activity.observations.get(fact.sessionID);
        if (last?.kind === "lifecycle" && isActiveState(last.state) && last.executionID === normalized.executionID && normalized.timestamp > last.timestamp) {
          activity.observations.set(fact.sessionID, {
            ...last,
            timestamp: normalized.timestamp
          });
        }
      } catch (error) {
        activity.invalidExecutions.add(fact.executionID);
        activity.sessionEpochs.set(fact.sessionID, randomUUID());
        activity.observations.delete(fact.sessionID);
        warn("work activity persistence degraded", error);
      }
      return;
    }
    if (type === "pulse.tool") {
      if (typeof properties.toolID === "string" && typeof properties.sessionID === "string") {
        const key = JSON.stringify([properties.sessionID, properties.executionID ?? null, properties.stepID ?? properties.messageID ?? null, properties.toolID]);
        if (properties.pending) source.tools.set(key, {
          sessionID: properties.sessionID,
          executionID: properties.executionID,
          pending: true
        });else source.tools.delete(key);
      }
      return;
    }
    const sessionID = readSessionIDFromEvent(type, properties, event);
    const info = eventInfo(properties, event);
    let messageProof;
    let scopeChanged = false;
    if (sessionID) {
      const before = source.scopes.revision;
      const parent = readParentSessionIDFromEvent(type, properties, event);
      if (parent) {
        parentSessionCache.set(sessionID, parent);
        source.scopes.observeSessionMetadata(sessionID, {
          parentSessionID: parent
        });
      }
      for (const raw of [asRecord(properties.session), asRecord(event.session)]) {
        if (raw) source.scopes.observeSessionMetadata(sessionID, raw);
      }
      if (type === "session.created" || type === "session.updated") {
        // Observe the raw SDK entity (including fields absent from SDK typings).
        for (const raw of [properties, event, asRecord(properties.session), asRecord(event.session), info]) {
          if (raw) source.scopes.observeSessionMetadata(sessionID, raw);
        }
        source.metadataGeneration.set(sessionID, (source.metadataGeneration.get(sessionID) ?? 0) + 1);
        const sessionAgent = matchingSessionAgent(sessionID, [asRecord(properties.session), asRecord(event.session), properties, event, asRecord(properties.info), asRecord(event.info), info]);
        if (sessionAgent) {
          queueSessionMetadata(source, sessionID, [sessionAgent]);
          await persistScopeRegistry(source, totals);
        }
      }
      if (info?.role === "assistant") {
        messageProof = source.scopes.observeMessageMetadata(sessionID, info);
        const id = readMessageID(properties, info);
        if (id && messageProof.sourceScope === "magic-message") {
          source.messageScopes.set(id, messageProof);
          source.pendingMessageScopes.add(id);
          await persistScopeRegistry(source, totals);
          const old = (await storage.read()).find(record => record.messageID === id);
          if (old) {
            const annotated = {
              ...old,
              scope: messageProof
            };
            await persistCompletedRecord(source, storage, totals, annotated);
          }
          retireResponse(active, id, sessionID);
          completedMessageIDs.add(id);
        }
      }
      scopeChanged = source.scopes.revision !== before;
      if (scopeChanged) {
        source.metadataGeneration.set(sessionID, (source.metadataGeneration.get(sessionID) ?? 0) + 1);
        source.scopeDirty.add(sessionID);
      }
      discardExcludedPersistence(source);
      source.requestMetadata(sessionID);
      if (parent) source.requestMetadata(parent, true, true);
    }
    const messageID = readMessageID(properties, info ?? {});
    const excluded = sessionID && (!eligibleSession(source, sessionID) || messageID && source.messageScopes.has(messageID));
    if (excluded) {
      if (scopeChanged) await persistScopeRegistry(source, totals);
      if (messageID && sessionID) {
        retireResponse(active, messageID, sessionID);
        completedMessageIDs.add(messageID);
      }
      // Known hidden activity never extends the user task or creates counters.
      return;
    }
    if (type === "message.part.delta" || type === "session.next.text.delta" || type === "session.next.reasoning.delta" || type === "session.next.tool.input.delta") {
      recordDelta(active, properties, event, receivedAt, type === "message.part.delta" ? "legacy" : "v2");
      if (scopeChanged) await persistScopeRegistry(source, totals);
      return;
    }
    if (scopeChanged) await persistScopeRegistry(source, totals);
    const lifecycle = lifecycleStateForEvent(type, properties, event);
    const eventExecutionID = event.executionID ?? properties.executionID;
    const observedExecutionID = sessionID ? activity.observations.get(sessionID)?.executionID : undefined;
    const staleTerminal = lifecycle && !isActiveState(lifecycle) && eventExecutionID && observedExecutionID && eventExecutionID !== observedExecutionID;
    if (sessionID && lifecycle && !staleTerminal) {
      source.states.set(sessionID, lifecycle);
      if (!isActiveState(lifecycle)) for (const [key, tool] of source.tools) {
        if (tool.sessionID === sessionID && tool.executionID === (event.executionID ?? properties.executionID)) source.tools.delete(key);
      }
    }
    const part = asRecord(properties.part);
    if (part?.type === "tool" && typeof part.id === "string" && sessionID) {
      source.tools.set(JSON.stringify([sessionID, eventExecutionID ?? null, part.messageID ?? properties.messageID ?? null, part.id]), {
        sessionID,
        executionID: eventExecutionID,
        pending: !["completed", "error"].includes(part.state?.status)
      });
    }
    if (!staleTerminal) recordResponseLifecycle(active, type, properties, event, receivedAt);
    const explicitTimestamp = explicitEventTimestamp(event, properties);
    const rawKey = explicitTimestamp === undefined && needsActivityIdentity(type, properties, event) ? rawEventKey(type, event) : undefined;
    const timestamp = explicitTimestamp ?? (rawKey === undefined ? receivedAt : runtimeEventTimestamp(activity, rawKey, event, properties, receivedAt));
    try {
      await captureActivityForEvent(activity, type, properties, event, timestamp);
    } catch (error) {
      warn("activity event handling failed", error);
    }
    if (type === "message.part.updated") {
      recordPartMetadata(active, properties, timestamp, event);
      return;
    }
    if (type === "message.updated") {
      try {
        await handleMessageUpdated(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, event, properties, timestamp, receivedAt);
      } finally {
        if (info?.role === "assistant" && messageID && sessionID && !isSnapshotIngress(event, properties) && isCompleted(info, properties, event)) {
          // Lifecycle ownership is independent of accepting a usage correction.
          retireResponse(active, messageID, sessionID);
          completedMessageIDs.add(messageID);
          scheduleIdleReconciliation(input, source, activity, active, sessionID, messageID, info, ingressEpoch);
        }
      }
      return;
    }
    if (type === "session.next.step.started") {
      recordResponseStep(active, properties, event, timestamp);
      return;
    }
    if (type === "session.next.step.ended") {
      recordStepFallback(active, completedMessageIDs, properties, event, timestamp);
      return;
    }
    if (isIdleEvent(type, properties, event) && !staleTerminal) {
      await flushIdleStates(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, properties, event, timestamp);
      // An authoritative terminal event retires only this session's tool
      // ownership. A still-busy legitimate child remains independently active.
      for (const [id, tool] of source.tools) if (tool.sessionID === sessionID && (eventExecutionID === undefined || tool.executionID === eventExecutionID)) source.tools.delete(id);
      await retryPendingPersistence(source, storage, totals, sessionID);
    }
  } catch (error) {
    warn("event parsing failed", error);
  }
}
function recordDelta(active, properties, event, timestamp, stream) {
  const sessionID = readSessionIDFromEvent("message.part.delta", properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const metadata = runtimeContentMetadata(active);
  if (isSnapshotIngress(event, properties)) return;
  if (!messageID && responseRuntime(active).closed.has(sessionID)) return;
  if (messageID && (metadata.completed.has(messageID) || metadata.roles.has(messageID) && metadata.roles.get(messageID) !== "assistant")) return;
  const delta = readDelta(properties, event);
  if (!acceptedContentDelta(properties, event, stream, delta)) return;
  const key = messageID ?? pendingKey(sessionID);
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  if (state.sessionID !== sessionID) return;
  bindPendingTaint(active, state);
  if (!state.observedFromStart || !messageID) taintResponse(active, state, "unobserved-response-start");
  if (!state.liveAssistant || responseRuntime(active).current.get(sessionID) !== messageID) taintResponse(active, state, "not-current-assistant");
  if (timestamp < state.startedAt) state.startedAt = timestamp;
  state.firstTokenAt = Math.min(state.firstTokenAt ?? timestamp, timestamp);
  state.timing = recordContentArrival({
    ...state.timing,
    start: state.startedAt
  }, timestamp);
  state[stream].hasData = true;
  active.set(messageID ?? key, state);
}

/** Accept a content delta without hashing its text or recording a speed sample. */
function acceptedContentDelta(properties, event, stream, delta) {
  if (!delta) return false;
  const type = properties.part?.type ?? properties.kind ?? properties.type ?? (properties.reasoningID !== undefined || properties.field === "reasoning" || event.type === "session.next.reasoning.delta" ? "reasoning" : properties.callID !== undefined || event.type === "session.next.tool.input.delta" ? "tool" : "text");
  const field = properties.field;
  if (stream === "legacy") {
    if (typeof type === "string" && !["text", "reasoning", "tool", "output"].includes(type)) return false;
    if (type === "tool" && field !== "input" && field !== "state.input" && field !== "state.raw") return false;
    if (typeof field === "string" && !["text", "reasoning", "input", "state.input", "state.raw"].includes(field)) return false;
    if (properties.output !== undefined || properties.result !== undefined) return false;
  }
  return true;
}
function recordResponseStep(active, properties, event, timestamp) {
  const sessionID = readSessionIDFromEvent(event.type, properties, event);
  const messageID = readMessageID(properties);
  if (!sessionID || messageID && runtimeContentMetadata(active).completed.has(messageID)) return;
  if (!messageID && responseRuntime(active).closed.has(sessionID)) return;
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  bindPendingTaint(active, state);
  const id = properties.stepID ?? properties.stepId ?? properties.step?.id ?? properties.part?.id ?? properties.id;
  state.progress ??= cachedContentProgress(runtimeContentMetadata(active), messageID ?? pendingKey(sessionID));
  noteStepIdentity(state.progress, typeof id === "string" ? id : undefined);
  active.set(messageID ?? pendingKey(sessionID), state);
}
function recordStepFallback(active, completedMessageIDs, properties, event, timestamp) {
  const sessionID = readSessionIDFromEvent("session.next.step.ended", properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  if (messageID && completedMessageIDs.has(messageID)) return;
  if (!messageID && responseRuntime(active).closed.has(sessionID)) return;
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  const info = eventInfo(properties, event);
  state.progress ??= cachedContentProgress(runtimeContentMetadata(active), messageID ?? pendingKey(sessionID));
  active.set(messageID ?? pendingKey(sessionID), state);
  recordResponseStep(active, properties, event, timestamp);
  const tokens = tokenFields(info?.tokens ?? properties.tokens ?? properties);
  state.fallbackTokens = mergeFallbackTokens(state.fallbackTokens, tokens);
  state.model = state.model ?? modelName(info);
  const notedAgent = normalizeAgentName(info?.agent);
  if (notedAgent) state.agent = notedAgent;
  state.cost = numberOrUndefined(info?.cost ?? properties.cost) ?? state.cost;
  active.set(messageID ?? pendingKey(sessionID), state);
}
async function handleMessageUpdated(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, event, properties, timestamp, receivedAt) {
  const info = eventInfo(properties, event);
  if (!info) return;
  const messageID = readMessageID(properties, info);
  const sessionID = readSessionIDFromEvent("message.updated", properties, event);
  if (!messageID || !sessionID) return;
  const metadata = runtimeContentMetadata(active);
  if (typeof info.role === "string") metadata.roles.set(messageID, info.role);
  if (info.role !== "assistant") {
    active.delete(messageID);
    return;
  }
  if (!isCompleted(info, properties, event)) {
    // Only a newly created live assistant may receive metadata-only Thinking.
    // Old unfinished snapshots are not evidence of a new response in this runtime.
    if (metadata.completed.has(messageID) || isSnapshotIngress(event, properties)) return;
    const created = numberOrUndefined(info.time?.created ?? info.time?.start);
    if (created === undefined || created < responseRuntime(active).observedSince || created > timestamp) return;
    if (active.get(messageID)?.liveAssistant === false) return;
    for (const candidate of active.values()) {
      if (candidate.sessionID !== sessionID || candidate.messageID === messageID || !candidate.liveAssistant) continue;
      if (candidate.startedAt > created) return;
      candidate.liveAssistant = false;
      taintResponse(active, candidate, "superseded-assistant");
    }
    const state = getOrCreateState(active, messageID, sessionID, created);
    if (state.sessionID !== sessionID) return;
    state.startedAt = Math.min(state.startedAt, created);
    state.timing = {
      ...state.timing,
      start: state.startedAt
    };
    state.liveAssistant = true;
    const cached = cachedContentProgress(metadata, messageID);
    if (state.observedFromStart === undefined) {
      const reportedUsage = tokenFields(info.tokens);
      const alreadyGenerating = [info.time?.firstToken, info.time?.firstContent, info.time?.firstResponse].some(hasNumber) || (reportedUsage.output ?? 0) > 0 || (reportedUsage.reasoning ?? 0) > 0 || ["in_progress", "in-progress", "recovering", "recovered"].includes(info.status);
      state.observedFromStart = created <= receivedAt && created >= responseRuntime(active).observedSince && !alreadyGenerating && !state.legacy.hasData && !state.v2.hasData && ![...cached.parts.values()].some(part => part.snapshotBytes > 0 || part.deltaBytes > 0);
      state.progress = mergeContentProgress(createContentProgress({
        fromCurrentStart: state.observedFromStart
      }), state.progress ?? cached);
      metadata.progress.set(messageID, state.progress);
    }
    bindPendingTaint(active, state);
    const notedAgent = normalizeAgentName(info.agent);
    if (notedAgent) state.agent = notedAgent;
    responseRuntime(active).current.set(sessionID, messageID);
    responseRuntime(active).closed.delete(sessionID);
    active.set(messageID, state);
    return;
  }
  if (isSnapshotIngress(event, properties)) return;
  const source = sourcesByRuntime.get(active);
  // A failed history write must not prevent building the full completion from
  // LIVE evidence. A retained non-LIVE candidate also survives partial/replayed
  // completion facts without regenerating its calibrated samples or clocks.
  const retained = await storage.read().catch(error => {
    warn("history read failed", error);
    return [];
  });
  const previous = source.pendingPersistence.get(messageID)?.record ?? retained.find(record => record.messageID === messageID);
  const ledger = await totals.read().catch(() => undefined);
  const snapshot = (ledger && Object.prototype.hasOwnProperty.call(ledger.open, messageID) ? ledger.open[messageID] : undefined) ?? (ledger && Object.prototype.hasOwnProperty.call(ledger.settled, messageID) ? ledger.settled[messageID] : undefined);
  if (snapshot === true) {
    // No reversible contribution survives. Do not reconstruct a history slot
    // or manufacture speed coverage from an already-accounted old response.
    completedMessageIDs.add(messageID);
    metadata.completed.add(messageID);
    forgetPendingPersistence(source, messageID);
    active.delete(messageID);
    return;
  }
  const prior = previous ?? snapshot;
  const exactTokens = tokenFields(info.tokens);
  // Missing reasoning is a partial correction, never an authoritative zero.
  // This applies to both retained history and reversible settled snapshots;
  // step fallback cannot make an incomplete completion correction authoritative.
  if (prior && (prior.quality ?? "exact") === "exact" && prior.tokens.reasoning > 0 && exactTokens.reasoning === undefined) {
    completedMessageIDs.add(messageID);
    metadata.completed.add(messageID);
    return;
  }
  const priorUpdate = coerceCompletionUpdate(prior?.update);
  const fingerprint = createHash("sha256").update(stableSerialize(properties.v2Completion ?? {
    id: info.id,
    sessionID: info.sessionID,
    role: info.role,
    agent: info.agent,
    model: info.model,
    tokens: info.tokens,
    cost: info.cost,
    finish: info.finish,
    time: info.time
  })).digest("hex");
  const update = {
    source: "live",
    instanceID: activity.instanceID,
    sequence: metadata.nextSequence++,
    receivedAt,
    ...(numberOrUndefined(event.revision ?? properties.revision) !== undefined ? {
      revision: numberOrUndefined(event.revision ?? properties.revision)
    } : {}),
    fingerprint,
    seenFingerprints: [...new Set([...(priorUpdate?.seenFingerprints ?? []), ...(priorUpdate ? [priorUpdate.fingerprint] : []), fingerprint])]
  };
  if (!isNewerCompletionUpdate(update, priorUpdate)) {
    // A history write may have succeeded while its totals write failed. Replay
    // repairs that single-writer projection rather than dropping the retry.
    const repaired = previous ? await persistCompletedRecord(source, storage, totals, previous) : snapshot !== undefined;
    if (repaired) {
      completedMessageIDs.add(messageID);
      metadata.completed.add(messageID);
      active.delete(messageID);
    }
    return;
  }
  const state = takeState(active, messageID, sessionID, timestamp);
  const fallback = state?.fallbackTokens ?? {};
  const tokens = {
    input: exactOrFallback(exactTokens.input, fallback.input, 0),
    output: exactOrFallback(exactTokens.output, fallback.output, 0),
    reasoning: exactOrFallback(exactTokens.reasoning, fallback.reasoning, 0),
    cacheRead: exactOrFallback(exactTokens.cacheRead, fallback.cacheRead, prior?.tokens.cacheRead ?? 0),
    cacheWrite: exactOrFallback(exactTokens.cacheWrite, fallback.cacheWrite, prior?.tokens.cacheWrite ?? 0)
  };
  const quality = exactTokens.output !== undefined && exactTokens.input !== undefined && (exactTokens.reasoning !== undefined || tokens.reasoning === 0) ? "exact" : "provisional";
  if (prior && (prior.quality ?? "exact") === "exact" && quality === "provisional") {
    // A trimmed exact response is still authoritative in the ledger. Reject
    // partial completion facts before they can reclaim a history window slot.
    completedMessageIDs.add(messageID);
    metadata.completed.add(messageID);
    return;
  }
  const parentSessionID = resolveParentSessionID(input, parentSessionCache, sessionID, "message.updated", properties, event);
  await safeRecordParentFact(activity, "message.updated", sessionID, parentSessionID, timestamp, properties, event);
  const record = makeHistoryRecord({
    messageID,
    sessionID,
    parentSessionID,
    model: modelName(info) ?? state?.model ?? previous?.model,
    cost: numberOrUndefined(info.cost) ?? state?.cost ?? prior?.cost ?? 0,
    tokens,
    samples: [],
    state,
    info: previous && !hasNumber(info.time?.created) && !hasNumber(info.time?.start) ? {
      ...info,
      time: {
        ...info.time,
        created: previous.time.start
      }
    } : info,
    completedAt: timestamp,
    quality
  });
  if (!record.agent && previous?.agent) record.agent = previous.agent;
  if (previous) {
    const firstToken = earliestFirstOutput(record.time.start, record.time.completed ?? timestamp, previous.time.firstContent, previous.time.firstToken, record.time.firstToken);
    if (firstToken !== undefined) {
      record.time = recordContentArrival(record.time, firstToken);
    }
    if (previous.time.firstResponse !== undefined && previous.time.firstResponseSource && previous.time.firstResponseTimeSource) {
      record.time = applyFirstResponseSignal(record.time, {
        timestamp: previous.time.firstResponse,
        source: previous.time.firstResponseSource,
        timeSource: previous.time.firstResponseTimeSource,
        estimated: previous.time.firstResponseEstimated ?? true
      });
    }
  }
  record.time.ttft = timeToFirstToken(record);
  delete record.speed;
  record.update = update;
  if (await persistCompletedRecord(source, storage, totals, record)) {
    completedMessageIDs.add(messageID);
    metadata.completed.add(messageID);
  }
}
async function flushIdleStates(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, properties, event, timestamp) {
  const sessionID = readSessionIDFromEvent("session.idle", properties, event);
  if (!sessionID) return;
  responseRuntime(active).pendingTaints.delete(sessionID);
  responseRuntime(active).current.delete(sessionID);
  responseRuntime(active).closed.add(sessionID);
  const entries = [...active.entries()].filter(([, state]) => state.sessionID === sessionID);
  for (const [key, state] of entries) {
    retireResponse(active, state.messageID, sessionID);
    active.delete(key);
    if (!state.legacy.hasData && !state.v2.hasData && Object.keys(state.fallbackTokens).length === 0) continue;
    if (state.messageID.startsWith("__pending__:")) continue;
    if (completedMessageIDs.has(state.messageID)) continue;
    const tokens = {
      input: state.fallbackTokens.input ?? 0,
      output: state.fallbackTokens.output ?? 0,
      reasoning: state.fallbackTokens.reasoning ?? 0,
      cacheRead: state.fallbackTokens.cacheRead ?? 0,
      cacheWrite: state.fallbackTokens.cacheWrite ?? 0
    };
    const parentSessionID = resolveParentSessionID(input, parentSessionCache, sessionID, "session.idle", properties, event);
    await safeRecordParentFact(activity, "session.idle", sessionID, parentSessionID, timestamp, properties, event);
    const record = makeHistoryRecord({
      messageID: state.messageID,
      sessionID,
      parentSessionID,
      model: state.model,
      cost: state.cost ?? 0,
      tokens,
      samples: [],
      state,
      info: undefined,
      completedAt: timestamp,
      quality: "provisional"
    });
    // Failed provisional persistence belongs to the committer, not a LIVE
    // response object kept forever after an authoritative terminal.
    await persistCompletedRecord(sourcesByRuntime.get(active), storage, totals, record);
  }
}
function makeHistoryRecord(input) {
  const infoTime = asRecord(input.info?.time) ?? {};
  const start = numberOrUndefined(infoTime.start) ?? numberOrUndefined(infoTime.created) ?? input.state?.startedAt ?? input.completedAt;
  const completed = numberOrUndefined(infoTime.end) ?? numberOrUndefined(infoTime.completed) ?? input.completedAt;
  const firstToken = earliestFirstOutput(start, completed, numberOrUndefined(infoTime.firstToken), numberOrUndefined(infoTime.firstTokenAt), input.state?.firstTokenAt);
  const ttft = firstToken === undefined ? undefined : Math.max(0, firstToken - start);
  const duration = Math.max(0, completed - start);
  const agent = normalizeAgentName(input.info?.agent) ?? normalizeAgentName(input.state?.agent);
  const record = {
    version: HISTORY_VERSION,
    messageID: input.messageID,
    sessionID: input.sessionID,
    ...(input.parentSessionID ? {
      parentSessionID: input.parentSessionID
    } : {}),
    ...(input.model ? {
      model: input.model
    } : {}),
    ...(agent ? {
      agent
    } : {}),
    tokens: input.tokens,
    cost: Math.max(0, numberOrUndefined(input.cost) ?? 0),
    time: {
      start,
      ...(firstToken !== undefined ? {
        firstToken
      } : {}),
      completed,
      ...(ttft !== undefined ? {
        ttft
      } : {}),
      duration
    },
    samples: input.samples,
    quality: input.quality
  };
  if (firstToken !== undefined) record.time = recordContentArrival(record.time, firstToken);
  const timing = input.state?.timing;
  if (timing?.firstResponse !== undefined && timing.firstResponseSource && timing.firstResponseTimeSource) {
    record.time = applyFirstResponseSignal(record.time, {
      timestamp: timing.firstResponse,
      source: timing.firstResponseSource,
      timeSource: timing.firstResponseTimeSource,
      estimated: timing.firstResponseEstimated ?? true
    });
  }
  record.time.ttft = timeToFirstToken(record);
  return record;
}
function takeState(active, messageID, sessionID, timestamp) {
  const direct = active.get(messageID);
  const pending = runtimeContentMetadata(active).completed.has(messageID) ? undefined : active.get(pendingKey(sessionID));
  if (direct && pending && direct !== pending) {
    mergeStates(direct, pending);
    active.delete(pendingKey(sessionID));
  }
  if (direct) {
    active.delete(messageID);
    return direct;
  }
  if (pending) {
    active.delete(pendingKey(sessionID));
    pending.messageID = messageID;
    return pending;
  }
  return undefined;
}
function getOrCreateState(active, messageID, sessionID, timestamp) {
  const direct = messageID ? active.get(messageID) : undefined;
  const pendingKeyValue = pendingKey(sessionID);
  const pending = active.get(pendingKeyValue);
  if (direct && pending && direct !== pending) {
    mergeStates(direct, pending);
    active.delete(pendingKeyValue);
  }
  const state = direct ?? pending ?? createState(messageID ?? pendingKeyValue, sessionID, timestamp);
  if (messageID) state.messageID = messageID;
  if (messageID && pending && state === pending) active.delete(pendingKeyValue);
  return state;
}
function mergeStates(target, source) {
  target.progress = mergeContentProgress(target.progress, source.progress);
  target.startedAt = Math.min(target.startedAt, source.startedAt);
  target.liveAssistant ||= source.liveAssistant;
  target.observedFromStart &&= source.observedFromStart;
  if (source.timing?.firstContent !== undefined) target.timing = recordContentArrival({
    ...target.timing,
    start: target.startedAt
  }, source.timing.firstContent);
  if (source.timing?.firstResponse !== undefined && source.timing.firstResponseSource && source.timing.firstResponseTimeSource) {
    target.timing = applyFirstResponseSignal({
      ...target.timing,
      start: target.startedAt
    }, {
      timestamp: source.timing.firstResponse,
      source: source.timing.firstResponseSource,
      timeSource: source.timing.firstResponseTimeSource,
      estimated: source.timing.firstResponseEstimated ?? true
    });
  }
  if (target.firstTokenAt === undefined || source.firstTokenAt !== undefined && source.firstTokenAt < target.firstTokenAt) {
    target.firstTokenAt = source.firstTokenAt;
  }
  target.model = target.model ?? source.model;
  if (!target.agent && source.agent) target.agent = source.agent;
  target.cost = target.cost ?? source.cost;
  target.fallbackTokens = mergeFallbackTokens(source.fallbackTokens, target.fallbackTokens);
  target.legacy.hasData ||= source.legacy.hasData;
  target.v2.hasData ||= source.v2.hasData;
}
function createState(messageID, sessionID, timestamp) {
  return {
    messageID,
    sessionID,
    startedAt: timestamp,
    fallbackTokens: {},
    legacy: {
      hasData: false
    },
    v2: {
      hasData: false
    }
  };
}
function eventInfo(properties, event) {
  return asRecord(properties.info) ?? asRecord(properties.message) ?? asRecord(event.info) ?? (properties.role ? properties : undefined);
}
function tokenFields(value) {
  if (!isRecord(value)) return {};
  const normalized = normalizeTokenCounts(value);
  const inputDetails = isRecord(value.inputTokenDetails) ? value.inputTokenDetails : undefined;
  const outputDetails = isRecord(value.outputTokenDetails) ? value.outputTokenDetails : undefined;
  const fields = {};
  if (hasNumber(value.input) || hasNumber(value.inputTokens)) fields.input = normalized.input;
  if (hasNumber(value.output) || hasNumber(value.outputTokens)) fields.output = normalized.output;
  if (hasNumber(value.reasoning) || hasNumber(value.reasoningTokens) || hasNumber(outputDetails?.reasoningTokens) || hasNumber(outputDetails?.reasoning)) {
    fields.reasoning = normalized.reasoning;
  }
  if (hasNumber(value.cacheRead) || hasNumber(value.cache_read) || isRecord(value.cache) && hasNumber(value.cache.read) || hasNumber(value.cachedInputTokens) || hasNumber(value.cacheReadTokens) || hasNumber(inputDetails?.cacheReadTokens) || hasNumber(inputDetails?.cacheRead)) {
    fields.cacheRead = normalized.cacheRead;
  }
  if (hasNumber(value.cacheWrite) || hasNumber(value.cache_write) || isRecord(value.cache) && hasNumber(value.cache.write) || hasNumber(value.cacheWriteTokens) || hasNumber(inputDetails?.cacheWriteTokens) || hasNumber(inputDetails?.cacheWrite)) {
    fields.cacheWrite = normalized.cacheWrite;
  }
  return fields;
}
function mergeFallbackTokens(previous, incoming) {
  const result = {
    ...previous,
    ...incoming
  };
  if (previous.cacheRead !== undefined && incoming.cacheRead !== undefined) {
    result.cacheRead = Math.max(previous.cacheRead, incoming.cacheRead);
  }
  if (previous.cacheWrite !== undefined && incoming.cacheWrite !== undefined) {
    result.cacheWrite = Math.max(previous.cacheWrite, incoming.cacheWrite);
  }
  return result;
}
function exactOrFallback(exact, fallback, estimate) {
  return exact ?? fallback ?? Math.max(0, Math.round(estimate));
}
function cacheOrFallback(exact, fallback) {
  return exact ?? fallback ?? 0;
}
function isCompleted(info, properties, event) {
  const values = [info.completed, properties.completed, event.completed];
  if (values.some(value => value === true || value === "completed")) return true;
  const status = info.status ?? properties.status ?? event.status;
  if (status === "completed" || isRecord(status) && status.type === "completed") return true;
  const time = asRecord(info.time);
  return numberOrUndefined(time?.end) !== undefined || numberOrUndefined(time?.completed) !== undefined;
}
function isIdleEvent(type, properties, event) {
  const state = lifecycleStateForEvent(type, properties, event);
  return state !== undefined && !isActiveState(state);
}
function resolveParentSessionID(input, cache, sessionID, type, properties, event) {
  const direct = readParentSessionIDFromEvent(type, properties, event);
  if (direct && direct !== sessionID) {
    cache.set(sessionID, direct);
    return direct;
  }
  // Metadata I/O is owned by the deferred worker. Serial completion/receipt
  // processing can only consume already-observed authoritative ancestry.
  return cache.get(sessionID);
}
async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function safeUpsert(storage, _totals, record) {
  const committer = committersByStorage.get(storage);
  if (committer) {
    try {
      const report = await committer.upsert(record);
      pendingUsageByStorage.set(storage, report.pendingCount);
      if (report.committed) acceptedUsageByStorage.delete(storage);else acceptedUsageByStorage.set(storage, record);
      return report.committed;
    } catch (error) {
      acceptedUsageByStorage.delete(storage);
      pendingUsageByStorage.delete(storage);
      warn("usage commit failed", error);
      return false;
    }
  }
  throw new Error("Backend usage committer is not initialized");
}
function resolveOptions(candidate) {
  if (!isRecord(candidate)) return {};
  return {
    historyPath: typeof candidate.historyPath === "string" ? candidate.historyPath : undefined,
    runsPath: typeof candidate.runsPath === "string" ? candidate.runsPath : undefined,
    totalsPath: typeof candidate.totalsPath === "string" ? candidate.totalsPath : undefined,
    maxRecords: numberOrUndefined(candidate.maxRecords),
    bytesPerToken: numberOrUndefined(candidate.bytesPerToken)
  };
}
function readMessageID(...sources) {
  return readStringFrom(sources, ["messageID", "messageId", "assistantMessageID", "assistantMessageId", "id", "message.id", "part.messageID"]);
}
function readDelta(properties, event) {
  const values = [properties.delta, properties.text, properties.content, properties.part?.delta, properties.part?.text, event.delta, event.text];
  return values.find(value => typeof value === "string" && value.length > 0);
}
function inferKind(properties, event) {
  const values = [properties.kind, properties.type, properties.field, properties.part?.type, event.kind, event.type];
  return values.some(value => typeof value === "string" && value.toLowerCase().includes("reason")) ? "reasoning" : "output";
}
function modelName(info) {
  if (!info) return undefined;
  if (typeof info.model === "string") return info.model;
  if (isRecord(info.model)) {
    return readStringFrom([info.model], ["modelID", "id", "name"]);
  }
  return readStringFrom([info], ["modelID", "modelId"]);
}
function explicitEventTimestamp(event, properties) {
  return numberOrUndefined(event.timestamp) ?? numberOrUndefined(event.time) ?? numberOrUndefined(properties.timestamp) ?? numberOrUndefined(properties.time);
}
function readString(source, fallback, keys) {
  return readStringFrom([source, fallback], keys);
}
function readStringFrom(sources, keys) {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = getPath(source, key);
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}
function getPath(source, path) {
  return path.split(".").reduce((value, key) => isRecord(value) ? value[key] : undefined, source);
}
function pendingKey(sessionID) {
  return `__pending__:${sessionID}`;
}
function joinPath(base, suffix) {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function hasNumber(value) {
  return numberOrUndefined(value) !== undefined;
}
function warn(message, error) {
  const detail = error instanceof Error ? error.message : undefined;
  if (detail) console.warn(`[oc-tps] ${message}: ${detail}`);else console.warn(`[oc-tps] ${message}`);
}
function asRecord(value) {
  return isRecord(value) ? value : undefined;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/** V1 hooks are retained explicitly; V2 loads setup, never returned hooks. */
export async function setup(ctx) {
  const controller = new AbortController();
  const backendController = new AbortController();
  const budget = createQueryBudget(controller.signal);
  const metadataCache = new Map();
  let metadataEpoch = 0;
  const getSession = async (sessionID, signal, fresh = false) => {
    const cached = metadataCache.get(sessionID);
    if (!fresh && cached && performance.now() - cached.at < QUERY_RETRY_MS) return cached.session;
    const epoch = metadataEpoch;
    const response = await budget.run(signal, () => ctx.session.get({
      sessionID
    }, {
      signal
    }));
    signal.throwIfAborted();
    if (epoch !== metadataEpoch) throw new Error("metadata belongs to a disconnected observation epoch");
    if (response.id !== sessionID) throw new Error("V2 metadata response belongs to another session");
    const session = compactSessionMetadata(response);
    metadataCache.delete(sessionID);
    metadataCache.set(sessionID, {
      session,
      at: performance.now()
    });
    while (metadataCache.size > QUERY_CACHE_LIMIT) metadataCache.delete(metadataCache.keys().next().value);
    return session;
  };
  const adapter = createV2EventAdapter();
  let drainBackend = () => Promise.resolve();
  const input = {
    directory: ctx.location.directory,
    worktree: ctx.location.directory,
    project: ctx.location.project,
    v2Signal: backendController.signal,
    onActivityGap: () => adapter.invalidate(),
    registerV2Drain: drain => {
      drainBackend = drain;
    },
    client: {
      session: {
        get: async (parameters, options) => {
          const signal = AbortSignal.any([controller.signal, options.signal]);
          const session = await getSession(parameters.sessionID, signal);
          signal.throwIfAborted();
          if (!parameters.classificationOnly && session.location.directory !== ctx.location.directory) {
            throw new Error("V2 current-session metadata has contradictory directory evidence");
          }
          // A matching foreign ancestor is classification evidence, never proof
          // that its lifecycle belongs to this writer's directory.
          return session;
        }
      }
    },
    readV2Idle: (sessionID, signal) => {
      const combined = AbortSignal.any([controller.signal, signal]);
      return readV2Idle({
        ...ctx,
        session: {
          get: ({
            sessionID
          }) => getSession(sessionID, combined, true)
        }
      }, sessionID, combined);
    }
  };
  let hooks;
  try {
    hooks = await server(input, ctx.options);
  } catch (error) {
    controller.abort();
    backendController.abort();
    adapter.clear();
    throw error;
  }
  // Execution transitions in the public stream can omit location even though
  // adjacent model-step events are scoped. Never discard their original time,
  // and never infer ownership from the frontend or the currently open route.
  const directories = new Map();
  const activeDirectories = new Map();
  const pending = new Map();
  const lookups = [];
  const requests = new Set();
  let delivery = Promise.resolve();
  let workers = 0;
  let connected = false;
  const enqueue = job => {
    // Admission is stopped by the subscription signal. Once admitted, a
    // delivery owns its place and must drain even if disposal arrives now.
    const result = delivery.then(job);
    delivery = result.catch(error => warn("V2 event delivery failed", error));
    return delivery;
  };
  const rememberDirectory = (sessionID, directory) => {
    directories.delete(sessionID);
    directories.set(sessionID, directory);
    while (directories.size > 2048) {
      const candidate = [...directories.keys()].find(id => !activeDirectories.has(id));
      if (!candidate) break;
      directories.delete(candidate);
    }
  };
  const sever = async sessionID => {
    await hooks.event?.({
      event: {
        type: "pulse.observation.gap",
        sessionID
      }
    });
    adapter.invalidate(sessionID);
    if (sessionID) activeDirectories.delete(sessionID);else activeDirectories.clear();
  };
  const apply = async (event, session) => {
    for (const adapted of adapter.events(event)) {
      const sid = adapted.properties?.sessionID;
      const state = lifecycleStateForEvent(adapted.type, adapted.properties ?? {}, adapted);
      if (typeof sid === "string" && state) {
        const previous = activeDirectories.get(sid);
        const timestamp = numberOrUndefined(adapted.timestamp) ?? 0;
        const sequence = numberOrUndefined(adapted.sourceSequence);
        if (!previous || timestamp >= previous.timestamp && (previous.sequence === undefined || sequence === undefined || sequence >= previous.sequence)) {
          if (isActiveState(state)) {
            activeDirectories.set(sid, {
              timestamp,
              sequence
            });
            rememberDirectory(sid, ctx.location.directory);
          } else activeDirectories.delete(sid);
        }
      }
      // Reuse the verified session entity in the normal scope/ancestry guards
      // before applying its queued lifecycle; known MC proof is not discarded
      // merely because this lookup was initially needed for location.
      await hooks.event?.({
        event: session ? {
          ...adapted,
          properties: {
            ...adapted.properties,
            session
          }
        } : adapted
      });
    }
  };
  const flush = async (sessionID, directory, session) => {
    const entry = pending.get(sessionID);
    if (!entry) return;
    pending.delete(sessionID);
    entry.controller?.abort();
    if (directory !== ctx.location.directory) return;
    for (const [index, event] of entry.events.entries()) await apply(event, index === 0 ? session : undefined);
  };
  const pump = () => {
    while (!controller.signal.aborted && workers < 4 && lookups.length) {
      const {
        sessionID,
        entry
      } = lookups.shift();
      if (pending.get(sessionID) !== entry) continue;
      entry.queued = false;
      workers++;
      const requestController = new AbortController();
      entry.controller = requestController;
      const signal = AbortSignal.any([controller.signal, requestController.signal]);
      const request = (async () => {
        try {
          const session = await withTimeout(Promise.resolve().then(() => {
            signal.throwIfAborted();
            return getSession(sessionID, signal);
          }), PARENT_LOOKUP_TIMEOUT_MS);
          if (signal.aborted || session?.id !== sessionID || typeof session.location?.directory !== "string") return;
          await enqueue(async () => {
            // A scoped event may already have resolved or contradicted this
            // lookup. Its newer evidence wins over a delayed metadata result.
            if (pending.get(sessionID) !== entry) return;
            rememberDirectory(sessionID, session.location.directory);
            await flush(sessionID, session.location.directory, session);
          });
        } catch {/* Timeout/failure is unknown, never same-directory proof. */} finally {
          requestController.abort();
          entry.controller = undefined;
          workers--;
        }
      })();
      requests.add(request);
      void request.finally(() => {
        requests.delete(request);
        pump();
      });
    }
  };
  const receive = event => {
    if (!isV2ControlEvent(event.type)) return Promise.resolve();
    return enqueue(async () => {
      if (event.type === "server.connected") {
        if (connected) {
          for (const entry of pending.values()) entry.controller?.abort();
          pending.clear();
          lookups.length = 0;
          metadataCache.clear();
          directories.clear();
          metadataEpoch++;
          await sever();
        }
        connected = true;
        await apply(event);
        return;
      }
      const data = asRecord(event.data);
      const dataLocation = asRecord(data?.location);
      const location = event.location ?? dataLocation;
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
      if (event.location && event.location.directory !== ctx.location.directory || dataLocation && dataLocation.directory !== ctx.location.directory) {
        if (sessionID) {
          // Contradictory envelopes are not ownership proof for either location.
          const foreign = event.location?.directory !== ctx.location.directory ? event.location?.directory : dataLocation?.directory;
          directories.delete(sessionID);
          await sever(sessionID);
          await flush(sessionID, typeof foreign === "string" ? foreign : "");
        }
        return;
      }
      if (location) {
        if (sessionID) {
          rememberDirectory(sessionID, ctx.location.directory);
          await flush(sessionID, ctx.location.directory);
        }
        await apply(event);
        return;
      }
      if (!event.type.startsWith("session.")) {
        await apply(event);
        return;
      }
      // Only lifecycle facts need deferred location proof. Never buffer content
      // or make streaming deltas trigger metadata requests or ledger writes.
      if (!sessionID || !["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.retry.scheduled", "session.status", "session.idle"].includes(event.type)) return;
      const directory = directories.get(sessionID);
      if (directory !== undefined) {
        if (directory === ctx.location.directory) await apply(event);
        return;
      }
      let entry = pending.get(sessionID);
      if (!entry) {
        if (pending.size >= 256) {
          const oldest = pending.keys().next().value;
          const evicted = pending.get(oldest);
          await sever(oldest);
          evicted.controller?.abort();
          pending.delete(oldest);
          const queued = lookups.findIndex(item => item.entry === evicted);
          if (queued >= 0) lookups.splice(queued, 1);
        }
        entry = {
          events: [],
          queued: true
        };
        pending.set(sessionID, entry);
        lookups.push({
          sessionID,
          entry
        });
      } else if (!entry.queued && !entry.controller) {
        // Retry only on a new lifecycle event, never on a timer or ledger poll.
        entry.queued = true;
        lookups.push({
          sessionID,
          entry
        });
      }
      // If proof stays unavailable under a flood, discard the unproven prefix
      // rather than dropping just an idle/terminal and bridging an unknown gap.
      if (entry.events.length >= 64) {
        await sever(sessionID);
        entry.events.length = 0;
      }
      entry.events.push(event);
      pump();
    });
  };
  const subscription = (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal
        })) {
          if (controller.signal.aborted) break;
          await receive(event);
        }
      } catch (error) {
        if (!controller.signal.aborted) warn("V2 event subscription interrupted", error);
      }
      if (controller.signal.aborted) break;
      await enqueue(async () => {
        for (const entry of pending.values()) entry.controller?.abort();
        pending.clear();
        lookups.length = 0;
        metadataCache.clear();
        directories.clear();
        metadataEpoch++;
        connected = false;
        await sever();
      });
      // Recover on throw AND EOF; this is subscription backoff, not ledger or
      // model polling. A new observation epoch never bridges the unknown gap.
      await new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(1000, 25 * 2 ** Math.min(failures++, 6)));
        controller.signal.addEventListener("abort", finish, {
          once: true
        });
      });
    }
  })();
  return async () => {
    controller.abort();
    for (const entry of pending.values()) entry.controller?.abort();
    await subscription;
    await delivery;
    // Known/scoped admitted events have now released any provable prefix.
    // Remaining unknown-directory observations cannot safely be written.
    pending.clear();
    lookups.length = 0;
    await Promise.allSettled(requests);
    backendController.abort();
    await drainBackend();
    adapter.clear();
  };
}
const plugin = {
  id: "oc-tps",
  server,
  setup
};
export default plugin;
