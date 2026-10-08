import type { SpeedContribution } from "./statistics.js";
import type { CompactScopeEvidence } from "./scope.js";

export const DEFAULT_BYTES_PER_TOKEN = 5.5;
export const DEFAULT_ROLLING_WINDOW_MS = 10_000;
export const MIN_ROLLING_OBSERVATION_MS = 1_000;
export const HISTORY_VERSION = 1;
export type HistoryRecordQuality = "provisional" | "exact";

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

export interface RollingRateMeasurement {
  status: "warming" | "ready" | "inactive";
  /** Estimated event-arrival tokens/second; zero unless ready. */
  rate: number;
  elapsedMs: number;
  observedTokens: number;
  /** Distinct timestamps in the observation window, including the baseline. */
  observationCount: number;
}

export interface ResponseTiming {
  start: number;
  /** Compatibility alias for firstContent, never a Thinking-only signal. */
  firstToken?: number;
  firstResponse?: number;
  firstContent?: number;
  firstResponseSource?: "thinking" | "content";
  firstResponseTimeSource?: "part-start" | "arrival";
  firstResponseEstimated?: boolean;
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
  quality?: HistoryRecordQuality;
  speed?: SpeedContribution;
  scope?: CompactScopeEvidence;
}

export interface RateStats {
  avg: number;
  max: number;
  min: number;
  available?: boolean;
  extremaAvailable?: boolean;
  /** Arrival windows are estimates even after final usage calibration. */
  estimated?: boolean;
}

export interface ActiveResponse {
  messageID: string;
  sessionID: string;
  model?: string;
  startedAt: number;
  firstTokenAt?: number;
  firstResponseAt?: number;
  firstContentAt?: number;
  firstResponseSource?: "thinking" | "content";
  firstResponseTimeSource?: "part-start" | "arrival";
  firstResponseEstimated?: boolean;
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
  const inputDetails = isRecord(source.inputTokenDetails) ? source.inputTokenDetails : {};
  const outputDetails = isRecord(source.outputTokenDetails) ? source.outputTokenDetails : {};
  const rawCacheRead = firstNonNegativeNumber(
    source.cachedInputTokens,
    source.cacheReadTokens,
    inputDetails.cacheReadTokens,
    inputDetails.cacheRead,
  );
  const rawCacheWrite = firstNonNegativeNumber(
    source.cacheWriteTokens,
    inputDetails.cacheWriteTokens,
    inputDetails.cacheWrite,
  );
  const cacheRead = firstNonNegativeNumber(
    source.cacheRead,
    source.cache_read,
    cache.read,
    rawCacheRead,
  );
  const cacheWrite = firstNonNegativeNumber(
    source.cacheWrite,
    source.cache_write,
    cache.write,
    rawCacheWrite,
  );
  const rawInputTokens = nonNegativeNumberOrUndefined(source.inputTokens);
  const rawOutputTokens = nonNegativeNumberOrUndefined(source.outputTokens);
  const reasoning = firstNonNegativeNumber(
    source.reasoning,
    source.reasoningTokens,
    outputDetails.reasoningTokens,
    outputDetails.reasoning,
  );
  const hasRawInputDetails = rawInputTokens !== undefined
    || rawCacheRead !== undefined
    || rawCacheWrite !== undefined;
  const hasRawOutputDetails = rawOutputTokens !== undefined
    || reasoning !== undefined;
  return {
    input: firstNonNegativeNumber(
      source.input,
      !hasRawInputDetails || rawInputTokens === undefined
        ? undefined
        : rawInputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0),
    ) ?? 0,
    output: firstNonNegativeNumber(
      source.output,
      !hasRawOutputDetails || rawOutputTokens === undefined
        ? undefined
        : rawOutputTokens - (reasoning ?? 0),
    ) ?? 0,
    reasoning: reasoning ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
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
  // Retain the entire equal-timestamp predecessor batch for interpolation.
  const predecessor = next.filter((entry) => entry.timestamp < cutoff).at(-1)?.timestamp;
  return next.filter((entry) => entry.timestamp >= cutoff || entry.timestamp === predecessor);
}

