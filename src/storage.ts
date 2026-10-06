import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import {
  HISTORY_VERSION,
  HistoryRecord,
  SpeedSample,
  TokenCounts,
} from "./core.js";
import { coerceCompletionUpdate, coerceSpeedContribution, isNewerCompletionUpdate, type MeasuredHistoryRecord } from './statistics.js';

export const DEFAULT_MAX_RECORDS = 1000;

/** Persist this marker: normalization's zero is not an original timing fact. */
export type StoredResponseTiming = HistoryRecord["time"] & { startMissing?: true };
export function hasOriginalResponseTiming(record: HistoryRecord): boolean {
  const time = record.time as StoredResponseTiming;
  return time.startMissing !== true && Number.isFinite(time.start) && time.start >= 0
    && typeof time.completed === "number" && Number.isFinite(time.completed) && time.completed > time.start;
}

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
  const records = await readPrimaryHistoryFile(path);
  const orphanTemps = await findRecoverableTemps(path);
  if (orphanTemps.length === 0) return records;

  const recoveredPaths: string[] = [];
  const recoveredRecords: HistoryRecord[] = [];
  for (const orphan of orphanTemps) {
    try {
      const content = await readFile(orphan.path, "utf8");
      recoveredPaths.push(orphan.path);
      recoveredRecords.push(...parseHistoryJsonl(content));
    } catch (error) {
      // Leave unreadable files for a later attempt. A temp-file problem must
      // not make an otherwise readable history unavailable.
      if (!isNodeError(error) || error.code !== "ENOENT") continue;
    }
  }

  if (recoveredPaths.length === 0) return records;
  const merged = mergeHistoryRecords(records, recoveredRecords);
  if (recoveredRecords.length > 0) await writeHistoryFile(path, merged);
  await Promise.all(recoveredPaths.map((tempPath) => rm(tempPath, { force: true })));
  return merged;
}

export function mergeHistoryRecords(
  mainRecords: readonly HistoryRecord[],
  recoveredRecords: readonly HistoryRecord[],
): HistoryRecord[] {
  const byMessage = new Map<string, HistoryRecord>();
  for (const record of [...mainRecords, ...recoveredRecords]) {
    const normalized = normalizeHistoryRecord(record);
    if (!normalized) continue;
    const existing = byMessage.get(normalized.messageID);
    if (!existing || isPreferredRecord(normalized, existing)) {
      byMessage.set(normalized.messageID, normalized);
    }
  }
  return [...byMessage.values()];
}

async function readPrimaryHistoryFile(path: string): Promise<HistoryRecord[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseHistoryJsonl(content);
}

async function findRecoverableTemps(path: string): Promise<OrphanTemp[]> {
  const directory = dirname(path);
  const pattern = new RegExp(`^\\.${escapeRegExp(basename(path))}\\.(\\d+)\\.(\\d+)\\.([^./]+)\\.tmp$`);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = pattern.exec(entry.name);
      if (!match) return undefined;
      const pid = Number(match[1]);
      const timestamp = Number(match[2]);
      if (!isExitedProcess(pid) || !Number.isFinite(timestamp)) return undefined;
      return {
        path: join(directory, entry.name),
        pid,
        timestamp,
      };
    })
    .filter((temp): temp is OrphanTemp => temp !== undefined)
    .sort((left, right) => left.timestamp - right.timestamp || left.path.localeCompare(right.path));
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
      if (record) {
        const existing = byMessage.get(record.messageID);
        if (!existing || isPreferredRecord(record, existing)) {
          byMessage.set(record.messageID, record);
        }
      }
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
    if (!normalized) continue;
    const existing = unique.get(normalized.messageID);
    if (!existing || isPreferredRecord(normalized, existing)) {
      unique.set(normalized.messageID, normalized);
    }
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
  const quality = value.quality === "provisional" || value.quality === "exact"
    ? value.quality
    : undefined;
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
    ...(quality ? { quality } : {}),
    ...(coerceSpeedContribution(value.speed) ? { speed: coerceSpeedContribution(value.speed) } : {}),
    ...(coerceCompletionUpdate(value.update) ? { update: coerceCompletionUpdate(value.update) } : {}),
  };
}

function upsertRecord(records: readonly HistoryRecord[], record: HistoryRecord): HistoryRecord[] {
  const normalized = normalizeHistoryRecord(record);
  if (!normalized) throw new TypeError("Invalid history record");
  const existing = records.find((entry) => entry.messageID === normalized.messageID);
  const chosen = existing && !isPreferredRecord(normalized, existing) ? existing : normalized;
  const result = records.filter((entry) => entry.messageID !== normalized.messageID);
  result.push(chosen);
  return result;
}

function isPreferredRecord(candidate: HistoryRecord, existing: HistoryRecord): boolean {
  const candidateQuality = candidate.quality ?? "exact";
  const existingQuality = existing.quality ?? "exact";
  const nextUpdate = (candidate as MeasuredHistoryRecord).update;
  const priorUpdate = (existing as MeasuredHistoryRecord).update;
  if (nextUpdate) {
    if (!isNewerCompletionUpdate(nextUpdate, priorUpdate)) return false;
    return candidateQuality === "exact" || existingQuality !== "exact";
  }
  if (priorUpdate && candidateQuality === existingQuality) return false;
  if (candidateQuality !== existingQuality) return candidateQuality === "exact";
  const candidateCompleteness = recordCompleteness(candidate);
  const existingCompleteness = recordCompleteness(existing);
  if (candidateCompleteness !== existingCompleteness) {
    return candidateCompleteness > existingCompleteness;
  }

  const candidateFreshness = recordFreshness(candidate);
  const existingFreshness = recordFreshness(existing);
  if (candidateFreshness !== existingFreshness) return candidateFreshness > existingFreshness;

  // The later source wins an otherwise identical tie. Recovered files are
  // processed after the primary file and in filename timestamp order.
  return true;
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

interface OrphanTemp {
  path: string;
  pid: number;
  timestamp: number;
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
    ...(source.startMissing === true || finiteNumberOrUndefined(source.start) === undefined ? { startMissing: true as const } : {}),
    ...(finiteNumberOrUndefined(source.firstResponse) !== undefined ? { firstResponse: source.firstResponse } : {}),
    ...(finiteNumberOrUndefined(source.firstContent) !== undefined ? { firstContent: source.firstContent } : {}),
    ...(["thinking", "content"].includes(source.firstResponseSource) ? { firstResponseSource: source.firstResponseSource } : {}),
    ...(["part-start", "arrival"].includes(source.firstResponseTimeSource) ? { firstResponseTimeSource: source.firstResponseTimeSource } : {}),
    ...(typeof source.firstResponseEstimated === "boolean" ? { firstResponseEstimated: source.firstResponseEstimated } : {}),
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

function isExitedProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
