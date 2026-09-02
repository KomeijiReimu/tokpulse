import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */

import { isAbsolute, join } from "node:path";
import { createMemo, createRoot, createSignal, onCleanup } from "solid-js";
import { DEFAULT_BYTES_PER_TOKEN, DEFAULT_ROLLING_WINDOW_MS, HISTORY_VERSION, addTokenCounts, aggregateSession, aggregateSessionTree, calculateSpeedStats, calibrateResponseSamples, bytesToTokens, durationOf, emptyTokenCounts, formatDuration, formatNumber, normalizeTokenCounts, rollingTokenRate, timeToFirstToken, utf8ByteLength } from "./core.js";
import { DEFAULT_MAX_RECORDS, readHistoryFile } from "./storage.js";
const DEFAULT_HISTORY_PATH = ".opencode/oc-tps/history.jsonl";
const HISTORY_ROUTE = "oc-tps-history";
const HISTORY_MODE = "oc-tps.history";
const COMMAND_NAME = "oc-tps.history";
const SPARK_CHARS = ".:-=+#";
const recordQualityByObject = new WeakMap();
function lifecycleStateAt(events, timestamp) {
  return events.filter(event => event.timestamp <= timestamp).at(-1)?.state;
}
function mergeLifecycleEvents(left, right) {
  const byTimestamp = new Map();
  for (const event of [...left, ...right]) {
    const existing = byTimestamp.get(event.timestamp);
    if (!existing || activeTaskSessionState(event.state) && !activeTaskSessionState(existing.state)) {
      byTimestamp.set(event.timestamp, {
        ...event
      });
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
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
function readDelta(properties, event) {
  const values = [properties.delta, properties.text, properties.content, getPath(properties, "part.delta"), getPath(properties, "part.text"), event.delta, event.text];
  return values.find(value => typeof value === "string" && value.length > 0);
}
function inferKind(properties, event) {
  const values = [properties.kind, properties.type, properties.field, getPath(properties, "part.type"), event.kind, event.type];
  return values.some(value => typeof value === "string" && value.toLowerCase().includes("reason")) ? "reasoning" : "output";
}
function modelName(value) {
  if (!value) return undefined;
  const direct = readString(value.model);
  if (direct) return direct;
  const model = asRecord(value.model);
  return readStringFrom([model, value], ["modelID", "modelId", "id", "name"]);
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
function mergeIntervals(left, right) {
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
  const target = run.phase === "active" ? run.lifecycleEvents : run.pendingLifecycleEvents;
  const events = target.get(sessionID) ?? [];
  const existing = events.find(event => event.timestamp === timestamp);
  if (existing) {
    if (existing.state === state) return false;
    if (activeTaskSessionState(existing.state) && !activeTaskSessionState(state)) return false;
    existing.state = state;
  } else {
    events.push({
      state,
      timestamp
    });
    events.sort((left, right) => left.timestamp - right.timestamp);
  }
  target.set(sessionID, events);
  return true;
}
function rebuildActiveIntervals(run, through) {
  const computedIntervals = lifecycleIntervals(run.lifecycleEvents, through);
  const intervals = mergeIntervals(run.carriedIntervals, computedIntervals);
  run.activeIntervals = intervals;
  run.activeElapsed = intervalElapsed(intervals);
}
function lifecycleIntervals(lifecycleEvents, through) {
  const points = [...lifecycleEvents.values()].flatMap(events => events.map(event => event.timestamp)).sort((left, right) => left - right);
  if (through !== undefined && Number.isFinite(through)) points.push(through);
  points.sort((left, right) => left - right);
  const uniquePoints = [...new Set(points)];
  const computedIntervals = [];
  for (let index = 0; index < uniquePoints.length; index += 1) {
    const start = uniquePoints[index];
    const end = uniquePoints[index + 1];
    if (end === undefined || end <= start) continue;
    const active = [...lifecycleEvents.values()].some(events => activeTaskSessionState(lifecycleStateAt(events, start)));
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
  run.carriedIntervals = [];
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
  run.runStartedAt = earliestActiveTimestamp(run) ?? timestamp;
  rebuildActiveIntervals(run);
}
function recordTaskSessionActivity(run, sessionID, state, timestamp) {
  run.participantSessions.add(sessionID);
  if (!recordLifecycleEvent(run, sessionID, state, timestamp)) return false;
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
  const startedAt = run.runStartedAt ?? timestamp;
  const activityEnd = Math.max(timestamp, ...run.lastActivityAt.values());
  rebuildActiveIntervals(run, activityEnd);
  const completedIntervals = [...run.activeIntervals];
  const completedActiveElapsed = intervalElapsed(completedIntervals);
  const summary = {
    runEpoch: run.runEpoch,
    startedAt,
    completedAt: activityEnd,
    wallTime: Math.max(0, completedActiveElapsed)
  };
  run.lastRunIntervals = completedIntervals;
  run.lastRunLifecycleEvents = new Map([...run.lifecycleEvents.entries()].map(([sessionID, events]) => [sessionID, events.map(event => ({
    ...event
  }))]));
  run.lastRunCarriedIntervals = cloneIntervals(run.carriedIntervals);
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
  const previous = run.lastRunLifecycleEvents.get(sessionID) ?? [];
  const next = mergeLifecycleEvents(previous, [{
    state,
    timestamp
  }]);
  run.lastRunLifecycleEvents.set(sessionID, next);
  const computed = lifecycleIntervals(run.lastRunLifecycleEvents, run.lastRunWallTime.completedAt);
  run.lastRunIntervals = mergeIntervals(run.lastRunCarriedIntervals, computed);
  run.lastRunWallTime = {
    ...run.lastRunWallTime,
    startedAt: Math.min(run.lastRunWallTime.startedAt, ...run.lastRunIntervals.map(interval => interval.start)),
    wallTime: intervalElapsed(run.lastRunIntervals)
  };
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
  const state = direct ?? pending ?? createActiveState(messageID ?? pendingID, sessionID, timestamp);
  if (messageID) state.messageID = messageID;
  if (messageID && pending && state === pending) active.delete(pendingID);
  return state;
}
export function takeActiveState(active, messageID, sessionID) {
  const direct = active.get(messageID);
  const pendingID = pendingKey(sessionID);
  const state = direct ?? active.get(pendingID);
  if (!state || state.sessionID !== sessionID) return undefined;
  active.delete(messageID);
  if (!direct) active.delete(pendingID);
  state.messageID = messageID;
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
  const firstToken = infoTimeValue(input.info, ["firstToken", "firstTokenAt"]) ?? input.state?.firstTokenAt;
  const completed = infoTimeValue(input.info, ["end", "completed"]) ?? input.completedAt;
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
    cost: Math.max(0, Number.isFinite(input.cost) ? input.cost : 0),
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
    quality: input.quality ?? "exact"
  };
  recordQualityByObject.set(record, input.quality ?? "exact");
  return record;
}
export function makeTokens(info, state, bytesPerToken) {
  const exact = tokenFields(info);
  const fallback = state?.fallbackTokens ?? {};
  const estimate = estimateActiveTokens(state, bytesPerToken);
  const cacheRead = exact.cacheRead === undefined ? fallback.cacheRead ?? 0 : exact.cacheRead === 0 && (fallback.cacheRead ?? 0) > 0 ? fallback.cacheRead : exact.cacheRead;
  const cacheWrite = exact.cacheWrite === undefined ? fallback.cacheWrite ?? 0 : exact.cacheWrite === 0 && (fallback.cacheWrite ?? 0) > 0 ? fallback.cacheWrite : exact.cacheWrite;
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
function completedElapsed(record) {
  const completed = record.time.completed ?? record.time.start;
  const firstToken = record.time.firstToken;
  if (firstToken !== undefined) return Math.max(0, completed - firstToken);
  return Math.max(0, durationOf(record) ?? 0);
}
export function makeLastCompletedSnapshot(record, runEpoch = 0, estimated = false) {
  const elapsed = completedElapsed(record);
  const generated = record.tokens.output + record.tokens.reasoning;
  return {
    record,
    rate: elapsed > 0 ? generated * 1000 / elapsed : 0,
    generated,
    ...(timeToFirstToken(record) !== undefined ? {
      ttft: timeToFirstToken(record)
    } : {}),
    elapsed,
    runEpoch,
    estimated
  };
}
function commitRecord(store, record, markCompleted) {
  const quality = markCompleted ? "exact" : "provisional";
  if (!markCompleted && store.completedMessageIDs.has(record.messageID)) return;
  if (markCompleted && store.completedMessageIDs.has(record.messageID) && store.records.some(entry => entry.messageID === record.messageID && historyRecordsEquivalent(entry, record))) return;
  const selected = selectCommitRecord(store, record, quality);
  const effectiveRecord = selected.record;
  const effectiveQuality = selected.quality ?? "exact";
  const existingRuntime = getSessionRuntime(store, record.sessionID);
  const existingContribution = existingRuntime.contributions.get(record.messageID) ?? existingRuntime.completedContributions.get(record.messageID);
  const runtime = existingContribution ? existingRuntime : ensureSessionRun(store, record.sessionID, record.time.start);
  const historicalEpoch = existingRuntime.completedContributions.get(record.messageID)?.runEpoch;
  if (runtime.contributions.get(record.messageID)?.quality === "exact" && effectiveQuality === "provisional") return;
  const applied = applyRecordToSessionRuntime(runtime, effectiveRecord, effectiveQuality);
  if (!applied && runtime.contributions.get(record.messageID)?.record !== effectiveRecord && runtime.completedContributions.get(record.messageID)?.record !== effectiveRecord) return;
  runtime.status = effectiveQuality === "exact" ? runtime.status : "busy";
  if (runtime.activeMessageID === record.messageID) runtime.activeMessageID = undefined;
  if (markCompleted || effectiveQuality === "exact") store.completedMessageIDs.add(record.messageID);
  if (selected.source === "incoming") addOptimisticRecord(store, effectiveRecord, effectiveQuality);
  const contributionEpoch = runtime.completedContributions.get(record.messageID)?.runEpoch ?? runtime.contributions.get(record.messageID)?.runEpoch ?? historicalEpoch ?? runtime.runEpoch;
  const snapshot = makeLastCompletedSnapshot(effectiveRecord, contributionEpoch, effectiveQuality === "provisional");
  const previousSnapshot = store.lastCompletedBySession.get(effectiveRecord.sessionID);
  if (previousSnapshot === undefined || previousSnapshot.record.messageID === effectiveRecord.messageID || contributionEpoch > previousSnapshot.runEpoch || contributionEpoch === previousSnapshot.runEpoch && recordCompletedAt(effectiveRecord) >= recordCompletedAt(previousSnapshot.record)) {
    store.lastCompletedBySession.set(effectiveRecord.sessionID, snapshot);
  }
}
function parentSessionID(api, sessionID, info, store) {
  let stateParent;
  try {
    const session = api.state.session.get(sessionID);
    if (session?.parentID) stateParent = session.parentID;
  } catch {
    // State can still be syncing while a response completes.
  }
  return stateParent ?? readStringFrom([info], ["parentSessionID", "parentSessionId", "parentID"]) ?? store?.sessionParents.get(sessionID);
}
function knownRootSessionID(store, sessionID) {
  let root = sessionID;
  const visited = new Set();
  while (!visited.has(root)) {
    visited.add(root);
    const parent = store.sessionParents.get(root);
    if (!parent) break;
    root = parent;
  }
  return root;
}
function rewriteRecordParent(record, parentSessionID) {
  if (parentSessionID === undefined || record.parentSessionID === parentSessionID) return record;
  const next = {
    ...record,
    parentSessionID
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
  const sourceIntervals = sourceWasActive ? source.activeIntervals : mergeIntervals(source.lastRunIntervals, source.carriedIntervals);
  const carriedSourceIntervals = mergeIntervals(source.lastRunIntervals, source.carriedIntervals);
  const sourceLifecycleEvents = sourceWasActive ? source.lifecycleEvents : source.lastRunLifecycleEvents;
  const activeCandidates = new Set([...target.activeSessions, ...source.activeSessions]);
  target.rootSessionID = rootSessionID;
  target.phase = target.phase === "active" || source.phase === "active" ? "active" : "idle";
  target.runEpoch = Math.max(target.runEpoch, source.runEpoch);
  target.rootBusy = target.rootBusy || source.rootBusy;
  target.rootObserved = target.rootObserved || source.rootObserved;
  target.hasExplicitRootStart = target.hasExplicitRootStart || source.hasExplicitRootStart;
  target.lastRunIntervals = mergeIntervals(target.lastRunIntervals, carriedSourceIntervals);
  if (targetWasActive) {
    target.carriedIntervals = mergeIntervals(target.carriedIntervals, sourceWasActive ? source.carriedIntervals : carriedSourceIntervals);
  } else if (sourceWasActive) {
    target.carriedIntervals = cloneIntervals(source.carriedIntervals);
  } else {
    target.carriedIntervals = [];
  }
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
  if (target.phase === "active") rebuildActiveIntervals(target);else {
    target.lastRunLifecycleEvents = lifecycleCandidates;
    target.lastRunCarriedIntervals = mergeIntervals(target.lastRunCarriedIntervals, source.lastRunCarriedIntervals);
    target.lastRunIntervals = mergeIntervals(target.lastRunIntervals, target.lastRunCarriedIntervals);
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
  if (!sessionID || !parentID || sessionID === parentID) return false;
  const previous = store.sessionParents.get(sessionID);
  if (previous !== parentID) store.sessionParents.set(sessionID, parentID);
  const repaired = repairKnownParents(store);
  const rootSessionID = knownRootSessionID(store, sessionID);
  const migrated = migrateTaskWallRuns(store, rootSessionID);
  return previous !== parentID || repaired || migrated;
}
function sessionEventSources(properties, event) {
  return [asRecord(properties.info), asRecord(properties.session), asRecord(event.info), asRecord(event.session), properties, event].filter(value => value !== undefined);
}
export function cacheSessionParentFromEvent(store, input) {
  const event = normalizeEvent(input);
  if (!event) return false;
  const type = eventType(event);
  if (type !== "session.created" && type !== "session.updated") return false;
  const properties = eventProperties(event);
  const sessionID = readSessionID(properties, event);
  const parentID = readStringFrom(sessionEventSources(properties, event), ["parentID", "parentSessionID", "parentSessionId", "parent.id"]);
  if (!sessionID || !parentID) return false;
  return rememberSessionParent(store, sessionID, parentID);
}
function rootSessionIDFor(store, api, sessionID, info) {
  const parent = parentSessionID(api, sessionID, info, store);
  if (parent) rememberSessionParent(store, sessionID, parent);
  const rootSessionID = knownRootSessionID(store, sessionID);
  migrateTaskWallRuns(store, rootSessionID);
  return rootSessionID;
}
function getTaskWallRun(store, rootSessionID) {
  migrateTaskWallRuns(store, rootSessionID);
  const existing = store.taskRuns.get(rootSessionID);
  if (existing) return existing;
  const run = createTaskWallRun(rootSessionID);
  store.taskRuns.set(rootSessionID, run);
  return run;
}
function findTaskWallRun(store, rootSessionID, sessionID) {
  const direct = store.taskRuns.get(rootSessionID);
  if (direct) return direct;
  for (const [key, run] of store.taskRuns) {
    if (key === sessionID || run.rootSessionID === sessionID || run.participantSessions.has(sessionID) || run.activeSessions.has(sessionID) || run.sessionStates.has(sessionID) || run.pendingSessions.has(sessionID)) {
      return run;
    }
  }
  return undefined;
}
export function taskWallTimeForSession(store, sessionID, now = Date.now()) {
  if (!sessionID) return undefined;
  const rootSessionID = knownRootSessionID(store, sessionID);
  migrateTaskWallRuns(store, rootSessionID);
  const run = findTaskWallRun(store, rootSessionID, sessionID);
  if (!run) return undefined;
  if (run.phase === "active" && run.runStartedAt !== undefined) {
    rebuildActiveIntervals(run, now);
    return Math.max(0, run.activeElapsed);
  }
  if (run.lastRunWallTime) return run.lastRunWallTime.wallTime;
  return undefined;
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
function recordDelta(store, properties, event, stream, explicitKind, bytesPerToken) {
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const parentID = readStringFrom([properties, event], ["parentSessionID", "parentSessionId", "parentID"]);
  if (parentID) rememberSessionParent(store, sessionID, parentID);
  const messageID = readMessageID(properties);
  const delta = readDelta(properties, event);
  if (!delta) return;
  const timestamp = eventTimestamp(event, properties);
  const runtime = ensureSessionRun(store, sessionID, timestamp);
  const existingState = (messageID ? store.active.get(messageID) : undefined) ?? store.active.get(pendingKey(sessionID));
  const bytes = utf8ByteLength(delta);
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  const sample = {
    timestamp,
    tokens: estimatedTokens,
    estimatedTokens,
    bytes,
    kind: explicitKind ?? inferKind(properties, event)
  };
  if (existingState?.selectedSource !== undefined && existingState.selectedSource !== stream) {
    existingState[stream].hasData = true;
    existingState[stream].samples.push(sample);
    existingState[stream].samples.sort((left, right) => left.timestamp - right.timestamp);
    if (messageID) runtime.activeMessageID = messageID;
    store.bump();
    return;
  }
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  if (state.sessionID !== sessionID) return;
  state.selectedSource = lockStreamSource(state.selectedSource, stream);
  state.startedAt = Math.min(state.startedAt, timestamp);
  state.firstTokenAt = state.firstTokenAt ?? timestamp;
  runtime.runFirstTokenAt = runtime.runFirstTokenAt === undefined ? timestamp : Math.min(runtime.runFirstTokenAt, timestamp);
  if (messageID) runtime.activeMessageID = messageID;
  state[stream].hasData = true;
  state[stream].samples.push(sample);
  state[stream].samples.sort((left, right) => left.timestamp - right.timestamp);
  store.active.set(messageID ?? pendingKey(sessionID), state);
  store.bump();
}
function recordStepStarted(store, properties, event) {
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const timestamp = eventTimestamp(event, properties);
  const runtime = ensureSessionRun(store, sessionID, timestamp);
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.startedAt = Math.min(state.startedAt, timestamp);
  state.model = state.model ?? modelName(properties);
  if (messageID) runtime.activeMessageID = messageID;
  store.active.set(messageID ?? pendingKey(sessionID), state);
  store.bump();
}
function recordStepFallback(store, properties, event) {
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const timestamp = eventTimestamp(event, properties);
  const runtime = ensureSessionRun(store, sessionID, timestamp);
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.fallbackTokens = mergeTokenFields(state.fallbackTokens, tokenFields(properties.tokens ?? properties));
  state.model = state.model ?? modelName(properties);
  state.cost = state.cost ?? readNumber(properties.cost);
  if (messageID) runtime.activeMessageID = messageID;
  store.active.set(messageID ?? pendingKey(sessionID), state);
  store.bump();
}
function baseHistoryRecords(store) {
  if (store.diskRecords.length > 0 || store.records.length === 0) return store.diskRecords;
  const optimisticIDs = new Set(store.optimistic.keys());
  return store.records.filter(record => !optimisticIDs.has(record.messageID));
}
function preferredHistoryLayer(candidate, existing) {
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
  if (candidateQuality === "exact" && existingQuality === "exact") {
    if (candidate.source !== "disk" && existing.source === "disk") return candidate;
    if (existing.source !== "disk" && candidate.source === "disk") return existing;
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
  store.optimistic.set(record.messageID, record);
  store.optimisticQuality.set(record.messageID, quality);
  store.optimisticOrder.set(record.messageID, store.nextOptimisticOrder);
  store.nextOptimisticOrder += 1;
  store.records = mergeHistoryLayers(baseHistoryRecords(store), store.optimistic, store.maxRecords, store.optimisticQuality, store.optimisticOrder);
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
function handleMessageUpdated(store, api, properties, event, bytesPerToken) {
  const info = eventInfo(properties, event);
  if (!info || info.role !== "assistant") return false;
  const messageID = readMessageID(properties, info);
  const sessionID = readStringFrom([info, properties, event], ["sessionID", "sessionId", "session.id"]);
  if (!messageID || !sessionID) return false;
  const timestamp = eventTimestamp(event, properties);
  if (!isCompleted(info, properties, event)) {
    const runtime = ensureSessionRun(store, sessionID, timestamp);
    const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
    state.startedAt = Math.min(state.startedAt, infoTimeValue(info, ["start", "created"]) ?? timestamp);
    state.model = state.model ?? modelName(info);
    state.cost = state.cost ?? readNumber(info.cost);
    state.fallbackTokens = mergeTokenFields(state.fallbackTokens, tokenFields(info.tokens));
    runtime.activeMessageID = messageID;
    store.active.set(messageID, state);
    store.bump();
    return false;
  }
  const state = takeActiveState(store.active, messageID, sessionID);
  const tokens = makeTokens(info, state, bytesPerToken);
  const record = makeHistoryRecord({
    messageID,
    sessionID,
    parentSessionID: parentSessionID(api, sessionID, info, store),
    model: modelName(info) ?? state?.model,
    cost: readNumber(info.cost) ?? state?.cost ?? 0,
    tokens,
    samples: calibrateResponseSamples(finalSamples(state), {
      output: tokens.output,
      reasoning: tokens.reasoning
    }),
    state,
    info,
    completedAt: timestamp,
    quality: "exact"
  });
  commitRecord(store, record, true);
  noteTaskRecord(store, api, record);
  return true;
}
function flushIdleStates(store, api, sessionID, bytesPerToken, completedAt = Date.now()) {
  let flushed = false;
  const entries = [...store.active.entries()].filter(([, state]) => state.sessionID === sessionID);
  for (const [key, state] of entries) {
    store.active.delete(key);
    if (state.messageID.startsWith("__pending__:")) continue;
    const tokens = makeTokens(undefined, state, bytesPerToken);
    const record = makeHistoryRecord({
      messageID: state.messageID,
      sessionID,
      parentSessionID: parentSessionID(api, sessionID, undefined, store),
      model: state.model,
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
  if (type === "session.idle") return "idle";
  if (type !== "session.status" && !type.endsWith(".status")) return undefined;
  const value = properties.status ?? properties.state ?? event.status;
  const name = statusName(value);
  if (name === "busy" || name === "retry") return name;
  if (terminalStatus(value)) return "idle";
  return undefined;
}
function finishSessionRun(store, api, sessionID, bytesPerToken, completedAt) {
  const runtime = getSessionRuntime(store, sessionID);
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
export function handleSessionLifecycle(store, api, type, properties, event, bytesPerToken) {
  const sessionID = readSessionID(properties, event);
  const status = sessionRunStatus(type, properties, event);
  if (!sessionID || status === undefined) return false;
  const timestamp = eventTimestamp(event, properties);
  const eventParent = readStringFrom(sessionEventSources(properties, event), ["parentID", "parentSessionID", "parentSessionId", "parent.id"]);
  if (eventParent) rememberSessionParent(store, sessionID, eventParent);
  const rootSessionID = rootSessionIDFor(store, api, sessionID);
  const taskRun = status === "idle" ? findTaskWallRun(store, rootSessionID, sessionID) ?? getTaskWallRun(store, rootSessionID) : getTaskWallRun(store, rootSessionID);
  if (status === "idle") {
    const finishedSession = finishSessionRun(store, api, sessionID, bytesPerToken, timestamp);
    const finishedTask = taskRun ? transitionTaskWallRun(taskRun, sessionID, "idle", timestamp) : undefined;
    if (finishedTask) store.bump();
    return finishedSession || finishedTask !== undefined;
  }
  if (!taskRun) return false;
  const runtime = getSessionRuntime(store, sessionID);
  const changed = transitionSessionRuntime(runtime, status, timestamp);
  const finishedTask = transitionTaskWallRun(taskRun, sessionID, status, timestamp);
  if (changed) store.bump();
  if (finishedTask) store.bump();
  return false;
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
  return left.messageID === right.messageID && left.sessionID === right.sessionID && left.parentSessionID === right.parentSessionID && left.model === right.model && left.cost === right.cost && tokenCountsEqual(left.tokens, right.tokens) && left.time.start === right.time.start && left.time.firstToken === right.time.firstToken && left.time.completed === right.time.completed && left.time.ttft === right.time.ttft && left.time.duration === right.time.duration && (left.quality ?? "exact") === (right.quality ?? "exact");
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
function hydrateHistoryState(store, diskRecords) {
  for (const record of diskRecords) {
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
      if (preferred.record === overlay) {
        selected = overlay;
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
      removeOptimisticRecord(store, record.messageID);
    }
    store.completedMessageIDs.add(record.messageID);
    const runtime = store.sessionRuntime.get(record.sessionID);
    if (runtime?.contributions.has(record.messageID)) {
      applyRecordToSessionRuntime(runtime, selected, "exact");
    }
    const existing = store.lastCompletedBySession.get(record.sessionID);
    if (existing === undefined || recordCompletedAt(record) >= recordCompletedAt(existing.record)) {
      store.lastCompletedBySession.set(record.sessionID, makeLastCompletedSnapshot(record, runtime?.runEpoch ?? 0));
    }
  }
}
async function reloadHistory(store, api, path, maxRecords, generation = store.historyGeneration) {
  if (store.disposed) return;
  try {
    const diskRecords = (await readHistoryFile(path)).slice(-maxRecords);
    if (store.disposed || generation !== store.historyGeneration) return;
    store.diskRecords = diskRecords;
    repairKnownParents(store);
    hydrateHistoryState(store, store.diskRecords);
    store.records = mergeHistoryLayers(store.diskRecords, store.optimistic, maxRecords, store.optimisticQuality, store.optimisticOrder);
    store.bump();
  } catch (error) {
    warnWithToast(api, "history read failed", error);
  }
}
function resolveOptions(value) {
  const options = asRecord(value);
  const maxRecordsValue = readNumber(options?.maxRecords);
  const bytesPerTokenValue = readNumber(options?.bytesPerToken);
  return {
    historyPath: readString(options?.historyPath),
    maxRecords: maxRecordsValue !== undefined && maxRecordsValue > 0 ? Math.max(1, Math.floor(maxRecordsValue)) : DEFAULT_MAX_RECORDS,
    bytesPerToken: bytesPerTokenValue !== undefined && bytesPerTokenValue > 0 ? bytesPerTokenValue : DEFAULT_BYTES_PER_TOKEN,
    enabled: options?.enabled !== false
  };
}
function resolveHistoryPath(api, configuredPath) {
  const base = api.state.path.worktree && api.state.path.worktree !== "/" ? api.state.path.worktree : api.state.path.directory;
  const relativeOrAbsolute = configuredPath && configuredPath.trim().length > 0 ? configuredPath : DEFAULT_HISTORY_PATH;
  return isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : join(base, relativeOrAbsolute);
}
export function createRuntimeStore(maxRecords) {
  return createRoot(disposeSignals => {
    const [revision, setRevision] = createSignal(0);
    return {
      maxRecords,
      diskRecords: [],
      records: [],
      optimistic: new Map(),
      optimisticQuality: new Map(),
      optimisticOrder: new Map(),
      nextOptimisticOrder: 1,
      active: new Map(),
      completedMessageIDs: new Set(),
      sessionRuntime: new Map(),
      taskRuns: new Map(),
      sessionParents: new Map(),
      lastCompletedBySession: new Map(),
      pulseExpanded: false,
      historyGeneration: 0,
      revision,
      bump: () => setRevision(value => value + 1),
      disposed: false,
      disposeSignals
    };
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
  const decimals = unitIndex === units.length - 1 ? 1 : scaled >= 100 ? 0 : 1;
  let rendered = scaled.toFixed(decimals);
  if (unitIndex < units.length - 1) rendered = rendered.replace(/\.0$/, "");
  return `${sign}${rendered}${units[unitIndex]}`;
}
export function formatCompactRate(value) {
  return `${formatCompactNumber(value)} tok/s`;
}
export function formatCacheHitRate(rate) {
  if (rate === undefined || !Number.isFinite(rate)) return "--";
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}
export function formatPulseMetrics(tokens, speed) {
  const speedLabel = Number.isFinite(speed) && speed > 0 ? ` · ${formatCompactRate(speed)}` : "";
  return `${formatCompactNumber(totalTokens(tokens))} total${speedLabel} · cache ${formatCacheHitRate(cacheHitRate(tokens))}`;
}
export function formatPulseSummary(tokens, speed) {
  return `+ Token Pulse  ${formatPulseMetrics(tokens, speed)}`;
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
function formatOptionalDuration(value) {
  return value === undefined ? "--" : formatDuration(value);
}
export function generationElapsed(record) {
  const completed = record.time.completed;
  const firstToken = record.time.firstToken;
  if (typeof completed === "number" && Number.isFinite(completed) && typeof firstToken === "number" && Number.isFinite(firstToken)) {
    return Math.max(0, completed - firstToken);
  }
  return durationOf(record);
}
function stableGeneratedRate(record) {
  const elapsed = generationElapsed(record);
  const generated = generatedTokens(record.tokens);
  return elapsed !== undefined && elapsed > 0 ? generated * 1000 / elapsed : 0;
}
export function recordSpeedSummary(record) {
  const generated = generatedTokens(record.tokens);
  const sampleStats = calculateSpeedStats(record.samples);
  const stableRate = stableGeneratedRate(record);
  if (record.samples.length >= 2 && sampleStats.avg > 0) {
    return {
      ...sampleStats,
      avg: stableRate > 0 ? stableRate : sampleStats.avg,
      generated
    };
  }
  return {
    avg: stableRate,
    max: stableRate,
    min: stableRate,
    generated
  };
}
export function aggregateSpeed(records) {
  let generated = 0;
  let elapsed = 0;
  for (const record of records) {
    const generationTime = generationElapsed(record);
    if (generationTime === undefined || generationTime <= 0) continue;
    generated += generatedTokens(record.tokens);
    elapsed += generationTime;
  }
  return elapsed > 0 ? generated * 1000 / elapsed : 0;
}
function sparkline(samples, width = 8) {
  if (width <= 0) return "";
  if (samples.length === 0) return ".".repeat(width);
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const values = Array.from({
    length: width
  }, (_, index) => {
    const start = Math.floor(index * ordered.length / width);
    const end = Math.max(start + 1, Math.floor((index + 1) * ordered.length / width));
    const bucket = ordered.slice(start, Math.min(end, ordered.length));
    return bucket.reduce((sum, sample) => sum + Math.max(0, sample.tokens), 0);
  });
  const max = Math.max(...values);
  const min = Math.min(...values);
  return values.map(value => {
    if (max === min) return SPARK_CHARS[3];
    const index = Math.round((value - min) / (max - min) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[Math.max(0, Math.min(SPARK_CHARS.length - 1, index))];
  }).join("");
}
function padRight(value, width) {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}
function padLeft(value, width) {
  return value.length >= width ? value.slice(-width) : value.padStart(width, " ");
}
function formatHistoryRow(record) {
  const speed = recordSpeedSummary(record);
  const ttft = timeToFirstToken(record);
  const duration = durationOf(record);
  return [padRight(formatTime(record.time.completed ?? record.time.start), 8), padRight(shortTail(record.sessionID, 11), 11), padRight(truncateMiddle(record.model, 14), 14), padLeft(`${formatCompactNumber(record.tokens.output)}/${formatCompactNumber(record.tokens.reasoning)}`, 9), padLeft(formatCompactNumber(speed.avg), 6), padLeft(formatCompactNumber(speed.max), 6), padLeft(formatCompactNumber(speed.min), 6), padLeft(formatOptionalDuration(ttft), 7), padLeft(formatOptionalDuration(duration), 7), padLeft(formatCost(record.cost), 9), sparkline(record.samples)].join(" ");
}
function summaryLines(label, tokens, cost, responseCount) {
  return [label, `  Total tokens (input + generated + cache) ${formatCompactNumber(totalTokens(tokens))}`, `  Uncached input ${formatCompactNumber(tokens.input)}  Cache read (reused) ${formatCompactNumber(tokens.cacheRead)}`, `  Cache hit rate ${formatCacheHitRate(cacheHitRate(tokens))}`, `  Cache write ${formatCompactNumber(tokens.cacheWrite)}  Visible output ${formatCompactNumber(tokens.output)}`, `  Reasoning ${formatCompactNumber(tokens.reasoning)}  Generated (output + reasoning) ${formatCompactNumber(generatedTokens(tokens))}`, `  Model calls ${formatCompactNumber(responseCount)}  Estimated cost ${formatCost(cost)}`];
}
function emptySummaryLines() {
  const empty = emptyTokenCounts();
  return [...summaryLines("Session only", empty, 0, 0), ...summaryLines("Including subagents", empty, 0, 0), "No completed responses yet"];
}
function pulseMetricRows(tokens, cost, responseCount) {
  return [{
    label: "Total tokens (input + generated + cache)",
    value: formatCompactNumber(totalTokens(tokens))
  }, {
    label: "Uncached input",
    value: formatCompactNumber(tokens.input)
  }, {
    label: "Cache read (reused)",
    value: formatCompactNumber(tokens.cacheRead)
  }, {
    label: "Cache hit rate",
    value: formatCacheHitRate(cacheHitRate(tokens))
  }, {
    label: "Cache write",
    value: formatCompactNumber(tokens.cacheWrite)
  }, {
    label: "Visible output",
    value: formatCompactNumber(tokens.output)
  }, {
    label: "Reasoning",
    value: formatCompactNumber(tokens.reasoning)
  }, {
    label: "Generated",
    value: formatCompactNumber(generatedTokens(tokens))
  }, {
    label: "Model calls",
    value: formatCompactNumber(responseCount)
  }, {
    label: "Estimated cost",
    value: formatCost(cost)
  }];
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
        _$setProp(_el$5, "truncate", true);
        _$setProp(_el$5, "wrapMode", "none");
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
  const metrics = pulseMetricRows(props.section.tokens, props.section.cost, props.section.responseCount);
  return (() => {
    var _el$6 = _$createElement("box"),
      _el$7 = _$createElement("text");
    _$insertNode(_el$6, _el$7);
    _$setProp(_el$6, "flexDirection", "column");
    _$setProp(_el$6, "width", "100%");
    _$setProp(_el$6, "paddingTop", 1);
    _$setProp(_el$7, "truncate", true);
    _$setProp(_el$7, "wrapMode", "none");
    _$insert(_el$7, () => props.section.label);
    _$insert(_el$6, _$createComponent(PulseMetricGrid, {
      get theme() {
        return props.theme;
      },
      get rows() {
        return [[metrics[0]], [metrics[1], metrics[2]], [metrics[3], metrics[4]], [metrics[5], metrics[6]], [metrics[7], metrics[8]], [metrics[9]]];
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
      _$setProp(_el$10, "truncate", true);
      _$setProp(_el$10, "wrapMode", "none");
      _$insert(_el$10, () => `${"  ".repeat(row.depth)}${shortTail(row.sessionID, 10)}  ${formatCompactNumber(row.responseCount)} responses  ${formatCompactNumber(row.generated)} generated`);
      _$setProp(_el$11, "truncate", true);
      _$setProp(_el$11, "wrapMode", "none");
      _$insert(_el$11, () => `model ${truncateMiddle(row.model, 24)}  ${formatCompactRate(row.speed)}`);
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
function childRows(records, aggregate, store) {
  if (!aggregate) return [];
  const rows = [];
  const repairedRecords = recordsWithKnownParents(records, store);
  const visit = (node, depth) => {
    const directRecords = repairedRecords.filter(record => record.sessionID === node.sessionID);
    const subtreeIDs = new Set();
    const collectIDs = current => {
      subtreeIDs.add(current.sessionID);
      current.children.forEach(collectIDs);
    };
    collectIDs(node);
    const subtreeRecords = repairedRecords.filter(record => subtreeIDs.has(record.sessionID));
    const displayRecords = directRecords.length > 0 ? directRecords : subtreeRecords;
    const directGenerated = generatedTokens(node.directTokens);
    const responseCount = node.directResponseCount || node.responseCount;
    const generated = node.directResponseCount > 0 ? directGenerated : generatedTokens(node.tokens);
    const modelRecord = displayRecords.slice().sort((left, right) => (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start))[0];
    rows.push({
      depth,
      sessionID: node.sessionID,
      responseCount,
      generated,
      speed: aggregateSpeed(displayRecords),
      model: modelRecord?.model ?? "-"
    });
    node.children.forEach(child => visit(child, depth + 1));
  };
  aggregate.children.forEach(child => visit(child, 0));
  return rows;
}
function activeStats(state, now, bytesPerToken) {
  if (!state) return {
    rate: 0,
    generated: 0,
    elapsed: 0
  };
  const tokens = estimateActiveTokens(state, bytesPerToken);
  return {
    rate: rollingTokenRate(selectedSamples(state), now, DEFAULT_ROLLING_WINDOW_MS),
    generated: generatedTokens(tokens),
    ...(state.firstTokenAt !== undefined ? {
      ttft: Math.max(0, state.firstTokenAt - state.startedAt)
    } : {}),
    elapsed: Math.max(0, now - state.startedAt)
  };
}
function latestActive(active, sessionID, preferredMessageID) {
  const preferred = preferredMessageID ? active.get(preferredMessageID) : undefined;
  if (preferred?.sessionID === sessionID) return preferred;
  return [...active.values()].filter(state => state.sessionID === sessionID && !state.messageID.startsWith("__pending__:")).sort((left, right) => right.startedAt - left.startedAt)[0] ?? [...active.values()].filter(state => state.sessionID === sessionID).sort((left, right) => right.startedAt - left.startedAt)[0];
}
function liveLabel(store, sessionID, bytesPerToken, width) {
  const runtime = store.sessionRuntime.get(sessionID);
  const state = latestActive(store.active, sessionID, runtime?.activeMessageID);
  const stats = activeStats(state, Date.now(), bytesPerToken);
  const runGenerated = runtime ? generatedTokens(runtime.runTotals) : 0;
  if (state) {
    const rate = `LIVE ~${formatCompactRate(stats.rate)}`;
    if (width < 34) return rate;
    if (width < 58) {
      return `${rate} gen ~${formatCompactNumber(stats.generated)} ttft ${formatOptionalDuration(stats.ttft)}`;
    }
    return `${rate} gen ~${formatCompactNumber(stats.generated)} ttft ${formatOptionalDuration(stats.ttft)} elapsed ${formatDuration(stats.elapsed)} total ${formatCompactNumber(runGenerated)}`;
  }
  const last = store.lastCompletedBySession.get(sessionID);
  if (last) {
    const prefix = last.estimated ? "LAST ~" : "LAST ";
    const rate = `${prefix}${formatCompactRate(last.rate)}`;
    const totalGenerated = runtime && runtime.runEpoch > 0 ? runGenerated : last.generated;
    if (width < 34) return rate;
    if (width < 58) {
      return `${rate} gen ${formatCompactNumber(last.generated)} ttft ${formatOptionalDuration(last.ttft)}`;
    }
    return `${rate} gen ${formatCompactNumber(last.generated)} ttft ${formatOptionalDuration(last.ttft)} elapsed ${formatDuration(last.elapsed)} total ${formatCompactNumber(totalGenerated)}`;
  }
  return "IDLE";
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
    var _el$12 = _$createElement("box"),
      _el$13 = _$createElement("text"),
      _el$15 = _$createElement("text"),
      _el$16 = _$createTextNode(`session `);
    _$insertNode(_el$12, _el$13);
    _$insertNode(_el$12, _el$15);
    _$setProp(_el$12, "height", 2);
    _$setProp(_el$12, "paddingX", 1);
    _$setProp(_el$12, "flexDirection", "column");
    _$insertNode(_el$13, _$createTextNode(`OC TPS / history`));
    _$insertNode(_el$15, _el$16);
    _$setProp(_el$15, "truncate", true);
    _$setProp(_el$15, "wrapMode", "none");
    _$insert(_el$15, () => shortTail(props.sessionID, 18), null);
    _$effect(_p$ => {
      var _v$6 = props.theme.current.backgroundPanel,
        _v$7 = props.theme.current.primary,
        _v$8 = props.theme.current.textMuted;
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$12, "backgroundColor", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$13, "fg", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$15, "fg", _v$8, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$12;
  })();
}
function SummaryBlock(props) {
  const lines = createMemo(() => {
    props.store.revision();
    const aggregate = aggregateForSession(props.store.records, props.sessionID, props.store);
    if (!aggregate) return emptySummaryLines();
    return [...summaryLines("Session only", aggregate.directTokens, aggregate.directCost, aggregate.directResponseCount), ...summaryLines("Including subagents", aggregate.tokens, aggregate.cost, aggregate.responseCount)];
  });
  return (() => {
    var _el$17 = _$createElement("box"),
      _el$18 = _$createElement("text");
    _$insertNode(_el$17, _el$18);
    _$setProp(_el$17, "paddingX", 1);
    _$setProp(_el$17, "flexDirection", "column");
    _$insertNode(_el$18, _$createTextNode(`totals`));
    _$insert(_el$17, () => lines().map(line => (() => {
      var _el$20 = _$createElement("text");
      _$setProp(_el$20, "wrapMode", "word");
      _$insert(_el$20, line);
      _$effect(_$p => _$setProp(_el$20, "fg", props.theme.current.text, _$p));
      return _el$20;
    })()), null);
    _$effect(_p$ => {
      var _v$9 = props.theme.current.background,
        _v$0 = props.theme.current.secondary;
      _v$9 !== _p$.e && (_p$.e = _$setProp(_el$17, "backgroundColor", _v$9, _p$.e));
      _v$0 !== _p$.t && (_p$.t = _$setProp(_el$18, "fg", _v$0, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$17;
  })();
}
function HistoryView(props) {
  const rows = createMemo(() => {
    props.store.revision();
    return recentRecords(props.store.records, props.sessionID, props.store);
  });
  return (() => {
    var _el$21 = _$createElement("box"),
      _el$22 = _$createElement("box"),
      _el$23 = _$createElement("text"),
      _el$25 = _$createElement("scrollbox");
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$25);
    _$setProp(_el$21, "flexDirection", "column");
    _$setProp(_el$21, "flexGrow", 1);
    _$insert(_el$21, _$createComponent(Header, {
      get theme() {
        return props.api.theme;
      },
      get sessionID() {
        return props.sessionID;
      }
    }), _el$22);
    _$insert(_el$21, _$createComponent(SummaryBlock, {
      get theme() {
        return props.api.theme;
      },
      get store() {
        return props.store;
      },
      get sessionID() {
        return props.sessionID;
      }
    }), _el$22);
    _$insertNode(_el$22, _el$23);
    _$setProp(_el$22, "height", 1);
    _$setProp(_el$22, "paddingX", 1);
    _$insertNode(_el$23, _$createTextNode(`TIME SESSION MODEL OUT/REAS AVG MAX MIN TTFT DUR COST SPARK`));
    _$setProp(_el$23, "truncate", true);
    _$setProp(_el$23, "wrapMode", "none");
    _$setProp(_el$25, "flexGrow", 1);
    _$setProp(_el$25, "flexDirection", "column");
    _$setProp(_el$25, "paddingX", 1);
    _$setProp(_el$25, "stickyScroll", true);
    _$setProp(_el$25, "stickyStart", "top");
    _$insert(_el$25, (() => {
      var _c$ = _$memo(() => rows().length === 0);
      return () => _c$() ? (() => {
        var _el$26 = _$createElement("text");
        _$insertNode(_el$26, _$createTextNode(`No completed responses yet`));
        _$effect(_$p => _$setProp(_el$26, "fg", props.api.theme.current.textMuted, _$p));
        return _el$26;
      })() : rows().map(record => (() => {
        var _el$28 = _$createElement("text");
        _$setProp(_el$28, "truncate", true);
        _$setProp(_el$28, "wrapMode", "none");
        _$insert(_el$28, () => formatHistoryRow(record));
        _$effect(_$p => _$setProp(_el$28, "fg", props.api.theme.current.text, _$p));
        return _el$28;
      })());
    })());
    _$effect(_p$ => {
      var _v$1 = props.api.theme.current.background,
        _v$10 = props.api.theme.current.backgroundElement,
        _v$11 = props.api.theme.current.textMuted,
        _v$12 = props.api.theme.current.background;
      _v$1 !== _p$.e && (_p$.e = _$setProp(_el$21, "backgroundColor", _v$1, _p$.e));
      _v$10 !== _p$.t && (_p$.t = _$setProp(_el$22, "backgroundColor", _v$10, _p$.t));
      _v$11 !== _p$.a && (_p$.a = _$setProp(_el$23, "fg", _v$11, _p$.a));
      _v$12 !== _p$.o && (_p$.o = _$setProp(_el$25, "backgroundColor", _v$12, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$21;
  })();
}
function PromptRight(props) {
  setFocusSession(props.store, props.sessionID);
  const label = createMemo(() => {
    props.store.revision();
    return liveLabel(props.store, props.sessionID, props.options.bytesPerToken, Math.max(1, props.api.renderer.width));
  });
  return (() => {
    var _el$29 = _$createElement("text");
    _$setProp(_el$29, "truncate", true);
    _$setProp(_el$29, "wrapMode", "none");
    _$insert(_el$29, label);
    _$effect(_$p => _$setProp(_el$29, "fg", props.api.theme.current.accent, _$p));
    return _el$29;
  })();
}
function setFocusSession(store, sessionID) {
  if (!sessionID || store.focusSessionID === sessionID) return;
  store.focusSessionID = sessionID;
  store.bump();
}
export function togglePulse(store) {
  store.pulseExpanded = !store.pulseExpanded;
  store.bump();
  return store.pulseExpanded;
}
function BottomContent(props) {
  const sessionID = createMemo(() => {
    props.store.revision();
    return props.store.focusSessionID ?? props.sessionID;
  });
  const view = createMemo(() => {
    props.store.revision();
    return {
      aggregate: aggregateForSession(props.store.records, sessionID(), props.store),
      records: props.store.records
    };
  });
  const taskWallTime = createMemo(() => {
    props.store.revision();
    return taskWallTimeForSession(props.store, sessionID());
  });
  const rows = createMemo(() => childRows(view().records, view().aggregate, props.store));
  const sections = createMemo(() => {
    const aggregate = view().aggregate;
    if (!aggregate) {
      return [{
        label: "SESSION ONLY",
        tokens: emptyTokenCounts(),
        cost: 0,
        responseCount: 0
      }, {
        label: "INCLUDING SUBAGENTS",
        tokens: emptyTokenCounts(),
        cost: 0,
        responseCount: 0
      }];
    }
    return [{
      label: "SESSION ONLY",
      tokens: aggregate.directTokens,
      cost: aggregate.directCost,
      responseCount: aggregate.directResponseCount
    }, {
      label: "INCLUDING SUBAGENTS",
      tokens: aggregate.tokens,
      cost: aggregate.cost,
      responseCount: aggregate.responseCount
    }];
  });
  const pulseSummary = createMemo(() => {
    const currentView = view();
    const currentSessionID = sessionID();
    const aggregate = currentView.aggregate;
    return {
      tokens: aggregate?.tokens ?? emptyTokenCounts(),
      speed: aggregate && currentSessionID ? aggregateSpeed(recordsForSession(currentView.records, currentSessionID)) : 0
    };
  });
  const metricLabel = createMemo(() => {
    const summary = pulseSummary();
    return formatPulseMetrics(summary.tokens, summary.speed);
  });
  const taskWallTimeLabel = createMemo(() => {
    const wallTime = taskWallTime();
    return wallTime === undefined ? "--" : formatDuration(wallTime);
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
    var _el$30 = _$createElement("box"),
      _el$31 = _$createElement("box"),
      _el$32 = _$createElement("text"),
      _el$33 = _$createElement("text");
    _$insertNode(_el$30, _el$31);
    _$insertNode(_el$30, _el$33);
    _$setProp(_el$30, "flexDirection", "column");
    _$setProp(_el$30, "width", "100%");
    _$setProp(_el$30, "paddingTop", 1);
    _$setProp(_el$30, "paddingX", 1);
    _$setProp(_el$30, "overflow", "hidden");
    _$insertNode(_el$31, _el$32);
    _$setProp(_el$31, "focusable", true);
    _$setProp(_el$31, "width", "100%");
    _$setProp(_el$31, "height", 1);
    _$setProp(_el$31, "paddingX", 1);
    _$setProp(_el$31, "onMouseDown", onPulseMouseDown);
    _$setProp(_el$32, "truncate", true);
    _$setProp(_el$32, "wrapMode", "none");
    _$insert(_el$32, () => expanded() ? "- Token Pulse" : "+ Token Pulse");
    _$setProp(_el$33, "width", "100%");
    _$setProp(_el$33, "paddingX", 1);
    _$setProp(_el$33, "truncate", true);
    _$setProp(_el$33, "wrapMode", "none");
    _$insert(_el$33, metricLabel);
    _$insert(_el$30, (() => {
      var _c$2 = _$memo(() => !!expanded());
      return () => _c$2() && (!sessionID() ? (() => {
        var _el$34 = _$createElement("text");
        _$insertNode(_el$34, _$createTextNode(`No active session`));
        _$setProp(_el$34, "paddingTop", 1);
        _$setProp(_el$34, "truncate", true);
        _$setProp(_el$34, "wrapMode", "none");
        _$effect(_$p => _$setProp(_el$34, "fg", props.api.theme.current.textMuted, _$p));
        return _el$34;
      })() : [(() => {
        var _el$36 = _$createElement("text"),
          _el$37 = _$createTextNode(`session `);
        _$insertNode(_el$36, _el$37);
        _$setProp(_el$36, "paddingTop", 1);
        _$setProp(_el$36, "truncate", true);
        _$setProp(_el$36, "wrapMode", "none");
        _$insert(_el$36, () => shortTail(sessionID(), 18), null);
        _$effect(_$p => _$setProp(_el$36, "fg", props.api.theme.current.secondary, _$p));
        return _el$36;
      })(), _$memo(() => sections().map(section => _$createComponent(PulseSection, {
        get theme() {
          return props.api.theme;
        },
        section: section
      }))), _$memo(() => _$memo(() => !!!view().aggregate)() && (() => {
        var _el$41 = _$createElement("text");
        _$insertNode(_el$41, _$createTextNode(`No completed responses yet`));
        _$setProp(_el$41, "paddingTop", 1);
        _$setProp(_el$41, "truncate", true);
        _$setProp(_el$41, "wrapMode", "none");
        _$effect(_$p => _$setProp(_el$41, "fg", props.api.theme.current.textMuted, _$p));
        return _el$41;
      })()), (() => {
        var _el$38 = _$createElement("box"),
          _el$39 = _$createElement("text");
        _$insertNode(_el$38, _el$39);
        _$setProp(_el$38, "flexDirection", "column");
        _$setProp(_el$38, "width", "100%");
        _$setProp(_el$38, "paddingTop", 1);
        _$insertNode(_el$39, _$createTextNode(`SESSION RUN`));
        _$setProp(_el$39, "truncate", true);
        _$setProp(_el$39, "wrapMode", "none");
        _$insert(_el$38, _$createComponent(PulseMetricGrid, {
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
        _$effect(_$p => _$setProp(_el$39, "fg", props.api.theme.current.accent, _$p));
        return _el$38;
      })(), _$memo(() => _$memo(() => rows().length > 0)() && _$createComponent(ChildAgentRows, {
        get theme() {
          return props.api.theme;
        },
        get rows() {
          return rows();
        }
      }))]);
    })(), null);
    _$effect(_p$ => {
      var _v$13 = props.api.theme.current.backgroundElement,
        _v$14 = props.api.theme.current.primary,
        _v$15 = props.api.theme.current.textMuted;
      _v$13 !== _p$.e && (_p$.e = _$setProp(_el$31, "backgroundColor", _v$13, _p$.e));
      _v$14 !== _p$.t && (_p$.t = _$setProp(_el$32, "fg", _v$14, _p$.t));
      _v$15 !== _p$.a && (_p$.a = _$setProp(_el$33, "fg", _v$15, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$30;
  })();
}
export function createTuiSlotPlugin(api, store, options) {
  return {
    order: 1_000_000,
    slots: {
      sidebar_content: (_context, props) => _$createComponent(BottomContent, {
        api: api,
        store: store,
        get sessionID() {
          return props.session_id;
        }
      }),
      session_prompt_right: (_context, props) => _$createComponent(PromptRight, {
        api: api,
        store: store,
        get sessionID() {
          return props.session_id;
        },
        options: options
      })
    }
  };
}
function registerLegacyCommand(api, openHistory) {
  if (!api.command) return;
  try {
    const dispose = once(api.command.register(() => [{
      title: "Open token history",
      value: COMMAND_NAME,
      description: "Open recent token speed history for the current session",
      category: "Plugin",
      keybind: "ctrl+shift+t",
      slash: {
        name: "tps"
      },
      onSelect: openHistory
    }]));
    api.lifecycle.onDispose(dispose);
  } catch (error) {
    warnWithToast(api, "legacy command registration failed", error);
  }
}
const tui = async (api, rawOptions) => {
  const options = resolveOptions(rawOptions);
  if (!options.enabled) return;
  const store = createRuntimeStore(options.maxRecords);
  const historyPath = resolveHistoryPath(api, options.historyPath);
  let disposed = false;
  let reloadTimer;
  let reloadGeneration = 0;
  const scheduleReload = () => {
    reloadGeneration += 1;
    const generation = reloadGeneration;
    store.historyGeneration = generation;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    const run = async attempt => {
      if (disposed || generation !== reloadGeneration) return;
      reloadTimer = undefined;
      await reloadHistory(store, api, historyPath, options.maxRecords, generation);
      if (!disposed && generation === reloadGeneration && attempt < 3 && store.optimistic.size > 0) {
        reloadTimer = setTimeout(() => {
          void run(attempt + 1);
        }, 100);
      }
    };
    reloadTimer = setTimeout(() => {
      void run(0);
    }, 30);
  };
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
    api.keymap.registerLayer({
      mode: "base",
      commands: [{
        name: COMMAND_NAME,
        title: "Open token history",
        description: "Open recent token speed history for the current session",
        category: "Plugin",
        namespace: "palette",
        slashName: "tps",
        run: openHistory
      }],
      bindings: [{
        key: "ctrl+shift+t",
        cmd: COMMAND_NAME,
        desc: "Open token history"
      }]
    });
    api.keymap.registerLayer({
      mode: HISTORY_MODE,
      priority: 100,
      commands: [{
        name: "oc-tps.history.back",
        title: "Return from token history",
        description: "Return to the current session or home",
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
    registerLegacyCommand(api, openHistory);
  }
  api.slots.register(createTuiSlotPlugin(api, store, options));

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
  const handleEvent = input => {
    if (disposed) return;
    try {
      const event = normalizeEvent(input);
      if (!event) return;
      const type = eventType(event);
      const properties = eventProperties(event);
      const eventSessionID = readSessionID(properties, event);
      if (type === "session.created" || type === "session.updated") {
        const mapped = cacheSessionParentFromEvent(store, event);
        const sessionID = readSessionID(properties, event);
        if (sessionID) rootSessionIDFor(store, api, sessionID);
        setFocusSession(store, sessionID);
        if (mapped) store.bump();
        return;
      }
      if (eventSessionID) rootSessionIDFor(store, api, eventSessionID);
      setFocusSession(store, eventSessionID);
      if (type === "message.part.delta") {
        recordDelta(store, properties, event, "legacy", undefined, options.bytesPerToken);
        return;
      }
      if (type === "session.next.text.delta" || type === "session.next.reasoning.delta") {
        recordDelta(store, properties, event, "v2", type.endsWith("reasoning.delta") ? "reasoning" : "output", options.bytesPerToken);
        return;
      }
      if (type === "session.next.step.started") {
        recordStepStarted(store, properties, event);
        return;
      }
      if (type === "session.next.step.ended") {
        recordStepFallback(store, properties, event);
        return;
      }
      if (type === "message.updated") {
        if (handleMessageUpdated(store, api, properties, event, options.bytesPerToken)) {
          scheduleReload();
        }
        return;
      }
      if (type === "session.idle" || type === "session.status") {
        if (handleSessionLifecycle(store, api, type, properties, event, options.bytesPerToken)) {
          scheduleReload();
        }
      }
    } catch (error) {
      console.warn("[oc-tps] event parsing failed", error);
    }
  };
  subscribe("message.part.delta", handleEvent);
  subscribe("session.next.text.delta", handleEvent);
  subscribe("session.next.reasoning.delta", handleEvent);
  subscribe("message.updated", handleEvent);
  subscribe("session.next.step.started", handleEvent);
  subscribe("session.next.step.ended", handleEvent);
  subscribe("session.idle", handleEvent);
  subscribe("session.status", handleEvent);
  subscribe("session.created", handleEvent);
  subscribe("session.updated", handleEvent);
  const interval = setInterval(() => {
    if (!disposed && store.active.size > 0) store.bump();
  }, 500);
  api.lifecycle.onDispose(() => {
    disposed = true;
    store.disposed = true;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    clearInterval(interval);
    store.active.clear();
    store.optimistic.clear();
    store.optimisticQuality.clear();
    store.optimisticOrder.clear();
    store.diskRecords = [];
    store.records = [];
    store.completedMessageIDs.clear();
    store.sessionRuntime.clear();
    store.taskRuns.clear();
    store.sessionParents.clear();
    store.lastCompletedBySession.clear();
    store.focusSessionID = undefined;
    store.disposeSignals();
  });
  store.historyGeneration += 1;
  await reloadHistory(store, api, historyPath, options.maxRecords, store.historyGeneration);
};
const plugin = {
  id: "oc-tps",
  tui
};
export default plugin;
