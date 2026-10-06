export function measureRecordSpeed(record, observations = {}) {
  const generatedTokens = record.tokens.output + record.tokens.reasoning;
  const speed = {};
  if (!valid(record.tokens.output) || !valid(record.tokens.reasoning) || !valid(generatedTokens)) return speed;
  const start = record.time.start;
  const end = record.time.completed;
  speed.response = deriveSafeResponseMeasurement(record, {
    rawTimingKnown: true,
    ...observations
  });
  if (!speed.response) delete speed.response;
  const generation = observations.generation;
  if (generation?.complete && generation.version === 2 && generation.coverage === "complete" && valid(generation.start) && valid(generation.end) && generation.end > generation.start && valid(start) && valid(end) && generation.start >= start && generation.end <= end && typeof generation.outputObserved === "boolean" && typeof generation.reasoningObserved === "boolean" && (record.tokens.output === 0 || generation.outputObserved) && (record.tokens.reasoning === 0 || generation.reasoningObserved)) {
    speed.generation = {
      generatedTokens,
      durationMs: generation.end - generation.start,
      estimated: generation.estimated || observations.usageExact !== true
    };
    if (typeof generation.outputObserved === "boolean" && typeof generation.reasoningObserved === "boolean") {
      speed.generationEvidence = {
        start: generation.start,
        end: generation.end,
        outputObserved: generation.outputObserved,
        reasoningObserved: generation.reasoningObserved,
        version: 2,
        coverage: "complete"
      };
    }
  }
  return speed;
}

/** Only callers holding original start/completed facts may opt in. A normalized
 * zero start is not provenance. Response throughput includes TTFT/tool wait. */
export function deriveSafeResponseMeasurement(record, provenance) {
  const {
    start,
    completed
  } = record.time;
  const generatedTokens = record.tokens.output + record.tokens.reasoning;
  if (provenance.rawTimingKnown !== true || !valid(start) || !valid(completed) || completed <= start || !valid(record.tokens.output) || !valid(record.tokens.reasoning) || !valid(generatedTokens)) return undefined;
  return {
    generatedTokens,
    durationMs: completed - start,
    estimated: provenance.usageExact !== true || provenance.responseTimingExact !== true
  };
}
/** LAST, history and details share this decision. Never fabricate generation
 * from firstToken/completion, nor derive response from normalized old timing. */
export function selectSpeedMeasurement(record) {
  const speed = coerceSpeedContribution(record.speed);
  const generation = qualifiedGeneration(speed, record) ? speed?.generation : undefined;
  const response = speed?.response;
  const measurement = generation ?? response;
  const rate = measurement ? measurement.generatedTokens * 1000 / measurement.durationMs : undefined;
  const available = rate !== undefined && Number.isFinite(rate);
  return {
    available,
    ...(available ? {
      rate,
      basis: generation ? "generation" : "response",
      measurement
    } : {}),
    estimated: measurement?.estimated ?? true,
    coverage: {
      generation: !!generation,
      response: !!response,
      generatedTokens: available ? measurement.generatedTokens : 0,
      durationMs: available ? measurement.durationMs : 0
    }
  };
}
function qualifiedGeneration(speed, record) {
  const evidence = speed?.generationEvidence;
  if (!speed?.generation || !evidence || evidence.version !== 2 || evidence.coverage !== "complete" || evidence.end - evidence.start !== speed.generation.durationMs) return false;
  if (!record) return true;
  return valid(record.time.start) && valid(record.time.completed) && evidence.start >= record.time.start && evidence.end <= record.time.completed && (record.tokens.output === 0 || evidence.outputObserved) && (record.tokens.reasoning === 0 || evidence.reasoningObserved) && speed.generation.generatedTokens === record.tokens.output + record.tokens.reasoning;
}
export function emptySpeedTotals() {
  const zero = () => ({
    generatedTokens: 0,
    durationMs: 0,
    responseCount: 0,
    estimatedResponseCount: 0
  });
  return {
    generation: zero(),
    response: zero()
  };
}
export function coerceSpeedContribution(value) {
  if (!object(value)) return undefined;
  const result = {};
  for (const kind of ["generation", "response"]) {
    const m = value[kind];
    if (object(m) && valid(m.generatedTokens) && valid(m.durationMs) && m.durationMs > 0 && typeof m.estimated === "boolean") {
      result[kind] = {
        generatedTokens: m.generatedTokens,
        durationMs: m.durationMs,
        estimated: m.estimated
      };
    }
  }
  const evidence = value.generationEvidence;
  if (result.generation && object(evidence) && valid(evidence.start) && valid(evidence.end) && evidence.end > evidence.start && typeof evidence.outputObserved === "boolean" && typeof evidence.reasoningObserved === "boolean" && evidence.end - evidence.start === result.generation.durationMs) {
    result.generationEvidence = {
      start: evidence.start,
      end: evidence.end,
      outputObserved: evidence.outputObserved,
      reasoningObserved: evidence.reasoningObserved,
      ...(evidence.version === 2 && ["complete", "unknown", "gap"].includes(evidence.coverage) ? {
        version: 2,
        coverage: evidence.coverage
      } : {})
    };
  }
  return result.generation || result.response ? result : undefined;
}

