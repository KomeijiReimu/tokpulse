export const DEFAULT_BYTES_PER_TOKEN = 5.5;
export const DEFAULT_ROLLING_WINDOW_MS = 10_000;
export const HISTORY_VERSION = 1;

export type SampleKind = "output" | "reasoning";

export interface TokenCounts {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SpeedSample {
  timestamp: number;
  tokens: number;
  estimatedTokens?: number;
  bytes?: number;
  kind?: SampleKind;
}

export interface ResponseTiming {
  start: number;
  firstToken?: number;
  completed?: number;
  ttft?: number;
  duration?: number;
}

export interface HistoryRecord {
  version: number;
  messageID: string;
  sessionID: string;
  parentSessionID?: string;
  model?: string;
  tokens: TokenCounts;
  cost: number;
  time: ResponseTiming;
  samples: SpeedSample[];
}

export interface RateStats {
  avg: number;
  max: number;
  min: number;
}

export interface ActiveResponse {
  messageID: string;
  sessionID: string;
  model?: string;
  startedAt: number;
  firstTokenAt?: number;
  estimatedOutputTokens: number;
  estimatedReasoningTokens: number;
  samples: SpeedSample[];
  tokens: TokenCounts;
  completed: boolean;
}

export interface LiveStats {
  sessionID?: string;
  active: boolean;
  model?: string;
  tokens: TokenCounts;
  speed: RateStats;
  ttft?: number;
  elapsedMs?: number;
  samples: SpeedSample[];
}

export interface SessionAggregate {
  sessionID: string;
  parentSessionID?: string;
  directTokens: TokenCounts;
  directCost: number;
  directResponseCount: number;
  tokens: TokenCounts;
  cost: number;
  responseCount: number;
  children: SessionAggregate[];
}

export interface ResponseStats {
  responses: number;
  speed: RateStats;
  ttft: RateStats;
  duration: RateStats;
}

export function emptyTokenCounts(): TokenCounts {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

export function normalizeTokenCounts(value: unknown): TokenCounts {
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

export function addTokenCounts(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

export function scaleTokenCounts(counts: TokenCounts, factor: number): TokenCounts {
  const safeFactor = Number.isFinite(factor) && factor >= 0 ? factor : 0;
  return {
    input: counts.input * safeFactor,
    output: counts.output * safeFactor,
    reasoning: counts.reasoning * safeFactor,
    cacheRead: counts.cacheRead * safeFactor,
    cacheWrite: counts.cacheWrite * safeFactor,
  };
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Returns a fractional estimate so small deltas can be summed without rounding drift. */
export function bytesToTokens(bytes: number, bytesPerToken = DEFAULT_BYTES_PER_TOKEN): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) return 0;
  return bytes / bytesPerToken;
}

export const estimateTokensFromBytes = bytesToTokens;

export function createSpeedSample(
  bytes: number,
  timestamp = Date.now(),
  kind: SampleKind = "output",
  bytesPerToken = DEFAULT_BYTES_PER_TOKEN,
): SpeedSample {
  const estimatedTokens = bytesToTokens(bytes, bytesPerToken);
  return {
    timestamp: finiteNumber(timestamp, Date.now()),
    tokens: estimatedTokens,
    estimatedTokens,
    bytes: Math.max(0, finiteNumber(bytes, 0)),
    kind,
  };
}

export function appendSpeedSample(
  samples: readonly SpeedSample[],
  sample: SpeedSample,
  windowMs = DEFAULT_ROLLING_WINDOW_MS,
): SpeedSample[] {
  const next = [...samples, sample].sort((left, right) => left.timestamp - right.timestamp);
  if (!Number.isFinite(windowMs) || windowMs <= 0 || next.length === 0) return next;
  const newest = next[next.length - 1].timestamp;
  const cutoff = newest - windowMs;
  return next.filter((entry) => entry.timestamp >= cutoff);
}

export function rollingTokenRate(
  samples: readonly SpeedSample[],
  now?: number,
  windowMs = DEFAULT_ROLLING_WINDOW_MS,
): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const referenceNow = now ?? ordered[ordered.length - 1].timestamp;
  if (!Number.isFinite(referenceNow) || !Number.isFinite(windowMs) || windowMs < 0) return 0;
  const cutoff = referenceNow - windowMs;
  const selected = ordered.filter((sample) => sample.timestamp >= cutoff && sample.timestamp <= referenceNow);
  if (selected.length === 0) return 0;
  const totalTokens = selected.reduce((sum, sample) => sum + nonNegativeNumber(sample.tokens), 0);
  const first = selected[0].timestamp;
  const elapsed = referenceNow - first;
  if (elapsed <= 0) return 0;
  return (totalTokens * 1000) / elapsed;
}

export const calculateRollingRate = rollingTokenRate;

export function calculateRateStats(values: readonly number[]): RateStats {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length === 0) return { avg: 0, max: 0, min: 0 };
  const total = valid.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / valid.length,
    max: Math.max(...valid),
    min: Math.min(...valid),
  };
}

