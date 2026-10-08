import type { HistoryRecord, ResponseTiming, TokenCounts } from "./core.js";
import { MIN_ROLLING_OBSERVATION_MS } from "./core.js";
import { createHash, type Hash } from "node:crypto";

export const GENERATION_BASIS_VERSION = 3;
/** Runtime ingress declaration, never an implicit default for old observations. */
export const RECEIVE_CLOCK_RESOLUTION_MS = 1;
export const MIN_COMPLETED_OBSERVATION_MS = 100;
export type ObservationQuality = "short" | "standard";
export interface ReceiveClockContext { clockSource: "performance.now"; clockResolutionMs: number }
export type ContentStream = "legacy" | "v2";
export interface RateMeasurement { generatedTokens: number; durationMs: number; estimated: boolean; coverageGeneratedTokens?: number; observationQuality?: ObservationQuality }
export type GenerationCoverage = "complete" | "unknown" | "gap";
export interface GenerationCoverageDiagnostics { status: GenerationCoverage; reasons: string[] }
/** Stable rejection codes only: never persist event text, provider errors or
 * reasoning content as a diagnostic. Bound both input inspection and output. */
const GENERATION_REJECTION_REASONS = new Set([
  "unknown-coverage", "generation-invalidated", "invalid-v3-evidence", "missing-content-observation",
  "not-observed-from-current-start", "unknown-final-usage", "unknown-reasoning-usage",
  "unattributed-or-merged-deltas", "unknown-or-multiple-step-identities", "unknown-step-identity", "multiple-step-identities",
  "missing-receive-observations", "insufficient-receive-span", "unknown-receive-clock", "unfinished-response", "tool-usage-uncertain",
  "snapshot-delta-gap", "snapshot-delta-mismatch", "missing-comparable-final-snapshot", "missing-byte-receive-timing",
  "hidden-reasoning", "unobserved-output", "receive-byte-mismatch", "invalid-arrival-bytes", "anonymous-or-tool-arrival",
  "invalid-receive-clock", "arrival-kind-mismatch", "mixed-streams", "duplicate-or-unparsed-arrival", "nonmonotonic-receive-clock",
  "merged-receive-streams", "merged-recovered-content", "merged-delta-streams", "unknown-merged-coverage",
  "anonymous-snapshot", "part-kind-changed", "anonymous-delta", "retry", "failed", "recovery", "disconnect",
  "transport-disruption", "recovered-content", "unobserved-response-start", "not-current-assistant",
  "superseded-assistant", "previous-response-disruption", "aborted", "cancelled",
]);
function coerceGenerationCoverage(value: unknown): GenerationCoverageDiagnostics | undefined {
  if (!object(value) || !["complete", "unknown", "gap"].includes(value.status) || !Array.isArray(value.reasons)) return undefined;
  const reasons: string[] = [];
  for (const reason of value.reasons.slice(0, 64)) {
    if (typeof reason === "string" && GENERATION_REJECTION_REASONS.has(reason) && !reasons.includes(reason)) reasons.push(reason);
    if (reasons.length === 8) break;
  }
  return { status: value.status, reasons: value.status === "complete" ? [] : reasons.length ? reasons : ["unknown-coverage"] };
}
export interface CategoryByteEvidence { total: number; firstBatch: number }
export interface GenerationEvidence {
  start: number; end: number; outputObserved: boolean; reasoningObserved: boolean;
  /** Legacy evidence can be coerced, but only v3 enters generation accumulators. */
  version?: 2 | 3;
  coverage?: GenerationCoverage;
  firstReceiveMono?: number; lastReceiveMono?: number; observationCount?: number;
  timeSource?: "receive-monotonic"; fromCurrentStart?: boolean;
  selectedStream?: ContentStream; stepID?: string;
  bytes?: { output: CategoryByteEvidence; reasoning: CategoryByteEvidence };
  usage?: { output: number; reasoning: number };
  clockSource?: "performance.now"; clockResolutionMs?: number; observationQuality?: ObservationQuality;
}
export interface V3GenerationEvidence extends GenerationEvidence {
  version: 3; coverage: "complete";
  firstReceiveMono: number; lastReceiveMono: number; observationCount: number;
  timeSource: "receive-monotonic"; fromCurrentStart: true;
  selectedStream: ContentStream; stepID: string;
  bytes: { output: CategoryByteEvidence; reasoning: CategoryByteEvidence };
  usage: { output: number; reasoning: number };
}
export interface SpeedContribution {
  generation?: RateMeasurement; response?: RateMeasurement; generationEvidence?: GenerationEvidence;
  generationCoverage?: GenerationCoverageDiagnostics;
}
export interface CompletionUpdate {
  source: "live";
  instanceID: string;
  sequence: number;
  receivedAt: number;
  revision?: number;
  fingerprint: string;
  seenFingerprints: string[];
}
export interface RateAccumulator { generatedTokens: number; durationMs: number; responseCount: number; estimatedResponseCount: number; coverageGeneratedTokens?: number; shortResponseCount?: number }
export interface SessionSpeedTotals { generation: RateAccumulator; response: RateAccumulator }
export type MeasuredHistoryRecord = HistoryRecord & { speed?: SpeedContribution; update?: CompletionUpdate };
export interface SpeedObservations {
  usageExact?: boolean;
  responseTimingExact?: boolean;
  /** v3 receive span and per-category proportions; never provider/part boundaries. */
  generation?: Partial<GenerationEvidence> & { start: number; end: number; complete: boolean; estimated: boolean };
  generationCoverage?: GenerationCoverageDiagnostics;
}
export interface AverageRateSummary {
  available: boolean;
  rate: number | undefined;
  estimated: boolean;
  coveredGeneratedTokens: number;
  coveredResponseCount: number;
  estimatedResponseCount: number;
  durationMs: number;
  shortResponseCount?: number;
}
export interface SessionAverageSummary {
  generation: AverageRateSummary;
  response: AverageRateSummary & { includesTTFT: true; mayIncludeToolWait: true };
  totalGeneratedTokens: number;
  totalResponseCount: number;
}