/** Missing new generation observations are not an invalidation. Reuse requires
 * persisted interval AND category coverage; old snapshots without it cannot
 * grow a generation numerator or claim a newly corrected interval. */
export function mergeRecordSpeed(record, previous, generationStatus = "unobserved") {
  const next = coerceSpeedContribution(record.speed) ?? {};
  const prior = coerceSpeedContribution(previous?.speed);
  if (!qualifiedGeneration(next, record)) {
    delete next.generation;
    delete next.generationEvidence;
  }
  if (generationStatus === "invalidated") {
    delete next.generation;
    delete next.generationEvidence;
    return next;
  }
  if (next.generation || !prior?.generation || !qualifiedGeneration(prior)) return next;
  const evidence = prior.generationEvidence;
  if (!evidence || record.time.completed === undefined || evidence.start < record.time.start || evidence.end > record.time.completed || record.tokens.output > 0 && !evidence.outputObserved || record.tokens.reasoning > 0 && !evidence.reasoningObserved) return next;
  next.generation = {
    ...prior.generation,
    generatedTokens: record.tokens.output + record.tokens.reasoning,
    estimated: prior.generation.estimated || record.quality !== "exact"
  };
  next.generationEvidence = {
    ...evidence
  };
  return next;
}
export function coerceCompletionUpdate(value) {
  if (!object(value) || value.source !== "live" || typeof value.instanceID !== "string" || !valid(value.sequence) || !valid(value.receivedAt) || typeof value.fingerprint !== "string" || !Array.isArray(value.seenFingerprints) || !value.seenFingerprints.every(v => typeof v === "string")) return undefined;
  return {
    source: "live",
    instanceID: value.instanceID,
    sequence: value.sequence,
    receivedAt: value.receivedAt,
    ...(valid(value.revision) ? {
      revision: value.revision
    } : {}),
    fingerprint: value.fingerprint,
    seenFingerprints: [...value.seenFingerprints]
  };
}
/** Envelope revision is ordering evidence; provider completed/duration is not.
 * Otherwise explicitly-live updates use ingress order, not token volume.
 * Previously received facts remain replay, including after restart. */