export function calculateSpeedStats(samples: readonly SpeedSample[]): RateStats {
  if (samples.length < 2) return { avg: 0, max: 0, min: 0 };
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const rates: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const elapsed = ordered[index].timestamp - ordered[index - 1].timestamp;
    if (elapsed <= 0) continue;
    const tokens = nonNegativeNumber(ordered[index].tokens);
    rates.push((tokens * 1000) / elapsed);
  }
  return calculateRateStats(rates);
}

export function timeToFirstToken(record: Pick<HistoryRecord, "time">): number | undefined {
  if (typeof record.time.ttft !== "number" || !Number.isFinite(record.time.ttft)) {
    if (typeof record.time.firstToken !== "number" || !Number.isFinite(record.time.firstToken)) return undefined;
    if (!Number.isFinite(record.time.start)) return undefined;
    return Math.max(0, record.time.firstToken - record.time.start);
  }
  return Math.max(0, record.time.ttft);
}

export const calculateTTFT = timeToFirstToken;

export function durationOf(record: Pick<HistoryRecord, "time">): number | undefined {
  if (Number.isFinite(record.time.duration)) return Math.max(0, record.time.duration as number);
  if (!Number.isFinite(record.time.completed) || !Number.isFinite(record.time.start)) return undefined;
  return Math.max(0, (record.time.completed as number) - record.time.start);
}

export function calculateTTFTStats(records: readonly HistoryRecord[]): RateStats {
  return calculateRateStats(
    records.map(timeToFirstToken).filter((value): value is number => value !== undefined),
  );
}

export function calculateResponseStats(records: readonly HistoryRecord[]): ResponseStats {
  const speeds = records.map((record) => {
    const duration = durationOf(record);
    if (duration === undefined || duration <= 0) return undefined;
    return (record.tokens.output * 1000) / duration;
  }).filter((value): value is number => value !== undefined);
  const durations = records
    .map(durationOf)
    .filter((value): value is number => value !== undefined);
  return {
    responses: records.length,
    speed: calculateRateStats(speeds),
    ttft: calculateTTFTStats(records),
    duration: calculateRateStats(durations),
  };
}

/**
 * Proportionally converts estimated samples to integer token samples. The
 * largest-remainder pass makes the calibrated sample sum exactly equal the
 * final token count.
 */
export function calibrateEstimatedOutput(
  samples: readonly SpeedSample[],
  actualOutputTokens: number,
): SpeedSample[] {
  return calibrateSampleKind(samples, "output", actualOutputTokens);
}

export function calibrateResponseSamples(
  samples: readonly SpeedSample[],
  actualTokens: Pick<TokenCounts, "output" | "reasoning">,
): SpeedSample[] {
  const hasOutput = samples.some((sample) => sample.kind === "output");
  const hasReasoning = samples.some((sample) => sample.kind === "reasoning");
  let result = [...samples];
  if (hasOutput) result = calibrateSampleKind(result, "output", actualTokens.output);
  else if (!hasReasoning) result = calibrateSampleKind(result, undefined, actualTokens.output);
  if (hasReasoning) result = calibrateSampleKind(result, "reasoning", actualTokens.reasoning);
  return result;
}

export function calibrationFactor(
  samples: readonly SpeedSample[],
  actualOutputTokens: number,
  kind: SampleKind | undefined = "output",
): number {
  const selected = selectSamples(samples, kind);
  const estimated = selected.reduce(
    (sum, sample) => sum + nonNegativeNumber(sample.estimatedTokens ?? sample.tokens),
    0,
  );
  if (estimated <= 0) return 1;
  return Math.max(0, finiteNumber(actualOutputTokens, 0)) / estimated;
}

export function dedupeHistoryRecords(records: readonly HistoryRecord[]): HistoryRecord[] {
  const byMessage = new Map<string, HistoryRecord>();
  for (const record of records) {
    if (!record || typeof record.messageID !== "string" || record.messageID.length === 0) continue;
    byMessage.set(record.messageID, record);
  }
  return [...byMessage.values()];
}