interface ArrivalPoint { timestamp: number; tokens: number }
interface NormalizedArrivals {
  points: ArrivalPoint[]; referenceNow?: number; latestObservationAt?: number; latestTokenAt?: number;
}

/** Local, immutable-to-consumers normalization shared by LIVE and extrema. */
function normalizeArrivalPoints(samples: readonly SpeedSample[], now?: number, windowMs?: number): NormalizedArrivals {
  const ordered = samples.filter((sample) => Number.isFinite(sample.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  const points: ArrivalPoint[] = [];
  const referenceNow = now ?? ordered.at(-1)?.timestamp;
  const result: NormalizedArrivals = { points, referenceNow };
  if (referenceNow === undefined || !Number.isFinite(referenceNow)
    || (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs < 0))) return result;
  for (const sample of ordered) {
    if (sample.timestamp > referenceNow) break;
    result.latestObservationAt = sample.timestamp;
    const tokens = nonNegativeNumber(sample.estimatedTokens ?? sample.tokens);
    if (tokens > 0) result.latestTokenAt = sample.timestamp;
    const previous = points.at(-1);
    if (previous?.timestamp === sample.timestamp) previous.tokens += tokens;
    else {
      if (previous && windowMs !== undefined && sample.timestamp - previous.timestamp > windowMs) points.length = 0;
      points.push({ timestamp: sample.timestamp, tokens });
    }
  }
  return result;
}

/**
 * Measures token arrivals, not the model's precise generation speed. The first
 * timestamp is a cumulative-count baseline (its unknown batch is excluded).
 * Later batches are spread uniformly across the preceding arrival interval;
 * a left-edge crossing takes only the overlapping fraction, not a whole-batch
 * deletion. Silence extends the denominator, never the numerator. A full-window
 * arrival gap starts a new warmup; we do not interpolate across inactive gaps.
 * Equal timestamps merge. Final usage calibration does not improve arrival
 * timing: estimatedTokens, where present, remain the numerator for LIVE/peaks.
 */
export function measureRollingTokenRate(
  samples: readonly SpeedSample[],
  now?: number,
  windowMs = DEFAULT_ROLLING_WINDOW_MS,
): RollingRateMeasurement {
  const empty: RollingRateMeasurement = {
    status: "warming", rate: 0, elapsedMs: 0, observedTokens: 0, observationCount: 0,
  };
  const { points, referenceNow, latestObservationAt, latestTokenAt } = normalizeArrivalPoints(samples, now, windowMs);
  if (referenceNow === undefined || !Number.isFinite(referenceNow)
    || !Number.isFinite(windowMs) || windowMs < 0) return empty;
  const cutoff = referenceNow - windowMs;
  const baseline = points.length > 0 ? Math.max(cutoff, points[0].timestamp) : referenceNow;
  const elapsedMs = referenceNow - baseline;
  let observedTokens = 0;
  let observationCount = points.filter((point) => point.timestamp >= cutoff).length;
  // The predecessor is a real timestamp supporting the interpolated boundary.
  if (points.some((point) => point.timestamp < cutoff) && (points.find((point) => point.timestamp >= cutoff)?.timestamp ?? cutoff) > cutoff) observationCount += 1;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (point.timestamp <= baseline) continue;
    const fraction = (point.timestamp - Math.max(baseline, previous.timestamp)) / (point.timestamp - previous.timestamp);
    observedTokens += point.tokens * fraction;
  }
  const measurement = { ...empty, elapsedMs, observedTokens, observationCount };
  const lastActivityAt = latestTokenAt ?? latestObservationAt;
  if (lastActivityAt !== undefined && referenceNow - lastActivityAt >= windowMs) {
    return { ...measurement, status: "inactive" };
  }
  if (observationCount < 2 || elapsedMs < MIN_ROLLING_OBSERVATION_MS) return measurement;
  const rate = (observedTokens / elapsedMs) * 1000;
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(rate)) return measurement;
  return { ...measurement, status: "ready", rate };
}