export function measureRecordSpeed(record: HistoryRecord, observations: SpeedObservations = {}): SpeedContribution {
  const generatedTokens = record.tokens.output + record.tokens.reasoning;
  const speed: SpeedContribution = {};
  const coverage = coerceGenerationCoverage(observations.generationCoverage);
  if (coverage && coverage.status !== "complete") speed.generationCoverage = coverage;
  if (!valid(record.tokens.output) || !valid(record.tokens.reasoning) || !valid(generatedTokens)) return speed;
  speed.response = deriveSafeResponseMeasurement(record, { rawTimingKnown: true, ...observations });
  if (!speed.response) delete speed.response;
  const generation = observations.generation;
  if (observations.usageExact === true && generation?.complete && isV3Evidence(generation) && valid(record.time.completed)) {
    const evidence = copyV3Evidence(generation, record.tokens);
    const measurement = intervalMeasurement(evidence);
    if (measurement) { speed.generation = measurement; speed.generationEvidence = evidence; delete speed.generationCoverage; }
  }
  if (generation?.complete && !speed.generation) speed.generationCoverage ??= { status: "unknown", reasons: ["invalid-v3-evidence"] };
  return speed;
}

/** Only callers holding original start/completed facts may opt in. A normalized
 * zero start is not provenance. Response throughput includes TTFT/tool wait. */
export function deriveSafeResponseMeasurement(record: HistoryRecord,
  provenance: { rawTimingKnown: boolean; usageExact?: boolean; responseTimingExact?: boolean }): RateMeasurement | undefined {
  const { start, completed } = record.time;
  const generatedTokens = record.tokens.output + record.tokens.reasoning;
  if (provenance.rawTimingKnown !== true || !valid(start) || !valid(completed) || completed <= start
    || !valid(record.tokens.output) || !valid(record.tokens.reasoning) || !valid(generatedTokens)) return undefined;
  return { generatedTokens, durationMs: completed - start,
    estimated: provenance.usageExact !== true || provenance.responseTimingExact !== true };
}

export interface SelectedSpeedMeasurement {
  available: boolean;
  rate?: number;
  basis?: "generation" | "response";
  estimated: boolean;
  coverage: { generation: boolean; response: boolean; generatedTokens: number; durationMs: number; intervalGeneratedTokens?: number };
  measurement?: RateMeasurement;
}

/** Primary TPS is ONLY v3 host-observed generation, always estimated. Response
 * throughput is a separately named diagnostic, never a fallback. */
export function selectSpeedMeasurement(record: HistoryRecord): SelectedSpeedMeasurement {
  const speed = coerceSpeedContribution(record.speed);
  const generation = qualifiedGeneration(speed, record) ? speed?.generation : undefined;
  const response = speed?.response;
  const measurement = generation;
  const rate = measurement ? measurement.generatedTokens * 1000 / measurement.durationMs : undefined;
  const available = rate !== undefined && Number.isFinite(rate);
  return { available, ...(available ? { rate, basis: "generation" as const, measurement } : {}), estimated: true,
    coverage: { generation: !!generation, response: !!response, generatedTokens: available ? measurement!.coverageGeneratedTokens! : 0,
      intervalGeneratedTokens: available ? measurement!.generatedTokens : 0,
      durationMs: available ? measurement!.durationMs : 0 } };
}

export function selectResponseMeasurement(record: HistoryRecord): SelectedSpeedMeasurement {
  const measurement = coerceSpeedContribution(record.speed)?.response;
  const rate = measurement ? measurement.generatedTokens * 1000 / measurement.durationMs : undefined;
  const available = rate !== undefined && Number.isFinite(rate);
  return { available, ...(available ? { rate, basis: "response" as const, measurement } : {}), estimated: measurement?.estimated ?? true,
    coverage: { generation: false, response: available, generatedTokens: available ? measurement!.generatedTokens : 0,
      durationMs: available ? measurement!.durationMs : 0 } };
}

function trustedReceiveClock(value: unknown): value is ReceiveClockContext {
  return object(value) && value.clockSource === "performance.now" && valid(value.clockResolutionMs) && value.clockResolutionMs > 0;
}

function completedSpanQualified(span: number, clock: { clockSource?: unknown; clockResolutionMs?: unknown }): boolean {
  if (!valid(span) || span < MIN_COMPLETED_OBSERVATION_MS) return false;
  const declared = clock.clockSource !== undefined || clock.clockResolutionMs !== undefined;
  if (span < MIN_ROLLING_OBSERVATION_MS || declared) {
    return trustedReceiveClock(clock) && span >= Math.max(MIN_COMPLETED_OBSERVATION_MS, 10 * clock.clockResolutionMs);
  }
  return true; // Existing long v3 evidence predates explicit clock declarations.
}

function isV3Evidence(value: unknown): value is V3GenerationEvidence {
  if (!object(value) || value.version !== 3 || value.coverage !== "complete" || value.fromCurrentStart !== true
    || value.timeSource !== "receive-monotonic" || !["legacy", "v2"].includes(value.selectedStream)
    || typeof value.stepID !== "string" || !value.stepID.trim() || !valid(value.start) || !valid(value.end)
    || !valid(value.firstReceiveMono) || !valid(value.lastReceiveMono)
    || !completedSpanQualified(value.lastReceiveMono - value.firstReceiveMono, value) || !Number.isInteger(value.observationCount) || value.observationCount < 2
    || !object(value.bytes) || !object(value.usage)) return false;
  const quality = value.lastReceiveMono - value.firstReceiveMono < MIN_ROLLING_OBSERVATION_MS ? "short" : "standard";
  if ((quality === "short" || value.observationQuality !== undefined) && value.observationQuality !== quality) return false;
  for (const kind of ["output", "reasoning"] as const) {
    const bytes = value.bytes[kind];
    if (!object(bytes) || !Number.isSafeInteger(bytes.total) || bytes.total < 0 || !Number.isSafeInteger(bytes.firstBatch) || bytes.firstBatch < 0 || bytes.firstBatch > bytes.total
      || !valid(value.usage[kind]) || (value.usage[kind] > 0 && bytes.total === 0)
      || value[`${kind}Observed`] !== (bytes.total > 0)) return false;
  }
  const first = value.bytes.output.firstBatch + value.bytes.reasoning.firstBatch;
  const total = value.bytes.output.total + value.bytes.reasoning.total;
  return Number.isSafeInteger(total) && first > 0 && total > first;
}

