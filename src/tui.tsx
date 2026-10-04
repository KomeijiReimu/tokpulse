/** @jsxImportSource @opentui/solid */

import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { createMemo, createRoot, createSignal, onCleanup, onMount } from "solid-js";
import type { MouseEvent } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createBindingLookup, type BindingConfig, type BindingValue } from "@opencode-ai/plugin/tui";
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
  HistoryRecordQuality,
  RateStats,
  SessionAggregate,
  SpeedSample,
  TokenCounts,
  addTokenCounts,
  aggregateSession,
  aggregateSessionTree,
  calculateSpeedStats,
  dedupeHistoryRecords,
  calibrateResponseSamples,
  bytesToTokens,
  durationOf,
  emptyTokenCounts,
  formatDuration,
  formatNumber,
  normalizeTokenCounts,
  measureRollingTokenRate,
  timeToFirstToken,
  utf8ByteLength,
} from "./core.js";
import {
  replayActivity,
  resolveRootSessionID,
} from "./activity.js";
import type { ActivityEvent, ActivityReplay } from "./activity.js";
import { type CompletionUpdate, type ContentMetadataCache, type ContentProgress, type MeasuredHistoryRecord, type SpeedContribution, cachePartSnapshot, cachedContentProgress, coerceCompletionUpdate, coerceSpeedContribution, coerceSpeedTotals, contentSpeedObservations, createContentMetadataCache, earliestFirstOutput, isNewerCompletionUpdate, measureRecordSpeed, mergeRecordSpeed, parseModelDelta, sameSpeedContribution, updateSpeedTotals } from './statistics.js';
import { getSessionAverageSummary, type AverageRateSummary, type SessionAverageSummary } from "./statistics.js";
import {
  DEFAULT_MAX_RECORDS,
  readHistoryFile,
} from "./storage.js";
import { readActivityFile, resolveRunsPath } from "./runs-storage.js";
import { rollupSessionTotals } from "./totals-aggregate.js";
import type { TotalsRollup } from "./totals-aggregate.js";
import { TOTALS_VERSION, resolveTotalsPath } from "./totals-storage.js";
import type {
  OpenContribution,
  SessionDirectTotals,
  TotalsLedger,
} from "./totals-storage.js";

const DEFAULT_HISTORY_PATH = ".opencode/oc-tps/history.jsonl";
const HISTORY_ROUTE = "oc-tps-history";
const HISTORY_MODE = "oc-tps.history";
const COMMAND_NAME = "oc-tps.history";
export const DETAILS_COMMAND_NAME = "oc-tps.details";
const SPARK_CHARS = ".:-=+#";

type ObjectRecord = Record<string, unknown>;
export type StreamName = "legacy" | "v2";
type SampleKind = "output" | "reasoning";
export type RecordQuality = HistoryRecordQuality;
const recordQualityByObject = new WeakMap<object, RecordQuality>();
const observationRuntimes = new WeakMap<RuntimeStore, { instanceID: string; metadata: ContentMetadataCache }>();
function observationRuntime(store: RuntimeStore) {
  let runtime = observationRuntimes.get(store);
  if (!runtime) {
    runtime = { instanceID: randomUUID(), metadata: createContentMetadataCache() };
    observationRuntimes.set(store, runtime);
  }
  return runtime;
}
function knownCompletedMessage(store: RuntimeStore, messageID: string): boolean {
  return store.completedMessageIDs.has(messageID) || observationRuntime(store).metadata.completed.has(messageID)
    || store.totalsLedger.settled[messageID] !== undefined || store.totalsLedger.open[messageID]?.quality === "exact";
}
function knownNonAssistant(store: RuntimeStore, messageID: string): boolean {
  const role = observationRuntime(store).metadata.roles.get(messageID);
  return role !== undefined && role !== "assistant";
}
export function recordTuiPartMetadata(store: RuntimeStore, properties: ObjectRecord): void {
  cachePartSnapshot(observationRuntime(store).metadata, properties);
}

