import { createHash, randomUUID } from "node:crypto";
import { HISTORY_VERSION, bytesToTokens, calibrateResponseSamples, emptyTokenCounts, normalizeTokenCounts, timeToFirstToken, utf8ByteLength } from "./core.js";
import { ACTIVITY_VERSION, isActiveState, normalizeActivityEvent, replayActivity } from "./activity.js";
import { createActivityLedger } from "./runs-storage.js";
import { cachePartSnapshot, cachedContentProgress, coerceCompletionUpdate, contentSpeedObservations, createContentMetadataCache, createContentProgress, earliestFirstOutput, isNewerCompletionUpdate, measureRecordSpeed, mergeContentProgress, mergeRecordSpeed, noteContentArrival, noteStepIdentity, parseModelDelta, taintContentProgress } from './statistics.js';
import { createHistoryStorage, readHistoryFile } from "./storage.js";
import { applyFirstResponseSignal, recordContentArrival, thinkingFirstResponseSignal } from "./statistics.js";
import { createTotalsStorage, isCorruptTotalsError } from "./totals-storage.js";
const DEFAULT_HISTORY_PATH = ".opencode/oc-tps/history.jsonl";
const ACTIVITY_EVENT_NAMESPACE = "oc-tps";
const PARENT_LOOKUP_TIMEOUT_MS = 200;
const activityInitializationQueues = new Map();
const contentMetadataByRuntime = new WeakMap();
const responsesByRuntime = new WeakMap();
function responseRuntime(active) {
  let runtime = responsesByRuntime.get(active);
  if (!runtime) {
    runtime = {
      current: new Map(),
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
  const failure = status === "retry" || type.startsWith("session.next.") && (type.endsWith(".retried") || type.endsWith(".failed")) || type === "session.error" || type.includes("provider.error") || type.includes("provider-error") || eventInfo(properties, event)?.error !== undefined;
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
  cachePartSnapshot(metadata, properties);
  const part = asRecord(properties.part);
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
  const options = resolveOptions(pluginOptions ?? input.options ?? input.config);
  const baseDirectory = resolveProjectDirectory(input);
  const historyPath = resolveHistoryPath(baseDirectory, options.historyPath);
  const storage = createHistoryStorage(historyPath, {
    maxRecords: options.maxRecords
  });
  const totals = createTotalsStorage({
    historyPath,
    totalsPath: options.totalsPath
  });
  const activity = {
    ledger: createActivityLedger({
      historyPath,
      runsPath: options.runsPath
    }),
    instanceID: randomUUID(),
    nextSeq: 1,
    assignments: new Map(),
    writtenFacts: new Set(),
    rawTimestamps: new Map()
  };
  let eventQueue = Promise.all([initializeActivityRuntime(activity).catch(error => {
    warn("activity ledger initialization failed", error);
  }), initializeTotals(storage, totals, historyPath).catch(error => {
    warn("totals ledger initialization failed", error);
  })]).then(() => undefined);
  await eventQueue;
  const bytesPerToken = validBytesPerToken(options.bytesPerToken);
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
  // Establish the epoch when ingress is ready, not before asynchronous startup.
  responseRuntime(active).observedSince = Date.now();
  const event = payload => {
    const rawEvent = payload?.event;
    const receivedAt = Date.now();
    const receivedMonotonic = performance.now();
    const next = eventQueue.then(() => handleEvent(rawEvent, input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, bytesPerToken, receivedAt, receivedMonotonic)).catch(error => {
      warn("event handling failed", error);
    });
    eventQueue = next;
    return next;
  };
  return {
    event
  };
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
  return result;
}
async function initializeTotals(storage, totals, historyPath) {
  const retained = await storage.read();
  const recoverable = await readHistoryFile(historyPath);
  try {
    await seedRetainedTotals(totals, retained, recoverable);
  } catch (error) {
    if (!isCorruptTotalsError(error)) throw error;
    warn("totals ledger is corrupt", error);
    await totals.quarantine();
    await seedRetainedTotals(totals, retained, recoverable);
  }
}
async function seedRetainedTotals(totals, retained, recoverable = retained) {
  await totals.seed(recoverable);
  await totals.backfillSpeed(recoverable);
  await totals.applyMany(retained, {
    retainedMessageIDs: retained.map(record => record.messageID)
  });
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
    const appended = await runtime.ledger.appendMany(recovery);
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
  return stableSerialize([type, event]);
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
  const assignmentKey = stableSerialize(["lifecycle", type, sourceID ?? null, sessionID, state, parentSessionID ?? null, timestamp, observedAt, boundary.instanceEndedAt ?? null, boundary.lastObservedAt ?? null]);
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
    instanceID: runtime.instanceID,
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
  const assignmentKey = stableSerialize(["parent", type, sourceID ?? null, sessionID, parentSessionID, timestamp, observedAt, boundary.instanceEndedAt ?? null, boundary.lastObservedAt ?? null]);
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
    const appended = await runtime.ledger.appendLifecycle(event);
    runtime.writtenFacts.add(activityFactKey(appended));
  } catch (error) {
    warn("activity lifecycle write failed", error);
  }
}
async function safeAppendParent(runtime, event) {
  const factKey = activityFactKey(event);
  if (runtime.writtenFacts.has(factKey)) return;
  try {
    const appended = await runtime.ledger.appendParent(event);
    runtime.writtenFacts.add(activityFactKey(appended));
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
function readSessionIDFromEvent(type, properties, event) {
  const direct = readStringFrom([properties, event], ["sessionID", "sessionId", "session.id"]);
  if (direct) return direct;
  const sessionObjectID = readStringFrom([asRecord(properties.session), asRecord(event.session), asRecord(properties.event), asRecord(event.event)], ["id"]);
  if (sessionObjectID) return sessionObjectID;
  const nested = [asRecord(properties.session), asRecord(properties.event), asRecord(event.session), asRecord(event.event), asRecord(properties.info), asRecord(event.info)];
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
async function handleEvent(rawEvent, input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, bytesPerToken, receivedAt, receivedMonotonic) {
  try {
    const event = unwrapIncomingEvent(rawEvent);
    if (!event) return;
    const type = typeof event.type === "string" ? event.type : "";
    const properties = asRecord(event.properties) ?? asRecord(event.data) ?? {};
    recordResponseLifecycle(active, type, properties, event, receivedAt);
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
    if (type === "message.part.delta") {
      recordDelta(active, properties, event, receivedAt, "legacy", bytesPerToken, receivedMonotonic);
      return;
    }
    if (type === "session.next.text.delta" || type === "session.next.reasoning.delta" || type === "session.next.tool.input.delta") {
      recordDelta(active, properties, event, receivedAt, "v2", bytesPerToken, receivedMonotonic);
      return;
    }
    if (type === "message.updated") {
      await handleMessageUpdated(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, event, properties, timestamp, bytesPerToken, receivedAt);
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
    if (isIdleEvent(type, properties, event)) {
      await flushIdleStates(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, properties, event, timestamp, bytesPerToken);
    }
  } catch (error) {
    warn("event parsing failed", error);
  }
}
function recordDelta(active, properties, event, timestamp, stream, bytesPerToken, receivedMonotonic) {
  const sessionID = readSessionIDFromEvent("message.part.delta", properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const metadata = runtimeContentMetadata(active);
  if (isSnapshotIngress(event, properties)) return;
  if (messageID && (metadata.completed.has(messageID) || metadata.roles.has(messageID) && metadata.roles.get(messageID) !== "assistant")) return;
  const delta = readDelta(properties, event);
  if (!delta) return;
  const key = messageID ?? pendingKey(sessionID);
  const existing = active.get(messageID ?? key) ?? active.get(pendingKey(sessionID));
  const progress = existing?.progress ?? cachedContentProgress(metadata, messageID ?? key);
  const parsed = parseModelDelta(progress, properties, event, stream, delta);
  if (!parsed) return;
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  if (state.sessionID !== sessionID) return;
  state.progress = mergeContentProgress(state.progress, progress);
  bindPendingTaint(active, state);
  if (!state.observedFromStart || !messageID) taintResponse(active, state, "unobserved-response-start");
  if (!state.liveAssistant || responseRuntime(active).current.get(sessionID) !== messageID) taintResponse(active, state, "not-current-assistant");
  metadata.progress.set(messageID ?? key, state.progress);
  const kind = parsed.kind;
  if (timestamp < state.startedAt) state.startedAt = timestamp;
  state.firstTokenAt = Math.min(state.firstTokenAt ?? timestamp, timestamp);
  state.timing = recordContentArrival({
    ...state.timing,
    start: state.startedAt
  }, timestamp);
  const bytes = utf8ByteLength(delta);
  noteContentArrival(state.progress, {
    kind,
    bytes,
    partID: parsed.partID,
    receivedAt: timestamp,
    receivedMono: receivedMonotonic,
    stream
  });
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  const sample = {
    timestamp,
    tokens: estimatedTokens,
    estimatedTokens,
    bytes,
    kind
  };
  state[stream].hasData = true;
  state[stream].samples.push(sample);
  active.set(messageID ?? key, state);
}
function recordResponseStep(active, properties, event, timestamp) {
  const sessionID = readSessionIDFromEvent(event.type, properties, event);
  const messageID = readMessageID(properties);
  if (!sessionID || messageID && runtimeContentMetadata(active).completed.has(messageID)) return;
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
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  const info = eventInfo(properties, event);
  state.progress ??= cachedContentProgress(runtimeContentMetadata(active), messageID ?? pendingKey(sessionID));
  active.set(messageID ?? pendingKey(sessionID), state);
  recordResponseStep(active, properties, event, timestamp);
  const tokens = tokenFields(info?.tokens ?? properties.tokens ?? properties);
  state.fallbackTokens = mergeFallbackTokens(state.fallbackTokens, tokens);
  state.model = state.model ?? modelName(info);
  state.cost = numberOrUndefined(info?.cost ?? properties.cost) ?? state.cost;
  active.set(messageID ?? pendingKey(sessionID), state);
}
async function handleMessageUpdated(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, event, properties, timestamp, bytesPerToken, receivedAt) {
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
    if (created === undefined || created < timestamp - 1000 || created > timestamp) return;
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
      state.observedFromStart = created >= receivedAt - 1000 && created <= receivedAt && created >= responseRuntime(active).observedSince && !alreadyGenerating && !state.legacy.hasData && !state.v2.hasData && ![...cached.parts.values()].some(part => part.snapshotBytes > 0 || part.deltaBytes > 0);
      state.progress = mergeContentProgress(createContentProgress({
        fromCurrentStart: state.observedFromStart
      }), state.progress ?? cached);
      metadata.progress.set(messageID, state.progress);
    }
    bindPendingTaint(active, state);
    responseRuntime(active).current.set(sessionID, messageID);
    active.set(messageID, state);
    return;
  }
  if (isSnapshotIngress(event, properties)) return;
  const previous = (await storage.read()).find(record => record.messageID === messageID);
  const ledger = await totals.read().catch(() => undefined);
  const snapshot = ledger?.open[messageID] ?? ledger?.settled[messageID];
  if (snapshot === true) {
    // No reversible contribution survives. Do not reconstruct a history slot
    // or manufacture speed coverage from an already-accounted old response.
    completedMessageIDs.add(messageID);
    metadata.completed.add(messageID);
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
  const fingerprint = createHash("sha256").update(stableSerialize(info)).digest("hex");
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
    const repaired = previous ? await safeUpsert(storage, totals, previous) : snapshot !== undefined;
    if (repaired) {
      completedMessageIDs.add(messageID);
      metadata.completed.add(messageID);
      active.delete(messageID);
    }
    return;
  }
  const state = takeState(active, messageID, sessionID, timestamp);
  const fallback = state?.fallbackTokens ?? {};
  const estimate = estimateStateTokens(state, bytesPerToken);
  const tokens = {
    input: exactOrFallback(exactTokens.input, fallback.input, estimate.input),
    output: exactOrFallback(exactTokens.output, fallback.output, estimate.output),
    reasoning: exactOrFallback(exactTokens.reasoning, fallback.reasoning, estimate.reasoning),
    cacheRead: cacheOrFallback(exactTokens.cacheRead, fallback.cacheRead),
    cacheWrite: cacheOrFallback(exactTokens.cacheWrite, fallback.cacheWrite)
  };
  const quality = exactTokens.output !== undefined && exactTokens.input !== undefined && (exactTokens.reasoning !== undefined || tokens.reasoning === 0) ? "exact" : "provisional";
  if (prior && (prior.quality ?? "exact") === "exact" && quality === "provisional") {
    // A trimmed exact response is still authoritative in the ledger. Reject
    // partial completion facts before they can reclaim a history window slot.
    completedMessageIDs.add(messageID);
    metadata.completed.add(messageID);
    return;
  }
  const candidateSamples = state ? chooseSamples(state) : previous?.samples ?? [];
  const samples = calibrateResponseSamples(candidateSamples, {
    output: tokens.output,
    reasoning: tokens.reasoning
  });
  const parentSessionID = await resolveParentSessionID(input, parentSessionCache, sessionID, "message.updated", properties, event);
  await safeRecordParentFact(activity, "message.updated", sessionID, parentSessionID, timestamp, properties, event);
  const record = makeHistoryRecord({
    messageID,
    sessionID,
    parentSessionID,
    model: modelName(info) ?? state?.model,
    cost: numberOrUndefined(info.cost) ?? state?.cost ?? 0,
    tokens,
    samples,
    state,
    info,
    completedAt: timestamp,
    quality
  });
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
  record.speed = mergeRecordSpeed(record, prior, responseRuntime(active).tainted.has(messageID) || state && chooseSamples(state).length > 0 && !record.speed?.generation ? "invalidated" : "unobserved");
  record.update = update;
  if (await safeUpsert(storage, totals, record)) {
    completedMessageIDs.add(messageID);
    metadata.completed.add(messageID);
  } else if (state) active.set(messageID, state);
}
async function flushIdleStates(input, storage, totals, activity, active, completedMessageIDs, parentSessionCache, properties, event, timestamp, bytesPerToken) {
  const sessionID = readSessionIDFromEvent("session.idle", properties, event);
  if (!sessionID) return;
  responseRuntime(active).pendingTaints.delete(sessionID);
  responseRuntime(active).current.delete(sessionID);
  const entries = [...active.entries()].filter(([, state]) => state.sessionID === sessionID);
  for (const [key, state] of entries) {
    active.delete(key);
    if (!state.legacy.hasData && !state.v2.hasData && Object.keys(state.fallbackTokens).length === 0) continue;
    if (state.messageID.startsWith("__pending__:")) continue;
    if (completedMessageIDs.has(state.messageID)) continue;
    const estimate = estimateStateTokens(state, bytesPerToken);
    const tokens = {
      input: state.fallbackTokens.input ?? estimate.input,
      output: state.fallbackTokens.output ?? estimate.output,
      reasoning: state.fallbackTokens.reasoning ?? estimate.reasoning,
      cacheRead: state.fallbackTokens.cacheRead ?? 0,
      cacheWrite: state.fallbackTokens.cacheWrite ?? 0
    };
    const parentSessionID = await resolveParentSessionID(input, parentSessionCache, sessionID, "session.idle", properties, event);
    await safeRecordParentFact(activity, "session.idle", sessionID, parentSessionID, timestamp, properties, event);
    const record = makeHistoryRecord({
      messageID: state.messageID,
      sessionID,
      parentSessionID,
      model: state.model,
      cost: state.cost ?? 0,
      tokens,
      samples: calibrateResponseSamples(chooseSamples(state), {
        output: tokens.output,
        reasoning: tokens.reasoning
      }),
      state,
      info: undefined,
      completedAt: timestamp,
      quality: "provisional"
    });
    const wrote = await safeUpsert(storage, totals, record);
    if (!wrote) active.set(key, state);
  }
}
function makeHistoryRecord(input) {
  const infoTime = asRecord(input.info?.time) ?? {};
  const start = numberOrUndefined(infoTime.start) ?? numberOrUndefined(infoTime.created) ?? input.state?.startedAt ?? input.completedAt;
  const completed = numberOrUndefined(infoTime.end) ?? numberOrUndefined(infoTime.completed) ?? input.completedAt;
  const firstToken = earliestFirstOutput(start, completed, numberOrUndefined(infoTime.firstToken), numberOrUndefined(infoTime.firstTokenAt), input.state?.firstTokenAt);
  const ttft = firstToken === undefined ? undefined : Math.max(0, firstToken - start);
  const duration = Math.max(0, completed - start);
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
  record.speed = measureRecordSpeed(record, contentSpeedObservations(record, input.state?.progress, input.state?.firstTokenAt, input.quality === "exact", numberOrUndefined(infoTime.start ?? infoTime.created) !== undefined && numberOrUndefined(infoTime.end ?? infoTime.completed) !== undefined, tokenFields(input.info?.tokens).reasoning !== undefined));
  return record;
}
function chooseSamples(state) {
  if (!state) return [];
  return state.v2.hasData ? [...state.v2.samples] : [...state.legacy.samples];
}
function estimateStateTokens(state, bytesPerToken) {
  const samples = chooseSamples(state);
  const result = emptyTokenCounts();
  for (const sample of samples) {
    const tokens = sample.estimatedTokens ?? sample.tokens;
    if (sample.kind === "reasoning") result.reasoning += tokens;else result.output += tokens;
  }
  if (state && samples.length === 0) {
    const legacy = state.legacy.samples;
    const v2 = state.v2.samples;
    for (const sample of [...legacy, ...v2]) {
      const bytes = sample.bytes ?? 0;
      result.output += bytesToTokens(bytes, bytesPerToken);
    }
  }
  return result;
}
function takeState(active, messageID, sessionID, timestamp) {
  const direct = active.get(messageID);
  const pending = active.get(pendingKey(sessionID));
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
  target.cost = target.cost ?? source.cost;
  target.fallbackTokens = mergeFallbackTokens(source.fallbackTokens, target.fallbackTokens);
  target.legacy.hasData ||= source.legacy.hasData;
  target.legacy.samples.push(...source.legacy.samples);
  target.v2.hasData ||= source.v2.hasData;
  target.v2.samples.push(...source.v2.samples);
  target.legacy.samples.sort((left, right) => left.timestamp - right.timestamp);
  target.v2.samples.sort((left, right) => left.timestamp - right.timestamp);
}
function createState(messageID, sessionID, timestamp) {
  return {
    messageID,
    sessionID,
    startedAt: timestamp,
    fallbackTokens: {},
    legacy: {
      hasData: false,
      samples: []
    },
    v2: {
      hasData: false,
      samples: []
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
async function resolveParentSessionID(input, cache, sessionID, type, properties, event) {
  const direct = readParentSessionIDFromEvent(type, properties, event);
  if (direct && direct !== sessionID) {
    cache.set(sessionID, direct);
    return direct;
  }
  if (cache.has(sessionID)) return cache.get(sessionID);
  const client = input.client;
  const get = client?.session?.get;
  const sessionClient = client?.session;
  if (typeof get === "function" && sessionClient) {
    try {
      const response = await withTimeout(Promise.resolve().then(() => get.call(sessionClient, {
        path: {
          id: sessionID
        }
      })), PARENT_LOOKUP_TIMEOUT_MS);
      if (response === undefined) {
        cache.set(sessionID, undefined);
        return undefined;
      }
      const session = asRecord(response?.data) ?? asRecord(response);
      const parent = readStringFrom([session, asRecord(session?.session)], ["parentID", "parentSessionID", "parentSessionId", "parent.id", "session.parentID", "session.parentSessionID", "session.parentSessionId"]);
      const resolved = parent && parent !== sessionID ? parent : undefined;
      cache.set(sessionID, resolved);
      return resolved;
    } catch {
      cache.set(sessionID, undefined);
      return undefined;
    }
  }
  const fallback = direct && direct !== sessionID ? direct : undefined;
  cache.set(sessionID, fallback);
  return fallback;
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
async function safeUpsert(storage, totals, record) {
  try {
    await storage.upsert(record);
  } catch (error) {
    warn("history write failed", error);
    return false;
  }
  let retained;
  try {
    retained = await storage.read();
  } catch (error) {
    warn("totals write failed", error);
    return false;
  }
  try {
    const retainedMessageIDs = retained.map(entry => entry.messageID);
    const stored = retained.find(entry => entry.messageID === record.messageID);
    if (stored) {
      await totals.apply(stored, {
        retainedMessageIDs
      });
    } else {
      await totals.apply(record, {
        retainedMessageIDs
      });
    }
    return true;
  } catch (error) {
    if (!isCorruptTotalsError(error)) {
      warn("totals write failed", error);
      return false;
    }
    warn("totals ledger is corrupt", error);
    try {
      await totals.quarantine();
      await seedRetainedTotals(totals, retained);
      return true;
    } catch (recoveryError) {
      warn("totals write failed", recoveryError);
      return false;
    }
  }
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
function validBytesPerToken(value) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 5.5;
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
const plugin = {
  id: "oc-tps",
  server
};
export default plugin;