function copyV3Evidence(e: V3GenerationEvidence, usage = e.usage): V3GenerationEvidence {
  return { start: e.start, end: e.end, version: 3, coverage: "complete", firstReceiveMono: e.firstReceiveMono,
    lastReceiveMono: e.lastReceiveMono, observationCount: e.observationCount, timeSource: "receive-monotonic", fromCurrentStart: true,
    selectedStream: e.selectedStream, stepID: e.stepID, outputObserved: e.outputObserved, reasoningObserved: e.reasoningObserved,
    bytes: { output: { ...e.bytes.output }, reasoning: { ...e.bytes.reasoning } }, usage: { output: usage.output, reasoning: usage.reasoning },
    ...(e.clockSource !== undefined ? { clockSource: e.clockSource } : {}),
    ...(e.clockResolutionMs !== undefined ? { clockResolutionMs: e.clockResolutionMs } : {}),
    ...(e.observationQuality !== undefined ? { observationQuality: e.observationQuality } : {}) };
}

/** Full usage is coverage, NOT the interval numerator. Every global-first-mono
 * batch byte is excluded, by kind. There is no arbitrary one-token subtraction. */
function intervalMeasurement(e: V3GenerationEvidence): RateMeasurement | undefined {
  if (!isV3Evidence(e)) return undefined;
  let generatedTokens = 0;
  for (const kind of ["output", "reasoning"] as const) {
    const { total, firstBatch } = e.bytes[kind];
    if (total > 0) generatedTokens += e.usage[kind] * ((total - firstBatch) / total);
  }
  const coverageGeneratedTokens = e.usage.output + e.usage.reasoning;
  const durationMs = e.lastReceiveMono - e.firstReceiveMono;
  if (!valid(generatedTokens) || !valid(coverageGeneratedTokens) || !valid(durationMs)) return undefined;
  return { generatedTokens, coverageGeneratedTokens, durationMs, estimated: true,
    observationQuality: durationMs < MIN_ROLLING_OBSERVATION_MS ? "short" : "standard" };
}

export function isQualifiedGenerationContribution(speed: SpeedContribution | undefined): boolean {
  return qualifiedGeneration(coerceSpeedContribution(speed));
}

function qualifiedGeneration(speed: SpeedContribution | undefined, record?: HistoryRecord): boolean {
  const evidence = speed?.generationEvidence;
  if (!speed?.generation || !isV3Evidence(evidence)) return false;
  const expected = intervalMeasurement(evidence);
  if (!expected || speed.generation.estimated !== true || speed.generation.durationMs !== expected.durationMs
    || speed.generation.generatedTokens !== expected.generatedTokens || speed.generation.coverageGeneratedTokens !== expected.coverageGeneratedTokens
    || ((expected.observationQuality === "short" || speed.generation.observationQuality !== undefined)
      && speed.generation.observationQuality !== expected.observationQuality)) return false;
  if (!record) return true;
  return valid(record.time.completed) && evidence.usage.output === record.tokens.output && evidence.usage.reasoning === record.tokens.reasoning;
}

export function emptySpeedTotals(): SessionSpeedTotals {
  const zero = (): RateAccumulator => ({ generatedTokens: 0, durationMs: 0, responseCount: 0, estimatedResponseCount: 0, coverageGeneratedTokens: 0 });
  return { generation: { ...zero(), shortResponseCount: 0 }, response: zero() };
}
export function coerceSpeedContribution(value: unknown): SpeedContribution | undefined {
  if (!object(value)) return undefined;
  const result: SpeedContribution = {};
  for (const kind of ["generation", "response"] as const) {
    const m = value[kind];
    if (object(m) && valid(m.generatedTokens) && valid(m.durationMs) && m.durationMs > 0 && typeof m.estimated === "boolean") {
      result[kind] = { generatedTokens: m.generatedTokens, durationMs: m.durationMs, estimated: m.estimated };
      if (valid(m.coverageGeneratedTokens)) result[kind]!.coverageGeneratedTokens = m.coverageGeneratedTokens;
      if (m.observationQuality !== undefined) {
        if (m.observationQuality !== "short" && m.observationQuality !== "standard") { delete result[kind]; continue; }
        result[kind]!.observationQuality = m.observationQuality;
      }
    }
  }
  const evidence = value.generationEvidence;
  if (result.generation && isV3Evidence(evidence)) {
    result.generationEvidence = copyV3Evidence(evidence);
  } else if (result.generation && object(evidence) && valid(evidence.start) && valid(evidence.end) && evidence.end > evidence.start
    && typeof evidence.outputObserved === "boolean" && typeof evidence.reasoningObserved === "boolean"
    && evidence.end - evidence.start === result.generation.durationMs) {
    result.generationEvidence = { start: evidence.start, end: evidence.end,
      outputObserved: evidence.outputObserved, reasoningObserved: evidence.reasoningObserved,
      ...(evidence.version === 2 && ["complete", "unknown", "gap"].includes(evidence.coverage)
        ? { version: 2 as const, coverage: evidence.coverage as GenerationCoverage } : {}) };
  }
  const coverage = coerceGenerationCoverage(value.generationCoverage);
  if (coverage) result.generationCoverage = coverage;
  return result.generation || result.response || result.generationCoverage ? result : undefined;
}

/** Compatible authoritative usage corrections rescale original v3 proportions.
 * They never replace the interval estimate with whole-response usage. */
export function mergeRecordSpeed(record: HistoryRecord, previous: { tokens: TokenCounts; speed?: SpeedContribution } | undefined,
  generationStatus: "unobserved" | "invalidated" = "unobserved"): SpeedContribution {
  const next = coerceSpeedContribution(record.speed) ?? {};
  const prior = coerceSpeedContribution(previous?.speed);
  if (!qualifiedGeneration(next, record)) { delete next.generation; delete next.generationEvidence; }
  if (generationStatus === "invalidated") {
    delete next.generation; delete next.generationEvidence;
    if (!next.generationCoverage || next.generationCoverage.status === "complete") next.generationCoverage =
      prior?.generationCoverage?.status !== "complete" && prior?.generationCoverage
        ? prior.generationCoverage : { status: "unknown", reasons: ["generation-invalidated"] };
    return next;
  }
  if (next.generation) { delete next.generationCoverage; return next; }
  if (!next.generationCoverage && prior?.generationCoverage && prior.generationCoverage.status !== "complete") next.generationCoverage = prior.generationCoverage;
  if (!prior?.generation || !qualifiedGeneration(prior)) return next;
  const evidence = prior.generationEvidence;
  if (!isV3Evidence(evidence) || !valid(record.time.completed)) return next;
  const corrected = copyV3Evidence(evidence, record.tokens);
  const measurement = intervalMeasurement(corrected);
  if (!measurement) {
    next.generationCoverage ??= { status: "unknown", reasons: [record.tokens.reasoning > 0 && evidence.bytes.reasoning.total === 0
      ? "hidden-reasoning" : record.tokens.output > 0 && evidence.bytes.output.total === 0 ? "unobserved-output" : "unknown-final-usage"] };
    return next;
  }
  next.generation = measurement;
  next.generationEvidence = corrected;
  delete next.generationCoverage;
  return next;
}

