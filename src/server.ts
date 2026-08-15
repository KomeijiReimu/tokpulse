import type { Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin";
import {
  HISTORY_VERSION,
  HistoryRecord,
  SpeedSample,
  TokenCounts,
  bytesToTokens,
  calibrateResponseSamples,
  emptyTokenCounts,
  normalizeTokenCounts,
  utf8ByteLength,
} from "./core.js";
import { createHistoryStorage, HistoryStorage } from "./storage.js";

export interface ServerOptions {
  historyPath?: string;
  maxRecords?: number;
  bytesPerToken?: number;
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

interface AnyRecord {
  [key: string]: any;
}

const DEFAULT_HISTORY_PATH = ".opencode/oc-tps/history.jsonl";

export const server: Plugin = async (input: PluginInput, pluginOptions?: PluginOptions) => {
  const options = resolveOptions(pluginOptions ?? (input as AnyRecord).options ?? (input as AnyRecord).config);
  const baseDirectory = resolveProjectDirectory(input);
  const historyPath = resolveHistoryPath(baseDirectory, options.historyPath);
  const storage = createHistoryStorage(historyPath, {
    maxRecords: options.maxRecords,
  });
  const bytesPerToken = validBytesPerToken(options.bytesPerToken);
  const active = new Map<string, ActiveState>();
  const completedMessageIDs = new Set<string>();
  let eventQueue: Promise<void> = Promise.resolve();

  const event = (payload: { event?: unknown }): Promise<void> => {
    const rawEvent = payload?.event;
    const next = eventQueue
      .then(() => handleEvent(rawEvent, input, storage, active, completedMessageIDs, bytesPerToken))
      .catch((error) => {
        warn("event handling failed", error);
      });
    eventQueue = next;
    return next;
  };

  return { event };
};

export function resolveProjectDirectory(input: Pick<PluginInput, "directory" | "worktree">): string {
  if (typeof input.worktree === "string" && input.worktree.length > 0 && input.worktree !== "/") {
    return input.worktree;
  }
  return input.directory;
}

export function resolveHistoryPath(baseDirectory: string, configuredPath?: string): string {
  if (!configuredPath || configuredPath.trim().length === 0) {
    return joinPath(baseDirectory, DEFAULT_HISTORY_PATH);
  }
  if (configuredPath.startsWith("/")) return configuredPath;
  return joinPath(baseDirectory, configuredPath);
}

async function handleEvent(
  rawEvent: unknown,
  input: PluginInput,
  storage: HistoryStorage,
  active: Map<string, ActiveState>,
  completedMessageIDs: Set<string>,
  bytesPerToken: number,
): Promise<void> {
  try {
    const event = asRecord(rawEvent);
    if (!event) return;
    const type = typeof event.type === "string" ? event.type : "";
    const properties = asRecord(event.properties) ?? asRecord(event.data) ?? {};
    const timestamp = eventTimestamp(event, properties);

    if (type === "message.part.delta") {
      recordDelta(active, properties, event, timestamp, "legacy", bytesPerToken);
      return;
    }
    if (type === "session.next.text.delta" || type === "session.next.reasoning.delta") {
      recordDelta(
        active,
        properties,
        event,
        timestamp,
        "v2",
        bytesPerToken,
        type.endsWith("reasoning.delta") ? "reasoning" : "output",
      );
      return;
    }
    if (type === "message.updated") {
      await handleMessageUpdated(
        input,
        storage,
        active,
        completedMessageIDs,
        event,
        properties,
        timestamp,
        bytesPerToken,
      );
      return;
    }
    if (type === "session.next.step.ended") {
      recordStepFallback(active, properties, event, timestamp);
      return;
    }
    if (isIdleEvent(type, properties)) {
      await flushIdleStates(input, storage, active, properties, event, timestamp, bytesPerToken);
    }
  } catch (error) {
    warn("event parsing failed", error);
  }
}

function recordDelta(
  active: Map<string, ActiveState>,
  properties: AnyRecord,
  event: AnyRecord,
  timestamp: number,
  stream: "legacy" | "v2",
  bytesPerToken: number,
  explicitKind?: "output" | "reasoning",
): void {
  const sessionID = readString(properties, event, [
    "sessionID",
    "sessionId",
    "session.id",
  ]);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const delta = readDelta(properties, event);
  if (!delta) return;
  const kind = explicitKind ?? inferKind(properties, event);
  const key = messageID ?? pendingKey(sessionID);
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  if (state.sessionID !== sessionID) return;
  if (timestamp < state.startedAt) state.startedAt = timestamp;
  if (state.firstTokenAt === undefined) state.firstTokenAt = timestamp;
  const bytes = utf8ByteLength(delta);
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  const sample: SpeedSample = {
    timestamp,
    tokens: estimatedTokens,
    estimatedTokens,
    bytes,
    kind,
  };
  state[stream].hasData = true;
  state[stream].samples.push(sample);
  active.set(messageID ?? key, state);
}

function recordStepFallback(
  active: Map<string, ActiveState>,
  properties: AnyRecord,
  event: AnyRecord,
  timestamp: number,
): void {
  const sessionID = readString(properties, event, ["sessionID", "sessionId"]);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  const info = eventInfo(properties, event);
  const tokens = tokenFields(info?.tokens ?? properties.tokens ?? properties);
  state.fallbackTokens = { ...state.fallbackTokens, ...tokens };
  state.model = state.model ?? modelName(info);
  if (state.cost === undefined) state.cost = numberOrUndefined(info?.cost ?? properties.cost);
  active.set(messageID ?? pendingKey(sessionID), state);
}

async function handleMessageUpdated(
  input: PluginInput,
  storage: HistoryStorage,
  active: Map<string, ActiveState>,
  completedMessageIDs: Set<string>,
  event: AnyRecord,
  properties: AnyRecord,
  timestamp: number,
  bytesPerToken: number,
): Promise<void> {
  const info = eventInfo(properties, event);
  if (!info || info.role !== "assistant" || !isCompleted(info, properties, event)) return;
  const messageID = readMessageID(properties, info);
  const sessionID = readStringFrom([info, properties, event], ["sessionID", "sessionId"]);
  if (!messageID || !sessionID) return;
  if (completedMessageIDs.has(messageID)) {
    active.delete(messageID);
    return;
  }

  const state = takeState(active, messageID, sessionID, timestamp);
  const exactTokens = tokenFields(info.tokens);
  const fallback = state?.fallbackTokens ?? {};
  const estimate = estimateStateTokens(state, bytesPerToken);
  const tokens: TokenCounts = {
    input: exactOrFallback(exactTokens.input, fallback.input, estimate.input),
    output: exactOrFallback(exactTokens.output, fallback.output, estimate.output),
    reasoning: exactOrFallback(exactTokens.reasoning, fallback.reasoning, estimate.reasoning),
    cacheRead: exactOrFallback(exactTokens.cacheRead, fallback.cacheRead, 0),
    cacheWrite: exactOrFallback(exactTokens.cacheWrite, fallback.cacheWrite, 0),
  };
  const candidateSamples = chooseSamples(state);
  const samples = calibrateResponseSamples(candidateSamples, {
    output: tokens.output,
    reasoning: tokens.reasoning,
  });
  const parentSessionID = await resolveParentSessionID(input, sessionID, info);
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
  });
  if (await safeUpsert(storage, record)) completedMessageIDs.add(messageID);
  else if (state) active.set(messageID, state);
}