export function aggregateSessionTree(
  records: readonly HistoryRecord[],
  rootSessionID?: string,
): SessionAggregate[] {
  const uniqueRecords = dedupeHistoryRecords(records);
  const nodes = new Map<string, MutableSessionAggregate>();

  for (const record of uniqueRecords) {
    const node = nodes.get(record.sessionID) ?? createMutableSession(record.sessionID);
    if (!node.parentSessionID && record.parentSessionID) node.parentSessionID = record.parentSessionID;
    node.directTokens = addTokenCounts(node.directTokens, normalizeTokenCounts(record.tokens));
    node.directCost += nonNegativeNumber(record.cost);
    node.directResponseCount += 1;
    nodes.set(record.sessionID, node);
  }

  const roots: MutableSessionAggregate[] = [];
  for (const node of nodes.values()) {
    if (!node.parentSessionID || !nodes.has(node.parentSessionID)) {
      roots.push(node);
      continue;
    }
    nodes.get(node.parentSessionID)?.children.push(node);
  }

  const materialize = (
    node: MutableSessionAggregate,
    path: Set<string>,
  ): SessionAggregate => {
    if (path.has(node.sessionID)) return materializeWithoutChildren(node);
    const nextPath = new Set(path).add(node.sessionID);
    const children = node.children.map((child) => materialize(child, nextPath));
    let tokens = { ...node.directTokens };
    let cost = node.directCost;
    let responseCount = node.directResponseCount;
    for (const child of children) {
      tokens = addTokenCounts(tokens, child.tokens);
      cost += child.cost;
      responseCount += child.responseCount;
    }
    return {
      sessionID: node.sessionID,
      ...(node.parentSessionID ? { parentSessionID: node.parentSessionID } : {}),
      directTokens: { ...node.directTokens },
      directCost: node.directCost,
      directResponseCount: node.directResponseCount,
      tokens,
      cost,
      responseCount,
      children,
    };
  };

  if (rootSessionID) {
    const requested = nodes.get(rootSessionID);
    return requested ? [materialize(requested, new Set())] : [];
  }
  return roots.map((root) => materialize(root, new Set()));
}

export function aggregateSession(
  records: readonly HistoryRecord[],
  sessionID: string,
): SessionAggregate | undefined {
  return aggregateSessionTree(records, sessionID)[0];
}

export function aggregateSessionsByID(
  records: readonly HistoryRecord[],
): Map<string, SessionAggregate> {
  const roots = aggregateSessionTree(records);
  const result = new Map<string, SessionAggregate>();
  const visit = (node: SessionAggregate) => {
    result.set(node.sessionID, node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return result;
}

export function formatNumber(value: number, maximumFractionDigits = 2): string {
  const safeValue = finiteNumber(value, 0);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.max(0, maximumFractionDigits),
    useGrouping: true,
  }).format(safeValue);
}

export function formatTokens(tokens: number): string {
  return formatNumber(Math.round(Math.max(0, finiteNumber(tokens, 0))), 0);
}

export function formatDuration(milliseconds: number): string {
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

function calibrateSampleKind(
  samples: readonly SpeedSample[],
  kind: SampleKind | undefined,
  actualTokens: number,
): SpeedSample[] {
  const selectedIndexes = samples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => kind === undefined || sample.kind === kind)
    .map(({ index }) => index);
  if (selectedIndexes.length === 0) return [...samples];

  const weights = selectedIndexes.map((index) =>
    nonNegativeNumber(samples[index].estimatedTokens ?? samples[index].tokens),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return [...samples];

  const target = Math.max(0, Math.round(finiteNumber(actualTokens, 0)));
  const exact = weights.map((weight) => (weight / totalWeight) * target);
  const allocated = exact.map(Math.floor);
  let remainder = target - allocated.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - allocated[index] }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const item of order) {
    if (remainder <= 0) break;
    allocated[item.index] += 1;
    remainder -= 1;
  }

  const result = [...samples];
  selectedIndexes.forEach((sampleIndex, index) => {
    result[sampleIndex] = {
      ...result[sampleIndex],
      tokens: allocated[index],
    };
  });
  return result;
}

function selectSamples(
  samples: readonly SpeedSample[],
  kind: SampleKind | undefined,
): SpeedSample[] {
  const selected = kind === undefined ? [...samples] : samples.filter((sample) => sample.kind === kind);
  return selected.length > 0 ? selected : [...samples];
}

function createMutableSession(sessionID: string): MutableSessionAggregate {
  return {
    sessionID,
    directTokens: emptyTokenCounts(),
    directCost: 0,
    directResponseCount: 0,
    children: [],
  };
}

function materializeWithoutChildren(node: MutableSessionAggregate): SessionAggregate {
  return {
    sessionID: node.sessionID,
    ...(node.parentSessionID ? { parentSessionID: node.parentSessionID } : {}),
    directTokens: { ...node.directTokens },
    directCost: node.directCost,
    directResponseCount: node.directResponseCount,
    tokens: { ...node.directTokens },
    cost: node.directCost,
    responseCount: node.directResponseCount,
    children: [],
  };
}

interface MutableSessionAggregate {
  sessionID: string;
  parentSessionID?: string;
  directTokens: TokenCounts;
  directCost: number;
  directResponseCount: number;
  children: MutableSessionAggregate[];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, finiteNumber(value, 0));
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