export function coerceCompletionUpdate(value: unknown): CompletionUpdate | undefined {
  if (!object(value) || value.source !== "live" || typeof value.instanceID !== "string" || !valid(value.sequence)
    || !valid(value.receivedAt) || typeof value.fingerprint !== "string" || !Array.isArray(value.seenFingerprints)
    || !value.seenFingerprints.every((v: unknown) => typeof v === "string")) return undefined;
  return { source: "live", instanceID: value.instanceID, sequence: value.sequence, receivedAt: value.receivedAt,
    ...(valid(value.revision) ? { revision: value.revision } : {}), fingerprint: value.fingerprint, seenFingerprints: [...value.seenFingerprints] };
}
/** Envelope revision is ordering evidence; provider completed/duration is not.
 * Otherwise explicitly-live updates use ingress order, not token volume.
 * Previously received facts remain replay, including after restart. */
export function isNewerCompletionUpdate(next: CompletionUpdate, previous: CompletionUpdate | undefined): boolean {
  if (!previous) return true;
  if (next.revision !== undefined && previous.revision !== undefined && next.revision !== previous.revision) return next.revision > previous.revision;
  if (previous.fingerprint === next.fingerprint || previous.seenFingerprints.includes(next.fingerprint)) return false;
  return next.instanceID === previous.instanceID ? next.sequence > previous.sequence : next.receivedAt >= previous.receivedAt;
}
export function coerceSpeedTotals(value: unknown): SessionSpeedTotals | undefined {
  if (!object(value)) return undefined;
  const result = emptySpeedTotals();
  for (const kind of ["generation", "response"] as const) {
    const m = value[kind];
    if (!object(m) || !valid(m.generatedTokens) || !valid(m.durationMs) || !valid(m.responseCount)
      || !valid(m.estimatedResponseCount) || m.estimatedResponseCount > m.responseCount) return undefined;
    result[kind] = { generatedTokens: m.generatedTokens, durationMs: m.durationMs,
      responseCount: m.responseCount, estimatedResponseCount: m.estimatedResponseCount,
      coverageGeneratedTokens: valid(m.coverageGeneratedTokens) ? m.coverageGeneratedTokens : 0 };
    if (kind === "generation") {
      if (m.shortResponseCount !== undefined && (!Number.isInteger(m.shortResponseCount) || !valid(m.shortResponseCount) || m.shortResponseCount > m.responseCount)) return undefined;
      result.generation.shortResponseCount = m.shortResponseCount ?? 0;
    }
  }
  return result;
}
export function updateSpeedTotals(current: SessionSpeedTotals | undefined, contribution: SpeedContribution | undefined, sign: 1 | -1): SessionSpeedTotals | undefined {
  const speed = coerceSpeedContribution(contribution);
  if (!speed) return coerceSpeedTotals(current);
  const result = coerceSpeedTotals(current) ?? emptySpeedTotals();
  for (const kind of ["generation", "response"] as const) {
    const m = speed[kind];
    if (!m) continue;
    // Both signs must use the v3 basis: subtracting legacy generation after
    // migration could erase unrelated new v3 measurements.
    if (kind === "generation" && !qualifiedGeneration(speed)) continue;
    const a = result[kind];
    a.generatedTokens = Math.max(0, a.generatedTokens + sign * m.generatedTokens);
    a.durationMs = Math.max(0, a.durationMs + sign * m.durationMs);
    a.responseCount = Math.max(0, a.responseCount + sign);
    a.estimatedResponseCount = Math.max(0, a.estimatedResponseCount + sign * Number(m.estimated));
    if (kind === "generation") a.shortResponseCount = Math.max(0, (a.shortResponseCount ?? 0) + sign * Number(m.observationQuality === "short"));
    a.coverageGeneratedTokens = Math.max(0, (a.coverageGeneratedTokens ?? 0)
      + sign * (kind === "generation" ? m.coverageGeneratedTokens! : m.generatedTokens));
  }
  return result;
}
export function addSpeedTotals(left: SessionSpeedTotals | undefined, right: SessionSpeedTotals | undefined): SessionSpeedTotals | undefined {
  if (!left && !right) return undefined;
  const result = coerceSpeedTotals(left) ?? emptySpeedTotals();
  const incoming = coerceSpeedTotals(right) ?? emptySpeedTotals();
  for (const kind of ["generation", "response"] as const) {
    for (const field of ["generatedTokens", "durationMs", "responseCount", "estimatedResponseCount"] as const) result[kind][field] += incoming[kind][field];
    result[kind].coverageGeneratedTokens = (result[kind].coverageGeneratedTokens ?? 0) + (incoming[kind].coverageGeneratedTokens ?? 0);
  }
  result.generation.shortResponseCount = (result.generation.shortResponseCount ?? 0) + (incoming.generation.shortResponseCount ?? 0);
  return result;
}
export function sameSpeedContribution(left: SpeedContribution | undefined, right: SpeedContribution | undefined): boolean {
  return JSON.stringify(coerceSpeedContribution(left)) === JSON.stringify(coerceSpeedContribution(right));
}
export function getSessionAverageSummary(directTotals: { tokens: TokenCounts; responseCount: number; speed?: SessionSpeedTotals }): SessionAverageSummary {
  const speed = coerceSpeedTotals(directTotals.speed) ?? emptySpeedTotals();
  const summary = (a: RateAccumulator): AverageRateSummary => ({ available: a.durationMs > 0 && a.responseCount > 0,
    rate: a.durationMs > 0 && a.responseCount > 0 ? a.generatedTokens * 1000 / a.durationMs : undefined,
    estimated: a.estimatedResponseCount > 0, coveredGeneratedTokens: a.coverageGeneratedTokens ?? 0,
    coveredResponseCount: a.responseCount, estimatedResponseCount: a.estimatedResponseCount, durationMs: a.durationMs });
  const generation = summary(speed.generation);
  return { generation: { ...generation, estimated: generation.available || generation.estimated, shortResponseCount: speed.generation.shortResponseCount ?? 0 }, response: { ...summary(speed.response), includesTTFT: true, mayIncludeToolWait: true },
    totalGeneratedTokens: directTotals.tokens.output + directTotals.tokens.reasoning, totalResponseCount: directTotals.responseCount };
}

