import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import {
  HISTORY_VERSION,
  HistoryRecord,
  SpeedSample,
  TokenCounts,
} from "./core.js";

export const DEFAULT_MAX_RECORDS = 1000;

export interface HistoryStorageOptions {
  path: string;
  maxRecords?: number;
}

export interface HistoryStorage {
  append(record: HistoryRecord): Promise<void>;
  upsert(record: HistoryRecord): Promise<void>;
  read(): Promise<HistoryRecord[]>;
  clear(): Promise<void>;
  prune(): Promise<HistoryRecord[]>;
}

export function createHistoryStorage(
  pathOrOptions: string | HistoryStorageOptions,
  options: Omit<HistoryStorageOptions, "path"> = {},
): HistoryStorage {
  const settings = typeof pathOrOptions === "string"
    ? { path: pathOrOptions, ...options }
    : pathOrOptions;
  const path = settings.path;
  const maxRecords = normalizeMaxRecords(settings.maxRecords);
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const read = () => enqueue(async () => {
    const records = await readHistoryFile(path);
    return records.slice(-maxRecords);
  });

  return {
    append: (record) => enqueue(async () => {
      const records = await readHistoryFile(path);
      const next = upsertRecord(records, record);
      await writeHistoryFile(path, next.slice(-maxRecords));
    }),
    upsert: (record) => enqueue(async () => {
      const records = await readHistoryFile(path);
      const next = upsertRecord(records, record);
      await writeHistoryFile(path, next.slice(-maxRecords));
    }),
    read,
    clear: () => enqueue(async () => {
      try {
        await rm(path, { force: true });
      } catch {
        // A missing or concurrently removed history file is already clear.
      }
    }),
    prune: () => enqueue(async () => {
      const records = (await readHistoryFile(path)).slice(-maxRecords);
      await writeHistoryFile(path, records);
      return records;
    }),
  };
}

export async function readHistoryFile(path: string): Promise<HistoryRecord[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseHistoryJsonl(content);
}

export async function writeHistoryFile(
  path: string,
  records: readonly HistoryRecord[],
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serializeHistoryJsonl(records), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseHistoryJsonl(content: string): HistoryRecord[] {
  const byMessage = new Map<string, HistoryRecord>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const record = normalizeHistoryRecord(parsed);
      if (record) byMessage.set(record.messageID, record);
    } catch {
      // Keep valid records when one line was truncated or otherwise corrupt.
    }
  }
  return [...byMessage.values()];
}

export function serializeHistoryJsonl(records: readonly HistoryRecord[]): string {
  const unique = new Map<string, HistoryRecord>();
  for (const record of records) {
    const normalized = normalizeHistoryRecord(record);
    if (normalized) unique.set(normalized.messageID, normalized);
  }
  if (unique.size === 0) return "";
  return `${[...unique.values()].map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function normalizeHistoryRecord(value: unknown): HistoryRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== undefined && value.version !== HISTORY_VERSION) return undefined;
  if (typeof value.messageID !== "string" || value.messageID.length === 0) return undefined;
  if (typeof value.sessionID !== "string" || value.sessionID.length === 0) return undefined;
  const tokens = normalizeTokens(value.tokens);
  const time = normalizeTime(value.time);
  const samples = Array.isArray(value.samples)
    ? value.samples.map(normalizeSample).filter((sample): sample is SpeedSample => sample !== undefined)
    : [];
  return {
    version: HISTORY_VERSION,
    messageID: value.messageID,
    sessionID: value.sessionID,
    ...(typeof value.parentSessionID === "string" && value.parentSessionID.length > 0
      ? { parentSessionID: value.parentSessionID }
      : {}),
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    tokens,
    cost: nonNegativeNumber(value.cost),
    time,
    samples,
  };
}

function upsertRecord(records: readonly HistoryRecord[], record: HistoryRecord): HistoryRecord[] {
  const normalized = normalizeHistoryRecord(record);
  if (!normalized) throw new TypeError("Invalid history record");
  const result = records.filter((entry) => entry.messageID !== normalized.messageID);
  result.push(normalized);
  return result;
}

function normalizeTokens(value: unknown): TokenCounts {
  const source = isRecord(value) ? value : {};
  const cache = isRecord(source.cache) ? source.cache : {};
  return {
    input: nonNegativeNumber(source.input),
    output: nonNegativeNumber(source.output),
    reasoning: nonNegativeNumber(source.reasoning),
    cacheRead: nonNegativeNumber(source.cacheRead ?? cache.read),
    cacheWrite: nonNegativeNumber(source.cacheWrite ?? cache.write),
  };
}

function normalizeTime(value: unknown): HistoryRecord["time"] {
  const source = isRecord(value) ? value : {};
  return {
    start: finiteNumber(source.start, 0),
    ...(finiteNumberOrUndefined(source.firstToken) !== undefined
      ? { firstToken: finiteNumberOrUndefined(source.firstToken) }
      : {}),
    ...(finiteNumberOrUndefined(source.completed) !== undefined
      ? { completed: finiteNumberOrUndefined(source.completed) }
      : {}),
    ...(finiteNumberOrUndefined(source.ttft) !== undefined
      ? { ttft: finiteNumberOrUndefined(source.ttft) }
      : {}),
    ...(finiteNumberOrUndefined(source.duration) !== undefined
      ? { duration: finiteNumberOrUndefined(source.duration) }
      : {}),
  };
}

function normalizeSample(value: unknown): SpeedSample | undefined {
  if (!isRecord(value)) return undefined;
  const timestamp = finiteNumberOrUndefined(value.timestamp);
  const tokens = finiteNumberOrUndefined(value.tokens);
  if (timestamp === undefined || tokens === undefined) return undefined;
  const kind = value.kind === "output" || value.kind === "reasoning" ? value.kind : undefined;
  return {
    timestamp,
    tokens: Math.max(0, tokens),
    ...(finiteNumberOrUndefined(value.estimatedTokens) !== undefined
      ? { estimatedTokens: Math.max(0, finiteNumberOrUndefined(value.estimatedTokens) as number) }
      : {}),
    ...(finiteNumberOrUndefined(value.bytes) !== undefined
      ? { bytes: Math.max(0, finiteNumberOrUndefined(value.bytes) as number) }
      : {}),
    ...(kind ? { kind } : {}),
  };
}

function normalizeMaxRecords(value: number | undefined): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return DEFAULT_MAX_RECORDS;
  return Math.max(1, Math.floor(value as number));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, finiteNumber(value, 0));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error || isRecord(value);
}