export function isNewerCompletionUpdate(next, previous) {
  if (!previous) return true;
  if (next.revision !== undefined && previous.revision !== undefined && next.revision !== previous.revision) return next.revision > previous.revision;
  if (previous.fingerprint === next.fingerprint || previous.seenFingerprints.includes(next.fingerprint)) return false;
  return next.instanceID === previous.instanceID ? next.sequence > previous.sequence : next.receivedAt >= previous.receivedAt;
}
export function coerceSpeedTotals(value) {
  if (!object(value)) return undefined;
  const result = emptySpeedTotals();
  for (const kind of ["generation", "response"]) {
    const m = value[kind];
    if (!object(m) || !valid(m.generatedTokens) || !valid(m.durationMs) || !valid(m.responseCount) || !valid(m.estimatedResponseCount) || m.estimatedResponseCount > m.responseCount) return undefined;
    result[kind] = {
      generatedTokens: m.generatedTokens,
      durationMs: m.durationMs,
      responseCount: m.responseCount,
      estimatedResponseCount: m.estimatedResponseCount
    };
  }
  return result;
}
export function updateSpeedTotals(current, contribution, sign) {
  const speed = coerceSpeedContribution(contribution);
  if (!speed) return coerceSpeedTotals(current);
  const result = coerceSpeedTotals(current) ?? emptySpeedTotals();
  for (const kind of ["generation", "response"]) {
    const m = speed[kind];
    if (!m) continue;
    // Retain legacy measurements in coercion so reversible ledger corrections
    // can subtract old contributions; never add them as newly covered calls.
    if (kind === "generation" && sign === 1 && !qualifiedGeneration(speed)) continue;
    const a = result[kind];
    a.generatedTokens = Math.max(0, a.generatedTokens + sign * m.generatedTokens);
    a.durationMs = Math.max(0, a.durationMs + sign * m.durationMs);
    a.responseCount = Math.max(0, a.responseCount + sign);
    a.estimatedResponseCount = Math.max(0, a.estimatedResponseCount + sign * Number(m.estimated));
  }
  return result;
}
export function addSpeedTotals(left, right) {
  if (!left && !right) return undefined;
  const result = coerceSpeedTotals(left) ?? emptySpeedTotals();
  const incoming = coerceSpeedTotals(right) ?? emptySpeedTotals();
  for (const kind of ["generation", "response"]) {
    for (const field of ["generatedTokens", "durationMs", "responseCount", "estimatedResponseCount"]) result[kind][field] += incoming[kind][field];
  }
  return result;
}
export function sameSpeedContribution(left, right) {
  return JSON.stringify(coerceSpeedContribution(left)) === JSON.stringify(coerceSpeedContribution(right));
}
export function getSessionAverageSummary(directTotals) {
  const speed = coerceSpeedTotals(directTotals.speed) ?? emptySpeedTotals();
  const summary = a => ({
    available: a.durationMs > 0 && a.responseCount > 0,
    rate: a.durationMs > 0 && a.responseCount > 0 ? a.generatedTokens * 1000 / a.durationMs : undefined,
    estimated: a.estimatedResponseCount > 0,
    coveredGeneratedTokens: a.generatedTokens,
    coveredResponseCount: a.responseCount,
    estimatedResponseCount: a.estimatedResponseCount,
    durationMs: a.durationMs
  });
  return {
    generation: summary(speed.generation),
    response: {
      ...summary(speed.response),
      includesTTFT: true,
      mayIncludeToolWait: true
    },
    totalGeneratedTokens: directTotals.tokens.output + directTotals.tokens.reasoning,
    totalResponseCount: directTotals.responseCount
  };
}

/** Compare only timestamps in the same response interval/clock domain. */
export function earliestFirstOutput(start, completed, ...values) {
  const candidates = values.filter(v => valid(v) && v >= start && v <= completed);
  return candidates.length ? Math.min(...candidates) : undefined;
}
/** Match Host ReasoningPart visibility, not session busy/provider activity.
 * The caller must establish live ingress/current assistant ownership; history
 * and reconnect snapshots set live=false. This helper never creates samples. */
export function thinkingFirstResponseSignal(part, context) {
  if (!object(part) || !context.live || context.role !== "assistant" || context.completed !== undefined || part.type !== "reasoning" || part.messageID !== context.messageID || context.sessionID !== undefined && part.sessionID !== undefined && part.sessionID !== context.sessionID || part.role !== undefined && part.role !== "assistant" || part.time?.end != null || !valid(context.start) || !valid(context.now) || context.now < context.start) return undefined;
  const visibleText = typeof part.text === "string" ? part.text.replaceAll("[REDACTED]", "").trim() : "";
  if (!visibleText && !part.metadata) return undefined;
  const start = part.time?.start;
  if (valid(start) && start >= context.start && start <= context.now) {
    return {
      timestamp: start,
      source: "thinking",
      timeSource: "part-start",
      estimated: false
    };
  }
  return {
    timestamp: context.now,
    source: "thinking",
    timeSource: "arrival",
    estimated: true
  };
}