/** Compare only timestamps in the same response interval/clock domain. */
export function earliestFirstOutput(start: number, completed: number, ...values: (number | undefined)[]): number | undefined {
  const candidates = values.filter((v): v is number => valid(v) && v >= start && v <= completed);
  return candidates.length ? Math.min(...candidates) : undefined;
}

export interface FirstResponseSignal {
  timestamp: number;
  source: "thinking" | "content";
  timeSource: "part-start" | "arrival";
  estimated: boolean;
}
export interface FirstResponseContext {
  messageID: string; sessionID?: string; role: string;
  start: number; now: number; completed?: number; live: boolean;
}

/** Match Host ReasoningPart visibility, not session busy/provider activity.
 * The caller must establish live ingress/current assistant ownership; history
 * and reconnect snapshots set live=false. This helper never creates samples. */
export function thinkingFirstResponseSignal(part: unknown, context: FirstResponseContext): FirstResponseSignal | undefined {
  if (!object(part) || !context.live || context.role !== "assistant" || context.completed !== undefined
    || part.type !== "reasoning" || part.messageID !== context.messageID
    || (context.sessionID !== undefined && part.sessionID !== undefined && part.sessionID !== context.sessionID)
    || (part.role !== undefined && part.role !== "assistant") || part.time?.end != null
    || !valid(context.start) || !valid(context.now) || context.now < context.start) return undefined;
  const visibleText = typeof part.text === "string" ? part.text.replaceAll("[REDACTED]", "").trim() : "";
  if (!visibleText && !part.metadata) return undefined;
  const start = part.time?.start;
  if (valid(start) && start >= context.start && start <= context.now) {
    return { timestamp: start, source: "thinking", timeSource: "part-start", estimated: false };
  }
  return { timestamp: context.now, source: "thinking", timeSource: "arrival", estimated: true };
}

/** Earliest valid signal wins with its provenance; duplicate replay cannot
 * rewrite existing equal-time provenance. Neither alias nor samples change. */
export function applyFirstResponseSignal(time: ResponseTiming, signal: FirstResponseSignal): ResponseTiming {
  if (!valid(time.start) || !valid(signal.timestamp) || signal.timestamp < time.start
    || (time.completed !== undefined && (!valid(time.completed) || signal.timestamp > time.completed))) return { ...time };
  const prior = time.firstResponse;
  const priorValid = valid(prior) && prior >= time.start && (time.completed === undefined || prior <= time.completed);
  const content = earliestFirstOutput(time.start, time.completed ?? Infinity, time.firstContent, time.firstToken);
  if (priorValid && prior <= signal.timestamp && (content === undefined || prior <= content)) return { ...time };
  // Migrating an active legacy state must not replace an already earlier real
  // content fact with a later Thinking signal just because firstResponse is new.
  if (content !== undefined && content <= signal.timestamp && (!priorValid || content < prior)) {
    return { ...time, firstResponse: content, firstResponseSource: "content", firstResponseTimeSource: "arrival", firstResponseEstimated: true };
  }
  return { ...time, firstResponse: signal.timestamp, firstResponseSource: signal.source,
    firstResponseTimeSource: signal.timeSource, firstResponseEstimated: signal.estimated };
}

/** Actual model delta arrivals establish firstContent and its legacy alias.
 * Thinking alone can never establish either. Arrival time is estimated. */
export function recordContentArrival(time: ResponseTiming, timestamp: number): ResponseTiming {
  if (!valid(time.start) || !valid(timestamp) || timestamp < time.start
    || (time.completed !== undefined && (!valid(time.completed) || timestamp > time.completed))) return { ...time };
  const firstContent = earliestFirstOutput(time.start, time.completed ?? timestamp, time.firstContent, time.firstToken, timestamp)!;
  return applyFirstResponseSignal({ ...time, firstContent, firstToken: firstContent },
    { timestamp: firstContent, source: "content", timeSource: "arrival", estimated: true });
}

