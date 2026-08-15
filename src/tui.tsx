/** @jsxImportSource @opentui/solid */

import { isAbsolute, join } from "node:path";
import { createMemo, createRoot, createSignal, onCleanup } from "solid-js";
import type { MouseEvent } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui";
import {
  DEFAULT_BYTES_PER_TOKEN,
  DEFAULT_ROLLING_WINDOW_MS,
  HISTORY_VERSION,
  HistoryRecord,
  RateStats,
  SessionAggregate,
  SpeedSample,
  TokenCounts,
  addTokenCounts,
  aggregateSession,
  aggregateSessionTree,
  calculateSpeedStats,
  calibrateResponseSamples,
  bytesToTokens,
  durationOf,
  emptyTokenCounts,
  formatDuration,
  formatNumber,
  normalizeTokenCounts,
  rollingTokenRate,
  timeToFirstToken,
  utf8ByteLength,
} from "./core.js";
import {
  DEFAULT_MAX_RECORDS,
  readHistoryFile,
} from "./storage.js";

const DEFAULT_HISTORY_PATH = ".opencode/oc-tps/history.jsonl";
const HISTORY_ROUTE = "oc-tps-history";
const HISTORY_MODE = "oc-tps.history";
const COMMAND_NAME = "oc-tps.history";
const SPARK_CHARS = ".:-=+#";

type ObjectRecord = Record<string, unknown>;
export type StreamName = "legacy" | "v2";
type SampleKind = "output" | "reasoning";
type CompatibleEventType =
  | "message.part.delta"
  | "session.next.text.delta"
  | "session.next.reasoning.delta"
  | "message.updated"
  | "session.next.step.started"
  | "session.next.step.ended"
  | "session.idle"
  | "session.status"
  | "session.created"
  | "session.updated";

interface CompatibleEvent {
  type?: unknown;
  timestamp?: unknown;
  properties?: unknown;
  data?: unknown;
  event?: unknown;
  info?: unknown;
  [key: string]: unknown;
}

interface CompatibleEventOn {
  (type: CompatibleEventType, handler: (event: unknown) => void): () => void;
}

interface CandidateStream {
  hasData: boolean;
  samples: SpeedSample[];
}

export interface ActiveState {
  messageID: string;
  sessionID: string;
  startedAt: number;
  firstTokenAt?: number;
  model?: string;
  cost?: number;
  fallbackTokens: Partial<TokenCounts>;
  legacy: CandidateStream;
  v2: CandidateStream;
  selectedSource?: StreamName;
}

export type SessionRunStatus = "idle" | "busy" | "retry";

interface RuntimeContribution {
  tokens: TokenCounts;
  cost: number;
}

export interface SessionRunSummary {
  runEpoch: number;
  tokens: TokenCounts;
  cost: number;
  responseCount: number;
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
}

export interface SessionRuntime {
  status: SessionRunStatus;
  runEpoch: number;
  activeMessageID?: string;
  runStartedAt?: number;
  runFirstTokenAt?: number;
  runTotals: TokenCounts;
  runCost: number;
  runResponseCount: number;
  seenMessageIDs: Set<string>;
  lastRunSummary?: SessionRunSummary;
  contributions: Map<string, RuntimeContribution>;
}

export type TaskSessionState = "busy" | "retry" | "idle" | "completed";

interface PendingTaskSession {
  state: TaskSessionState;
  timestamp: number;
}

export interface TaskWallTimeSummary {
  runEpoch: number;
  startedAt: number;
  completedAt: number;
  wallTime: number;
}

export interface TaskWallRun {
  rootSessionID: string;
  phase: "idle" | "active";
  runEpoch: number;
  rootBusy: boolean;
  rootObserved: boolean;
  hasExplicitRootStart: boolean;
  runStartedAt?: number;
  participantSessions: Set<string>;
  activeSessions: Set<string>;
  sessionStates: Map<string, TaskSessionState>;
  lastActivityAt: Map<string, number>;
  pendingSessions: Map<string, PendingTaskSession>;
  lastRunWallTime?: TaskWallTimeSummary;
}

export interface LastCompletedSnapshot {
  record: HistoryRecord;
  rate: number;
  generated: number;
  ttft?: number;
  elapsed: number;
  runEpoch: number;
  estimated: boolean;
}

export interface TuiOptions {
  historyPath?: string;
  maxRecords: number;
  bytesPerToken: number;
  enabled: boolean;
}

export interface RuntimeStore {
  maxRecords: number;
  records: HistoryRecord[];
  optimistic: Map<string, HistoryRecord>;
  active: Map<string, ActiveState>;
  completedMessageIDs: Set<string>;
  sessionRuntime: Map<string, SessionRuntime>;
  taskRuns: Map<string, TaskWallRun>;
  sessionParents: Map<string, string>;
  lastCompletedBySession: Map<string, LastCompletedSnapshot>;
  focusSessionID?: string;
  pulseExpanded: boolean;
  historyGeneration: number;
  revision: () => number;
  bump: () => void;
  disposed: boolean;
  disposeSignals: () => void;
}

interface AggregateView {
  aggregate?: SessionAggregate;
  records: HistoryRecord[];
}

interface ChildRow {
  depth: number;
  sessionID: string;
  responseCount: number;
  generated: number;
  speed: number;
  model: string;
}

export interface RecordSpeedSummary extends RateStats {
  generated: number;
}

function isRecord(value: unknown): value is ObjectRecord {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): ObjectRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function getPath(source: ObjectRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    return isRecord(value) ? value[key] : undefined;
  }, source);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringFrom(
  sources: readonly (ObjectRecord | undefined)[],
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = readString(getPath(source, key));
      if (value) return value;
    }
  }
  return undefined;
}