/** Earliest valid signal wins with its provenance; duplicate replay cannot
 * rewrite existing equal-time provenance. Neither alias nor samples change. */
export function applyFirstResponseSignal(time, signal) {
  if (!valid(time.start) || !valid(signal.timestamp) || signal.timestamp < time.start || time.completed !== undefined && (!valid(time.completed) || signal.timestamp > time.completed)) return {
    ...time
  };
  const prior = time.firstResponse;
  const priorValid = valid(prior) && prior >= time.start && (time.completed === undefined || prior <= time.completed);
  const content = earliestFirstOutput(time.start, time.completed ?? Infinity, time.firstContent, time.firstToken);
  if (priorValid && prior <= signal.timestamp && (content === undefined || prior <= content)) return {
    ...time
  };
  // Migrating an active legacy state must not replace an already earlier real
  // content fact with a later Thinking signal just because firstResponse is new.
  if (content !== undefined && content <= signal.timestamp && (!priorValid || content < prior)) {
    return {
      ...time,
      firstResponse: content,
      firstResponseSource: "content",
      firstResponseTimeSource: "arrival",
      firstResponseEstimated: true
    };
  }
  return {
    ...time,
    firstResponse: signal.timestamp,
    firstResponseSource: signal.source,
    firstResponseTimeSource: signal.timeSource,
    firstResponseEstimated: signal.estimated
  };
}

/** Actual model delta arrivals establish firstContent and its legacy alias.
 * Thinking alone can never establish either. Arrival time is estimated. */