function valid(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function object(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export interface ContentPartProgress {
  type: string; deltaBytes: number; snapshotBytes: number; end?: number; start?: number;
  /** Comparable final text snapshot, not an absent text property normalized to ''. */
  finalSnapshotBytes?: number;
  finalSnapshotDigest?: string;
  snapshotDigest?: string;
  deltaHasher?: Hash;
  /** Constant-size raw-prefix checkpoint at the last non-whitespace character.
   * It proves rawStream.trimEnd(), never snapshot.trimEnd() or trimStart(). */
  trimEndHasher?: Hash;
  trimEndBytes?: number;
  receivedBytes?: number;
  knownGap?: boolean;
}
export interface ContentReceiveProgress {
  firstWall: number; lastWall: number; firstMono: number; lastMono: number; observationCount: number;
  bytes: { output: CategoryByteEvidence; reasoning: CategoryByteEvidence };
  /** Proof covers every accepted arrival; an omitted declaration is irreversible. */
  clockSource?: "performance.now"; clockResolutionMs?: number; clockTrusted?: boolean;
}
export interface ContentProgress {
  parts: Map<string, ContentPartProgress>; eventIDs: Set<string>; stepEnds?: Set<number>;
  unknownCoverage?: boolean;
  fromCurrentStart?: boolean;
  selectedStream?: ContentStream;
  taints?: Set<string>;
  stepIdentities?: Set<string>;
  receive?: ContentReceiveProgress;
}
export interface ContentMetadataCache {
  progress: Map<string, ContentProgress>;
  roles: Map<string, string>;
  completed: Set<string>;
  nextSequence: number;
}
export function createContentMetadataCache(): ContentMetadataCache {
  return { progress: new Map(), roles: new Map(), completed: new Set(), nextSequence: 1 };
}
export function cachedContentProgress(cache: ContentMetadataCache, messageID: string): ContentProgress {
  let progress = cache.progress.get(messageID);
  if (!progress) { progress = createContentProgress(); cache.progress.set(messageID, progress); }
  return progress;
}
/** Only metadata: deliberately has no ActiveState argument or side effect. */
export function cachePartSnapshot(cache: ContentMetadataCache, properties: Record<string, any>): void {
  const part = properties.part;
  if (!object(part) || typeof part.messageID !== "string") return;
  if (typeof part.role === "string") cache.roles.set(part.messageID, part.role);
  notePartSnapshot(cachedContentProgress(cache, part.messageID), properties);
}
export function createContentProgress(options: { fromCurrentStart?: boolean; selectedStream?: ContentStream } = {}): ContentProgress {
  return { parts: new Map(), eventIDs: new Set(), fromCurrentStart: options.fromCurrentStart === true,
    ...(options.selectedStream ? { selectedStream: options.selectedStream } : {}), taints: new Set(), stepIdentities: new Set() };
}

/** Lifecycle callers report retry/fail/recovery/known disconnect. Taint is
 * permanent for this message; busy is never a new clean model invocation. */
export function taintContentProgress(progress: ContentProgress, reason: string): void {
  progress.taints ??= new Set();
  progress.taints.add(reason.trim() || "unknown-coverage");
  progress.unknownCoverage = true;
}

/** Deduplicate STEP IDENTITIES, not wall timestamps or duplicate snapshots. */
export function noteStepIdentity(progress: ContentProgress, identity: string | undefined): void {
  if (typeof identity !== "string" || !identity.trim()) { taintContentProgress(progress, "unknown-step-identity"); return; }
  progress.stepIdentities ??= new Set();
  progress.stepIdentities.add(identity);
  if (progress.stepIdentities.size > 1) taintContentProgress(progress, "multiple-step-identities");
}

/** Call exactly once AFTER parse accepts a nonempty selected-stream delta,
 * using both clocks captured together at ingress. Part bytes and receive bytes
 * are separate accounting lanes: every accepted byte must have receive timing. */
export function noteContentArrival(progress: ContentProgress, arrival: {
  kind: "output" | "reasoning"; bytes: number; partID?: string;
  receivedAt: number; receivedMono: number; stream: ContentStream;
}, clock?: ReceiveClockContext): void {
  if (arrival.bytes === 0) return;
  if (!Number.isSafeInteger(arrival.bytes) || arrival.bytes < 0) { taintContentProgress(progress, "invalid-arrival-bytes"); return; }
  const part = arrival.partID ? progress.parts.get(arrival.partID) : undefined;
  if (!part || !["text", "output", "reasoning"].includes(part.type)) { taintContentProgress(progress, "anonymous-or-tool-arrival"); return; }
  if (!valid(arrival.receivedAt) || !valid(arrival.receivedMono)) { taintContentProgress(progress, "invalid-receive-clock"); return; }
  if (arrival.kind !== (part.type === "reasoning" ? "reasoning" : "output")) { taintContentProgress(progress, "arrival-kind-mismatch"); return; }
  if (progress.fromCurrentStart !== true) taintContentProgress(progress, "not-observed-from-current-start");
  if (progress.selectedStream && progress.selectedStream !== arrival.stream) taintContentProgress(progress, "mixed-streams");
  progress.selectedStream ??= arrival.stream;
  if ((part.receivedBytes ?? 0) + arrival.bytes > part.deltaBytes) { taintContentProgress(progress, "duplicate-or-unparsed-arrival"); return; }
  const receive = progress.receive;
  if (receive && arrival.receivedMono < receive.lastMono) { taintContentProgress(progress, "nonmonotonic-receive-clock"); return; }
  part.receivedBytes = (part.receivedBytes ?? 0) + arrival.bytes;
  if (!receive) {
    progress.receive = { firstWall: arrival.receivedAt, lastWall: arrival.receivedAt, firstMono: arrival.receivedMono,
      lastMono: arrival.receivedMono, observationCount: 1,
      bytes: { output: { total: 0, firstBatch: 0 }, reasoning: { total: 0, firstBatch: 0 } } };
  }
  const next = progress.receive!;
  next.clockTrusted = trustedReceiveClock(clock) && (!receive || receive.clockTrusted === true);
  if (next.clockTrusted) {
    next.clockSource = clock!.clockSource;
    next.clockResolutionMs = Math.max(next.clockResolutionMs ?? 0, clock!.clockResolutionMs);
  } else {
    delete next.clockSource;
    delete next.clockResolutionMs;
  }
  if (arrival.receivedMono > next.lastMono) next.observationCount += 1;
  next.lastMono = arrival.receivedMono;
  next.lastWall = arrival.receivedAt;
  next.bytes[arrival.kind].total += arrival.bytes;
  if (arrival.receivedMono === next.firstMono) next.bytes[arrival.kind].firstBatch += arrival.bytes;
}
export function mergeContentProgress(target: ContentProgress | undefined, source: ContentProgress | undefined): ContentProgress | undefined {
  if (!target) return source;
  if (!source || target === source) return target;
  if (target.receive && source.receive) taintContentProgress(target, "merged-receive-streams");
  else if (source.receive) {
    target.receive = { ...source.receive, bytes: { output: { ...source.receive.bytes.output }, reasoning: { ...source.receive.bytes.reasoning } } };
    if (source.fromCurrentStart !== true) taintContentProgress(target, "merged-recovered-content");
  }
  if (target.selectedStream && source.selectedStream && target.selectedStream !== source.selectedStream) taintContentProgress(target, "mixed-streams");
  target.selectedStream ??= source.selectedStream;
  for (const reason of source.taints ?? []) taintContentProgress(target, reason);
  for (const identity of source.stepIdentities ?? []) noteStepIdentity(target, identity);
  for (const [id, incoming] of source.parts) {
    const previous = target.parts.get(id);
    if (previous === incoming) continue;
    // Independent streams cannot prove byte identity/deduplication merely by
    // adding lengths. Preserve the uncertainty instead of inventing coverage.
    if (previous && previous.deltaBytes > 0 && incoming.deltaBytes > 0) taintContentProgress(target, "merged-delta-streams");
    const merged = previous ? { ...previous, deltaBytes: previous.deltaBytes + incoming.deltaBytes,
      snapshotBytes: incoming.snapshotDigest !== undefined ? incoming.snapshotBytes : previous.snapshotBytes, end: previous.end ?? incoming.end,
      start: previous.start ?? incoming.start, finalSnapshotBytes: incoming.finalSnapshotBytes ?? previous.finalSnapshotBytes,
      finalSnapshotDigest: incoming.finalSnapshotDigest ?? previous.finalSnapshotDigest,
      snapshotDigest: incoming.snapshotDigest ?? previous.snapshotDigest,
      deltaHasher: previous.deltaBytes > 0 ? previous.deltaHasher?.copy() : incoming.deltaHasher?.copy(),
      trimEndHasher: previous.deltaBytes > 0 ? previous.trimEndHasher?.copy() : incoming.trimEndHasher?.copy(),
      trimEndBytes: previous.deltaBytes > 0 ? previous.trimEndBytes : incoming.trimEndBytes,
      receivedBytes: (previous.receivedBytes ?? 0) + (incoming.receivedBytes ?? 0),
      knownGap: previous.knownGap || incoming.knownGap } : { ...incoming, deltaHasher: incoming.deltaHasher?.copy(), trimEndHasher: incoming.trimEndHasher?.copy() };
    target.parts.set(id, merged);
  }
  target.unknownCoverage ||= source.unknownCoverage;
  if (target.unknownCoverage && !target.taints?.size) taintContentProgress(target, "unknown-merged-coverage");
  for (const id of source.eventIDs) target.eventIDs.add(id);
  if (source.stepEnds) {
    target.stepEnds ??= new Set();
    for (const timestamp of source.stepEnds) target.stepEnds.add(timestamp);
  }
  return target;
}
/** Snapshots are pending facts, NOT ingress ordering or evidence of lost deltas.
 * Even a final-part notification may precede delivery of its deltas. Evaluate
 * only at actual response completion; preserve per-part final state on repeats. */
export function notePartSnapshot(progress: ContentProgress, properties: Record<string, any>): void {
  const part = properties.part;
  if (!object(part) || typeof part.type !== "string") return;
  if (typeof part.id !== "string" || !part.id) { taintContentProgress(progress, "anonymous-snapshot"); return; }
  if (part.type === "tool") taintContentProgress(progress, "tool-usage-uncertain");
  if (typeof part.stepID === "string") noteStepIdentity(progress, part.stepID);
  const callKey = typeof part.callID === "string" ? `call:${part.callID}` : undefined;
  const previous = progress.parts.get(part.id) ?? (callKey ? progress.parts.get(callKey) : undefined);
  if (previous && previous.type !== part.type && previous.deltaBytes > 0) taintContentProgress(progress, "part-kind-changed");
  const snapshotBytes = typeof part.text === "string" ? new TextEncoder().encode(part.text).length : undefined;
  const entry: ContentPartProgress = { ...previous, type: part.type, deltaBytes: previous?.deltaBytes ?? 0,
    snapshotBytes: snapshotBytes ?? previous?.snapshotBytes ?? 0,
    start: valid(part.time?.start) ? part.time.start : previous?.start,
    end: part.type === "text" || part.type === "reasoning" ? (valid(part.time?.end) ? part.time.end : previous?.end)
      : part.type === "tool" && part.state?.status === "running" && valid(part.state?.time?.start) ? part.state.time.start : previous?.end };
  // A midstream snapshot can legitimately be ahead of host delta delivery.
  // Store hashes only: no permanent content taint until completion comparison.
  if (["text", "output", "reasoning"].includes(part.type) && snapshotBytes !== undefined) {
    const snapshotDigest = createHash("sha256").update(part.text).digest("hex");
    entry.snapshotDigest = snapshotDigest;
    if (valid(part.time?.end) || properties.final === true) {
      entry.finalSnapshotBytes = snapshotBytes;
      entry.finalSnapshotDigest = snapshotDigest;
    }
  }
  progress.parts.set(part.id, entry);
  if (callKey) progress.parts.set(callKey, entry);
}
export function parseModelDelta(progress: ContentProgress, properties: Record<string, any>, event: Record<string, any>, stream: "legacy" | "v2", delta: string): { kind: "output" | "reasoning"; partID?: string } | undefined {
  const partID = properties.partID ?? properties.partId ?? properties.part?.id ?? properties.textID ?? properties.reasoningID
    ?? (typeof properties.callID === "string" ? `call:${properties.callID}` : undefined);
  const part = typeof partID === "string" ? progress.parts.get(partID) : undefined;
  const type = properties.part?.type ?? part?.type ?? properties.kind ?? properties.type
    ?? (properties.reasoningID !== undefined || properties.field === "reasoning" || event.type === "session.next.reasoning.delta" ? "reasoning"
      : properties.callID !== undefined || event.type === "session.next.tool.input.delta" ? "tool" : "text");
  const field = properties.field;
  if (stream === "legacy") {
    if (typeof type === "string" && !["text", "reasoning", "tool", "output"].includes(type)) return undefined;
    if (type === "tool" && field !== "input" && field !== "state.input" && field !== "state.raw") return undefined;
    if (typeof field === "string" && !["text", "reasoning", "input", "state.input", "state.raw"].includes(field)) return undefined;
    if (properties.output !== undefined || properties.result !== undefined) return undefined;
  }
  if (!delta.length) return undefined;
  const id = event.eventID ?? event.eventId ?? event.id ?? properties.eventID;
  if (typeof id === "string") {
    const identity = `${event.type}:${id}`;
    if (progress.eventIDs.has(identity)) return undefined;
    progress.eventIDs.add(identity);
  }
  if (progress.selectedStream && progress.selectedStream !== stream) taintContentProgress(progress, "mixed-streams");
  progress.selectedStream ??= stream;
  if (type === "tool") taintContentProgress(progress, "tool-usage-uncertain");
  if (typeof partID === "string") {
    const entry: ContentPartProgress = part ?? { type: typeof type === "string" ? type : "text", deltaBytes: 0, snapshotBytes: 0 };
    entry.deltaHasher ??= createHash("sha256");
    if (entry.deltaBytes === 0) { entry.trimEndHasher = createHash("sha256"); entry.trimEndBytes = 0; }
    // Whitespace from earlier chunks remains in the raw hash. If a later
    // non-whitespace character arrives it becomes INTERNAL content, so its
    // checkpoint includes that whitespace. No growing trailing-string buffer.
    const prefix = delta.trimEnd();
    if (prefix.length) {
      entry.deltaHasher.update(prefix);
      entry.trimEndHasher = entry.deltaHasher.copy();
      entry.trimEndBytes = entry.deltaBytes + new TextEncoder().encode(prefix).length;
    }
    entry.deltaHasher.update(delta.slice(prefix.length));
    entry.deltaBytes += new TextEncoder().encode(delta).length;
    progress.parts.set(partID, entry);
  } else taintContentProgress(progress, "anonymous-delta");
  return { kind: type === "reasoning" || properties.field === "reasoning" ? "reasoning" : "output", ...(typeof partID === "string" ? { partID } : {}) };
}
/** Compatibility wrapper; new consumers must use parseModelDelta's kind. */
export function acceptModelDelta(progress: ContentProgress, properties: Record<string, any>, event: Record<string, any>, stream: "legacy" | "v2", delta: string): boolean {
  return parseModelDelta(progress, properties, event, stream, delta) !== undefined;
}

/** v3 is an estimated HOST-RECEIVE rate, not provider generation timing. Only
 * first/last nonempty selected-stream content delta mono times form the span.
 * Clean current-start ownership, one deduplicated step, complete SHA-256-matched
 * final snapshots, and per-kind final usage are required. Thinking/part/step/
 * tool timestamps are never boundaries. Full usage coverage is independent
 * from the interval numerator, which excludes the whole global-first batch. */
export function contentSpeedObservations(record: HistoryRecord, progress: ContentProgress | undefined, firstOutput: number | undefined, usageExact: boolean, responseTimingExact: boolean, reasoningUsageKnown = true): SpeedObservations {
  const observations: SpeedObservations = { usageExact, responseTimingExact };
  const reject = (reason: string | string[], status: GenerationCoverage = "unknown"): SpeedObservations => {
    observations.generationCoverage = coerceGenerationCoverage({ status, reasons: Array.isArray(reason) ? reason : [reason] });
    return observations;
  };
  // firstOutput is legacy compatibility input, deliberately NOT a v3 boundary.
  void firstOutput;
  if (!progress) return reject("missing-content-observation");
  if (progress.taints?.size) return reject([...progress.taints], [...progress.taints].some((r) => r.includes("snapshot-delta")) ? "gap" : "unknown");
  if (progress.fromCurrentStart !== true) return reject("not-observed-from-current-start");
  if (!usageExact) return reject("unknown-final-usage");
  if (!reasoningUsageKnown) return reject("unknown-reasoning-usage");
  if (progress.unknownCoverage) return reject("unattributed-or-merged-deltas");
  if (progress.stepIdentities?.size !== 1) return reject("unknown-or-multiple-step-identities");
  if (!valid(record.time.completed)) return reject("unfinished-response");
  const parts = [...new Set(progress.parts.values())];
  const contentParts = parts.filter((p) => ["text", "output", "reasoning"].includes(p.type));
  if (parts.some((p) => p.type === "tool")) return reject("tool-usage-uncertain");
  if (contentParts.some((p) => p.knownGap)) return reject("snapshot-delta-gap", "gap");
  if (!contentParts.length || contentParts.some((p) => p.finalSnapshotBytes === undefined || p.finalSnapshotDigest === undefined)) return reject("missing-comparable-final-snapshot");
  for (const part of contentParts) {
    const strict = part.finalSnapshotBytes === part.deltaBytes
      && part.finalSnapshotDigest === (part.deltaHasher ?? createHash("sha256")).copy().digest("hex");
    const trailingRemoval = part.trimEndHasher !== undefined && part.finalSnapshotBytes === part.trimEndBytes
      && part.finalSnapshotDigest === part.trimEndHasher.copy().digest("hex");
    if (!strict && !trailingRemoval) {
      part.knownGap = true;
      const reason = part.finalSnapshotBytes! > part.deltaBytes ? "snapshot-delta-gap" : "snapshot-delta-mismatch";
      taintContentProgress(progress, reason);
      return reject(reason, "gap");
    }
  }
  const receive = progress.receive;
  if (!receive || !progress.selectedStream) return reject("missing-receive-observations");
  const span = receive.lastMono - receive.firstMono;
  if (receive.observationCount < 2 || !valid(span) || span < MIN_COMPLETED_OBSERVATION_MS) return reject("insufficient-receive-span");
  if (span < MIN_ROLLING_OBSERVATION_MS && receive.clockTrusted !== true) return reject("unknown-receive-clock");
  if (!completedSpanQualified(span, receive)) return reject("insufficient-receive-span");
  if (contentParts.some((p) => (p.receivedBytes ?? 0) !== p.deltaBytes)) {
    taintContentProgress(progress, "missing-byte-receive-timing");
    return reject("missing-byte-receive-timing");
  }
  if (record.tokens.reasoning > 0 && !contentParts.some((p) => p.type === "reasoning" && p.deltaBytes > 0)) return reject("hidden-reasoning");
  if (record.tokens.output > 0 && !contentParts.some((p) => (p.type === "text" || p.type === "output") && p.deltaBytes > 0)) return reject("unobserved-output");
  for (const kind of ["output", "reasoning"] as const) {
    const total = contentParts.filter((p) => (p.type === "reasoning" ? "reasoning" : "output") === kind).reduce((sum, p) => sum + p.deltaBytes, 0);
    if (receive.bytes[kind].total !== total) { taintContentProgress(progress, "receive-byte-mismatch"); return reject("receive-byte-mismatch"); }
  }
  const evidence: V3GenerationEvidence = { start: receive.firstWall, end: receive.lastWall,
    firstReceiveMono: receive.firstMono, lastReceiveMono: receive.lastMono, observationCount: receive.observationCount,
    version: 3, coverage: "complete", timeSource: "receive-monotonic", fromCurrentStart: true,
    selectedStream: progress.selectedStream, stepID: [...progress.stepIdentities][0],
    outputObserved: receive.bytes.output.total > 0, reasoningObserved: receive.bytes.reasoning.total > 0,
    bytes: { output: { ...receive.bytes.output }, reasoning: { ...receive.bytes.reasoning } },
    usage: { output: record.tokens.output, reasoning: record.tokens.reasoning },
    observationQuality: span < MIN_ROLLING_OBSERVATION_MS ? "short" : "standard",
    ...(receive.clockTrusted === true ? { clockSource: receive.clockSource, clockResolutionMs: receive.clockResolutionMs } : {}) };
  if (!intervalMeasurement(evidence)) return reject("invalid-v3-evidence");
  observations.generationCoverage = { status: "complete", reasons: [] };
  observations.generation = { ...evidence, complete: true, estimated: true };
  return observations;
}
