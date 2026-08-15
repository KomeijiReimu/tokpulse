/** @jsxImportSource @opentui/solid */

import { isAbsolute, join } from "node:path";
import { createMemo, createRoot, createSignal, onCleanup } from "solid-js";
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
  calculateRateStats,
  calculateSpeedStats,
  calibrateResponseSamples,
  bytesToTokens,
  durationOf,
  emptyTokenCounts,
  formatDuration,
  formatNumber,
  formatTokens,
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
type StreamName = "legacy" | "v2";
type SampleKind = "output" | "reasoning";
type CompatibleEventType =
  | "message.part.delta"
  | "session.next.text.delta"
  | "session.next.reasoning.delta"
  | "message.updated"
  | "session.next.step.started"
  | "session.next.step.ended"
  | "session.idle"
  | "session.status";

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

interface ActiveState {
  messageID: string;
  sessionID: string;
  startedAt: number;
  firstTokenAt?: number;
  model?: string;
  cost?: number;
  fallbackTokens: Partial<TokenCounts>;
  legacy: CandidateStream;
  v2: CandidateStream;
}

interface TuiOptions {
  historyPath?: string;
  maxRecords: number;
  bytesPerToken: number;
  enabled: boolean;
}

interface RuntimeStore {
  maxRecords: number;
  records: HistoryRecord[];
  optimistic: Map<string, HistoryRecord>;
  active: Map<string, ActiveState>;
  completedMessageIDs: Set<string>;
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

interface RecordSpeedSummary extends RateStats {
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
  const nested = asRecord(outer.event);
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
  return readStringFrom([properties, event], [
    "sessionID",
    "sessionId",
    "session.id",
  ]);
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

function createActiveState(
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

function mergeActiveStates(target: ActiveState, source: ActiveState): void {
  target.startedAt = Math.min(target.startedAt, source.startedAt);
  if (
    target.firstTokenAt === undefined
    || (source.firstTokenAt !== undefined && source.firstTokenAt < target.firstTokenAt)
  ) {
    target.firstTokenAt = source.firstTokenAt;
  }
  target.model = target.model ?? source.model;
  target.cost = target.cost ?? source.cost;
  target.fallbackTokens = mergeTokenFields(source.fallbackTokens, target.fallbackTokens);
  target.legacy.hasData ||= source.legacy.hasData;
  target.legacy.samples.push(...source.legacy.samples);
  target.v2.hasData ||= source.v2.hasData;
  target.v2.samples.push(...source.v2.samples);
  target.legacy.samples.sort((left, right) => left.timestamp - right.timestamp);
  target.v2.samples.sort((left, right) => left.timestamp - right.timestamp);
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
  if (direct && pending && direct !== pending) {
    mergeActiveStates(direct, pending);
    active.delete(pendingID);
  }
  const state = direct ?? pending ?? createActiveState(messageID ?? pendingID, sessionID, timestamp);
  if (messageID) state.messageID = messageID;
  if (messageID && pending && state === pending) active.delete(pendingID);
  return state;
}

function takeActiveState(
  active: Map<string, ActiveState>,
  messageID: string,
  sessionID: string,
): ActiveState | undefined {
  const direct = active.get(messageID);
  const pendingID = pendingKey(sessionID);
  const pending = active.get(pendingID);
  if (direct && pending && direct !== pending) {
    mergeActiveStates(direct, pending);
    active.delete(pendingID);
  }
  const state = direct ?? pending;
  if (!state || state.sessionID !== sessionID) return undefined;
  active.delete(messageID);
  active.delete(pendingID);
  state.messageID = messageID;
  return state;
}

function selectedSamples(state: ActiveState | undefined): SpeedSample[] {
  if (!state) return [];
  return state.v2.hasData ? [...state.v2.samples] : [...state.legacy.samples];
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
    for (const sample of [...state.legacy.samples, ...state.v2.samples]) {
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

function isIdleEvent(type: string, properties: ObjectRecord, event: CompatibleEvent): boolean {
  if (type === "session.idle") return true;
  if (type !== "session.status" && !type.endsWith(".status")) return false;
  return terminalStatus(properties.status ?? properties.state ?? event.status);
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

function parentSessionID(api: TuiPluginApi, sessionID: string, info?: ObjectRecord): string | undefined {
  try {
    const session = api.state.session.get(sessionID);
    if (session?.parentID) return session.parentID;
  } catch {
    // State can still be syncing while a response completes.
  }
  return readStringFrom([info], ["parentSessionID", "parentID"]);
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
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  if (state.sessionID !== sessionID) return;
  state.startedAt = Math.min(state.startedAt, timestamp);
  state.firstTokenAt = state.firstTokenAt ?? timestamp;
  const bytes = utf8ByteLength(delta);
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  const sample: SpeedSample = {
    timestamp,
    tokens: estimatedTokens,
    estimatedTokens,
    bytes,
    kind: explicitKind ?? inferKind(properties, event),
  };
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
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.startedAt = Math.min(state.startedAt, timestamp);
  state.model = state.model ?? modelName(properties);
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
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.fallbackTokens = mergeTokenFields(
    state.fallbackTokens,
    tokenFields(properties.tokens ?? properties),
  );
  state.model = state.model ?? modelName(properties);
  state.cost = state.cost ?? readNumber(properties.cost);
  store.active.set(messageID ?? pendingKey(sessionID), state);
  store.bump();
}

function addOptimisticRecord(store: RuntimeStore, record: HistoryRecord): void {
  store.optimistic.set(record.messageID, record);
  store.records = mergeRecords(store.records, store.optimistic, store.maxRecords);
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
    const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
    state.startedAt = Math.min(
      state.startedAt,
      infoTimeValue(info, ["start", "created"]) ?? timestamp,
    );
    state.model = state.model ?? modelName(info);
    state.cost = state.cost ?? readNumber(info.cost);
    state.fallbackTokens = mergeTokenFields(state.fallbackTokens, tokenFields(info.tokens));
    store.active.set(messageID, state);
    store.bump();
    return false;
  }

  if (store.completedMessageIDs.has(messageID)) {
    store.active.delete(messageID);
    store.active.delete(pendingKey(sessionID));
    return true;
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
    samples: calibrateResponseSamples(selectedSamples(state), {
      output: tokens.output,
      reasoning: tokens.reasoning,
    }),
    state,
    info,
    completedAt: timestamp,
  });
  store.completedMessageIDs.add(messageID);
  addOptimisticRecord(store, record);
  return true;
}

function flushIdleStates(
  store: RuntimeStore,
  api: TuiPluginApi,
  sessionID: string,
  bytesPerToken: number,
): boolean {
  let flushed = false;
  const timestamp = Date.now();
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
      samples: calibrateResponseSamples(selectedSamples(state), {
        output: tokens.output,
        reasoning: tokens.reasoning,
      }),
      state,
      completedAt: timestamp,
    });
    addOptimisticRecord(store, record);
    flushed = true;
  }
  if (entries.length > 0) store.bump();
  return flushed;
}

function mergeRecords(
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

async function reloadHistory(
  store: RuntimeStore,
  api: TuiPluginApi,
  path: string,
  maxRecords: number,
): Promise<void> {
  if (store.disposed) return;
  try {
    const diskRecords = (await readHistoryFile(path)).slice(-maxRecords);
    for (const record of diskRecords) store.optimistic.delete(record.messageID);
    store.records = mergeRecords(diskRecords, store.optimistic, maxRecords);
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

function createRuntimeStore(maxRecords: number): RuntimeStore {
  return createRoot((disposeSignals): RuntimeStore => {
    const [revision, setRevision] = createSignal(0);
    return {
      maxRecords,
      records: [],
      optimistic: new Map<string, HistoryRecord>(),
      active: new Map<string, ActiveState>(),
      completedMessageIDs: new Set<string>(),
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

function formatRate(value: number): string {
  return `${formatNumber(value, 1)} tok/s`;
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

function recordSpeedSummary(record: HistoryRecord): RecordSpeedSummary {
  const generated = generatedTokens(record.tokens);
  const sampleStats = calculateSpeedStats(record.samples);
  if (record.samples.length >= 2 && sampleStats.avg > 0) {
    return { ...sampleStats, generated };
  }
  const duration = durationOf(record);
  const fallbackRate = duration !== undefined && duration > 0
    ? (generated * 1000) / duration
    : 0;
  return {
    avg: fallbackRate,
    max: fallbackRate,
    min: fallbackRate,
    generated,
  };
}

function aggregateSpeed(records: readonly HistoryRecord[]): number {
  const values = records
    .map((record) => recordSpeedSummary(record).avg)
    .filter((value) => Number.isFinite(value) && value > 0);
  return calculateRateStats(values).avg;
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
    padLeft(`${formatTokens(record.tokens.output)}/${formatTokens(record.tokens.reasoning)}`, 9),
    padLeft(formatNumber(speed.avg, 1), 6),
    padLeft(formatNumber(speed.max, 1), 6),
    padLeft(formatNumber(speed.min, 1), 6),
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
    `${label} in ${formatTokens(tokens.input)} out ${formatTokens(tokens.output)} reasoning ${formatTokens(tokens.reasoning)} generated ${formatTokens(generatedTokens(tokens))}`,
    `${label} cache ${formatTokens(tokens.cacheRead)}/${formatTokens(tokens.cacheWrite)} cost ${formatCost(cost)} responses ${formatTokens(responseCount)}`,
  ];
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
    const directGenerated = generatedTokens(node.directTokens);
    const responseCount = node.directResponseCount || node.responseCount;
    const generated = node.directResponseCount > 0 ? directGenerated : generatedTokens(node.tokens);
    const modelRecord = directRecords
      .slice()
      .sort((left, right) => (
        (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start)
      ))[0];
    rows.push({
      depth,
      sessionID: node.sessionID,
      responseCount,
      generated,
      speed: aggregateSpeed(directRecords),
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
): ActiveState | undefined {
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
  const state = latestActive(store.active, sessionID);
  const stats = activeStats(state, Date.now(), bytesPerToken);
  const rate = formatRate(stats.rate);
  if (width < 30) return rate;
  if (!state) return `${rate} idle`;
  if (width < 48) return `${rate} ${formatTokens(stats.generated)}t ${formatDuration(stats.elapsed)}`;
  return `${rate} ${formatTokens(stats.generated)}t ttft ${formatOptionalDuration(stats.ttft)} elapsed ${formatDuration(stats.elapsed)}`;
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
    if (!aggregate) return ["No completed responses yet"];
    return [
      ...summaryLines(
        "direct",
        aggregate.directTokens,
        aggregate.directCost,
        aggregate.directResponseCount,
      ),
      ...summaryLines("all", aggregate.tokens, aggregate.cost, aggregate.responseCount),
    ];
  });
  return (
    <box paddingX={1} flexDirection="column" backgroundColor={props.theme.current.background}>
      <text fg={props.theme.current.secondary}>totals</text>
      {lines().map((line) => (
        <text fg={props.theme.current.text} truncate wrapMode="none">{line}</text>
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

function SidebarContent(props: {
  api: TuiPluginApi;
  store: RuntimeStore;
  sessionID: string;
}): JSX.Element {
  const view = createMemo((): AggregateView => {
    props.store.revision();
    return {
      aggregate: aggregateForSession(props.store.records, props.sessionID),
      records: props.store.records,
    };
  });
  const rows = createMemo(() => childRows(view().records, view().aggregate));
  const lines = createMemo(() => {
    const aggregate = view().aggregate;
    if (!aggregate) return ["No completed responses yet"];
    return [
      ...summaryLines("direct", aggregate.directTokens, aggregate.directCost, aggregate.directResponseCount),
      ...summaryLines("all", aggregate.tokens, aggregate.cost, aggregate.responseCount),
    ];
  });
  return (
    <box flexDirection="column" paddingTop={1} paddingX={1}>
      <text fg={props.api.theme.current.secondary}>token pulse</text>
      {lines().map((line) => (
        <text fg={props.api.theme.current.textMuted} truncate wrapMode="none">{line}</text>
      ))}
      {rows().map((row) => (
        <box flexDirection="column" paddingTop={1}>
          <text fg={props.api.theme.current.info} truncate wrapMode="none">
            {`${"  ".repeat(row.depth)}> ${shortTail(row.sessionID, 10)} ${formatTokens(row.responseCount)}r ${formatTokens(row.generated)}t`}
          </text>
          <text fg={props.api.theme.current.textMuted} truncate wrapMode="none">
            {`  ${formatRate(row.speed)} ${truncateMiddle(row.model, 14)}`}
          </text>
        </box>
      ))}
    </box>
  );
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
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    const run = async (attempt: number): Promise<void> => {
      if (disposed || generation !== reloadGeneration) return;
      reloadTimer = undefined;
      await reloadHistory(store, api, historyPath, options.maxRecords);
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

  const slotPlugin: TuiSlotPlugin = {
    slots: {
      session_prompt_right: (_context, props) => (
        <PromptRight
          api={api}
          store={store}
          sessionID={props.session_id}
          options={options}
        />
      ),
      sidebar_content: (_context, props) => (
        <SidebarContent api={api} store={store} sessionID={props.session_id} />
      ),
    },
  };
  api.slots.register(slotPlugin);

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
        scheduleReload();
        return;
      }
      if (type === "message.updated") {
        if (handleMessageUpdated(store, api, properties, event, options.bytesPerToken)) {
          scheduleReload();
        }
        return;
      }
      if (isIdleEvent(type, properties, event)) {
        const sessionID = readSessionID(properties, event);
        if (sessionID && flushIdleStates(store, api, sessionID, options.bytesPerToken)) {
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
    store.disposeSignals();
  });

  await reloadHistory(store, api, historyPath, options.maxRecords);
};

const plugin = {
  id: "oc-tps",
  tui,
};

export default plugin;