// Same canonical payload fingerprint as the server, for cross-process replay
// confirmation. Timing/usage magnitudes are facts, not update versions.
function serializeCompletionFact(value: unknown, seen = new Set<unknown>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((entry) => serializeCompletionFact(entry, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serializeCompletionFact((value as ObjectRecord)[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return result;
}
type CompatibleEventType =
  | "message.part.delta"
  | "message.part.updated"
  | "session.next.tool.input.delta"
  | "session.next.text.delta"
  | "session.next.reasoning.delta"
  | "message.updated"
  | "session.next.step.started"
  | "session.next.step.ended"
  | "session.idle"
  | "session.status"
  | "session.next.retried"
  | "session.next.step.failed"
  | "session.error"
  | "session.abort"
  | "session.aborted"
  | "session.cancel"
  | "session.cancelled"
  | "session.stop"
  | "session.stopped"
  | "session.completed"
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
  progress?: ContentProgress;
  model?: string;
  cost?: number;
  fallbackTokens: Partial<TokenCounts>;
  legacy: CandidateStream;
  v2: CandidateStream;
  selectedSource?: StreamName;
}

export type SessionRunStatus = "idle" | "busy" | "retry";

interface RuntimeContribution {
  record: HistoryRecord;
  tokens: TokenCounts;
  cost: number;
  quality: RecordQuality;
  runEpoch: number;
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
  completedContributions: Map<string, RuntimeContribution>;
  runSummaries: Map<number, SessionRunSummary>;
}

export type TaskSessionState = "busy" | "retry" | "idle" | "completed";

interface PendingTaskSession {
  state: TaskSessionState;
  timestamp: number;
}

interface TaskLifecycleEvent {
  state: TaskSessionState;
  timestamp: number;
}

interface RecordedLifecycleEvent {
  historyChanged: boolean;
  currentEpoch: boolean;
  currentChanged: boolean;
}

function lifecycleStateAt(
  events: readonly TaskLifecycleEvent[],
  timestamp: number,
): TaskSessionState | undefined {
  return events.filter((event) => event.timestamp <= timestamp).at(-1)?.state;
}

function mergeLifecycleEvents(
  left: readonly TaskLifecycleEvent[],
  right: readonly TaskLifecycleEvent[],
): TaskLifecycleEvent[] {
  const byTimestamp = new Map<number, TaskLifecycleEvent>();
  for (const event of [...left, ...right]) {
    const existing = byTimestamp.get(event.timestamp);
    if (!existing || (activeTaskSessionState(event.state) && !activeTaskSessionState(existing.state))) {
      byTimestamp.set(event.timestamp, { ...event });
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function sameLifecycleEvents(
  left: readonly TaskLifecycleEvent[],
  right: readonly TaskLifecycleEvent[],
): boolean {
  return left.length === right.length
    && left.every((event, index) => (
      event.timestamp === right[index]?.timestamp
      && event.state === right[index]?.state
    ));
}

function recordLifecycleFact(
  eventsBySession: Map<string, TaskLifecycleEvent[]>,
  sessionID: string,
  state: TaskSessionState,
  timestamp: number,
): boolean {
  const previous = eventsBySession.get(sessionID) ?? [];
  const next = mergeLifecycleEvents(previous, [{ state, timestamp }]);
  if (sameLifecycleEvents(previous, next)) return false;
  eventsBySession.set(sessionID, next);
  return true;
}

function cloneLifecycleEventMap(
  eventsBySession: ReadonlyMap<string, readonly TaskLifecycleEvent[]>,
): Map<string, TaskLifecycleEvent[]> {
  return new Map(
    [...eventsBySession.entries()].map(([sessionID, events]) => [
      sessionID,
      events.map((event) => ({ ...event })),
    ]),
  );
}

function mergeLifecycleEventMaps(
  left: ReadonlyMap<string, readonly TaskLifecycleEvent[]>,
  right: ReadonlyMap<string, readonly TaskLifecycleEvent[]>,
): Map<string, TaskLifecycleEvent[]> {
  const merged = cloneLifecycleEventMap(left);
  for (const [sessionID, events] of right) {
    merged.set(sessionID, mergeLifecycleEvents(merged.get(sessionID) ?? [], events));
  }
  return merged;
}

function completeLifecycleHistoryForRun(run: TaskWallRun): Map<string, TaskLifecycleEvent[]> {
  return mergeLifecycleEventMaps(
    mergeLifecycleEventMaps(
      mergeLifecycleEventMaps(run.lifecycleHistory, run.lifecycleEvents),
      run.pendingLifecycleEvents,
    ),
    run.lastRunLifecycleEvents,
  );
}

function lifecycleHistorySignature(run: TaskWallRun): string {
  return JSON.stringify(
    [...completeLifecycleHistoryForRun(run).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sessionID, events]) => [
        sessionID,
        events.map((event) => [event.timestamp, event.state]),
      ]),
  );
}

function closeLifecycleHistoryAt(
  eventsBySession: ReadonlyMap<string, readonly TaskLifecycleEvent[]>,
  completedAt: number | undefined,
): Map<string, TaskLifecycleEvent[]> {
  const closed = cloneLifecycleEventMap(eventsBySession);
  if (completedAt === undefined || !Number.isFinite(completedAt)) return closed;
  for (const [sessionID, events] of closed) {
    const latest = events
      .filter((event) => event.timestamp <= completedAt)
      .at(-1);
    if (latest && activeTaskSessionState(latest.state) && latest.timestamp < completedAt) {
      recordLifecycleFact(closed, sessionID, "completed", completedAt);
    }
  }
  return closed;
}

export interface TaskActivityInterval {
  start: number;
  end: number;
}

function cloneIntervals(intervals: readonly TaskActivityInterval[]): TaskActivityInterval[] {
  return intervals.map((interval) => ({ ...interval }));
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
  pendingLifecycleEvents: Map<string, TaskLifecycleEvent[]>;
  lifecycleEvents: Map<string, TaskLifecycleEvent[]>;
  /** Complete lifecycle facts retained across completed epochs for late events. */
  lifecycleHistory: Map<string, TaskLifecycleEvent[]>;
  carriedIntervals: TaskActivityInterval[];
  activeIntervals: TaskActivityInterval[];
  activeElapsed: number;
  lastRunWallTime?: TaskWallTimeSummary;
  lastRunIntervals: TaskActivityInterval[];
  lastRunLifecycleEvents: Map<string, TaskLifecycleEvent[]>;
  lastRunCarriedIntervals: TaskActivityInterval[];
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
  runsPath?: string;
  totalsPath?: string;
  maxRecords: number;
  bytesPerToken: number;
  enabled: boolean;
  keybinds?: BindingConfig;
}

export interface RuntimeStore {
  maxRecords: number;
  diskRecords: HistoryRecord[];
  records: HistoryRecord[];
  optimistic: Map<string, HistoryRecord>;
  optimisticQuality: Map<string, RecordQuality>;
  optimisticOrder: Map<string, number>;
  nextOptimisticOrder: number;
  active: Map<string, ActiveState>;
  completedMessageIDs: Set<string>;
  sessionRuntime: Map<string, SessionRuntime>;
  taskRuns: Map<string, TaskWallRun>;
  sessionParents: Map<string, string>;
  totalsLedger: TotalsLedger;
  lastCompletedBySession: Map<string, LastCompletedSnapshot>;
  focusSessionID?: string;
  pulseExpanded: boolean;
  historyGeneration: number;
  activityEvents: ActivityEvent[];
  activityReplay: ActivityReplay;
  activityGeneration: number;
  revision: () => number;
  bump: () => void;
  disposed: boolean;
  disposeSignals: () => void;
}

interface AggregateView {
  aggregate?: SessionAggregate;
  records: HistoryRecord[];
  totals?: TotalsRollup;
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
  estimated: boolean;
  basis: "generation" | "response";
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
  const input = asRecord(value);
  const source = asRecord(input?.tokens)
    ?? asRecord(input?.usage)
    ?? asRecord(input?.tokenUsage)
    ?? input;
  if (!source) return {};
  const normalized = normalizeTokenCounts(source);
  const fields: Partial<TokenCounts> = {};
  const inputDetails = asRecord(source.inputTokenDetails);
  const outputDetails = asRecord(source.outputTokenDetails);
  const rawInput = readNumber(source.inputTokens)
    ?? readNumber(source.promptTokens);
  const uncachedInput = readNumber(source.noCacheTokens)
    ?? readNumber(inputDetails?.noCacheTokens)
    ?? readNumber(inputDetails?.noCacheInputTokens);
  const rawOutput = readNumber(source.outputTokens)
    ?? readNumber(source.completionTokens);
  const textOutput = readNumber(outputDetails?.textTokens)
    ?? readNumber(outputDetails?.text)
    ?? readNumber(outputDetails?.outputTokens);
  const hasInput = readNumber(source.input) !== undefined
    || rawInput !== undefined
    || uncachedInput !== undefined
    || readNumber(source.cacheReadTokens) !== undefined
    || readNumber(source.cacheWriteTokens) !== undefined
    || readNumber(source.cache_read) !== undefined
    || readNumber(source.cache_write) !== undefined
    || readNumber(inputDetails?.cacheReadTokens) !== undefined
    || readNumber(inputDetails?.cacheWriteTokens) !== undefined
    || readNumber(inputDetails?.cacheRead) !== undefined
    || readNumber(inputDetails?.cacheWrite) !== undefined;
  const hasOutput = readNumber(source.output) !== undefined
    || rawOutput !== undefined
    || textOutput !== undefined
    || readNumber(source.reasoning) !== undefined
    || readNumber(outputDetails?.reasoningTokens) !== undefined
    || readNumber(outputDetails?.reasoning) !== undefined;
  const hasReasoning = readNumber(source.reasoning) !== undefined
    || readNumber(source.reasoningTokens) !== undefined
    || readNumber(outputDetails?.reasoningTokens) !== undefined
    || readNumber(outputDetails?.reasoning) !== undefined;
  if (hasInput) {
    fields.input = uncachedInput !== undefined
      ? Math.max(0, uncachedInput)
      : normalized.input;
  }
  if (hasOutput) {
    fields.output = textOutput !== undefined
      ? Math.max(0, textOutput)
      : rawOutput !== undefined && normalized.reasoning > 0
        ? Math.max(0, rawOutput - normalized.reasoning)
        : normalized.output;
  }
  if (hasReasoning) fields.reasoning = normalized.reasoning;
  const cache = asRecord(source.cache);
  if (
    readNumber(source.cacheRead) !== undefined
    || readNumber(source.cacheReadTokens) !== undefined
    || readNumber(source.cachedInputTokens) !== undefined
    || readNumber(source.cache_read) !== undefined
    || readNumber(inputDetails?.cacheReadTokens) !== undefined
    || readNumber(inputDetails?.cacheRead) !== undefined
    || readNumber(cache?.read) !== undefined
  ) {
    fields.cacheRead = normalized.cacheRead;
  }
  if (
    readNumber(source.cacheWrite) !== undefined
    || readNumber(source.cacheWriteTokens) !== undefined
    || readNumber(source.cache_write) !== undefined
    || readNumber(inputDetails?.cacheWriteTokens) !== undefined
    || readNumber(inputDetails?.cacheWrite) !== undefined
    || readNumber(cache?.write) !== undefined
  ) {
    fields.cacheWrite = normalized.cacheWrite;
  }
  return fields;
}

function mergeTokenFields(
  left: Partial<TokenCounts>,
  right: Partial<TokenCounts>,
): Partial<TokenCounts> {
  const merged = { ...left };
  for (const key of ["input", "output", "reasoning"] as const) {
    if (right[key] !== undefined) merged[key] = right[key];
  }
  for (const key of ["cacheRead", "cacheWrite"] as const) {
    if (right[key] !== undefined) {
      merged[key] = Math.max(merged[key] ?? 0, right[key]);
    }
  }
  return merged;
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
    completedContributions: new Map<string, RuntimeContribution>(),
    runSummaries: new Map<number, SessionRunSummary>(),
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
    pendingLifecycleEvents: new Map<string, TaskLifecycleEvent[]>(),
    lifecycleEvents: new Map<string, TaskLifecycleEvent[]>(),
    lifecycleHistory: new Map<string, TaskLifecycleEvent[]>(),
    carriedIntervals: [],
    activeIntervals: [],
    activeElapsed: 0,
    lastRunIntervals: [],
    lastRunLifecycleEvents: new Map<string, TaskLifecycleEvent[]>(),
    lastRunCarriedIntervals: [],
  };
}

function clearTaskRunParticipants(run: TaskWallRun): void {
  run.participantSessions.clear();
  run.activeSessions.clear();
  run.sessionStates.clear();
  run.lastActivityAt.clear();
}

function clearTaskRunCycle(run: TaskWallRun): void {
  run.lifecycleEvents.clear();
  run.pendingLifecycleEvents.clear();
  run.activeIntervals = [];
  run.activeElapsed = 0;
}

function mergeIntervals(
  left: readonly TaskActivityInterval[],
  right: readonly TaskActivityInterval[] = [],
): TaskActivityInterval[] {
  return [...left, ...right]
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce<TaskActivityInterval[]>((merged, interval) => {
      const previous = merged.at(-1);
      if (previous && interval.start <= previous.end) {
        previous.end = Math.max(previous.end, interval.end);
      } else {
        merged.push({ ...interval });
      }
      return merged;
    }, []);
}

function intervalElapsed(intervals: readonly TaskActivityInterval[]): number {
  return intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
}

function recordLifecycleEvent(
  run: TaskWallRun,
  sessionID: string,
  state: TaskSessionState,
  timestamp: number,
): RecordedLifecycleEvent {
  const currentEpoch = run.phase === "active"
    && lifecycleFactBelongsToCurrentEpoch(run, timestamp);
  const target = run.phase === "active"
    ? (currentEpoch ? run.lifecycleEvents : undefined)
    : run.pendingLifecycleEvents;
  const historyChanged = recordLifecycleFact(run.lifecycleHistory, sessionID, state, timestamp);
  const currentChanged = target !== undefined && currentEpoch
    ? recordLifecycleFact(target, sessionID, state, timestamp)
    : false;
  return { historyChanged, currentEpoch, currentChanged };
}

function lifecycleFactBelongsToCurrentEpoch(run: TaskWallRun, timestamp: number): boolean {
  if (run.phase !== "active") return false;
  // Once a task has completed, that completion timestamp is the exclusive
  // lower boundary for the next active epoch. Facts before it are historical
  // corrections and must not mutate current participant state.
  const previousCompletion = run.lastRunWallTime?.completedAt;
  return previousCompletion === undefined || timestamp >= previousCompletion;
}

function rebuildActiveIntervals(run: TaskWallRun, through?: number): void {
  const completeHistory = completeLifecycleHistoryForRun(run);
  const hasLifecycleFacts = [...completeHistory.values()].some((events) => events.length > 0);
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

function lifecycleIntervals(
  lifecycleEvents: ReadonlyMap<string, readonly TaskLifecycleEvent[]>,
  through?: number,
): TaskActivityInterval[] {
  const boundedLifecycleEvents = through === undefined || !Number.isFinite(through)
    ? lifecycleEvents
    : new Map(
      [...lifecycleEvents.entries()].map(([sessionID, events]) => [
        sessionID,
        events.filter((event) => event.timestamp <= through),
      ]),
    );
  const points = [...boundedLifecycleEvents.values()]
    .flatMap((events) => events.map((event) => event.timestamp))
    .sort((left, right) => left - right);
  if (through !== undefined && Number.isFinite(through)) points.push(through);
  points.sort((left, right) => left - right);
  const uniquePoints = [...new Set(points)];
  const computedIntervals: TaskActivityInterval[] = [];
  for (let index = 0; index < uniquePoints.length; index += 1) {
    const start = uniquePoints[index];
    const end = uniquePoints[index + 1];
    if (end === undefined || end <= start) continue;
    const active = [...boundedLifecycleEvents.values()].some((events) => (
      activeTaskSessionState(lifecycleStateAt(events, start))
    ));
    if (!active) continue;
    const previous = computedIntervals.at(-1);
    if (previous?.end === start) previous.end = end;
    else computedIntervals.push({ start, end });
  }
  return computedIntervals;
}

function earliestActiveTimestamp(run: TaskWallRun): number | undefined {
  const timestamps = [...run.lifecycleEvents.values()]
    .flatMap((events) => events)
    .filter((event) => activeTaskSessionState(event.state))
    .map((event) => event.timestamp);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function activeTaskSessionState(state: TaskSessionState | undefined): boolean {
  return state === "busy" || state === "retry";
}

function startTaskWallRun(
  run: TaskWallRun,
  timestamp: number,
  explicitRootStart: boolean,
): void {
  const pendingLifecycle = new Map<string, TaskLifecycleEvent[]>();
  for (const [sessionID, events] of run.pendingLifecycleEvents) {
    pendingLifecycle.set(sessionID, events.map((event) => ({ ...event })));
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
      run.lifecycleEvents.set(sessionID, [{ ...pending }]);
    }
  });
  for (const [sessionID, events] of pendingLifecycle) {
    const latest = events.at(-1);
    if (!latest) continue;
    run.participantSessions.add(sessionID);
    run.sessionStates.set(sessionID, latest.state);
    run.lastActivityAt.set(sessionID, Math.max(...events.map((event) => event.timestamp)));
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
  const carriedStart = run.carriedIntervals.length > 0
    ? Math.min(...run.carriedIntervals.map((interval) => interval.start))
    : undefined;
  const currentStart = earliestActiveTimestamp(run);
  run.runStartedAt = Math.min(
    carriedStart ?? timestamp,
    currentStart ?? timestamp,
  );
  rebuildActiveIntervals(run);
}

function recordTaskSessionActivity(
  run: TaskWallRun,
  sessionID: string,
  state: TaskSessionState,
  timestamp: number,
): boolean {
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
  run.lastActivityAt.set(
    sessionID,
    previous === undefined ? latest.timestamp : Math.max(previous, latest.timestamp),
  );
  const currentState = run.sessionStates.get(sessionID);
  if (activeTaskSessionState(currentState)) run.activeSessions.add(sessionID);
  else run.activeSessions.delete(sessionID);
  if (sessionID === run.rootSessionID) {
    run.rootObserved = true;
    run.rootBusy = activeTaskSessionState(currentState);
  }
  rebuildActiveIntervals(run);
  return true;
}

function finishTaskWallRun(
  run: TaskWallRun,
  timestamp: number,
): TaskWallTimeSummary | undefined {
  if (run.phase !== "active" || run.activeSessions.size > 0) return undefined;
  const activityEnd = Math.max(timestamp, ...run.lastActivityAt.values());
  const completeHistory = completeLifecycleHistoryForRun(run);
  run.lifecycleHistory = completeHistory;
  const completedIntervals = lifecycleIntervals(completeHistory, activityEnd);
  const completedActiveElapsed = intervalElapsed(completedIntervals);
  const cumulativeStart = completedIntervals.length > 0
    ? Math.min(...completedIntervals.map((interval) => interval.start))
    : run.runStartedAt ?? timestamp;
  const summary: TaskWallTimeSummary = {
    runEpoch: run.runEpoch,
    startedAt: cumulativeStart,
    completedAt: activityEnd,
    wallTime: Math.max(0, completedActiveElapsed),
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

function patchCompletedTaskWallRun(
  run: TaskWallRun,
  sessionID: string,
  state: TaskSessionState,
  timestamp: number,
): boolean {
  if (!run.lastRunWallTime || timestamp >= run.lastRunWallTime.completedAt) return false;
  if (!recordLifecycleFact(run.lifecycleHistory, sessionID, state, timestamp)) return false;
  const completeHistory = completeLifecycleHistoryForRun(run);
  run.lifecycleHistory = completeHistory;
  const correctedIntervals = lifecycleIntervals(
    completeHistory,
    run.lastRunWallTime.completedAt,
  );
  run.lastRunIntervals = mergeIntervals(correctedIntervals);
  run.lastRunWallTime = {
    ...run.lastRunWallTime,
    startedAt: Math.min(
      run.lastRunWallTime.startedAt,
      ...run.lastRunIntervals.map((interval) => interval.start),
    ),
    wallTime: intervalElapsed(run.lastRunIntervals),
  };
  // A late event corrects the finished epoch. Keep the cumulative carry and
  // all persisted-in-memory summaries on the same corrected interval union
  // so a subsequent epoch cannot resurrect stale time.
  run.carriedIntervals = cloneIntervals(run.lastRunIntervals);
  run.lastRunCarriedIntervals = cloneIntervals(run.lastRunIntervals);
  run.lastRunLifecycleEvents = cloneLifecycleEventMap(completeHistory);
  return true;
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
    if (run.lastRunWallTime && timestamp < run.lastRunWallTime.completedAt) {
      patchCompletedTaskWallRun(run, sessionID, state, timestamp);
      return undefined;
    }
    if (activeTaskSessionState(state)) {
      startTaskWallRun(run, timestamp, startsRootRun);
    } else {
      recordLifecycleEvent(run, sessionID, state, timestamp);
      run.pendingSessions.set(sessionID, { state, timestamp });
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

export function noteTaskRunRecord(
  run: TaskWallRun,
  sessionID: string,
  startedAt: number | undefined,
  completedAt: number | undefined,
): TaskWallTimeSummary | undefined {
  // A message completion only finalizes message/token accounting. The task
  // run remains active until the participant emits its lifecycle idle or
  // terminal state.
  void run;
  void sessionID;
  void startedAt;
  void completedAt;
  return undefined;
}

function startSessionRun(
  runtime: SessionRuntime,
  timestamp: number,
  status: Exclude<SessionRunStatus, "idle"> = "busy",
): void {
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
    startSessionRun(runtime, timestamp, status);
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
  quality?: RecordQuality;
}): HistoryRecord {
  const start = infoTimeValue(input.info, ["start", "created"])
    ?? input.state?.startedAt
    ?? input.completedAt;
  const completed = infoTimeValue(input.info, ["end", "completed"])
    ?? input.completedAt;
  const firstToken = earliestFirstOutput(start, completed, infoTimeValue(input.info, ["firstToken", "firstTokenAt"]), input.state?.firstTokenAt);
  const ttft = firstToken === undefined ? undefined : Math.max(0, firstToken - start);
  const duration = Math.max(0, completed - start);
  const record: HistoryRecord = {
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
    quality: input.quality ?? "exact",
  };
  recordQualityByObject.set(record, input.quality ?? "exact");
  record.speed = measureRecordSpeed(record, contentSpeedObservations(record, input.state?.progress, input.state?.firstTokenAt,
    input.quality === "exact", infoTimeValue(input.info, ["start", "created"]) !== undefined && infoTimeValue(input.info, ["end", "completed"]) !== undefined,
    tokenFields(input.info?.tokens).reasoning !== undefined));
  return record;
}

export function makeTokens(
  info: ObjectRecord | undefined,
  state: ActiveState | undefined,
  bytesPerToken: number,
): TokenCounts {
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
    cacheWrite,
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

function recordCompleteness(record: HistoryRecord): number {
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

function recordFreshness(record: HistoryRecord): number {
  return Math.max(
    record.time.start,
    record.time.firstToken ?? Number.NEGATIVE_INFINITY,
    record.time.completed ?? Number.NEGATIVE_INFINITY,
  );
}

function preferredHistoryRecord(
  candidate: HistoryRecord,
  existing: HistoryRecord,
  candidateQuality: RecordQuality,
  existingQuality: RecordQuality,
): HistoryRecord {
  const authoritative = preferredUpdateLayer(
    { record: candidate, quality: candidateQuality, source: "incoming", order: 1 },
    { record: existing, quality: existingQuality, source: "optimistic", order: 0 },
  );
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

export function applyRecordToSessionRuntime(
  runtime: SessionRuntime,
  record: HistoryRecord,
  quality: RecordQuality = "exact",
): boolean {
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
      quality,
    });
    const summary = runtime.runSummaries.get(historical.runEpoch);
    if (summary) {
      const tokens = replaceTokenContribution(summary.tokens, previous.tokens, record.tokens);
      runtime.runSummaries.set(historical.runEpoch, {
        ...summary,
        tokens,
        cost: Math.max(0, summary.cost - previous.cost + record.cost),
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
      const correctedSummary: SessionRunSummary = {
        ...previousSummary,
        tokens: replaceTokenContribution(previousSummary.tokens, previous.tokens, record.tokens),
        cost: Math.max(0, previousSummary.cost - previous.cost + record.cost),
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
    runEpoch: runtime.runEpoch,
  });
  runtime.runStartedAt = runtime.runStartedAt === undefined
    ? record.time.start
    : Math.min(runtime.runStartedAt, record.time.start);
  if (record.time.firstToken !== undefined) {
    runtime.runFirstTokenAt = runtime.runFirstTokenAt === undefined
      ? record.time.firstToken
      : Math.min(runtime.runFirstTokenAt, record.time.firstToken);
  }
  if (runtime.status === "idle" && runtime.lastRunSummary?.runEpoch === runtime.runEpoch) {
    runtime.lastRunSummary = {
      ...runtime.lastRunSummary,
      tokens: { ...runtime.runTotals },
      cost: runtime.runCost,
      responseCount: runtime.runResponseCount,
      ...(runtime.runStartedAt !== undefined ? { startedAt: runtime.runStartedAt } : {}),
      ...(runtime.runFirstTokenAt !== undefined ? { firstTokenAt: runtime.runFirstTokenAt } : {}),
    };
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
  const quality: RecordQuality = record.quality ?? (markCompleted ? "exact" : "provisional");
  if (!markCompleted && store.completedMessageIDs.has(record.messageID)) return;
  if (
    markCompleted
    && store.completedMessageIDs.has(record.messageID)
    && store.records.some((entry) => entry.messageID === record.messageID && historyRecordsEquivalent(entry, record))
  ) return;
  const selected = selectCommitRecord(store, record, quality);
  const effectiveRecord = selected.record;
  const effectiveQuality = selected.quality ?? "exact";
  const existingRuntime = getSessionRuntime(store, record.sessionID);
  const existingContribution = existingRuntime.contributions.get(record.messageID)
    ?? existingRuntime.completedContributions.get(record.messageID);
  const runtime = existingContribution
    ? existingRuntime
    : ensureSessionRun(store, record.sessionID, record.time.start);
  const historicalEpoch = existingRuntime.completedContributions.get(record.messageID)?.runEpoch;
  if (runtime.contributions.get(record.messageID)?.quality === "exact" && effectiveQuality === "provisional") return;
  const applied = applyRecordToSessionRuntime(runtime, effectiveRecord, effectiveQuality);
  if (
    !applied
    && runtime.contributions.get(record.messageID)?.record !== effectiveRecord
    && runtime.completedContributions.get(record.messageID)?.record !== effectiveRecord
  ) return;
  runtime.status = markCompleted || effectiveQuality === "exact" ? runtime.status : "busy";
  if (runtime.activeMessageID === record.messageID) runtime.activeMessageID = undefined;
  if (markCompleted || effectiveQuality === "exact") store.completedMessageIDs.add(record.messageID);
  if (selected.source === "incoming") addOptimisticRecord(store, effectiveRecord, effectiveQuality);
  const contributionEpoch = runtime.completedContributions.get(record.messageID)?.runEpoch
    ?? runtime.contributions.get(record.messageID)?.runEpoch
    ?? historicalEpoch
    ?? runtime.runEpoch;
  const snapshot = makeLastCompletedSnapshot(
    effectiveRecord,
    contributionEpoch,
    effectiveQuality === "provisional",
  );
  const previousSnapshot = store.lastCompletedBySession.get(effectiveRecord.sessionID);
  if (
    previousSnapshot === undefined
    || previousSnapshot.record.messageID === effectiveRecord.messageID
    || contributionEpoch > previousSnapshot.runEpoch
    || (
      contributionEpoch === previousSnapshot.runEpoch
      && recordCompletedAt(effectiveRecord) >= recordCompletedAt(previousSnapshot.record)
    )
  ) {
    store.lastCompletedBySession.set(effectiveRecord.sessionID, snapshot);
  }
}

function parentSessionID(
  api: TuiPluginApi,
  sessionID: string,
  info?: ObjectRecord,
  store?: RuntimeStore,
): string | undefined {
  const explicit = readStringFrom([info], ["parentSessionID", "parentSessionId"]);
  if (explicit) return explicit;
  let stateParent: string | undefined;
  try {
    const session = api.state.session.get(sessionID);
    if (session?.parentID) stateParent = session.parentID;
  } catch {
    // State can still be syncing while a response completes.
  }
  return stateParent
    ?? store?.sessionParents.get(sessionID);
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

function rewriteRecordParent(
  record: HistoryRecord,
  parentSessionID: string | undefined,
): HistoryRecord {
  if (parentSessionID === undefined || record.parentSessionID === parentSessionID) return record;
  const next: HistoryRecord = { ...record, parentSessionID };
  const quality = recordQualityByObject.get(record);
  if (quality !== undefined) recordQualityByObject.set(next, quality);
  return next;
}

function repairKnownParents(store: RuntimeStore): boolean {
  let changed = false;
  const repair = (record: HistoryRecord): HistoryRecord => {
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
      store.records = mergeHistoryLayers(
        baseHistoryRecords(store),
        store.optimistic,
        store.maxRecords,
        store.optimisticQuality,
        store.optimisticOrder,
      );
    } else {
      store.records = repairedRecords;
    }
    for (const [sessionID, snapshot] of store.lastCompletedBySession) {
      const repaired = repair(snapshot.record);
      if (repaired !== snapshot.record) {
        store.lastCompletedBySession.set(
          sessionID,
          { ...snapshot, record: repaired },
        );
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

function mergeTaskWallRun(
  target: TaskWallRun,
  source: TaskWallRun,
  rootSessionID: string,
): void {
  const targetWasActive = target.phase === "active";
  const sourceWasActive = source.phase === "active";
  const targetHistory = completeLifecycleHistoryForRun(target);
  const sourceHistory = sourceWasActive
    ? completeLifecycleHistoryForRun(source)
    : closeLifecycleHistoryAt(
      completeLifecycleHistoryForRun(source),
      source.lastRunWallTime?.completedAt,
    );
  const sourceIntervals = sourceWasActive
    ? source.activeIntervals
    : mergeIntervals(source.lastRunIntervals, source.carriedIntervals);
  const carriedSourceIntervals = mergeIntervals(source.lastRunIntervals, source.carriedIntervals);
  const sourceLifecycleEvents = sourceWasActive
    ? source.lifecycleEvents
    : new Map<string, TaskLifecycleEvent[]>();
  const activeCandidates = new Set([
    ...target.activeSessions,
    ...source.activeSessions,
  ]);
  target.rootSessionID = rootSessionID;
  target.lifecycleHistory = mergeLifecycleEventMaps(targetHistory, sourceHistory);
  const historicalIntervals = lifecycleIntervals(target.lifecycleHistory);
  target.carriedIntervals = cloneIntervals(historicalIntervals);
  target.lastRunIntervals = cloneIntervals(historicalIntervals);
  target.lastRunCarriedIntervals = cloneIntervals(historicalIntervals);
  target.lastRunLifecycleEvents = cloneLifecycleEventMap(target.lifecycleHistory);
  target.phase = target.phase === "active" || source.phase === "active"
    ? "active"
    : "idle";
  target.runEpoch = Math.max(target.runEpoch, source.runEpoch);
  target.rootBusy = target.rootBusy || source.rootBusy;
  target.rootObserved = target.rootObserved || source.rootObserved;
  target.hasExplicitRootStart = target.hasExplicitRootStart || source.hasExplicitRootStart;
  const lifecycleCandidates = new Map<string, TaskLifecycleEvent[]>();
  for (const [sessionID, events] of target.lifecycleEvents) {
    lifecycleCandidates.set(sessionID, mergeLifecycleEvents(events, []));
  }
  for (const [sessionID, events] of sourceLifecycleEvents) {
    lifecycleCandidates.set(
      sessionID,
      mergeLifecycleEvents(lifecycleCandidates.get(sessionID) ?? [], events),
    );
  }
  target.lifecycleEvents = lifecycleCandidates;
  const pendingLifecycle = new Map<string, TaskLifecycleEvent[]>();
  for (const [sessionID, events] of target.pendingLifecycleEvents) {
    pendingLifecycle.set(sessionID, events.map((event) => ({ ...event })));
  }
  for (const [sessionID, events] of source.pendingLifecycleEvents) {
    pendingLifecycle.set(
      sessionID,
      mergeLifecycleEvents(pendingLifecycle.get(sessionID) ?? [], events),
    );
  }
  target.pendingLifecycleEvents = pendingLifecycle;
  if (targetWasActive) {
    target.activeIntervals = mergeIntervals(target.activeIntervals, sourceIntervals);
    target.activeElapsed = intervalElapsed(target.activeIntervals);
  }
  const mergedParticipants = new Set([
    ...target.participantSessions,
    ...source.participantSessions,
  ]);
  target.participantSessions = mergedParticipants;
  if (source.runStartedAt !== undefined) {
    target.runStartedAt = target.runStartedAt === undefined
      ? source.runStartedAt
      : Math.min(target.runStartedAt, source.runStartedAt);
  }
  if (carriedSourceIntervals.length > 0) {
    const sourceStart = Math.min(...carriedSourceIntervals.map((interval) => interval.start));
    target.runStartedAt = target.runStartedAt === undefined
      ? sourceStart
      : Math.min(target.runStartedAt, sourceStart);
  }
  const sourceEarliestActive = earliestActiveTimestamp(source);
  if (sourceEarliestActive !== undefined) {
    target.runStartedAt = target.runStartedAt === undefined
      ? sourceEarliestActive
      : Math.min(target.runStartedAt, sourceEarliestActive);
  }

  for (const sessionID of source.participantSessions) target.participantSessions.add(sessionID);
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
  for (const [sessionID, events] of target.lifecycleEvents) {
    const latest = events.at(-1);
    if (!latest) continue;
    target.participantSessions.add(sessionID);
    target.sessionStates.set(sessionID, latest.state);
    target.lastActivityAt.set(
      sessionID,
      Math.max(target.lastActivityAt.get(sessionID) ?? Number.NEGATIVE_INFINITY, latest.timestamp),
    );
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
  if (target.lastRunWallTime) {
    const completedAt = Math.max(
      target.lastRunWallTime.completedAt,
      source.lastRunWallTime?.completedAt ?? target.lastRunWallTime.completedAt,
    );
    const completedIntervals = lifecycleIntervals(target.lifecycleHistory, completedAt);
    target.lastRunIntervals = cloneIntervals(completedIntervals);
    target.lastRunCarriedIntervals = cloneIntervals(completedIntervals);
    target.lastRunWallTime = {
      ...target.lastRunWallTime,
      completedAt,
      startedAt: Math.min(
        target.lastRunWallTime.startedAt,
        ...completedIntervals.map((interval) => interval.start),
      ),
      wallTime: intervalElapsed(completedIntervals),
    };
  }
  if (target.phase === "active") rebuildActiveIntervals(target);
  else {
    target.lastRunLifecycleEvents = cloneLifecycleEventMap(target.lifecycleHistory);
    target.lastRunCarriedIntervals = cloneIntervals(target.carriedIntervals);
    target.lastRunIntervals = cloneIntervals(target.carriedIntervals);
    if (target.lastRunWallTime) {
      target.lastRunWallTime = {
        ...target.lastRunWallTime,
        wallTime: intervalElapsed(target.lastRunIntervals),
        completedAt: Math.max(
          target.lastRunWallTime.completedAt,
          source.lastRunWallTime?.completedAt ?? target.lastRunWallTime.completedAt,
        ),
        startedAt: Math.min(
          target.lastRunWallTime.startedAt,
          ...target.lastRunIntervals.map((interval) => interval.start),
        ),
      };
    }
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
  const repaired = repairKnownParents(store);
  const rootSessionID = knownRootSessionID(store, sessionID);
  const migrated = migrateTaskWallRuns(store, rootSessionID);
  return previous !== parentID || repaired || migrated;
}

function sessionParentFromEvent(
  type: string,
  properties: ObjectRecord,
  event: CompatibleEvent,
): string | undefined {
  const normalizedType = type.toLowerCase();
  const sources = [
    properties,
    event,
    asRecord(properties.info),
    asRecord(properties.message),
    asRecord(properties.session),
    asRecord(properties.event),
    asRecord(event.info),
    asRecord(event.session),
    asRecord(event.event),
  ];
  const explicit = readStringFrom(sources, ["parentSessionID", "parentSessionId"]);
  if (explicit) return explicit;
  if (!normalizedType.startsWith("session.")) return undefined;
  const sessionEntitySources = [
    asRecord(properties.session),
    asRecord(event.session),
    asRecord(properties.event)?.session,
    asRecord(event.event)?.session,
    asRecord(properties.info)?.session,
    asRecord(event.info)?.session,
  ].filter((value): value is ObjectRecord => isRecord(value));
  const isSessionEntityEvent = normalizedType === "session.created" || normalizedType === "session.updated";
  if (isSessionEntityEvent) {
    for (const source of [
      properties,
      event,
      asRecord(properties.info),
      asRecord(event.info),
      asRecord(properties.event),
      asRecord(event.event),
    ]) {
      if (source) sessionEntitySources.push(source);
    }
  }
  return readStringFrom(sessionEntitySources, ["parentID", "parent.id"]);
}

export function cacheSessionParentFromEvent(store: RuntimeStore, input: unknown): boolean {
  const event = normalizeEvent(input);
  if (!event) return false;
  const type = eventType(event);
  if (type !== "session.created" && type !== "session.updated") return false;
  const properties = eventProperties(event);
  const sessionID = readSessionID(properties, event);
  const parentID = sessionParentFromEvent(type, properties, event);
  if (!sessionID || !parentID) return false;
  return rememberSessionParent(store, sessionID, parentID);
}

function rootSessionIDFor(
  store: RuntimeStore,
  api: TuiPluginApi,
  sessionID: string,
  info?: ObjectRecord,
): string {
  const parent = parentSessionID(api, sessionID, info, store);
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

function taskWallRunsForActivityRoot(
  store: RuntimeStore,
  rootSessionID: string,
): TaskWallRun[] {
  const runs: TaskWallRun[] = [];
  for (const [key, run] of store.taskRuns) {
    const sessionIDs = new Set([
      key,
      run.rootSessionID,
      ...run.participantSessions,
      ...run.activeSessions,
      ...run.sessionStates.keys(),
      ...run.pendingSessions.keys(),
    ]);
    if ([...sessionIDs].some((sessionID) => activityRootSessionID(store, sessionID) === rootSessionID)) {
      runs.push(run);
    }
  }
  return runs;
}

function findTaskWallRun(
  store: RuntimeStore,
  rootSessionID: string,
  sessionID: string,
): TaskWallRun | undefined {
  const direct = store.taskRuns.get(rootSessionID);
  if (direct) return direct;
  return taskWallRunsForActivityRoot(store, rootSessionID)
    .find((run) => run.rootSessionID === sessionID || run.participantSessions.has(sessionID));
}

export function taskWallTimeForSession(
  store: RuntimeStore,
  sessionID: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!sessionID) return undefined;
  const rootSessionID = activityRootSessionID(store, sessionID);
  migrateTaskWallRuns(store, rootSessionID);
  const runs = taskWallRunsForActivityRoot(store, rootSessionID);
  const liveIntervals: TaskActivityInterval[] = [];
  let hasCompletedLiveActivity = false;
  for (const run of runs) {
    if (run.phase === "active") {
      rebuildActiveIntervals(run, now);
      liveIntervals.push(...run.activeIntervals);
      hasCompletedLiveActivity = run.lifecycleEvents.size > 0 || run.carriedIntervals.length > 0;
    } else {
      liveIntervals.push(...run.lastRunIntervals, ...run.carriedIntervals);
      hasCompletedLiveActivity = run.lastRunWallTime !== undefined
        || run.lastRunLifecycleEvents.size > 0
        || run.lastRunIntervals.length > 0
        || run.carriedIntervals.length > 0;
    }
  }
  const persistedIntervals = persistedActivityIntervalsForRoot(
    store.activityReplay,
    rootSessionID,
    store.sessionParents,
  );
  const intervals = mergeTaskActivityIntervals(
    store.activityReplay,
    sessionID,
    liveIntervals,
    store.sessionParents,
  );
  if (intervals.length > 0) return intervalElapsed(intervals);

  const hasCompletedPersistedActivity = persistedCompletedActivityForRoot(
    store.activityReplay,
    rootSessionID,
    store.sessionParents,
  );
  if (hasCompletedPersistedActivity || hasCompletedLiveActivity || persistedIntervals.length > 0) return 0;
  return undefined;
}

export function hasLiveTaskWallActivity(
  store: Pick<RuntimeStore, "active" | "taskRuns">,
): boolean {
  if (store.active.size > 0) return true;
  for (const run of store.taskRuns.values()) {
    if (run.phase === "active") return true;
  }
  return false;
}

export function mergeTaskActivityIntervals(
  replay: ActivityReplay | undefined,
  sessionID: string,
  liveIntervals: readonly TaskActivityInterval[] = [],
  sessionParents?: ReadonlyMap<string, string>,
): TaskActivityInterval[] {
  if (!replay) return mergeIntervals([], liveIntervals);
  const rootSessionID = activityRootSessionIDFromReplay(replay, sessionID, sessionParents);
  const persisted = persistedActivityIntervalsForRoot(replay, rootSessionID, sessionParents);
  return mergeIntervals(persisted, liveIntervals);
}

function activityParentMap(
  replay: ActivityReplay,
  sessionParents?: ReadonlyMap<string, string>,
): Map<string, string> {
  const parents = new Map<string, string>();
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

function activityRootSessionIDFromReplay(
  replay: ActivityReplay,
  sessionID: string,
  sessionParents?: ReadonlyMap<string, string>,
): string {
  return resolveRootSessionID(sessionID, activityParentMap(replay, sessionParents));
}

function activityRootSessionID(store: RuntimeStore, sessionID: string): string {
  return activityRootSessionIDFromReplay(store.activityReplay, sessionID, store.sessionParents);
}

function activityParticipantIDs(replay: ActivityReplay): Set<string> {
  const sessionIDs = new Set<string>();
  for (const participant of replay.participants) sessionIDs.add(participant.sessionID);
  for (const [sessionID, parentSessionID] of replay.parentBySessionID) {
    sessionIDs.add(sessionID);
    if (parentSessionID) sessionIDs.add(parentSessionID);
  }
  return sessionIDs;
}

function persistedActivityIntervalsForRoot(
  replay: ActivityReplay,
  rootSessionID: string,
  sessionParents?: ReadonlyMap<string, string>,
): TaskActivityInterval[] {
  const intervals: TaskActivityInterval[] = [];
  for (const sessionID of activityParticipantIDs(replay)) {
    if (activityRootSessionIDFromReplay(replay, sessionID, sessionParents) !== rootSessionID) continue;
    const timeline = replay.timelines.get(sessionID);
    if (timeline) intervals.push(...timeline.activeIntervals);
  }
  return mergeIntervals(intervals, []);
}

function persistedCompletedActivityForRoot(
  replay: ActivityReplay,
  rootSessionID: string,
  sessionParents?: ReadonlyMap<string, string>,
): boolean {
  for (const sessionID of activityParticipantIDs(replay)) {
    if (activityRootSessionIDFromReplay(replay, sessionID, sessionParents) !== rootSessionID) continue;
    const timeline = replay.timelines.get(sessionID);
    if (timeline && timeline.events.length > 0 && !timeline.open) return true;
  }
  return false;
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

export function recordDelta(
  store: RuntimeStore,
  properties: ObjectRecord,
  event: CompatibleEvent,
  stream: StreamName,
  _explicitKind: SampleKind | undefined,
  bytesPerToken: number,
): void {
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const parentID = sessionParentFromEvent("message.part.delta", properties, event);
  if (parentID) rememberSessionParent(store, sessionID, parentID);
  const messageID = readMessageID(properties);
  if (messageID && (knownCompletedMessage(store, messageID) || knownNonAssistant(store, messageID))) return;
  const delta = readDelta(properties, event);
  if (!delta) return;
  const timestamp = eventTimestamp(event, properties);
  const existingState = (messageID ? store.active.get(messageID) : undefined)
    ?? store.active.get(pendingKey(sessionID));
  const progress = existingState?.progress ?? cachedContentProgress(observationRuntime(store).metadata, messageID ?? pendingKey(sessionID));
  const parsed = parseModelDelta(progress, properties, event, stream, delta);
  if (!parsed) return;
  const runtime = ensureSessionRun(store, sessionID, timestamp);
  const state = existingState ?? getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.progress = progress;
  observationRuntime(store).metadata.progress.set(messageID ?? pendingKey(sessionID), progress);
  state.firstTokenAt = Math.min(state.firstTokenAt ?? timestamp, timestamp);
  runtime.runFirstTokenAt = Math.min(runtime.runFirstTokenAt ?? timestamp, timestamp);
  const bytes = utf8ByteLength(delta);
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  const sample: SpeedSample = {
    timestamp,
    tokens: estimatedTokens,
    estimatedTokens,
    bytes,
    kind: parsed.kind,
  };
  if (existingState?.selectedSource !== undefined && existingState.selectedSource !== stream) {
    existingState[stream].hasData = true;
    existingState[stream].samples.push(sample);
    existingState[stream].samples.sort((left, right) => left.timestamp - right.timestamp);
    if (messageID) runtime.activeMessageID = messageID;
    store.bump();
    return;
  }
  if (state.sessionID !== sessionID) return;
  state.selectedSource = lockStreamSource(state.selectedSource, stream);
  state.startedAt = Math.min(state.startedAt, timestamp);
  state.firstTokenAt = Math.min(state.firstTokenAt ?? timestamp, timestamp);
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

export function recordStepStarted(
  store: RuntimeStore,
  properties: ObjectRecord,
  event: CompatibleEvent,
): void {
  const sessionID = readSessionID(properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  if (messageID && (knownCompletedMessage(store, messageID) || knownNonAssistant(store, messageID))) return;
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
  if (messageID && (knownCompletedMessage(store, messageID) || knownNonAssistant(store, messageID))) return;
  const timestamp = eventTimestamp(event, properties);
  const runtime = ensureSessionRun(store, sessionID, timestamp);
  const state = getOrCreateActiveState(store.active, messageID, sessionID, timestamp);
  state.fallbackTokens = mergeTokenFields(
    state.fallbackTokens,
    tokenFields(properties.tokens ?? properties),
  );
  state.progress ??= cachedContentProgress(observationRuntime(store).metadata, messageID ?? pendingKey(sessionID));
  state.progress.stepEnds ??= new Set();
  state.progress.stepEnds.add(timestamp);
  state.model = state.model ?? modelName(properties);
  state.cost = state.cost ?? readNumber(properties.cost);
  if (messageID) runtime.activeMessageID = messageID;
  store.active.set(messageID ?? pendingKey(sessionID), state);
  store.bump();
}

interface HistoryLayerCandidate {
  record: HistoryRecord;
  quality?: RecordQuality;
  source: "disk" | "optimistic" | "incoming";
  order: number;
}

function preferredUpdateLayer(candidate: HistoryLayerCandidate, existing: HistoryLayerCandidate): HistoryLayerCandidate | undefined {
  const next = coerceCompletionUpdate((candidate.record as MeasuredHistoryRecord).update);
  const previous = coerceCompletionUpdate((existing.record as MeasuredHistoryRecord).update);
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

function baseHistoryRecords(store: RuntimeStore): HistoryRecord[] {
  if (store.diskRecords.length > 0 || store.records.length === 0) return store.diskRecords;
  const optimisticIDs = new Set(store.optimistic.keys());
  return store.records.filter((record) => !optimisticIDs.has(record.messageID));
}

function preferredHistoryLayer(
  candidate: HistoryLayerCandidate,
  existing: HistoryLayerCandidate,
): HistoryLayerCandidate {
  const authoritative = preferredUpdateLayer(candidate, existing);
  if (authoritative) return authoritative;
  const candidateQuality = candidate.quality ?? "exact";
  const existingQuality = existing.quality ?? "exact";
  const candidateCompleteness = recordCompleteness(candidate.record);
  const existingCompleteness = recordCompleteness(existing.record);
  if (
    candidateQuality !== existingQuality
  ) {
    if (
      candidate.source !== "disk"
      && candidateQuality === "exact"
      && existing.source === "disk"
      && existingQuality === "provisional"
    ) return candidate;
    if (
      existing.source !== "disk"
      && existingQuality === "exact"
      && candidate.source === "disk"
      && candidateQuality === "provisional"
    ) return existing;
    if (
      candidate.source === "disk"
      && candidateQuality === "exact"
      && candidateCompleteness > existingCompleteness
    ) return candidate;
    if (
      existing.source === "disk"
      && existingQuality === "exact"
      && existingCompleteness > candidateCompleteness
    ) return existing;
    if (candidateQuality === "exact" && existingQuality === "provisional") {
      return candidate;
    }
    if (candidateQuality === "provisional" && existingQuality === "exact") {
      return existing;
    }
    return candidateQuality === "exact" ? candidate : existing;
  }
  if (
    candidate.source !== "disk"
    && existing.source === "disk"
    && candidateCompleteness !== existingCompleteness
  ) {
    return candidateCompleteness > existingCompleteness ? candidate : existing;
  }
  if (
    existing.source !== "disk"
    && candidate.source === "disk"
    && candidateCompleteness !== existingCompleteness
  ) {
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

function addOptimisticRecord(
  store: RuntimeStore,
  record: HistoryRecord,
  quality: RecordQuality,
): boolean {
  recordQualityByObject.set(record, quality);
  store.optimistic.set(record.messageID, record);
  store.optimisticQuality.set(record.messageID, quality);
  store.optimisticOrder.set(record.messageID, store.nextOptimisticOrder);
  store.nextOptimisticOrder += 1;
  store.records = mergeHistoryLayers(
    baseHistoryRecords(store),
    store.optimistic,
    store.maxRecords,
    store.optimisticQuality,
    store.optimisticOrder,
  );
  store.bump();
  return true;
}

function selectCommitRecord(
  store: RuntimeStore,
  record: HistoryRecord,
  quality: RecordQuality,
): HistoryLayerCandidate {
  const candidates: HistoryLayerCandidate[] = [{
    record,
    quality,
    source: "incoming",
    order: store.nextOptimisticOrder,
  }];
  const previous = store.optimistic.get(record.messageID);
  const previousQuality = store.optimisticQuality.get(record.messageID)
    ?? (previous ? recordQualityByObject.get(previous) : undefined)
    ?? "exact";
  if (previous) {
    candidates.push({
      record: previous,
      quality: previousQuality,
      source: "optimistic",
      order: store.optimisticOrder.get(record.messageID) ?? Number.NEGATIVE_INFINITY,
    });
  }
  const diskRecord = baseHistoryRecords(store).find((entry) => entry.messageID === record.messageID);
  if (diskRecord) candidates.push({ record: diskRecord, quality: diskRecordQuality(diskRecord), source: "disk", order: 0 });
  return candidates.slice(1).reduce(
    (best, candidate) => preferredHistoryLayer(candidate, best),
    candidates[0],
  );
}

export function handleMessageUpdated(
  store: RuntimeStore,
  api: TuiPluginApi,
  properties: ObjectRecord,
  event: CompatibleEvent,
  bytesPerToken: number,
  receivedAt = Date.now(),
): boolean {
  const info = eventInfo(properties, event);
  if (!info) return false;
  const messageID = readMessageID(properties, info);
  const sessionID = readStringFrom([info, properties, event], [
    "sessionID",
    "sessionId",
    "session.id",
  ]);
  if (!messageID || !sessionID) return false;
  const observations = observationRuntime(store);
  if (typeof info.role === "string") observations.metadata.roles.set(messageID, info.role);
  if (info.role !== "assistant") {
    if (typeof info.role === "string") store.active.delete(messageID);
    return false;
  }
  const timestamp = eventTimestamp(event, properties);

  if (!isCompleted(info, properties, event)) {
    if (knownCompletedMessage(store, messageID) || event.replay === true || properties.replay === true || event.source === "snapshot") return false;
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

  if (event.replay === true || properties.replay === true || event.source === "snapshot") return false;
  const previous = previousTuiRecord(store, messageID);
  const openSnapshot = store.totalsLedger.open[messageID] as OpenContribution | undefined;
  const snapshot = openSnapshot ?? store.totalsLedger.settled[messageID];
  if (snapshot === true) {
    store.completedMessageIDs.add(messageID); observations.metadata.completed.add(messageID);
    store.active.delete(messageID);
    return false;
  }
  let prior: HistoryRecord | OpenContribution | undefined = previous ?? snapshot;
  const snapshotUpdate = coerceCompletionUpdate(snapshot?.update);
  const previousUpdate = coerceCompletionUpdate((previous as MeasuredHistoryRecord | undefined)?.update);
  if (snapshot && snapshotUpdate && (!previousUpdate || isNewerCompletionUpdate(snapshotUpdate, previousUpdate))) prior = snapshot;
  const priorUpdate = coerceCompletionUpdate((prior as MeasuredHistoryRecord | undefined)?.update);
  const fingerprint = createHash("sha256").update(serializeCompletionFact(info)).digest("hex");
  const revision = readNumber(event.revision ?? properties.revision);
  const update: CompletionUpdate = { source: "live", instanceID: observations.instanceID, sequence: observations.metadata.nextSequence++, receivedAt,
    ...(revision !== undefined ? { revision } : {}), fingerprint,
    seenFingerprints: [...new Set([...(priorUpdate?.seenFingerprints ?? []), ...(priorUpdate ? [priorUpdate.fingerprint] : []), fingerprint])] };
  if (!isNewerCompletionUpdate(update, priorUpdate)) {
    store.completedMessageIDs.add(messageID); observations.metadata.completed.add(messageID);
    store.active.delete(messageID);
    return false;
  }
  const pendingState = store.active.get(messageID) ?? store.active.get(pendingKey(sessionID));
  const candidateTokens = makeTokens(info, pendingState, bytesPerToken);
  const exactFields = tokenFields(info.tokens);
  const quality: RecordQuality = exactFields.output !== undefined && exactFields.input !== undefined
    && (exactFields.reasoning !== undefined || candidateTokens.reasoning === 0) ? "exact" : "provisional";
  if (prior && (prior.quality ?? "exact") === "exact" && quality === "provisional") return false;
  const state = takeActiveState(store.active, messageID, sessionID);
  const tokens = makeTokens(info, state, bytesPerToken);
  const record = makeHistoryRecord({
    messageID,
    sessionID,
    parentSessionID: parentSessionID(api, sessionID, info, store),
    model: modelName(info) ?? state?.model,
    cost: readNumber(info.cost) ?? state?.cost ?? 0,
    tokens,
    samples: calibrateResponseSamples(state ? finalSamples(state) : previous?.samples ?? [], {
      output: tokens.output,
      reasoning: tokens.reasoning,
    }),
    state,
    info,
    completedAt: timestamp,
    quality,
  });
  if (previous) {
    const firstToken = earliestFirstOutput(record.time.start, record.time.completed ?? timestamp, previous.time.firstToken, record.time.firstToken);
    if (firstToken !== undefined) {
      record.time.firstToken = firstToken;
      record.time.ttft = firstToken - record.time.start;
    }
  }
  record.speed = mergeRecordSpeed(record, prior, state && finalSamples(state).length > 0 && !record.speed?.generation ? "invalidated" : "unobserved");
  (record as MeasuredHistoryRecord).update = update;
  commitRecord(store, record, true);
  observations.metadata.completed.add(messageID);
  noteTaskRecord(store, api, record);
  return true;
}

function previousTuiRecord(store: RuntimeStore, messageID: string): HistoryRecord | undefined {
  let selected: HistoryLayerCandidate | undefined;
  const consider = (record: HistoryRecord | undefined, source: HistoryLayerCandidate["source"]) => {
    if (!record) return;
    const candidate = { record, quality: record.quality ?? recordQuality(record), source,
      order: source === "disk" ? 0 : store.optimisticOrder.get(messageID) ?? 0 };
    selected = selected ? preferredHistoryLayer(candidate, selected) : candidate;
  };
  consider(store.records.find((record) => record.messageID === messageID), "disk");
  consider(store.diskRecords.find((record) => record.messageID === messageID), "disk");
  consider(store.optimistic.get(messageID), "optimistic");
  if (!selected) {
    for (const runtime of store.sessionRuntime.values()) {
      consider((runtime.contributions.get(messageID) ?? runtime.completedContributions.get(messageID))?.record, "optimistic");
    }
  }
  return selected?.record;
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
    if (!state.legacy.hasData && !state.v2.hasData && Object.keys(state.fallbackTokens).length === 0) continue;
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
        reasoning: tokens.reasoning,
      }),
      state,
      completedAt,
      quality: "provisional",
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
  const normalizedType = type.toLowerCase();
  if (normalizedType === "session.next.retried") return "retry";
  if (normalizedType === "session.next.step.failed") return "idle";
  if (
    normalizedType === "session.idle"
    || normalizedType === "session.error"
    || normalizedType === "session.abort"
    || normalizedType === "session.aborted"
    || normalizedType === "session.cancel"
    || normalizedType === "session.cancelled"
    || normalizedType === "session.stop"
    || normalizedType === "session.stopped"
    || normalizedType === "session.completed"
  ) return "idle";
  if (normalizedType !== "session.status" && !normalizedType.endsWith(".status")) return undefined;
  const value = properties.status
    ?? properties.state
    ?? event.status
    ?? getPath(properties, "info.status")
    ?? getPath(properties, "info.state")
    ?? getPath(event, "info.status")
    ?? getPath(event, "info.state");
  const name = statusName(value)?.toLowerCase();
  if (name === "busy" || name === "retry") return name;
  if (terminalStatus(value)) return "idle";
  return undefined;
}

function isSessionLifecycleEventType(type: string): boolean {
  const normalizedType = type.toLowerCase();
  return normalizedType === "session.idle"
    || normalizedType === "session.status"
    || normalizedType === "session.next.retried"
    || normalizedType === "session.next.step.failed"
    || normalizedType === "session.error"
    || normalizedType === "session.abort"
    || normalizedType === "session.aborted"
    || normalizedType === "session.cancel"
    || normalizedType === "session.cancelled"
    || normalizedType === "session.stop"
    || normalizedType === "session.stopped"
    || normalizedType === "session.completed";
}

function finishSessionRun(
  store: RuntimeStore,
  api: TuiPluginApi,
  sessionID: string,
  bytesPerToken: number,
  completedAt: number,
): boolean {
  const runtime = getSessionRuntime(store, sessionID);
  if (!sessionLifecycleFactBelongsToCurrentEpoch(runtime, completedAt)) return false;
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

function sessionLifecycleFactBelongsToCurrentEpoch(
  runtime: SessionRuntime,
  timestamp: number,
): boolean {
  const previousCompletion = runtime.lastRunSummary?.completedAt;
  return previousCompletion === undefined || timestamp >= previousCompletion;
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
  const eventParent = sessionParentFromEvent(type, properties, event);
  if (eventParent) rememberSessionParent(store, sessionID, eventParent);
  const rootSessionID = rootSessionIDFor(store, api, sessionID);
  const taskRun = status === "idle"
    ? findTaskWallRun(store, rootSessionID, sessionID) ?? getTaskWallRun(store, rootSessionID)
    : getTaskWallRun(store, rootSessionID);
  if (status === "idle") {
    const historyBefore = taskRun ? lifecycleHistorySignature(taskRun) : undefined;
    const finishedSession = finishSessionRun(store, api, sessionID, bytesPerToken, timestamp);
    const finishedTask = taskRun
      ? transitionTaskWallRun(taskRun, sessionID, "idle", timestamp)
      : undefined;
    const historyChanged = taskRun !== undefined
      && historyBefore !== lifecycleHistorySignature(taskRun);
    if (finishedTask || historyChanged) store.bump();
    return finishedSession || finishedTask !== undefined || historyChanged;
  }
  if (!taskRun) return false;
  const runtime = getSessionRuntime(store, sessionID);
  const historyBefore = lifecycleHistorySignature(taskRun);
  const currentEpoch = sessionLifecycleFactBelongsToCurrentEpoch(runtime, timestamp);
  const changed = currentEpoch
    ? transitionSessionRuntime(runtime, status, timestamp)
    : false;
  const finishedTask = transitionTaskWallRun(taskRun, sessionID, status, timestamp);
  const historyChanged = historyBefore !== lifecycleHistorySignature(taskRun);
  if (changed || finishedTask || historyChanged) store.bump();
  return false;
}

export function mergeHistoryLayers(
  diskRecords: readonly HistoryRecord[],
  optimistic: ReadonlyMap<string, HistoryRecord>,
  maxRecords: number,
  optimisticQuality?: ReadonlyMap<string, RecordQuality>,
  optimisticOrder?: ReadonlyMap<string, number>,
): HistoryRecord[] {
  const byMessage = new Map<string, HistoryLayerCandidate>();
  for (const record of diskRecords) {
    const candidate: HistoryLayerCandidate = {
      record,
      quality: diskRecordQuality(record),
      source: "disk",
      order: 0,
    };
    const existing = byMessage.get(record.messageID);
    byMessage.set(
      record.messageID,
      existing ? preferredHistoryLayer(candidate, existing) : candidate,
    );
  }
  for (const [messageID, record] of optimistic) {
    const candidate: HistoryLayerCandidate = {
      record,
      quality: optimisticQuality?.get(messageID) ?? recordQualityByObject.get(record) ?? "exact",
      source: "optimistic",
      order: optimisticOrder?.get(messageID) ?? 0,
    };
    const existing = byMessage.get(messageID);
    byMessage.set(
      messageID,
      existing ? preferredHistoryLayer(candidate, existing) : candidate,
    );
  }
  return [...byMessage.values()].map((candidate) => candidate.record).slice(-maxRecords);
}

export function classifyTokenFields(value: unknown): Partial<TokenCounts> {
  return tokenFields(value);
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
    && left.time.duration === right.time.duration
    && (left.quality ?? "exact") === (right.quality ?? "exact")
    && sameSpeedContribution(left.speed, right.speed)
    && JSON.stringify(coerceCompletionUpdate((left as MeasuredHistoryRecord).update)) === JSON.stringify(coerceCompletionUpdate((right as MeasuredHistoryRecord).update));
}

function recordCompletedAt(record: HistoryRecord): number {
  return record.time.completed ?? record.time.start;
}

function recordQuality(record: HistoryRecord): RecordQuality {
  return recordQualityByObject.get(record) ?? "exact";
}

function diskRecordQuality(record: HistoryRecord): RecordQuality {
  if (record.quality === "provisional" || record.quality === "exact") return record.quality;
  // HistoryRecord predates the in-memory quality marker. A persisted record
  // with timing/sample calibration is treated as complete; older snapshots
  // without that evidence remain provisional.
  return record.time.firstToken !== undefined
    || record.time.ttft !== undefined
    || record.samples.length > 0
    ? "exact"
    : "provisional";
}

function removeOptimisticRecord(store: RuntimeStore, messageID: string): void {
  store.optimistic.delete(messageID);
  store.optimisticQuality.delete(messageID);
  store.optimisticOrder.delete(messageID);
}

export function hydrateHistoryState(
  store: RuntimeStore,
  diskRecords: readonly HistoryRecord[],
): void {
  for (const record of diskRecords) {
    const overlay = store.optimistic.get(record.messageID);
    let selected = record;
    if (overlay) {
      const overlayQuality = store.optimisticQuality.get(record.messageID)
        ?? recordQualityByObject.get(overlay)
        ?? "provisional";
      const preferred = preferredHistoryLayer(
        { record, quality: diskRecordQuality(record), source: "disk", order: 0 },
        {
          record: overlay,
          quality: overlayQuality,
          source: "optimistic",
          order: store.optimisticOrder.get(record.messageID) ?? 0,
        },
      );
      if (preferred.record === overlay) {
        selected = overlay;
        if (overlayQuality === "exact") store.completedMessageIDs.add(record.messageID);
        const existing = store.lastCompletedBySession.get(overlay.sessionID);
        if (
          overlayQuality === "exact"
          && (existing === undefined || recordCompletedAt(overlay) >= recordCompletedAt(existing.record))
        ) {
          const runtime = store.sessionRuntime.get(overlay.sessionID);
          store.lastCompletedBySession.set(
            overlay.sessionID,
            makeLastCompletedSnapshot(overlay, runtime?.runEpoch ?? 0),
          );
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
    if (
      existing === undefined
      || recordCompletedAt(record) >= recordCompletedAt(existing.record)
    ) {
      store.lastCompletedBySession.set(
        record.sessionID,
        makeLastCompletedSnapshot(record, runtime?.runEpoch ?? 0),
      );
    }
  }
}

export async function reloadHistory(
  store: RuntimeStore,
  api: TuiPluginApi,
  path: string,
  totalsPath: string,
  maxRecords: number,
  generation = store.historyGeneration,
): Promise<void> {
  if (store.disposed) return;
  let diskRecords: HistoryRecord[];
  try {
    diskRecords = (await readHistoryFile(path)).slice(-maxRecords);
  } catch (error) {
    warnWithToast(api, "history read failed", error);
    return;
  }
  if (store.disposed || generation !== store.historyGeneration) return;

  let totalsLedger: TotalsLedger | undefined;
  try {
    totalsLedger = await readTotalsSnapshot(totalsPath);
  } catch (error) {
    if (store.disposed || generation !== store.historyGeneration) return;
    warnWithToast(api, "totals read failed", error);
  }
  if (store.disposed || generation !== store.historyGeneration) return;

  store.diskRecords = diskRecords;
  if (totalsLedger) store.totalsLedger = totalsLedger;
  repairKnownParents(store);
  hydrateHistoryState(store, store.diskRecords);
  store.records = mergeHistoryLayers(
    store.diskRecords,
    store.optimistic,
    maxRecords,
    store.optimisticQuality,
    store.optimisticOrder,
  );
  store.bump();
}

async function reloadActivity(
  store: RuntimeStore,
  api: TuiPluginApi,
  path: string,
  generation = store.activityGeneration,
): Promise<void> {
  if (store.disposed) return;
  try {
    const activityEvents = await readActivityFile(path);
    const activityReplay = replayActivity(activityEvents);
    if (
      store.disposed
      || generation !== store.activityGeneration
    ) return;
    store.activityEvents = activityEvents;
    store.activityReplay = activityReplay;
    store.activityGeneration = generation;
    let parentChanged = false;
    for (const [sessionID, parentSessionID] of activityReplay.parentBySessionID) {
      if (!parentSessionID || store.sessionParents.get(sessionID) === parentSessionID) continue;
      store.sessionParents.set(sessionID, parentSessionID);
      parentChanged = true;
    }
    if (parentChanged) {
      repairKnownParents(store);
      for (const sessionID of activityReplay.parentBySessionID.keys()) {
        migrateTaskWallRuns(store, activityRootSessionID(store, sessionID));
      }
    }
    store.bump();
  } catch (error) {
    warnWithToast(api, "activity read failed", error);
  }
}

export function resolveOptions(value: unknown): TuiOptions {
  const options = asRecord(value);
  const maxRecordsValue = readNumber(options?.maxRecords);
  const bytesPerTokenValue = readNumber(options?.bytesPerToken);
  return {
    historyPath: readString(options?.historyPath),
    runsPath: readString(options?.runsPath),
    totalsPath: readString(options?.totalsPath),
    maxRecords: maxRecordsValue !== undefined && maxRecordsValue > 0
      ? Math.max(1, Math.floor(maxRecordsValue))
      : DEFAULT_MAX_RECORDS,
    bytesPerToken: bytesPerTokenValue !== undefined && bytesPerTokenValue > 0
      ? bytesPerTokenValue
      : DEFAULT_BYTES_PER_TOKEN,
    enabled: options?.enabled !== false,
    keybinds: resolvePluginKeybinds(options?.keybinds),
  };
}

// Keep native key strings (commas and <leader> included) intact for the host.
function isKeybindValue(value: unknown): value is BindingValue {
  if (value === false || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((item) => !Array.isArray(item) && item !== false && isKeybindValue(item));
  const item = asRecord(value);
  if (!item) return false;
  if (typeof item.name === "string") {
    return ["ctrl", "shift", "meta", "super", "hyper"].every((flag) => item[flag] === undefined || typeof item[flag] === "boolean");
  }
  return typeof item.key === "string" || (isRecord(item.key) && typeof item.key.name === "string" && isKeybindValue(item.key));
}

function resolvePluginKeybinds(value: unknown): BindingConfig | undefined {
  const input = asRecord(value);
  if (!input) return undefined;
  const result: Record<string, BindingValue> = {};
  for (const name of [COMMAND_NAME, DETAILS_COMMAND_NAME]) {
    if (isKeybindValue(input[name])) result[name] = input[name];
  }
  return result;
}

export function tokenPulseBindings(options: TuiOptions) {
  const keys = createBindingLookup({
    [COMMAND_NAME]: "ctrl+shift+t",
    [DETAILS_COMMAND_NAME]: "ctrl+shift+y",
    ...options.keybinds,
  });
  return keys.gather("token-pulse", [COMMAND_NAME, DETAILS_COMMAND_NAME]);
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
      diskRecords: [],
      records: [],
      optimistic: new Map<string, HistoryRecord>(),
      optimisticQuality: new Map<string, RecordQuality>(),
      optimisticOrder: new Map<string, number>(),
      nextOptimisticOrder: 1,
      active: new Map<string, ActiveState>(),
      completedMessageIDs: new Set<string>(),
      sessionRuntime: new Map<string, SessionRuntime>(),
      taskRuns: new Map<string, TaskWallRun>(),
      sessionParents: new Map<string, string>(),
      totalsLedger: emptyTotalsLedger(),
      lastCompletedBySession: new Map<string, LastCompletedSnapshot>(),
      activityEvents: [],
      activityReplay: replayActivity([]),
      activityGeneration: 0,
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
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning;
}

function recordsWithKnownParents(
  records: readonly HistoryRecord[],
  store?: RuntimeStore,
): HistoryRecord[] {
  if (!store || store.sessionParents.size === 0) return [...records];
  return records.map((record) => rewriteRecordParent(record, store.sessionParents.get(record.sessionID)));
}

export function cacheHitRate(tokens: TokenCounts): number | undefined {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined;
  const rate = tokens.cacheRead / denominator;
  return Number.isFinite(rate) ? rate : undefined;
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
  const decimals = unitIndex === 0 ? (scaled >= 100 ? 0 : 1) : 1;
  const divisors = [1_000, 1_000_000, 1_000_000_000];
  const rendered = formatScaledUnit(absolute, divisors[unitIndex] ?? 1_000, decimals, unitIndex === 0);
  return `${sign}${rendered}${units[unitIndex]}`;
}

function formatScaledUnit(
  absolute: number,
  divisor: number,
  decimals: number,
  trimTrailingZero: boolean,
): string {
  let rendered: string;
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

export function formatCompactRate(value: number): string {
  return `${formatCompactNumber(value)} tok/s`;
}

export function formatCacheHitRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return "--";
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}

export function formatPulseMetrics(tokens: TokenCounts, speed: number): string {
  const speedLabel = Number.isFinite(speed) && speed > 0
    ? ` · ${formatCompactRate(speed)}`
    : "";
  return `${formatCompactNumber(totalTokens(tokens))} total${speedLabel} · cache ${formatCacheHitRate(cacheHitRate(tokens))}`;
}

export function formatPulseSummary(tokens: TokenCounts, speed: number): string {
  return `+ Token Pulse  ${formatPulseMetrics(tokens, speed)}`;
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
  return record.speed?.generation?.durationMs ?? record.speed?.response?.durationMs ?? durationOf(record);
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
  const metadata = { estimated: (record.speed?.generation ?? record.speed?.response)?.estimated ?? true,
    basis: record.speed?.generation ? "generation" as const : "response" as const };
  if (record.samples.length >= 2 && sampleStats.avg > 0) {
    return { ...sampleStats, avg: stableRate > 0 ? stableRate : sampleStats.avg, generated, ...metadata };
  }
  return {
    avg: stableRate,
    max: stableRate,
    min: stableRate,
    generated,
    ...metadata,
  };
}

export function aggregateSpeed(records: readonly HistoryRecord[]): number {
  let generated = 0;
  let elapsed = 0;
  for (const record of records) {
    // Window/LAST aggregate uses a single response basis; never mix generation
    // and response durations when only a subset has generation coverage.
    const generationTime = record.speed?.response?.durationMs ?? durationOf(record);
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
    `  Total tokens (input + generated + cache) ${formatCompactNumber(totalTokens(tokens))}`,
    `  Uncached input ${formatCompactNumber(tokens.input)}  Cache read (reused) ${formatCompactNumber(tokens.cacheRead)}`,
    `  Cache hit rate ${formatCacheHitRate(cacheHitRate(tokens))}`,
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
    { label: "Total tokens (input + generated + cache)", value: formatCompactNumber(totalTokens(tokens)) },
    { label: "Uncached input", value: formatCompactNumber(tokens.input) },
    { label: "Cache read (reused)", value: formatCompactNumber(tokens.cacheRead) },
    { label: "Cache hit rate", value: formatCacheHitRate(cacheHitRate(tokens)) },
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
          [metrics[9]],
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
  store?: RuntimeStore,
): SessionAggregate | undefined {
  if (!sessionID) return undefined;
  const repairedRecords = recordsWithKnownParents(records, store);
  const direct = aggregateSession(repairedRecords, sessionID);
  if (direct) return direct;

  const roots = aggregateSessionTree(repairedRecords);
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
  store?: RuntimeStore,
): HistoryRecord[] {
  if (!sessionID) return [...records];
  const aggregate = aggregateForSession(records, sessionID, store);
  const repairedRecords = recordsWithKnownParents(records, store);
  if (!aggregate) return repairedRecords.filter((record) => record.sessionID === sessionID);
  const ids = new Set<string>();
  const visit = (node: SessionAggregate) => {
    ids.add(node.sessionID);
    node.children.forEach(visit);
  };
  visit(aggregate);
  return repairedRecords.filter((record) => ids.has(record.sessionID));
}

function recentRecords(
  records: readonly HistoryRecord[],
  sessionID: string | undefined,
  store?: RuntimeStore,
): HistoryRecord[] {
  return recordsForSession(records, sessionID, store)
    .slice()
    .sort((left, right) => (
      (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start)
    ))
    .slice(0, 24);
}

const TOTALS_TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

interface TotalsProjectionLedger {
  sessions: Record<string, SessionDirectTotals>;
  open: Record<string, OpenContribution>;
  settled?: Record<string, OpenContribution | true>;
}

export function projectSessionTotals(
  ledger: TotalsProjectionLedger,
  records: readonly HistoryRecord[],
  parentBySessionID: ReadonlyMap<string, string>,
  sessionID: string,
): TotalsRollup {
  const projected = projectTotals(ledger, records, parentBySessionID);
  return rollupSessionTotals(projected.sessions, projected.parents, sessionID);
}

function totalsForSession(store: RuntimeStore, sessionID: string | undefined): TotalsRollup | undefined {
  if (!sessionID) return undefined;
  // Detail-window trimming must not discard unconfirmed direct contributions.
  const contributions = mergeHistoryLayers(baseHistoryRecords(store), store.optimistic, Number.MAX_SAFE_INTEGER,
    store.optimisticQuality, store.optimisticOrder);
  return projectSessionTotals(store.totalsLedger, contributions, store.sessionParents, sessionID);
}

export function sessionUsageSummary(store: RuntimeStore, sessionID: string): SessionAverageSummary {
  return getSessionAverageSummary(totalsForSession(store, sessionID)?.direct ?? zeroDirectTotals());
}

export function formatAverageRate(summary: AverageRateSummary): string {
  if (!summary.available || summary.rate === undefined) return "--";
  return `${summary.estimated ? "~" : ""}${formatCompactRate(summary.rate)}`;
}

export function sessionAverageDisplay(summary: SessionAverageSummary, isChild = false): {
  label: string; value: string; coverage?: string;
} {
  const basis = summary.generation.available ? "generation" : "response";
  const measured = summary[basis];
  const partial = measured.available && (measured.coveredResponseCount < summary.totalResponseCount
    || measured.coveredGeneratedTokens < summary.totalGeneratedTokens);
  return {
    label: isChild ? "Session avg TPS" : "Main avg TPS",
    value: `${formatAverageRate(measured)}${measured.available && basis === "response" ? " (response)" : ""}`,
    ...(partial ? { coverage: `Measured ${formatCompactNumber(measured.coveredResponseCount)}/${formatCompactNumber(summary.totalResponseCount)} calls` } : {}),
  };
}

function averageCoverage(summary: AverageRateSummary, total: SessionAverageSummary): string {
  return `${formatCompactNumber(summary.coveredGeneratedTokens)}/${formatCompactNumber(total.totalGeneratedTokens)} generated tokens · ${formatCompactNumber(summary.coveredResponseCount)}/${formatCompactNumber(total.totalResponseCount)} calls · ${formatOptionalDuration(summary.available ? summary.durationMs : undefined)} measured · ${formatCompactNumber(summary.estimatedResponseCount)} estimated calls`;
}

export function TokenPulseDetails(props: { api: TuiPluginApi; store: RuntimeStore; sessionID: string }): JSX.Element {
  const [dimensions, setDimensions] = createSignal({ width: props.api.renderer.width, height: props.api.renderer.height });
  const onResize = (width: number, height: number) => setDimensions({ width, height });
  if (typeof props.api.renderer.on === "function") {
    props.api.renderer.on("resize", onResize);
    onCleanup(() => props.api.renderer.off("resize", onResize));
  }
  // Host Dialog starts at height / 4 and adds one top-padding row. Reserve
  // another bottom row rather than budgeting against the whole terminal.
  const contentHeight = () => Math.max(1, dimensions().height - Math.ceil(dimensions().height / 4) - 2);
  const compact = () => dimensions().height < 24;
  const details = createMemo(() => {
    props.store.revision();
    const direct = totalsForSession(props.store, props.sessionID)?.direct ?? zeroDirectTotals();
    const average = getSessionAverageSummary(direct);
    const last = props.store.lastCompletedBySession.get(props.sessionID);
    return { direct, average, last };
  });
  const theme = props.api.theme.current;
  return (
    <box flexDirection="column" paddingX={dimensions().width < 50 ? 1 : 2} paddingY={compact() ? 0 : 1} width="100%" height={contentHeight()} flexShrink={0} overflow="hidden">
      <text fg={theme.primary} flexShrink={0}>Token Pulse details</text>
      <text fg={theme.textMuted} flexShrink={0} wrapMode="word">{`Session ${props.sessionID} · this session only; no subagents`}</text>
      <scrollbox flexGrow={1} flexShrink={1} minHeight={0} paddingTop={1} focusable scrollY scrollX={false} viewportOptions={{ minHeight: 0, overflow: "hidden" }} contentOptions={{ flexDirection: "column", flexShrink: 0 }} ref={(scroll) => onMount(() => scroll.focus())}>
        <box flexDirection="column" flexShrink={0} width="100%">
        <text fg={theme.accent}>SESSION AVERAGES</text>
        <text fg={theme.text} wrapMode="word">{`Generation avg TPS  ${formatAverageRate(details().average.generation)}`}</text>
        <text fg={theme.textMuted} wrapMode="word">{averageCoverage(details().average.generation, details().average)}</text>
        <text fg={theme.text} wrapMode="word">{`Response avg TPS  ${formatAverageRate(details().average.response)}`}</text>
        <text fg={theme.textMuted} wrapMode="word">{averageCoverage(details().average.response, details().average)}</text>
        <text fg={theme.textMuted} wrapMode="word">Response time includes TTFT and may include tool waits. Generation time needs observed start and end boundaries.</text>
        <text fg={theme.accent} paddingTop={1}>SESSION USAGE</text>
        <PulseMetricGrid theme={props.api.theme} rows={pulseMetricRows(details().direct.tokens, details().direct.cost, details().direct.responseCount).map((metric) => [metric])} />
        <text fg={theme.accent} paddingTop={1}>LAST RESPONSE</text>
        <text fg={theme.text} wrapMode="word">{details().last
          ? `${details().last!.estimated ? "~" : ""}${formatCompactRate(details().last!.rate)} (${details().last!.record.speed?.generation ? "generation" : "response"}) · TTFT ${formatOptionalDuration(details().last!.ttft)} · elapsed ${formatDuration(details().last!.elapsed)}`
          : "No completed response in the loaded history"}</text>
        <text fg={theme.textMuted} paddingTop={1} wrapMode="word">Average = measured generated tokens / measured time, not an average of call speeds. Generated tokens include output and reasoning; input and cache are excluded.</text>
        <text fg={theme.textMuted} wrapMode="word">~ means estimated. Coverage shows which calls have usable timing; older calls may have none. Live speed uses observed stream samples, not exact model usage.</text>
        </box>
      </scrollbox>
      <text fg={theme.textMuted} paddingTop={compact() ? 0 : 1} flexShrink={0}>esc / ctrl+c to close</text>
    </box>
  );
}

export function createDetailsController(api: TuiPluginApi, store: RuntimeStore) {
  let owned = false;
  let openedSessionID: string | undefined;
  return {
    get owned() { return owned; },
    get sessionID() { return openedSessionID; },
    open(): string | undefined {
      if (store.disposed || api.ui.dialog.open) return undefined;
      const sessionID = currentSessionID(api);
      if (!sessionID) {
        api.ui.toast({ variant: "info", message: "Open a session to view Token Pulse details", duration: 3000 });
        return undefined;
      }
      api.ui.dialog.replace(() => <TokenPulseDetails api={api} store={store} sessionID={sessionID} />, () => {
        owned = false;
        openedSessionID = undefined;
      });
      owned = true;
      openedSessionID = sessionID;
      api.ui.dialog.setSize("large");
      return sessionID;
    },
  };
}

export function registerTokenPulseCommands(api: TuiPluginApi, store: RuntimeStore, options: TuiOptions, openHistory: () => void) {
  const details = createDetailsController(api, store);
  // Palette and slash lookup happens in modal/autocomplete modes. Keep
  // definitions reachable there, without enabling shortcuts in those modes.
  const commands = api.keymap.registerLayer({
    commands: [
      { name: COMMAND_NAME, title: "Open token history", desc: "Open recent token speed history for the current session", category: "Plugin", namespace: "palette", slashName: "tps", run: openHistory },
      { name: DETAILS_COMMAND_NAME, title: "Token Pulse details", desc: "Session averages, usage and timing coverage", category: "Plugin", namespace: "palette", slashName: "tps-details", run: () => { details.open(); } },
    ],
  });
  api.lifecycle.onDispose(commands);
  const bindings = api.keymap.registerLayer({
    mode: "base",
    bindings: tokenPulseBindings(options),
  });
  api.lifecycle.onDispose(bindings);
  return details;
}

interface ProjectedTotals {
  sessions: Record<string, SessionDirectTotals>;
  parents: Map<string, string>;
}

function projectTotals(
  ledger: TotalsProjectionLedger,
  records: readonly HistoryRecord[],
  parentBySessionID: ReadonlyMap<string, string>,
): ProjectedTotals {
  const unique = mergeHistoryLayers(records, new Map(), Number.MAX_SAFE_INTEGER);
  return {
    sessions: applyWindowAdjustments(ledger, unique),
    parents: projectionParents(parentBySessionID, unique),
  };
}

function applyWindowAdjustments(
  ledger: TotalsProjectionLedger,
  records: readonly HistoryRecord[],
): Record<string, SessionDirectTotals> {
  const sessions: Record<string, SessionDirectTotals> = {};
  for (const [sessionID, session] of Object.entries(ledger.sessions ?? {})) {
    if (sessionID.length === 0 || !session) continue;
    sessions[sessionID] = cloneDirectTotals(session);
  }
  const settled = ledger.settled ?? {};
  const open = ledger.open ?? {};
  for (const record of records) {
    const settledValue = settled[record.messageID];
    if (settledValue === true) continue;
    const next = contributionNumbers(record);
    if (!next) continue;
    const previous = settledValue ?? open[record.messageID];
    if (previous) {
      if (previous.quality === "exact" && record.quality === "provisional") continue;
      const priorUpdate = coerceCompletionUpdate(previous.update);
      const nextUpdate = coerceCompletionUpdate((record as MeasuredHistoryRecord).update);
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
        applyDirectDelta(
          ensureDirect(sessions, next.sessionID),
          prior.tokens,
          prior.cost,
          next.tokens,
          next.cost,
          prior.speed,
          next.speed,
        );
      }
      continue;
    }
    addDirect(ensureDirect(sessions, next.sessionID), next.tokens, next.cost, next.speed);
  }
  return sessions;
}

interface ContributionNumbers {
  sessionID: string;
  tokens: TokenCounts;
  cost: number;
  speed?: SpeedContribution;
}

function contributionNumbers(record: HistoryRecord): ContributionNumbers | undefined {
  if (typeof record.sessionID !== "string" || record.sessionID.length === 0) return undefined;
  return {
    sessionID: record.sessionID,
    tokens: normalizeTokenCounts(record.tokens),
    cost: nonNegativeMetric(record.cost),
    speed: coerceSpeedContribution(record.speed),
  };
}

function openNumbers(contribution: OpenContribution): ContributionNumbers | undefined {
  if (typeof contribution?.sessionID !== "string" || contribution.sessionID.length === 0) return undefined;
  return {
    sessionID: contribution.sessionID,
    tokens: normalizeTokenCounts(contribution.tokens),
    cost: nonNegativeMetric(contribution.cost),
    speed: coerceSpeedContribution(contribution.speed),
  };
}

function sameContributionNumbers(left: ContributionNumbers, right: ContributionNumbers): boolean {
  return left.sessionID === right.sessionID
    && left.cost === right.cost
    && sameSpeedContribution(left.speed, right.speed)
    && TOTALS_TOKEN_FIELDS.every((field) => left.tokens[field] === right.tokens[field]);
}

function projectionParents(
  parentBySessionID: ReadonlyMap<string, string>,
  records: readonly HistoryRecord[],
): Map<string, string> {
  const parents = new Map<string, string>();
  for (const [sessionID, parent] of parentBySessionID) {
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

function isParentLink(sessionID: string, parent: string | null | undefined): parent is string {
  return typeof sessionID === "string"
    && sessionID.length > 0
    && typeof parent === "string"
    && parent.length > 0
    && parent !== sessionID;
}

function cloneDirectTotals(session: SessionDirectTotals): SessionDirectTotals {
  return {
    tokens: normalizeTokenCounts(session.tokens),
    cost: nonNegativeMetric(session.cost),
    responseCount: nonNegativeMetric(session.responseCount),
    ...(session.speed ? { speed: coerceSpeedTotals(session.speed) } : {}),
  };
}

function zeroDirectTotals(): SessionDirectTotals {
  return {
    tokens: emptyTokenCounts(),
    cost: 0,
    responseCount: 0,
  };
}

function ensureDirect(
  sessions: Record<string, SessionDirectTotals>,
  sessionID: string,
): SessionDirectTotals {
  const existing = sessions[sessionID];
  if (existing) return existing;
  const created = zeroDirectTotals();
  sessions[sessionID] = created;
  return created;
}

function addDirect(session: SessionDirectTotals, tokens: TokenCounts, cost: number, speed?: SpeedContribution): void {
  session.tokens = clampTokenCounts(addTokenCounts(session.tokens, tokens));
  session.cost = clampNonNegative(session.cost + cost);
  session.responseCount = clampNonNegative(session.responseCount + 1);
  const updated = updateSpeedTotals(session.speed, speed, 1);
  if (updated) session.speed = updated;
}

function subtractDirect(session: SessionDirectTotals, tokens: TokenCounts, cost: number, speed?: SpeedContribution): void {
  session.tokens = subtractTokenCounts(session.tokens, tokens);
  session.cost = clampNonNegative(session.cost - cost);
  session.responseCount = clampNonNegative(session.responseCount - 1);
  const updated = updateSpeedTotals(session.speed, speed, -1);
  if (updated) session.speed = updated;
}

function applyDirectDelta(
  session: SessionDirectTotals,
  previousTokens: TokenCounts,
  previousCost: number,
  nextTokens: TokenCounts,
  nextCost: number,
  previousSpeed?: SpeedContribution,
  nextSpeed?: SpeedContribution,
): void {
  const tokens = emptyTokenCounts();
  for (const field of TOTALS_TOKEN_FIELDS) {
    tokens[field] = clampNonNegative(session.tokens[field] + nextTokens[field] - previousTokens[field]);
  }
  session.tokens = tokens;
  session.cost = clampNonNegative(session.cost + nextCost - previousCost);
  const updated = updateSpeedTotals(updateSpeedTotals(session.speed, previousSpeed, -1), nextSpeed, 1);
  if (updated) session.speed = updated;
}

function subtractTokenCounts(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    input: clampNonNegative(left.input - right.input),
    output: clampNonNegative(left.output - right.output),
    reasoning: clampNonNegative(left.reasoning - right.reasoning),
    cacheRead: clampNonNegative(left.cacheRead - right.cacheRead),
    cacheWrite: clampNonNegative(left.cacheWrite - right.cacheWrite),
  };
}

function clampTokenCounts(tokens: TokenCounts): TokenCounts {
  return {
    input: clampNonNegative(tokens.input),
    output: clampNonNegative(tokens.output),
    reasoning: clampNonNegative(tokens.reasoning),
    cacheRead: clampNonNegative(tokens.cacheRead),
    cacheWrite: clampNonNegative(tokens.cacheWrite),
  };
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function nonNegativeMetric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function totalsHaveUsage(totals: SessionDirectTotals | undefined): boolean {
  if (!totals) return false;
  return totals.responseCount > 0 || totals.cost > 0 || totalTokens(totals.tokens) > 0;
}

function emptyTotalsLedger(): TotalsLedger {
  return {
    version: TOTALS_VERSION,
    sessions: {},
    open: {},
    settled: {},
  };
}

async function readTotalsSnapshot(path: string): Promise<TotalsLedger> {
  // createTotalsStorage().read() keeps a process-local cache, so a ledger
  // written by the server process would stay stale. Reload from disk instead.
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyTotalsLedger();
    throw error;
  }
  return coerceTotalsSnapshot(JSON.parse(content));
}

function coerceTotalsSnapshot(value: unknown): TotalsLedger {
  if (!isRecord(value) || value.version !== TOTALS_VERSION) {
    throw new TypeError("Invalid totals ledger");
  }
  if (!isRecord(value.sessions) || !isRecord(value.open)) {
    throw new TypeError("Invalid totals ledger");
  }
  const sessions: Record<string, SessionDirectTotals> = {};
  for (const [sessionID, sessionValue] of Object.entries(value.sessions)) {
    if (sessionID.length === 0) throw new TypeError("Invalid totals ledger");
    sessions[sessionID] = coerceDirectTotals(sessionValue);
  }
  const open: Record<string, OpenContribution> = {};
  for (const [messageID, contribution] of Object.entries(value.open)) {
    if (messageID.length === 0) throw new TypeError("Invalid totals ledger");
    open[messageID] = coerceOpenContribution(contribution);
  }
  return {
    version: TOTALS_VERSION,
    sessions,
    open,
    settled: coerceSettled(value.settled),
  };
}

function coerceSettled(value: unknown): Record<string, OpenContribution | true> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("Invalid totals ledger");
  const settled: Record<string, OpenContribution | true> = {};
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

function coerceDirectTotals(value: unknown): SessionDirectTotals {
  if (!isRecord(value)) throw new TypeError("Invalid totals ledger");
  if (value.speed !== undefined && !coerceSpeedTotals(value.speed)) throw new TypeError("Invalid totals ledger");
  return {
    tokens: coerceTotalsTokens(value.tokens),
    cost: requireNonNegative(value.cost),
    responseCount: requireNonNegative(value.responseCount),
    ...(value.speed !== undefined ? { speed: coerceSpeedTotals(value.speed) } : {}),
  };
}

function coerceOpenContribution(value: unknown): OpenContribution {
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
    ...(value.speed !== undefined ? { speed: coerceSpeedContribution(value.speed) } : {}),
    ...(value.update !== undefined ? { update: coerceCompletionUpdate(value.update) } : {}),
  };
}

function coerceTotalsTokens(value: unknown): TokenCounts {
  if (!isRecord(value)) throw new TypeError("Invalid totals ledger");
  return {
    input: requireNonNegative(value.input),
    output: requireNonNegative(value.output),
    reasoning: requireNonNegative(value.reasoning),
    cacheRead: requireNonNegative(value.cacheRead),
    cacheWrite: requireNonNegative(value.cacheWrite),
  };
}

function requireNonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("Invalid totals ledger");
  }
  return value;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error || isRecord(value);
}

function childRows(
  records: readonly HistoryRecord[],
  sessionID: string | undefined,
  store?: RuntimeStore,
): ChildRow[] {
  if (!sessionID || !store) return [];
  const projected = projectTotals(store.totalsLedger, records, store.sessionParents);
  const root = rollupSessionTotals(projected.sessions, projected.parents, sessionID);
  const rows: ChildRow[] = [];
  const visited = new Set<string>([sessionID]);
  const append = (childID: string, depth: number): void => {
    if (visited.has(childID)) return;
    visited.add(childID);
    const rollup = rollupSessionTotals(projected.sessions, projected.parents, childID);
    const directRecords = records.filter((record) => record.sessionID === childID);
    const show = directRecords.length > 0 || totalsHaveUsage(rollup.including);
    if (show) {
      const modelRecord = directRecords
        .slice()
        .sort((left, right) => (
          (right.time.completed ?? right.time.start) - (left.time.completed ?? left.time.start)
        ))[0];
      rows.push({
        depth,
        sessionID: childID,
        responseCount: rollup.direct.responseCount || rollup.including.responseCount,
        generated: rollup.direct.responseCount > 0
          ? generatedTokens(rollup.direct.tokens)
          : generatedTokens(rollup.including.tokens),
        speed: aggregateSpeed(directRecords),
        model: modelRecord?.model ?? "-",
      });
    }
    for (const child of rollup.children) append(child.sessionID, show ? depth + 1 : depth);
  };
  for (const child of root.children) append(child.sessionID, 0);
  return rows;
}

function activeStats(
  state: ActiveState | undefined,
  now: number,
  bytesPerToken: number,
): {
  rate: number;
  status: "warming" | "ready" | "inactive";
  generated: number;
  ttft?: number;
  elapsed: number;
} {
  if (!state) return { rate: 0, status: "inactive", generated: 0, elapsed: 0 };
  const tokens = estimateActiveTokens(state, bytesPerToken);
  const measured = measureRollingTokenRate(selectedSamples(state), now, DEFAULT_ROLLING_WINDOW_MS);
  return {
    rate: measured.rate,
    status: measured.status,
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

export function liveLabel(
  store: RuntimeStore,
  sessionID: string,
  bytesPerToken: number,
  width: number,
  now = Date.now(),
  toolWaiting = false,
): string {
  const runtime = store.sessionRuntime.get(sessionID);
  const state = latestActive(store.active, sessionID, runtime?.activeMessageID);
  const stats = activeStats(state, now, bytesPerToken);
  const runGenerated = runtime ? generatedTokens(runtime.runTotals) : 0;
  if (state) {
    const rate = toolWaiting || stats.status === "inactive" ? "WAIT --"
      : stats.status === "warming" ? "WARMUP --" : `LIVE ~${formatCompactRate(stats.rate)}`;
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
    const rollup = totalsForSession(props.store, props.sessionID);
    const aggregate = aggregateForSession(props.store.records, props.sessionID, props.store);
    if (!rollup || (!totalsHaveUsage(rollup.including) && !aggregate)) return emptySummaryLines();
    return [
      ...summaryLines(
        "Session only",
        rollup.direct.tokens,
        rollup.direct.cost,
        rollup.direct.responseCount,
      ),
      ...summaryLines(
        "Including subagents",
        rollup.including.tokens,
        rollup.including.cost,
        rollup.including.responseCount,
      ),
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
    return recentRecords(props.store.records, props.sessionID, props.store);
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
  rememberVisibleSession(props.store, props.sessionID);
  const label = createMemo(() => {
    props.store.revision();
    return liveLabel(
      props.store,
      props.sessionID,
      props.options.bytesPerToken,
      Math.max(1, props.api.renderer.width),
      Date.now(),
      knownToolWaiting(props.api, props.store, props.sessionID),
    );
  });
  return <text fg={props.api.theme.current.accent} truncate wrapMode="none">{label()}</text>;
}

function knownToolWaiting(api: TuiPluginApi, store: RuntimeStore, sessionID: string): boolean {
  const state = latestActive(store.active, sessionID, store.sessionRuntime.get(sessionID)?.activeMessageID);
  if (!state) return false;
  const latest = selectedSamples(state).at(-1)?.timestamp ?? state.startedAt;
  try {
    return api.state.part(state.messageID).some((part) => part.type === "tool"
      && part.state.status === "running" && part.state.time.start >= latest);
  } catch {
    return false;
  }
}

export function rememberVisibleSession(store: RuntimeStore, sessionID: string | undefined): void {
  if (!sessionID || store.focusSessionID === sessionID) return;
  store.focusSessionID = sessionID;
  store.bump();
}

export function displayedSessionID(_store: RuntimeStore, slotSessionID: string): string {
  return slotSessionID;
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
    return displayedSessionID(props.store, props.sessionID);
  });
  const view = createMemo((): AggregateView => {
    props.store.revision();
    return {
      aggregate: aggregateForSession(props.store.records, sessionID(), props.store),
      records: props.store.records,
      totals: totalsForSession(props.store, sessionID()),
    };
  });
  const taskWallTime = createMemo(() => {
    props.store.revision();
    return taskWallTimeForSession(props.store, sessionID());
  });
  const rows = createMemo(() => childRows(view().records, sessionID(), props.store));
  const average = createMemo(() => {
    props.store.revision();
    return sessionAverageDisplay(sessionUsageSummary(props.store, sessionID()),
      Boolean(parentSessionID(props.api, sessionID(), undefined, props.store)));
  });
  const sections = createMemo((): PulseSectionData[] => {
    const totals = view().totals;
    return [
      {
        label: "SESSION ONLY",
        tokens: totals?.direct.tokens ?? emptyTokenCounts(),
        cost: totals?.direct.cost ?? 0,
        responseCount: totals?.direct.responseCount ?? 0,
      },
      {
        label: "INCLUDING SUBAGENTS",
        tokens: totals?.including.tokens ?? emptyTokenCounts(),
        cost: totals?.including.cost ?? 0,
        responseCount: totals?.including.responseCount ?? 0,
      },
    ];
  });
  const pulseSummary = createMemo(() => {
    const currentView = view();
    const currentSessionID = sessionID();
    return {
      tokens: currentView.totals?.including.tokens ?? emptyTokenCounts(),
      speed: currentView.aggregate && currentSessionID
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
      flexShrink={0}
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
      <box flexDirection="column" width="100%" paddingX={1} flexShrink={0}>
        <text fg={props.api.theme.current.textMuted} wrapMode="word" flexShrink={0}>{average().label}</text>
        <text fg={props.api.theme.current.accent} wrapMode="word" flexShrink={0}>{average().value}</text>
        {average().coverage && <text fg={props.api.theme.current.textMuted} wrapMode="word" flexShrink={0}>{average().coverage}</text>}
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
          {!view().aggregate && !totalsHaveUsage(view().totals?.including) && (
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

function registerLegacyCommand(api: TuiPluginApi, openHistory: () => void, openDetails: () => void, options: TuiOptions): void {
  if (!api.command) return;
  try {
    const dispose = once(api.command.register(() => [
      {
        title: "Open token history",
        value: COMMAND_NAME,
        description: "Open recent token speed history for the current session",
        category: "Plugin",
        keybind: legacyBinding(options, COMMAND_NAME, "ctrl+shift+t"),
        slash: { name: "tps" },
        onSelect: openHistory,
      },
      {
        title: "Token Pulse details",
        value: DETAILS_COMMAND_NAME,
        description: "Session averages, usage and timing coverage",
        category: "Plugin",
        keybind: legacyBinding(options, DETAILS_COMMAND_NAME, "ctrl+shift+y"),
        slash: { name: "tps-details" },
        onSelect: openDetails,
      },
    ]));
    api.lifecycle.onDispose(dispose);
  } catch (error) {
    warnWithToast(api, "legacy command registration failed", error);
  }
}

function legacyBinding(options: TuiOptions, name: string, fallback: string): string | undefined {
  if (!options.keybinds || !Object.hasOwn(options.keybinds, name)) return fallback;
  const value = options.keybinds[name];
  return typeof value === "string" && value !== "none" ? value : undefined;
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = resolveOptions(rawOptions);
  if (!options.enabled) return;

  const store = createRuntimeStore(options.maxRecords);
  const historyPath = resolveHistoryPath(api, options.historyPath);
  const runsPath = resolveRunsPath(historyPath, options.runsPath);
  const totalsPath = resolveTotalsPath({
    historyPath,
    totalsPath: options.totalsPath,
  });
  let disposed = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let activityReloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadGeneration = 0;
  let activityReloadGeneration = 0;

  const scheduleReload = (): void => {
    reloadGeneration += 1;
    const generation = reloadGeneration;
    store.historyGeneration = generation;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    const run = async (attempt: number): Promise<void> => {
      if (disposed || generation !== reloadGeneration) return;
      reloadTimer = undefined;
      await reloadHistory(store, api, historyPath, totalsPath, options.maxRecords, generation);
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

  const scheduleActivityReload = (): void => {
    activityReloadGeneration += 1;
    const generation = activityReloadGeneration;
    store.activityGeneration = generation;
    if (activityReloadTimer !== undefined) clearTimeout(activityReloadTimer);
    const run = async (attempt: number): Promise<void> => {
      if (disposed || generation !== activityReloadGeneration) return;
      activityReloadTimer = undefined;
      await reloadActivity(store, api, runsPath, generation);
      if (!disposed && generation === activityReloadGeneration && attempt < 3) {
        activityReloadTimer = setTimeout(() => {
          void run(attempt + 1);
        }, 100);
      }
    };
    activityReloadTimer = setTimeout(() => {
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

    registerTokenPulseCommands(api, store, options, openHistory);
    api.keymap.registerLayer({
      mode: HISTORY_MODE,
      priority: 100,
      commands: [
        {
          name: "oc-tps.history.back",
          title: "Return from token history",
          desc: "Return to the current session or home",
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
    const details = createDetailsController(api, store);
    registerLegacyCommand(api, openHistory, () => { details.open(); }, options);
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
    const receivedAt = Date.now();
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
        if (mapped) store.bump();
        scheduleActivityReload();
        return;
      }
      if (eventSessionID) rootSessionIDFor(store, api, eventSessionID);
      if (type === "message.part.updated") {
        recordTuiPartMetadata(store, properties);
        return;
      }
      if (type === "message.part.delta") {
        recordDelta(store, properties, event, "legacy", undefined, options.bytesPerToken);
        return;
      }
      if (type === "session.next.text.delta" || type === "session.next.reasoning.delta" || type === "session.next.tool.input.delta") {
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

  const interval = setInterval(() => {
    if (!disposed && hasLiveTaskWallActivity(store)) store.bump();
  }, 500);

  api.lifecycle.onDispose(() => {
    disposed = true;
    store.disposed = true;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    if (activityReloadTimer !== undefined) clearTimeout(activityReloadTimer);
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
    store.activityEvents = [];
    store.activityReplay = replayActivity([]);
    store.lastCompletedBySession.clear();
    store.focusSessionID = undefined;
    store.disposeSignals();
  });

  store.historyGeneration += 1;
  await Promise.all([
    reloadHistory(store, api, historyPath, totalsPath, options.maxRecords, store.historyGeneration),
    reloadActivity(store, api, runsPath, store.activityGeneration),
  ]);
};

const plugin = {
  id: "oc-tps",
  tui,
};

export default plugin;