function readNumberFrom(
  sources: readonly (ObjectRecord | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = readNumber(getPath(source, key));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function normalizeEvent(input: unknown): CompatibleEvent | undefined {
  const outer = asRecord(input);
  if (!outer) return undefined;
  const nested = asRecord(outer.event) ?? asRecord(outer.payload);
  if (nested && typeof nested.type === "string") return nested;
  return outer;
}

function eventProperties(event: CompatibleEvent): ObjectRecord {
  return asRecord(event.properties) ?? asRecord(event.data) ?? {};
}

function eventType(event: CompatibleEvent): string {
  return readString(event.type) ?? "";
}

function eventTimestamp(event: CompatibleEvent, properties: ObjectRecord): number {
  return readNumberFrom([event, properties], ["timestamp", "time"]) ?? Date.now();
}

function eventInfo(
  properties: ObjectRecord,
  event: CompatibleEvent,
): ObjectRecord | undefined {
  return asRecord(properties.info)
    ?? asRecord(properties.message)
    ?? asRecord(event.info)
    ?? (typeof properties.role === "string" ? properties : undefined);
}

function readMessageID(...sources: ObjectRecord[]): string | undefined {
  return readStringFrom(sources, [
    "messageID",
    "messageId",
    "assistantMessageID",
    "assistantMessageId",
    "message.id",
    "id",
    "part.messageID",
  ]);
}

function readSessionID(
  properties: ObjectRecord,
  event: CompatibleEvent,
): string | undefined {
  const direct = readStringFrom([properties, event], [
    "sessionID",
    "sessionId",
    "session.id",
  ]);
  if (direct) return direct;
  return readStringFrom([
    asRecord(properties.info),
    asRecord(properties.session),
    asRecord(event.info),
    asRecord(event.session),
  ], ["id", "sessionID", "sessionId", "session.id"]);
}

function readDelta(
  properties: ObjectRecord,
  event: CompatibleEvent,
): string | undefined {
  const values: unknown[] = [
    properties.delta,
    properties.text,
    properties.content,
    getPath(properties, "part.delta"),
    getPath(properties, "part.text"),
    event.delta,
    event.text,
  ];
  return values.find((value): value is string => (
    typeof value === "string" && value.length > 0
  ));
}

function inferKind(
  properties: ObjectRecord,
  event: CompatibleEvent,
): SampleKind {
  const values: unknown[] = [
    properties.kind,
    properties.type,
    properties.field,
    getPath(properties, "part.type"),
    event.kind,
    event.type,
  ];
  return values.some((value) => (
    typeof value === "string" && value.toLowerCase().includes("reason")
  )) ? "reasoning" : "output";
}

function modelName(value: ObjectRecord | undefined): string | undefined {
  if (!value) return undefined;
  const direct = readString(value.model);
  if (direct) return direct;
  const model = asRecord(value.model);
  return readStringFrom([model, value], ["modelID", "modelId", "id", "name"]);
}

function tokenFields(value: unknown): Partial<TokenCounts> {
  const source = asRecord(value);
  if (!source) return {};
  const normalized = normalizeTokenCounts(source);
  const fields: Partial<TokenCounts> = {};
  if (readNumber(source.input) !== undefined) fields.input = normalized.input;
  if (readNumber(source.output) !== undefined) fields.output = normalized.output;
  if (readNumber(source.reasoning) !== undefined) fields.reasoning = normalized.reasoning;
  const cache = asRecord(source.cache);
  if (readNumber(source.cacheRead) !== undefined || readNumber(cache?.read) !== undefined) {
    fields.cacheRead = normalized.cacheRead;
  }
  if (readNumber(source.cacheWrite) !== undefined || readNumber(cache?.write) !== undefined) {
    fields.cacheWrite = normalized.cacheWrite;
  }
  return fields;
}

function mergeTokenFields(
  left: Partial<TokenCounts>,
  right: Partial<TokenCounts>,
): Partial<TokenCounts> {
  return { ...left, ...right };
}

function pendingKey(sessionID: string): string {
  return `__pending__:${sessionID}`;
}

export function createSessionRuntime(): SessionRuntime {
  return {
    status: "idle",
    runEpoch: 0,
    runTotals: emptyTokenCounts(),
    runCost: 0,
    runResponseCount: 0,
    seenMessageIDs: new Set<string>(),
    contributions: new Map<string, RuntimeContribution>(),
  };
}

export function createTaskWallRun(rootSessionID: string): TaskWallRun {
  return {
    rootSessionID,
    phase: "idle",
    runEpoch: 0,
    rootBusy: false,
    rootObserved: false,
    hasExplicitRootStart: false,
    participantSessions: new Set<string>(),
    activeSessions: new Set<string>(),
    sessionStates: new Map<string, TaskSessionState>(),
    lastActivityAt: new Map<string, number>(),
    pendingSessions: new Map<string, PendingTaskSession>(),
  };
}

function clearTaskRunParticipants(run: TaskWallRun): void {
  run.participantSessions.clear();
  run.activeSessions.clear();
  run.sessionStates.clear();
  run.lastActivityAt.clear();
}

function activeTaskSessionState(state: TaskSessionState | undefined): boolean {
  return state === "busy" || state === "retry";
}

function startTaskWallRun(
  run: TaskWallRun,
  timestamp: number,
  explicitRootStart: boolean,
): void {
  run.phase = "active";
  run.runEpoch += 1;
  run.runStartedAt = timestamp;
  run.rootBusy = explicitRootStart;
  run.rootObserved = explicitRootStart;
  run.hasExplicitRootStart = explicitRootStart;
  clearTaskRunParticipants(run);
  run.pendingSessions.forEach((pending, sessionID) => {
    const continuesIntoRun = pending.state === "busy"
      || pending.state === "retry"
      || pending.timestamp >= timestamp;
    if (!continuesIntoRun) return;
    run.participantSessions.add(sessionID);
    run.sessionStates.set(sessionID, pending.state);
    run.lastActivityAt.set(sessionID, pending.timestamp);
    if (pending.state === "busy" || pending.state === "retry") {
      run.activeSessions.add(sessionID);
    }
  });
  run.pendingSessions.clear();
  if (explicitRootStart) {
    run.participantSessions.add(run.rootSessionID);
    run.activeSessions.add(run.rootSessionID);
    run.sessionStates.set(run.rootSessionID, "busy");
    run.lastActivityAt.set(run.rootSessionID, timestamp);
  }
}

function recordTaskSessionActivity(
  run: TaskWallRun,
  sessionID: string,
  state: TaskSessionState,
  timestamp: number,
): void {
  run.participantSessions.add(sessionID);
  run.sessionStates.set(sessionID, state);
  const previous = run.lastActivityAt.get(sessionID);
  run.lastActivityAt.set(
    sessionID,
    previous === undefined ? timestamp : Math.max(previous, timestamp),
  );
  if (state === "busy" || state === "retry") run.activeSessions.add(sessionID);
  else run.activeSessions.delete(sessionID);
  if (sessionID === run.rootSessionID) {
    run.rootObserved = true;
    run.rootBusy = state === "busy" || state === "retry";
  }
}

function finishTaskWallRun(
  run: TaskWallRun,
  timestamp: number,
): TaskWallTimeSummary | undefined {
  if (run.phase !== "active" || !run.rootObserved || run.activeSessions.size > 0) return undefined;
  const startedAt = run.runStartedAt ?? timestamp;
  const activityEnd = Math.max(
    timestamp,
    ...run.lastActivityAt.values(),
  );
  const summary: TaskWallTimeSummary = {
    runEpoch: run.runEpoch,
    startedAt,
    completedAt: activityEnd,
    wallTime: Math.max(0, activityEnd - startedAt),
  };
  run.lastRunWallTime = summary;
  run.phase = "idle";
  run.rootBusy = false;
  run.rootObserved = false;
  run.activeSessions.clear();
  return summary;
}

export function transitionTaskWallRun(
  run: TaskWallRun,
  sessionID: string,
  state: TaskSessionState,
  timestamp: number,
): TaskWallTimeSummary | undefined {
  const isRoot = sessionID === run.rootSessionID;
  const startsRootRun = isRoot && activeTaskSessionState(state);
  if (run.phase === "idle") {
    if (startsRootRun) {
      startTaskWallRun(run, timestamp, true);
    } else {
      run.pendingSessions.set(sessionID, { state, timestamp });
      return undefined;
    }
  } else if (startsRootRun && !run.hasExplicitRootStart) {
    run.runStartedAt = timestamp;
    run.hasExplicitRootStart = true;
    run.rootObserved = true;
    run.rootBusy = true;
  }
  recordTaskSessionActivity(run, sessionID, state, timestamp);
  return finishTaskWallRun(run, timestamp);
}

export function noteTaskRunRecord(
  run: TaskWallRun,
  sessionID: string,
  startedAt: number | undefined,
  completedAt: number | undefined,
): TaskWallTimeSummary | undefined {
  if (run.phase !== "active") return undefined;
  const activityAt = completedAt ?? startedAt;
  if (activityAt === undefined) return undefined;
  recordTaskSessionActivity(run, sessionID, "completed", activityAt);
  return finishTaskWallRun(run, activityAt);
}

function startSessionRun(
  runtime: SessionRuntime,
  timestamp: number,
  status: Exclude<SessionRunStatus, "idle"> = "busy",
): void {
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

export function transitionSessionRuntime(
  runtime: SessionRuntime,
  status: SessionRunStatus,
  timestamp: number,
): boolean {
  if (status === "idle") {
    if (runtime.status === "idle" && runtime.activeMessageID === undefined) return false;
    runtime.status = "idle";
    return true;
  }
  if (runtime.status === "idle") {
    if (status === "busy" || runtime.runEpoch === 0) startSessionRun(runtime, timestamp, status);
    else runtime.status = status;
  } else {
    runtime.status = status;
  }
  runtime.runStartedAt = runtime.runStartedAt === undefined
    ? timestamp
    : Math.min(runtime.runStartedAt, timestamp);
  return true;
}

export function freezeSessionRun(
  runtime: SessionRuntime,
  timestamp: number,
): SessionRunSummary | undefined {
  if (runtime.status === "idle") return undefined;
  const summary: SessionRunSummary = {
    runEpoch: runtime.runEpoch,
    tokens: { ...runtime.runTotals },
    cost: runtime.runCost,
    responseCount: runtime.runResponseCount,
    ...(runtime.runStartedAt !== undefined ? { startedAt: runtime.runStartedAt } : {}),
    ...(runtime.runFirstTokenAt !== undefined ? { firstTokenAt: runtime.runFirstTokenAt } : {}),
    completedAt: timestamp,
  };
  runtime.lastRunSummary = summary;
  runtime.status = "idle";
  runtime.activeMessageID = undefined;
  return summary;
}

function ensureSessionRun(
  store: RuntimeStore,
  sessionID: string,
  timestamp: number,
): SessionRuntime {
  const runtime = getSessionRuntime(store, sessionID);
  if (runtime.status === "idle") startSessionRun(runtime, timestamp);
  runtime.status = "busy";
  runtime.runStartedAt = runtime.runStartedAt === undefined
    ? timestamp
    : Math.min(runtime.runStartedAt, timestamp);
  return runtime;
}

function getSessionRuntime(store: RuntimeStore, sessionID: string): SessionRuntime {
  const existing = store.sessionRuntime.get(sessionID);
  if (existing) return existing;
  const runtime = createSessionRuntime();
  store.sessionRuntime.set(sessionID, runtime);
  return runtime;
}

export function createActiveState(
  messageID: string,
  sessionID: string,
  timestamp: number,
): ActiveState {
  return {
    messageID,
    sessionID,
    startedAt: timestamp,
    fallbackTokens: {},
    legacy: { hasData: false, samples: [] },
    v2: { hasData: false, samples: [] },
  };
}

export function lockStreamSource(
  selected: StreamName | undefined,
  incoming: StreamName,
): StreamName {
  return selected ?? incoming;
}

function getOrCreateActiveState(
  active: Map<string, ActiveState>,
  messageID: string | undefined,
  sessionID: string,
  timestamp: number,
): ActiveState {
  const direct = messageID ? active.get(messageID) : undefined;
  const pendingID = pendingKey(sessionID);
  const pending = active.get(pendingID);
  const state = direct ?? pending ?? createActiveState(messageID ?? pendingID, sessionID, timestamp);
  if (messageID) state.messageID = messageID;
  if (messageID && pending && state === pending) active.delete(pendingID);
  return state;
}

export function takeActiveState(
  active: Map<string, ActiveState>,
  messageID: string,
  sessionID: string,
): ActiveState | undefined {
  const direct = active.get(messageID);
  const pendingID = pendingKey(sessionID);
  const state = direct ?? active.get(pendingID);
  if (!state || state.sessionID !== sessionID) return undefined;
  active.delete(messageID);
  if (!direct) active.delete(pendingID);
  state.messageID = messageID;
  return state;
}

export function selectedSamples(state: ActiveState | undefined): SpeedSample[] {
  if (!state) return [];
  if (state.selectedSource === "v2") return [...state.v2.samples];
  if (state.selectedSource === "legacy") return [...state.legacy.samples];
  return state.v2.hasData ? [...state.v2.samples] : [...state.legacy.samples];
}

// Keep live estimates source-locked; only final calibration gives v2 its priority.
export function finalSamples(state: ActiveState | undefined): SpeedSample[] {
  if (!state) return [];
  return state.v2.hasData ? [...state.v2.samples] : selectedSamples(state);
}

function estimateActiveTokens(
  state: ActiveState | undefined,
  bytesPerToken: number,
): TokenCounts {
  const result = emptyTokenCounts();
  const samples = selectedSamples(state);
  for (const sample of samples) {
    const tokens = Math.max(0, sample.estimatedTokens ?? sample.tokens);
    if (sample.kind === "reasoning") result.reasoning += tokens;
    else result.output += tokens;
  }
  if (state && samples.length === 0) {
    const source = state.selectedSource === "v2" ? state.v2 : state.legacy;
    for (const sample of source.samples) {
      result.output += bytesToTokens(sample.bytes ?? 0, bytesPerToken);
    }
  }
  return result;
}

function exactOrFallback(
  exact: number | undefined,
  fallback: number | undefined,
  estimate: number,
): number {
  return exact ?? fallback ?? Math.max(0, Math.round(estimate));
}

function isCompleted(
  info: ObjectRecord,
  properties: ObjectRecord,
  event: CompatibleEvent,
): boolean {
  const values = [info.completed, properties.completed, event.completed];
  if (values.some((value) => value === true || value === "completed")) return true;
  const status = info.status ?? properties.status ?? event.status;
  if (status === "completed" || (isRecord(status) && status.type === "completed")) return true;
  const time = asRecord(info.time);
  return readNumber(time?.end) !== undefined || readNumber(time?.completed) !== undefined;
}

function terminalStatus(value: unknown): boolean {
  if (value === "idle" || value === "completed" || value === "error") return true;
  if (value === "failed" || value === "aborted" || value === "cancelled" || value === "stopped") return true;
  if (!isRecord(value)) return false;
  return terminalStatus(value.type) || terminalStatus(value.status);
}

function statusName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return readString(value.type) ?? readString(value.status);
}

function infoTimeValue(
  info: ObjectRecord | undefined,
  keys: readonly string[],
): number | undefined {
  return readNumberFrom([asRecord(info?.time), info], keys);
}

function makeHistoryRecord(input: {
  messageID: string;
  sessionID: string;
  parentSessionID?: string;
  model?: string;
  cost: number;
  tokens: TokenCounts;
  samples: SpeedSample[];
  state?: ActiveState;
  info?: ObjectRecord;
  completedAt: number;
}): HistoryRecord {
  const start = infoTimeValue(input.info, ["start", "created"])
    ?? input.state?.startedAt
    ?? input.completedAt;
  const firstToken = infoTimeValue(input.info, ["firstToken", "firstTokenAt"])
    ?? input.state?.firstTokenAt;
  const completed = infoTimeValue(input.info, ["end", "completed"])
    ?? input.completedAt;
  const ttft = firstToken === undefined ? undefined : Math.max(0, firstToken - start);
  const duration = Math.max(0, completed - start);
  return {
    version: HISTORY_VERSION,
    messageID: input.messageID,
    sessionID: input.sessionID,
    ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
    ...(input.model ? { model: input.model } : {}),
    tokens: input.tokens,
    cost: Math.max(0, Number.isFinite(input.cost) ? input.cost : 0),
    time: {
      start,
      ...(firstToken !== undefined ? { firstToken } : {}),
      completed,
      ...(ttft !== undefined ? { ttft } : {}),
      duration,
    },
    samples: input.samples,
  };
}

function makeTokens(
  info: ObjectRecord | undefined,
  state: ActiveState | undefined,
  bytesPerToken: number,
): TokenCounts {
  const exact = tokenFields(info?.tokens);
  const fallback = state?.fallbackTokens ?? {};
  const estimate = estimateActiveTokens(state, bytesPerToken);
  return {
    input: exactOrFallback(exact.input, fallback.input, estimate.input),
    output: exactOrFallback(exact.output, fallback.output, estimate.output),
    reasoning: exactOrFallback(exact.reasoning, fallback.reasoning, estimate.reasoning),
    cacheRead: exactOrFallback(exact.cacheRead, fallback.cacheRead, 0),
    cacheWrite: exactOrFallback(exact.cacheWrite, fallback.cacheWrite, 0),
  };
}

function replaceTokenContribution(
  total: TokenCounts,
  previous: TokenCounts,
  next: TokenCounts,
): TokenCounts {
  return {
    input: Math.max(0, total.input - previous.input + next.input),
    output: Math.max(0, total.output - previous.output + next.output),
    reasoning: Math.max(0, total.reasoning - previous.reasoning + next.reasoning),
    cacheRead: Math.max(0, total.cacheRead - previous.cacheRead + next.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite + next.cacheWrite),
  };
}

export function applyRecordToSessionRuntime(
  runtime: SessionRuntime,
  record: HistoryRecord,
): boolean {
  const previous = runtime.contributions.get(record.messageID);
  if (previous) {
    runtime.runTotals = replaceTokenContribution(runtime.runTotals, previous.tokens, record.tokens);
    runtime.runCost = Math.max(0, runtime.runCost - previous.cost + record.cost);
  } else {
    runtime.runTotals = addTokenCounts(runtime.runTotals, record.tokens);
    runtime.runCost += record.cost;
    runtime.runResponseCount += 1;
    runtime.seenMessageIDs.add(record.messageID);
  }
  runtime.contributions.set(record.messageID, { tokens: record.tokens, cost: record.cost });
  runtime.runStartedAt = runtime.runStartedAt === undefined
    ? record.time.start
    : Math.min(runtime.runStartedAt, record.time.start);
  if (record.time.firstToken !== undefined) {
    runtime.runFirstTokenAt = runtime.runFirstTokenAt === undefined
      ? record.time.firstToken
      : Math.min(runtime.runFirstTokenAt, record.time.firstToken);
  }
  return previous === undefined;
}

function completedElapsed(record: HistoryRecord): number {
  const completed = record.time.completed ?? record.time.start;
  const firstToken = record.time.firstToken;
  if (firstToken !== undefined) return Math.max(0, completed - firstToken);
  return Math.max(0, durationOf(record) ?? 0);
}

export function makeLastCompletedSnapshot(
  record: HistoryRecord,
  runEpoch = 0,
  estimated = false,
): LastCompletedSnapshot {
  const elapsed = completedElapsed(record);
  const generated = record.tokens.output + record.tokens.reasoning;
  return {
    record,
    rate: elapsed > 0 ? (generated * 1000) / elapsed : 0,
    generated,
    ...(timeToFirstToken(record) !== undefined
      ? { ttft: timeToFirstToken(record) }
      : {}),
    elapsed,
    runEpoch,
    estimated,
  };
}

function commitRecord(
  store: RuntimeStore,
  record: HistoryRecord,
  markCompleted: boolean,
): void {
  const existingRuntime = getSessionRuntime(store, record.sessionID);
  const runtime = existingRuntime.status === "idle"
    && existingRuntime.contributions.has(record.messageID)
    ? existingRuntime
    : ensureSessionRun(store, record.sessionID, record.time.start);
  runtime.status = "busy";
  applyRecordToSessionRuntime(runtime, record);
  if (runtime.activeMessageID === record.messageID) runtime.activeMessageID = undefined;
  if (markCompleted) store.completedMessageIDs.add(record.messageID);
  store.lastCompletedBySession.set(
    record.sessionID,
    makeLastCompletedSnapshot(record, runtime.runEpoch, !markCompleted),
  );
  addOptimisticRecord(store, record);
}

function parentSessionID(api: TuiPluginApi, sessionID: string, info?: ObjectRecord): string | undefined {
  try {
    const session = api.state.session.get(sessionID);
    if (session?.parentID) return session.parentID;
  } catch {
    // State can still be syncing while a response completes.
  }
  return readStringFrom([info], ["parentSessionID", "parentSessionId", "parentID"]);
}

function knownRootSessionID(store: RuntimeStore, sessionID: string): string {
  let root = sessionID;
  const visited = new Set<string>();
  while (!visited.has(root)) {
    visited.add(root);
    const parent = store.sessionParents.get(root);
    if (!parent) break;
    root = parent;
  }
  return root;
}

function mergeTaskWallRun(
  target: TaskWallRun,
  source: TaskWallRun,
  rootSessionID: string,
): void {
  const activeCandidates = new Set([
    ...target.activeSessions,
    ...source.activeSessions,
  ]);
  target.rootSessionID = rootSessionID;
  target.phase = target.phase === "active" || source.phase === "active"
    ? "active"
    : "idle";
  target.runEpoch = Math.max(target.runEpoch, source.runEpoch);
  target.rootBusy = target.rootBusy || source.rootBusy;
  target.rootObserved = target.rootObserved || source.rootObserved;
  target.hasExplicitRootStart = target.hasExplicitRootStart || source.hasExplicitRootStart;
  if (source.runStartedAt !== undefined) {
    target.runStartedAt = target.runStartedAt === undefined
      ? source.runStartedAt
      : Math.min(target.runStartedAt, source.runStartedAt);
  }

  for (const sessionID of source.participantSessions) {
    target.participantSessions.add(sessionID);
  }
  for (const [sessionID, state] of source.sessionStates) {
    const current = target.sessionStates.get(sessionID);
    const currentAt = target.lastActivityAt.get(sessionID) ?? Number.NEGATIVE_INFINITY;
    const sourceAt = source.lastActivityAt.get(sessionID) ?? Number.NEGATIVE_INFINITY;
    if (
      current === undefined
      || sourceAt > currentAt
      || (sourceAt === currentAt && activeTaskSessionState(state) && !activeTaskSessionState(current))
    ) {
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
    if (
      current === undefined
      || pending.timestamp > current.timestamp
      || (
        pending.timestamp === current.timestamp
        && activeTaskSessionState(pending.state)
        && !activeTaskSessionState(current.state)
      )
    ) {
      target.pendingSessions.set(sessionID, pending);
    }
  }

  for (const sessionID of activeCandidates) {
    target.participantSessions.add(sessionID);
    if (!target.sessionStates.has(sessionID)) {
      target.sessionStates.set(sessionID, "busy");
    }
  }
  target.activeSessions.clear();
  for (const [sessionID, state] of target.sessionStates) {
    if (activeTaskSessionState(state)) target.activeSessions.add(sessionID);
  }
  const rootState = target.sessionStates.get(rootSessionID);
  if (rootState !== undefined) target.rootBusy = activeTaskSessionState(rootState);

  const sourceSummary = source.lastRunWallTime;
  const targetSummary = target.lastRunWallTime;
  if (
    targetSummary === undefined
    || (
      sourceSummary !== undefined
      && (
        sourceSummary.runEpoch > targetSummary.runEpoch
        || (
          sourceSummary.runEpoch === targetSummary.runEpoch
          && sourceSummary.completedAt > targetSummary.completedAt
        )
      )
    )
  ) {
    target.lastRunWallTime = sourceSummary;
  }
}

function migrateTaskWallRuns(store: RuntimeStore, rootSessionID: string): boolean {
  let target = store.taskRuns.get(rootSessionID);
  let changed = false;
  const entries = [...store.taskRuns.entries()];
  for (const [key, source] of entries) {
    if (key === rootSessionID) continue;
    if (
      knownRootSessionID(store, key) !== rootSessionID
      && knownRootSessionID(store, source.rootSessionID) !== rootSessionID
    ) {
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

function rememberSessionParent(
  store: RuntimeStore,
  sessionID: string,
  parentID: string,
): boolean {
  if (!sessionID || !parentID || sessionID === parentID) return false;
  const previous = store.sessionParents.get(sessionID);
  if (previous !== parentID) store.sessionParents.set(sessionID, parentID);
  const rootSessionID = knownRootSessionID(store, sessionID);
  const migrated = migrateTaskWallRuns(store, rootSessionID);
  return previous !== parentID || migrated;
}

function sessionEventSources(
  properties: ObjectRecord,
  event: CompatibleEvent,
): ObjectRecord[] {
  return [
    asRecord(properties.info),
    asRecord(properties.session),
    asRecord(event.info),
    asRecord(event.session),
    properties,
    event,
  ].filter((value): value is ObjectRecord => value !== undefined);
}

export function cacheSessionParentFromEvent(store: RuntimeStore, input: unknown): boolean {
  const event = normalizeEvent(input);
  if (!event) return false;
  const type = eventType(event);
  if (type !== "session.created" && type !== "session.updated") return false;
  const properties = eventProperties(event);
  const sessionID = readSessionID(properties, event);
  const parentID = readStringFrom(
    sessionEventSources(properties, event),
    ["parentID", "parentSessionID", "parentSessionId", "parent.id"],
  );
  if (!sessionID || !parentID) return false;
  return rememberSessionParent(store, sessionID, parentID);
}

function rootSessionIDFor(
  store: RuntimeStore,
  api: TuiPluginApi,
  sessionID: string,
  info?: ObjectRecord,
): string {
  const parent = parentSessionID(api, sessionID, info);
  if (parent) rememberSessionParent(store, sessionID, parent);
  const rootSessionID = knownRootSessionID(store, sessionID);
  migrateTaskWallRuns(store, rootSessionID);
  return rootSessionID;
}

function getTaskWallRun(store: RuntimeStore, rootSessionID: string): TaskWallRun {
  migrateTaskWallRuns(store, rootSessionID);
  const existing = store.taskRuns.get(rootSessionID);
  if (existing) return existing;
  const run = createTaskWallRun(rootSessionID);
  store.taskRuns.set(rootSessionID, run);
  return run;
}

function findTaskWallRun(
  store: RuntimeStore,
  rootSessionID: string,
  sessionID: string,
): TaskWallRun | undefined {
  const direct = store.taskRuns.get(rootSessionID);
  if (direct) return direct;
  for (const [key, run] of store.taskRuns) {
    if (
      key === sessionID
      || run.rootSessionID === sessionID
      || run.participantSessions.has(sessionID)
      || run.activeSessions.has(sessionID)
      || run.sessionStates.has(sessionID)
      || run.pendingSessions.has(sessionID)
    ) {
      return run;
    }
  }
  return undefined;
}

export function taskWallTimeForSession(
  store: RuntimeStore,
  sessionID: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!sessionID) return undefined;
  const rootSessionID = knownRootSessionID(store, sessionID);
  migrateTaskWallRuns(store, rootSessionID);
  const run = findTaskWallRun(store, rootSessionID, sessionID);
  if (!run) return undefined;
  if (run.phase === "active" && run.runStartedAt !== undefined) {
    return Math.max(0, now - run.runStartedAt);
  }
  if (run.lastRunWallTime) return run.lastRunWallTime.wallTime;
  return undefined;
}

export function noteTaskRecord(
  store: RuntimeStore,
  api: TuiPluginApi,
  record: HistoryRecord,
): void {
  const info = record.parentSessionID ? { parentSessionID: record.parentSessionID } : undefined;
  const rootSessionID = rootSessionIDFor(store, api, record.sessionID, info);
  const run = findTaskWallRun(store, rootSessionID, record.sessionID);
  if (!run || run.phase !== "active") return;
  const summary = noteTaskRunRecord(
    run,
    record.sessionID,
    record.time.start,
    record.time.completed,
  );
  if (summary) store.bump();
}

function recordDelta(
  store: RuntimeStore,
  properties: ObjectRecord,
  event: CompatibleEvent,
  stream: StreamName,
  explicitKind: SampleKind | undefined,
  bytesPerToken: number,
): void {
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const delta = readDelta(properties, event);
  if (!delta) return;
  const timestamp = eventTimestamp(event, properties);
  const runtime = ensureSessionRun(store, sessionID, timestamp);
  const existingState = (messageID ? store.active.get(messageID) : undefined)
    ?? store.active.get(pendingKey(sessionID));
  const bytes = utf8ByteLength(delta);
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  const sample: SpeedSample = {
    timestamp,
    tokens: estimatedTokens,
    estimatedTokens,
    bytes,
    kind: explicitKind ?? inferKind(properties, event),
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
  runtime.runFirstTokenAt = runtime.runFirstTokenAt === undefined
    ? timestamp
    : Math.min(runtime.runFirstTokenAt, timestamp);
  if (messageID) runtime.activeMessageID = messageID;
  state[stream].hasData = true;
  state[stream].samples.push(sample);
  state[stream].samples.sort((left, right) => left.timestamp - right.timestamp);
  store.active.set(messageID ?? pendingKey(sessionID), state);
  store.bump();
}

function recordStepStarted(
  store: RuntimeStore,
  properties: ObjectRecord,
  event: CompatibleEvent,
): void {
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

function recordStepFallback(
  store: RuntimeStore,
  properties: ObjectRecord,
  event: CompatibleEvent,
): void {
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const timestamp = eventTimestamp(event, properties);
  const runtime = ensureSessionRun(store, sessionID, timestamp);
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.fallbackTokens = mergeTokenFields(
    state.fallbackTokens,
    tokenFields(properties.tokens ?? properties),
  );
  state.model = state.model ?? modelName(properties);
  state.cost = state.cost ?? readNumber(properties.cost);
  if (messageID) runtime.activeMessageID = messageID;
  store.active.set(messageID ?? pendingKey(sessionID), state);
  store.bump();
}

function addOptimisticRecord(store: RuntimeStore, record: HistoryRecord): void {
  store.optimistic.set(record.messageID, record);
  store.records = mergeHistoryLayers(store.records, store.optimistic, store.maxRecords);
  store.bump();
}

function handleMessageUpdated(
  store: RuntimeStore,
  api: TuiPluginApi,
  properties: ObjectRecord,
  event: CompatibleEvent,
  bytesPerToken: number,
): boolean {
  const info = eventInfo(properties, event);
  if (!info || info.role !== "assistant") return false;
  const messageID = readMessageID(properties, info);
  const sessionID = readStringFrom([info, properties, event], [
    "sessionID",
    "sessionId",
    "session.id",
  ]);
  if (!messageID || !sessionID) return false;
  const timestamp = eventTimestamp(event, properties);

  if (!isCompleted(info, properties, event)) {
    const runtime = ensureSessionRun(store, sessionID, timestamp);
    const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
    state.startedAt = Math.min(
      state.startedAt,
      infoTimeValue(info, ["start", "created"]) ?? timestamp,
    );
    state.model = state.model ?? modelName(info);
    state.cost = state.cost ?? readNumber(info.cost);
    state.fallbackTokens = mergeTokenFields(state.fallbackTokens, tokenFields(info.tokens));
    runtime.activeMessageID = messageID;
    store.active.set(messageID, state);
    store.bump();
    return false;
  }

  if (store.completedMessageIDs.has(messageID)) {
    store.active.delete(messageID);
    const runtime = getSessionRuntime(store, sessionID);
    if (runtime.activeMessageID === messageID) runtime.activeMessageID = undefined;
    return false;
  }
  const state = takeActiveState(store.active, messageID, sessionID);
  const tokens = makeTokens(info, state, bytesPerToken);
  const record = makeHistoryRecord({
    messageID,
    sessionID,
    parentSessionID: parentSessionID(api, sessionID, info),
    model: modelName(info) ?? state?.model,
    cost: readNumber(info.cost) ?? state?.cost ?? 0,
    tokens,
    samples: calibrateResponseSamples(finalSamples(state), {
      output: tokens.output,
      reasoning: tokens.reasoning,
    }),
    state,
    info,
    completedAt: timestamp,
  });
  commitRecord(store, record, true);
  noteTaskRecord(store, api, record);
  return true;
}

function flushIdleStates(
  store: RuntimeStore,
  api: TuiPluginApi,
  sessionID: string,
  bytesPerToken: number,
  completedAt = Date.now(),
): boolean {
  let flushed = false;
  const entries = [...store.active.entries()].filter(([, state]) => state.sessionID === sessionID);
  for (const [key, state] of entries) {
    store.active.delete(key);
    if (state.messageID.startsWith("__pending__:")) continue;
    const tokens = makeTokens(undefined, state, bytesPerToken);
    const record = makeHistoryRecord({
      messageID: state.messageID,
      sessionID,
      parentSessionID: parentSessionID(api, sessionID),
      model: state.model,
      cost: state.cost ?? 0,
      tokens,
      samples: calibrateResponseSamples(finalSamples(state), {
        output: tokens.output,
        reasoning: tokens.reasoning,
      }),
      state,
      completedAt,
    });
    commitRecord(store, record, false);
    flushed = true;
  }
  if (entries.length > 0) store.bump();
  return flushed;
}

function sessionRunStatus(
  type: string,
  properties: ObjectRecord,
  event: CompatibleEvent,
): SessionRunStatus | undefined {
  if (type === "session.idle") return "idle";
  if (type !== "session.status" && !type.endsWith(".status")) return undefined;
  const value = properties.status ?? properties.state ?? event.status;
  const name = statusName(value);
  if (name === "busy" || name === "retry") return name;
  if (terminalStatus(value)) return "idle";
  return undefined;
}

function finishSessionRun(
  store: RuntimeStore,
  api: TuiPluginApi,
  sessionID: string,
  bytesPerToken: number,
  completedAt: number,
): boolean {
  const runtime = getSessionRuntime(store, sessionID);
  const hadActive = [...store.active.values()].some((state) => state.sessionID === sessionID);
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

export function handleSessionLifecycle(
  store: RuntimeStore,
  api: TuiPluginApi,
  type: string,
  properties: ObjectRecord,
  event: CompatibleEvent,
  bytesPerToken: number,
): boolean {
  const sessionID = readSessionID(properties, event);
  const status = sessionRunStatus(type, properties, event);
  if (!sessionID || status === undefined) return false;
  const timestamp = eventTimestamp(event, properties);
  const rootSessionID = rootSessionIDFor(store, api, sessionID);
  const taskRun = status === "idle"
    ? findTaskWallRun(store, rootSessionID, sessionID)
    : getTaskWallRun(store, rootSessionID);
  if (status === "idle") {
    const finishedSession = finishSessionRun(store, api, sessionID, bytesPerToken, timestamp);
    const finishedTask = taskRun
      ? transitionTaskWallRun(taskRun, sessionID, "idle", timestamp)
      : undefined;
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

export function mergeHistoryLayers(
  diskRecords: readonly HistoryRecord[],
  optimistic: ReadonlyMap<string, HistoryRecord>,
  maxRecords: number,
): HistoryRecord[] {
  const byMessage = new Map<string, HistoryRecord>();
  for (const record of diskRecords) {
    byMessage.set(record.messageID, record);
  }
  for (const [messageID, record] of optimistic) {
    byMessage.set(messageID, record);
  }
  return [...byMessage.values()].slice(-maxRecords);
}

function tokenCountsEqual(left: TokenCounts, right: TokenCounts): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.reasoning === right.reasoning
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite;
}

export function historyRecordsEquivalent(
  left: HistoryRecord,
  right: HistoryRecord,
): boolean {
  return left.messageID === right.messageID
    && left.sessionID === right.sessionID
    && left.parentSessionID === right.parentSessionID
    && left.model === right.model
    && left.cost === right.cost
    && tokenCountsEqual(left.tokens, right.tokens)
    && left.time.start === right.time.start
    && left.time.firstToken === right.time.firstToken
    && left.time.completed === right.time.completed
    && left.time.ttft === right.time.ttft
    && left.time.duration === right.time.duration;
}

function recordCompletedAt(record: HistoryRecord): number {
  return record.time.completed ?? record.time.start;
}

function hydrateHistoryState(
  store: RuntimeStore,
  diskRecords: readonly HistoryRecord[],
): void {
  for (const record of diskRecords) {
    const overlay = store.optimistic.get(record.messageID);
    if (overlay && !historyRecordsEquivalent(overlay, record)) continue;
    store.completedMessageIDs.add(record.messageID);
    const existing = store.lastCompletedBySession.get(record.sessionID);
    if (
      existing === undefined
      || recordCompletedAt(record) >= recordCompletedAt(existing.record)
    ) {
      const runtime = store.sessionRuntime.get(record.sessionID);
      store.lastCompletedBySession.set(
        record.sessionID,
        makeLastCompletedSnapshot(record, runtime?.runEpoch ?? 0),
      );
    }
  }
}

async function reloadHistory(
  store: RuntimeStore,
  api: TuiPluginApi,
  path: string,
  maxRecords: number,
  generation = store.historyGeneration,
): Promise<void> {
  if (store.disposed) return;
  try {
    const diskRecords = (await readHistoryFile(path)).slice(-maxRecords);
    if (store.disposed || generation !== store.historyGeneration) return;
    for (const record of diskRecords) {
      const overlay = store.optimistic.get(record.messageID);
      if (overlay && historyRecordsEquivalent(overlay, record)) {
        store.optimistic.delete(record.messageID);
      }
    }
    hydrateHistoryState(store, diskRecords);
    store.records = mergeHistoryLayers(diskRecords, store.optimistic, maxRecords);
    store.bump();
  } catch (error) {
    warnWithToast(api, "history read failed", error);
  }
}

function resolveOptions(value: unknown): TuiOptions {
  const options = asRecord(value);
  const maxRecordsValue = readNumber(options?.maxRecords);
  const bytesPerTokenValue = readNumber(options?.bytesPerToken);
  return {
    historyPath: readString(options?.historyPath),
    maxRecords: maxRecordsValue !== undefined && maxRecordsValue > 0
      ? Math.max(1, Math.floor(maxRecordsValue))
      : DEFAULT_MAX_RECORDS,
    bytesPerToken: bytesPerTokenValue !== undefined && bytesPerTokenValue > 0
      ? bytesPerTokenValue
      : DEFAULT_BYTES_PER_TOKEN,
    enabled: options?.enabled !== false,
  };
}

function resolveHistoryPath(api: TuiPluginApi, configuredPath: string | undefined): string {
  const base = api.state.path.worktree
    && api.state.path.worktree !== "/"
    ? api.state.path.worktree
    : api.state.path.directory;
  const relativeOrAbsolute = configuredPath && configuredPath.trim().length > 0
    ? configuredPath
    : DEFAULT_HISTORY_PATH;
  return isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : join(base, relativeOrAbsolute);
}

export function createRuntimeStore(maxRecords: number): RuntimeStore {
  return createRoot((disposeSignals): RuntimeStore => {
    const [revision, setRevision] = createSignal(0);
    return {
      maxRecords,
      records: [],
      optimistic: new Map<string, HistoryRecord>(),
      active: new Map<string, ActiveState>(),
      completedMessageIDs: new Set<string>(),
      sessionRuntime: new Map<string, SessionRuntime>(),
      taskRuns: new Map<string, TaskWallRun>(),
      sessionParents: new Map<string, string>(),
      lastCompletedBySession: new Map<string, LastCompletedSnapshot>(),
      pulseExpanded: false,
      historyGeneration: 0,
      revision,
      bump: () => setRevision((value) => value + 1),
      disposed: false,
      disposeSignals,
    };
  });
}

function once(dispose: () => void): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
}

function shortTail(value: string | undefined, maxLength = 12): string {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  return `...${value.slice(-(maxLength - 3))}`;
}

function truncateMiddle(value: string | undefined, maxLength: number): string {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const left = Math.ceil((maxLength - 3) / 2);
  const right = maxLength - 3 - left;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

function generatedTokens(tokens: TokenCounts): number {
  return tokens.output + tokens.reasoning;
}

export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.cacheRead + tokens.output + tokens.reasoning;
}

export function formatCompactNumber(value: number): string {
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

export function formatCompactRate(value: number): string {
  return `${formatCompactNumber(value)} tok/s`;
}

export function formatPulseMetrics(tokens: TokenCounts, speed: number): string {
  const speedLabel = Number.isFinite(speed) && speed > 0
    ? ` · ${formatCompactRate(speed)}`
    : "";
  return `${formatCompactNumber(totalTokens(tokens))} total${speedLabel}`;
}

export function formatPulseSummary(tokens: TokenCounts, speed: number): string {
  const speedLabel = Number.isFinite(speed) && speed > 0
    ? `  ${formatCompactRate(speed)}`
    : "";
  return `+ Token Pulse  ${formatCompactNumber(totalTokens(tokens))} total${speedLabel}`;
}

function formatCost(value: number): string {
  return `$${formatNumber(value, 4)}`;
}

function formatTime(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toISOString().slice(11, 19);
}

function formatOptionalDuration(value: number | undefined): string {
  return value === undefined ? "--" : formatDuration(value);
}

export function generationElapsed(record: HistoryRecord): number | undefined {
  const completed = record.time.completed;
  const firstToken = record.time.firstToken;
  if (
    typeof completed === "number"
    && Number.isFinite(completed)
    && typeof firstToken === "number"
    && Number.isFinite(firstToken)
  ) {
    return Math.max(0, completed - firstToken);
  }
  return durationOf(record);
}

function stableGeneratedRate(record: HistoryRecord): number {
  const elapsed = generationElapsed(record);
  const generated = generatedTokens(record.tokens);
  return elapsed !== undefined && elapsed > 0 ? (generated * 1000) / elapsed : 0;
}

export function recordSpeedSummary(record: HistoryRecord): RecordSpeedSummary {
  const generated = generatedTokens(record.tokens);
  const sampleStats = calculateSpeedStats(record.samples);
  const stableRate = stableGeneratedRate(record);
  if (record.samples.length >= 2 && sampleStats.avg > 0) {
    return { ...sampleStats, avg: stableRate > 0 ? stableRate : sampleStats.avg, generated };
  }
  return {
    avg: stableRate,
    max: stableRate,
    min: stableRate,
    generated,
  };
}

export function aggregateSpeed(records: readonly HistoryRecord[]): number {
  let generated = 0;
  let elapsed = 0;
  for (const record of records) {
    const generationTime = generationElapsed(record);
    if (generationTime === undefined || generationTime <= 0) continue;
    generated += generatedTokens(record.tokens);
    elapsed += generationTime;
  }
  return elapsed > 0 ? (generated * 1000) / elapsed : 0;
}

function sparkline(samples: readonly SpeedSample[], width = 8): string {
  if (width <= 0) return "";
  if (samples.length === 0) return ".".repeat(width);
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const values = Array.from({ length: width }, (_, index) => {
    const start = Math.floor((index * ordered.length) / width);
    const end = Math.max(start + 1, Math.floor(((index + 1) * ordered.length) / width));
    const bucket = ordered.slice(start, Math.min(end, ordered.length));
    return bucket.reduce((sum, sample) => sum + Math.max(0, sample.tokens), 0);
  });
  const max = Math.max(...values);
  const min = Math.min(...values);
  return values.map((value) => {
    if (max === min) return SPARK_CHARS[3];
    const index = Math.round(((value - min) / (max - min)) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[Math.max(0, Math.min(SPARK_CHARS.length - 1, index))];
  }).join("");
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value.slice(-width) : value.padStart(width, " ");
}

function formatHistoryRow(record: HistoryRecord): string {
  const speed = recordSpeedSummary(record);
  const ttft = timeToFirstToken(record);
  const duration = durationOf(record);
  return [
    padRight(formatTime(record.time.completed ?? record.time.start), 8),
    padRight(shortTail(record.sessionID, 11), 11),
    padRight(truncateMiddle(record.model, 14), 14),
    padLeft(`${formatCompactNumber(record.tokens.output)}/${formatCompactNumber(record.tokens.reasoning)}`, 9),
    padLeft(formatCompactNumber(speed.avg), 6),
    padLeft(formatCompactNumber(speed.max), 6),
    padLeft(formatCompactNumber(speed.min), 6),
    padLeft(formatOptionalDuration(ttft), 7),
    padLeft(formatOptionalDuration(duration), 7),
    padLeft(formatCost(record.cost), 9),
    sparkline(record.samples),
  ].join(" ");
}

function summaryLines(
  label: string,
  tokens: TokenCounts,
  cost: number,
  responseCount: number,
): string[] {
  return [
    label,
    `  Total tokens (input + generated) ${formatCompactNumber(totalTokens(tokens))}`,
    `  Uncached input ${formatCompactNumber(tokens.input)}  Cache read (reused) ${formatCompactNumber(tokens.cacheRead)}`,
    `  Cache write ${formatCompactNumber(tokens.cacheWrite)}  Visible output ${formatCompactNumber(tokens.output)}`,
    `  Reasoning ${formatCompactNumber(tokens.reasoning)}  Generated (output + reasoning) ${formatCompactNumber(generatedTokens(tokens))}`,
    `  Model calls ${formatCompactNumber(responseCount)}  Estimated cost ${formatCost(cost)}`,
  ];
}

function emptySummaryLines(): string[] {
  const empty = emptyTokenCounts();
  return [
    ...summaryLines("Session only", empty, 0, 0),
    ...summaryLines("Including subagents", empty, 0, 0),
    "No completed responses yet",
  ];
}

interface PulseMetric {
  label: string;
  value: string;
}

interface PulseSectionData {
  label: string;
  tokens: TokenCounts;
  cost: number;
  responseCount: number;
}

function pulseMetricRows(
  tokens: TokenCounts,
  cost: number,
  responseCount: number,
): PulseMetric[] {
  return [
    { label: "Total tokens (input + generated)", value: formatCompactNumber(totalTokens(tokens)) },
    { label: "Uncached input", value: formatCompactNumber(tokens.input) },
    { label: "Cache read (reused)", value: formatCompactNumber(tokens.cacheRead) },
    { label: "Cache write", value: formatCompactNumber(tokens.cacheWrite) },
    { label: "Visible output", value: formatCompactNumber(tokens.output) },
    { label: "Reasoning", value: formatCompactNumber(tokens.reasoning) },
    { label: "Generated", value: formatCompactNumber(generatedTokens(tokens)) },
    { label: "Model calls", value: formatCompactNumber(responseCount) },
    { label: "Estimated cost", value: formatCost(cost) },
  ];
}

function PulseMetricGrid(props: {
  theme: TuiPluginApi["theme"];
  rows: readonly (readonly PulseMetric[])[];
}): JSX.Element {
  return (
    <box flexDirection="column" width="100%">
      {props.rows.map((row) => (
        <box flexDirection="row" width="100%" columnGap={1}>
          {row.map((metric) => (
            <box flexDirection="column" flexBasis={0} flexGrow={1} minWidth={0}>
              <text fg={props.theme.current.textMuted} wrapMode="word">
                {metric.label}
              </text>
              <text fg={props.theme.current.text} truncate wrapMode="none">
                {metric.value}
              </text>
            </box>
          ))}
        </box>
      ))}
    </box>
  );
}

function PulseSection(props: {
  theme: TuiPluginApi["theme"];
  section: PulseSectionData;
}): JSX.Element {
  const metrics = pulseMetricRows(props.section.tokens, props.section.cost, props.section.responseCount);
  return (
    <box flexDirection="column" width="100%" paddingTop={1}>
      <text fg={props.theme.current.accent} truncate wrapMode="none">
        {props.section.label}
      </text>
      <PulseMetricGrid
        theme={props.theme}
        rows={[
          [metrics[0]],
          [metrics[1], metrics[2]],
          [metrics[3], metrics[4]],
          [metrics[5], metrics[6]],
          [metrics[7], metrics[8]],
        ]}
      />
    </box>
  );
}

function ChildAgentRows(props: {
  theme: TuiPluginApi["theme"];
  rows: readonly ChildRow[];
}): JSX.Element {
  return (
    <box flexDirection="column" width="100%" paddingTop={1}>
      <text fg={props.theme.current.accent} truncate wrapMode="none">CHILD AGENTS</text>
      {props.rows.map((row) => (
        <box
          flexDirection="column"
          width="100%"
          paddingTop={1}
          paddingLeft={1}
          border={["left"]}
          borderColor={props.theme.current.borderSubtle}
        >
          <text fg={props.theme.current.info} truncate wrapMode="none">
            {`${"  ".repeat(row.depth)}${shortTail(row.sessionID, 10)}  ${formatCompactNumber(row.responseCount)} responses  ${formatCompactNumber(row.generated)} generated`}
          </text>
          <text fg={props.theme.current.textMuted} truncate wrapMode="none">
            {`model ${truncateMiddle(row.model, 24)}  ${formatCompactRate(row.speed)}`}
          </text>
        </box>
      ))}
    </box>
  );
}

function aggregateForSession(
  records: readonly HistoryRecord[],
  sessionID: string | undefined,
): SessionAggregate | undefined {
  if (!sessionID) return undefined;
  const direct = aggregateSession(records, sessionID);
  if (direct) return direct;

  const roots = aggregateSessionTree(records);
  const children: SessionAggregate[] = [];
  const visit = (node: SessionAggregate) => {
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
    children,
  };
}

function recordsForSession(
  records: readonly HistoryRecord[],
  sessionID: string | undefined,
): HistoryRecord[] {
  if (!sessionID) return [...records];
  const aggregate = aggregateForSession(records, sessionID);
  if (!aggregate) return records.filter((record) => record.sessionID === sessionID);
  const ids = new Set<string>();
  const visit = (node: SessionAggregate) => {
    ids.add(node.sessionID);
    node.children.forEach(visit);
  };
  visit(aggregate);
  return records.filter((record) => ids.has(record.sessionID));
}

function recentRecords(
  records: readonly HistoryRecord[],
  sessionID: string | undefined,
): HistoryRecord[] {
  return recordsForSession(records, sessionID)
    .slice()
    .sort((left, right) => (
      (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start)
    ))
    .slice(0, 24);
}

function childRows(
  records: readonly HistoryRecord[],
  aggregate: SessionAggregate | undefined,
): ChildRow[] {
  if (!aggregate) return [];
  const rows: ChildRow[] = [];
  const visit = (node: SessionAggregate, depth: number) => {
    const directRecords = records.filter((record) => record.sessionID === node.sessionID);
    const subtreeIDs = new Set<string>();
    const collectIDs = (current: SessionAggregate) => {
      subtreeIDs.add(current.sessionID);
      current.children.forEach(collectIDs);
    };
    collectIDs(node);
    const subtreeRecords = records.filter((record) => subtreeIDs.has(record.sessionID));
    const displayRecords = directRecords.length > 0 ? directRecords : subtreeRecords;
    const directGenerated = generatedTokens(node.directTokens);
    const responseCount = node.directResponseCount || node.responseCount;
    const generated = node.directResponseCount > 0 ? directGenerated : generatedTokens(node.tokens);
    const modelRecord = displayRecords
      .slice()
      .sort((left, right) => (
        (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start)
      ))[0];
    rows.push({
      depth,
      sessionID: node.sessionID,
      responseCount,
      generated,
      speed: aggregateSpeed(displayRecords),
      model: modelRecord?.model ?? "-",
    });
    node.children.forEach((child) => visit(child, depth + 1));
  };
  aggregate.children.forEach((child) => visit(child, 0));
  return rows;
}

function activeStats(
  state: ActiveState | undefined,
  now: number,
  bytesPerToken: number,
): {
  rate: number;
  generated: number;
  ttft?: number;
  elapsed: number;
} {
  if (!state) return { rate: 0, generated: 0, elapsed: 0 };
  const tokens = estimateActiveTokens(state, bytesPerToken);
  return {
    rate: rollingTokenRate(selectedSamples(state), now, DEFAULT_ROLLING_WINDOW_MS),
    generated: generatedTokens(tokens),
    ...(state.firstTokenAt !== undefined
      ? { ttft: Math.max(0, state.firstTokenAt - state.startedAt) }
      : {}),
    elapsed: Math.max(0, now - state.startedAt),
  };
}

function latestActive(
  active: ReadonlyMap<string, ActiveState>,
  sessionID: string,
  preferredMessageID?: string,
): ActiveState | undefined {
  const preferred = preferredMessageID ? active.get(preferredMessageID) : undefined;
  if (preferred?.sessionID === sessionID) return preferred;
  return [...active.values()]
    .filter((state) => state.sessionID === sessionID && !state.messageID.startsWith("__pending__:"))
    .sort((left, right) => right.startedAt - left.startedAt)[0]
    ?? [...active.values()]
      .filter((state) => state.sessionID === sessionID)
      .sort((left, right) => right.startedAt - left.startedAt)[0];
}

function liveLabel(
  store: RuntimeStore,
  sessionID: string,
  bytesPerToken: number,
  width: number,
): string {
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

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current;
  if (route.name !== "session") return undefined;
  return readString(route.params?.sessionID);
}

function routeSessionID(params: Record<string, unknown> | undefined): string | undefined {
  return readString(params?.sessionID);
}

function leaveHistory(api: TuiPluginApi): void {
  const route = api.route.current;
  const sessionID = route.name === HISTORY_ROUTE ? routeSessionID(route.params) : undefined;
  if (sessionID) api.route.navigate("session", { sessionID });
  else api.route.navigate("home");
}

function warnWithToast(api: TuiPluginApi, message: string, error?: unknown): void {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  console.warn(`[oc-tps] ${message}${detail}`);
  try {
    api.ui.toast({
      variant: "warning",
      message: `oc-tps: ${message}${detail}`,
      duration: 4000,
    });
  } catch {
    // TUI may be disposing while an async history read finishes.
  }
}

function Header(props: { theme: TuiPluginApi["theme"]; sessionID?: string }): JSX.Element {
  return (
    <box
      height={2}
      paddingX={1}
      flexDirection="column"
      backgroundColor={props.theme.current.backgroundPanel}
    >
      <text fg={props.theme.current.primary}>OC TPS / history</text>
      <text fg={props.theme.current.textMuted} truncate wrapMode="none">
        session {shortTail(props.sessionID, 18)}
      </text>
    </box>
  );
}

function SummaryBlock(props: {
  theme: TuiPluginApi["theme"];
  store: RuntimeStore;
  sessionID?: string;
}): JSX.Element {
  const lines = createMemo(() => {
    props.store.revision();
    const aggregate = aggregateForSession(props.store.records, props.sessionID);
    if (!aggregate) return emptySummaryLines();
    return [
      ...summaryLines(
        "Session only",
        aggregate.directTokens,
        aggregate.directCost,
        aggregate.directResponseCount,
      ),
      ...summaryLines("Including subagents", aggregate.tokens, aggregate.cost, aggregate.responseCount),
    ];
  });
  return (
    <box paddingX={1} flexDirection="column" backgroundColor={props.theme.current.background}>
      <text fg={props.theme.current.secondary}>totals</text>
      {lines().map((line) => (
        <text fg={props.theme.current.text} wrapMode="word">{line}</text>
      ))}
    </box>
  );
}

function HistoryView(props: {
  api: TuiPluginApi;
  store: RuntimeStore;
  sessionID?: string;
  options: TuiOptions;
}): JSX.Element {
  const rows = createMemo(() => {
    props.store.revision();
    return recentRecords(props.store.records, props.sessionID);
  });
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={props.api.theme.current.background}>
      <Header theme={props.api.theme} sessionID={props.sessionID} />
      <SummaryBlock theme={props.api.theme} store={props.store} sessionID={props.sessionID} />
      <box height={1} paddingX={1} backgroundColor={props.api.theme.current.backgroundElement}>
        <text fg={props.api.theme.current.textMuted} truncate wrapMode="none">
          TIME     SESSION      MODEL            OUT/REAS  AVG    MAX    MIN    TTFT    DUR      COST      SPARK
        </text>
      </box>
      <scrollbox
        flexGrow={1}
        flexDirection="column"
        paddingX={1}
        stickyScroll
        stickyStart="top"
        backgroundColor={props.api.theme.current.background}
      >
        {rows().length === 0 ? (
          <text fg={props.api.theme.current.textMuted}>No completed responses yet</text>
        ) : rows().map((record) => (
          <text fg={props.api.theme.current.text} truncate wrapMode="none">
            {formatHistoryRow(record)}
          </text>
        ))}
      </scrollbox>
    </box>
  );
}

function PromptRight(props: {
  api: TuiPluginApi;
  store: RuntimeStore;
  sessionID: string;
  options: TuiOptions;
}): JSX.Element {
  setFocusSession(props.store, props.sessionID);
  const label = createMemo(() => {
    props.store.revision();
    return liveLabel(
      props.store,
      props.sessionID,
      props.options.bytesPerToken,
      Math.max(1, props.api.renderer.width),
    );
  });
  return <text fg={props.api.theme.current.accent} truncate wrapMode="none">{label()}</text>;
}

function setFocusSession(store: RuntimeStore, sessionID: string | undefined): void {
  if (!sessionID || store.focusSessionID === sessionID) return;
  store.focusSessionID = sessionID;
  store.bump();
}

export function togglePulse(store: RuntimeStore): boolean {
  store.pulseExpanded = !store.pulseExpanded;
  store.bump();
  return store.pulseExpanded;
}

function BottomContent(props: {
  api: TuiPluginApi;
  store: RuntimeStore;
  sessionID: string;
}): JSX.Element {
  const sessionID = createMemo(() => {
    props.store.revision();
    return props.store.focusSessionID ?? props.sessionID;
  });
  const view = createMemo((): AggregateView => {
    props.store.revision();
    return {
      aggregate: aggregateForSession(props.store.records, sessionID()),
      records: props.store.records,
    };
  });
  const taskWallTime = createMemo(() => {
    props.store.revision();
    return taskWallTimeForSession(props.store, sessionID());
  });
  const rows = createMemo(() => childRows(view().records, view().aggregate));
  const sections = createMemo((): PulseSectionData[] => {
    const aggregate = view().aggregate;
    if (!aggregate) {
      return [
        { label: "SESSION ONLY", tokens: emptyTokenCounts(), cost: 0, responseCount: 0 },
        { label: "INCLUDING SUBAGENTS", tokens: emptyTokenCounts(), cost: 0, responseCount: 0 },
      ];
    }
    return [
      {
        label: "SESSION ONLY",
        tokens: aggregate.directTokens,
        cost: aggregate.directCost,
        responseCount: aggregate.directResponseCount,
      },
      {
        label: "INCLUDING SUBAGENTS",
        tokens: aggregate.tokens,
        cost: aggregate.cost,
        responseCount: aggregate.responseCount,
      },
    ];
  });
  const pulseSummary = createMemo(() => {
    const currentView = view();
    const currentSessionID = sessionID();
    const aggregate = currentView.aggregate;
    return {
      tokens: aggregate?.tokens ?? emptyTokenCounts(),
      speed: aggregate && currentSessionID
        ? aggregateSpeed(recordsForSession(currentView.records, currentSessionID))
        : 0,
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
  const onPulseMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    togglePulse(props.store);
  };
  return (
    <box
      flexDirection="column"
      width="100%"
      paddingTop={1}
      paddingX={1}
      overflow="hidden"
    >
      <box
        focusable
        width="100%"
        height={1}
        paddingX={1}
        backgroundColor={props.api.theme.current.backgroundElement}
        onMouseDown={onPulseMouseDown}
      >
        <text fg={props.api.theme.current.primary} truncate wrapMode="none">
          {expanded() ? "- Token Pulse" : "+ Token Pulse"}
        </text>
      </box>
      <text fg={props.api.theme.current.textMuted} width="100%" paddingX={1} truncate wrapMode="none">
        {metricLabel()}
      </text>
      {expanded() && (!sessionID() ? (
        <text fg={props.api.theme.current.textMuted} paddingTop={1} truncate wrapMode="none">
          No active session
        </text>
      ) : (
        <>
          <text fg={props.api.theme.current.secondary} paddingTop={1} truncate wrapMode="none">
            session {shortTail(sessionID(), 18)}
          </text>
          {sections().map((section) => (
            <PulseSection theme={props.api.theme} section={section} />
          ))}
          {!view().aggregate && (
            <text fg={props.api.theme.current.textMuted} paddingTop={1} truncate wrapMode="none">
              No completed responses yet
            </text>
          )}
          <box flexDirection="column" width="100%" paddingTop={1}>
            <text fg={props.api.theme.current.accent} truncate wrapMode="none">SESSION RUN</text>
            <PulseMetricGrid
              theme={props.api.theme}
              rows={[[{ label: "Task wall time", value: taskWallTimeLabel() }]]}
            />
          </box>
          {rows().length > 0 && <ChildAgentRows theme={props.api.theme} rows={rows()} />}
        </>
      ))}
    </box>
  );
}

export function createTuiSlotPlugin(
  api: TuiPluginApi,
  store: RuntimeStore,
  options: TuiOptions,
): TuiSlotPlugin {
  return {
    order: 1_000_000,
    slots: {
      sidebar_content: (_context, props) => (
        <BottomContent api={api} store={store} sessionID={props.session_id} />
      ),
      session_prompt_right: (_context, props) => (
        <PromptRight
          api={api}
          store={store}
          sessionID={props.session_id}
          options={options}
        />
      ),
    },
  };
}

function registerLegacyCommand(api: TuiPluginApi, openHistory: () => void): void {
  if (!api.command) return;
  try {
    const dispose = once(api.command.register(() => [
      {
        title: "Open token history",
        value: COMMAND_NAME,
        description: "Open recent token speed history for the current session",
        category: "Plugin",
        keybind: "ctrl+shift+t",
        slash: { name: "tps" },
        onSelect: openHistory,
      },
    ]));
    api.lifecycle.onDispose(dispose);
  } catch (error) {
    warnWithToast(api, "legacy command registration failed", error);
  }
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = resolveOptions(rawOptions);
  if (!options.enabled) return;

  const store = createRuntimeStore(options.maxRecords);
  const historyPath = resolveHistoryPath(api, options.historyPath);
  let disposed = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadGeneration = 0;

  const scheduleReload = (): void => {
    reloadGeneration += 1;
    const generation = reloadGeneration;
    store.historyGeneration = generation;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    const run = async (attempt: number): Promise<void> => {
      if (disposed || generation !== reloadGeneration) return;
      reloadTimer = undefined;
      await reloadHistory(store, api, historyPath, options.maxRecords, generation);
      if (
        !disposed
        && generation === reloadGeneration
        && attempt < 3
        && store.optimistic.size > 0
      ) {
        reloadTimer = setTimeout(() => {
          void run(attempt + 1);
        }, 100);
      }
    };
    reloadTimer = setTimeout(() => {
      void run(0);
    }, 30);
  };

  const openHistory = (): void => {
    const sessionID = currentSessionID(api);
    api.route.navigate(HISTORY_ROUTE, sessionID ? { sessionID } : undefined);
  };

  try {
    api.route.register([
      {
        name: HISTORY_ROUTE,
        render: ({ params }) => {
          const popMode = api.mode.push(HISTORY_MODE);
          onCleanup(popMode);
          return (
            <HistoryView
              api={api}
              store={store}
              sessionID={routeSessionID(params)}
              options={options}
            />
          );
        },
      },
    ]);

    api.keymap.registerLayer({
      mode: "base",
      commands: [
        {
          name: COMMAND_NAME,
          title: "Open token history",
          description: "Open recent token speed history for the current session",
          category: "Plugin",
          namespace: "palette",
          slashName: "tps",
          run: openHistory,
        },
      ],
      bindings: [
        {
          key: "ctrl+shift+t",
          cmd: COMMAND_NAME,
          desc: "Open token history",
        },
      ],
    });
    api.keymap.registerLayer({
      mode: HISTORY_MODE,
      priority: 100,
      commands: [
        {
          name: "oc-tps.history.back",
          title: "Return from token history",
          description: "Return to the current session or home",
          category: "Plugin",
          run: () => leaveHistory(api),
        },
      ],
      bindings: [
        {
          key: "escape",
          cmd: "oc-tps.history.back",
          desc: "Return to current session",
        },
      ],
    });
  } catch (error) {
    warnWithToast(api, "keymap registration failed; using legacy command API", error);
    registerLegacyCommand(api, openHistory);
  }

  api.slots.register(createTuiSlotPlugin(api, store, options));

  // The generated SDK union can lag runtime legacy/v2 event names; keep this cast local.
  const eventOn = api.event.on as unknown as CompatibleEventOn;
  const subscribe = (
    type: CompatibleEventType,
    handler: (event: unknown) => void,
  ): void => {
    try {
      const dispose = once(eventOn.call(api.event, type, handler));
      api.lifecycle.onDispose(dispose);
    } catch (error) {
      console.warn(`[oc-tps] event subscription unavailable for ${type}`, error);
    }
  };

  const handleEvent = (input: unknown): void => {
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
        recordDelta(
          store,
          properties,
          event,
          "v2",
          type.endsWith("reasoning.delta") ? "reasoning" : "output",
          options.bytesPerToken,
        );
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
  tui,
};

export default plugin;