export function recordContentArrival(time, timestamp) {
  if (!valid(time.start) || !valid(timestamp) || timestamp < time.start || time.completed !== undefined && (!valid(time.completed) || timestamp > time.completed)) return {
    ...time
  };
  const firstContent = earliestFirstOutput(time.start, time.completed ?? timestamp, time.firstContent, time.firstToken, timestamp);
  return applyFirstResponseSignal({
    ...time,
    firstContent,
    firstToken: firstContent
  }, {
    timestamp: firstContent,
    source: "content",
    timeSource: "arrival",
    estimated: true
  });
}
function valid(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function createContentMetadataCache() {
  return {
    progress: new Map(),
    roles: new Map(),
    completed: new Set(),
    nextSequence: 1
  };
}
export function cachedContentProgress(cache, messageID) {
  let progress = cache.progress.get(messageID);
  if (!progress) {
    progress = createContentProgress();
    cache.progress.set(messageID, progress);
  }
  return progress;
}
/** Only metadata: deliberately has no ActiveState argument or side effect. */
export function cachePartSnapshot(cache, properties) {
  const part = properties.part;
  if (!object(part) || typeof part.messageID !== "string") return;
  if (typeof part.role === "string") cache.roles.set(part.messageID, part.role);
  notePartSnapshot(cachedContentProgress(cache, part.messageID), properties);
}
export function createContentProgress() {
  return {
    parts: new Map(),
    eventIDs: new Set()
  };
}
export function mergeContentProgress(target, source) {
  if (!target) return source;
  if (!source || target === source) return target;
  for (const [id, incoming] of source.parts) {
    const previous = target.parts.get(id);
    if (previous === incoming) continue;
    // Independent streams cannot prove byte identity/deduplication merely by
    // adding lengths. Preserve the uncertainty instead of inventing coverage.
    if (previous && previous.deltaBytes > 0 && incoming.deltaBytes > 0) target.unknownCoverage = true;
    const merged = previous ? {
      ...previous,
      deltaBytes: previous.deltaBytes + incoming.deltaBytes,
      snapshotBytes: Math.max(previous.snapshotBytes, incoming.snapshotBytes),
      end: previous.end ?? incoming.end,
      start: previous.start ?? incoming.start,
      finalSnapshotBytes: incoming.finalSnapshotBytes ?? previous.finalSnapshotBytes,
      knownGap: previous.knownGap || incoming.knownGap
    } : {
      ...incoming
    };
    target.parts.set(id, merged);
  }
  target.unknownCoverage ||= source.unknownCoverage;
  for (const id of source.eventIDs) target.eventIDs.add(id);
  if (source.stepEnds) {
    target.stepEnds ??= new Set();
    for (const timestamp of source.stepEnds) target.stepEnds.add(timestamp);
  }
  return target;
}
/** Snapshots establish type/progress only; they are not real-time generation. */
export function notePartSnapshot(progress, properties) {
  const part = properties.part;
  if (!object(part) || typeof part.id !== "string" || typeof part.type !== "string") return;
  const callKey = typeof part.callID === "string" ? `call:${part.callID}` : undefined;
  const previous = progress.parts.get(part.id) ?? (callKey ? progress.parts.get(callKey) : undefined);
  const snapshotBytes = typeof part.text === "string" ? new TextEncoder().encode(part.text).length : undefined;
  const entry = {
    ...previous,
    type: part.type,
    deltaBytes: previous?.deltaBytes ?? 0,
    snapshotBytes: Math.max(previous?.snapshotBytes ?? 0, snapshotBytes ?? 0),
    start: valid(part.time?.start) ? part.time.start : previous?.start,
    end: part.type === "text" || part.type === "reasoning" ? valid(part.time?.end) ? part.time.end : previous?.end : part.type === "tool" && part.state?.status === "running" && valid(part.state?.time?.start) ? part.state.time.start : previous?.end
  };
  // Comparing UTF-8 text snapshots to UTF-8 text deltas is meaningful; token
  // calibration and tool JSON snapshots are not byte-coverage evidence.
  if ((part.type === "text" || part.type === "reasoning") && snapshotBytes !== undefined) {
    if (snapshotBytes > entry.deltaBytes) entry.knownGap = true;
    if (valid(part.time?.end)) entry.finalSnapshotBytes = snapshotBytes;
  }
  progress.parts.set(part.id, entry);
  if (callKey) progress.parts.set(callKey, entry);
}
export function parseModelDelta(progress, properties, event, stream, delta) {
  const partID = properties.partID ?? properties.partId ?? properties.part?.id ?? properties.textID ?? properties.reasoningID ?? (typeof properties.callID === "string" ? `call:${properties.callID}` : undefined);
  const part = typeof partID === "string" ? progress.parts.get(partID) : undefined;
  const type = properties.part?.type ?? part?.type ?? properties.kind ?? properties.type ?? (properties.reasoningID !== undefined || event.type === "session.next.reasoning.delta" ? "reasoning" : properties.callID !== undefined || event.type === "session.next.tool.input.delta" ? "tool" : "text");
  const field = properties.field;
  if (stream === "legacy") {
    if (typeof type === "string" && !["text", "reasoning", "tool", "output"].includes(type)) return undefined;
    if (type === "tool" && field !== "input" && field !== "state.input" && field !== "state.raw") return undefined;
    if (typeof field === "string" && !["text", "reasoning", "input", "state.input", "state.raw"].includes(field)) return undefined;
    if (properties.output !== undefined || properties.result !== undefined) return undefined;
  }
  const id = event.eventID ?? event.eventId ?? event.id ?? properties.eventID;
  if (typeof id === "string") {
    const identity = `${event.type}:${id}`;
    if (progress.eventIDs.has(identity)) return undefined;
    progress.eventIDs.add(identity);
  }
  if (typeof partID === "string") {
    const entry = part ?? {
      type: typeof type === "string" ? type : "text",
      deltaBytes: 0,
      snapshotBytes: 0
    };
    entry.deltaBytes += new TextEncoder().encode(delta).length;
    progress.parts.set(partID, entry);
  } else progress.unknownCoverage = true;
  return {
    kind: type === "reasoning" || properties.field === "reasoning" ? "reasoning" : "output",
    ...(typeof partID === "string" ? {
      partID
    } : {})
  };
}
/** Compatibility wrapper; new consumers must use parseModelDelta's kind. */
export function acceptModelDelta(progress, properties, event, stream, delta) {
  return parseModelDelta(progress, properties, event, stream, delta) !== undefined;
}

/** Version 2 coverage: a comparable final UTF-8 snapshot must equal captured
 * delta bytes for EVERY content part, with no previously known gap, original
 * start/end boundaries, known reasoning usage and no uncertain tool/multistep
 * span. Equal byte lengths are necessary, not proof of token identity or model
 * internal timing: generation remains estimated. Usage calibration cannot
 * satisfy any of these checks. Tool-running start excludes subsequent wait;
 * step-finish/tool-completed end are never generation end boundaries. */
export function contentSpeedObservations(record, progress, firstOutput, usageExact, responseTimingExact, reasoningUsageKnown = true) {
  const observations = {
    usageExact,
    responseTimingExact
  };
  const reject = (reason, status = "unknown") => {
    observations.generationCoverage = {
      status,
      reasons: [reason]
    };
    return observations;
  };
  if (!progress || firstOutput === undefined || !valid(firstOutput)) return reject("missing-content-observation");
  if (!reasoningUsageKnown) return reject("unknown-reasoning-usage");
  if (progress.unknownCoverage) return reject("unattributed-or-merged-deltas");
  if ((progress.stepEnds?.size ?? 0) > 1) return reject("multiple-steps");
  const parts = [...new Set(progress.parts.values())];
  const modelParts = parts.filter(p => ["text", "reasoning", "tool"].includes(p.type));
  const contentParts = modelParts.filter(p => p.type !== "tool");
  const ended = modelParts.filter(p => valid(p.end));
  if (contentParts.some(p => p.knownGap || p.finalSnapshotBytes !== undefined && p.finalSnapshotBytes !== p.deltaBytes)) return reject("snapshot-delta-gap", "gap");
  if (!modelParts.length || ended.length !== modelParts.length) return reject("missing-end-boundary");
  if (contentParts.some(p => !valid(p.start) || !valid(p.end) || p.start < record.time.start || p.start > p.end)) return reject("missing-or-invalid-start-boundary");
  if (contentParts.some(p => p.finalSnapshotBytes === undefined)) return reject("missing-comparable-final-snapshot");
  if (record.tokens.reasoning > 0 && !contentParts.some(p => p.type === "reasoning" && p.deltaBytes > 0)) return reject("hidden-reasoning");
  if (record.tokens.output > 0 && !contentParts.some(p => p.type === "text" && p.deltaBytes > 0)) return reject("unobserved-output");
  if (modelParts.some(p => p.type === "tool" && p.deltaBytes > 0)) return reject("tool-input-coverage-uncertain");
  const end = Math.max(...ended.map(p => p.end));
  const toolStart = parts.filter(p => p.type === "tool" && p.end !== undefined).map(p => p.end);
  // A later content end following tool-running evidence could be another round
  // on the same message. The gap cannot be presented as model generation.
  if (toolStart.length && contentParts.some(p => (p.end ?? 0) > Math.min(...toolStart))) return reject("content-after-tool-start");
  const start = Math.min(firstOutput, ...contentParts.map(p => p.start));
  if (!contentParts.length || !valid(record.time.completed) || firstOutput < record.time.start || firstOutput > end || end > record.time.completed || end <= start) return reject("invalid-response-interval");
  observations.generationCoverage = {
    status: "complete",
    reasons: []
  };
  observations.generation = {
    start,
    end,
    complete: true,
    estimated: true,
    version: 2,
    coverage: "complete",
    outputObserved: contentParts.some(p => p.type === "text" && p.deltaBytes > 0),
    reasoningObserved: contentParts.some(p => p.type === "reasoning" && p.deltaBytes > 0)
  };
  return observations;
}
