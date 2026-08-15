export const DEFAULT_BYTES_PER_TOKEN = 5.5;
export const DEFAULT_ROLLING_WINDOW_MS = 10_000;
export const HISTORY_VERSION = 1;
export function emptyTokenCounts() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0
  };
}
export function normalizeTokenCounts(value) {
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
export function addTokenCounts(left, right) {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite
  };
}
export function scaleTokenCounts(counts, factor) {
  const safeFactor = Number.isFinite(factor) && factor >= 0 ? factor : 0;
  return {
    input: counts.input * safeFactor,
    output: counts.output * safeFactor,
    reasoning: counts.reasoning * safeFactor,
    cacheRead: counts.cacheRead * safeFactor,
    cacheWrite: counts.cacheWrite * safeFactor
  };
}
export function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

/** Returns a fractional estimate so small deltas can be summed without rounding drift. */
export function bytesToTokens(bytes, bytesPerToken = DEFAULT_BYTES_PER_TOKEN) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) return 0;
  return bytes / bytesPerToken;
}
export const estimateTokensFromBytes = bytesToTokens;
export function createSpeedSample(bytes, timestamp = Date.now(), kind = "output", bytesPerToken = DEFAULT_BYTES_PER_TOKEN) {
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  return {
    timestamp: finiteNumber(timestamp, Date.now()),
    tokens: estimatedTokens,
    estimatedTokens,
    bytes: Math.max(0, finiteNumber(bytes, 0)),
    kind
  };
}
export function appendSpeedSample(samples, sample, windowMs = DEFAULT_ROLLING_WINDOW_MS) {
  const next = [...samples, sample].sort((left, right) => left.timestamp - right.timestamp);
  if (!Number.isFinite(windowMs) || windowMs <= 0 || next.length === 0) return next;
  const newest = next[next.length - 1].timestamp;
  const cutoff = newest - windowMs;
  return next.filter(entry => entry.timestamp >= cutoff);
}
export function rollingTokenRate(samples, now, windowMs = DEFAULT_ROLLING_WINDOW_MS) {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const referenceNow = now ?? ordered[ordered.length - 1].timestamp;
  if (!Number.isFinite(referenceNow) || !Number.isFinite(windowMs) || windowMs < 0) return 0;
  const cutoff = referenceNow - windowMs;
  const selected = ordered.filter(sample => sample.timestamp >= cutoff && sample.timestamp <= referenceNow);
  if (selected.length === 0) return 0;
  const totalTokens = selected.reduce((sum, sample) => sum + nonNegativeNumber(sample.tokens), 0);
  const first = selected[0].timestamp;
  const elapsed = referenceNow - first;
  if (elapsed <= 0) return 0;
  return totalTokens * 1000 / elapsed;
}
export const calculateRollingRate = rollingTokenRate;
export function calculateRateStats(values) {
  const valid = values.filter(value => Number.isFinite(value) && value >= 0);
  if (valid.length === 0) return {
    avg: 0,
    max: 0,
    min: 0
  };
  const total = valid.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / valid.length,
    max: Math.max(...valid),
    min: Math.min(...valid)
  };
}
export function calculateSpeedStats(samples) {
  if (samples.length < 2) return {
    avg: 0,
    max: 0,
    min: 0
  };
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const rates = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const elapsed = ordered[index].timestamp - ordered[index - 1].timestamp;
    if (elapsed <= 0) continue;
    const tokens = nonNegativeNumber(ordered[index].tokens);
    rates.push(tokens * 1000 / elapsed);
  }
  return calculateRateStats(rates);
}
export function timeToFirstToken(record) {
  if (typeof record.time.ttft !== "number" || !Number.isFinite(record.time.ttft)) {
    if (typeof record.time.firstToken !== "number" || !Number.isFinite(record.time.firstToken)) return undefined;
    if (!Number.isFinite(record.time.start)) return undefined;
    return Math.max(0, record.time.firstToken - record.time.start);
  }
  return Math.max(0, record.time.ttft);
}
export const calculateTTFT = timeToFirstToken;
export function durationOf(record) {
  if (Number.isFinite(record.time.duration)) return Math.max(0, record.time.duration);
  if (!Number.isFinite(record.time.completed) || !Number.isFinite(record.time.start)) return undefined;
  return Math.max(0, record.time.completed - record.time.start);
}
export function calculateTTFTStats(records) {
  return calculateRateStats(records.map(timeToFirstToken).filter(value => value !== undefined));
}
export function calculateResponseStats(records) {
  const speeds = records.map(record => {
    const duration = durationOf(record);
    if (duration === undefined || duration <= 0) return undefined;
    return record.tokens.output * 1000 / duration;
  }).filter(value => value !== undefined);
  const durations = records.map(durationOf).filter(value => value !== undefined);
  return {
    responses: records.length,
    speed: calculateRateStats(speeds),
    ttft: calculateTTFTStats(records),
    duration: calculateRateStats(durations)
  };
}

/**
 * Proportionally converts estimated samples to integer token samples. The
 * largest-remainder pass makes the calibrated sample sum exactly equal the
 * final token count.
 */