async function flushIdleStates(
  input: PluginInput,
  storage: HistoryStorage,
  active: Map<string, ActiveState>,
  properties: AnyRecord,
  event: AnyRecord,
  timestamp: number,
  bytesPerToken: number,
): Promise<void> {
  const sessionID = readString(properties, event, ["sessionID", "sessionId"]);
  if (!sessionID) return;
  const entries = [...active.entries()].filter(([, state]) => state.sessionID === sessionID);
  for (const [key, state] of entries) {
    active.delete(key);
    if (state.messageID.startsWith("__pending__:")) continue;
    const estimate = estimateStateTokens(state, bytesPerToken);
    const tokens: TokenCounts = {
      input: state.fallbackTokens.input ?? estimate.input,
      output: state.fallbackTokens.output ?? estimate.output,
      reasoning: state.fallbackTokens.reasoning ?? estimate.reasoning,
      cacheRead: state.fallbackTokens.cacheRead ?? 0,
      cacheWrite: state.fallbackTokens.cacheWrite ?? 0,
    };
    const parentSessionID = await resolveParentSessionID(input, sessionID, undefined);
    const record = makeHistoryRecord({
      messageID: state.messageID,
      sessionID,
      parentSessionID,
      model: state.model,
      cost: state.cost ?? 0,
      tokens,
      samples: calibrateResponseSamples(chooseSamples(state), {
        output: tokens.output,
        reasoning: tokens.reasoning,
      }),
      state,
      info: undefined,
      completedAt: timestamp,
    });
    await safeUpsert(storage, record);
  }
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
  info?: AnyRecord;
  completedAt: number;
}): HistoryRecord {
  const infoTime = asRecord(input.info?.time) ?? {};
  const start = numberOrUndefined(infoTime.start)
    ?? numberOrUndefined(infoTime.created)
    ?? input.state?.startedAt
    ?? input.completedAt;
  const firstToken = numberOrUndefined(infoTime.firstToken)
    ?? numberOrUndefined(infoTime.firstTokenAt)
    ?? input.state?.firstTokenAt;
  const completed = numberOrUndefined(infoTime.end)
    ?? numberOrUndefined(infoTime.completed)
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
    cost: Math.max(0, numberOrUndefined(input.cost) ?? 0),
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

function chooseSamples(state: ActiveState | undefined): SpeedSample[] {
  if (!state) return [];
  return state.v2.hasData ? [...state.v2.samples] : [...state.legacy.samples];
}

function estimateStateTokens(state: ActiveState | undefined, bytesPerToken: number): TokenCounts {
  const samples = chooseSamples(state);
  const result = emptyTokenCounts();
  for (const sample of samples) {
    const tokens = sample.estimatedTokens ?? sample.tokens;
    if (sample.kind === "reasoning") result.reasoning += tokens;
    else result.output += tokens;
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

function takeState(
  active: Map<string, ActiveState>,
  messageID: string,
  sessionID: string,
  timestamp: number,
): ActiveState | undefined {
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

function getOrCreateState(
  active: Map<string, ActiveState>,
  messageID: string | undefined,
  sessionID: string,
  timestamp: number,
): ActiveState {
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

function mergeStates(target: ActiveState, source: ActiveState): void {
  target.startedAt = Math.min(target.startedAt, source.startedAt);
  if (target.firstTokenAt === undefined || (source.firstTokenAt !== undefined && source.firstTokenAt < target.firstTokenAt)) {
    target.firstTokenAt = source.firstTokenAt;
  }
  target.model = target.model ?? source.model;
  target.cost = target.cost ?? source.cost;
  target.fallbackTokens = { ...source.fallbackTokens, ...target.fallbackTokens };
  target.legacy.hasData ||= source.legacy.hasData;
  target.legacy.samples.push(...source.legacy.samples);
  target.v2.hasData ||= source.v2.hasData;
  target.v2.samples.push(...source.v2.samples);
  target.legacy.samples.sort((left, right) => left.timestamp - right.timestamp);
  target.v2.samples.sort((left, right) => left.timestamp - right.timestamp);
}

function createState(messageID: string, sessionID: string, timestamp: number): ActiveState {
  return {
    messageID,
    sessionID,
    startedAt: timestamp,
    fallbackTokens: {},
    legacy: { hasData: false, samples: [] },
    v2: { hasData: false, samples: [] },
  };
}

function eventInfo(properties: AnyRecord, event: AnyRecord): AnyRecord | undefined {
  return asRecord(properties.info)
    ?? asRecord(properties.message)
    ?? asRecord(event.info)
    ?? (properties.role ? properties : undefined);
}

function tokenFields(value: unknown): Partial<TokenCounts> {
  if (!isRecord(value)) return {};
  const normalized = normalizeTokenCounts(value);
  const fields: Partial<TokenCounts> = {};
  if (hasNumber(value.input)) fields.input = normalized.input;
  if (hasNumber(value.output)) fields.output = normalized.output;
  if (hasNumber(value.reasoning)) fields.reasoning = normalized.reasoning;
  if (hasNumber(value.cacheRead) || (isRecord(value.cache) && hasNumber(value.cache.read))) {
    fields.cacheRead = normalized.cacheRead;
  }
  if (hasNumber(value.cacheWrite) || (isRecord(value.cache) && hasNumber(value.cache.write))) {
    fields.cacheWrite = normalized.cacheWrite;
  }
  return fields;
}

function exactOrFallback(exact: number | undefined, fallback: number | undefined, estimate: number): number {
  return exact ?? fallback ?? Math.max(0, Math.round(estimate));
}

function isCompleted(info: AnyRecord, properties: AnyRecord, event: AnyRecord): boolean {
  const values = [info.completed, properties.completed, event.completed];
  if (values.some((value) => value === true || value === "completed")) return true;
  const status = info.status ?? properties.status ?? event.status;
  if (status === "completed" || (isRecord(status) && status.type === "completed")) return true;
  const time = asRecord(info.time);
  return numberOrUndefined(time?.end) !== undefined || numberOrUndefined(time?.completed) !== undefined;
}

function isIdleEvent(type: string, properties: AnyRecord): boolean {
  if (type === "session.idle") return true;
  if (type !== "session.status" && !type.endsWith(".status")) return false;
  const status = properties.status;
  return status === "idle"
    || (isRecord(status) && (status.type === "idle" || status.status === "idle"));
}

async function resolveParentSessionID(
  input: PluginInput,
  sessionID: string,
  info: AnyRecord | undefined,
): Promise<string | undefined> {
  const client = (input as AnyRecord).client as AnyRecord | undefined;
  const get = client?.session?.get;
  const sessionClient = client?.session;
  if (typeof get === "function" && sessionClient) {
    try {
      const response = await get.call(sessionClient, { path: { id: sessionID } });
      const session = asRecord(response?.data) ?? asRecord(response);
      const parent = readStringFrom([session], ["parentID", "parentSessionID"]);
      if (parent) return parent;
    } catch {
      // Parent lookup is supplemental and must never block a completed response.
    }
  }
  return readStringFrom([info], ["parentSessionID"]);
}

async function safeUpsert(storage: HistoryStorage, record: HistoryRecord): Promise<boolean> {
  try {
    await storage.upsert(record);
    return true;
  } catch (error) {
    warn("history write failed", error);
    return false;
  }
}

function resolveOptions(candidate: unknown): ServerOptions {
  if (!isRecord(candidate)) return {};
  return {
    historyPath: typeof candidate.historyPath === "string" ? candidate.historyPath : undefined,
    maxRecords: numberOrUndefined(candidate.maxRecords),
    bytesPerToken: numberOrUndefined(candidate.bytesPerToken),
  };
}

function validBytesPerToken(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 5.5;
}

function readMessageID(...sources: AnyRecord[]): string | undefined {
  return readStringFrom(sources, [
    "messageID",
    "messageId",
    "assistantMessageID",
    "assistantMessageId",
    "id",
    "message.id",
    "part.messageID",
  ]);
}

function readDelta(properties: AnyRecord, event: AnyRecord): string | undefined {
  const values = [
    properties.delta,
    properties.text,
    properties.content,
    properties.part?.delta,
    properties.part?.text,
    event.delta,
    event.text,
  ];
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function inferKind(properties: AnyRecord, event: AnyRecord): "output" | "reasoning" {
  const values = [
    properties.kind,
    properties.type,
    properties.field,
    properties.part?.type,
    event.kind,
    event.type,
  ];
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes("reason"))
    ? "reasoning"
    : "output";
}

function modelName(info: AnyRecord | undefined): string | undefined {
  if (!info) return undefined;
  if (typeof info.model === "string") return info.model;
  if (isRecord(info.model)) {
    return readStringFrom([info.model], ["modelID", "id", "name"]);
  }
  return readStringFrom([info], ["modelID", "modelId"]);
}

function eventTimestamp(event: AnyRecord, properties: AnyRecord): number {
  return numberOrUndefined(event.timestamp)
    ?? numberOrUndefined(properties.timestamp)
    ?? Date.now();
}

function readString(source: AnyRecord, fallback: AnyRecord, keys: string[]): string | undefined {
  return readStringFrom([source, fallback], keys);
}

function readStringFrom(sources: Array<AnyRecord | undefined>, keys: string[]): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = getPath(source, key);
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function getPath(source: AnyRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (
    isRecord(value) ? value[key] : undefined
  ), source);
}

function pendingKey(sessionID: string): string {
  return `__pending__:${sessionID}`;
}

function joinPath(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasNumber(value: unknown): value is number {
  return numberOrUndefined(value) !== undefined;
}

function warn(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : undefined;
  if (detail) console.warn(`[oc-tps] ${message}: ${detail}`);
  else console.warn(`[oc-tps] ${message}`);
}

function asRecord(value: unknown): AnyRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

const plugin: PluginModule = { id: "oc-tps", server };

export default plugin;
