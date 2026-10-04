export function measureRecordSpeed(record, observations = {}) {
  const generatedTokens = record.tokens.output + record.tokens.reasoning;
  const speed = {};
  const start = record.time.start;
  const end = record.time.completed;
  if (valid(start) && valid(end) && end > start) {
    speed.response = {
      generatedTokens,
      durationMs: end - start,
      estimated: observations.usageExact !== true || observations.responseTimingExact !== true
    };
  }
  const generation = observations.generation;
  if (generation?.complete && valid(generation.start) && valid(generation.end) && generation.end > generation.start) {
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
        reasoningObserved: generation.reasoningObserved
      };
    }
  }
  return speed;
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
      reasoningObserved: evidence.reasoningObserved
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
  if (generationStatus === "invalidated") {
    delete next.generation;
    delete next.generationEvidence;
    return next;
  }
  if (next.generation || !prior?.generation) return next;
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
    target.parts.set(id, previous ? {
      type: previous.type,
      deltaBytes: previous.deltaBytes + incoming.deltaBytes,
      snapshotBytes: Math.max(previous.snapshotBytes, incoming.snapshotBytes),
      end: previous.end ?? incoming.end
    } : {
      ...incoming
    });
  }
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
  const content = typeof part.text === "string" ? part.text : "";
  const entry = {
    type: part.type,
    deltaBytes: previous?.deltaBytes ?? 0,
    snapshotBytes: Math.max(previous?.snapshotBytes ?? 0, new TextEncoder().encode(content).length),
    end: part.type === "text" || part.type === "reasoning" ? valid(part.time?.end) ? part.time.end : previous?.end : part.type === "tool" && part.state?.status === "running" && valid(part.state?.time?.start) ? part.state.time.start : previous?.end
  };
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
  }
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

/** Host 1.18.34: content end / tool-running start precede tool wait;
 * step-finish and tool-completed end do not. Arrival first-output is estimated. */
export function contentSpeedObservations(record, progress, firstOutput, usageExact, responseTimingExact, reasoningUsageKnown = true) {
  const observations = {
    usageExact,
    responseTimingExact
  };
  if (!progress || firstOutput === undefined || !valid(firstOutput)) return observations;
  if (!reasoningUsageKnown) return observations;
  if ((progress.stepEnds?.size ?? 0) > 1) return observations;
  const parts = [...new Set(progress.parts.values())];
  const modelParts = parts.filter(p => ["text", "reasoning", "tool"].includes(p.type));
  const ended = modelParts.filter(p => p.end !== undefined);
  // All known model parts must have an end boundary. Hidden reasoning must be observed.
  if (!modelParts.length || ended.length !== modelParts.length) return observations;
  if (record.tokens.reasoning > 0 && !parts.some(p => p.type === "reasoning" && p.deltaBytes > 0)) return observations;
  if (record.tokens.output > 0 && !parts.some(p => (p.type === "text" || p.type === "tool") && p.deltaBytes > 0)) return observations;
  const end = Math.max(...ended.map(p => p.end));
  const toolStart = parts.filter(p => p.type === "tool" && p.end !== undefined).map(p => p.end);
  // A later content end following tool-running evidence could be another round
  // on the same message. The gap cannot be presented as model generation.
  if (toolStart.length && parts.some(p => (p.type === "text" || p.type === "reasoning") && (p.end ?? 0) > Math.min(...toolStart))) return observations;
  if (firstOutput < record.time.start || end > (record.time.completed ?? end) || end <= firstOutput) return observations;
  observations.generation = {
    start: firstOutput,
    end,
    complete: true,
    estimated: true,
    outputObserved: parts.some(p => (p.type === "text" || p.type === "tool") && p.deltaBytes > 0),
    reasoningObserved: parts.some(p => p.type === "reasoning" && p.deltaBytes > 0)
  };
  return observations;
}
