import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { HISTORY_VERSION } from "./core.js";
export const DEFAULT_MAX_RECORDS = 1000;
export function createHistoryStorage(pathOrOptions, options = {}) {
  const settings = typeof pathOrOptions === "string" ? {
    path: pathOrOptions,
    ...options
  } : pathOrOptions;
  const path = settings.path;
  const maxRecords = normalizeMaxRecords(settings.maxRecords);
  let queue = Promise.resolve();
  const enqueue = operation => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const read = () => enqueue(async () => {
    const records = await readHistoryFile(path);
    return records.slice(-maxRecords);
  });
  return {
    append: record => enqueue(async () => {
      const records = await readHistoryFile(path);
      const next = upsertRecord(records, record);
      await writeHistoryFile(path, next.slice(-maxRecords));
    }),
    upsert: record => enqueue(async () => {
      const records = await readHistoryFile(path);
      const next = upsertRecord(records, record);
      await writeHistoryFile(path, next.slice(-maxRecords));
    }),
    read,
    clear: () => enqueue(async () => {
      try {
        await rm(path, {
          force: true
        });
      } catch {
        // A missing or concurrently removed history file is already clear.
      }
    }),
    prune: () => enqueue(async () => {
      const records = (await readHistoryFile(path)).slice(-maxRecords);
      await writeHistoryFile(path, records);
      return records;
    })
  };
}
export async function readHistoryFile(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseHistoryJsonl(content);
}
export async function writeHistoryFile(path, records) {
  const directory = dirname(path);
  await mkdir(directory, {
    recursive: true
  });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(temporaryPath, serializeHistoryJsonl(records), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, {
      force: true
    }).catch(() => undefined);
    throw error;
  }
}
export function parseHistoryJsonl(content) {
  const byMessage = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const record = normalizeHistoryRecord(parsed);
      if (record) byMessage.set(record.messageID, record);
    } catch {
      // Keep valid records when one line was truncated or otherwise corrupt.
    }
  }
  return [...byMessage.values()];
}
export function serializeHistoryJsonl(records) {
  const unique = new Map();
  for (const record of records) {
    const normalized = normalizeHistoryRecord(record);
    if (normalized) unique.set(normalized.messageID, normalized);
  }
  if (unique.size === 0) return "";
  return `${[...unique.values()].map(record => JSON.stringify(record)).join("\n")}\n`;
}
export function normalizeHistoryRecord(value) {
  if (!isRecord(value)) return undefined;
  if (value.version !== undefined && value.version !== HISTORY_VERSION) return undefined;
  if (typeof value.messageID !== "string" || value.messageID.length === 0) return undefined;
  if (typeof value.sessionID !== "string" || value.sessionID.length === 0) return undefined;
  const tokens = normalizeTokens(value.tokens);
  const time = normalizeTime(value.time);
  const samples = Array.isArray(value.samples) ? value.samples.map(normalizeSample).filter(sample => sample !== undefined) : [];
  return {
    version: HISTORY_VERSION,
    messageID: value.messageID,
    sessionID: value.sessionID,
    ...(typeof value.parentSessionID === "string" && value.parentSessionID.length > 0 ? {
      parentSessionID: value.parentSessionID
    } : {}),
    ...(typeof value.model === "string" && value.model.length > 0 ? {
      model: value.model
    } : {}),
    tokens,
    cost: nonNegativeNumber(value.cost),
    time,
    samples
  };
}
function upsertRecord(records, record) {
  const normalized = normalizeHistoryRecord(record);
  if (!normalized) throw new TypeError("Invalid history record");
  const result = records.filter(entry => entry.messageID !== normalized.messageID);
  result.push(normalized);
  return result;
}
function normalizeTokens(value) {
  const source = isRecord(value) ? value : {};
  const cache = isRecord(source.cache) ? source.cache : {};
  return {
    input: nonNegativeNumber(source.input),
    output: nonNegativeNumber(source.output),
    reasoning: nonNegativeNumber(source.reasoning),
    cacheRead: nonNegativeNumber(source.cacheRead ?? cache.read),
    cacheWrite: nonNegativeNumber(source.cacheWrite ?? cache.write)
  };
}
function normalizeTime(value) {
  const source = isRecord(value) ? value : {};
  return {
    start: finiteNumber(source.start, 0),
    ...(finiteNumberOrUndefined(source.firstToken) !== undefined ? {
      firstToken: finiteNumberOrUndefined(source.firstToken)
    } : {}),
    ...(finiteNumberOrUndefined(source.completed) !== undefined ? {
      completed: finiteNumberOrUndefined(source.completed)
    } : {}),
    ...(finiteNumberOrUndefined(source.ttft) !== undefined ? {
      ttft: finiteNumberOrUndefined(source.ttft)
    } : {}),
    ...(finiteNumberOrUndefined(source.duration) !== undefined ? {
      duration: finiteNumberOrUndefined(source.duration)
    } : {})
  };
}
function normalizeSample(value) {
  if (!isRecord(value)) return undefined;
  const timestamp = finiteNumberOrUndefined(value.timestamp);
  const tokens = finiteNumberOrUndefined(value.tokens);
  if (timestamp === undefined || tokens === undefined) return undefined;
  const kind = value.kind === "output" || value.kind === "reasoning" ? value.kind : undefined;
  return {
    timestamp,
    tokens: Math.max(0, tokens),
    ...(finiteNumberOrUndefined(value.estimatedTokens) !== undefined ? {
      estimatedTokens: Math.max(0, finiteNumberOrUndefined(value.estimatedTokens))
    } : {}),
    ...(finiteNumberOrUndefined(value.bytes) !== undefined ? {
      bytes: Math.max(0, finiteNumberOrUndefined(value.bytes))
    } : {}),
    ...(kind ? {
      kind
    } : {})
  };
}
function normalizeMaxRecords(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_RECORDS;
  return Math.max(1, Math.floor(value));
}
function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function finiteNumberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function nonNegativeNumber(value) {
  return Math.max(0, finiteNumber(value, 0));
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isNodeError(value) {
  return value instanceof Error || isRecord(value);
}
