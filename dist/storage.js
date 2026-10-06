import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { HISTORY_VERSION } from "./core.js";
import { coerceCompletionUpdate, coerceSpeedContribution, isNewerCompletionUpdate, mergeRecordSpeed } from './statistics.js';
export const DEFAULT_MAX_RECORDS = 1000;

/** Persist this marker: normalization's zero is not an original timing fact. */

export function hasOriginalResponseTiming(record) {
  const time = record.time;
  return time.startMissing !== true && Number.isFinite(time.start) && time.start >= 0 && typeof time.completed === "number" && Number.isFinite(time.completed) && time.completed > time.start;
}
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
  const records = await readPrimaryHistoryFile(path);
  const orphanTemps = await findRecoverableTemps(path);
  if (orphanTemps.length === 0) return records;
  const recoveredPaths = [];
  const recoveredRecords = [];
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
  await Promise.all(recoveredPaths.map(tempPath => rm(tempPath, {
    force: true
  })));
  return merged;
}
export function mergeHistoryRecords(mainRecords, recoveredRecords) {
  const byMessage = new Map();
  for (const record of [...mainRecords, ...recoveredRecords]) {
    const normalized = normalizeHistoryRecord(record);
    if (!normalized) continue;
    const existing = byMessage.get(normalized.messageID);
    if (!existing || isPreferredRecord(normalized, existing)) {
      byMessage.set(normalized.messageID, mergeAcceptedRecord(normalized, existing));
    }
  }
  return [...byMessage.values()];
}
async function readPrimaryHistoryFile(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseHistoryJsonl(content);
}
async function findRecoverableTemps(path) {
  const directory = dirname(path);
  const pattern = new RegExp(`^\\.${escapeRegExp(basename(path))}\\.(\\d+)\\.(\\d+)\\.([^./]+)\\.tmp$`);
  let entries;
  try {
    entries = await readdir(directory, {
      withFileTypes: true
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter(entry => entry.isFile()).map(entry => {
    const match = pattern.exec(entry.name);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const timestamp = Number(match[2]);
    if (!isExitedProcess(pid) || !Number.isFinite(timestamp)) return undefined;
    return {
      path: join(directory, entry.name),
      pid,
      timestamp
    };
  }).filter(temp => temp !== undefined).sort((left, right) => left.timestamp - right.timestamp || left.path.localeCompare(right.path));
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
      if (record) {
        const existing = byMessage.get(record.messageID);
        if (!existing || isPreferredRecord(record, existing)) {
          byMessage.set(record.messageID, mergeAcceptedRecord(record, existing));
        }
      }
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
    if (!normalized) continue;
    const existing = unique.get(normalized.messageID);
    if (!existing || isPreferredRecord(normalized, existing)) {
      unique.set(normalized.messageID, mergeAcceptedRecord(normalized, existing));
    }
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
  const quality = value.quality === "provisional" || value.quality === "exact" ? value.quality : undefined;
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
    samples,
    ...(quality ? {
      quality
    } : {}),
    // Keep explicit empty live snapshots: absence means unobserved, whereas an
    // empty server snapshot can revoke an earlier qualified measurement.
    ...(isRecord(value.speed) ? {
      speed: coerceSpeedContribution(value.speed) ?? {}
    } : {}),
    ...(coerceCompletionUpdate(value.update) ? {
      update: coerceCompletionUpdate(value.update)
    } : {})
  };
}
function upsertRecord(records, record) {
  const normalized = normalizeHistoryRecord(record);
  if (!normalized) throw new TypeError("Invalid history record");
  const existing = records.find(entry => entry.messageID === normalized.messageID);
  const chosen = existing && !isPreferredRecord(normalized, existing) ? existing : mergeAcceptedRecord(normalized, existing);
  const result = records.filter(entry => entry.messageID !== normalized.messageID);
  result.push(chosen);
  return result;
}

/** Usage corrections reuse only the shared module's qualified v3 evidence. */
function mergeAcceptedRecord(candidate, existing) {
  if (!existing) return candidate;
  const speed = coerceSpeedContribution(mergeRecordSpeed(candidate, existing, candidate.update && candidate.speed !== undefined && !candidate.speed.generation ? "invalidated" : "unobserved"));
  const merged = {
    ...candidate
  };
  if (speed) merged.speed = speed;else if (candidate.speed !== undefined) merged.speed = {};else delete merged.speed;
  return merged;
}
function isPreferredRecord(candidate, existing) {
  const candidateQuality = candidate.quality ?? "exact";
  const existingQuality = existing.quality ?? "exact";
  const nextUpdate = candidate.update;
  const priorUpdate = existing.update;
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
    ...(source.startMissing === true || finiteNumberOrUndefined(source.start) === undefined ? {
      startMissing: true
    } : {}),
    ...(finiteNumberOrUndefined(source.firstResponse) !== undefined ? {
      firstResponse: source.firstResponse
    } : {}),
    ...(finiteNumberOrUndefined(source.firstContent) !== undefined ? {
      firstContent: source.firstContent
    } : {}),
    ...(["thinking", "content"].includes(source.firstResponseSource) ? {
      firstResponseSource: source.firstResponseSource
    } : {}),
    ...(["part-start", "arrival"].includes(source.firstResponseTimeSource) ? {
      firstResponseTimeSource: source.firstResponseTimeSource
    } : {}),
    ...(typeof source.firstResponseEstimated === "boolean" ? {
      firstResponseEstimated: source.firstResponseEstimated
    } : {}),
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
function isExitedProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