export function calibrateEstimatedOutput(samples, actualOutputTokens) {
  return calibrateSampleKind(samples, "output", actualOutputTokens);
}
export function calibrateResponseSamples(samples, actualTokens) {
  const hasOutput = samples.some(sample => sample.kind === "output");
  const hasReasoning = samples.some(sample => sample.kind === "reasoning");
  let result = [...samples];
  if (hasOutput) result = calibrateSampleKind(result, "output", actualTokens.output);else if (!hasReasoning) result = calibrateSampleKind(result, undefined, actualTokens.output);
  if (hasReasoning) result = calibrateSampleKind(result, "reasoning", actualTokens.reasoning);
  return result;
}
export function calibrationFactor(samples, actualOutputTokens, kind = "output") {
  const selected = selectSamples(samples, kind);
  const estimated = selected.reduce((sum, sample) => sum + nonNegativeNumber(sample.estimatedTokens ?? sample.tokens), 0);
  if (estimated <= 0) return 1;
  return Math.max(0, finiteNumber(actualOutputTokens, 0)) / estimated;
}
export function dedupeHistoryRecords(records) {
  const byMessage = new Map();
  for (const record of records) {
    if (!record || typeof record.messageID !== "string" || record.messageID.length === 0) continue;
    byMessage.set(record.messageID, record);
  }
  return [...byMessage.values()];
}
export function aggregateSessionTree(records, rootSessionID) {
  const uniqueRecords = dedupeHistoryRecords(records);
  const nodes = new Map();
  for (const record of uniqueRecords) {
    const node = nodes.get(record.sessionID) ?? createMutableSession(record.sessionID);
    if (!node.parentSessionID && record.parentSessionID) node.parentSessionID = record.parentSessionID;
    node.directTokens = addTokenCounts(node.directTokens, normalizeTokenCounts(record.tokens));
    node.directCost += nonNegativeNumber(record.cost);
    node.directResponseCount += 1;
    nodes.set(record.sessionID, node);
  }
  const roots = [];
  for (const node of nodes.values()) {
    if (!node.parentSessionID || !nodes.has(node.parentSessionID)) {
      roots.push(node);
      continue;
    }
    nodes.get(node.parentSessionID)?.children.push(node);
  }
  const materialize = (node, path) => {
    if (path.has(node.sessionID)) return materializeWithoutChildren(node);
    const nextPath = new Set(path).add(node.sessionID);
    const children = node.children.map(child => materialize(child, nextPath));
    let tokens = {
      ...node.directTokens
    };
    let cost = node.directCost;
    let responseCount = node.directResponseCount;
    for (const child of children) {
      tokens = addTokenCounts(tokens, child.tokens);
      cost += child.cost;
      responseCount += child.responseCount;
    }
    return {
      sessionID: node.sessionID,
      ...(node.parentSessionID ? {
        parentSessionID: node.parentSessionID
      } : {}),
      directTokens: {
        ...node.directTokens
      },
      directCost: node.directCost,
      directResponseCount: node.directResponseCount,
      tokens,
      cost,
      responseCount,
      children
    };
  };
  if (rootSessionID) {
    const requested = nodes.get(rootSessionID);
    return requested ? [materialize(requested, new Set())] : [];
  }
  return roots.map(root => materialize(root, new Set()));
}
export function aggregateSession(records, sessionID) {
  return aggregateSessionTree(records, sessionID)[0];
}
export function aggregateSessionsByID(records) {
  const roots = aggregateSessionTree(records);
  const result = new Map();
  const visit = node => {
    result.set(node.sessionID, node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return result;
}
export function formatNumber(value, maximumFractionDigits = 2) {
  const safeValue = finiteNumber(value, 0);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.max(0, maximumFractionDigits),
    useGrouping: true
  }).format(safeValue);
}
export function formatTokens(tokens) {
  return formatNumber(Math.round(Math.max(0, finiteNumber(tokens, 0))), 0);
}
export function formatDuration(milliseconds) {
  const value = Math.max(0, finiteNumber(milliseconds, 0));
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${trimDecimal(value / 1000)}s`;
  const totalSeconds = Math.floor(value / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
function calibrateSampleKind(samples, kind, actualTokens) {
  const selectedIndexes = samples.map((sample, index) => ({
    sample,
    index
  })).filter(({
    sample
  }) => kind === undefined || sample.kind === kind).map(({
    index
  }) => index);
  if (selectedIndexes.length === 0) return [...samples];
  const weights = selectedIndexes.map(index => nonNegativeNumber(samples[index].estimatedTokens ?? samples[index].tokens));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return [...samples];
  const target = Math.max(0, Math.round(finiteNumber(actualTokens, 0)));
  const exact = weights.map(weight => weight / totalWeight * target);
  const allocated = exact.map(Math.floor);
  let remainder = target - allocated.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({
    index,
    fraction: value - allocated[index]
  })).sort((left, right) => right.fraction - left.fraction);
  for (const item of order) {
    if (remainder <= 0) break;
    allocated[item.index] += 1;
    remainder -= 1;
  }
  const result = [...samples];
  selectedIndexes.forEach((sampleIndex, index) => {
    result[sampleIndex] = {
      ...result[sampleIndex],
      tokens: allocated[index]
    };
  });
  return result;
}
function selectSamples(samples, kind) {
  const selected = kind === undefined ? [...samples] : samples.filter(sample => sample.kind === kind);
  return selected.length > 0 ? selected : [...samples];
}
function createMutableSession(sessionID) {
  return {
    sessionID,
    directTokens: emptyTokenCounts(),
    directCost: 0,
    directResponseCount: 0,
    children: []
  };
}
function materializeWithoutChildren(node) {
  return {
    sessionID: node.sessionID,
    ...(node.parentSessionID ? {
      parentSessionID: node.parentSessionID
    } : {}),
    directTokens: {
      ...node.directTokens
    },
    directCost: node.directCost,
    directResponseCount: node.directResponseCount,
    tokens: {
      ...node.directTokens
    },
    cost: node.directCost,
    responseCount: node.directResponseCount,
    children: []
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function nonNegativeNumber(value) {
  return Math.max(0, finiteNumber(value, 0));
}
function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}