export function rollingTokenRate(
  samples: readonly SpeedSample[],
  now?: number,
  windowMs = DEFAULT_ROLLING_WINDOW_MS,
): number {
  return measureRollingTokenRate(samples, now, windowMs).rate;
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
  const { points } = normalizeArrivalPoints(samples);
  const prefix: number[] = [];
  const rates: number[] = [];
  let segmentStart = 0;
  let left = 0;
  let latestTokenAt: number | undefined;
  // Peaks/troughs are supported rolling windows ending at actual observations,
  // not arbitrary adjacent-chunk rates or a response-average fallback. One sort,
  // then a linear moving boundary; prefix sums exclude each segment's baseline.
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (index > 0 && point.timestamp - points[index - 1].timestamp > DEFAULT_ROLLING_WINDOW_MS) {
      segmentStart = index;
      left = index;
    }
    prefix[index] = index === segmentStart ? 0 : prefix[index - 1] + point.tokens;
    if (point.tokens > 0) latestTokenAt = point.timestamp;
    const cutoff = point.timestamp - DEFAULT_ROLLING_WINDOW_MS;
    while (points[left].timestamp < cutoff) left += 1;
    const elapsedMs = point.timestamp - Math.max(cutoff, points[segmentStart].timestamp);
    const interpolated = left > segmentStart && points[left].timestamp > cutoff;
    const observationCount = index - left + 1 + Number(interpolated);
    if (point.timestamp - (latestTokenAt ?? point.timestamp) >= DEFAULT_ROLLING_WINDOW_MS
      || observationCount < 2 || elapsedMs < MIN_ROLLING_OBSERVATION_MS) continue;
    let observedTokens = prefix[index] - prefix[left];
    if (interpolated) observedTokens += points[left].tokens
      * ((points[left].timestamp - cutoff) / (points[left].timestamp - points[left - 1].timestamp));
    // Rare overflowing/huge token sums cannot safely be subtracted. Preserve the
    // original per-window finite-rate decision rather than poisoning later windows.
    if (!Number.isFinite(observedTokens) || prefix[index] > Number.MAX_SAFE_INTEGER
      || prefix[left] > Math.abs(observedTokens) * 10_000) {
      const measurement = measureRollingTokenRate(samples, point.timestamp);
      if (measurement.status === "ready") rates.push(measurement.rate);
      continue;
    }
    const rate = (observedTokens / elapsedMs) * 1000;
    if (Number.isFinite(elapsedMs) && Number.isFinite(rate)) rates.push(rate);
  }
  return { ...calculateRateStats(rates), available: rates.length > 0,
    extremaAvailable: rates.length > 0, estimated: true };
}

export function timeToFirstToken(record: Pick<HistoryRecord, "time">): number | undefined {
  const { firstResponse, start, completed } = record.time;
  if (typeof firstResponse === "number" && Number.isFinite(firstResponse) && Number.isFinite(start)
    && firstResponse >= start && (completed === undefined || firstResponse <= completed)) return firstResponse - start;
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
    const existing = byMessage.get(record.messageID);
    if (!existing || preferredHistoryRecord(record, existing)) {
      byMessage.set(record.messageID, record);
    }
  }
  return [...byMessage.values()];
}

function preferredHistoryRecord(candidate: HistoryRecord, existing: HistoryRecord): boolean {
  const candidateQuality = candidate.quality ?? "exact";
  const existingQuality = existing.quality ?? "exact";
  if (candidateQuality !== existingQuality) return candidateQuality === "exact";
  const candidateCompleted = candidate.time.completed ?? candidate.time.start;
  const existingCompleted = existing.time.completed ?? existing.time.start;
  if (candidateCompleted !== existingCompleted) return candidateCompleted > existingCompleted;
  return true;
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

function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  const number = finiteNumberOrUndefined(value);
  return number === undefined ? undefined : Math.max(0, number);
}

function firstNonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = nonNegativeNumberOrUndefined(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
