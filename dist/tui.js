import { use as _$use } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */

import { readLedgerText } from "./persistence-files.js";
import { watch, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createEffect, createMemo, createRoot, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { createV2TuiBridge } from "./tui-v2.js";
import { tuiReadModel, disconnectTuiReadModel, parentProofPort, RevisionMap, TuiActivitySelection, activitySemanticIdentity } from "./tui-read-model.js";
import { mergeTotalsSources } from "./source-ledgers.js";
import { sessionSourcePort, sessionSourceDirectory, sessionSourcePaths } from "./tui-source.js";
import { DEFAULT_BYTES_PER_TOKEN, HISTORY_VERSION, addTokenCounts, aggregateSession, aggregateSessionTree, calibrateResponseSamples, bytesToTokens, emptyTokenCounts, formatDuration, formatNumber, normalizeTokenCounts, timeToFirstToken } from "./core.js";
import { normalizeActivityEvent, resolveRootSessionID } from "./activity.js";
import { cachePartSnapshot, cachedContentProgress, coerceCompletionUpdate, coerceSpeedContribution, coerceSpeedTotals, contentSpeedObservations, createContentMetadataCache, earliestFirstOutput, isNewerCompletionUpdate, measureRecordSpeed, mergeRecordSpeed, sameSpeedContribution, updateSpeedTotals } from './statistics.js';
import { applyFirstResponseSignal, createContentProgress, mergeContentProgress, noteStepIdentity, selectSpeedMeasurement, taintContentProgress, thinkingFirstResponseSignal } from "./statistics.js";
import { completeContentMetadata, retireContentMetadata, disposeContentMetadata } from "./statistics.js";
import { createScopeRegistry, coerceScopeEvidence, collectSessionScopeEvidence, isSessionScopeExcluded, mergeScopeEvidence } from "./scope.js";
import { DEFAULT_MAX_RECORDS, parseHistoryJsonl, filterHistoryRecords } from "./storage.js";
import { readActivityDelta } from "./runs-storage.js";
import { normalizeAgentName, normalizeAgentNames } from "./agent-names.js";
import { DEFAULT_HISTORY_PATH } from "./storage-paths.js";
import { rollupSessionTotals } from "./totals-aggregate.js";
import { TOTALS_VERSION, getExcludedMessageIDs, projectTotalsGenerationBasis, projectTotalsMeasurementScope } from "./totals-storage.js";
const HISTORY_ROUTE = "oc-tps-history";
const HISTORY_MODE = "oc-tps.history";
const COMMAND_NAME = "oc-tps.history";
export const DETAILS_COMMAND_NAME = "oc-tps.details";
function ownValue(dictionary, key) {
  return dictionary && Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : undefined;
}
const recordQualityByObject = new WeakMap();
// Observation facts are compact control metadata only. Shared activity owns all
// interval mathematics; canonical reload replaces matching optimistic facts.

const tuiActivities = new WeakMap();
function tuiActivity(store) {
  let value = tuiActivities.get(store);
  if (!value) {
    const selection = new TuiActivitySelection(store);
    value = {
      selection,
      get projector() {
        return selection.projector;
      },
      canonical: store.activityEvents,
      overlay: selection.overlay,
      instanceID: randomUUID(),
      sequence: 0,
      known: selection.known,
      candidates: new Set(),
      runtimeEpochs: new Map(),
      partialSessions: new Set(),
      executions: new Map(),
      currentExecutions: new Map(),
      scopes: Object.create(null),
      scopeKey: ""
    };
    tuiActivities.set(store, value);
    if (store.activityEvents.length) replaceActivityProjection(store, value);
  }
  if (value.canonical !== store.activityEvents) replaceActivityProjection(store, value);
  value.selection.patch();
  return value;
}
function replaceActivityProjection(store, value) {
  value.canonical = store.activityEvents;
  tuiReadModel(store).canonicalParents(store.activityEvents, true);
  value.selection.reset(store.activityEvents);
  for (const fact of store.activityEvents) value.known.add(fact.sessionID);
}
export function recordTuiActivityFact(store, input, event = {}) {
  if (store.disposed) return false;
  const value = tuiActivity(store);
  const executionID = readString(input.executionID ?? event.executionID);
  const sequence = readNumber(input.sourceSequence ?? event.sourceSequence ?? event.revision);
  const timestamp = readNumber(input.timestamp) ?? Date.now();
  let execution = executionID ? value.executions.get(executionID) : undefined;
  if (execution?.frozen) return false;
  const resume = input.kind === "lifecycle" && (input.state === "busy" || input.state === "retry") && timestamp >= observationRuntime(store).observedSince;
  // A post-gap positive control can resume the same execution in a fresh
  // observation. A late terminal from its old prefix cannot close that tail.
  if (execution && execution.instanceID !== value.instanceID && !resume) return false;
  if (!execution || execution.instanceID !== value.instanceID) execution = {
    instanceID: value.instanceID,
    boundarySequence: sequence,
    boundaryTime: timestamp
  };else if (sequence !== undefined && execution.boundarySequence !== undefined ? sequence < execution.boundarySequence : timestamp < execution.boundaryTime) return false;
  const instanceID = execution.instanceID;
  // Adapter partial executions have no observed lifecycle start and cannot
  // manufacture busy time. Keep their proof in the adapter/canonical ledger,
  // not an ever-repaired live stream with no activity to project.
  if (input.kind !== "lifecycle" && executionID?.startsWith("partial:")) return false;
  if (input.kind === "lifecycle" && input.state === "busy" && executionID && !executionID.startsWith("partial:") && typeof input.sessionID === "string" && value.partialSessions.has(input.sessionID)) {
    const ends = new Map();
    for (const fact of value.overlay.values()) if (fact.sessionID === input.sessionID && fact.instanceID === value.instanceID && fact.executionID?.startsWith("partial:")) {
      ends.set(fact.executionID, Math.max(ends.get(fact.executionID) ?? fact.timestamp, fact.timestamp));
    }
    for (const [id, fact] of value.overlay) if (fact.sessionID === input.sessionID && fact.instanceID === value.instanceID && fact.executionID && ends.has(fact.executionID)) {
      value.overlay.set(id, {
        ...fact,
        instanceEndedAt: ends.get(fact.executionID)
      });
      const partial = value.executions.get(fact.executionID);
      if (partial) partial.frozen = true;
    }
    value.partialSessions.delete(input.sessionID);
    // Refine a placeholder observation; never invent an idle or a span from
    // its last known prefix to the newly identified execution.
    for (const id of ends.keys()) value.selection.freeze(value.instanceID, undefined, id);
  }
  const sourceEventID = readString(input.sourceEventID) ?? readString(event.sourceEventID) ?? readString(event.id);
  const providedEventID = readString(input.eventID);
  const semantic = sourceEventID || providedEventID ? activitySemanticIdentity({
    ...input,
    eventID: providedEventID,
    executionID,
    sourceEventID,
    timestamp: readNumber(input.timestamp ?? event.timestamp)
  }) : undefined;
  if (semantic && value.selection.hasLiveSemantic(semantic)) return false;
  const seq = value.sequence + 1;
  const fact = normalizeActivityEvent({
    ...input,
    version: 2,
    instanceID,
    seq,
    observedAt: Date.now(),
    eventID: providedEventID ?? `tui:${instanceID}:${seq}`,
    sourceEventID: input.sourceEventID ?? event.sourceEventID ?? event.id,
    sourceSequence: input.sourceSequence ?? event.sourceSequence ?? event.revision
  });
  if (!fact) return false;
  if (executionID) value.executions.set(executionID, execution);
  if (fact.kind === "parent") tuiReadModel(store).observeParent(fact.sessionID, {
    parent: fact.parentSessionID || null,
    origin: "live",
    identity: fact.sourceEventID ?? fact.eventID,
    sourceEpoch: readString(event.sourceEpoch),
    sourceSequence: sequence
  });
  value.selection.patch();
  if (!value.selection.addLive(fact, semantic)) return false;
  value.sequence = seq;
  if (fact.kind === "lifecycle") {
    if (executionID?.startsWith("partial:") && (fact.state === "busy" || fact.state === "retry")) value.partialSessions.add(fact.sessionID);
    if (fact.state === "busy" || fact.state === "retry") value.candidates.add(fact.sessionID);else if (!value.projector.totals(fact.sessionID, {
      liveNow: Date.now(),
      trustedCurrentInstanceID: value.instanceID
    }).active) value.candidates.delete(fact.sessionID);
  }
  return true;
}
function disconnectTuiActivity(store) {
  const value = tuiActivity(store);
  value.selection.freeze(value.instanceID);
  value.instanceID = randomUUID();
  value.sequence = 0;
  value.currentExecutions.clear();
  value.candidates.clear();
  tuiReadModel(store).bindProof();
}
export function tuiActivityTimes(store, sessionID, now = Date.now()) {
  const value = tuiActivity(store);
  return value.projector.totals(sessionID, {
    liveNow: now,
    trustedCurrentInstanceID: value.instanceID
  });
}
/** Structural, store-scoped test observation; no log or user-facing surface. */
export function tuiActivityDiagnostics(store) {
  const value = tuiActivity(store);
  return {
    ...value.selection.diagnostics(),
    activeCandidates: value.candidates.size,
    compactContributions: [...store.sessionRuntime.values()].reduce((sum, runtime) => sum + (retiredContributions.get(runtime)?.size ?? 0), 0),
    activeResponses: store.active.size,
    optimisticResponses: store.optimistic.size,
    runtimeResponses: [...store.sessionRuntime.values()].reduce((sum, runtime) => sum + runtime.contributions.size + runtime.completedContributions.size, 0),
    progress: observationRuntime(store).metadata.progress.size
  };
}
const observationRuntimes = new WeakMap();
function observationRuntime(store) {
  let runtime = observationRuntimes.get(store);
  if (!runtime) {
    runtime = {
      instanceID: randomUUID(),
      metadata: createContentMetadataCache(),
      liveAssistantMessages: new Set(),
      observedSince: Date.now(),
      connected: false,
      taintedMessages: new Set(),
      pendingTaints: new Map()
    };
    observationRuntimes.set(store, runtime);
  }
  return runtime;
}
function knownCompletedMessage(store, messageID) {
  return store.completedMessageIDs.has(messageID) || observationRuntime(store).metadata.completed.has(messageID) || ownValue(store.totalsLedger.settled, messageID) !== undefined || ownValue(store.totalsLedger.open, messageID)?.quality === "exact";
}
function knownNonAssistant(store, messageID) {
  const role = observationRuntime(store).metadata.roles.get(messageID);
  return role !== undefined && role !== "assistant";
}
function scopeEligible(store, sessionID, messageID) {
  const model = tuiReadModel(store);
  return !(messageID && model.excluded(messageID)) && model.eligible(sessionID);
}
function scopedRecords(store, records) {
  return tuiReadModel(store).filter(records);
}
function observeAssistantScope(store, sessionID, messageID, info) {
  const previousRevision = store.sourceScopes.revision;
  const proof = store.sourceScopes.observeMessageMetadata(sessionID, info);
  if (proof.sourceScope === "magic-message" || proof.sourceScope === "magic-session") {
    store.messageScopes.set(messageID, mergeScopeEvidence(store.messageScopes.get(messageID), proof));
    tuiReadModel(store).noteProof(messageID);
  }
  if (previousRevision !== store.sourceScopes.revision && store.sourceScopes.isExcluded(sessionID)) refreshScopeProjection(store);else if (!scopeEligible(store, sessionID, messageID)) {
    // A local MC work identity is not a whole-session reclassification. Do not
    // replay the canonical activity log or scan all past responses for it.
    finalizeResponse(store, messageID, sessionID, store.active.get(messageID)?.responseEpoch, {
      authoritative: true
    });
    removeOptimisticRecord(store, messageID);
    const runtime = store.sessionRuntime.get(sessionID);
    runtime?.contributions.delete(messageID);
    runtime?.completedContributions.delete(messageID);
    completeContentMetadata(observationRuntime(store).metadata, messageID);
    store.records = store.records.filter(record => record.messageID !== messageID);
    if (store.lastCompletedBySession.get(sessionID)?.record.messageID === messageID) store.lastCompletedBySession.delete(sessionID);
    store.bump();
  }
  return proof;
}
function refreshScopeProjection(store) {
  store.records = scopedRecords(store, store.records);
  tuiReadModel(store).syncScopes();
  for (const state of [...store.active.values()]) if (!scopeEligible(store, state.sessionID, state.messageID)) {
    finalizeResponse(store, state.messageID, state.sessionID, state.responseEpoch, {
      authoritative: true
    });
  }
  for (const [id, last] of store.lastCompletedBySession) if (!scopeEligible(store, id, last.record.messageID)) store.lastCompletedBySession.delete(id);
  for (const run of store.taskRuns.values()) for (const id of run.activeSessions) if (!scopeEligible(store, id)) run.activeSessions.delete(id);
  retireCanonicalResponses(store);
  store.bump();
}
export function recordTuiPartMetadata(store, properties, event = {}, receivedAt = Date.now()) {
  const observations = observationRuntime(store);
  const part = asRecord(properties.part);
  const messageID = readString(part?.messageID);
  const sessionID = readString(part?.sessionID) ?? (messageID ? store.active.get(messageID)?.sessionID : undefined);
  if (sessionID && !scopeEligible(store, sessionID, messageID)) return;
  const active = messageID ? store.active.get(messageID) : undefined;
  if (active && part?.sessionID !== undefined && part.sessionID !== active.sessionID) return;
  cachePartSnapshot(observations.metadata, properties);
  if (part?.type === "step-start" && messageID) {
    noteStepIdentity(cachedContentProgress(observations.metadata, messageID), stepIdentity(properties, part));
  }
  if (!part || !messageID || knownCompletedMessage(store, messageID)) return;
  const state = store.active.get(messageID);
  if (!state) return;
  const signal = thinkingFirstResponseSignal(part, {
    messageID,
    sessionID: state.sessionID,
    role: observations.metadata.roles.get(messageID) ?? "unknown",
    start: state.startedAt,
    now: receivedAt,
    live: event.type === "message.part.updated" && observations.liveAssistantMessages.has(messageID) && !isReplayEvent(event, properties)
  });
  if (!signal) return;
  const previous = state.firstResponseAt;
  applyActiveTiming(state, applyFirstResponseSignal(activeTiming(state), signal));
  if (state.firstResponseAt !== previous) store.bump();
}
function stepIdentity(properties, part) {
  return readString(properties.stepID ?? properties.stepId ?? part?.stepID ?? part?.stepId ?? getPath(properties, "step.id") ?? part?.id ?? getPath(properties, "part.id") ?? properties.id);
}
function taintTuiState(store, state, reason) {
  state.progress ??= cachedContentProgress(observationRuntime(store).metadata, state.messageID);
  taintContentProgress(state.progress, reason);
  observationRuntime(store).taintedMessages.add(state.messageID);
}
function bindTuiPendingTaints(store, state) {
  const observations = observationRuntime(store);
  for (const reason of observations.pendingTaints.get(state.sessionID) ?? []) taintTuiState(store, state, reason);
  observations.pendingTaints.delete(state.sessionID);
}

/** Known disruptions are evidence; a quiet window alone is not a disconnect. */
export function recordTuiObservationLifecycle(store, type, properties, event, receivedAt = Date.now()) {
  const observations = observationRuntime(store);
  const transport = type === "server.connected" ? observations.connected : type === "server.instance.disposed" || type.startsWith("workspace.") && /status|disposed|deleted/.test(type);
  if (type === "server.connected") observations.connected = true;
  if (transport) {
    disconnectTuiActivity(store);
    observations.observedSince = Math.max(observations.observedSince, receivedAt);
  }
  if (transport) for (const state of store.active.values()) {
    taintTuiState(store, state, "transport-disruption");
    observations.liveAssistantMessages.delete(state.messageID);
  }
  const info = eventInfo(properties, event);
  const status = statusName(properties.status ?? event.status ?? info?.status ?? info?.state)?.toLowerCase();
  const failure = status === "retry" || type === "session.next.retried" || type === "session.next.step.failed" || type === "session.error" || eventInfo(properties, event)?.error !== undefined;
  if (!failure) return;
  const sessionID = readSessionID(properties, event) ?? (type.startsWith("session.") && info?.role === undefined ? readString(info?.id) : undefined);
  // Session metadata's info.id is NOT a message ID. Only assistant info owns it.
  const messageID = readStringFrom([properties, event, info], ["messageID", "messageId", "message.id", "assistantMessageID", "assistantMessageId"]) ?? (info?.role === "assistant" ? readString(info.id) : undefined);
  const reason = status === "retry" || type === "session.next.retried" ? "retry" : "failed";
  const states = [...store.active.values()].filter(state => messageID ? state.messageID === messageID : state.sessionID === sessionID);
  if (messageID) observations.taintedMessages.add(messageID);
  for (const state of states) taintTuiState(store, state, reason);
  if (!messageID && !states.length && sessionID) {
    const pending = observations.pendingTaints.get(sessionID) ?? new Set();
    pending.add(reason);
    observations.pendingTaints.set(sessionID, pending);
  }
}
function isReplayEvent(event, properties) {
  return event.replay === true || properties.replay === true || [event.source, properties.source].some(source => source === "snapshot" || source === "history" || source === "reconnect");
}
function activeTiming(state) {
  return {
    start: state.startedAt,
    firstToken: state.firstTokenAt,
    firstContent: state.firstContentAt,
    firstResponse: state.firstResponseAt,
    firstResponseSource: state.firstResponseSource,
    firstResponseTimeSource: state.firstResponseTimeSource,
    firstResponseEstimated: state.firstResponseEstimated
  };
}
function applyActiveTiming(state, time) {
  state.firstTokenAt = time.firstToken;
  state.firstContentAt = time.firstContent;
  state.firstResponseAt = time.firstResponse;
  state.firstResponseSource = time.firstResponseSource;
  state.firstResponseTimeSource = time.firstResponseTimeSource;
  state.firstResponseEstimated = time.firstResponseEstimated;
}

// Same canonical payload fingerprint as the server, for cross-process replay
// confirmation. Timing/usage magnitudes are facts, not update versions.
function serializeCompletionFact(value, seen = new Set()) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result = Array.isArray(value) ? `[${value.map(entry => serializeCompletionFact(entry, seen)).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serializeCompletionFact(value[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return result;
}
const retiredContributions = new WeakMap();
function compactContribution(record, runEpoch) {
  return {
    runEpoch,
    sessionID: record.sessionID,
    time: {
      ...record.time
    },
    model: record.model,
    agent: record.agent,
    tokens: record.tokens,
    cost: record.cost,
    update: record.update
  };
}
let legacyLifecycleOrder = 0;
function lifecycleStateAt(events, timestamp) {
  return events.filter(event => event.timestamp <= timestamp).at(-1)?.state;
}
function mergeLifecycleEvents(left, right) {
  const byTimestamp = new Map();
  for (const event of [...left, ...right]) {
    const existing = byTimestamp.get(event.timestamp);
    if (!existing || (event.order ?? 0) >= (existing.order ?? 0)) {
      byTimestamp.set(event.timestamp, {
        ...event
      });
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}
function sameLifecycleEvents(left, right) {
  return left.length === right.length && left.every((event, index) => event.timestamp === right[index]?.timestamp && event.state === right[index]?.state);
}
function recordLifecycleFact(eventsBySession, sessionID, state, timestamp) {
  const previous = eventsBySession.get(sessionID) ?? [];
  if (previous.find(event => event.timestamp === timestamp)?.state === state) return false;
  const next = mergeLifecycleEvents(previous, [{
    state,
    timestamp,
    order: ++legacyLifecycleOrder
  }]);
  if (sameLifecycleEvents(previous, next)) return false;
  eventsBySession.set(sessionID, next);
  return true;
}
function cloneLifecycleEventMap(eventsBySession) {
  return new Map([...eventsBySession.entries()].map(([sessionID, events]) => [sessionID, events.map(event => ({
    ...event
  }))]));
}
function mergeLifecycleEventMaps(left, right) {
  const merged = cloneLifecycleEventMap(left);
  for (const [sessionID, events] of right) {
    merged.set(sessionID, mergeLifecycleEvents(merged.get(sessionID) ?? [], events));
  }
  return merged;
}
function completeLifecycleHistoryForRun(run) {
  return mergeLifecycleEventMaps(mergeLifecycleEventMaps(mergeLifecycleEventMaps(run.lifecycleHistory, run.lifecycleEvents), run.pendingLifecycleEvents), run.lastRunLifecycleEvents);
}
function lifecycleHistorySignature(run) {
  return JSON.stringify([...completeLifecycleHistoryForRun(run).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([sessionID, events]) => [sessionID, events.map(event => [event.timestamp, event.state])]));
}
function closeLifecycleHistoryAt(eventsBySession, completedAt) {
  const closed = cloneLifecycleEventMap(eventsBySession);
  if (completedAt === undefined || !Number.isFinite(completedAt)) return closed;
  for (const [sessionID, events] of closed) {
    const latest = events.filter(event => event.timestamp <= completedAt).at(-1);
    if (latest && activeTaskSessionState(latest.state) && latest.timestamp < completedAt) {
      recordLifecycleFact(closed, sessionID, "completed", completedAt);
    }
  }
  return closed;
}
function cloneIntervals(intervals) {
  return intervals.map(interval => ({
    ...interval
  }));
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function asRecord(value) {
  return isRecord(value) ? value : undefined;
}
function getPath(source, path) {
  return path.split(".").reduce((value, key) => {
    return isRecord(value) ? value[key] : undefined;
  }, source);
}
function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function readStringFrom(sources, keys) {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = readString(getPath(source, key));
      if (value) return value;
    }
  }
  return undefined;
}
function readNumberFrom(sources, keys) {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = readNumber(getPath(source, key));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
function normalizeEvent(input) {
  const outer = asRecord(input);
  if (!outer) return undefined;
  if (typeof outer.type === "string") return outer;
  const nested = asRecord(outer.event) ?? asRecord(outer.payload);
  if (nested && typeof nested.type === "string") return nested;
  return outer;
}
function eventProperties(event) {
  return asRecord(event.properties) ?? asRecord(event.data) ?? {};
}
function eventType(event) {
  return readString(event.type) ?? "";
}
function eventTimestamp(event, properties) {
  return readNumberFrom([event, properties], ["timestamp", "time"]) ?? Date.now();
}
function eventInfo(properties, event) {
  return asRecord(properties.info) ?? asRecord(properties.message) ?? asRecord(event.info) ?? (typeof properties.role === "string" ? properties : undefined);
}
function readMessageID(...sources) {
  return readStringFrom(sources, ["messageID", "messageId", "assistantMessageID", "assistantMessageId", "message.id", "id", "part.messageID"]);
}
function readSessionID(properties, event) {
  const direct = readStringFrom([properties, event], ["sessionID", "sessionId", "session.id"]);
  if (direct) return direct;
  return readStringFrom([asRecord(properties.info), asRecord(properties.session), asRecord(event.info), asRecord(event.session)], ["id", "sessionID", "sessionId", "session.id"]);
}
function modelName(value) {
  if (!value) return undefined;
  const direct = readString(value.model);
  if (direct) return direct;
  const model = asRecord(value.model);
  return readStringFrom([model], ["modelID", "modelId", "id", "name"]) ?? readStringFrom([value], ["modelID", "modelId"]);
}
function tokenFields(value) {
  const input = asRecord(value);
  const source = asRecord(input?.tokens) ?? asRecord(input?.usage) ?? asRecord(input?.tokenUsage) ?? input;
  if (!source) return {};
  const normalized = normalizeTokenCounts(source);
  const fields = {};
  const inputDetails = asRecord(source.inputTokenDetails);
  const outputDetails = asRecord(source.outputTokenDetails);
  const rawInput = readNumber(source.inputTokens) ?? readNumber(source.promptTokens);
  const uncachedInput = readNumber(source.noCacheTokens) ?? readNumber(inputDetails?.noCacheTokens) ?? readNumber(inputDetails?.noCacheInputTokens);
  const rawOutput = readNumber(source.outputTokens) ?? readNumber(source.completionTokens);
  const textOutput = readNumber(outputDetails?.textTokens) ?? readNumber(outputDetails?.text) ?? readNumber(outputDetails?.outputTokens);
  const hasInput = readNumber(source.input) !== undefined || rawInput !== undefined || uncachedInput !== undefined || readNumber(source.cacheReadTokens) !== undefined || readNumber(source.cacheWriteTokens) !== undefined || readNumber(source.cache_read) !== undefined || readNumber(source.cache_write) !== undefined || readNumber(inputDetails?.cacheReadTokens) !== undefined || readNumber(inputDetails?.cacheWriteTokens) !== undefined || readNumber(inputDetails?.cacheRead) !== undefined || readNumber(inputDetails?.cacheWrite) !== undefined;
  const hasOutput = readNumber(source.output) !== undefined || rawOutput !== undefined || textOutput !== undefined || readNumber(source.reasoning) !== undefined || readNumber(outputDetails?.reasoningTokens) !== undefined || readNumber(outputDetails?.reasoning) !== undefined;
  const hasReasoning = readNumber(source.reasoning) !== undefined || readNumber(source.reasoningTokens) !== undefined || readNumber(outputDetails?.reasoningTokens) !== undefined || readNumber(outputDetails?.reasoning) !== undefined;
  if (hasInput) {
    fields.input = uncachedInput !== undefined ? Math.max(0, uncachedInput) : normalized.input;
  }
  if (hasOutput) {
    fields.output = textOutput !== undefined ? Math.max(0, textOutput) : rawOutput !== undefined && normalized.reasoning > 0 ? Math.max(0, rawOutput - normalized.reasoning) : normalized.output;
  }
  if (hasReasoning) fields.reasoning = normalized.reasoning;
  const cache = asRecord(source.cache);
  if (readNumber(source.cacheRead) !== undefined || readNumber(source.cacheReadTokens) !== undefined || readNumber(source.cachedInputTokens) !== undefined || readNumber(source.cache_read) !== undefined || readNumber(inputDetails?.cacheReadTokens) !== undefined || readNumber(inputDetails?.cacheRead) !== undefined || readNumber(cache?.read) !== undefined) {
    fields.cacheRead = normalized.cacheRead;
  }
  if (readNumber(source.cacheWrite) !== undefined || readNumber(source.cacheWriteTokens) !== undefined || readNumber(source.cache_write) !== undefined || readNumber(inputDetails?.cacheWriteTokens) !== undefined || readNumber(inputDetails?.cacheWrite) !== undefined || readNumber(cache?.write) !== undefined) {
    fields.cacheWrite = normalized.cacheWrite;
  }
  return fields;
}
function mergeTokenFields(left, right) {
  const merged = {
    ...left
  };
  for (const key of ["input", "output", "reasoning"]) {
    if (right[key] !== undefined) merged[key] = right[key];
  }
  for (const key of ["cacheRead", "cacheWrite"]) {
    if (right[key] !== undefined) {
      merged[key] = Math.max(merged[key] ?? 0, right[key]);
    }
  }
  return merged;
}
function pendingKey(sessionID) {
  return `__pending__:${sessionID}`;
}
export function createSessionRuntime() {
  return {
    status: "idle",
    runEpoch: 0,
    runTotals: emptyTokenCounts(),
    runCost: 0,
    runResponseCount: 0,
    seenMessageIDs: new Set(),
    contributions: new Map(),
    completedContributions: new Map(),
    runSummaries: new Map()
  };
}
export function createTaskWallRun(rootSessionID) {
  return {
    rootSessionID,
    phase: "idle",
    runEpoch: 0,
    rootBusy: false,
    rootObserved: false,
    hasExplicitRootStart: false,
    participantSessions: new Set(),
    activeSessions: new Set(),
    sessionStates: new Map(),
    lastActivityAt: new Map(),
    pendingSessions: new Map(),
    pendingLifecycleEvents: new Map(),
    lifecycleEvents: new Map(),
    lifecycleHistory: new Map(),
    carriedIntervals: [],
    activeIntervals: [],
    activeElapsed: 0,
    lastRunIntervals: [],
    lastRunLifecycleEvents: new Map(),
    lastRunCarriedIntervals: []
  };
}
function clearTaskRunParticipants(run) {
  run.participantSessions.clear();
  run.activeSessions.clear();
  run.sessionStates.clear();
  run.lastActivityAt.clear();
}
function clearTaskRunCycle(run) {
  run.lifecycleEvents.clear();
  run.pendingLifecycleEvents.clear();
  run.activeIntervals = [];
  run.activeElapsed = 0;
}
function mergeIntervals(left, right = []) {
  return [...left, ...right].filter(interval => interval.end > interval.start).sort((a, b) => a.start - b.start || a.end - b.end).reduce((merged, interval) => {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({
        ...interval
      });
    }
    return merged;
  }, []);
}
function intervalElapsed(intervals) {
  return intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
}
function recordLifecycleEvent(run, sessionID, state, timestamp) {
  const currentEpoch = run.phase === "active" && lifecycleFactBelongsToCurrentEpoch(run, timestamp);
  const target = run.phase === "active" ? currentEpoch ? run.lifecycleEvents : undefined : run.pendingLifecycleEvents;
  const historyChanged = recordLifecycleFact(run.lifecycleHistory, sessionID, state, timestamp);
  const currentChanged = target !== undefined && currentEpoch ? recordLifecycleFact(target, sessionID, state, timestamp) : false;
  return {
    historyChanged,
    currentEpoch,
    currentChanged
  };
}
function lifecycleFactBelongsToCurrentEpoch(run, timestamp) {
  if (run.phase !== "active") return false;
  // Once a task has completed, that completion timestamp is the exclusive
  // lower boundary for the next active epoch. Facts before it are historical
  // corrections and must not mutate current participant state.
  const previousCompletion = run.lastRunWallTime?.completedAt;
  return previousCompletion === undefined || timestamp >= previousCompletion;
}
function rebuildActiveIntervals(run, through) {
  const completeHistory = completeLifecycleHistoryForRun(run);
  const hasLifecycleFacts = [...completeHistory.values()].some(events => events.length > 0);
  if (!hasLifecycleFacts) {
    run.activeIntervals = cloneIntervals(run.carriedIntervals);
    run.activeElapsed = intervalElapsed(run.activeIntervals);
    return;
  }
  run.lifecycleHistory = completeHistory;
  // Lifecycle facts are authoritative. Carry is only a compatibility snapshot
  // of closed history and must not be unioned with a corrected full replay.
  run.carriedIntervals = cloneIntervals(lifecycleIntervals(completeHistory));
  const intervals = lifecycleIntervals(completeHistory, through);
  run.activeIntervals = intervals;
  run.activeElapsed = intervalElapsed(intervals);
}
function lifecycleIntervals(lifecycleEvents, through) {
  const boundedLifecycleEvents = through === undefined || !Number.isFinite(through) ? lifecycleEvents : new Map([...lifecycleEvents.entries()].map(([sessionID, events]) => [sessionID, events.filter(event => event.timestamp <= through)]));
  const points = [...boundedLifecycleEvents.values()].flatMap(events => events.map(event => event.timestamp)).sort((left, right) => left - right);
  if (through !== undefined && Number.isFinite(through)) points.push(through);
  points.sort((left, right) => left - right);
  const uniquePoints = [...new Set(points)];
  const computedIntervals = [];
  for (let index = 0; index < uniquePoints.length; index += 1) {
    const start = uniquePoints[index];
    const end = uniquePoints[index + 1];
    if (end === undefined || end <= start) continue;
    const active = [...boundedLifecycleEvents.values()].some(events => activeTaskSessionState(lifecycleStateAt(events, start)));
    if (!active) continue;
    const previous = computedIntervals.at(-1);
    if (previous?.end === start) previous.end = end;else computedIntervals.push({
      start,
      end
    });
  }
  return computedIntervals;
}
function earliestActiveTimestamp(run) {
  const timestamps = [...run.lifecycleEvents.values()].flatMap(events => events).filter(event => activeTaskSessionState(event.state)).map(event => event.timestamp);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}
function activeTaskSessionState(state) {
  return state === "busy" || state === "retry";
}
function startTaskWallRun(run, timestamp, explicitRootStart) {
  const pendingLifecycle = new Map();
  for (const [sessionID, events] of run.pendingLifecycleEvents) {
    pendingLifecycle.set(sessionID, events.map(event => ({
      ...event
    })));
  }
  run.phase = "active";
  run.runEpoch += 1;
  run.runStartedAt = timestamp;
  run.rootBusy = explicitRootStart;
  run.rootObserved = explicitRootStart;
  run.hasExplicitRootStart = explicitRootStart;
  clearTaskRunParticipants(run);
  clearTaskRunCycle(run);
  run.runStartedAt = timestamp;
  run.activeIntervals = [];
  run.activeElapsed = 0;
  run.lifecycleEvents = pendingLifecycle;
  run.pendingLifecycleEvents.clear();
  run.pendingSessions.forEach((pending, sessionID) => {
    if (!run.lifecycleEvents.has(sessionID)) {
      run.lifecycleEvents.set(sessionID, [{
        ...pending
      }]);
    }
  });
  for (const [sessionID, events] of pendingLifecycle) {
    const latest = events.at(-1);
    if (!latest) continue;
    run.participantSessions.add(sessionID);
    run.sessionStates.set(sessionID, latest.state);
    run.lastActivityAt.set(sessionID, Math.max(...events.map(event => event.timestamp)));
    if (activeTaskSessionState(latest.state)) run.activeSessions.add(sessionID);
  }
  run.pendingSessions.clear();
  if (explicitRootStart) {
    run.participantSessions.add(run.rootSessionID);
    run.activeSessions.add(run.rootSessionID);
    run.sessionStates.set(run.rootSessionID, "busy");
    run.lastActivityAt.set(run.rootSessionID, timestamp);
    recordLifecycleEvent(run, run.rootSessionID, "busy", timestamp);
  }
  const carriedStart = run.carriedIntervals.length > 0 ? Math.min(...run.carriedIntervals.map(interval => interval.start)) : undefined;
  const currentStart = earliestActiveTimestamp(run);
  run.runStartedAt = Math.min(carriedStart ?? timestamp, currentStart ?? timestamp);
  rebuildActiveIntervals(run);
}
function recordTaskSessionActivity(run, sessionID, state, timestamp) {
  const recorded = recordLifecycleEvent(run, sessionID, state, timestamp);
  if (!recorded.currentEpoch) {
    if (recorded.historyChanged) rebuildActiveIntervals(run);
    return false;
  }
  run.participantSessions.add(sessionID);
  if (!recorded.currentChanged) return recorded.historyChanged;
  const events = run.lifecycleEvents.get(sessionID) ?? [];
  const latest = events.at(-1);
  if (!latest) return false;
  run.sessionStates.set(sessionID, latest.state);
  const previous = run.lastActivityAt.get(sessionID);
  run.lastActivityAt.set(sessionID, previous === undefined ? latest.timestamp : Math.max(previous, latest.timestamp));
  const currentState = run.sessionStates.get(sessionID);
  if (activeTaskSessionState(currentState)) run.activeSessions.add(sessionID);else run.activeSessions.delete(sessionID);
  if (sessionID === run.rootSessionID) {
    run.rootObserved = true;
    run.rootBusy = activeTaskSessionState(currentState);
  }
  rebuildActiveIntervals(run);
  return true;
}
function finishTaskWallRun(run, timestamp) {
  if (run.phase !== "active" || run.activeSessions.size > 0) return undefined;
  const activityEnd = Math.max(timestamp, ...run.lastActivityAt.values());
  const completeHistory = completeLifecycleHistoryForRun(run);
  run.lifecycleHistory = completeHistory;
  const completedIntervals = lifecycleIntervals(completeHistory, activityEnd);
  const completedActiveElapsed = intervalElapsed(completedIntervals);
  const cumulativeStart = completedIntervals.length > 0 ? Math.min(...completedIntervals.map(interval => interval.start)) : run.runStartedAt ?? timestamp;
  const summary = {
    runEpoch: run.runEpoch,
    startedAt: cumulativeStart,
    completedAt: activityEnd,
    wallTime: Math.max(0, completedActiveElapsed)
  };
  run.lastRunIntervals = completedIntervals;
  run.lastRunLifecycleEvents = cloneLifecycleEventMap(completeHistory);
  run.lastRunCarriedIntervals = cloneIntervals(completedIntervals);
  run.lastRunWallTime = summary;
  run.phase = "idle";
  run.rootBusy = false;
  run.rootObserved = false;
  run.hasExplicitRootStart = false;
  run.runStartedAt = undefined;
  clearTaskRunParticipants(run);
  run.lifecycleEvents.clear();
  run.pendingLifecycleEvents.clear();
  run.carriedIntervals = cloneIntervals(completedIntervals);
  run.activeIntervals = [];
  run.activeElapsed = 0;
  return summary;
}
function patchCompletedTaskWallRun(run, sessionID, state, timestamp) {
  if (!run.lastRunWallTime || timestamp >= run.lastRunWallTime.completedAt) return false;
  if (!recordLifecycleFact(run.lifecycleHistory, sessionID, state, timestamp)) return false;
  const completeHistory = completeLifecycleHistoryForRun(run);
  run.lifecycleHistory = completeHistory;
  const correctedIntervals = lifecycleIntervals(completeHistory, run.lastRunWallTime.completedAt);
  run.lastRunIntervals = mergeIntervals(correctedIntervals);
  run.lastRunWallTime = {
    ...run.lastRunWallTime,
    startedAt: Math.min(run.lastRunWallTime.startedAt, ...run.lastRunIntervals.map(interval => interval.start)),
    wallTime: intervalElapsed(run.lastRunIntervals)
  };
  // A late event corrects the finished epoch. Keep the cumulative carry and
  // all persisted-in-memory summaries on the same corrected interval union
  // so a subsequent epoch cannot resurrect stale time.
  run.carriedIntervals = cloneIntervals(run.lastRunIntervals);
  run.lastRunCarriedIntervals = cloneIntervals(run.lastRunIntervals);
  run.lastRunLifecycleEvents = cloneLifecycleEventMap(completeHistory);
  return true;
}
export function transitionTaskWallRun(run, sessionID, state, timestamp) {
  const isRoot = sessionID === run.rootSessionID;
  const startsRootRun = isRoot && activeTaskSessionState(state);
  if (run.phase === "idle") {
    if (run.lastRunWallTime && timestamp < run.lastRunWallTime.completedAt) {
      patchCompletedTaskWallRun(run, sessionID, state, timestamp);
      return undefined;
    }
    if (activeTaskSessionState(state)) {
      startTaskWallRun(run, timestamp, startsRootRun);
    } else {
      recordLifecycleEvent(run, sessionID, state, timestamp);
      run.pendingSessions.set(sessionID, {
        state,
        timestamp
      });
      return undefined;
    }
  } else if (startsRootRun && !run.hasExplicitRootStart) {
    run.runStartedAt = Math.min(run.runStartedAt ?? timestamp, timestamp);
    run.hasExplicitRootStart = true;
  }
  const accepted = recordTaskSessionActivity(run, sessionID, state, timestamp);
  if (accepted && activeTaskSessionState(state)) run.runStartedAt = Math.min(run.runStartedAt ?? timestamp, timestamp);
  return finishTaskWallRun(run, timestamp);
}
export function noteTaskRunRecord(run, sessionID, startedAt, completedAt) {
  // A message completion only finalizes message/token accounting. The task
  // run remains active until the participant emits its lifecycle idle or
  // terminal state.
  void run;
  void sessionID;
  void startedAt;
  void completedAt;
  return undefined;
}
function startSessionRun(runtime, timestamp, status = "busy") {
  for (const [messageID, contribution] of runtime.contributions) {
    runtime.completedContributions.set(messageID, contribution);
  }
  runtime.runEpoch += 1;
  runtime.status = status;
  runtime.activeMessageID = undefined;
  runtime.runStartedAt = timestamp;
  runtime.runFirstTokenAt = undefined;
  runtime.runTotals = emptyTokenCounts();
  runtime.runCost = 0;
  runtime.runResponseCount = 0;
  runtime.seenMessageIDs.clear();
  runtime.contributions.clear();
}
export function transitionSessionRuntime(runtime, status, timestamp) {
  if (status === "idle") {
    if (runtime.status === "idle" && runtime.activeMessageID === undefined) return false;
    runtime.status = "idle";
    return true;
  }
  if (runtime.status === "idle") {
    startSessionRun(runtime, timestamp, status);
  } else {
    runtime.status = status;
  }
  runtime.runStartedAt = runtime.runStartedAt === undefined ? timestamp : Math.min(runtime.runStartedAt, timestamp);
  return true;
}
export function freezeSessionRun(runtime, timestamp) {
  if (runtime.status === "idle") return undefined;
  const summary = {
    runEpoch: runtime.runEpoch,
    tokens: {
      ...runtime.runTotals
    },
    cost: runtime.runCost,
    responseCount: runtime.runResponseCount,
    ...(runtime.runStartedAt !== undefined ? {
      startedAt: runtime.runStartedAt
    } : {}),
    ...(runtime.runFirstTokenAt !== undefined ? {
      firstTokenAt: runtime.runFirstTokenAt
    } : {}),
    completedAt: timestamp
  };
  runtime.lastRunSummary = summary;
  runtime.runSummaries.set(runtime.runEpoch, summary);
  for (const [messageID, contribution] of runtime.contributions) {
    if (contribution.runEpoch === runtime.runEpoch) {
      runtime.completedContributions.set(messageID, contribution);
    }
  }
  runtime.status = "idle";
  runtime.activeMessageID = undefined;
  return summary;
}
function ensureSessionRun(store, sessionID, timestamp) {
  const runtime = getSessionRuntime(store, sessionID);
  if (runtime.status === "idle") startSessionRun(runtime, timestamp);
  runtime.status = "busy";
  runtime.runStartedAt = runtime.runStartedAt === undefined ? timestamp : Math.min(runtime.runStartedAt, timestamp);
  return runtime;
}
function getSessionRuntime(store, sessionID) {
  const existing = store.sessionRuntime.get(sessionID);
  if (existing) return existing;
  const runtime = createSessionRuntime();
  store.sessionRuntime.set(sessionID, runtime);
  return runtime;
}
export function createActiveState(messageID, sessionID, timestamp) {
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
export function lockStreamSource(selected, incoming) {
  return selected ?? incoming;
}
function getOrCreateActiveState(active, messageID, sessionID, timestamp) {
  const direct = messageID ? active.get(messageID) : undefined;
  const pendingID = pendingKey(sessionID);
  const pending = active.get(pendingID);
  const ownedPending = pending?.ownerMessageID === messageID ? pending : undefined;
  const state = direct ?? ownedPending ?? createActiveState(messageID ?? pendingID, sessionID, timestamp);
  if (direct && ownedPending && direct !== ownedPending && direct.responseEpoch === ownedPending.responseEpoch) {
    direct.progress = mergeContentProgress(direct.progress, ownedPending.progress);
    direct.fallbackTokens = mergeTokenFields(direct.fallbackTokens, ownedPending.fallbackTokens);
    for (const source of ["legacy", "v2"]) {
      direct[source].hasData ||= ownedPending[source].hasData;
      direct[source].samples.push(...ownedPending[source].samples);
    }
  }
  if (messageID) state.messageID = messageID;
  if (messageID && ownedPending) active.delete(pendingID);
  return state;
}
export function takeActiveState(active, messageID, sessionID) {
  const direct = active.get(messageID);
  const pendingID = pendingKey(sessionID);
  const pending = active.get(pendingID);
  const state = direct ?? (pending?.ownerMessageID === messageID ? pending : undefined);
  if (!state || state.sessionID !== sessionID) return undefined;
  active.delete(messageID);
  if (pending?.ownerMessageID === messageID && (state.responseEpoch === undefined || pending.responseEpoch === state.responseEpoch)) active.delete(pendingID);
  state.messageID = messageID;
  return state;
}
function ownedMessageID(store, sessionID) {
  const id = store.sessionRuntime.get(sessionID)?.activeMessageID;
  return id && observationRuntime(store).liveAssistantMessages.has(id) && !knownCompletedMessage(store, id) ? id : undefined;
}

/** Completion is a lifecycle fact, independent of whether its usage correction wins. */
export function finalizeResponse(store, messageID, sessionID, epoch, completionFact) {
  if (!completionFact.authoritative) return undefined;
  const runtime = store.sessionRuntime.get(sessionID);
  const direct = store.active.get(messageID);
  if (direct && (direct.sessionID !== sessionID || epoch !== undefined && direct.responseEpoch !== epoch)) return undefined;
  const pendingID = pendingKey(sessionID);
  const pending = store.active.get(pendingID);
  const ownedPending = pending?.sessionID === sessionID && pending.ownerMessageID === messageID && (epoch === undefined || pending.responseEpoch === epoch) ? pending : undefined;
  const state = direct ?? ownedPending;
  if (direct && ownedPending && direct !== ownedPending && direct.responseEpoch === ownedPending.responseEpoch) {
    getOrCreateActiveState(store.active, messageID, sessionID, direct.startedAt);
  }
  if (state) state.messageID = messageID;
  const sameCurrent = runtime?.activeMessageID === messageID && (epoch === undefined || runtime.runEpoch === epoch);
  if (state) store.active.delete(messageID);
  if (pending?.sessionID === sessionID && (pending.ownerMessageID === messageID || sameCurrent && pending.ownerMessageID === undefined) && (epoch === undefined || pending.responseEpoch === undefined || pending.responseEpoch === epoch)) store.active.delete(pendingID);
  if (sameCurrent) runtime.activeMessageID = undefined;
  store.completedMessageIDs.add(messageID);
  const observations = observationRuntime(store);
  observations.metadata.completed.add(messageID);
  observations.liveAssistantMessages.delete(messageID);
  if (state || sameCurrent || pending && !store.active.has(pendingID)) store.bump();
  return state;
}
export function selectedSamples(state) {
  if (!state) return [];
  if (state.selectedSource === "v2") return [...state.v2.samples];
  if (state.selectedSource === "legacy") return [...state.legacy.samples];
  return state.v2.hasData ? [...state.v2.samples] : [...state.legacy.samples];
}

// Keep live estimates source-locked; only final calibration gives v2 its priority.
export function finalSamples(state) {
  if (!state) return [];
  return state.v2.hasData ? [...state.v2.samples] : selectedSamples(state);
}
function estimateActiveTokens(state, bytesPerToken) {
  const result = emptyTokenCounts();
  const samples = selectedSamples(state);
  for (const sample of samples) {
    const tokens = Math.max(0, sample.estimatedTokens ?? sample.tokens);
    if (sample.kind === "reasoning") result.reasoning += tokens;else result.output += tokens;
  }
  if (state && samples.length === 0) {
    const source = state.selectedSource === "v2" ? state.v2 : state.legacy;
    for (const sample of source.samples) {
      result.output += bytesToTokens(sample.bytes ?? 0, bytesPerToken);
    }
  }
  return result;
}
function exactOrFallback(exact, fallback, estimate) {
  return exact ?? fallback ?? Math.max(0, Math.round(estimate));
}
function isCompleted(info, properties, event) {
  const values = [info.completed, properties.completed, event.completed];
  if (values.some(value => value === true || value === "completed")) return true;
  const status = info.status ?? properties.status ?? event.status;
  if (status === "completed" || isRecord(status) && status.type === "completed") return true;
  const time = asRecord(info.time);
  return readNumber(time?.end) !== undefined || readNumber(time?.completed) !== undefined;
}
function terminalStatus(value) {
  if (value === "idle" || value === "completed" || value === "error") return true;
  if (value === "failed" || value === "aborted" || value === "cancelled" || value === "stopped") return true;
  if (!isRecord(value)) return false;
  return terminalStatus(value.type) || terminalStatus(value.status);
}
function statusName(value) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return readString(value.type) ?? readString(value.status);
}
function infoTimeValue(info, keys) {
  return readNumberFrom([asRecord(info?.time), info], keys);
}
function makeHistoryRecord(input) {
  const start = infoTimeValue(input.info, ["start", "created"]) ?? input.state?.startedAt ?? input.completedAt;
  const completed = infoTimeValue(input.info, ["end", "completed"]) ?? input.completedAt;
  const firstToken = earliestFirstOutput(start, completed, infoTimeValue(input.info, ["firstToken", "firstTokenAt"]), input.state?.firstTokenAt);
  let timing = {
    start,
    completed,
    duration: Math.max(0, completed - start),
    ...(firstToken !== undefined ? {
      firstToken,
      firstContent: firstToken
    } : {})
  };
  if (input.state?.firstResponseAt !== undefined) {
    timing = applyFirstResponseSignal(timing, {
      timestamp: input.state.firstResponseAt,
      source: input.state.firstResponseSource ?? "content",
      timeSource: input.state.firstResponseTimeSource ?? "arrival",
      estimated: input.state.firstResponseEstimated ?? true
    });
  }
  const ttft = timeToFirstToken({
    time: timing
  });
  const duration = Math.max(0, completed - start);
  const agent = normalizeAgentName(input.agent);
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
    cost: Math.max(0, Number.isFinite(input.cost) ? input.cost : 0),
    time: {
      ...timing,
      ...(ttft !== undefined ? {
        ttft
      } : {}),
      duration
    },
    samples: input.samples,
    quality: input.quality ?? "exact"
  };
  recordQualityByObject.set(record, input.quality ?? "exact");
  record.speed = measureRecordSpeed(record, contentSpeedObservations(record, input.state?.progress, input.state?.firstTokenAt, input.quality === "exact", infoTimeValue(input.info, ["start", "created"]) !== undefined && infoTimeValue(input.info, ["end", "completed"]) !== undefined, tokenFields(input.info?.tokens).reasoning !== undefined));
  return record;
}
export function makeTokens(info, state, bytesPerToken) {
  const exact = tokenFields(info);
  const fallback = state?.fallbackTokens ?? {};
  const estimate = estimateActiveTokens(state, bytesPerToken);
  const cacheRead = exact.cacheRead ?? fallback.cacheRead ?? 0;
  const cacheWrite = exact.cacheWrite ?? fallback.cacheWrite ?? 0;
  return {
    input: exactOrFallback(exact.input, fallback.input, estimate.input),
    output: exactOrFallback(exact.output, fallback.output, estimate.output),
    reasoning: exactOrFallback(exact.reasoning, fallback.reasoning, estimate.reasoning),
    cacheRead,
    cacheWrite
  };
}
function replaceTokenContribution(total, previous, next) {
  return {
    input: Math.max(0, total.input - previous.input + next.input),
    output: Math.max(0, total.output - previous.output + next.output),
    reasoning: Math.max(0, total.reasoning - previous.reasoning + next.reasoning),
    cacheRead: Math.max(0, total.cacheRead - previous.cacheRead + next.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite + next.cacheWrite)
  };
}
function recordCompleteness(record) {
  let score = 0;
  if (record.parentSessionID) score += 2;
  if (record.model) score += 2;
  if (record.time.firstToken !== undefined) score += 1;
  if (record.time.completed !== undefined) score += 3;
  if (record.time.ttft !== undefined) score += 1;
  if (record.time.duration !== undefined) score += 1;
  if (record.samples.length > 0) score += 2 + Math.min(record.samples.length, 8);
  if (record.tokens.input > 0) score += 1;
  if (record.tokens.output > 0) score += 1;
  if (record.tokens.reasoning > 0) score += 1;
  if (record.tokens.cacheRead > 0) score += 1;
  if (record.tokens.cacheWrite > 0) score += 1;
  if (record.cost > 0) score += 1;
  return score;
}
function recordFreshness(record) {
  return Math.max(record.time.start, record.time.firstToken ?? Number.NEGATIVE_INFINITY, record.time.completed ?? Number.NEGATIVE_INFINITY);
}
function preferredHistoryRecord(candidate, existing, candidateQuality, existingQuality) {
  const authoritative = preferredUpdateLayer({
    record: candidate,
    quality: candidateQuality,
    source: "incoming",
    order: 1
  }, {
    record: existing,
    quality: existingQuality,
    source: "optimistic",
    order: 0
  });
  if (authoritative) return authoritative.record;
  if (candidateQuality !== existingQuality) {
    return candidateQuality === "exact" ? candidate : existing;
  }
  const candidateFreshness = recordFreshness(candidate);
  const existingFreshness = recordFreshness(existing);
  if (candidateFreshness !== existingFreshness) {
    return candidateFreshness > existingFreshness ? candidate : existing;
  }
  const candidateCompleteness = recordCompleteness(candidate);
  const existingCompleteness = recordCompleteness(existing);
  if (candidateCompleteness !== existingCompleteness) {
    return candidateCompleteness > existingCompleteness ? candidate : existing;
  }
  return candidate;
}
export function applyRecordToSessionRuntime(runtime, record, quality = "exact") {
  const compact = retiredContributions.get(runtime)?.get(record.messageID);
  if (compact && !runtime.contributions.has(record.messageID) && !runtime.completedContributions.has(record.messageID)) {
    if (quality !== "exact") return false;
    if (compact.runEpoch === runtime.runEpoch) {
      runtime.runTotals = replaceTokenContribution(runtime.runTotals, compact.tokens, record.tokens);
      runtime.runCost = Math.max(0, runtime.runCost - compact.cost + record.cost);
    }
    const summary = runtime.runSummaries.get(compact.runEpoch);
    if (summary) {
      const corrected = {
        ...summary,
        tokens: replaceTokenContribution(summary.tokens, compact.tokens, record.tokens),
        cost: Math.max(0, summary.cost - compact.cost + record.cost)
      };
      runtime.runSummaries.set(compact.runEpoch, corrected);
      if (runtime.lastRunSummary?.runEpoch === compact.runEpoch) runtime.lastRunSummary = corrected;
    }
    retiredContributions.get(runtime).set(record.messageID, compactContribution(record, compact.runEpoch));
    return true;
  }
  const historical = runtime.completedContributions.get(record.messageID);
  if (!runtime.contributions.has(record.messageID) && historical) {
    const previous = historical.record;
    if (quality === "provisional") return false;
    const preferred = preferredHistoryRecord(record, previous, quality, historical.quality);
    if (preferred !== record) return false;
    runtime.completedContributions.set(record.messageID, {
      ...historical,
      record,
      tokens: record.tokens,
      cost: record.cost,
      quality
    });
    const summary = runtime.runSummaries.get(historical.runEpoch);
    if (summary) {
      const tokens = replaceTokenContribution(summary.tokens, previous.tokens, record.tokens);
      runtime.runSummaries.set(historical.runEpoch, {
        ...summary,
        tokens,
        cost: Math.max(0, summary.cost - previous.cost + record.cost)
      });
      if (runtime.lastRunSummary?.runEpoch === historical.runEpoch) runtime.lastRunSummary = runtime.runSummaries.get(historical.runEpoch);
    }
    return false;
  }
  const previous = runtime.contributions.get(record.messageID);
  if (previous && previous.quality === "exact" && quality === "provisional") return false;
  if (previous) {
    const preferred = preferredHistoryRecord(record, previous.record, quality, previous.quality);
    if (preferred !== record) return false;
  }
  if (previous) {
    runtime.runTotals = replaceTokenContribution(runtime.runTotals, previous.tokens, record.tokens);
    runtime.runCost = Math.max(0, runtime.runCost - previous.cost + record.cost);
    const previousSummary = runtime.runSummaries.get(previous.runEpoch);
    if (previousSummary) {
      const correctedSummary = {
        ...previousSummary,
        tokens: replaceTokenContribution(previousSummary.tokens, previous.tokens, record.tokens),
        cost: Math.max(0, previousSummary.cost - previous.cost + record.cost)
      };
      runtime.runSummaries.set(previous.runEpoch, correctedSummary);
      if (runtime.lastRunSummary?.runEpoch === previous.runEpoch) {
        runtime.lastRunSummary = correctedSummary;
      }
    }
  } else {
    runtime.runTotals = addTokenCounts(runtime.runTotals, record.tokens);
    runtime.runCost += record.cost;
    runtime.runResponseCount += 1;
    runtime.seenMessageIDs.add(record.messageID);
  }
  runtime.contributions.set(record.messageID, {
    record,
    tokens: record.tokens,
    cost: record.cost,
    quality,
    runEpoch: runtime.runEpoch
  });
  runtime.runStartedAt = runtime.runStartedAt === undefined ? record.time.start : Math.min(runtime.runStartedAt, record.time.start);
  if (record.time.firstToken !== undefined) {
    runtime.runFirstTokenAt = runtime.runFirstTokenAt === undefined ? record.time.firstToken : Math.min(runtime.runFirstTokenAt, record.time.firstToken);
  }
  if (runtime.status === "idle" && runtime.lastRunSummary?.runEpoch === runtime.runEpoch) {
    runtime.lastRunSummary = {
      ...runtime.lastRunSummary,
      tokens: {
        ...runtime.runTotals
      },
      cost: runtime.runCost,
      responseCount: runtime.runResponseCount,
      ...(runtime.runStartedAt !== undefined ? {
        startedAt: runtime.runStartedAt
      } : {}),
      ...(runtime.runFirstTokenAt !== undefined ? {
        firstTokenAt: runtime.runFirstTokenAt
      } : {})
    };
  }
  return previous === undefined;
}
export function makeLastCompletedSnapshot(record, runEpoch = 0, _estimated = false) {
  const selected = selectSpeedMeasurement(record);
  const elapsed = selected.measurement?.durationMs ?? 0;
  const generated = record.tokens.output + record.tokens.reasoning;
  return {
    record,
    rate: selected.rate ?? 0,
    generated,
    ...(timeToFirstToken(record) !== undefined ? {
      ttft: timeToFirstToken(record)
    } : {}),
    elapsed,
    runEpoch,
    estimated: selected.estimated,
    available: selected.available,
    basis: selected.basis,
    observationQuality: selected.measurement?.observationQuality
  };
}
function commitRecord(store, record, markCompleted) {
  const quality = record.quality ?? (markCompleted ? "exact" : "provisional");
  if (!markCompleted && store.completedMessageIDs.has(record.messageID)) return;
  if (markCompleted && store.completedMessageIDs.has(record.messageID) && store.records.some(entry => entry.messageID === record.messageID && historyRecordsEquivalent(entry, record))) return;
  const selected = selectCommitRecord(store, record, quality);
  const effectiveRecord = selected.record;
  const effectiveQuality = selected.quality ?? "exact";
  const existingRuntime = getSessionRuntime(store, record.sessionID);
  const existingContribution = existingRuntime.contributions.get(record.messageID) ?? existingRuntime.completedContributions.get(record.messageID);
  const compact = retiredContributions.get(existingRuntime)?.get(record.messageID);
  const runtime = existingContribution || compact ? existingRuntime : ensureSessionRun(store, record.sessionID, record.time.start);
  const historicalEpoch = existingRuntime.completedContributions.get(record.messageID)?.runEpoch ?? compact?.runEpoch;
  if (runtime.contributions.get(record.messageID)?.quality === "exact" && effectiveQuality === "provisional") return;
  const applied = applyRecordToSessionRuntime(runtime, effectiveRecord, effectiveQuality);
  if (!applied && runtime.contributions.get(record.messageID)?.record !== effectiveRecord && runtime.completedContributions.get(record.messageID)?.record !== effectiveRecord) return;
  runtime.status = markCompleted || effectiveQuality === "exact" ? runtime.status : "busy";
  if (runtime.activeMessageID === record.messageID) runtime.activeMessageID = undefined;
  if (markCompleted || effectiveQuality === "exact") store.completedMessageIDs.add(record.messageID);
  if (selected.source === "incoming") addOptimisticRecord(store, effectiveRecord, effectiveQuality);
  const contributionEpoch = runtime.completedContributions.get(record.messageID)?.runEpoch ?? runtime.contributions.get(record.messageID)?.runEpoch ?? historicalEpoch ?? runtime.runEpoch;
  const snapshot = makeLastCompletedSnapshot(effectiveRecord, contributionEpoch, effectiveQuality === "provisional");
  const previousSnapshot = store.lastCompletedBySession.get(effectiveRecord.sessionID);
  if (previousSnapshot === undefined || previousSnapshot.record.messageID === effectiveRecord.messageID || contributionEpoch > previousSnapshot.runEpoch || contributionEpoch === previousSnapshot.runEpoch && recordCompletedAt(effectiveRecord) >= recordCompletedAt(previousSnapshot.record)) {
    store.lastCompletedBySession.set(effectiveRecord.sessionID, snapshot);
  }
  store.bump();
}
function parentSessionID(api, sessionID, info, store) {
  if (store?.sessionParents.has(sessionID)) return store.sessionParents.get(sessionID) ?? undefined;
  const explicit = readStringFrom([info], ["parentSessionID", "parentSessionId"]);
  if (explicit) return explicit;
  let stateParent;
  try {
    const session = api.state.session.get(sessionID);
    if (session?.parentID) stateParent = session.parentID;
  } catch {
    // State can still be syncing while a response completes.
  }
  return stateParent ?? store?.sessionParents.get(sessionID) ?? undefined;
}
function knownRootSessionID(store, sessionID) {
  return tuiReadModel(store).root(sessionID);
}
function rewriteRecordParent(record, parentSessionID) {
  if (parentSessionID === undefined || record.parentSessionID === parentSessionID) return record;
  const next = {
    ...record,
    parentSessionID: parentSessionID ?? undefined
  };
  const quality = recordQualityByObject.get(record);
  if (quality !== undefined) recordQualityByObject.set(next, quality);
  return next;
}
function repairKnownParents(store) {
  let changed = false;
  const repair = record => {
    const next = rewriteRecordParent(record, store.sessionParents.get(record.sessionID));
    if (next !== record) changed = true;
    return next;
  };
  const repairedRecords = store.records.map(repair);
  store.diskRecords = store.diskRecords.map(repair);
  for (const [messageID, record] of store.optimistic) {
    const next = repair(record);
    if (next === record) continue;
    store.optimistic.set(messageID, next);
    recordQualityByObject.set(next, store.optimisticQuality.get(messageID) ?? recordQuality(record));
  }
  if (changed) {
    if (store.diskRecords.length > 0 || store.optimistic.size > 0) {
      store.records = mergeHistoryLayers(baseHistoryRecords(store), store.optimistic, store.maxRecords, store.optimisticQuality, store.optimisticOrder);
    } else {
      store.records = repairedRecords;
    }
    for (const [sessionID, snapshot] of store.lastCompletedBySession) {
      const repaired = repair(snapshot.record);
      if (repaired !== snapshot.record) {
        store.lastCompletedBySession.set(sessionID, {
          ...snapshot,
          record: repaired
        });
      }
    }
    for (const runtime of store.sessionRuntime.values()) {
      for (const contribution of runtime.contributions.values()) {
        contribution.record = repair(contribution.record);
      }
    }
    store.bump();
  }
  return changed;
}
function mergeTaskWallRun(target, source, rootSessionID) {
  const targetWasActive = target.phase === "active";
  const sourceWasActive = source.phase === "active";
  const targetHistory = completeLifecycleHistoryForRun(target);
  const sourceHistory = sourceWasActive ? completeLifecycleHistoryForRun(source) : closeLifecycleHistoryAt(completeLifecycleHistoryForRun(source), source.lastRunWallTime?.completedAt);
  const sourceIntervals = sourceWasActive ? source.activeIntervals : mergeIntervals(source.lastRunIntervals, source.carriedIntervals);
  const carriedSourceIntervals = mergeIntervals(source.lastRunIntervals, source.carriedIntervals);
  const sourceLifecycleEvents = sourceWasActive ? source.lifecycleEvents : new Map();
  const activeCandidates = new Set([...target.activeSessions, ...source.activeSessions]);
  target.rootSessionID = rootSessionID;
  target.lifecycleHistory = mergeLifecycleEventMaps(targetHistory, sourceHistory);
  const historicalIntervals = lifecycleIntervals(target.lifecycleHistory);
  target.carriedIntervals = cloneIntervals(historicalIntervals);
  target.lastRunIntervals = cloneIntervals(historicalIntervals);
  target.lastRunCarriedIntervals = cloneIntervals(historicalIntervals);
  target.lastRunLifecycleEvents = cloneLifecycleEventMap(target.lifecycleHistory);
  target.phase = target.phase === "active" || source.phase === "active" ? "active" : "idle";
  target.runEpoch = Math.max(target.runEpoch, source.runEpoch);
  target.rootBusy = target.rootBusy || source.rootBusy;
  target.rootObserved = target.rootObserved || source.rootObserved;
  target.hasExplicitRootStart = target.hasExplicitRootStart || source.hasExplicitRootStart;
  const lifecycleCandidates = new Map();
  for (const [sessionID, events] of target.lifecycleEvents) {
    lifecycleCandidates.set(sessionID, mergeLifecycleEvents(events, []));
  }
  for (const [sessionID, events] of sourceLifecycleEvents) {
    lifecycleCandidates.set(sessionID, mergeLifecycleEvents(lifecycleCandidates.get(sessionID) ?? [], events));
  }
  target.lifecycleEvents = lifecycleCandidates;
  const pendingLifecycle = new Map();
  for (const [sessionID, events] of target.pendingLifecycleEvents) {
    pendingLifecycle.set(sessionID, events.map(event => ({
      ...event
    })));
  }
  for (const [sessionID, events] of source.pendingLifecycleEvents) {
    pendingLifecycle.set(sessionID, mergeLifecycleEvents(pendingLifecycle.get(sessionID) ?? [], events));
  }
  target.pendingLifecycleEvents = pendingLifecycle;
  if (targetWasActive) {
    target.activeIntervals = mergeIntervals(target.activeIntervals, sourceIntervals);
    target.activeElapsed = intervalElapsed(target.activeIntervals);
  }
  const mergedParticipants = new Set([...target.participantSessions, ...source.participantSessions]);
  target.participantSessions = mergedParticipants;
  if (source.runStartedAt !== undefined) {
    target.runStartedAt = target.runStartedAt === undefined ? source.runStartedAt : Math.min(target.runStartedAt, source.runStartedAt);
  }
  if (carriedSourceIntervals.length > 0) {
    const sourceStart = Math.min(...carriedSourceIntervals.map(interval => interval.start));
    target.runStartedAt = target.runStartedAt === undefined ? sourceStart : Math.min(target.runStartedAt, sourceStart);
  }
  const sourceEarliestActive = earliestActiveTimestamp(source);
  if (sourceEarliestActive !== undefined) {
    target.runStartedAt = target.runStartedAt === undefined ? sourceEarliestActive : Math.min(target.runStartedAt, sourceEarliestActive);
  }
  for (const sessionID of source.participantSessions) target.participantSessions.add(sessionID);
  for (const [sessionID, state] of source.sessionStates) {
    const current = target.sessionStates.get(sessionID);
    const currentAt = target.lastActivityAt.get(sessionID) ?? Number.NEGATIVE_INFINITY;
    const sourceAt = source.lastActivityAt.get(sessionID) ?? Number.NEGATIVE_INFINITY;
    if (current === undefined || sourceAt > currentAt || sourceAt === currentAt && activeTaskSessionState(state) && !activeTaskSessionState(current)) {
      target.sessionStates.set(sessionID, state);
    }
  }
  for (const [sessionID, timestamp] of source.lastActivityAt) {
    const current = target.lastActivityAt.get(sessionID);
    if (current === undefined || timestamp > current) {
      target.lastActivityAt.set(sessionID, timestamp);
    }
  }
  for (const [sessionID, pending] of source.pendingSessions) {
    const current = target.pendingSessions.get(sessionID);
    if (current === undefined || pending.timestamp > current.timestamp || pending.timestamp === current.timestamp && activeTaskSessionState(pending.state) && !activeTaskSessionState(current.state)) {
      target.pendingSessions.set(sessionID, pending);
    }
  }
  for (const sessionID of activeCandidates) {
    target.participantSessions.add(sessionID);
    if (!target.sessionStates.has(sessionID)) {
      target.sessionStates.set(sessionID, "busy");
    }
  }
  for (const [sessionID, events] of target.lifecycleEvents) {
    const latest = events.at(-1);
    if (!latest) continue;
    target.participantSessions.add(sessionID);
    target.sessionStates.set(sessionID, latest.state);
    target.lastActivityAt.set(sessionID, Math.max(target.lastActivityAt.get(sessionID) ?? Number.NEGATIVE_INFINITY, latest.timestamp));
  }
  target.activeSessions.clear();
  for (const [sessionID, state] of target.sessionStates) {
    if (activeTaskSessionState(state)) target.activeSessions.add(sessionID);
  }
  const rootState = target.sessionStates.get(rootSessionID);
  target.rootObserved = rootState !== undefined;
  target.rootBusy = activeTaskSessionState(rootState);
  target.hasExplicitRootStart = activeTaskSessionState(rootState);
  target.runStartedAt = earliestActiveTimestamp(target) ?? target.runStartedAt;
  rebuildActiveIntervals(target);
  const sourceSummary = source.lastRunWallTime;
  const targetSummary = target.lastRunWallTime;
  if (targetSummary === undefined || sourceSummary !== undefined && (sourceSummary.runEpoch > targetSummary.runEpoch || sourceSummary.runEpoch === targetSummary.runEpoch && sourceSummary.completedAt > targetSummary.completedAt)) {
    target.lastRunWallTime = sourceSummary;
  }
  if (target.lastRunWallTime) {
    const completedAt = Math.max(target.lastRunWallTime.completedAt, source.lastRunWallTime?.completedAt ?? target.lastRunWallTime.completedAt);
    const completedIntervals = lifecycleIntervals(target.lifecycleHistory, completedAt);
    target.lastRunIntervals = cloneIntervals(completedIntervals);
    target.lastRunCarriedIntervals = cloneIntervals(completedIntervals);
    target.lastRunWallTime = {
      ...target.lastRunWallTime,
      completedAt,
      startedAt: Math.min(target.lastRunWallTime.startedAt, ...completedIntervals.map(interval => interval.start)),
      wallTime: intervalElapsed(completedIntervals)
    };
  }
  if (target.phase === "active") rebuildActiveIntervals(target);else {
    target.lastRunLifecycleEvents = cloneLifecycleEventMap(target.lifecycleHistory);
    target.lastRunCarriedIntervals = cloneIntervals(target.carriedIntervals);
    target.lastRunIntervals = cloneIntervals(target.carriedIntervals);
    if (target.lastRunWallTime) {
      target.lastRunWallTime = {
        ...target.lastRunWallTime,
        wallTime: intervalElapsed(target.lastRunIntervals),
        completedAt: Math.max(target.lastRunWallTime.completedAt, source.lastRunWallTime?.completedAt ?? target.lastRunWallTime.completedAt),
        startedAt: Math.min(target.lastRunWallTime.startedAt, ...target.lastRunIntervals.map(interval => interval.start))
      };
    }
  }
}
function migrateTaskWallRuns(store, rootSessionID) {
  let target = store.taskRuns.get(rootSessionID);
  let changed = false;
  const entries = [...store.taskRuns.entries()];
  for (const [key, source] of entries) {
    if (key === rootSessionID) continue;
    if (knownRootSessionID(store, key) !== rootSessionID && knownRootSessionID(store, source.rootSessionID) !== rootSessionID) {
      continue;
    }
    if (!target) {
      source.rootSessionID = rootSessionID;
      store.taskRuns.delete(key);
      store.taskRuns.set(rootSessionID, source);
      target = source;
    } else {
      mergeTaskWallRun(target, source, rootSessionID);
      store.taskRuns.delete(key);
    }
    changed = true;
  }
  return changed;
}
function rememberSessionParent(store, sessionID, parentID) {
  if (!sessionID || sessionID === parentID) return false;
  const changed = tuiReadModel(store).observeParent(sessionID, {
    parent: parentID,
    origin: "cache"
  });
  if (!changed) return false;
  const repaired = repairKnownParents(store);
  const rootSessionID = knownRootSessionID(store, sessionID);
  const migrated = migrateTaskWallRuns(store, rootSessionID);
  return changed || repaired || migrated;
}
function sessionParentFromEvent(type, properties, event) {
  const normalizedType = type.toLowerCase();
  const sources = [properties, event, asRecord(properties.info), asRecord(properties.message), asRecord(properties.session), asRecord(properties.event), asRecord(event.info), asRecord(event.session), asRecord(event.event)];
  for (const source of sources) if (source && (Object.hasOwn(source, "parentSessionID") || Object.hasOwn(source, "parentSessionId"))) {
    const value = source.parentSessionID ?? source.parentSessionId;
    if (value === null || value === undefined || value === "") return null;
  }
  const explicit = readStringFrom(sources, ["parentSessionID", "parentSessionId"]);
  if (explicit) return explicit;
  if (!normalizedType.startsWith("session.")) return undefined;
  const sessionEntitySources = [asRecord(properties.session), asRecord(event.session), asRecord(properties.event)?.session, asRecord(event.event)?.session, asRecord(properties.info)?.session, asRecord(event.info)?.session].filter(value => isRecord(value));
  const isSessionEntityEvent = normalizedType === "session.created" || normalizedType === "session.updated";
  if (isSessionEntityEvent) {
    for (const source of [properties, event, asRecord(properties.info), asRecord(event.info), asRecord(properties.event), asRecord(event.event)]) {
      if (source) sessionEntitySources.push(source);
    }
  }
  for (const source of sessionEntitySources) if (Object.hasOwn(source, "parentID") && (source.parentID === null || source.parentID === undefined || source.parentID === "")) return null;
  return readStringFrom(sessionEntitySources, ["parentID", "parent.id"]);
}
export function cacheSessionParentFromEvent(store, input) {
  const event = normalizeEvent(input);
  if (!event) return false;
  const type = eventType(event);
  if (type !== "session.created" && type !== "session.updated") return false;
  const properties = eventProperties(event);
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return false;
  const before = store.sourceScopes.revision;
  const model = tuiReadModel(store);
  store.sourceScopes.observeSessionMetadata(sessionID, eventInfo(properties, event) ?? asRecord(properties.session) ?? properties);
  const parentID = sessionParentFromEvent(type, properties, event);
  const mapped = parentID !== undefined ? model.observeParent(sessionID, {
    parent: parentID,
    origin: "live",
    identity: readString(event.sourceEventID ?? event.id),
    sourceEpoch: readString(event.sourceEpoch ?? event.instanceID),
    sourceSequence: readNumber(event.sourceSequence),
    entityRevision: readNumber(event.entityRevision)
  }) : false;
  model.syncScopes(sessionID);
  if (mapped) {
    repairKnownParents(store);
    migrateTaskWallRuns(store, model.root(sessionID));
  }
  if (store.sourceScopes.revision !== before) {
    refreshScopeProjection(store);
  }
  return mapped || store.sourceScopes.revision !== before;
}
function rootSessionIDFor(store, api, sessionID, info) {
  const previous = store.sourceScopes.revision;
  const model = tuiReadModel(store);
  model.bindProof(api[parentProofPort]);
  try {
    // A V2 TUI may attach after parent creation events. Cached ancestor
    // metadata is still authoritative Magic Context evidence; no network read.
    const visited = new Set();
    let id = sessionID;
    while (id && !visited.has(id)) {
      if (id !== sessionID && model.ancestryChecked.has(id)) break;
      visited.add(id);
      const cached = api.state.session.get(id);
      if (cached) {
        store.sourceScopes.observeSessionMetadata(id, cached);
        model.syncScopes(id);
      }
      if (cached && Object.hasOwn(cached, "parentID")) model.observeParent(id, {
        parent: cached.parentID || null,
        origin: "cache"
      });
      const parent = model.parents.get(id);
      model.ancestryChecked.add(id);
      id = parent ?? undefined;
    }
  } catch {/* SDK state may not be ready; unknown is not exclusion evidence. */}
  const parent = readStringFrom([info], ["parentSessionID", "parentSessionId"]);
  if (parent) rememberSessionParent(store, sessionID, parent);
  if (previous !== store.sourceScopes.revision && !scopeEligible(store, sessionID)) refreshScopeProjection(store);
  const rootSessionID = knownRootSessionID(store, sessionID);
  return rootSessionID;
}
function getTaskWallRun(store, rootSessionID) {
  const existing = store.taskRuns.get(rootSessionID);
  if (existing) return existing;
  const run = createTaskWallRun(rootSessionID);
  store.taskRuns.set(rootSessionID, run);
  return run;
}
function taskWallRunsForActivityRoot(store, rootSessionID) {
  const runs = [];
  for (const [key, run] of store.taskRuns) {
    const sessionIDs = new Set([key, run.rootSessionID, ...run.participantSessions, ...run.activeSessions, ...run.sessionStates.keys(), ...run.pendingSessions.keys()]);
    if ([...sessionIDs].some(sessionID => activityRootSessionID(store, sessionID) === rootSessionID)) {
      runs.push(run);
    }
  }
  return runs;
}
function findTaskWallRun(store, rootSessionID, sessionID) {
  const direct = store.taskRuns.get(rootSessionID);
  if (direct) return direct;
  return taskWallRunsForActivityRoot(store, rootSessionID).find(run => run.rootSessionID === sessionID || run.participantSessions.has(sessionID));
}
const taskDisplaySnapshots = new WeakMap();
function taskDisplayIntervals(store, run, now) {
  const sources = [run.lifecycleHistory, run.lifecycleEvents, run.pendingLifecycleEvents, run.lastRunLifecycleEvents];
  let cached = taskDisplaySnapshots.get(run);
  const unchanged = cached?.store === store && cached.scopeRevision === store.sourceScopes.revision && cached.ledger === store.totalsLedger && cached.parents === store.sessionParents && cached.phase === run.phase && sources.every((source, index) => source === cached.sources[index] && source.size === cached.entries[index].length && cached.entries[index].every(([id, events]) => source.get(id) === events));
  if (!unchanged) {
    // Lifecycle arrays are replaced, not mutated, by recordLifecycleFact. Replay
    // their closed facts once; a timer tick only extends the current open tail.
    const history = new Map([...completeLifecycleHistoryForRun(run)].filter(([id]) => scopeEligible(store, id)));
    const latest = [...history.values()].flatMap(events => events.at(-1) ? [events.at(-1).timestamp] : []);
    const boundary = latest.length ? Math.max(...latest) : undefined;
    cached = {
      store,
      scopeRevision: store.sourceScopes.revision,
      ledger: store.totalsLedger,
      parents: store.sessionParents,
      phase: run.phase,
      sources,
      entries: sources.map(source => [...source]),
      history,
      intervals: lifecycleIntervals(history),
      boundary,
      open: run.phase === "active" && [...history.values()].some(events => activeTaskSessionState(events.at(-1)?.state))
    };
    taskDisplaySnapshots.set(run, cached);
  }
  if (!cached.history.size) return run.phase === "active" ? cloneIntervals(run.carriedIntervals) : [...run.lastRunIntervals, ...run.carriedIntervals];
  const boundary = cached.boundary;
  if (run.phase === "active" && boundary !== undefined && now < boundary) return lifecycleIntervals(cached.history, now);
  return cached.open && boundary !== undefined && now > boundary ? [...cached.intervals, {
    start: boundary,
    end: now
  }] : cached.intervals;
}
export function taskWallTimeForSession(store, sessionID, now = Date.now()) {
  if (!sessionID || !scopeEligible(store, sessionID)) return undefined;
  if (tuiActivities.has(store) || store.activityEvents.length && store.taskRuns.size === 0) {
    const value = tuiActivity(store);
    const root = activityRootSessionID(store, sessionID);
    if (!value.selection.knownRoot(root) && !store.taskRuns.has(root)) return undefined;
    return tuiActivityTimes(store, root, now).includingMilliseconds;
  }
  const rootSessionID = activityRootSessionID(store, sessionID);
  migrateTaskWallRuns(store, rootSessionID);
  const runs = taskWallRunsForActivityRoot(store, rootSessionID);
  const liveIntervals = [];
  let hasCompletedLiveActivity = false;
  for (const run of runs) {
    liveIntervals.push(...taskDisplayIntervals(store, run, now));
    hasCompletedLiveActivity ||= run.lifecycleEvents.size > 0 || run.lastRunWallTime !== undefined || run.lastRunLifecycleEvents.size > 0 || run.lastRunIntervals.length > 0 || run.carriedIntervals.length > 0;
  }
  // Standalone legacy TaskWallRun utility fixtures have no observation facts.
  // Production lifecycle/canonical consumers always use the shared projector.
  const intervals = mergeIntervals(liveIntervals);
  if (intervals.length > 0) return intervalElapsed(intervals);
  if (hasCompletedLiveActivity) return 0;
  return undefined;
}
export function hasLiveTaskWallActivity(store) {
  if (store.disposed) return false;
  if (tuiActivities.has(store)) {
    const value = tuiActivity(store);
    for (const id of value.candidates) {
      if (tuiActivityTimes(store, id).active) return true;
      value.candidates.delete(id);
    }
    return false;
  }
  for (const state of store.active.values()) if (observationRuntime(store).liveAssistantMessages.has(state.messageID) && !knownCompletedMessage(store, state.messageID) && scopeEligible(store, state.sessionID, state.messageID)) return true;
  for (const run of store.taskRuns.values()) {
    if (run.phase === "active" && [...run.activeSessions].some(id => scopeEligible(store, id))) return true;
  }
  return false;
}
export function mergeTaskActivityIntervals(replay, sessionID, liveIntervals = [], sessionParents) {
  if (!replay) return mergeIntervals([], liveIntervals);
  const rootSessionID = activityRootSessionIDFromReplay(replay, sessionID, sessionParents);
  const persisted = persistedActivityIntervalsForRoot(replay, rootSessionID, sessionParents);
  return mergeIntervals(persisted, liveIntervals);
}
function activityParentMap(replay, sessionParents) {
  const parents = new Map();
  for (const [sessionID, parentSessionID] of replay.parentBySessionID) {
    if (parentSessionID) parents.set(sessionID, parentSessionID);
  }
  if (sessionParents) {
    for (const [sessionID, parentSessionID] of sessionParents) {
      if (parentSessionID) parents.set(sessionID, parentSessionID);
    }
  }
  return parents;
}
function activityRootSessionIDFromReplay(replay, sessionID, sessionParents) {
  return resolveRootSessionID(sessionID, activityParentMap(replay, sessionParents));
}
function activityRootSessionID(store, sessionID) {
  return tuiReadModel(store).root(sessionID);
}
function activityParticipantIDs(replay) {
  const sessionIDs = new Set();
  for (const participant of replay.participants) sessionIDs.add(participant.sessionID);
  for (const [sessionID, parentSessionID] of replay.parentBySessionID) {
    sessionIDs.add(sessionID);
    if (parentSessionID) sessionIDs.add(parentSessionID);
  }
  return sessionIDs;
}
function persistedActivityIntervalsForRoot(replay, rootSessionID, sessionParents) {
  const intervals = [];
  for (const sessionID of activityParticipantIDs(replay)) {
    if (activityRootSessionIDFromReplay(replay, sessionID, sessionParents) !== rootSessionID) continue;
    const timeline = replay.timelines.get(sessionID);
    if (timeline) intervals.push(...timeline.activeIntervals);
  }
  return mergeIntervals(intervals, []);
}
function persistedCompletedActivityForRoot(replay, rootSessionID, sessionParents) {
  for (const sessionID of activityParticipantIDs(replay)) {
    if (activityRootSessionIDFromReplay(replay, sessionID, sessionParents) !== rootSessionID) continue;
    const timeline = replay.timelines.get(sessionID);
    if (timeline && timeline.events.length > 0 && !timeline.open) return true;
  }
  return false;
}
export function noteTaskRecord(store, api, record) {
  const info = record.parentSessionID ? {
    parentSessionID: record.parentSessionID
  } : undefined;
  const rootSessionID = rootSessionIDFor(store, api, record.sessionID, info);
  const run = findTaskWallRun(store, rootSessionID, record.sessionID);
  if (!run || run.phase !== "active") return;
  const summary = noteTaskRunRecord(run, record.sessionID, record.time.start, record.time.completed);
  if (summary) store.bump();
}
export function recordDelta(_store, _properties, _event, _stream, _explicitKind, _bytesPerToken, _receivedAt = Date.now(), _receivedMono = performance.now(), _clock) {
  // Content streaming is intentionally not projected. Completion, history, and
  // activity events remain the only paths that refresh usage or task time.
}
export function recordStepStarted(store, properties, event) {
  if (isReplayEvent(event, properties)) return;
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties) ?? ownedMessageID(store, sessionID);
  if (!scopeEligible(store, sessionID, messageID)) return;
  if (messageID && (knownCompletedMessage(store, messageID) || knownNonAssistant(store, messageID))) return;
  const timestamp = eventTimestamp(event, properties);
  const runtime = messageID && observationRuntime(store).liveAssistantMessages.has(messageID) ? ensureSessionRun(store, sessionID, timestamp) : getSessionRuntime(store, sessionID);
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.startedAt = Math.min(state.startedAt, timestamp);
  state.model = state.model ?? modelName(properties);
  state.progress ??= cachedContentProgress(observationRuntime(store).metadata, messageID ?? pendingKey(sessionID));
  noteStepIdentity(state.progress, stepIdentity(properties));
  bindTuiPendingTaints(store, state);
  if (messageID) runtime.activeMessageID = messageID;
  state.responseEpoch ??= runtime.runEpoch;
  state.ownerMessageID ??= messageID;
  store.active.set(state.messageID, state);
  store.bump();
}
export function recordStepFallback(store, properties, event) {
  if (isReplayEvent(event, properties)) return;
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties) ?? ownedMessageID(store, sessionID);
  if (!scopeEligible(store, sessionID, messageID)) return;
  if (messageID && (knownCompletedMessage(store, messageID) || knownNonAssistant(store, messageID))) return;
  const timestamp = eventTimestamp(event, properties);
  const runtime = messageID && observationRuntime(store).liveAssistantMessages.has(messageID) ? ensureSessionRun(store, sessionID, timestamp) : getSessionRuntime(store, sessionID);
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  const info = eventInfo(properties, event);
  state.fallbackTokens = tokenFields(info?.tokens ?? properties.tokens ?? properties);
  state.progress ??= cachedContentProgress(observationRuntime(store).metadata, messageID ?? pendingKey(sessionID));
  noteStepIdentity(state.progress, stepIdentity(properties));
  bindTuiPendingTaints(store, state);
  state.model = state.model ?? modelName(properties);
  state.cost = readNumber(info?.cost ?? properties.cost) ?? state.cost;
  if (messageID) runtime.activeMessageID = messageID;
  state.responseEpoch ??= runtime.runEpoch;
  state.ownerMessageID ??= messageID;
  store.active.set(state.messageID, state);
  store.bump();
}
function preferredUpdateLayer(candidate, existing) {
  const next = coerceCompletionUpdate(candidate.record.update);
  const previous = coerceCompletionUpdate(existing.record.update);
  if (!next && !previous) return undefined;
  const nextQuality = candidate.quality ?? "exact";
  const previousQuality = existing.quality ?? "exact";
  if (next && previous) {
    // The same provider fact written by the server confirms the overlay. Its
    // canonical samples/timing may differ from local arrival observations.
    if (next.fingerprint === previous.fingerprint && next.revision === previous.revision) {
      if (candidate.source === "disk") return candidate;
      if (existing.source === "disk") return existing;
      return existing;
    }
    if (!isNewerCompletionUpdate(next, previous)) return existing;
    return nextQuality === "exact" || previousQuality !== "exact" ? candidate : existing;
  }
  if (nextQuality !== previousQuality) return nextQuality === "exact" ? candidate : existing;
  return next ? candidate : existing;
}
function baseHistoryRecords(store) {
  if (store.diskRecords.length > 0 || store.records.length === 0) return scopedRecords(store, store.diskRecords);
  return scopedRecords(store, store.records.filter(record => !store.optimistic.has(record.messageID)));
}
function preferredHistoryLayer(candidate, existing) {
  const selected = selectPreferredHistoryLayer(candidate, existing);
  const other = selected === candidate ? existing : candidate;
  // Legacy snapshots can confirm usage without supplying agent metadata. Keep
  // observed identity only for this same message and session, never a parent.
  if (selected.record.messageID !== other.record.messageID || selected.record.sessionID !== other.record.sessionID || normalizeAgentName(selected.record.agent)) return selected;
  const agent = normalizeAgentName(other.record.agent);
  return agent ? {
    ...selected,
    record: {
      ...selected.record,
      agent
    }
  } : selected;
}
function selectPreferredHistoryLayer(candidate, existing) {
  const authoritative = preferredUpdateLayer(candidate, existing);
  if (authoritative) return authoritative;
  const candidateQuality = candidate.quality ?? "exact";
  const existingQuality = existing.quality ?? "exact";
  const candidateCompleteness = recordCompleteness(candidate.record);
  const existingCompleteness = recordCompleteness(existing.record);
  if (candidateQuality !== existingQuality) {
    if (candidate.source !== "disk" && candidateQuality === "exact" && existing.source === "disk" && existingQuality === "provisional") return candidate;
    if (existing.source !== "disk" && existingQuality === "exact" && candidate.source === "disk" && candidateQuality === "provisional") return existing;
    if (candidate.source === "disk" && candidateQuality === "exact" && candidateCompleteness > existingCompleteness) return candidate;
    if (existing.source === "disk" && existingQuality === "exact" && existingCompleteness > candidateCompleteness) return existing;
    if (candidateQuality === "exact" && existingQuality === "provisional") {
      return candidate;
    }
    if (candidateQuality === "provisional" && existingQuality === "exact") {
      return existing;
    }
    return candidateQuality === "exact" ? candidate : existing;
  }
  if (candidate.source !== "disk" && existing.source === "disk" && candidateCompleteness !== existingCompleteness) {
    return candidateCompleteness > existingCompleteness ? candidate : existing;
  }
  if (existing.source !== "disk" && candidate.source === "disk" && candidateCompleteness !== existingCompleteness) {
    return candidateCompleteness > existingCompleteness ? candidate : existing;
  }
  const candidateVolume = totalTokens(candidate.record.tokens);
  const existingVolume = totalTokens(existing.record.tokens);
  if (candidateVolume !== existingVolume) {
    return candidateVolume > existingVolume ? candidate : existing;
  }
  const candidateFreshness = recordFreshness(candidate.record);
  const existingFreshness = recordFreshness(existing.record);
  if (candidateFreshness !== existingFreshness) {
    return candidateFreshness > existingFreshness ? candidate : existing;
  }
  if (candidateCompleteness !== existingCompleteness) {
    return candidateCompleteness > existingCompleteness ? candidate : existing;
  }
  if (candidate.order !== existing.order) return candidate.order > existing.order ? candidate : existing;
  return candidate.source === "optimistic" ? candidate : existing;
}
function addOptimisticRecord(store, record, quality) {
  recordQualityByObject.set(record, quality);
  const existing = store.optimistic.has(record.messageID);
  store.optimistic.set(record.messageID, record);
  store.optimisticQuality.set(record.messageID, quality);
  store.optimisticOrder.set(record.messageID, store.nextOptimisticOrder);
  store.nextOptimisticOrder += 1;
  // The displayed history window is bounded; cumulative unconfirmed evidence
  // is not a reason to scan every previous response on each completion. A late
  // correction of a trimmed ID retains its original position, not a new row.
  if (existing) store.records = store.records.map(entry => entry.messageID === record.messageID ? record : entry);else store.records = mergeHistoryLayers(store.records, new Map([[record.messageID, record]]), store.maxRecords, store.optimisticQuality, store.optimisticOrder);
  store.bump();
  return true;
}
function selectCommitRecord(store, record, quality) {
  const candidates = [{
    record,
    quality,
    source: "incoming",
    order: store.nextOptimisticOrder
  }];
  const previous = store.optimistic.get(record.messageID);
  const previousQuality = store.optimisticQuality.get(record.messageID) ?? (previous ? recordQualityByObject.get(previous) : undefined) ?? "exact";
  if (previous) {
    candidates.push({
      record: previous,
      quality: previousQuality,
      source: "optimistic",
      order: store.optimisticOrder.get(record.messageID) ?? Number.NEGATIVE_INFINITY
    });
  }
  const diskRecord = baseHistoryRecords(store).find(entry => entry.messageID === record.messageID);
  if (diskRecord) candidates.push({
    record: diskRecord,
    quality: diskRecordQuality(diskRecord),
    source: "disk",
    order: 0
  });
  return candidates.slice(1).reduce((best, candidate) => preferredHistoryLayer(candidate, best), candidates[0]);
}
export function handleMessageUpdated(store, api, properties, event, bytesPerToken, receivedAt = Date.now()) {
  const info = eventInfo(properties, event);
  if (!info) return false;
  const messageID = readMessageID(properties, info);
  const sessionID = readStringFrom([info, properties, event], ["sessionID", "sessionId", "session.id"]);
  if (!messageID || !sessionID) return false;
  rootSessionIDFor(store, api, sessionID);
  observeAssistantScope(store, sessionID, messageID, info);
  if (!scopeEligible(store, sessionID, messageID)) {
    finalizeResponse(store, messageID, sessionID, store.active.get(messageID)?.responseEpoch, {
      authoritative: true
    });
    return false;
  }
  const observations = observationRuntime(store);
  recordTuiObservationLifecycle(store, "message.updated", properties, event, receivedAt);
  if (typeof info.role === "string") observations.metadata.roles.set(messageID, info.role);
  if (info.role !== "assistant") {
    observations.liveAssistantMessages.delete(messageID);
    if (typeof info.role === "string") store.active.delete(messageID);
    return false;
  }
  const timestamp = eventTimestamp(event, properties);
  if (!isCompleted(info, properties, event)) {
    if (knownCompletedMessage(store, messageID) || isReplayEvent(event, properties)) return false;
    const created = infoTimeValue(info, ["start", "created"]);
    const existing = store.active.get(messageID) ?? store.active.get(pendingKey(sessionID));
    // Do not infer a current response merely from an unfinished recovered record.
    if (created === undefined || created < observations.observedSince || created > receivedAt) return false;
    for (const candidate of store.active.values()) {
      if (candidate.sessionID !== sessionID || candidate.messageID === messageID || !observations.liveAssistantMessages.has(candidate.messageID)) continue;
      if (candidate.startedAt > created) return false;
      observations.liveAssistantMessages.delete(candidate.messageID);
    }
    observations.liveAssistantMessages.add(messageID);
    const runtime = ensureSessionRun(store, sessionID, timestamp);
    const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
    state.responseEpoch = runtime.runEpoch;
    state.ownerMessageID = messageID;
    state.startedAt = Math.min(state.startedAt, created);
    if (state.observedFromStart === undefined) {
      const cached = cachedContentProgress(observations.metadata, messageID);
      const usage = tokenFields(info.tokens);
      const alreadyGenerating = (usage.output ?? 0) > 0 || (usage.reasoning ?? 0) > 0 || infoTimeValue(info, ["firstToken", "firstContent", "firstResponse"]) !== undefined || ["in_progress", "in-progress", "recovering", "recovered"].includes(readString(info.status) ?? "");
      state.observedFromStart = !alreadyGenerating && !(existing?.legacy.hasData || existing?.v2.hasData) && ![...cached.parts.values()].some(part => part.snapshotBytes > 0 || part.deltaBytes > 0);
      state.progress = mergeContentProgress(createContentProgress({
        fromCurrentStart: state.observedFromStart
      }), state.progress ?? cached);
      observations.metadata.progress.set(messageID, state.progress);
    }
    bindTuiPendingTaints(store, state);
    if (observations.taintedMessages.has(messageID)) taintTuiState(store, state, "previous-response-disruption");
    state.model = state.model ?? modelName(info);
    state.agent = normalizeAgentName(info.agent) ?? state.agent;
    state.cost = state.cost ?? readNumber(info.cost);
    state.fallbackTokens = mergeTokenFields(state.fallbackTokens, tokenFields(info.tokens));
    runtime.activeMessageID = messageID;
    store.active.set(messageID, state);
    store.bump();
    return false;
  }
  if (isReplayEvent(event, properties)) return false;
  const finalized = finalizeResponse(store, messageID, sessionID, store.active.get(messageID)?.responseEpoch, {
    completedAt: infoTimeValue(info, ["completed", "end"]),
    authoritative: true
  });
  const previous = previousTuiRecord(store, messageID);
  const openSnapshot = ownValue(store.totalsLedger.open, messageID);
  const snapshot = openSnapshot ?? ownValue(store.totalsLedger.settled, messageID);
  if (snapshot === true) {
    store.completedMessageIDs.add(messageID);
    observations.metadata.completed.add(messageID);
    store.active.delete(messageID);
    return false;
  }
  let prior = previous ?? snapshot;
  const snapshotUpdate = coerceCompletionUpdate(snapshot?.update);
  const previousUpdate = coerceCompletionUpdate(previous?.update);
  if (snapshot && snapshotUpdate && (!previousUpdate || isNewerCompletionUpdate(snapshotUpdate, previousUpdate))) prior = snapshot;
  const priorUpdate = coerceCompletionUpdate(prior?.update);
  const fingerprint = createHash("sha256").update(serializeCompletionFact(properties.v2Completion ?? info)).digest("hex");
  const revision = readNumber(event.revision ?? properties.revision);
  const update = {
    source: "live",
    instanceID: observations.instanceID,
    sequence: observations.metadata.nextSequence++,
    receivedAt,
    ...(revision !== undefined ? {
      revision
    } : {}),
    fingerprint,
    seenFingerprints: [...new Set([...(priorUpdate?.seenFingerprints ?? []), ...(priorUpdate ? [priorUpdate.fingerprint] : []), fingerprint])]
  };
  if (!isNewerCompletionUpdate(update, priorUpdate)) {
    store.completedMessageIDs.add(messageID);
    observations.metadata.completed.add(messageID);
    store.active.delete(messageID);
    return false;
  }
  const pendingState = finalized;
  const candidateTokens = makeTokens(info, pendingState, bytesPerToken);
  const exactFields = tokenFields(info.tokens);
  if (prior && (prior.quality ?? "exact") === "exact" && prior.tokens.reasoning > 0 && exactFields.reasoning === undefined) return false;
  const quality = exactFields.output !== undefined && exactFields.input !== undefined && (exactFields.reasoning !== undefined || candidateTokens.reasoning === 0) ? "exact" : "provisional";
  if (prior && (prior.quality ?? "exact") === "exact" && quality === "provisional") return false;
  const state = finalized;
  const tokens = {
    ...(prior?.tokens ?? makeTokens(info, state, bytesPerToken)),
    ...exactFields
  };
  const record = makeHistoryRecord({
    messageID,
    sessionID,
    parentSessionID: parentSessionID(api, sessionID, info, store),
    model: modelName(info) ?? state?.model,
    agent: normalizeAgentName(info.agent) ?? state?.agent ?? (previous?.sessionID === sessionID ? previous.agent : undefined),
    cost: readNumber(info.cost) ?? prior?.cost ?? state?.cost ?? 0,
    tokens,
    samples: calibrateResponseSamples(state ? finalSamples(state) : previous?.samples ?? [], {
      output: tokens.output,
      reasoning: tokens.reasoning
    }),
    state,
    info,
    completedAt: timestamp,
    quality
  });
  if (previous) {
    const firstToken = earliestFirstOutput(record.time.start, record.time.completed ?? timestamp, previous.time.firstToken, record.time.firstToken);
    if (firstToken !== undefined) {
      record.time.firstToken = firstToken;
      record.time.firstContent = firstToken;
    }
    if (previous.time.firstResponse !== undefined) record.time = applyFirstResponseSignal(record.time, {
      timestamp: previous.time.firstResponse,
      source: previous.time.firstResponseSource ?? "content",
      timeSource: previous.time.firstResponseTimeSource ?? "arrival",
      estimated: previous.time.firstResponseEstimated ?? true
    });
    record.time.ttft = timeToFirstToken({
      time: {
        ...record.time,
        ttft: undefined
      }
    });
  }
  record.speed = mergeRecordSpeed(record, prior, observations.taintedMessages.has(messageID) || state && finalSamples(state).length > 0 && !record.speed?.generation ? "invalidated" : "unobserved");
  record.update = update;
  commitRecord(store, record, true);
  completeContentMetadata(observations.metadata, messageID);
  observations.liveAssistantMessages.delete(messageID);
  noteTaskRecord(store, api, record);
  return true;
}
function previousTuiRecord(store, messageID) {
  let selected;
  const consider = (record, source) => {
    if (!record) return;
    const candidate = {
      record,
      quality: record.quality ?? recordQuality(record),
      source,
      order: source === "disk" ? 0 : store.optimisticOrder.get(messageID) ?? 0
    };
    selected = selected ? preferredHistoryLayer(candidate, selected) : candidate;
  };
  consider(store.records.find(record => record.messageID === messageID), "disk");
  consider(store.diskRecords.find(record => record.messageID === messageID), "disk");
  consider(store.optimistic.get(messageID), "optimistic");
  if (!selected) {
    for (const runtime of store.sessionRuntime.values()) {
      consider((runtime.contributions.get(messageID) ?? runtime.completedContributions.get(messageID))?.record, "optimistic");
      const compact = retiredContributions.get(runtime)?.get(messageID);
      if (compact) consider({
        ...compact,
        version: 1,
        messageID,
        quality: "exact",
        samples: []
      }, "optimistic");
    }
  }
  return selected?.record;
}
function flushIdleStates(store, api, sessionID, bytesPerToken, completedAt = Date.now()) {
  let flushed = false;
  const entries = [...store.active.entries()].filter(([, state]) => state.sessionID === sessionID);
  for (const [key, state] of entries) {
    store.active.delete(key);
    if (!state.legacy.hasData && !state.v2.hasData && Object.keys(state.fallbackTokens).length === 0) continue;
    if (state.messageID.startsWith("__pending__:")) continue;
    const tokens = makeTokens(undefined, state, bytesPerToken);
    const record = makeHistoryRecord({
      messageID: state.messageID,
      sessionID,
      parentSessionID: parentSessionID(api, sessionID, undefined, store),
      model: state.model,
      agent: state.agent,
      cost: state.cost ?? 0,
      tokens,
      samples: calibrateResponseSamples(finalSamples(state), {
        output: tokens.output,
        reasoning: tokens.reasoning
      }),
      state,
      completedAt,
      quality: "provisional"
    });
    commitRecord(store, record, false);
    flushed = true;
  }
  if (entries.length > 0) store.bump();
  return flushed;
}
function sessionRunStatus(type, properties, event) {
  const normalizedType = type.toLowerCase();
  if (normalizedType === "session.next.retried") return "retry";
  if (normalizedType === "session.next.step.failed") return "idle";
  if (normalizedType === "session.idle" || normalizedType === "session.error" || normalizedType === "session.abort" || normalizedType === "session.aborted" || normalizedType === "session.cancel" || normalizedType === "session.cancelled" || normalizedType === "session.stop" || normalizedType === "session.stopped" || normalizedType === "session.completed") return "idle";
  if (normalizedType !== "session.status" && !normalizedType.endsWith(".status")) return undefined;
  const value = properties.status ?? properties.state ?? event.status ?? getPath(properties, "info.status") ?? getPath(properties, "info.state") ?? getPath(event, "info.status") ?? getPath(event, "info.state");
  const name = statusName(value)?.toLowerCase();
  if (name === "busy" || name === "retry") return name;
  if (terminalStatus(value)) return "idle";
  return undefined;
}
function isSessionLifecycleEventType(type) {
  const normalizedType = type.toLowerCase();
  return normalizedType === "session.idle" || normalizedType === "session.status" || normalizedType === "session.next.retried" || normalizedType === "session.next.step.failed" || normalizedType === "session.error" || normalizedType === "session.abort" || normalizedType === "session.aborted" || normalizedType === "session.cancel" || normalizedType === "session.cancelled" || normalizedType === "session.stop" || normalizedType === "session.stopped" || normalizedType === "session.completed";
}
function finishSessionRun(store, api, sessionID, bytesPerToken, completedAt) {
  const runtime = getSessionRuntime(store, sessionID);
  if (!sessionLifecycleFactBelongsToCurrentEpoch(runtime, completedAt)) return false;
  const hadActive = [...store.active.values()].some(state => state.sessionID === sessionID);
  const wasRunning = runtime.status !== "idle" || hadActive;
  const flushed = flushIdleStates(store, api, sessionID, bytesPerToken, completedAt);
  const frozen = wasRunning ? freezeSessionRun(runtime, completedAt) : undefined;
  runtime.status = "idle";
  runtime.activeMessageID = undefined;
  if (hadActive || flushed || frozen !== undefined || wasRunning) {
    store.bump();
    return true;
  }
  return false;
}
function sessionLifecycleFactBelongsToCurrentEpoch(runtime, timestamp) {
  const previousCompletion = runtime.lastRunSummary?.completedAt;
  return previousCompletion === undefined || timestamp >= previousCompletion;
}
export function handleSessionLifecycle(store, api, type, properties, event, bytesPerToken) {
  const sessionID = readSessionID(properties, event);
  if (!sessionID || !scopeEligible(store, sessionID) || isReplayEvent(event, properties)) return false;
  recordTuiObservationLifecycle(store, type, properties, event);
  const status = sessionRunStatus(type, properties, event);
  if (!sessionID || status === undefined) return false;
  const timestamp = eventTimestamp(event, properties);
  if (status !== "idle" && timestamp < observationRuntime(store).observedSince) return false;
  const eventParent = sessionParentFromEvent(type, properties, event);
  if (eventParent) rememberSessionParent(store, sessionID, eventParent);
  const rootSessionID = rootSessionIDFor(store, api, sessionID);
  if (!scopeEligible(store, sessionID)) return false;
  const activity = tuiActivity(store);
  const executionID = readString(event.executionID ?? properties.executionID);
  const runtime = getSessionRuntime(store, sessionID);
  const refinesPartial = status !== "idle" && executionID && !executionID.startsWith("partial:") && activity.currentExecutions.get(sessionID)?.startsWith("partial:");
  const fresh = timestamp >= (runtime.runStartedAt ?? -Infinity) || Boolean(refinesPartial);
  if (!recordTuiActivityFact(store, {
    kind: "lifecycle",
    sessionID,
    timestamp,
    state: status,
    ...(executionID ? {
      executionID
    } : {}),
    parentSessionID: store.sessionParents.get(sessionID)
  }, event)) return false;
  if (status !== "idle" && fresh && executionID) activity.currentExecutions.set(sessionID, executionID);
  if (refinesPartial) runtime.runStartedAt = Math.min(runtime.runStartedAt ?? timestamp, timestamp);
  const current = fresh && (!executionID || !activity.currentExecutions.has(sessionID) || activity.currentExecutions.get(sessionID) === executionID);
  const run = getTaskWallRun(store, rootSessionID);
  if (current) run.lastActivityAt.set(sessionID, timestamp);
  if (status === "idle" && current) {
    const changed = finishSessionRun(store, api, sessionID, bytesPerToken, timestamp);
    run.activeSessions.delete(sessionID);
    if (!tuiActivityTimes(store, rootSessionID, timestamp).active) {
      run.phase = "idle";
      run.lastRunWallTime = {
        runEpoch: run.runEpoch,
        startedAt: run.runStartedAt ?? timestamp,
        completedAt: timestamp,
        wallTime: tuiActivityTimes(store, rootSessionID, timestamp).includingMilliseconds
      };
    }
    store.bump();
    return changed;
  }
  if (status !== "idle" && current && sessionLifecycleFactBelongsToCurrentEpoch(runtime, timestamp)) {
    const previousObservation = activity.runtimeEpochs.get(sessionID);
    if (previousObservation && previousObservation !== activity.instanceID) startSessionRun(runtime, timestamp, status);
    activity.runtimeEpochs.set(sessionID, activity.instanceID);
    transitionSessionRuntime(runtime, status, timestamp);
    if (run.phase === "idle") {
      run.runEpoch++;
      run.runStartedAt = timestamp;
    }
    run.phase = "active";
    run.activeSessions.add(sessionID);
  }
  store.bump();
  return status === "idle";
}
export function mergeHistoryLayers(diskRecords, optimistic, maxRecords, optimisticQuality, optimisticOrder) {
  const byMessage = new Map();
  for (const record of diskRecords) {
    const candidate = {
      record,
      quality: diskRecordQuality(record),
      source: "disk",
      order: 0
    };
    const existing = byMessage.get(record.messageID);
    byMessage.set(record.messageID, existing ? preferredHistoryLayer(candidate, existing) : candidate);
  }
  for (const [messageID, record] of optimistic) {
    const candidate = {
      record,
      quality: optimisticQuality?.get(messageID) ?? recordQualityByObject.get(record) ?? "exact",
      source: "optimistic",
      order: optimisticOrder?.get(messageID) ?? 0
    };
    const existing = byMessage.get(messageID);
    byMessage.set(messageID, existing ? preferredHistoryLayer(candidate, existing) : candidate);
  }
  return [...byMessage.values()].map(candidate => candidate.record).slice(-maxRecords);
}
export function classifyTokenFields(value) {
  return tokenFields(value);
}
function tokenCountsEqual(left, right) {
  return left.input === right.input && left.output === right.output && left.reasoning === right.reasoning && left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite;
}
export function historyRecordsEquivalent(left, right) {
  return left.messageID === right.messageID && left.sessionID === right.sessionID && left.parentSessionID === right.parentSessionID && left.model === right.model && normalizeAgentName(left.agent) === normalizeAgentName(right.agent) && left.cost === right.cost && tokenCountsEqual(left.tokens, right.tokens) && left.time.start === right.time.start && left.time.firstToken === right.time.firstToken && left.time.firstContent === right.time.firstContent && left.time.firstResponse === right.time.firstResponse && left.time.firstResponseSource === right.time.firstResponseSource && left.time.firstResponseTimeSource === right.time.firstResponseTimeSource && left.time.firstResponseEstimated === right.time.firstResponseEstimated && left.time.completed === right.time.completed && left.time.ttft === right.time.ttft && left.time.duration === right.time.duration && (left.quality ?? "exact") === (right.quality ?? "exact") && sameSpeedContribution(left.speed, right.speed) && JSON.stringify(coerceCompletionUpdate(left.update)) === JSON.stringify(coerceCompletionUpdate(right.update));
}
function recordCompletedAt(record) {
  return record.time.completed ?? record.time.start;
}
function recordQuality(record) {
  return recordQualityByObject.get(record) ?? "exact";
}
function diskRecordQuality(record) {
  if (record.quality === "provisional" || record.quality === "exact") return record.quality;
  // HistoryRecord predates the in-memory quality marker. A persisted record
  // with timing/sample calibration is treated as complete; older snapshots
  // without that evidence remain provisional.
  return record.time.firstToken !== undefined || record.time.ttft !== undefined || record.samples.length > 0 ? "exact" : "provisional";
}
function removeOptimisticRecord(store, messageID) {
  store.optimistic.delete(messageID);
  store.optimisticQuality.delete(messageID);
  store.optimisticOrder.delete(messageID);
}

/** A canonical reversible contribution retires a full response even after its
 * history row has been trimmed. Compact ID/revision/scope evidence stays in totals. */
export function retireCanonicalResponses(store) {
  const confirmed = (id, record) => {
    if (record && !scopeEligible(store, record.sessionID, id)) return true;
    const snapshot = ownValue(store.totalsLedger.open, id) ?? ownValue(store.totalsLedger.settled, id);
    if (!snapshot || snapshot !== true && snapshot.quality !== "exact") return false;
    if (snapshot === true || snapshot.excluded || !record) return true;
    const next = coerceCompletionUpdate(snapshot.update);
    const previous = coerceCompletionUpdate(record.update);
    return next && previous ? next.fingerprint === previous.fingerprint || isNewerCompletionUpdate(next, previous) : tokenCountsEqual(snapshot.tokens, record.tokens) && snapshot.cost === record.cost;
  };
  for (const [id, record] of store.optimistic) if (confirmed(id, record)) removeOptimisticRecord(store, id);
  for (const [id, state] of store.active) if (confirmed(id)) {
    finalizeResponse(store, id, state.sessionID, state.responseEpoch, {
      authoritative: true
    });
  }
  for (const runtime of store.sessionRuntime.values()) {
    for (const source of [runtime.contributions, runtime.completedContributions]) {
      for (const [id, contribution] of source) if (confirmed(id, contribution.record)) {
        let compact = retiredContributions.get(runtime);
        if (!compact) {
          compact = new Map();
          retiredContributions.set(runtime, compact);
        }
        compact.set(id, compactContribution(contribution.record, contribution.runEpoch));
        source.delete(id);
        completeContentMetadata(observationRuntime(store).metadata, id);
      }
    }
  }
  retireContentMetadata(observationRuntime(store).metadata, new Set(store.active.keys()));
  for (const [id, last] of store.lastCompletedBySession) if (confirmed(last.record.messageID, last.record) && last.record.samples.length) {
    store.lastCompletedBySession.set(id, {
      ...last,
      record: {
        ...last.record,
        samples: []
      }
    });
  }
}
export function hydrateHistoryState(store, diskRecords) {
  for (const record of diskRecords) {
    if (record.time.completed !== undefined && record.quality !== "provisional") finalizeResponse(store, record.messageID, record.sessionID, store.active.get(record.messageID)?.responseEpoch, {
      completedAt: record.time.completed,
      authoritative: true
    });
    if (!scopeEligible(store, record.sessionID, record.messageID) || scopedRecords(store, [record]).length === 0) continue;
    const overlay = store.optimistic.get(record.messageID);
    let selected = record;
    if (overlay) {
      const overlayQuality = store.optimisticQuality.get(record.messageID) ?? recordQualityByObject.get(overlay) ?? "provisional";
      const preferred = preferredHistoryLayer({
        record,
        quality: diskRecordQuality(record),
        source: "disk",
        order: 0
      }, {
        record: overlay,
        quality: overlayQuality,
        source: "optimistic",
        order: store.optimisticOrder.get(record.messageID) ?? 0
      });
      selected = preferred.record;
      if (preferred.source === "optimistic") {
        const overlay = preferred.record;
        store.optimistic.set(record.messageID, overlay);
        if (overlayQuality === "exact") store.completedMessageIDs.add(record.messageID);
        const existing = store.lastCompletedBySession.get(overlay.sessionID);
        if (overlayQuality === "exact" && (existing === undefined || recordCompletedAt(overlay) >= recordCompletedAt(existing.record))) {
          const runtime = store.sessionRuntime.get(overlay.sessionID);
          store.lastCompletedBySession.set(overlay.sessionID, makeLastCompletedSnapshot(overlay, runtime?.runEpoch ?? 0));
        }
        store.completedMessageIDs.add(overlay.messageID);
        const overlayRuntime = store.sessionRuntime.get(overlay.sessionID);
        if (overlayRuntime?.contributions.has(overlay.messageID)) {
          applyRecordToSessionRuntime(overlayRuntime, overlay, "exact");
        }
        continue;
      }
      if (preferred.record !== record) {
        // Disk has confirmed canonical usage but still lacks observed identity.
        // Retain that metadata on the confirmed snapshot until disk catches up.
        store.optimistic.set(record.messageID, selected);
        store.optimisticQuality.set(record.messageID, diskRecordQuality(record));
      } else removeOptimisticRecord(store, record.messageID);
    }
    store.completedMessageIDs.add(record.messageID);
    const runtime = store.sessionRuntime.get(record.sessionID);
    if (runtime?.contributions.has(record.messageID)) {
      applyRecordToSessionRuntime(runtime, selected, "exact");
    }
    const existing = store.lastCompletedBySession.get(record.sessionID);
    if (existing === undefined || recordCompletedAt(record) >= recordCompletedAt(existing.record)) {
      store.lastCompletedBySession.set(record.sessionID, makeLastCompletedSnapshot(selected, runtime?.runEpoch ?? 0));
    }
  }
  retireCanonicalResponses(store);
}
const sourceSnapshots = new WeakMap();
function snapshotsFor(store) {
  let value = sourceSnapshots.get(store);
  if (!value) {
    value = {
      history: new Map(),
      totals: new Map(),
      runs: new Map(),
      runPaths: [],
      outcomes: new Map()
    };
    sourceSnapshots.set(store, value);
  }
  return value;
}
function physicalPaths(paths) {
  return [...new Set((typeof paths === "string" ? [paths] : paths).map(path => resolve(path)))];
}
export async function reloadHistory(store, api, path, totalsPath, maxRecords, generation = store.historyGeneration) {
  if (store.disposed) return;
  const sourceEpoch = store.sourceEpoch;
  const snapshots = snapshotsFor(store);
  const histories = physicalPaths(path),
    totals = physicalPaths(totalsPath);
  let diskRecords;
  let historyChanged = false;
  for (const file of histories) {
    try {
      const records = parseHistoryJsonl(await readLedgerText(file));
      if (store.disposed || sourceEpoch !== store.sourceEpoch) return;
      for (const record of records) {
        if (record.time.completed !== undefined && record.quality !== "provisional") {
          finalizeResponse(store, record.messageID, record.sessionID, store.active.get(record.messageID)?.responseEpoch, {
            completedAt: record.time.completed,
            authoritative: true
          });
        }
      }
      if (generation !== store.historyGeneration) return;
      snapshots.history.set(file, records);
      historyChanged = true;
      sourceReadResult(store, "history", "loaded", file);
    } catch (error) {
      if (store.disposed || sourceEpoch !== store.sourceEpoch) return;
      if (generation === store.historyGeneration) {
        sourceReadError(store, "history", error, file);
        if (!isNodeError(error) || error.code !== "ENOENT") warnWithToast(api, "history read failed", error);
      }
    }
  }
  if (store.disposed || sourceEpoch !== store.sourceEpoch) return;
  if (generation !== store.historyGeneration) return;
  if (historyChanged) {
    const multipleSources = histories.length > 1;
    diskRecords = mergeHistoryLayers(histories.flatMap(file => snapshots.history.get(file) ?? []), new Map(), multipleSources ? Number.MAX_SAFE_INTEGER : maxRecords);
    // Cross-file windows use time order; live optimistic admission order stays intact.
    if (multipleSources) diskRecords = diskRecords.sort((left, right) => (left.time.completed ?? left.time.start) - (right.time.completed ?? right.time.start) || left.messageID.localeCompare(right.messageID)).slice(-maxRecords);
  }
  let totalsLedger;
  let totalsChanged = false;
  for (const file of totals) {
    try {
      const ledger = await readTotalsSnapshot(file);
      if (store.disposed || sourceEpoch !== store.sourceEpoch || generation !== store.historyGeneration) return;
      if (ledger) {
        snapshots.totals.set(file, ledger);
        totalsChanged = true;
      }
      sourceReadResult(store, "totals", ledger ? "loaded" : "missing", file);
    } catch (error) {
      if (store.disposed || sourceEpoch !== store.sourceEpoch || generation !== store.historyGeneration) return;
      sourceReadError(store, "totals", error, file);
      warnWithToast(api, "totals read failed", error);
    }
  }
  if (store.disposed || sourceEpoch !== store.sourceEpoch || generation !== store.historyGeneration) return;
  if (totalsChanged) {
    try {
      totalsLedger = mergeTotalsSources(totals.flatMap(file => {
        const ledger = snapshots.totals.get(file);
        return ledger ? [ledger] : [];
      }));
      snapshots.outcomes.delete("totals:union");
      const last = totals[totals.length - 1];
      if (last) sourceReadResult(store, "totals", snapshots.outcomes.get(`totals:${last}`).result, last);
    } catch (error) {
      sourceReadError(store, "totals", error, "union");
      warnWithToast(api, "totals sources cannot be combined", error);
    }
  }
  if (totalsLedger) {
    store.totalsLedger = totalsLedger;
  }
  // Each successful ledger remains independently useful. A failed history read
  // cannot block fresh totals, and a missing/failed totals read cannot erase the
  // same source's cumulative snapshot or its history detail window.
  if (diskRecords === undefined && !totalsLedger) return;
  store.diskRecords = (diskRecords ?? store.diskRecords).map(record => withCanonicalLedgerSpeed(store.totalsLedger, record));
  tuiReadModel(store).syncScopes();
  store.sourceScopes = createScopeRegistry(collectSessionScopeEvidence(store.diskRecords, tuiReadModel(store).scopes));
  for (const [id, record] of store.optimistic) {
    store.optimistic.set(id, withCanonicalLedgerSpeed(store.totalsLedger, record));
  }
  for (const [sessionID, last] of store.lastCompletedBySession) {
    const record = withCanonicalLedgerSpeed(store.totalsLedger, last.record);
    if (record !== last.record) store.lastCompletedBySession.set(sessionID, makeLastCompletedSnapshot(record, last.runEpoch));
  }
  repairKnownParents(store);
  hydrateHistoryState(store, store.diskRecords);
  store.records = scopedRecords(store, mergeHistoryLayers(store.diskRecords, store.optimistic, maxRecords, store.optimisticQuality, store.optimisticOrder));
  refreshScopeProjection(store);
}
export async function reloadActivity(store, api, path, generation = store.activityGeneration) {
  if (store.disposed) return false;
  const sourceEpoch = store.sourceEpoch;
  const value = tuiActivity(store),
    selection = value.selection;
  const token = ++selection.readToken;
  selection.retryNeeded = false;
  const model = tuiReadModel(store);
  model.bindProof(api[parentProofPort]);
  const snapshots = snapshotsFor(store),
    paths = physicalPaths(path);
  try {
    const reads = await Promise.all(paths.map(async file => {
      try {
        return {
          file,
          delta: await readActivityDelta(file, snapshots.runs.get(file)?.cursor)
        };
      } catch (error) {
        return {
          file,
          error
        };
      }
    }));
    if (store.disposed || sourceEpoch !== store.sourceEpoch || generation !== store.activityGeneration || token !== selection.readToken) {
      selection.counters.staleReads++;
      return false;
    }
    let reset = JSON.stringify(paths) !== JSON.stringify(snapshots.runPaths);
    const added = [];
    let succeeded = false;
    for (const read of reads) {
      if (!read.delta) {
        const error = read.error;
        if (error instanceof Error && /(?:Activity ledger (?:changed|truncated)|Ledger identity changed)/.test(error.message)) {
          selection.retryNeeded = true;
          selection.counters.readRetries++;
        } else {
          sourceReadError(store, "runs", error, read.file);
          warnWithToast(api, "activity read failed", error);
        }
        continue;
      }
      const delta = read.delta;
      if (!delta.cursor) {
        sourceReadResult(store, "runs", "missing", read.file);
        continue;
      }
      succeeded = true;
      sourceReadResult(store, "runs", "loaded", read.file);
      if (delta.mode === "unchanged") continue;
      if (delta.mode === "reset") {
        reset = true;
        snapshots.runs.set(read.file, {
          cursor: delta.cursor,
          events: Array.from(delta.events)
        });
      } else {
        const snapshot = snapshots.runs.get(read.file);
        snapshot.events.push(...delta.events);
        snapshot.cursor = delta.cursor;
      }
      added.push(...delta.events);
    }
    if (!succeeded) return false;
    if (!reset && !added.length) return !selection.retryNeeded;
    const events = reset ? [...new Map(paths.flatMap(file => snapshots.runs.get(file)?.events ?? []).map(fact => [JSON.stringify(fact), fact])).values()] : added;
    model.canonicalParents(events, reset);
    let accepted;
    if (reset) {
      store.activityEvents = events;
      value.canonical = store.activityEvents;
      selection.counters.canonicalArrayCopies += events.length;
      selection.reset(events);
      accepted = events;
    } else {
      selection.patch();
      accepted = selection.addCanonical(events);
      for (const fact of accepted) store.activityEvents.push(fact);
    }
    selection.patch();
    store.activityGeneration = generation;
    // Legacy facts have no SDK identity. Only a complete chain observed during
    // this observation can confirm a legacy overlay; V2 uses execution/source IDs.
    for (const sessionID of value.candidates) {
      if (!scopeEligible(store, sessionID) || value.currentExecutions.has(sessionID)) continue;
      const rootID = activityRootSessionID(store, sessionID);
      const run = findTaskWallRun(store, rootID, sessionID);
      if (!run || run.phase !== "active" || run.runStartedAt === undefined) continue;
      const lastActive = run.lastActivityAt.get(sessionID) ?? run.runStartedAt;
      for (const summary of selection.legacy.get(sessionID)?.values() ?? []) {
        const terminal = summary.latest;
        if (!terminal || terminal.kind !== "lifecycle" || summary.stable || terminal.state === "busy" || terminal.state === "retry" || terminal.timestamp < lastActive || terminal.observedAt < observationRuntime(store).observedSince) continue;
        if (!summary.earliestActive || summary.earliestActive.timestamp < observationRuntime(store).observedSince || summary.earliestActive.timestamp > lastActive) continue;
        const currentID = ownedMessageID(store, sessionID);
        const current = currentID ? store.active.get(currentID) : undefined;
        if (current?.sessionID === sessionID && observationRuntime(store).liveAssistantMessages.has(current.messageID) && current.startedAt > terminal.timestamp) continue;
        selection.retireLegacy(sessionID, terminal.timestamp);
        finishSessionRun(store, api, sessionID, DEFAULT_BYTES_PER_TOKEN, terminal.timestamp);
        run.lastActivityAt.set(sessionID, terminal.timestamp);
        run.activeSessions.delete(sessionID);
        value.candidates.delete(sessionID);
        if (!tuiActivityTimes(store, rootID, terminal.timestamp).active) {
          run.phase = "idle";
          run.lastRunWallTime = {
            runEpoch: run.runEpoch,
            startedAt: run.runStartedAt ?? terminal.timestamp,
            completedAt: terminal.timestamp,
            wallTime: tuiActivityTimes(store, rootID, terminal.timestamp).includingMilliseconds
          };
        }
        break;
      }
    }
    // Commit the stateless cursor only after all current-generation application.
    snapshots.runPaths = paths;
    selection.cursor = paths.length === 1 ? snapshots.runs.get(paths[0])?.cursor : undefined;
    if (accepted.length || reset) store.bump();
    return !selection.retryNeeded;
  } catch (error) {
    if (store.disposed || sourceEpoch !== store.sourceEpoch || generation !== store.activityGeneration || token !== selection.readToken) {
      selection.counters.staleReads++;
      return false;
    }
    selection.retryNeeded = error instanceof Error && /(?:Activity ledger (?:changed|truncated)|Ledger identity changed)/.test(error.message);
    if (selection.retryNeeded) {
      // Replacement/truncation is retried by the existing reload drain with
      // the previous cursor intact; it is not a user-actionable I/O failure.
      selection.counters.readRetries++;
      return false;
    }
    sourceReadError(store, "runs", error);
    warnWithToast(api, "activity read failed", error);
    return false;
  }
}
export function resolveOptions(value) {
  const options = asRecord(value);
  const maxRecordsValue = readNumber(options?.maxRecords);
  const bytesPerTokenValue = readNumber(options?.bytesPerToken);
  return {
    historyPath: readString(options?.historyPath),
    runsPath: readString(options?.runsPath),
    totalsPath: readString(options?.totalsPath),
    maxRecords: maxRecordsValue !== undefined && maxRecordsValue > 0 ? Math.max(1, Math.floor(maxRecordsValue)) : DEFAULT_MAX_RECORDS,
    bytesPerToken: bytesPerTokenValue !== undefined && bytesPerTokenValue > 0 ? bytesPerTokenValue : DEFAULT_BYTES_PER_TOKEN,
    enabled: options?.enabled !== false,
    keybinds: resolvePluginKeybinds(options?.keybinds)
  };
}

// Keep native key strings (commas and <leader> included) intact for the host.
function isKeybindValue(value) {
  if (value === false || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(item => !Array.isArray(item) && item !== false && isKeybindValue(item));
  const item = asRecord(value);
  if (!item) return false;
  if (typeof item.name === "string") {
    return ["ctrl", "shift", "meta", "alt", "option", "super", "hyper"].every(flag => item[flag] === undefined || typeof item[flag] === "boolean");
  }
  return typeof item.key === "string" || isRecord(item.key) && typeof item.key.name === "string" && isKeybindValue(item.key);
}
function resolvePluginKeybinds(value) {
  const input = asRecord(value);
  if (!input) return undefined;
  const result = {};
  for (const name of [COMMAND_NAME, DETAILS_COMMAND_NAME]) {
    if (isKeybindValue(input[name])) result[name] = input[name];
  }
  return result;
}
export function tokenPulseBindings(options) {
  const config = {
    [COMMAND_NAME]: "ctrl+shift+t",
    [DETAILS_COMMAND_NAME]: "ctrl+shift+y",
    ...options.keybinds
  };
  // These two commands only need native keys/Binding objects, not V1's runtime
  // keymap package (which the V2 host no longer resolves).
  return [COMMAND_NAME, DETAILS_COMMAND_NAME].flatMap(cmd => {
    const value = config[cmd];
    if (value === false || value === "none") return [];
    const items = Array.isArray(value) ? value : [value];
    return items.filter(item => item !== "none" && item !== undefined).map(item => {
      const binding = asRecord(item);
      return binding && "key" in binding ? {
        ...binding,
        cmd
      } : {
        key: item,
        cmd
      };
    });
  });
}
export function resolveHistoryPath(api, configuredPath) {
  const base = api.state.path.worktree && api.state.path.worktree !== "/" ? api.state.path.worktree : api.state.path.directory;
  const relativeOrAbsolute = configuredPath && configuredPath.trim().length > 0 ? configuredPath : DEFAULT_HISTORY_PATH;
  return isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : join(base, relativeOrAbsolute);
}
export function createRuntimeStore(maxRecords, observedSince = Date.now()) {
  return createRoot(disposeSignals => {
    const [revision, setRevision] = createSignal(0);
    const [clockRevision, setClockRevision] = createSignal(0);
    const store = {
      sourceEpoch: 0,
      sourceState: {
        status: "waiting-metadata",
        epoch: 0,
        live: false
      },
      maxRecords,
      diskRecords: [],
      records: [],
      optimistic: new RevisionMap(),
      optimisticQuality: new Map(),
      optimisticOrder: new Map(),
      nextOptimisticOrder: 1,
      active: new Map(),
      completedMessageIDs: new Set(),
      sessionRuntime: new Map(),
      taskRuns: new Map(),
      sessionParents: new Map(),
      sourceScopes: createScopeRegistry(),
      messageScopes: new Map(),
      totalsLedger: emptyTotalsLedger(),
      lastCompletedBySession: new Map(),
      activityEvents: [],
      activityGeneration: 0,
      pulseExpanded: false,
      historyGeneration: 0,
      revision,
      clockRevision,
      tick: () => setClockRevision(value => value + 1),
      bump: () => setRevision(value => value + 1),
      disposed: false,
      disposeSignals
    };
    observationRuntime(store).observedSince = observedSince;
    return store;
  });
}
function once(dispose) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
}
function shortTail(value, maxLength = 12) {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  return `...${value.slice(-(maxLength - 3))}`;
}
function truncateMiddle(value, maxLength) {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const left = Math.ceil((maxLength - 3) / 2);
  const right = maxLength - 3 - left;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}
function generatedTokens(tokens) {
  return tokens.output + tokens.reasoning;
}
export function totalTokens(tokens) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning;
}
function recordsWithKnownParents(records, store) {
  if (!store || store.sessionParents.size === 0) return [...records];
  return records.map(record => rewriteRecordParent(record, store.sessionParents.get(record.sessionID)));
}
export function cacheHitRate(tokens) {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined;
  const rate = tokens.cacheRead / denominator;
  return Number.isFinite(rate) ? rate : undefined;
}
export function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1000) return `${sign}${Math.round(absolute)}`;
  const units = ["k", "M", "B"];
  let scaled = absolute;
  let unitIndex = -1;
  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? scaled >= 100 ? 0 : 1 : 1;
  const divisors = [1_000, 1_000_000, 1_000_000_000];
  const rendered = formatScaledUnit(absolute, divisors[unitIndex] ?? 1_000, decimals, unitIndex === 0);
  return `${sign}${rendered}${units[unitIndex]}`;
}
function formatFullNumber(value) {
  return (Number.isFinite(value) ? value : 0).toLocaleString("en-US", {
    maximumFractionDigits: 20
  });
}
function formatScaledUnit(absolute, divisor, decimals, trimTrailingZero) {
  let rendered;
  if (decimals <= 0) {
    rendered = String(Math.round(absolute / divisor));
  } else {
    const factor = 10 ** decimals;
    const rounded = Math.round(absolute / (divisor / factor));
    const whole = Math.trunc(rounded / factor);
    const fraction = Math.abs(rounded % factor);
    rendered = `${whole}.${String(fraction).padStart(decimals, "0")}`;
  }
  if (trimTrailingZero) rendered = rendered.replace(/\.0$/, "");
  return rendered;
}
export function formatCacheHitRate(rate) {
  if (rate === undefined || !Number.isFinite(rate)) return "--";
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}
export function formatPulseMetrics(tokens, width = Number.POSITIVE_INFINITY, taskTimeMs) {
  const timeLabel = taskTimeMs !== undefined && Number.isFinite(taskTimeMs) && taskTimeMs >= 0 ? formatDuration(taskTimeMs).replace(/\s+/g, "") : "--";
  const fields = [`${formatFullNumber(totalTokens(tokens))} total`, `cache ${formatCacheHitRate(cacheHitRate(tokens))}`, `time ${timeLabel}`];
  return wrapMetricFields(fields, width);
}
function wrapMetricFields(fields, width) {
  const lines = [];
  for (const field of fields) {
    const previous = lines[lines.length - 1];
    if (previous !== undefined && previous.length + 3 + field.length <= width) {
      lines[lines.length - 1] = `${previous} · ${field}`;
    } else lines.push(field);
  }
  return lines.join("\n");
}
export function formatPulseSummary(tokens) {
  return `+ Token Pulse  ${formatPulseMetrics(tokens)}`;
}
function formatCost(value) {
  return `$${formatNumber(value, 4)}`;
}
function formatTime(timestamp) {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toISOString().slice(11, 19);
}
function padRight(value, width) {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}
function padLeft(value, width) {
  return value.length >= width ? value.slice(-width) : value.padStart(width, " ");
}
export function formatHistoryRow(record) {
  return [padRight(formatTime(record.time.completed ?? record.time.start), 8), padRight(shortTail(record.sessionID, 11), 11), padRight(truncateMiddle(record.model, 14), 14), padLeft(`${formatFullNumber(record.tokens.output)}/${formatFullNumber(record.tokens.reasoning)}`, 9), padLeft(formatCost(record.cost), 9)].join(" ");
}
function summaryLines(label, tokens, cost, responseCount) {
  return [label, `  Total tokens (input + generated + cache) ${formatFullNumber(totalTokens(tokens))}`, `  Uncached input ${formatFullNumber(tokens.input)}  Cache read (reused) ${formatFullNumber(tokens.cacheRead)}`, `  Cache hit rate ${formatCacheHitRate(cacheHitRate(tokens))}`, `  Cache write ${formatFullNumber(tokens.cacheWrite)}  Visible output ${formatFullNumber(tokens.output)}`, `  Reasoning ${formatFullNumber(tokens.reasoning)}  Generated (output + reasoning) ${formatFullNumber(generatedTokens(tokens))}`, `  Model calls ${formatFullNumber(responseCount)}  Estimated cost ${formatCost(cost)}`];
}
function emptySummaryLines() {
  const empty = emptyTokenCounts();
  return [...summaryLines("Session only", empty, 0, 0), ...summaryLines("Including subagents", empty, 0, 0), "No completed responses yet"];
}

// Presentation only: a missing ledger is not an empty, successfully read ledger.
function sourcePartAvailable(store, part) {
  const source = store.sourceState;
  // Same-source refresh failures retain successful reads, including valid zero
  // snapshots. An omitted part in an explicit loaded map is still unknown.
  return source.loaded ? source.loaded[part] === true : source.status === "ready";
}
export function sourceStatusLabel(store) {
  const source = store.sourceState;
  if (source.status === "ready") return undefined;
  if (source.status === "partial") return `Historical session metadata unavailable (${source.unavailableSessions?.length ?? 0}) · showing known ledger data`;
  if (source.status === "waiting-metadata") return "Waiting for session metadata";
  if (source.status === "loading") return Object.values(source.loaded ?? {}).some(Boolean) ? "Refreshing Token Pulse data" : "Loading Token Pulse data";
  const labels = {
    history: "history",
    totals: "totals",
    runs: "task time",
    metadata: "session metadata"
  };
  const failed = Object.keys(labels).filter(part => source.errors?.[part] || part !== "metadata" && source.paths && source.missing?.includes(source.paths[part]));
  if (failed.some(part => part !== "metadata" && source.loaded?.[part])) {
    return `Unable to refresh: ${failed.map(part => labels[part]).join(", ")} · showing last known data`;
  }
  return `${source.status === "error" ? "Unable to read" : "Missing ledger"}: ${failed.map(part => labels[part]).join(", ") || "Token Pulse data"}`;
}
function usageIsKnown(store, totals, sessionID) {
  return sourcePartAvailable(store, "totals") || totalsHaveUsage(totals) || !!sessionID && ownValue(store.totalsLedger.sessions, sessionID) !== undefined;
}
function pulseMetricRows(tokens, cost, responseCount, known = true) {
  const metrics = [{
    label: "Total tokens (input + generated + cache)",
    value: formatFullNumber(totalTokens(tokens))
  }, {
    label: "Uncached input",
    value: formatFullNumber(tokens.input)
  }, {
    label: "Cache read (reused)",
    value: formatFullNumber(tokens.cacheRead)
  }, {
    label: "Cache hit rate",
    value: formatCacheHitRate(cacheHitRate(tokens))
  }, {
    label: "Cache write",
    value: formatFullNumber(tokens.cacheWrite)
  }, {
    label: "Visible output",
    value: formatFullNumber(tokens.output)
  }, {
    label: "Reasoning",
    value: formatFullNumber(tokens.reasoning)
  }, {
    label: "Generated",
    value: formatFullNumber(generatedTokens(tokens))
  }, {
    label: "Model calls",
    value: formatFullNumber(responseCount)
  }, {
    label: "Estimated cost",
    value: formatCost(cost)
  }];
  return known ? metrics : metrics.map(metric => ({
    ...metric,
    value: "--"
  }));
}
function PulseMetricGrid(props) {
  return (() => {
    var _el$ = _$createElement("box");
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$insert(_el$, () => props.rows.map(row => (() => {
      var _el$2 = _$createElement("box");
      _$setProp(_el$2, "flexDirection", "row");
      _$setProp(_el$2, "width", "100%");
      _$setProp(_el$2, "columnGap", 1);
      _$insert(_el$2, () => row.map(metric => (() => {
        var _el$3 = _$createElement("box"),
          _el$4 = _$createElement("text"),
          _el$5 = _$createElement("text");
        _$insertNode(_el$3, _el$4);
        _$insertNode(_el$3, _el$5);
        _$setProp(_el$3, "flexDirection", "column");
        _$setProp(_el$3, "flexBasis", 0);
        _$setProp(_el$3, "flexGrow", 1);
        _$setProp(_el$3, "minWidth", 0);
        _$setProp(_el$4, "wrapMode", "word");
        _$insert(_el$4, () => metric.label);
        _$setProp(_el$5, "wrapMode", "word");
        _$insert(_el$5, () => metric.value);
        _$effect(_p$ => {
          var _v$ = props.theme.current.textMuted,
            _v$2 = props.theme.current.text;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$4, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$3;
      })()));
      return _el$2;
    })()));
    return _el$;
  })();
}
function PulseSection(props) {
  const metrics = createMemo(() => pulseMetricRows(props.section.tokens, props.section.cost, props.section.responseCount, props.known ?? true));
  return (() => {
    var _el$6 = _$createElement("box"),
      _el$7 = _$createElement("text");
    _$insertNode(_el$6, _el$7);
    _$setProp(_el$6, "flexDirection", "column");
    _$setProp(_el$6, "width", "100%");
    _$setProp(_el$6, "paddingTop", 1);
    _$setProp(_el$7, "wrapMode", "word");
    _$setProp(_el$7, "flexShrink", 0);
    _$insert(_el$7, () => props.section.label);
    _$insert(_el$6, _$createComponent(PulseMetricGrid, {
      get theme() {
        return props.theme;
      },
      get rows() {
        return [[metrics()[0]], [metrics()[1], metrics()[2]], [metrics()[3], metrics()[4]], [metrics()[5], metrics()[6]], [metrics()[7], metrics()[8]], [metrics()[9]]];
      }
    }), null);
    _$effect(_$p => _$setProp(_el$7, "fg", props.theme.current.accent, _$p));
    return _el$6;
  })();
}
function ChildAgentRows(props) {
  return (() => {
    var _el$8 = _$createElement("box"),
      _el$9 = _$createElement("text");
    _$insertNode(_el$8, _el$9);
    _$setProp(_el$8, "flexDirection", "column");
    _$setProp(_el$8, "width", "100%");
    _$setProp(_el$8, "paddingTop", 1);
    _$insertNode(_el$9, _$createTextNode(`CHILD AGENTS`));
    _$setProp(_el$9, "truncate", true);
    _$setProp(_el$9, "wrapMode", "none");
    _$insert(_el$8, () => props.rows.map(row => (() => {
      var _el$1 = _$createElement("box"),
        _el$10 = _$createElement("text"),
        _el$11 = _$createElement("text");
      _$insertNode(_el$1, _el$10);
      _$insertNode(_el$1, _el$11);
      _$setProp(_el$1, "flexDirection", "column");
      _$setProp(_el$1, "width", "100%");
      _$setProp(_el$1, "paddingTop", 1);
      _$setProp(_el$1, "paddingLeft", 1);
      _$setProp(_el$1, "border", ["left"]);
      _$insert(_el$1, (() => {
        var _c$ = _$memo(() => row.agents.length > 0);
        return () => _c$() && (() => {
          var _el$12 = _$createElement("text"),
            _el$13 = _$createElement("b");
          _$insertNode(_el$12, _el$13);
          _$setProp(_el$12, "wrapMode", "word");
          _$setProp(_el$12, "flexShrink", 0);
          _$insert(_el$13, () => `${"  ".repeat(row.depth)}${row.agents.join(" / ")}`);
          _$effect(_$p => _$setProp(_el$12, "fg", props.theme.current.text, _$p));
          return _el$12;
        })();
      })(), _el$10);
      _$setProp(_el$10, "wrapMode", "word");
      _$setProp(_el$10, "flexShrink", 0);
      _$insert(_el$10, () => `${"  ".repeat(row.depth)}${row.sessionID}  ${formatFullNumber(row.responseCount)} responses  ${formatFullNumber(row.generated)} generated  ${formatFullNumber(row.total)} total`);
      _$setProp(_el$11, "wrapMode", "word");
      _$setProp(_el$11, "flexShrink", 0);
      _$insert(_el$11, () => `model ${row.model}`);
      _$effect(_p$ => {
        var _v$3 = props.theme.current.borderSubtle,
          _v$4 = props.theme.current.info,
          _v$5 = props.theme.current.textMuted;
        _v$3 !== _p$.e && (_p$.e = _$setProp(_el$1, "borderColor", _v$3, _p$.e));
        _v$4 !== _p$.t && (_p$.t = _$setProp(_el$10, "fg", _v$4, _p$.t));
        _v$5 !== _p$.a && (_p$.a = _$setProp(_el$11, "fg", _v$5, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$1;
    })()), null);
    _$effect(_$p => _$setProp(_el$9, "fg", props.theme.current.accent, _$p));
    return _el$8;
  })();
}
function aggregateForSession(records, sessionID, store) {
  if (!sessionID) return undefined;
  const repairedRecords = recordsWithKnownParents(records, store);
  const direct = aggregateSession(repairedRecords, sessionID);
  if (direct) return direct;
  const roots = aggregateSessionTree(repairedRecords);
  const children = [];
  const visit = node => {
    if (node.parentSessionID === sessionID) children.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  if (children.length === 0) return undefined;
  let tokens = emptyTokenCounts();
  let cost = 0;
  let responseCount = 0;
  for (const child of children) {
    tokens = addTokenCounts(tokens, child.tokens);
    cost += child.cost;
    responseCount += child.responseCount;
  }
  return {
    sessionID,
    directTokens: emptyTokenCounts(),
    directCost: 0,
    directResponseCount: 0,
    tokens,
    cost,
    responseCount,
    children
  };
}
function recordsForSession(records, sessionID, store) {
  if (!sessionID) return [...records];
  const aggregate = aggregateForSession(records, sessionID, store);
  const repairedRecords = recordsWithKnownParents(records, store);
  if (!aggregate) return repairedRecords.filter(record => record.sessionID === sessionID);
  const ids = new Set();
  const visit = node => {
    ids.add(node.sessionID);
    node.children.forEach(visit);
  };
  visit(aggregate);
  return repairedRecords.filter(record => ids.has(record.sessionID));
}
function recentRecords(records, sessionID, store) {
  return recordsForSession(records, sessionID, store).slice().sort((left, right) => (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start)).slice(0, 24);
}
const TOTALS_TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
export function projectSessionTotals(ledger, records, parentBySessionID, sessionID) {
  const projected = projectTotals(ledger, records, parentBySessionID);
  return rollupSessionTotals(projected.sessions, projected.parents, sessionID, ledger.sessionScopes);
}
function totalsForSession(store, sessionID) {
  if (!sessionID) return undefined;
  return visibleTotalsIndex(store).get(sessionID);
}
const visibleHistory = new WeakMap();
function visibleRecords(store) {
  const cached = visibleHistory.get(store);
  if (cached?.disk === store.diskRecords && cached.window === store.records && cached.order === store.nextOptimisticOrder && cached.size === store.optimistic.size) return cached.records;
  // Details rows remain bounded. Full unconfirmed totals are reconciled per MID
  // by RevisionMap, not re-enumerated/sorted on every visible query.
  const records = mergeHistoryLayers(baseHistoryRecords(store), new Map(), store.maxRecords);
  visibleHistory.set(store, {
    disk: store.diskRecords,
    window: store.records,
    order: store.nextOptimisticOrder,
    size: store.optimistic.size,
    records
  });
  return records;
}
function visibleTotalsIndex(store, input) {
  const model = tuiReadModel(store);
  const records = input && input !== store.records ? input : visibleRecords(store);
  model.historyParents(records);
  return model.totals(records, store.optimistic, windowContributionTerms);
}
export function TokenPulseDetails(props) {
  if (!scopeEligible(props.store, props.sessionID)) return (() => {
    var _el$14 = _$createElement("text");
    _$insertNode(_el$14, _$createTextNode(`Maintenance session excluded`));
    _$effect(_$p => _$setProp(_el$14, "fg", props.api.theme.current.textMuted, _$p));
    return _el$14;
  })();
  const [dimensions, setDimensions] = createSignal({
    width: props.api.renderer.width,
    height: props.api.renderer.height
  });
  const onResize = (width, height) => setDimensions({
    width,
    height
  });
  if (typeof props.api.renderer.on === "function") {
    props.api.renderer.on("resize", onResize);
    onCleanup(() => props.api.renderer.off("resize", onResize));
  }
  // Host Dialog starts at height / 4 and adds one top-padding row. Reserve
  // another bottom row rather than budgeting against the whole terminal.
  const contentHeight = () => Math.max(1, dimensions().height - Math.ceil(dimensions().height / 4) - 2);
  const compact = () => dimensions().height < 24;
  const [selectedID, setSelectedID] = createSignal(props.sessionID);
  let selector;
  let body;
  const tree = createMemo(() => {
    props.store.revision();
    const parents = new Map(props.store.sessionParents);
    const candidates = new Set([props.sessionID, ...Object.keys(props.store.totalsLedger.sessions), ...parents.keys(), ...baseHistoryRecords(props.store).map(record => record.sessionID), ...Array.from(props.store.active.values(), state => state.sessionID)]);
    // Cached metadata only: do not fetch children or wait on the server.
    for (const id of candidates) {
      try {
        const parent = props.api.state.session.get(id)?.parentID;
        if (isParentLink(id, parent)) {
          parents.set(id, parent);
          candidates.add(parent);
        }
      } catch {/* State may still be syncing; keep the known parent map. */}
    }
    return buildSessionDetailsTree(props.store, props.sessionID, parents);
  });
  const details = createMemo(() => selectSessionDetails(tree(), selectedID(), props.store.lastCompletedBySession));
  const sourceLabel = createMemo(() => {
    props.store.revision();
    return sourceStatusLabel(props.store);
  });
  const directKnown = createMemo(() => {
    props.store.revision();
    return usageIsKnown(props.store, details().direct, details().sessionID);
  });
  const includingKnown = createMemo(() => {
    props.store.revision();
    return usageIsKnown(props.store, tree().including, props.sessionID);
  });
  const sessionTitle = id => {
    try {
      return props.api.state.session.get(id)?.title;
    } catch {
      return undefined;
    }
  };
  const options = createMemo(() => tree().nodes.map(node => ({
    name: `${"  ".repeat(Math.min(node.depth, 4))}${sessionTitle(node.sessionID) || shortTail(node.sessionID, 24)}${node.sessionID === props.sessionID ? " (current)" : ""}`,
    description: "",
    value: node.sessionID
  })), undefined, {
    equals: (before, after) => before.length === after.length && before.every((option, index) => option.name === after[index].name && option.value === after[index].value)
  });
  const choose = id => {
    if (typeof id !== "string" || !tree().nodes.some(node => node.sessionID === id)) return;
    if (id === selectedID()) return;
    setSelectedID(id);
    body?.scrollTo(0);
  };
  const theme = props.api.theme.current;
  return (() => {
    var _el$16 = _$createElement("box"),
      _el$17 = _$createElement("text"),
      _el$19 = _$createElement("text"),
      _el$20 = _$createElement("scrollbox"),
      _el$21 = _$createElement("text");
    _$insertNode(_el$16, _el$17);
    _$insertNode(_el$16, _el$19);
    _$insertNode(_el$16, _el$20);
    _$insertNode(_el$16, _el$21);
    _$setProp(_el$16, "flexDirection", "column");
    _$setProp(_el$16, "width", "100%");
    _$setProp(_el$16, "flexShrink", 0);
    _$setProp(_el$16, "overflow", "hidden");
    _$insertNode(_el$17, _$createTextNode(`Token Pulse details`));
    _$setProp(_el$17, "flexShrink", 0);
    _$setProp(_el$19, "flexShrink", 0);
    _$setProp(_el$19, "wrapMode", "word");
    _$insert(_el$19, () => `Scope ${props.sessionID} + descendants`);
    _$insert(_el$16, (() => {
      var _c$2 = _$memo(() => tree().nodes.length > 1);
      return () => _c$2() && (() => {
        var _el$23 = _$createElement("box"),
          _el$24 = _$createElement("text"),
          _el$25 = _$createElement("select"),
          _el$26 = _$createElement("box"),
          _el$27 = _$createElement("text"),
          _el$29 = _$createElement("text"),
          _el$31 = _$createElement("text"),
          _el$33 = _$createElement("text");
        _$insertNode(_el$23, _el$24);
        _$insertNode(_el$23, _el$25);
        _$insertNode(_el$23, _el$26);
        _$setProp(_el$23, "flexDirection", "column");
        _$setProp(_el$23, "flexShrink", 0);
        _$insert(_el$24, () => `SESSION TREE · ${tree().nodes.length} sessions`);
        _$use(node => {
          selector = node;
          onMount(() => node.focus());
        }, _el$25);
        _$setProp(_el$25, "flexShrink", 0);
        _$setProp(_el$25, "showDescription", false);
        _$setProp(_el$25, "showScrollIndicator", true);
        _$setProp(_el$25, "wrapSelection", false);
        _$setProp(_el$25, "itemSpacing", 0);
        _$setProp(_el$25, "onChange", (_index, option) => choose(option?.value));
        _$setProp(_el$25, "onSelect", (_index, option) => {
          choose(option?.value);
          body?.focus();
        });
        _$setProp(_el$25, "onKeyDown", key => {
          if (key.name === "tab") {
            key.preventDefault();
            key.stopPropagation();
            body?.focus();
          }
        });
        _$insertNode(_el$26, _el$27);
        _$insertNode(_el$26, _el$29);
        _$insertNode(_el$26, _el$31);
        _$insertNode(_el$26, _el$33);
        _$setProp(_el$26, "flexDirection", "row");
        _$setProp(_el$26, "height", 1);
        _$setProp(_el$26, "flexShrink", 0);
        _$insertNode(_el$27, _$createTextNode(`[prev]`));
        _$setProp(_el$27, "onMouseDown", () => {
          selector?.focus();
          selector?.moveUp();
        });
        _$insertNode(_el$29, _$createTextNode(` `));
        _$insertNode(_el$31, _$createTextNode(`[next]`));
        _$setProp(_el$31, "onMouseDown", () => {
          selector?.focus();
          selector?.moveDown();
        });
        _$insertNode(_el$33, _$createTextNode(` · ↑/↓ · Enter/Tab`));
        _$effect(_p$ => {
          var _v$12 = theme.accent,
            _v$13 = Math.min(tree().nodes.length, compact() ? 2 : 3),
            _v$14 = options(),
            _v$15 = Math.max(0, tree().nodes.findIndex(node => node.sessionID === details().sessionID)),
            _v$16 = theme.text,
            _v$17 = theme.backgroundPanel,
            _v$18 = theme.backgroundPanel,
            _v$19 = theme.backgroundElement,
            _v$20 = theme.accent,
            _v$21 = theme.accent,
            _v$22 = theme.textMuted,
            _v$23 = theme.accent,
            _v$24 = theme.textMuted;
          _v$12 !== _p$.e && (_p$.e = _$setProp(_el$24, "fg", _v$12, _p$.e));
          _v$13 !== _p$.t && (_p$.t = _$setProp(_el$25, "height", _v$13, _p$.t));
          _v$14 !== _p$.a && (_p$.a = _$setProp(_el$25, "options", _v$14, _p$.a));
          _v$15 !== _p$.o && (_p$.o = _$setProp(_el$25, "selectedIndex", _v$15, _p$.o));
          _v$16 !== _p$.i && (_p$.i = _$setProp(_el$25, "textColor", _v$16, _p$.i));
          _v$17 !== _p$.n && (_p$.n = _$setProp(_el$25, "backgroundColor", _v$17, _p$.n));
          _v$18 !== _p$.s && (_p$.s = _$setProp(_el$25, "focusedBackgroundColor", _v$18, _p$.s));
          _v$19 !== _p$.h && (_p$.h = _$setProp(_el$25, "selectedBackgroundColor", _v$19, _p$.h));
          _v$20 !== _p$.r && (_p$.r = _$setProp(_el$25, "selectedTextColor", _v$20, _p$.r));
          _v$21 !== _p$.d && (_p$.d = _$setProp(_el$27, "fg", _v$21, _p$.d));
          _v$22 !== _p$.l && (_p$.l = _$setProp(_el$29, "fg", _v$22, _p$.l));
          _v$23 !== _p$.u && (_p$.u = _$setProp(_el$31, "fg", _v$23, _p$.u));
          _v$24 !== _p$.c && (_p$.c = _$setProp(_el$33, "fg", _v$24, _p$.c));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined,
          n: undefined,
          s: undefined,
          h: undefined,
          r: undefined,
          d: undefined,
          l: undefined,
          u: undefined,
          c: undefined
        });
        return _el$23;
      })();
    })(), _el$20);
    _$use(scroll => {
      body = scroll;
      onMount(() => {
        if (tree().nodes.length === 1) scroll.focus();
      });
    }, _el$20);
    _$setProp(_el$20, "flexGrow", 1);
    _$setProp(_el$20, "flexShrink", 1);
    _$setProp(_el$20, "minHeight", 0);
    _$setProp(_el$20, "focusable", true);
    _$setProp(_el$20, "scrollY", true);
    _$setProp(_el$20, "scrollX", false);
    _$setProp(_el$20, "viewportOptions", {
      minHeight: 0,
      overflow: "hidden"
    });
    _$setProp(_el$20, "contentOptions", {
      flexDirection: "column",
      flexShrink: 0
    });
    _$setProp(_el$20, "onKeyDown", key => {
      if (key.name === "tab" && selector) {
        key.preventDefault();
        key.stopPropagation();
        selector.focus();
      }
    });
    _$insert(_el$20, (() => {
      var _c$3 = _$memo(() => !!sourceLabel());
      return () => _c$3() && (() => {
        var _el$35 = _$createElement("text");
        _$setProp(_el$35, "wrapMode", "word");
        _$setProp(_el$35, "flexShrink", 0);
        _$insert(_el$35, sourceLabel);
        _$effect(_$p => _$setProp(_el$35, "fg", theme.textMuted, _$p));
        return _el$35;
      })();
    })(), null);
    _$insert(_el$20, (() => {
      var _c$4 = _$memo(() => !!tree().nodes.length);
      return () => _c$4() ? (() => {
        var _el$36 = _$createElement("box"),
          _el$37 = _$createElement("text"),
          _el$39 = _$createElement("text"),
          _el$40 = _$createElement("text");
        _$insertNode(_el$36, _el$37);
        _$insertNode(_el$36, _el$39);
        _$insertNode(_el$36, _el$40);
        _$setProp(_el$36, "flexDirection", "column");
        _$setProp(_el$36, "flexShrink", 0);
        _$setProp(_el$36, "width", "100%");
        _$insertNode(_el$37, _$createTextNode(`SELECTED SESSION · direct only`));
        _$setProp(_el$39, "wrapMode", "word");
        _$insert(_el$39, () => `${sessionTitle(details().sessionID) ? `${sessionTitle(details().sessionID)} · ` : ""}${details().sessionID}`);
        _$insert(_el$36, (() => {
          var _c$5 = _$memo(() => !!(directKnown() && details().direct.responseCount === 0));
          return () => _c$5() && (() => {
            var _el$42 = _$createElement("text");
            _$insertNode(_el$42, _$createTextNode(`No recorded usage for this session`));
            _$setProp(_el$42, "wrapMode", "word");
            _$effect(_$p => _$setProp(_el$42, "fg", theme.textMuted, _$p));
            return _el$42;
          })();
        })(), _el$40);
        _$insertNode(_el$40, _$createTextNode(`SESSION USAGE`));
        _$insert(_el$36, _$createComponent(PulseMetricGrid, {
          get theme() {
            return props.api.theme;
          },
          get rows() {
            return pulseMetricRows(details().direct.tokens, details().direct.cost, details().direct.responseCount, directKnown()).map(metric => [metric]);
          }
        }), null);
        _$insert(_el$36, (() => {
          var _c$6 = _$memo(() => !!details().last?.record.model);
          return () => _c$6() && (() => {
            var _el$44 = _$createElement("text");
            _$setProp(_el$44, "wrapMode", "word");
            _$insert(_el$44, () => `Last model: ${details().last.record.model}`);
            _$effect(_$p => _$setProp(_el$44, "fg", theme.textMuted, _$p));
            return _el$44;
          })();
        })(), null);
        _$insert(_el$36, (() => {
          var _c$7 = _$memo(() => tree().nodes.length > 1);
          return () => _c$7() ? [(() => {
            var _el$45 = _$createElement("text");
            _$insertNode(_el$45, _$createTextNode(`INCLUDING SUBAGENTS · entire scope`));
            _$setProp(_el$45, "paddingTop", 1);
            _$effect(_$p => _$setProp(_el$45, "fg", theme.accent, _$p));
            return _el$45;
          })(), (() => {
            var _el$47 = _$createElement("text");
            _$insertNode(_el$47, _$createTextNode(`Includes every descendant once.`));
            _$setProp(_el$47, "wrapMode", "word");
            _$effect(_$p => _$setProp(_el$47, "fg", theme.textMuted, _$p));
            return _el$47;
          })(), _$createComponent(PulseMetricGrid, {
            get theme() {
              return props.api.theme;
            },
            get rows() {
              return pulseMetricRows(tree().including.tokens, tree().including.cost, tree().including.responseCount, includingKnown()).map(metric => [metric]);
            }
          })] : (() => {
            var _el$49 = _$createElement("text");
            _$insertNode(_el$49, _$createTextNode(`No known subagents in this scope`));
            _$setProp(_el$49, "paddingTop", 1);
            _$setProp(_el$49, "wrapMode", "word");
            _$effect(_$p => _$setProp(_el$49, "fg", theme.textMuted, _$p));
            return _el$49;
          })();
        })(), null);
        _$effect(_p$ => {
          var _v$25 = theme.accent,
            _v$26 = theme.textMuted,
            _v$27 = theme.accent;
          _v$25 !== _p$.e && (_p$.e = _$setProp(_el$37, "fg", _v$25, _p$.e));
          _v$26 !== _p$.t && (_p$.t = _$setProp(_el$39, "fg", _v$26, _p$.t));
          _v$27 !== _p$.a && (_p$.a = _$setProp(_el$40, "fg", _v$27, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$36;
      })() : (() => {
        var _el$51 = _$createElement("text");
        _$insertNode(_el$51, _$createTextNode(`Maintenance session excluded`));
        _$setProp(_el$51, "flexShrink", 0);
        _$effect(_$p => _$setProp(_el$51, "fg", theme.textMuted, _$p));
        return _el$51;
      })();
    })(), null);
    _$insertNode(_el$21, _$createTextNode(`esc / ctrl+c to close`));
    _$setProp(_el$21, "flexShrink", 0);
    _$effect(_p$ => {
      var _v$6 = dimensions().width < 50 ? 1 : 2,
        _v$7 = compact() ? 0 : 1,
        _v$8 = contentHeight(),
        _v$9 = theme.primary,
        _v$0 = theme.textMuted,
        _v$1 = compact() ? 0 : 1,
        _v$10 = theme.textMuted,
        _v$11 = compact() ? 0 : 1;
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$16, "paddingX", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$16, "paddingY", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$16, "height", _v$8, _p$.a));
      _v$9 !== _p$.o && (_p$.o = _$setProp(_el$17, "fg", _v$9, _p$.o));
      _v$0 !== _p$.i && (_p$.i = _$setProp(_el$19, "fg", _v$0, _p$.i));
      _v$1 !== _p$.n && (_p$.n = _$setProp(_el$20, "paddingTop", _v$1, _p$.n));
      _v$10 !== _p$.s && (_p$.s = _$setProp(_el$21, "fg", _v$10, _p$.s));
      _v$11 !== _p$.h && (_p$.h = _$setProp(_el$21, "paddingTop", _v$11, _p$.h));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined
    });
    return _el$16;
  })();
}
/** Read-only UI selection: keep ledger-only descendants, and visit cycles once. */
export function buildSessionDetailsTree(store, rootID, parents = store.sessionParents) {
  const model = tuiReadModel(store);
  if (parents !== store.sessionParents) for (const [id, parent] of parents) model.observeParent(id, {
    parent,
    origin: "cache"
  });
  const index = visibleTotalsIndex(store);
  const nodes = [];
  const visited = new Set();
  const pending = [{
    sessionID: rootID,
    depth: 0
  }];
  while (pending.length) {
    const node = pending.pop();
    if (!model.eligible(node.sessionID)) continue;
    if (visited.has(node.sessionID)) continue;
    visited.add(node.sessionID);
    const rollup = index.get(node.sessionID);
    nodes.push({
      ...node,
      direct: rollup.direct
    });
    for (const child of rollup.children.slice().reverse()) pending.push({
      sessionID: child.sessionID,
      depth: node.depth + 1
    });
  }
  const including = index.get(rootID).including;
  return {
    rootID,
    nodes,
    including
  };
}
export function selectSessionDetails(tree, sessionID, lastBySession) {
  const node = tree.nodes.find(item => item.sessionID === sessionID) ?? tree.nodes[0];
  const last = node ? lastBySession.get(node.sessionID) : undefined;
  return {
    ...(node ?? {
      sessionID: tree.rootID,
      depth: 0,
      direct: zeroDirectTotals()
    }),
    last
  };
}
export function createDetailsController(api, store) {
  let owned = false;
  let openedSessionID;
  return {
    get owned() {
      return owned;
    },
    get sessionID() {
      return openedSessionID;
    },
    open() {
      if (store.disposed || api.ui.dialog.open) return undefined;
      const sessionID = currentSessionID(api);
      if (!sessionID) {
        api.ui.toast({
          variant: "info",
          message: "Open a session to view Token Pulse details",
          duration: 3000
        });
        return undefined;
      }
      if (!scopeEligible(store, sessionID)) return undefined;
      api.ui.dialog.replace(() => _$createComponent(TokenPulseDetails, {
        api: api,
        store: store,
        sessionID: sessionID
      }), () => {
        owned = false;
        openedSessionID = undefined;
      });
      owned = true;
      openedSessionID = sessionID;
      api.ui.dialog.setSize("large");
      return sessionID;
    }
  };
}
export function registerTokenPulseCommands(api, store, options, openHistory) {
  const details = createDetailsController(api, store);
  // Palette and slash lookup happens in modal/autocomplete modes. Keep
  // definitions reachable there, without enabling shortcuts in those modes.
  const commands = api.keymap.registerLayer({
    commands: [{
      name: COMMAND_NAME,
      title: "Open token history",
      desc: "Open recent usage history for the current session",
      category: "Plugin",
      namespace: "palette",
      slashName: "tps",
      run: openHistory
    }, {
      name: DETAILS_COMMAND_NAME,
      title: "Token Pulse details",
      desc: "Session usage, cache and task time",
      category: "Plugin",
      namespace: "palette",
      slashName: "tps-details",
      run: () => {
        details.open();
      }
    }]
  });
  api.lifecycle.onDispose(commands);
  const bindings = api.keymap.registerLayer({
    mode: "base",
    bindings: tokenPulseBindings(options)
  });
  api.lifecycle.onDispose(bindings);
  return details;
}
function projectTotals(ledger, records, parentBySessionID) {
  const scope = collectSessionScopeEvidence(records, ledger.sessionScopes);
  const canonical = {
    ...ledger,
    version: TOTALS_VERSION,
    generationBasisVersion: ledger.generationBasisVersion === 3 ? 3 : undefined,
    settled: ledger.settled ?? {}
  };
  const parents = new Map(parentBySessionID); // Shared caches require immutable parent snapshots.
  const unique = filterHistoryRecords(mergeHistoryLayers(records, new Map(), Number.MAX_SAFE_INTEGER), scope, parents, getExcludedMessageIDs(canonical));
  const basis = projectTotalsGenerationBasis({
    ...ledger,
    version: TOTALS_VERSION,
    generationBasisVersion: ledger.generationBasisVersion === 3 ? 3 : undefined,
    settled: ledger.settled ?? {},
    sessionScopes: scope
  });
  return {
    sessions: projectTotalsMeasurementScope({
      ...basis,
      sessions: applyWindowAdjustments(basis, unique)
    }, parents).sessions,
    parents: projectionParents(parentBySessionID, unique)
  };
}
function applyWindowAdjustments(ledger, records) {
  const sessions = Object.create(null);
  for (const [sessionID, session] of Object.entries(ledger.sessions ?? {})) {
    if (sessionID.length === 0 || !session) continue;
    sessions[sessionID] = cloneDirectTotals(session);
  }
  const settled = ledger.settled ?? {};
  const open = ledger.open ?? {};
  for (const record of records) {
    const settledValue = ownValue(settled, record.messageID);
    if (settledValue === true) continue;
    const next = contributionNumbers(withCanonicalLedgerSpeed(ledger, record));
    if (!next) continue;
    const previous = settledValue ?? ownValue(open, record.messageID);
    if (previous?.excluded) continue;
    if (previous) {
      if (previous.quality === "exact" && record.quality === "provisional") continue;
      const priorUpdate = coerceCompletionUpdate(previous.update);
      const nextUpdate = coerceCompletionUpdate(record.update);
      if (previous.speedBackfill && !nextUpdate) continue;
      if (priorUpdate) {
        if (!nextUpdate) continue;
        // Disk ledger confirms this provider fact; use its canonical speed.
        if (nextUpdate.fingerprint === priorUpdate.fingerprint && nextUpdate.revision === priorUpdate.revision) continue;
        if (!isNewerCompletionUpdate(nextUpdate, priorUpdate)) continue;
      }
      const prior = openNumbers(previous);
      if (!prior || sameContributionNumbers(prior, next)) continue;
      if (prior.sessionID !== next.sessionID) {
        subtractDirect(ensureDirect(sessions, prior.sessionID), prior.tokens, prior.cost, prior.speed);
        addDirect(ensureDirect(sessions, next.sessionID), next.tokens, next.cost, next.speed);
      } else {
        applyDirectDelta(ensureDirect(sessions, next.sessionID), prior.tokens, prior.cost, next.tokens, next.cost, prior.speed, next.speed);
      }
      continue;
    }
    addDirect(ensureDirect(sessions, next.sessionID), next.tokens, next.cost, next.speed);
  }
  return sessions;
}

/** Same revision policy as applyWindowAdjustments, expressed as compact signed
 * source contributions so visible queries need not rescan every retained MID. */
function windowContributionTerms(ledger, record) {
  const settled = ownValue(ledger.settled, record.messageID);
  if (settled === true) return [];
  const next = contributionNumbers(withCanonicalLedgerSpeed(ledger, record));
  if (!next) return [];
  const previous = settled ?? ownValue(ledger.open, record.messageID);
  if (previous?.excluded) return [];
  if (!previous) return [{
    contribution: next,
    sign: 1
  }];
  if (previous.quality === "exact" && record.quality === "provisional") return [];
  const priorUpdate = coerceCompletionUpdate(previous.update);
  const nextUpdate = coerceCompletionUpdate(record.update);
  if (previous.speedBackfill && !nextUpdate) return [];
  if (priorUpdate) {
    if (!nextUpdate) return [];
    if (nextUpdate.fingerprint === priorUpdate.fingerprint && nextUpdate.revision === priorUpdate.revision) return [];
    if (!isNewerCompletionUpdate(nextUpdate, priorUpdate)) return [];
  }
  const prior = openNumbers(previous);
  return !prior || sameContributionNumbers(prior, next) ? [] : [{
    contribution: prior,
    sign: -1
  }, {
    contribution: next,
    sign: 1
  }];
}

// Server owns speed-only backfill/invalidation. Matching usage is not evidence
// that a stale history or optimistic record can replace its canonical timing.
function withCanonicalLedgerSpeed(ledger, record) {
  const previous = ownValue(ledger.settled, record.messageID) ?? ownValue(ledger.open, record.messageID);
  if (!previous || previous === true || previous.quality !== "exact" && !previous.speedBackfill && !previous.update || previous.sessionID !== record.sessionID || previous.cost !== record.cost || !tokenCountsEqual(previous.tokens, record.tokens)) return record;
  const priorUpdate = coerceCompletionUpdate(previous.update);
  const nextUpdate = coerceCompletionUpdate(record.update);
  if (previous.speedBackfill && !priorUpdate && nextUpdate) return record;
  if (priorUpdate && nextUpdate && isNewerCompletionUpdate(nextUpdate, priorUpdate)) return record;
  if (sameSpeedContribution(record.speed, previous.speed)) return record;
  return {
    ...record,
    speed: coerceSpeedContribution(previous.speed)
  };
}
function contributionNumbers(record) {
  if (typeof record.sessionID !== "string" || record.sessionID.length === 0) return undefined;
  return {
    sessionID: record.sessionID,
    tokens: normalizeTokenCounts(record.tokens),
    cost: nonNegativeMetric(record.cost),
    speed: coerceSpeedContribution(record.speed)
  };
}
function openNumbers(contribution) {
  if (typeof contribution?.sessionID !== "string" || contribution.sessionID.length === 0) return undefined;
  return {
    sessionID: contribution.sessionID,
    tokens: normalizeTokenCounts(contribution.tokens),
    cost: nonNegativeMetric(contribution.cost),
    speed: coerceSpeedContribution(contribution.speed)
  };
}
function sameContributionNumbers(left, right) {
  return left.sessionID === right.sessionID && left.cost === right.cost && sameSpeedContribution(left.speed, right.speed) && TOTALS_TOKEN_FIELDS.every(field => left.tokens[field] === right.tokens[field]);
}
function projectionParents(parentBySessionID, records) {
  const parents = new Map();
  for (const [sessionID, parent] of parentBySessionID) {
    if (parent === null) {
      parents.set(sessionID, null);
      continue;
    }
    if (!isParentLink(sessionID, parent)) continue;
    parents.set(sessionID, parent);
  }
  for (const record of records) {
    if (parents.has(record.sessionID)) continue;
    const parent = record.parentSessionID;
    if (!isParentLink(record.sessionID, parent)) continue;
    parents.set(record.sessionID, parent);
  }
  return parents;
}
function isParentLink(sessionID, parent) {
  return typeof sessionID === "string" && sessionID.length > 0 && typeof parent === "string" && parent.length > 0 && parent !== sessionID;
}
function cloneDirectTotals(session) {
  return {
    tokens: normalizeTokenCounts(session.tokens),
    cost: nonNegativeMetric(session.cost),
    responseCount: nonNegativeMetric(session.responseCount),
    ...(session.speed ? {
      speed: coerceSpeedTotals(session.speed)
    } : {})
  };
}
function zeroDirectTotals() {
  return {
    tokens: emptyTokenCounts(),
    cost: 0,
    responseCount: 0
  };
}
function ensureDirect(sessions, sessionID) {
  const existing = ownValue(sessions, sessionID);
  if (existing) return existing;
  const created = zeroDirectTotals();
  Object.defineProperty(sessions, sessionID, {
    value: created,
    writable: true,
    enumerable: true,
    configurable: true
  });
  return created;
}
function addDirect(session, tokens, cost, speed) {
  session.tokens = clampTokenCounts(addTokenCounts(session.tokens, tokens));
  session.cost = clampNonNegative(session.cost + cost);
  session.responseCount = clampNonNegative(session.responseCount + 1);
  const updated = updateSpeedTotals(session.speed, speed, 1);
  if (updated) session.speed = updated;
}
function subtractDirect(session, tokens, cost, speed) {
  session.tokens = subtractTokenCounts(session.tokens, tokens);
  session.cost = clampNonNegative(session.cost - cost);
  session.responseCount = clampNonNegative(session.responseCount - 1);
  const updated = updateSpeedTotals(session.speed, speed, -1);
  if (updated) session.speed = updated;
}
function applyDirectDelta(session, previousTokens, previousCost, nextTokens, nextCost, previousSpeed, nextSpeed) {
  const tokens = emptyTokenCounts();
  for (const field of TOTALS_TOKEN_FIELDS) {
    tokens[field] = clampNonNegative(session.tokens[field] + nextTokens[field] - previousTokens[field]);
  }
  session.tokens = tokens;
  session.cost = clampNonNegative(session.cost + nextCost - previousCost);
  const updated = updateSpeedTotals(updateSpeedTotals(session.speed, previousSpeed, -1), nextSpeed, 1);
  if (updated) session.speed = updated;
}
function subtractTokenCounts(left, right) {
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
function clampNonNegative(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}
function nonNegativeMetric(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}
function totalsHaveUsage(totals) {
  if (!totals) return false;
  return totals.responseCount > 0 || totals.cost > 0 || totalTokens(totals.tokens) > 0;
}
function emptyTotalsLedger() {
  return {
    version: TOTALS_VERSION,
    generationBasisVersion: 3,
    sessions: {},
    open: {},
    settled: {}
  };
}
async function readTotalsSnapshot(path) {
  // createTotalsStorage().read() keeps a process-local cache, so a ledger
  // written by the server process would stay stale. Reload from disk instead.
  let content;
  try {
    content = await readLedgerText(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return coerceTotalsSnapshot(JSON.parse(content));
}
function coerceTotalsSnapshot(value) {
  if (!isRecord(value) || value.version !== TOTALS_VERSION) {
    throw new TypeError("Invalid totals ledger");
  }
  if (!isRecord(value.sessions) || !isRecord(value.open)) {
    throw new TypeError("Invalid totals ledger");
  }
  const sessions = Object.create(null);
  for (const [sessionID, sessionValue] of Object.entries(value.sessions)) {
    if (sessionID.length === 0) throw new TypeError("Invalid totals ledger");
    sessions[sessionID] = coerceDirectTotals(sessionValue);
  }
  const open = Object.create(null);
  for (const [messageID, contribution] of Object.entries(value.open)) {
    if (messageID.length === 0) throw new TypeError("Invalid totals ledger");
    open[messageID] = coerceOpenContribution(contribution);
  }
  const sessionScopes = Object.create(null);
  if (isRecord(value.sessionScopes)) for (const [id, raw] of Object.entries(value.sessionScopes)) {
    const proof = coerceScopeEvidence(raw);
    if (proof) sessionScopes[id] = proof;
  }
  const messageScopes = Object.create(null);
  if (isRecord(value.messageScopes)) for (const [id, raw] of Object.entries(value.messageScopes)) {
    const proof = coerceScopeEvidence(raw);
    if (proof && ownValue(asRecord(value.settled), id) === true) messageScopes[id] = proof;
  }
  const sessionAgents = Object.create(null);
  if (isRecord(value.sessionAgents) && !Array.isArray(value.sessionAgents)) for (const [id, raw] of Object.entries(value.sessionAgents)) {
    const agents = normalizeAgentNames(raw);
    if (id && agents.length > 0) sessionAgents[id] = agents;
  }
  return {
    version: TOTALS_VERSION,
    ...(value.generationBasisVersion === 3 ? {
      generationBasisVersion: 3
    } : {}),
    sessions,
    open,
    settled: coerceSettled(value.settled),
    sessionScopes,
    messageScopes,
    sessionAgents
  };
}
function coerceSettled(value) {
  if (value === undefined) return Object.create(null);
  if (!isRecord(value)) throw new TypeError("Invalid totals ledger");
  const settled = Object.create(null);
  for (const [messageID, marker] of Object.entries(value)) {
    if (messageID.length === 0) throw new TypeError("Invalid totals ledger");
    if (marker === true) {
      settled[messageID] = true;
      continue;
    }
    settled[messageID] = coerceOpenContribution(marker);
  }
  return settled;
}
function coerceDirectTotals(value) {
  if (!isRecord(value)) throw new TypeError("Invalid totals ledger");
  if (value.speed !== undefined && !coerceSpeedTotals(value.speed)) throw new TypeError("Invalid totals ledger");
  return {
    tokens: coerceTotalsTokens(value.tokens),
    cost: requireNonNegative(value.cost),
    responseCount: requireNonNegative(value.responseCount),
    ...(value.speed !== undefined ? {
      speed: coerceSpeedTotals(value.speed)
    } : {})
  };
}
function coerceOpenContribution(value) {
  if (!isRecord(value)) throw new TypeError("Invalid totals ledger");
  if (value.speed !== undefined && !coerceSpeedContribution(value.speed)) throw new TypeError("Invalid totals ledger");
  if (value.update !== undefined && !coerceCompletionUpdate(value.update)) throw new TypeError("Invalid totals ledger");
  const sessionID = value.sessionID;
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    throw new TypeError("Invalid totals ledger");
  }
  const quality = value.quality;
  if (quality !== "provisional" && quality !== "exact") {
    throw new TypeError("Invalid totals ledger");
  }
  return {
    sessionID,
    quality,
    tokens: coerceTotalsTokens(value.tokens),
    cost: requireNonNegative(value.cost),
    ...(value.speed !== undefined ? {
      speed: coerceSpeedContribution(value.speed)
    } : {}),
    ...(value.update !== undefined ? {
      update: coerceCompletionUpdate(value.update)
    } : {}),
    ...(coerceScopeEvidence(value.excluded) ? {
      excluded: coerceScopeEvidence(value.excluded)
    } : {}),
    ...(isRecord(value.speedBackfill) && value.speedBackfill.version === 1 && value.speedBackfill.source === "server" ? {
      speedBackfill: {
        version: 1,
        source: "server"
      }
    } : {})
  };
}
function coerceTotalsTokens(value) {
  if (!isRecord(value)) throw new TypeError("Invalid totals ledger");
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
function isNodeError(value) {
  return value instanceof Error || isRecord(value);
}
export function childRows(records, sessionID, store) {
  if (!sessionID || !store) return [];
  const model = tuiReadModel(store);
  model.counters.rowDerivations++;
  const index = visibleTotalsIndex(store, records);
  records = scopedRecords(store, records);
  const bySession = new Map();
  for (const record of records) {
    model.counters.rowRecordVisits++;
    const list = bySession.get(record.sessionID) ?? [];
    list.push(record);
    bySession.set(record.sessionID, list);
  }
  const root = index.get(sessionID);
  const rows = [];
  const visited = new Set([sessionID]);
  const pending = root.children.slice().reverse().map(child => ({
    id: child.sessionID,
    depth: 0
  }));
  while (pending.length) {
    const {
      id: childID,
      depth
    } = pending.pop();
    if (visited.has(childID) || !model.eligible(childID)) continue;
    visited.add(childID);
    const rollup = index.get(childID);
    const directRecords = bySession.get(childID) ?? [];
    const show = directRecords.length > 0 || totalsHaveUsage(rollup.including);
    if (show) {
      const modelRecord = directRecords.slice().sort((left, right) => (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start))[0];
      rows.push({
        depth,
        sessionID: childID,
        agents: normalizeAgentNames([...normalizeAgentNames(ownValue(store.totalsLedger.sessionAgents, childID)), ...directRecords.map(record => record.agent)]),
        responseCount: rollup.direct.responseCount,
        generated: generatedTokens(rollup.direct.tokens),
        total: totalTokens(rollup.direct.tokens),
        model: modelRecord?.model ?? "-"
      });
    }
    for (const child of rollup.children.slice().reverse()) pending.push({
      id: child.sessionID,
      depth: show ? depth + 1 : depth
    });
  }
  return rows;
}
function currentSessionID(api) {
  const route = api.route.current;
  if (route.name !== "session") return undefined;
  return readString(route.params?.sessionID);
}
function routeSessionID(params) {
  return readString(params?.sessionID);
}
function leaveHistory(api) {
  const route = api.route.current;
  const sessionID = route.name === HISTORY_ROUTE ? routeSessionID(route.params) : undefined;
  if (sessionID) api.route.navigate("session", {
    sessionID
  });else api.route.navigate("home");
}
function warnWithToast(api, message, error) {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  console.warn(`[oc-tps] ${message}${detail}`);
  try {
    api.ui.toast({
      variant: "warning",
      message: `oc-tps: ${message}${detail}`,
      duration: 4000
    });
  } catch {
    // TUI may be disposing while an async history read finishes.
  }
}
function Header(props) {
  return (() => {
    var _el$53 = _$createElement("box"),
      _el$54 = _$createElement("text"),
      _el$56 = _$createElement("text"),
      _el$57 = _$createTextNode(`session `);
    _$insertNode(_el$53, _el$54);
    _$insertNode(_el$53, _el$56);
    _$setProp(_el$53, "height", 2);
    _$setProp(_el$53, "flexShrink", 0);
    _$setProp(_el$53, "paddingX", 1);
    _$setProp(_el$53, "flexDirection", "column");
    _$insertNode(_el$54, _$createTextNode(`Token history`));
    _$insertNode(_el$56, _el$57);
    _$setProp(_el$56, "truncate", true);
    _$setProp(_el$56, "wrapMode", "none");
    _$insert(_el$56, () => shortTail(props.sessionID, 18), null);
    _$effect(_p$ => {
      var _v$28 = props.theme.current.backgroundPanel,
        _v$29 = props.theme.current.primary,
        _v$30 = props.theme.current.textMuted;
      _v$28 !== _p$.e && (_p$.e = _$setProp(_el$53, "backgroundColor", _v$28, _p$.e));
      _v$29 !== _p$.t && (_p$.t = _$setProp(_el$54, "fg", _v$29, _p$.t));
      _v$30 !== _p$.a && (_p$.a = _$setProp(_el$56, "fg", _v$30, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$53;
  })();
}
function SummaryBlock(props) {
  const lines = createMemo(() => {
    props.store.revision();
    const rollup = totalsForSession(props.store, props.sessionID);
    const aggregate = aggregateForSession(props.store.records, props.sessionID, props.store);
    const status = sourceStatusLabel(props.store);
    const prefix = status ? [status] : [];
    if (!usageIsKnown(props.store, rollup?.including, props.sessionID)) return [...prefix, "Totals unavailable"];
    if (!rollup || !totalsHaveUsage(rollup.including) && !aggregate) return [...prefix, ...emptySummaryLines()];
    return [...prefix, ...(usageIsKnown(props.store, rollup.direct, props.sessionID) ? summaryLines("Session only", rollup.direct.tokens, rollup.direct.cost, rollup.direct.responseCount) : ["Session only: totals unavailable"]), ...summaryLines("Including subagents", rollup.including.tokens, rollup.including.cost, rollup.including.responseCount)];
  });
  return (() => {
    var _el$58 = _$createElement("box"),
      _el$59 = _$createElement("text");
    _$insertNode(_el$58, _el$59);
    _$setProp(_el$58, "paddingX", 1);
    _$setProp(_el$58, "flexShrink", 0);
    _$setProp(_el$58, "flexDirection", "column");
    _$insertNode(_el$59, _$createTextNode(`totals`));
    _$setProp(_el$59, "flexShrink", 0);
    _$insert(_el$58, () => lines().map(line => (() => {
      var _el$61 = _$createElement("text");
      _$setProp(_el$61, "flexShrink", 0);
      _$setProp(_el$61, "wrapMode", "word");
      _$insert(_el$61, line);
      _$effect(_$p => _$setProp(_el$61, "fg", props.theme.current.text, _$p));
      return _el$61;
    })()), null);
    _$effect(_p$ => {
      var _v$31 = props.theme.current.background,
        _v$32 = props.theme.current.secondary;
      _v$31 !== _p$.e && (_p$.e = _$setProp(_el$58, "backgroundColor", _v$31, _p$.e));
      _v$32 !== _p$.t && (_p$.t = _$setProp(_el$59, "fg", _v$32, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$58;
  })();
}
function HistoryView(props) {
  const rows = createMemo(() => {
    props.store.revision();
    return recentRecords(props.store.records, props.sessionID, props.store);
  });
  const emptyLabel = createMemo(() => {
    props.store.revision();
    return sourcePartAvailable(props.store, "history") ? "No completed responses yet" : sourceStatusLabel(props.store) ?? "History unavailable";
  });
  return (() => {
    var _el$62 = _$createElement("box"),
      _el$63 = _$createElement("box"),
      _el$64 = _$createElement("text"),
      _el$66 = _$createElement("scrollbox");
    _$insertNode(_el$62, _el$63);
    _$insertNode(_el$62, _el$66);
    _$setProp(_el$62, "flexDirection", "column");
    _$setProp(_el$62, "flexGrow", 1);
    _$insert(_el$62, _$createComponent(Header, {
      get theme() {
        return props.api.theme;
      },
      get sessionID() {
        return props.sessionID;
      }
    }), _el$63);
    _$insert(_el$62, _$createComponent(SummaryBlock, {
      get theme() {
        return props.api.theme;
      },
      get store() {
        return props.store;
      },
      get sessionID() {
        return props.sessionID;
      }
    }), _el$63);
    _$insertNode(_el$63, _el$64);
    _$setProp(_el$63, "height", 1);
    _$setProp(_el$63, "flexShrink", 0);
    _$setProp(_el$63, "paddingX", 1);
    _$insertNode(_el$64, _$createTextNode(`TIME SESSION MODEL OUT/REAS COST`));
    _$setProp(_el$64, "truncate", true);
    _$setProp(_el$64, "wrapMode", "none");
    _$setProp(_el$66, "flexGrow", 1);
    _$setProp(_el$66, "minHeight", 0);
    _$setProp(_el$66, "flexDirection", "column");
    _$setProp(_el$66, "paddingX", 1);
    _$setProp(_el$66, "stickyScroll", true);
    _$setProp(_el$66, "stickyStart", "top");
    _$insert(_el$66, (() => {
      var _c$8 = _$memo(() => rows().length === 0);
      return () => _c$8() ? (() => {
        var _el$67 = _$createElement("text");
        _$setProp(_el$67, "wrapMode", "word");
        _$insert(_el$67, emptyLabel);
        _$effect(_$p => _$setProp(_el$67, "fg", props.api.theme.current.textMuted, _$p));
        return _el$67;
      })() : rows().map(record => (() => {
        var _el$68 = _$createElement("text");
        _$setProp(_el$68, "truncate", true);
        _$setProp(_el$68, "wrapMode", "none");
        _$insert(_el$68, () => formatHistoryRow(record));
        _$effect(_$p => _$setProp(_el$68, "fg", props.api.theme.current.text, _$p));
        return _el$68;
      })());
    })());
    _$effect(_p$ => {
      var _v$33 = props.api.theme.current.background,
        _v$34 = props.api.theme.current.backgroundElement,
        _v$35 = props.api.theme.current.textMuted,
        _v$36 = props.api.theme.current.background;
      _v$33 !== _p$.e && (_p$.e = _$setProp(_el$62, "backgroundColor", _v$33, _p$.e));
      _v$34 !== _p$.t && (_p$.t = _$setProp(_el$63, "backgroundColor", _v$34, _p$.t));
      _v$35 !== _p$.a && (_p$.a = _$setProp(_el$64, "fg", _v$35, _p$.a));
      _v$36 !== _p$.o && (_p$.o = _$setProp(_el$66, "backgroundColor", _v$36, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$62;
  })();
}
export function rememberVisibleSession(store, sessionID) {
  if (!sessionID || store.focusSessionID === sessionID) return;
  store.focusSessionID = sessionID;
  store.bump();
}
export function displayedSessionID(_store, slotSessionID) {
  return slotSessionID;
}
export function togglePulse(store) {
  store.pulseExpanded = !store.pulseExpanded;
  store.bump();
  return store.pulseExpanded;
}
function BottomContent(props) {
  // Start with whole fields on separate rows until Yoga measures this sidebar.
  // Renderer width is the terminal, not the host sidebar's usable content width.
  const [metricWidth, setMetricWidth] = createSignal(0);
  const sessionID = createMemo(() => {
    props.store.revision();
    return displayedSessionID(props.store, props.sessionID);
  });
  const visible = createMemo(() => {
    props.store.revision();
    return scopeEligible(props.store, sessionID());
  });
  const view = createMemo(() => {
    props.store.revision();
    return {
      aggregate: aggregateForSession(props.store.records, sessionID(), props.store),
      records: props.store.records,
      totals: totalsForSession(props.store, sessionID())
    };
  });
  const taskWallTime = createMemo(() => {
    props.store.revision();
    props.store.clockRevision();
    if (!sourcePartAvailable(props.store, "runs")) return undefined;
    return taskWallTimeForSession(props.store, sessionID());
  });
  const sourceLabel = createMemo(() => {
    props.store.revision();
    return sourceStatusLabel(props.store);
  });
  const usageKnown = createMemo(() => {
    props.store.revision();
    return usageIsKnown(props.store, view().totals?.including, sessionID());
  });
  const rows = createMemo(() => {
    props.store.revision();
    return props.store.pulseExpanded ? childRows(view().records, sessionID(), props.store) : [];
  });
  const sections = createMemo(() => {
    const totals = view().totals;
    return [{
      label: "SESSION ONLY",
      tokens: totals?.direct.tokens ?? emptyTokenCounts(),
      cost: totals?.direct.cost ?? 0,
      responseCount: totals?.direct.responseCount ?? 0
    }, {
      label: "INCLUDING SUBAGENTS",
      tokens: totals?.including.tokens ?? emptyTokenCounts(),
      cost: totals?.including.cost ?? 0,
      responseCount: totals?.including.responseCount ?? 0
    }];
  });
  const taskWallTimeLabel = createMemo(() => {
    const wallTime = taskWallTime();
    return wallTime === undefined ? "--" : formatDuration(wallTime);
  });
  const metricLabel = createMemo(() => {
    if (!usageKnown()) return wrapMetricFields(["-- total", "cache --", `time ${taskWallTimeLabel().replace(/\s+/g, "")}`], metricWidth());
    const tokens = view().totals?.including.tokens ?? emptyTokenCounts();
    return formatPulseMetrics(tokens, metricWidth(), taskWallTime());
  });
  const expanded = createMemo(() => {
    props.store.revision();
    return props.store.pulseExpanded;
  });
  const onPulseMouseDown = event => {
    if (event.button !== 0) return;
    togglePulse(props.store);
  };
  return (() => {
    var _el$69 = _$createElement("box");
    _$setProp(_el$69, "flexDirection", "column");
    _$setProp(_el$69, "width", "100%");
    _$setProp(_el$69, "paddingTop", 1);
    _$setProp(_el$69, "paddingX", 1);
    _$setProp(_el$69, "overflow", "hidden");
    _$setProp(_el$69, "flexShrink", 0);
    _$insert(_el$69, (() => {
      var _c$9 = _$memo(() => !!visible());
      return () => _c$9() && [(() => {
        var _el$70 = _$createElement("box"),
          _el$71 = _$createElement("text");
        _$insertNode(_el$70, _el$71);
        _$setProp(_el$70, "focusable", true);
        _$setProp(_el$70, "width", "100%");
        _$setProp(_el$70, "height", 1);
        _$setProp(_el$70, "paddingX", 1);
        _$setProp(_el$70, "onMouseDown", onPulseMouseDown);
        _$setProp(_el$71, "truncate", true);
        _$setProp(_el$71, "wrapMode", "none");
        _$insert(_el$71, () => expanded() ? "- Token Pulse" : "+ Token Pulse");
        _$effect(_p$ => {
          var _v$37 = props.api.theme.current.backgroundElement,
            _v$38 = props.api.theme.current.primary;
          _v$37 !== _p$.e && (_p$.e = _$setProp(_el$70, "backgroundColor", _v$37, _p$.e));
          _v$38 !== _p$.t && (_p$.t = _$setProp(_el$71, "fg", _v$38, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$70;
      })(), (() => {
        var _el$72 = _$createElement("box"),
          _el$73 = _$createElement("text");
        _$insertNode(_el$72, _el$73);
        _$setProp(_el$72, "flexDirection", "column");
        _$setProp(_el$72, "width", "100%");
        _$setProp(_el$72, "paddingX", 1);
        _$setProp(_el$72, "flexShrink", 0);
        _$setProp(_el$72, "onSizeChange", function () {
          setMetricWidth(Math.max(1, this.width - 2));
        });
        _$setProp(_el$73, "width", "100%");
        _$setProp(_el$73, "wrapMode", "word");
        _$setProp(_el$73, "flexShrink", 0);
        _$insert(_el$73, metricLabel);
        _$effect(_$p => _$setProp(_el$73, "fg", props.api.theme.current.textMuted, _$p));
        return _el$72;
      })(), _$memo(() => _$memo(() => !!sourceLabel())() && (() => {
        var _el$74 = _$createElement("text");
        _$setProp(_el$74, "paddingX", 1);
        _$setProp(_el$74, "width", "100%");
        _$setProp(_el$74, "wrapMode", "word");
        _$setProp(_el$74, "flexShrink", 0);
        _$insert(_el$74, sourceLabel);
        _$effect(_$p => _$setProp(_el$74, "fg", props.api.theme.current.textMuted, _$p));
        return _el$74;
      })()), _$memo(() => _$memo(() => !!expanded())() && (!sessionID() ? (() => {
        var _el$75 = _$createElement("text");
        _$insertNode(_el$75, _$createTextNode(`No active session`));
        _$setProp(_el$75, "paddingTop", 1);
        _$setProp(_el$75, "truncate", true);
        _$setProp(_el$75, "wrapMode", "none");
        _$effect(_$p => _$setProp(_el$75, "fg", props.api.theme.current.textMuted, _$p));
        return _el$75;
      })() : [(() => {
        var _el$77 = _$createElement("text"),
          _el$78 = _$createTextNode(`session `);
        _$insertNode(_el$77, _el$78);
        _$setProp(_el$77, "paddingTop", 1);
        _$setProp(_el$77, "wrapMode", "word");
        _$setProp(_el$77, "flexShrink", 0);
        _$insert(_el$77, sessionID, null);
        _$effect(_$p => _$setProp(_el$77, "fg", props.api.theme.current.secondary, _$p));
        return _el$77;
      })(), _$memo(() => sections().map((section, index) => _$createComponent(PulseSection, {
        get theme() {
          return props.api.theme;
        },
        section: section,
        get known() {
          return usageIsKnown(props.store, section, sessionID());
        }
      }))), _$memo(() => _$memo(() => !!(usageKnown() && !view().aggregate && !totalsHaveUsage(view().totals?.including)))() && (() => {
        var _el$82 = _$createElement("text");
        _$insertNode(_el$82, _$createTextNode(`No completed responses yet`));
        _$setProp(_el$82, "paddingTop", 1);
        _$setProp(_el$82, "truncate", true);
        _$setProp(_el$82, "wrapMode", "none");
        _$effect(_$p => _$setProp(_el$82, "fg", props.api.theme.current.textMuted, _$p));
        return _el$82;
      })()), (() => {
        var _el$79 = _$createElement("box"),
          _el$80 = _$createElement("text");
        _$insertNode(_el$79, _el$80);
        _$setProp(_el$79, "flexDirection", "column");
        _$setProp(_el$79, "width", "100%");
        _$setProp(_el$79, "paddingTop", 1);
        _$insertNode(_el$80, _$createTextNode(`SESSION RUN`));
        _$setProp(_el$80, "truncate", true);
        _$setProp(_el$80, "wrapMode", "none");
        _$insert(_el$79, _$createComponent(PulseMetricGrid, {
          get theme() {
            return props.api.theme;
          },
          get rows() {
            return [[{
              label: "Task wall time",
              value: taskWallTimeLabel()
            }]];
          }
        }), null);
        _$effect(_$p => _$setProp(_el$80, "fg", props.api.theme.current.accent, _$p));
        return _el$79;
      })(), _$memo(() => _$memo(() => rows().length > 0)() && _$createComponent(ChildAgentRows, {
        get theme() {
          return props.api.theme;
        },
        get rows() {
          return rows();
        }
      }))]))];
    })());
    return _el$69;
  })();
}
export function createTuiSlotPlugin(api, store, options, selectSession) {
  return {
    order: 1_000_000,
    slots: {
      sidebar_content: (_context, props) => {
        if (selectSession) {
          createEffect(() => {
            void selectSession(props.session_id);
          });
          onCleanup(() => {
            void selectSession(undefined);
          });
        }
        return _$createComponent(BottomContent, {
          api: api,
          store: store,
          get sessionID() {
            return props.session_id;
          }
        });
      }
    }
  };
}
function registerLegacyCommand(api, openHistory, openDetails, options) {
  if (!api.command) return;
  try {
    const dispose = once(api.command.register(() => [{
      title: "Open token history",
      value: COMMAND_NAME,
      description: "Open recent usage history for the current session",
      category: "Plugin",
      keybind: legacyBinding(options, COMMAND_NAME, "ctrl+shift+t"),
      slash: {
        name: "tps"
      },
      onSelect: openHistory
    }, {
      title: "Token Pulse details",
      value: DETAILS_COMMAND_NAME,
      description: "Session usage, cache and task time",
      category: "Plugin",
      keybind: legacyBinding(options, DETAILS_COMMAND_NAME, "ctrl+shift+y"),
      slash: {
        name: "tps-details"
      },
      onSelect: openDetails
    }]));
    api.lifecycle.onDispose(dispose);
  } catch (error) {
    warnWithToast(api, "legacy command registration failed", error);
  }
}
function legacyBinding(options, name, fallback) {
  if (!options.keybinds || !Object.hasOwn(options.keybinds, name)) return fallback;
  const value = options.keybinds[name];
  return typeof value === "string" && value !== "none" ? value : undefined;
}

/** Watch only ledger names. Directory watches survive atomic file replacement;
 * a missing directory is reached through its nearest existing ancestor, without
 * recursive watches, scans, polling, or any inference of task completion. */
function watchLedgerPaths(paths) {
  let disposed = false;
  const disposers = [];
  const groups = new Map();
  for (const item of paths) {
    const path = resolve(item.path);
    const directory = dirname(path);
    const files = groups.get(directory) ?? new Map();
    files.set(basename(path), item.changed);
    groups.set(directory, files);
  }
  for (const [target, files] of groups) {
    let watcher;
    let current;
    let disabled = false;
    let probeTimer;
    const fingerprint = name => {
      try {
        const stat = statSync(join(target, name));
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
    };
    const fingerprints = new Map();
    const probeRenames = () => {
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      // Bun can coalesce an atomic rename to the staging filename only. One
      // event-driven metadata flush checks ONLY our two known ledger paths;
      // unchanged history/temp/unrelated files never cause a ledger replay.
      probeTimer = setTimeout(() => {
        probeTimer = undefined;
        if (disposed || disabled) return;
        try {
          for (const [name, changed] of files) {
            const next = fingerprint(name);
            if (next === fingerprints.get(name)) continue;
            fingerprints.set(name, next);
            changed();
          }
        } catch (error) {
          disable(error);
        }
      }, 30);
    };
    const locate = () => {
      let directory = target;
      while (true) {
        try {
          const stat = statSync(directory);
          if (!stat.isDirectory()) throw new Error("Ledger parent is not a directory");
          return {
            directory,
            dev: stat.dev,
            ino: stat.ino
          };
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT" || dirname(directory) === directory) throw error;
          directory = dirname(directory);
        }
      }
    };
    const same = next => current?.directory === next.directory && current.dev === next.dev && current.ino === next.ino;
    const disable = error => {
      if (disposed || disabled) return;
      disabled = true;
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      watcher?.close();
      watcher = undefined;
      // Finite fallback: existing host-event reloads remain available. Do not
      // restart an unsupported watcher in a timer/CPU loop or invent idle facts.
      console.warn(`[oc-tps] ledger watcher unavailable for ${target}; updates rely on host events`, error);
    };
    const arm = refresh => {
      if (disposed || disabled) return;
      try {
        // Re-check after attaching: creation between stat and watch must not
        // leave us stranded at an ancestor after its last mkdir/rename event.
        for (let remaining = target.split(sep).length + 1; remaining > 0; remaining--) {
          const next = locate();
          if (same(next)) break;
          const previous = watcher;
          watcher = watch(next.directory, {
            persistent: false,
            encoding: "buffer"
          }, (kind, filename) => {
            if (disposed || disabled) return;
            try {
              if (kind === "rename" && !same(locate())) {
                arm(true);
                return;
              }
              const name = filename === null ? undefined : Buffer.isBuffer(filename) ? filename.toString() : String(filename);
              if (current?.directory !== target) {
                const child = relative(current.directory, target).split(sep)[0];
                if (name === undefined || name === child) arm(true);
                return;
              }
              if (name === undefined) probeRenames();else if (files.has(name)) {
                fingerprints.set(name, fingerprint(name));
                files.get(name)();
              }
              if (kind === "rename") probeRenames();
            } catch (error) {
              disable(error);
            }
          });
          watcher.on("error", disable);
          current = next;
          previous?.close();
          if (current.directory === target) for (const name of files.keys()) fingerprints.set(name, fingerprint(name));
          if (refresh && current.directory === target) for (const changed of files.values()) changed();
          refresh = true;
        }
      } catch (error) {
        disable(error);
      }
    };
    arm(false);
    disposers.push(() => {
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      watcher?.close();
      watcher = undefined;
    });
  }
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) dispose();
  };
}
function sourceReadError(store, ledger, error, path) {
  sourceReadResult(store, ledger, isNodeError(error) && error.code === "ENOENT" ? "missing" : {
    error: error instanceof Error ? error.message : String(error)
  }, path);
}

/** Only an actual safe-FD read can establish availability. Keep prior knowledge
 * on the same source, but let every new result clear that ledger's older error. */
function sourceReadResult(store, ledger, result, physicalPath) {
  const state = store.sourceState,
    path = physicalPath ?? state.paths?.[ledger] ?? ledger;
  const outcomes = snapshotsFor(store).outcomes;
  outcomes.set(`${ledger}:${path}`, {
    ledger,
    path,
    result
  });
  const errors = {
    ...state.errors
  };
  delete errors[ledger];
  const missing = [];
  for (const outcome of outcomes.values()) {
    if (outcome.result === "missing") missing.push(outcome.path);else if (typeof outcome.result === "object") errors[outcome.ledger] = outcome.result.error;
  }
  const loaded = {
    ...state.loaded,
    [ledger]: result === "loaded" || !!state.loaded?.[ledger]
  };
  store.sourceState = {
    ...state,
    loaded,
    missing,
    errors,
    status: Object.keys(errors).length ? "error" : missing.length ? "missing" : loaded.history && loaded.totals && loaded.runs ? state.unavailableSessions?.length ? "partial" : "ready" : "loading"
  };
  store.bump();
}

/** Keep the signal/store identity mounted views own; discard every source-derived
 * cache together. sourceEpoch fences readers independently of same-source edits. */
function clearRuntimeSource(store) {
  store.sourceEpoch++;
  sourceSnapshots.delete(store);
  disconnectTuiReadModel(store);
  const activity = tuiActivities.get(store);
  activity?.selection.dispose();
  tuiActivities.delete(store);
  const observation = observationRuntimes.get(store);
  if (observation) disposeContentMetadata(observation.metadata);
  observationRuntimes.delete(store);
  visibleHistory.delete(store);
  store.active.clear();
  if (store.optimistic instanceof RevisionMap) store.optimistic.discard();else store.optimistic.clear();
  store.optimisticQuality.clear();
  store.optimisticOrder.clear();
  store.nextOptimisticOrder = 1;
  store.diskRecords = [];
  store.records = [];
  store.completedMessageIDs.clear();
  store.sessionRuntime.clear();
  store.taskRuns.clear();
  store.sessionParents = new Map();
  store.messageScopes.clear();
  store.sourceScopes = createScopeRegistry();
  store.totalsLedger = emptyTotalsLedger();
  store.activityEvents = [];
  store.lastCompletedBySession.clear();
  store.focusSessionID = undefined;
}
export const initializeTui = async (api, rawOptions) => {
  const options = resolveOptions(rawOptions);
  if (!options.enabled) return;
  const store = createRuntimeStore(options.maxRecords);
  const [sidebarSessionID, setSidebarSessionID] = createSignal();
  const launchDirectory = api.state.path.worktree && api.state.path.worktree !== "/" ? api.state.path.worktree : api.state.path.directory;
  let historyPath;
  let runsPath;
  let totalsPath;
  const directories = new Set();
  const discovered = new Set();
  let discovery;
  let discoveryDirty = false;
  let sourceKey;
  let selectedSessionID;
  let selectionSerial = 0;
  let metadataJob;
  let sourceSettled = Promise.resolve();
  let stopLedgerWatchers = () => {};
  let stopSourceEffect = () => {};
  let disposed = false;
  let reloadTimer;
  let activityReloadTimer;
  let reloadGeneration = 0;
  let activityReloadGeneration = 0;
  let historyAppliedGeneration = 0;
  let activityAppliedGeneration = -1;
  let historyDrain;
  let activityDrain;
  const drainHistory = () => {
    if (historyDrain) return historyDrain;
    historyDrain = (async () => {
      while (!disposed && historyPath && totalsPath) {
        const generation = reloadGeneration;
        if (reloadTimer !== undefined) clearTimeout(reloadTimer);
        reloadTimer = undefined;
        await reloadHistory(store, api, historyPath, totalsPath, options.maxRecords, generation);
        if (generation !== reloadGeneration) continue;
        historyAppliedGeneration = generation;
        discoverNewFamily();
        return;
      }
    })().finally(() => {
      historyDrain = undefined;
    });
    return historyDrain;
  };
  const drainActivity = () => {
    if (activityDrain) return activityDrain;
    activityDrain = (async () => {
      while (!disposed && runsPath) {
        const generation = activityReloadGeneration;
        if (activityReloadTimer !== undefined) clearTimeout(activityReloadTimer);
        activityReloadTimer = undefined;
        const applied = await reloadActivity(store, api, runsPath, generation);
        if (generation !== activityReloadGeneration) continue;
        if (!applied && tuiActivity(store).selection.retryNeeded && !disposed) {
          // Retry an actually rejected FD snapshot, not a quiet-window guess.
          // A single drain owns I/O and disposal/generation are checked again.
          await new Promise(resolve => setTimeout(resolve, 5));
          continue;
        }
        activityAppliedGeneration = generation;
        discoverNewFamily();
        return;
      }
    })().finally(() => {
      activityDrain = undefined;
    });
    return activityDrain;
  };
  const scheduleReload = () => {
    if (disposed || !historyPath) return;
    reloadGeneration += 1;
    const generation = reloadGeneration;
    store.historyGeneration = generation;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    const run = async (attempt, expectedGeneration) => {
      if (disposed || expectedGeneration !== reloadGeneration) return;
      const sourceEpoch = store.sourceEpoch;
      reloadTimer = undefined;
      await drainHistory();
      if (disposed || sourceEpoch !== store.sourceEpoch) return;
      await probeSource(sourceEpoch);
      if (!disposed && attempt < 3 && store.optimistic.size > 0 && reloadTimer === undefined) {
        const latestGeneration = reloadGeneration;
        reloadTimer = setTimeout(() => {
          void run(attempt + 1, latestGeneration);
        }, 100);
      }
    };
    reloadTimer = setTimeout(() => {
      void run(0, generation);
    }, 30);
  };
  const scheduleActivityReload = () => {
    if (disposed || !runsPath) return;
    activityReloadGeneration += 1;
    store.activityGeneration = activityReloadGeneration;
    if (activityReloadTimer !== undefined || activityDrain) return;
    const sourceEpoch = store.sourceEpoch;
    activityReloadTimer = setTimeout(() => {
      activityReloadTimer = undefined;
      if (!disposed && sourceEpoch === store.sourceEpoch) void drainActivity().then(() => probeSource(sourceEpoch));
    }, 30);
  };
  const excludedSource = id => store.sourceScopes.isExcluded(id) || isSessionScopeExcluded(id, tuiReadModel(store).scopes, store.sessionParents);
  const probeSource = async epoch => {
    const paths = store.sourceState.paths;
    if (!paths || disposed || epoch !== store.sourceEpoch) return;
    // Publish current read outcomes, not a pre/post-stat guess or an older
    // captured error map that could overwrite a successful concurrent read.
    const {
      missing,
      errors
    } = store.sourceState;
    const unavailableSessions = store.sourceState.unavailableSessions?.filter(id => !excludedSource(id));
    const loading = historyAppliedGeneration < reloadGeneration || activityAppliedGeneration < activityReloadGeneration;
    store.sourceState = {
      ...store.sourceState,
      unavailableSessions,
      status: Object.keys(errors ?? {}).length ? "error" : loading ? "loading" : missing?.length ? "missing" : unavailableSessions?.length ? "partial" : "ready"
    };
    store.bump();
  };
  const settleSource = async epoch => {
    do {
      await Promise.all([historyAppliedGeneration < reloadGeneration ? drainHistory() : Promise.resolve(), activityAppliedGeneration < activityReloadGeneration ? drainActivity() : Promise.resolve()]);
    } while (!disposed && epoch === store.sourceEpoch && (historyAppliedGeneration < reloadGeneration || activityAppliedGeneration < activityReloadGeneration));
    await probeSource(epoch);
  };
  const familyIDs = () => {
    const ids = new Set();
    if (!selectedSessionID) return ids;
    ids.add(selectedSessionID);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, parent] of store.sessionParents) if (parent && ids.has(parent) && !ids.has(id) && !excludedSource(id)) {
        ids.add(id);
        changed = true;
      }
    }
    return ids;
  };
  const watchSources = () => {
    const paths = [...directories].map(directory => sessionSourcePaths(directory, options));
    historyPath = physicalPaths(paths.map(path => path.history));
    runsPath = physicalPaths(paths.map(path => path.runs));
    totalsPath = physicalPaths(paths.map(path => path.totals));
    store.historyGeneration = ++reloadGeneration;
    store.activityGeneration = ++activityReloadGeneration;
    const epoch = store.sourceEpoch;
    stopLedgerWatchers();
    const watchers = new Map();
    for (const [files, kind] of [[historyPath, "history"], [totalsPath, "history"], [runsPath, "runs"]]) {
      for (const path of files) {
        const entry = watchers.get(path) ?? {
          path,
          history: false,
          runs: false
        };
        entry[kind] = true;
        watchers.set(path, entry);
      }
    }
    stopLedgerWatchers = watchLedgerPaths([...watchers.values()].map(entry => ({
      path: entry.path,
      changed: () => {
        if (epoch !== store.sourceEpoch) return;
        if (entry.history) scheduleReload();
        if (entry.runs) scheduleActivityReload();
      }
    })));
  };
  const discoverSources = () => {
    discoveryDirty = true;
    if (discovery) return discovery;
    const port = api[sessionSourcePort];
    if (!port || !selectedSessionID || !store.sourceState.paths) return Promise.resolve();
    discovery = (async () => {
      while (!disposed && discoveryDirty) {
        discoveryDirty = false;
        if (!selectedSessionID || !store.sourceState.paths) return;
        const epoch = store.sourceEpoch,
          serial = selectionSerial;
        let queried = false;
        for (const id of familyIDs()) {
          if (discovered.has(id) || id !== selectedSessionID && excludedSource(id)) continue;
          discovered.add(id);
          try {
            const locations = await port.directories(id);
            if (disposed || epoch !== store.sourceEpoch || serial !== selectionSerial) {
              if (epoch === store.sourceEpoch) discovered.delete(id);
              discoveryDirty = !disposed;
              break;
            }
            queried = true;
            let added = false;
            const children = await port.children(id);
            if (disposed || epoch !== store.sourceEpoch || serial !== selectionSerial) {
              if (epoch === store.sourceEpoch) discovered.delete(id);
              discoveryDirty = !disposed;
              break;
            }
            if (store.sourceState.unavailableSessions?.includes(id)) {
              store.sourceState = {
                ...store.sourceState,
                unavailableSessions: store.sourceState.unavailableSessions.filter(missing => missing !== id)
              };
            }
            for (const directory of locations) if (!directories.has(directory)) {
              directories.add(directory);
              added = true;
            }
            for (const child of children) {
              tuiReadModel(store).observeParent(child.id, {
                parent: child.parentID,
                origin: "cache"
              });
              if (!directories.has(child.directory)) {
                directories.add(child.directory);
                added = true;
              }
              if (!discovered.has(child.id)) discoveryDirty = true;
            }
            if (added) {
              watchSources();
              await settleSource(epoch);
            }
          } catch (error) {
            if (disposed || epoch !== store.sourceEpoch || serial !== selectionSerial) {
              if (epoch === store.sourceEpoch) discovered.delete(id);
              discoveryDirty = !disposed;
              break;
            }
            const native = asRecord(error);
            // The SDK's declared error identifies the missing session. Neither
            // a generic HTTP 404 nor another resource's absence is this outcome.
            if (id !== selectedSessionID && native?._tag === "SessionNotFoundError" && native.sessionID === id) {
              store.sourceState = {
                ...store.sourceState,
                unavailableSessions: [...new Set([...(store.sourceState.unavailableSessions ?? []), id])]
              };
              queried = true;
              continue; // Retain the known ledger snapshot and do not retry this SID each round.
            }
            discovered.delete(id);
            store.sourceState = {
              ...store.sourceState,
              status: "error",
              errors: {
                ...store.sourceState.errors,
                metadata: error instanceof Error ? error.message : String(error)
              }
            };
            store.bump();
            return;
          }
        }
        if (disposed || epoch !== store.sourceEpoch || serial !== selectionSerial) continue;
        if (queried) {
          const errors = {
            ...store.sourceState.errors
          };
          delete errors.metadata;
          store.sourceState = {
            ...store.sourceState,
            errors
          };
          await probeSource(epoch);
        }
      }
    })().finally(() => {
      discovery = undefined;
    });
    return discovery;
  };
  const discoverNewFamily = () => {
    if (discovery) {
      if ([...familyIDs()].some(id => !discovered.has(id))) discoveryDirty = true;
    } else if ([...familyIDs()].some(id => !discovered.has(id))) void discoverSources();
  };
  const bindSource = (sessionID, directory) => {
    if (disposed) return Promise.resolve();
    const paths = directory ? sessionSourcePaths(directory, options) : undefined;
    const key = paths ? JSON.stringify([directory, paths.history, paths.runs, paths.totals]) : "waiting-metadata";
    if (key === sourceKey) {
      if (store.sourceState.sessionID !== sessionID) {
        api[sessionSourcePort]?.bind(directory, sessionID);
        if (sessionID && store.sourceState.unavailableSessions?.includes(sessionID)) discovered.delete(sessionID);
        const previous = store.sourceState.sessionID;
        const sameFamily = !!previous && !!sessionID && tuiReadModel(store).root(previous) === tuiReadModel(store).root(sessionID);
        store.sourceState = {
          ...store.sourceState,
          sessionID
        };
        store.focusSessionID = sessionID;
        store.bump();
        if (!sameFamily && paths) {
          directories.clear();
          directories.add(directory);
          discovered.clear();
          const snapshots = snapshotsFor(store);
          const current = {
            history: resolve(paths.history),
            totals: resolve(paths.totals),
            runs: resolve(paths.runs)
          };
          for (const ledger of ["history", "totals", "runs"]) {
            for (const file of snapshots[ledger].keys()) if (file !== current[ledger]) snapshots[ledger].delete(file);
          }
          for (const [key, outcome] of snapshots.outcomes) {
            if (outcome.path !== current[outcome.ledger]) snapshots.outcomes.delete(key);
          }
          const errors = {},
            missing = [];
          for (const outcome of snapshots.outcomes.values()) {
            if (outcome.result === "missing") missing.push(outcome.path);else if (typeof outcome.result === "object") errors[outcome.ledger] = outcome.result.error;
          }
          store.sourceState = {
            ...store.sourceState,
            errors,
            missing,
            unavailableSessions: undefined,
            loaded: {
              history: snapshots.history.has(current.history),
              totals: snapshots.totals.has(current.totals),
              runs: snapshots.runs.has(current.runs)
            }
          };
          if (historyPath?.length !== 1 || totalsPath?.length !== 1 || runsPath?.length !== 1) {
            if (reloadTimer !== undefined) clearTimeout(reloadTimer);
            reloadTimer = undefined;
            if (activityReloadTimer !== undefined) clearTimeout(activityReloadTimer);
            activityReloadTimer = undefined;
            watchSources();
            sourceSettled = settleSource(store.sourceEpoch);
          }
        }
        sourceSettled = sourceSettled.then(() => discoverSources());
      } else if (!discovery && [...familyIDs()].some(id => !discovered.has(id))) {
        sourceSettled = sourceSettled.then(() => discoverSources());
      }
      return sourceSettled;
    }
    sourceKey = key;
    selectionSerial++;
    metadataJob = undefined;
    stopLedgerWatchers();
    stopLedgerWatchers = () => {};
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    reloadTimer = undefined;
    if (activityReloadTimer !== undefined) clearTimeout(activityReloadTimer);
    activityReloadTimer = undefined;
    const retain = !!paths && !!store.sourceState.paths && (store.sourceState.sessionID === sessionID || !!sessionID && !!store.sourceState.sessionID && tuiReadModel(store).root(sessionID) === tuiReadModel(store).root(store.sourceState.sessionID));
    if (!retain) {
      clearRuntimeSource(store);
      directories.clear();
      discovered.clear();
    }
    store.historyGeneration = ++reloadGeneration;
    store.activityGeneration = ++activityReloadGeneration;
    historyPath = undefined;
    runsPath = undefined;
    totalsPath = undefined;
    const port = api[sessionSourcePort];
    store.sourceState = {
      ...(retain ? store.sourceState : {}),
      status: paths ? "loading" : "waiting-metadata",
      epoch: store.sourceEpoch,
      sessionID,
      directory,
      paths,
      loaded: retain ? store.sourceState.loaded : {
        history: false,
        totals: false,
        runs: false
      },
      live: !!directory && (!!port || directory === launchDirectory)
    };
    port?.bind(directory, sessionID);
    store.focusSessionID = sessionID;
    store.bump();
    if (!paths) {
      historyAppliedGeneration = reloadGeneration;
      activityAppliedGeneration = activityReloadGeneration;
      sourceSettled = Promise.resolve();
      return sourceSettled;
    }
    const epoch = store.sourceEpoch;
    directories.add(directory);
    if (retain && sessionID) discovered.delete(sessionID);
    watchSources();
    sourceSettled = settleSource(epoch).then(() => discoverSources());
    return sourceSettled;
  };
  const selectSession = (sessionID, fetchMetadata = true) => {
    if (disposed) return Promise.resolve();
    if (sessionID !== selectedSessionID) {
      selectedSessionID = sessionID;
      selectionSerial++;
      metadataJob = undefined;
    }
    let directory;
    let metadataError;
    try {
      directory = sessionID ? sessionSourceDirectory(api, sessionID) : launchDirectory;
    } catch (error) {
      metadataError = error;
    }
    const bound = untrack(() => bindSource(sessionID, directory));
    const serial = selectionSerial;
    const port = api[sessionSourcePort];
    if (!directory && sessionID && port && fetchMetadata) {
      if (metadataJob?.id === sessionID) return metadataJob.promise;
      const promise = Promise.resolve().then(() => port.sync(sessionID)).then(() => {
        if (!disposed && serial === selectionSerial) return selectSession(sessionID, false);
      }).catch(error => {
        if (disposed || serial !== selectionSerial) return;
        store.sourceState = {
          ...store.sourceState,
          status: "error",
          errors: {
            metadata: error instanceof Error ? error.message : String(error)
          }
        };
        store.bump();
      }).finally(() => {
        if (metadataJob?.promise === promise) metadataJob = undefined;
      });
      metadataJob = {
        id: sessionID,
        promise
      };
      return promise;
    }
    if (metadataError) {
      store.sourceState = {
        ...store.sourceState,
        status: "error",
        errors: {
          metadata: String(metadataError)
        }
      };
      store.bump();
    }
    return bound;
  };
  const sourcePort = api[sessionSourcePort];
  const stopSourceChanges = sourcePort?.onChanged(id => {
    if (!familyIDs().has(id)) return;
    discovered.delete(id);
    if (discovery) discoveryDirty = true;
    // Source discovery is read-only. The selected source stays bound here;
    // descendants prove live ownership separately from their native metadata.
    sourceSettled = selectSession(selectedSessionID);
  });
  const openHistory = () => {
    const sessionID = currentSessionID(api);
    api.route.navigate(HISTORY_ROUTE, sessionID ? {
      sessionID
    } : undefined);
  };
  try {
    api.route.register([{
      name: HISTORY_ROUTE,
      render: ({
        params
      }) => {
        const popMode = api.mode.push(HISTORY_MODE);
        onCleanup(popMode);
        return _$createComponent(HistoryView, {
          api: api,
          store: store,
          get sessionID() {
            return routeSessionID(params);
          },
          options: options
        });
      }
    }]);
    registerTokenPulseCommands(api, store, options, openHistory);
    api.keymap.registerLayer({
      mode: HISTORY_MODE,
      priority: 100,
      commands: [{
        name: "oc-tps.history.back",
        title: "Return from token history",
        desc: "Return to the current session or home",
        category: "Plugin",
        run: () => leaveHistory(api)
      }],
      bindings: [{
        key: "escape",
        cmd: "oc-tps.history.back",
        desc: "Return to current session"
      }]
    });
  } catch (error) {
    warnWithToast(api, "keymap registration failed; using legacy command API", error);
    const details = createDetailsController(api, store);
    registerLegacyCommand(api, openHistory, () => {
      details.open();
    }, options);
  }
  api.slots.register(createTuiSlotPlugin(api, store, options, id => {
    setSidebarSessionID(id);
  }));

  // The generated SDK union can lag runtime legacy/v2 event names; keep this cast local.
  const eventOn = api.event.on;
  const subscribe = (type, handler) => {
    try {
      const dispose = once(eventOn.call(api.event, type, handler));
      api.lifecycle.onDispose(dispose);
    } catch (error) {
      console.warn(`[oc-tps] event subscription unavailable for ${type}`, error);
    }
  };
  const handleEvent = (input, _metadata) => {
    if (disposed) return;
    const event = normalizeEvent(input);
    if (!event) return;
    const type = eventType(event);
    // Content streaming does no Pulse work: no clocks, session lookup, task
    // migration, part snapshot, hash, sample, or totals revision.
    if (type === "message.part.delta" || type === "message.part.updated" || type === "session.next.text.delta" || type === "session.next.reasoning.delta" || type === "session.next.tool.input.delta") return;
    if (!store.sourceState.paths || !store.sourceState.live) return;
    const eventDirectory = readString(event.sourceDirectory) ?? _metadata?.directory;
    if (eventDirectory && eventDirectory !== store.sourceState.directory) {
      const id = readSessionID(eventProperties(event), event);
      if (!id || !api[sessionSourcePort]?.owns(id, eventDirectory)) return;
    }
    const receivedAt = Date.now();
    try {
      const properties = eventProperties(event);
      if (type === "pulse.activity") {
        const fact = asRecord(properties.fact);
        if (fact) {
          recordTuiActivityFact(store, fact, event);
          store.bump();
        }
        return;
      }
      if (type === "server.connected" || type === "server.instance.disposed" || type.startsWith("workspace.")) {
        recordTuiObservationLifecycle(store, type, properties, event, receivedAt);
        return;
      }
      const eventSessionID = readSessionID(properties, event);
      if (!api[sessionSourcePort] && eventSessionID && !eventDirectory) {
        const directory = sessionSourceDirectory(api, eventSessionID);
        if (directory && directory !== store.sourceState.directory) return;
      }
      if (type === "session.created" || type === "session.updated") {
        const mapped = cacheSessionParentFromEvent(store, event);
        const sessionID = readSessionID(properties, event);
        if (sessionID) rootSessionIDFor(store, api, sessionID);
        if (mapped) store.bump();
        discoverNewFamily();
        scheduleActivityReload();
        return;
      }
      if (eventSessionID) rootSessionIDFor(store, api, eventSessionID);
      if (type === "session.next.step.started") {
        recordStepStarted(store, properties, event);
        return;
      }
      if (type === "session.next.step.ended") {
        recordStepFallback(store, properties, event);
        return;
      }
      if (type === "message.updated") {
        if (handleMessageUpdated(store, api, properties, event, options.bytesPerToken, receivedAt)) {
          scheduleReload();
        }
        scheduleActivityReload();
        return;
      }
      if (isSessionLifecycleEventType(type)) {
        const changed = handleSessionLifecycle(store, api, type, properties, event, options.bytesPerToken);
        if (changed) scheduleReload();
        scheduleActivityReload();
      }
    } catch (error) {
      console.warn("[oc-tps] event parsing failed", error);
    }
  };
  subscribe("message.part.delta", handleEvent);
  subscribe("message.part.updated", handleEvent);
  subscribe("session.next.tool.input.delta", handleEvent);
  subscribe("session.next.text.delta", handleEvent);
  subscribe("session.next.reasoning.delta", handleEvent);
  subscribe("message.updated", handleEvent);
  subscribe("pulse.activity", handleEvent);
  subscribe("session.next.step.started", handleEvent);
  subscribe("session.next.step.ended", handleEvent);
  subscribe("session.idle", handleEvent);
  subscribe("session.status", handleEvent);
  subscribe("session.next.retried", handleEvent);
  subscribe("session.next.step.failed", handleEvent);
  subscribe("session.error", handleEvent);
  subscribe("session.abort", handleEvent);
  subscribe("session.aborted", handleEvent);
  subscribe("session.cancel", handleEvent);
  subscribe("session.cancelled", handleEvent);
  subscribe("session.stop", handleEvent);
  subscribe("session.stopped", handleEvent);
  subscribe("session.completed", handleEvent);
  subscribe("session.created", handleEvent);
  subscribe("session.updated", handleEvent);
  subscribe("server.connected", handleEvent);
  subscribe("server.instance.disposed", handleEvent);
  subscribe("workspace.status", handleEvent);
  subscribe("workspace.status.changed", handleEvent);
  subscribe("workspace.disposed", handleEvent);
  subscribe("workspace.deleted", handleEvent);
  const interval = setInterval(() => {
    if (!disposed && hasLiveTaskWallActivity(store)) store.tick();
  }, 500);
  api.lifecycle.onDispose(() => {
    disposed = true;
    store.disposed = true;
    store.activityGeneration++;
    store.historyGeneration++;
    stopSourceEffect();
    selectionSerial++;
    metadataJob = undefined;
    stopSourceChanges?.();
    stopLedgerWatchers();
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    if (activityReloadTimer !== undefined) clearTimeout(activityReloadTimer);
    clearInterval(interval);
    clearRuntimeSource(store);
    store.disposeSignals();
  });
  createRoot(dispose => {
    stopSourceEffect = dispose;
    createEffect(() => {
      const sidebar = sidebarSessionID();
      const route = sidebar ? undefined : api.route.current;
      void selectSession(sidebar ?? routeSessionID(route && "params" in route ? route.params : undefined));
    });
  });
  const initialSidebar = sidebarSessionID();
  const initialRoute = initialSidebar ? undefined : api.route.current;
  const initialSelection = selectSession(initialSidebar ?? routeSessionID(initialRoute && "params" in initialRoute ? initialRoute.params : undefined));
  // Unknown metadata must not block plugin registration or make an empty launch
  // directory look authoritative. A later fenced sync can bind the first source.
  if (store.sourceState.paths) await initialSelection;
  return {
    store,
    selectSession,
    settled: () => metadataJob?.promise ?? discovery ?? sourceSettled
  };
};
const plugin = {
  ...Plugin.define({
    id: "oc-tps",
    async setup(context) {
      const options = resolveOptions(context.options);
      if (!options.enabled) return;
      const bridge = createV2TuiBridge(context, tokenPulseBindings(options));
      try {
        await initializeTui(bridge.api, context.options);
      } catch (error) {
        await bridge.dispose();
        throw error;
      }
      return () => bridge.dispose();
    }
  }),
  tui: initializeTui
};
export default plugin;
