import { coerceScopeEvidence, collectSessionScopeEvidence } from "./scope.js";
export const ACTIVITY_VERSION = 2;
export const DEFAULT_ACTIVITY_INSTANCE_ID = "default";
export const LIFECYCLE_STATES = ["busy", "retry", "idle", "completed", "failed", "aborted", "cancelled", "stopped"];
const replayDiagnostics = new WeakMap();
/** Structural test hook, scoped to a returned replay object (no retained log). */
export function activityReplayDiagnostics(replay) {
  return {
    ...replayDiagnostics.get(replay)
  };
}
const ACTIVE_STATES = new Set(["busy", "retry"]);
const TERMINAL_STATES = new Set(["completed", "failed", "aborted", "cancelled", "stopped"]);

/** Returns true for the only states that contribute to active time. */
export function isActiveState(state) {
  return ACTIVE_STATES.has(state);
}
export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}
export function isLifecycleState(value) {
  return typeof value === "string" && LIFECYCLE_STATES.includes(value);
}

/**
 * Normalizes an untrusted JSON-ish event without depending on OpenCode or a
 * clock. Missing event IDs are replaced with a deterministic fingerprint.
 */
export function normalizeActivityEvent(value) {
  if (!isRecord(value)) return undefined;
  if (value.version !== undefined && value.version !== 1 && value.version !== ACTIVITY_VERSION) return undefined;
  const sessionID = nonEmptyString(value.sessionID);
  const timestamp = finiteNumberOrUndefined(value.timestamp);
  if (!sessionID || timestamp === undefined) return undefined;
  const observedAt = finiteNumberOrUndefined(value.observedAt) ?? timestamp;
  const instanceID = nonEmptyString(value.instanceID) ?? DEFAULT_ACTIVITY_INSTANCE_ID;
  const seqValue = finiteNumberOrUndefined(value.seq);
  const seq = seqValue === undefined ? undefined : Math.trunc(seqValue);
  const instanceEndedAt = finiteNumberOrUndefined(value.instanceEndedAt ?? value.instanceEndAt);
  const lastObservedAt = finiteNumberOrUndefined(value.lastObservedAt);
  const explicitKind = value.kind;
  const kind = explicitKind === "lifecycle" || explicitKind === "parent" || explicitKind === "work" || explicitKind === "execution-scope" ? explicitKind : explicitKind === undefined ? inferEventKind(value) : undefined;
  if (!kind) return undefined;
  const common = {
    version: value.version === 1 ? 1 : ACTIVITY_VERSION,
    kind,
    sessionID,
    timestamp,
    observedAt,
    instanceID,
    ...(seq === undefined ? {} : {
      seq
    }),
    ...(instanceEndedAt === undefined ? {} : {
      instanceEndedAt
    }),
    ...(lastObservedAt === undefined ? {} : {
      lastObservedAt
    }),
    ...(coerceScopeEvidence(value.scope) ? {
      scope: coerceScopeEvidence(value.scope)
    } : {}),
    ...(nonEmptyString(value.executionID) ? {
      executionID: value.executionID
    } : {}),
    ...(nonEmptyString(value.sourceEventID) ? {
      sourceEventID: value.sourceEventID
    } : {}),
    ...(Number.isSafeInteger(value.sourceSequence) ? {
      sourceSequence: value.sourceSequence
    } : {})
  };
  let event;
  if (kind === "lifecycle") {
    if (!isLifecycleState(value.state)) return undefined;
    const parentSessionID = normalizeParentSessionID(value.parentSessionID ?? value.parentSessionId);
    event = {
      ...common,
      kind: "lifecycle",
      state: value.state,
      ...(parentSessionID === undefined ? {} : {
        parentSessionID
      })
    };
  } else if (kind === "parent") {
    const rawParentSessionID = value.parentSessionID ?? value.parentSessionId;
    if (rawParentSessionID !== undefined && rawParentSessionID !== null && typeof rawParentSessionID !== "string") {
      return undefined;
    }
    const parentSessionID = normalizeParentSessionID(rawParentSessionID);
    event = {
      ...common,
      kind: "parent",
      ...(parentSessionID === undefined ? {} : {
        parentSessionID
      })
    };
  } else if (kind === "work") {
    const executionID = nonEmptyString(value.executionID);
    const workID = nonEmptyString(value.workID);
    const measurementScope = coerceScopeEvidence(value.measurementScope);
    if (value.version === 1 || !executionID || !workID || !measurementScope || !["step", "tool"].includes(value.source) || !["start", "end"].includes(value.phase)) return undefined;
    event = {
      ...common,
      kind,
      executionID,
      workID,
      source: value.source,
      phase: value.phase,
      measurementScope,
      ...(nonEmptyString(value.stepID) ? {
        stepID: value.stepID
      } : {})
    };
  } else {
    const executionID = nonEmptyString(value.executionID);
    if (value.version === 1 || !executionID || value.classification !== "pure-maintenance" || value.coverage !== "complete") return undefined;
    event = {
      ...common,
      kind,
      executionID,
      classification: "pure-maintenance",
      coverage: "complete"
    };
  }
  const suppliedEventID = nonEmptyString(value.eventID) ?? nonEmptyString(value.eventId);
  const eventID = suppliedEventID ?? activityEventFingerprint(event);
  return {
    ...event,
    eventID
  };
}
export function normalizeActivityEvents(values) {
  return values.map(normalizeActivityEvent).filter(event => event !== undefined);
}

/**
 * Dedupe by eventID plus the complete normalized event semantics. Identical
 * ID-less events share a fingerprint, while conflicting payloads that reuse
 * an explicit eventID remain distinct facts.
 */
export function dedupeActivityEvents(values) {
  const byDedupeKey = new Map();
  for (const value of values) {
    const event = normalizeActivityEvent(value);
    if (!event) continue;
    const dedupeKey = activityEventDedupeKey(event);
    if (!byDedupeKey.has(dedupeKey)) byDedupeKey.set(dedupeKey, event);
  }
  return [...byDedupeKey.values()];
}
export function compareActivityEvents(left, right) {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;

  // Sequence numbers are comparable only inside their observation epoch.
  if (left.instanceID === right.instanceID && left.sessionID === right.sessionID) {
    if (left.sourceSequence !== undefined && right.sourceSequence !== undefined && left.sourceSequence !== right.sourceSequence) return left.sourceSequence - right.sourceSequence;
    if (left.seq !== undefined && right.seq !== undefined && left.seq !== right.seq) return left.seq - right.seq;
  }
  if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt;
  // Stable sort preserves explicit receive order; never prioritize a state.
  return 0;
}
export function sortActivityEvents(values) {
  return dedupeActivityEvents(values).sort(compareActivityEvents);
}

/** Returns a stable, non-cryptographic fingerprint including boundary metadata. */
export function activityEventFingerprint(event) {
  return `fp-${fnv1a(activityEventSemanticCanonical(event))}`;
}
function activityEventSemanticCanonical(event) {
  return JSON.stringify([event.version, event.kind, event.sessionID, event.kind === "lifecycle" ? event.state : null, event.parentSessionID ?? null, event.timestamp, event.observedAt, event.instanceID, event.seq ?? null, event.instanceEndedAt ?? null, event.lastObservedAt ?? null, event.scope ?? null, event.executionID ?? null, event.sourceEventID ?? null, event.sourceSequence ?? null, event.kind === "work" ? [event.workID, event.source, event.phase, event.stepID ?? null, event.measurementScope] : null, event.kind === "execution-scope" ? ["pure-maintenance", "complete"] : null]);
}
function activityEventDedupeKey(event) {
  return JSON.stringify([event.eventID, activityEventSemanticCanonical(event)]);
}

/** Merges overlapping or adjacent half-open intervals. */
export function mergeIntervals(intervals) {
  const ordered = intervals.filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end)).map(interval => ({
    start: Math.min(interval.start, interval.end),
    end: Math.max(interval.start, interval.end)
  })).filter(interval => interval.end > interval.start).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) {
      merged.push({
        ...interval
      });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}
export function calculateActiveMilliseconds(intervals) {
  return mergeIntervals(intervals).reduce((total, interval) => total + (interval.end - interval.start), 0);
}
export const unionDurationMilliseconds = calculateActiveMilliseconds;

/**
 * Calculates the union of all lifecycle intervals in the supplied events.
 * Multiple sessions and process instances are kept separate until the final
 * union, so overlapping participants are never counted twice.
 */
export function calculateActiveIntervals(values, options = {}) {
  return mergeIntervals(replayActivity(values, options).participants.flatMap(participant => participant.intervals));
}
function activityParents(events, scopes = {}, parents) {
  const links = new Map();
  for (const [id, proof] of Object.entries(scopes)) if (proof.parentSessionID) links.set(id, proof.parentSessionID);
  for (const event of events) {
    if (event.kind === "parent" || event.parentSessionID !== undefined) links.set(event.sessionID, event.parentSessionID);
  }
  if (parents instanceof Map) for (const [id, parent] of parents) links.set(id, parent || undefined);else if (parents) for (const [id, parent] of Object.entries(parents)) links.set(id, parent || undefined);
  return links;
}
function cachedSessionEligible(id, scopes, parents, cache) {
  const path = [],
    seen = new Set();
  let current = id;
  let eligible = true;
  while (current && !seen.has(current)) {
    if (cache.has(current)) {
      eligible = cache.get(current);
      break;
    }
    seen.add(current);
    path.push(current);
    const proof = Object.prototype.hasOwnProperty.call(scopes, current) ? scopes[current] : undefined;
    if (proof?.sourceScope === "magic-session") {
      eligible = false;
      break;
    }
    current = parents.has(current) ? parents.get(current) : proof?.parentSessionID;
  }
  for (const item of path) cache.set(item, eligible);
  return eligible;
}

/** One shared eligibility decision for lifecycle, trees and interval metrics. */
export function filterActivityEvents(values, scopes = {}, parents) {
  const events = sortActivityEvents(values);
  scopes = collectSessionScopeEvidence(events, scopes);
  const links = activityParents(events, scopes, parents);
  const eligible = new Map();
  return events.filter(event => {
    if (event.scope?.sourceScope === "magic-message") return false;
    return cachedSessionEligible(event.sessionID, scopes, links, eligible);
  });
}
export const calculateSessionActiveIntervals = calculateActiveIntervals;

/**
 * Replays an append-only activity log. No implicit `Date.now()` boundary is
 * used: historical open intervals require explicit instance/observation bounds;
 * only a trusted current epoch may use a global cutoff as its end boundary.
 */
export function replayActivity(values, options = {}) {
  const replayOptions = normalizeReplayInput(options);
  const ordered = sortActivityEvents(values);
  const scopes = collectSessionScopeEvidence(ordered, replayOptions.sessionScopes);
  const allParents = activityParents(ordered, scopes, replayOptions.parentBySessionID);
  const replayCutoff = resolveGlobalCutoff(replayOptions);
  const bounded = replayCutoff === undefined ? ordered : ordered.filter(event => event.timestamp <= replayCutoff);
  const eligible = new Map();
  const sessionEligible = id => {
    return cachedSessionEligible(id, scopes, allParents, eligible);
  };
  const events = bounded.filter(event => event.scope?.sourceScope !== "magic-message" && sessionEligible(event.sessionID));
  const parentBySessionID = new Map([...allParents].filter(([id]) => sessionEligible(id)));
  const allSessionIDs = new Set();
  const factsByInstance = new Map();
  for (const event of events) {
    if (event.kind === "parent") continue;
    const key = streamKey(event.sessionID, event.instanceID);
    const facts = factsByInstance.get(key) ?? [];
    facts.push(event);
    factsByInstance.set(key, facts);
  }
  for (const event of events) {
    allSessionIDs.add(event.sessionID);
    if (event.parentSessionID) allSessionIDs.add(event.parentSessionID);
  }
  for (const sessionID of allSessionIDs) {
    const parentSessionID = parentBySessionID.get(sessionID);
    if (parentSessionID) allSessionIDs.add(parentSessionID);
  }
  const lifecycleBySession = new Map();
  for (const [key, stream] of factsByInstance) {
    const {
      sessionID,
      instanceID
    } = splitStreamKeyObject(key);
    const byInstance = lifecycleBySession.get(sessionID) ?? new Map();
    byInstance.set(instanceID, stream);
    lifecycleBySession.set(sessionID, byInstance);
  }
  const sortedSessionIDs = [...allSessionIDs].sort((left, right) => left.localeCompare(right));
  const timelines = new Map();
  for (const sessionID of sortedSessionIDs) {
    const instanceEvents = lifecycleBySession.get(sessionID) ?? new Map();
    const instances = [...instanceEvents.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([instanceID, instanceLifecycleEvents]) => projectInstanceFacts(instanceLifecycleEvents, sessionID, instanceID, replayOptions));
    const activeIntervals = mergeIntervals(instances.flatMap(instance => instance.intervals));
    const timeline = {
      sessionID,
      ...(parentBySessionID.get(sessionID) ? {
        parentSessionID: parentBySessionID.get(sessionID)
      } : {}),
      events: instances.flatMap(instance => instance.events).sort(compareActivityEvents),
      instances,
      activeIntervals,
      intervals: activeIntervals,
      activeMilliseconds: calculateActiveMilliseconds(activeIntervals),
      open: instances.some(instance => instance.open)
    };
    timelines.set(sessionID, timeline);
  }
  const rootIDs = new Set();
  const rootForSession = new Map();
  const sessionsByRoot = new Map();
  const metrics = {
    sessionAssignments: 0,
    parentVisits: 0
  };
  for (const sessionID of allSessionIDs) {
    metrics.sessionAssignments++;
    const rootSessionID = cachedRootSessionID(sessionID, parentBySessionID, rootForSession, metrics);
    const group = sessionsByRoot.get(rootSessionID) ?? [];
    group.push(sessionID);
    sessionsByRoot.set(rootSessionID, group);
    rootIDs.add(rootSessionID);
    if (!timelines.has(rootSessionID)) {
      const emptyTimeline = {
        sessionID: rootSessionID,
        ...(parentBySessionID.get(rootSessionID) ? {
          parentSessionID: parentBySessionID.get(rootSessionID)
        } : {}),
        events: [],
        instances: [],
        activeIntervals: [],
        intervals: [],
        activeMilliseconds: 0,
        open: false
      };
      timelines.set(rootSessionID, emptyTimeline);
    }
  }
  const roots = [...rootIDs].sort((left, right) => left.localeCompare(right)).map(rootSessionID => {
    const sessionIDs = (sessionsByRoot.get(rootSessionID) ?? []).sort((left, right) => left.localeCompare(right));
    if (!sessionIDs.includes(rootSessionID)) sessionIDs.unshift(rootSessionID);
    const participants = sessionIDs.map(sessionID => timelines.get(sessionID)).filter(timeline => timeline !== undefined);
    const activeIntervals = mergeIntervals(participants.flatMap(participant => participant.activeIntervals));
    return {
      rootSessionID,
      sessionIDs,
      descendantSessionIDs: sessionIDs.filter(sessionID => sessionID !== rootSessionID),
      participants,
      activeIntervals,
      intervals: activeIntervals,
      activeMilliseconds: calculateActiveMilliseconds(activeIntervals)
    };
  });
  const activeMillisecondsByRoot = new Map(roots.map(root => [root.rootSessionID, root.activeMilliseconds]));
  const rootActiveMilliseconds = Object.create(null);
  for (const root of roots) rootActiveMilliseconds[root.rootSessionID] = root.activeMilliseconds;
  const participants = [...timelines.values()].sort((left, right) => left.sessionID.localeCompare(right.sessionID));
  const result = {
    events,
    participants,
    participantTimelines: participants,
    timelines,
    parentBySessionID,
    roots,
    rootTasks: roots,
    activeMillisecondsByRoot,
    rootActiveMilliseconds
  };
  replayDiagnostics.set(result, metrics);
  return result;
}
export const replayActivityEvents = replayActivity;
export function resolveRootSessionID(sessionID, parentBySessionID) {
  const seen = new Map();
  const path = [];
  let current = sessionID;
  while (parentBySessionID.has(current)) {
    const cycleStart = seen.get(current);
    if (cycleStart !== undefined) {
      return [...path.slice(cycleStart), current].sort((left, right) => left.localeCompare(right))[0];
    }
    seen.set(current, path.length);
    path.push(current);
    const parent = parentBySessionID.get(current);
    if (!parent || parent === current) {
      return parent === current ? current : current;
    }
    current = parent;
  }
  return current;
}

/** Path compression, including canonical cycle representatives: each edge once. */
function cachedRootSessionID(id, parents, cache, metrics) {
  const path = [];
  const positions = new Map();
  let current = id;
  while (!cache.has(current) && !positions.has(current)) {
    metrics.parentVisits++;
    positions.set(current, path.length);
    path.push(current);
    const parent = parents.get(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  const cycle = positions.get(current);
  const root = cache.get(current) ?? (cycle !== undefined && parents.get(current) && parents.get(current) !== current ? path.slice(cycle).sort((a, b) => a.localeCompare(b))[0] : current);
  for (const item of path) cache.set(item, root);
  return root;
}
function compareStreamFacts(a, b) {
  if (a.sourceSequence !== undefined && b.sourceSequence !== undefined && a.sourceSequence !== b.sourceSequence) return a.sourceSequence - b.sourceSequence;
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
  return compareActivityEvents(a, b);
}

/** Shared interval subtraction. Inputs are unioned before the linear sweep. */
export function subtractActivityIntervals(base, removed) {
  return subtractIntervalsMeasured(base, removed);
}
function subtractIntervalsMeasured(base, removed, diagnostics) {
  const source = diagnostics ? mergeProjectionIntervals(base, diagnostics) : mergeIntervals(base);
  const cuts = diagnostics ? mergeProjectionIntervals(removed, diagnostics) : mergeIntervals(removed);
  const result = [];
  let index = 0;
  for (const interval of source) {
    if (diagnostics) diagnostics.intervalVisits++;
    let start = interval.start;
    while (index < cuts.length && cuts[index].end <= start) {
      if (diagnostics) diagnostics.intervalVisits++;
      index++;
    }
    for (let j = index; j < cuts.length && cuts[j].start < interval.end; j++) {
      if (diagnostics) diagnostics.intervalVisits++;
      if (diagnostics && Math.min(interval.end, cuts[j].start) > start) diagnostics.intervalMaterializations++;
      pushInterval(result, start, Math.min(interval.end, cuts[j].start));
      start = Math.max(start, cuts[j].end);
      if (start >= interval.end) break;
    }
    if (diagnostics && interval.end > start) diagnostics.intervalMaterializations++;
    pushInterval(result, start, interval.end);
  }
  return result;
}
function intersectIntervals(a, b, diagnostics) {
  const left = diagnostics ? mergeProjectionIntervals(a, diagnostics) : mergeIntervals(a);
  const right = diagnostics ? mergeProjectionIntervals(b, diagnostics) : mergeIntervals(b),
    result = [];
  let i = 0,
    j = 0;
  while (i < left.length && j < right.length) {
    if (diagnostics) {
      diagnostics.intervalVisits++;
      if (Math.min(left[i].end, right[j].end) > Math.max(left[i].start, right[j].start)) diagnostics.intervalMaterializations++;
    }
    pushInterval(result, Math.max(left[i].start, right[j].start), Math.min(left[i].end, right[j].end));
    if (left[i].end <= right[j].end) i++;else j++;
  }
  return result;
}
function workSpanKey(fact, source = fact.source, workID = fact.workID) {
  return JSON.stringify([fact.sessionID, fact.instanceID, fact.executionID, source, source === "tool" ? fact.stepID ?? null : null, workID]);
}
function collectWorkSpans(facts, visit, visitSpan) {
  const work = new Map();
  for (const fact of facts) {
    visit?.();
    if (fact.kind !== "work") continue;
    const key = workSpanKey(fact);
    const span = work.get(key) ?? {
      source: fact.source,
      workID: fact.workID,
      maintenance: false,
      normal: false,
      pending: true
    };
    if (fact.phase === "start") span.start = span.start === undefined ? fact.timestamp : Math.min(span.start, fact.timestamp);else span.end = span.end === undefined ? fact.timestamp : Math.max(span.end, fact.timestamp);
    const scope = fact.measurementScope.sourceScope;
    span.maintenance ||= scope === "magic-message" || scope === "magic-session";
    span.normal ||= scope === "user";
    span.pending = !span.maintenance && !span.normal;
    span.stepID = fact.stepID ?? span.stepID;
    if (fact.source === "tool" && fact.stepID) span.owningStepKey = workSpanKey(fact, "step", fact.stepID);
    work.set(key, span);
  }
  for (const span of work.values()) {
    visitSpan?.();
    if (span.owningStepKey && work.get(span.owningStepKey)?.maintenance) {
      span.maintenance = true;
      span.pending = false;
    }
  }
  return work;
}
function eligibleBusyIntervals(base, work, pure = false, visitSpan, diagnostics) {
  // Clock rollback is a zero-duration close, never a reversed busy interval.
  base = base.filter(interval => {
    if (diagnostics) diagnostics.intervalVisits++;
    return interval.end > interval.start;
  });
  if (diagnostics) diagnostics.intervalMaterializations += base.length;
  const maintenance = [],
    normal = [];
  for (const span of work) {
    visitSpan?.();
    // Neither an unpaired work boundary nor work outside busy creates time.
    if (span.start === undefined || span.end === undefined || span.end < span.start) continue;
    if (diagnostics && (span.maintenance || span.normal)) diagnostics.intervalMaterializations++;
    if (span.maintenance) maintenance.push({
      start: span.start,
      end: span.end
    });else if (span.normal) normal.push({
      start: span.start,
      end: span.end
    });
  }
  const remainder = pure ? [] : subtractIntervalsMeasured(base, maintenance, diagnostics);
  const restored = intersectIntervals(base, normal, diagnostics);
  if (diagnostics) diagnostics.intervalMaterializations += remainder.length + restored.length;
  return diagnostics ? mergeProjectionIntervals([...remainder, ...restored], diagnostics) : mergeIntervals([...remainder, ...restored]);
}
function projectExecutionFacts(facts, sessionID, instanceID, options, diagnostics) {
  const lifecycle = facts.filter(event => {
    if (diagnostics) diagnostics.factVisits++;
    if (!isLifecycleEvent(event)) return false;
    if (diagnostics) diagnostics.factMaterializations++;
    return true;
  }).sort((a, b) => {
    if (diagnostics) diagnostics.factSortComparisons++;
    return compareStreamFacts(a, b);
  });
  const result = calculateInstanceIntervals(lifecycle, sessionID, instanceID, options, diagnostics);
  const work = collectWorkSpans(facts, diagnostics && (() => {
    diagnostics.workFactVisits++;
    diagnostics.factVisits++;
  }), diagnostics && (() => diagnostics.workSpanVisits++));
  const complete = completeMaintenance(facts, lifecycle, work, result.boundary, diagnostics && (() => diagnostics.factVisits++), diagnostics && (() => diagnostics.workSpanVisits++));
  const intervals = eligibleBusyIntervals(result.intervals, work.values(), complete, diagnostics && (() => diagnostics.workSpanVisits++), diagnostics);
  return {
    ...result,
    intervals,
    activeIntervals: intervals,
    activeMilliseconds: intervalSum(intervals, diagnostics)
  };
}
function completeMaintenance(facts, lifecycle, work, boundary, visitFact, visitSpan) {
  const first = lifecycle[0],
    last = lifecycle[lifecycle.length - 1];
  if (!(facts.some(event => {
    visitFact?.();
    return event.kind === "execution-scope";
  }) && first?.state === "busy" && lifecycle.length > 1 && !isActiveState(last.state) && last.timestamp >= first.timestamp && (boundary === undefined || boundary >= last.timestamp) && work.size > 0)) return false;
  for (const span of work.values()) {
    visitSpan?.();
    if (!(span.maintenance && !span.pending && span.start !== undefined && span.end !== undefined && span.start >= first.timestamp && span.end >= span.start && span.end <= last.timestamp)) return false;
  }
  return true;
}
function projectInstanceFacts(facts, sessionID, instanceID, options, diagnostics) {
  const executions = new Map();
  for (const fact of facts) {
    if (diagnostics) {
      diagnostics.factVisits++;
      diagnostics.factMaterializations++;
    }
    const key = JSON.stringify(fact.executionID ?? null);
    const stream = executions.get(key) ?? [];
    stream.push(fact);
    executions.set(key, stream);
  }
  const streams = [...executions.values()];
  const latest = streams.reduce((last, stream) => {
    if (diagnostics) diagnostics.streamVisits++;
    const first = stream.find(event => {
      if (diagnostics) diagnostics.factVisits++;
      return isLifecycleEvent(event) && isActiveState(event.state);
    });
    return first && (!last || compareStreamFacts(last, first) <= 0) ? first : last;
  }, undefined);
  const projections = streams.map(stream => projectExecutionFacts(stream, sessionID, instanceID, latest && stream[0].executionID !== latest.executionID ? {
    ...options,
    trustedCurrentInstanceID: undefined
  } : options, diagnostics));
  const flattened = projections.flatMap(projection => {
    if (diagnostics) diagnostics.intervalMaterializations += projection.intervals.length;
    return projection.intervals;
  });
  const intervals = diagnostics ? mergeProjectionIntervals(flattened, diagnostics) : mergeIntervals(flattened);
  const events = facts.filter(event => {
    if (diagnostics) diagnostics.factVisits++;
    if (!isLifecycleEvent(event)) return false;
    if (diagnostics) diagnostics.factMaterializations++;
    return true;
  }).sort((a, b) => {
    if (diagnostics) diagnostics.factSortComparisons++;
    return compareStreamFacts(a, b);
  });
  return {
    sessionID,
    instanceID,
    events,
    intervals,
    activeIntervals: intervals,
    activeMilliseconds: intervalSum(intervals, diagnostics),
    open: projections.some(projection => projection.open),
    currentState: events[events.length - 1]?.state,
    boundary: resolveInstanceBoundary(events, sessionID, instanceID, options, diagnostics)
  };
}
function intervalSum(intervals, diagnostics) {
  return intervals.reduce((sum, interval) => {
    if (diagnostics) diagnostics.intervalVisits++;
    return sum + interval.end - interval.start;
  }, 0);
}
/** Reversible union. Each execution contributes coverage counts, not a duration
 * subtraction from the global union. Treap range updates preserve overlaps with
 * normal tools, parallel executions and children. Endpoints stay exact doubles. */
class CoverageIndex {
  root;
  sequence = 0;
  constructor(visit, diagnostics) {
    this.visit = visit;
    this.diagnostics = diagnostics;
  }
  make(start, end, count) {
    this.visit();
    // Stable mixed priorities: no clock/random dependency in shared math.
    let hash = ++this.sequence;
    hash = Math.imul(hash ^ hash >>> 16, 0x21f0aaad);
    hash = Math.imul(hash ^ hash >>> 15, 0x735a2d97);
    const length = end - start;
    return {
      start,
      end,
      count,
      priority: (hash ^ hash >>> 15) >>> 0,
      lazy: 0,
      minimum: count,
      minimumLength: length,
      length,
      first: start,
      last: end
    };
  }
  shift(node, delta) {
    if (!node) return;
    this.visit();
    node.count += delta;
    node.minimum += delta;
    node.lazy += delta;
  }
  push(node) {
    this.visit();
    if (!node.lazy) return;
    this.shift(node.left, node.lazy);
    this.shift(node.right, node.lazy);
    node.lazy = 0;
  }
  pull(node) {
    this.visit();
    node.minimum = Math.min(node.count, node.left?.minimum ?? Infinity, node.right?.minimum ?? Infinity);
    node.length = node.end - node.start + (node.left?.length ?? 0) + (node.right?.length ?? 0);
    node.minimumLength = (node.count === node.minimum ? node.end - node.start : 0) + (node.left?.minimum === node.minimum ? node.left.minimumLength : 0) + (node.right?.minimum === node.minimum ? node.right.minimumLength : 0);
    node.first = node.left?.first ?? node.start;
    node.last = node.right?.last ?? node.end;
    return node;
  }
  merge(left, right) {
    if (left) this.visit();
    if (right) this.visit();
    if (!left || !right) return left ?? right;
    if (left.priority < right.priority) {
      this.push(left);
      left.right = this.merge(left.right, right);
      return this.pull(left);
    }
    this.push(right);
    right.left = this.merge(left, right.left);
    return this.pull(right);
  }
  split(node, at) {
    if (!node) return [undefined, undefined];
    this.visit();
    this.push(node);
    if (at <= node.start) {
      const [left, middle] = this.split(node.left, at);
      node.left = undefined;
      return [left, this.merge(middle, this.pull(node))];
    }
    if (at >= node.end) {
      const [middle, right] = this.split(node.right, at);
      node.right = undefined;
      return [this.merge(this.pull(node), middle), right];
    }
    return [this.merge(node.left, this.make(node.start, at, node.count)), this.merge(this.make(at, node.end, node.count), node.right)];
  }
  covered(node) {
    if (!node) return 0;
    this.visit();
    return node.length - (node.minimum === 0 ? node.minimumLength : 0);
  }
  get total() {
    return this.covered(this.root);
  }
  add(interval, count = 1) {
    this.change(interval, count);
  }
  remove(interval, count = 1) {
    this.change(interval, -count);
  }
  forEachCovered(visit, range) {
    const walk = node => {
      if (!node) return;
      this.visit();
      if (range && (node.last <= range.start || node.first >= range.end)) return;
      if (node.minimum === 0 && node.minimumLength === node.length) return;
      this.push(node);
      walk(node.left);
      if (node.count > 0) {
        const start = Math.max(node.start, range?.start ?? node.start),
          end = Math.min(node.end, range?.end ?? node.end);
        if (end > start) {
          if (this.diagnostics) this.diagnostics.intervalMaterializations++;
          visit({
            start,
            end
          }, node.count);
        }
      }
      walk(node.right);
    };
    walk(this.root);
  }
  change({
    start,
    end
  }, delta) {
    if (end <= start) return;
    if (!this.root) this.root = this.make(start, end, 0);
    this.visit();
    if (start < this.root.first) this.root = this.merge(this.make(start, this.root.first, 0), this.root);
    if (end > this.root.last) this.root = this.merge(this.root, this.make(this.root.last, end, 0));
    const [left, rest] = this.split(this.root, start);
    const [middle, right] = this.split(rest, end);
    this.shift(middle, delta);
    if (middle && middle.minimum < 0) throw new Error("Activity coverage removed an unowned interval");
    this.root = this.merge(this.merge(left, middle), right);
  }
  overlap({
    start,
    end
  }) {
    const sum = node => {
      if (!node) return 0;
      this.visit();
      if (node.last <= start || node.first >= end) return 0;
      if (start <= node.first && node.last <= end) return this.covered(node);
      this.push(node);
      return (node.count > 0 ? Math.max(0, Math.min(end, node.end) - Math.max(start, node.start)) : 0) + sum(node.left) + sum(node.right);
    };
    return sum(this.root);
  }
  uncovered({
    start,
    end
  }) {
    const result = [];
    const walk = node => {
      if (!node) return;
      this.visit();
      if (node.last <= start || node.first >= end) return;
      if (node.minimum > 0) return;
      if (node.minimumLength === node.length) {
        pushInterval(result, Math.max(start, node.first), Math.min(end, node.last));
        return;
      }
      this.push(node);
      walk(node.left);
      if (node.count === 0) pushInterval(result, Math.max(start, node.start), Math.min(end, node.end));
      walk(node.right);
    };
    if (this.root) {
      this.visit();
      pushInterval(result, start, Math.min(end, this.root.first));
      walk(this.root);
      pushInterval(result, Math.max(start, this.root.last), end);
    } else pushInterval(result, start, end);
    if (this.diagnostics) this.diagnostics.intervalMaterializations += result.length;
    return this.diagnostics ? mergeProjectionIntervals(result, this.diagnostics) : mergeIntervals(result);
  }
}

/** Incremental cache of the SAME span classification used by collectWorkSpans.
 * Only a changed span and tools inheriting its maintenance proof are revisited. */
class WorkSpanIndex {
  spans = new Map();
  tools = new Map();
  earliestToolStart = new Map();
  maintenance;
  normal;
  maxEnd = -Infinity;
  minStart = Infinity;
  invalidMaintenance = 0;
  constructor(make, diagnostics) {
    this.diagnostics = diagnostics;
    this.maintenance = make();
    this.normal = make();
  }
  inspect(fact, start) {
    this.diagnostics.workSpanVisits++;
    const key = workSpanKey(fact),
      span = this.spans.get(key);
    const maintenance = fact.measurementScope.sourceScope === "magic-message" || fact.measurementScope.sourceScope === "magic-session";
    return {
      refinement: !!span && (fact.phase === "start" ? span.start !== undefined && fact.timestamp >= span.start : span.end !== undefined && fact.timestamp <= span.end),
      earlier: start !== undefined && (span?.start !== undefined && span.start < start || fact.source === "step" && maintenance && !span?.maintenance && (this.earliestToolStart.get(key) ?? Infinity) < start)
    };
  }
  pure(range, boundary) {
    return !!range && this.spans.size > 0 && this.invalidMaintenance === 0 && this.minStart >= range.start && this.maxEnd <= range.end && (boundary === undefined || boundary >= range.end);
  }
  update(fact) {
    this.diagnostics.workFactVisits++;
    const key = workSpanKey(fact),
      previous = this.spans.get(key);
    const span = previous ?? {
      source: fact.source,
      workID: fact.workID,
      maintenance: false,
      ownMaintenance: false,
      validMaintenance: false,
      normal: false,
      pending: true
    };
    if (!previous) this.invalidMaintenance++;
    this.spans.set(key, span);
    if (fact.phase === "start") span.start = Math.min(span.start ?? Infinity, fact.timestamp);else span.end = Math.max(span.end ?? -Infinity, fact.timestamp);
    span.ownMaintenance ||= fact.measurementScope.sourceScope === "magic-message" || fact.measurementScope.sourceScope === "magic-session";
    span.normal ||= fact.measurementScope.sourceScope === "user";
    span.stepID = fact.stepID ?? span.stepID;
    if (fact.source === "tool" && fact.stepID) {
      span.owningStepKey = workSpanKey(fact, "step", fact.stepID);
      let tools = this.tools.get(span.owningStepKey);
      if (!tools) {
        tools = new Set();
        this.tools.set(span.owningStepKey, tools);
      }
      tools.add(key);
      if (span.start !== undefined) this.earliestToolStart.set(span.owningStepKey, Math.min(this.earliestToolStart.get(span.owningStepKey) ?? Infinity, span.start));
    }
    const changed = [];
    const update = item => {
      this.diagnostics.workSpanVisits++;
      if (!item.validMaintenance) this.invalidMaintenance--;
      item.maintenance = item.ownMaintenance || !!(item.owningStepKey && this.spans.get(item.owningStepKey)?.maintenance);
      item.pending = !item.maintenance && !item.normal;
      item.validMaintenance = item.maintenance && !item.pending && item.start !== undefined && item.end !== undefined && item.end >= item.start;
      if (!item.validMaintenance) this.invalidMaintenance++;
      if (item.start !== undefined) this.minStart = Math.min(this.minStart, item.start);
      if (item.start !== undefined && item.end !== undefined) this.maxEnd = Math.max(this.maxEnd, item.end);
      if (item.indexed && item.indexed.interval.start === item.start && item.indexed.interval.end === item.end && item.indexed.maintenance === item.maintenance) return;
      if (item.indexed) {
        this.diagnostics.intervalVisits++;
        this.diagnostics.intervalMaterializations++;
        (item.indexed.maintenance ? this.maintenance : this.normal).remove(item.indexed.interval);
        changed.push(item.indexed.interval);
        item.indexed = undefined;
      }
      if (item.start !== undefined && item.end !== undefined) {
        this.maxEnd = Math.max(this.maxEnd, item.end);
        if (!item.pending && item.end > item.start) {
          const interval = {
            start: item.start,
            end: item.end
          };
          this.diagnostics.intervalVisits++;
          this.diagnostics.intervalMaterializations++;
          (item.maintenance ? this.maintenance : this.normal).add(interval);
          item.indexed = {
            interval,
            maintenance: item.maintenance
          };
          changed.push(interval);
        }
      }
    };
    const inherited = span.maintenance;
    update(span);
    if (fact.source === "step" && !inherited && span.maintenance) for (const tool of this.tools.get(key) ?? []) update(this.spans.get(tool));
    return changed;
  }
  eligible(range) {
    if (range.end <= range.start) return [];
    this.diagnostics.intervalVisits++;
    // Avoid enumerating unrelated normal spans when nothing is subtracted.
    if (this.maintenance.overlap(range) === 0 || this.normal.overlap(range) === range.end - range.start) {
      this.diagnostics.intervalMaterializations++;
      return [range];
    }
    const normal = [];
    this.normal.forEachCovered(interval => {
      this.diagnostics.intervalVisits++;
      this.diagnostics.intervalMaterializations++;
      normal.push(interval);
    }, range);
    const remaining = this.maintenance.uncovered(range);
    this.diagnostics.intervalMaterializations += remaining.length * 2 + normal.length;
    return mergeProjectionIntervals([...remaining, ...normal], this.diagnostics);
  }
}
function mergeProjectionIntervals(intervals, diagnostics) {
  diagnostics.intervalMaterializations += intervals.length;
  const sorted = [...intervals].sort((a, b) => {
    diagnostics.intervalSortComparisons++;
    return a.start - b.start || a.end - b.end;
  });
  const result = [];
  for (const interval of sorted) {
    diagnostics.intervalVisits++;
    const last = result[result.length - 1];
    if (interval.end <= interval.start) continue;
    if (last && last.end >= interval.start) last.end = Math.max(last.end, interval.end);else {
      result.push({
        ...interval
      });
      diagnostics.intervalMaterializations++;
    }
  }
  return result;
}
const projectionDiagnostics = new WeakMap();
/** Narrow structural test hook; not persisted or used by the collector. */
export function activityProjectionDiagnostics(projector) {
  return {
    ...projectionDiagnostics.get(projector)
  };
}

/**
 * Incremental execution projection. Per-view coverage indexes support replacing
 * one execution without replaying historical streams. Clock-only reads inspect
 * active streams and cached coverage; late proof repairs only its execution.
 */
export function createActivityProjector(initial = []) {
  const nodes = new Map();
  const streams = new Map();
  const latestExecutions = new Map();
  const identities = new Set();
  const identitySets = new Map();
  const selections = new Map();
  const fullKey = key => JSON.stringify([key.sessionID, key.instanceID, key.executionID ?? null]);
  const scopes = Object.create(null);
  const factScopes = Object.create(null);
  const factParents = new Map();
  const parentContext = new Map();
  const scopeContext = Object.create(null);
  let context = {};
  let maximumTimestamp = -Infinity;
  const diagnostics = {
    ingested: 0,
    lifecycleTransitions: 0,
    coldFactVisits: 0,
    snapshotBuilds: 0,
    clockStreamVisits: 0,
    indexStreamVisits: 0,
    indexBuilds: 0,
    indexNodeVisits: 0,
    snapshotStreamVisits: 0,
    workFactVisits: 0,
    nodeVisits: 0,
    ancestorVisits: 0,
    intervalVisits: 0,
    streamVisits: 0,
    identityVisits: 0,
    factVisits: 0,
    contextNodeVisits: 0,
    workSpanVisits: 0,
    factSortComparisons: 0,
    intervalMaterializations: 0,
    intervalSortComparisons: 0,
    factMaterializations: 0
  };
  const coverage = () => new CoverageIndex(() => diagnostics.indexNodeVisits++, diagnostics);
  const node = id => {
    diagnostics.nodeVisits++;
    let value = nodes.get(id);
    if (!value) {
      value = {
        id,
        children: new Set(),
        streams: new Set(),
        active: new Set(),
        localActive: new Set(),
        raw: coverage(),
        revision: 0,
        snapshots: new Map()
      };
      nodes.set(id, value);
    }
    return value;
  };
  const ancestors = id => {
    const result = [],
      seen = new Set();
    let current = id;
    while (current && !seen.has(current)) {
      diagnostics.ancestorVisits++;
      seen.add(current);
      const item = node(current);
      result.push(item);
      current = item.parent;
    }
    return result;
  };
  const excluded = id => {
    const path = [],
      positions = new Map();
    let current = id,
      inherited = false;
    while (current && !positions.has(current)) {
      diagnostics.ancestorVisits++;
      const item = node(current);
      if (item.excluded !== undefined) {
        inherited = item.excluded;
        break;
      }
      positions.set(current, path.length);
      path.push(item);
      current = item.parent;
    }
    if (current && positions.has(current)) for (let i = positions.get(current); i < path.length; i++) {
      diagnostics.nodeVisits++;
      inherited ||= scopes[path[i].id]?.sourceScope === "magic-session";
    }
    for (let i = path.length - 1; i >= 0; i--) {
      diagnostics.nodeVisits++;
      inherited ||= scopes[path[i].id]?.sourceScope === "magic-session";
      path[i].excluded = inherited;
    }
    return node(id).excluded ?? false;
  };
  const resolvedParent = id => {
    if (parentContext.has(id)) return parentContext.get(id) || undefined;
    return factParents.has(id) ? factParents.get(id) : scopes[id]?.parentSessionID;
  };
  const touch = item => {
    item.revision++;
  };
  const descendants = id => {
    const result = [],
      seen = new Set(),
      pending = [id];
    while (pending.length) {
      const next = pending.pop();
      diagnostics.contextNodeVisits++;
      if (seen.has(next)) continue;
      seen.add(next);
      const item = node(next);
      result.push(item);
      for (const child of item.children) pending.push(child);
    }
    return result;
  };
  function* historicalStreams(item) {
    for (const stream of item.streams) {
      diagnostics.indexStreamVisits++;
      yield stream;
    }
  }
  const weightedSubtree = id => {
    const result = [];
    if (excluded(id)) return result;
    const pending = [id],
      seen = new Set();
    while (pending.length) {
      const next = pending.pop();
      diagnostics.contextNodeVisits++;
      if (seen.has(next)) continue;
      seen.add(next);
      const item = node(next);
      if (scopes[next]?.sourceScope === "magic-session") continue;
      item.raw.forEachCovered((interval, count) => {
        diagnostics.intervalVisits++;
        result.push({
          interval,
          count
        });
      });
      for (const child of item.children) pending.push(child);
    }
    return result;
  };
  const transfer = (items, intervals, add) => {
    for (const item of items) {
      diagnostics.contextNodeVisits++;
      item.snapshots.clear();
      if (item.including) for (const {
        interval,
        count
      } of intervals) {
        diagnostics.intervalVisits++;
        if (add) item.including.add(interval, count);else item.including.remove(interval, count);
      }
      touch(item);
    }
  };
  const mutateMetadata = (id, mutate) => {
    const item = node(id),
      subtree = descendants(id),
      member = new Set(subtree.map(entry => entry.id));
    // Empty leaves can establish rich parent snapshots without walking every
    // ancestor chain merely to transfer zero coverage/zero active identities.
    const emptyLeaf = item.children.size === 0 && item.raw.total === 0 && item.active.size === 0;
    const before = emptyLeaf ? [] : ancestors(id).slice(1);
    const moving = emptyLeaf ? [] : weightedSubtree(id);
    const active = [...item.active];
    diagnostics.streamVisits += active.length;
    // A parent cycle changes reachability within the moving subtree. Its cold
    // cache repair below uses cached per-node coverage, never execution facts.
    let cycle = before.some(entry => member.has(entry.id));
    if (!cycle) transfer(before, moving, false);
    for (const ancestor of before) for (const stream of active) {
      diagnostics.streamVisits++;
      ancestor.active.delete(stream);
    }
    const previousParent = item.parent;
    mutate();
    const parent = resolvedParent(id);
    if (previousParent !== parent) {
      if (previousParent) node(previousParent).children.delete(id);
      item.parent = parent;
      if (parent) node(parent).children.add(id);
    }
    for (const entry of subtree) {
      diagnostics.contextNodeVisits++;
      entry.excluded = undefined;
      entry.direct = undefined;
      entry.including = undefined;
      entry.snapshots.clear();
      touch(entry);
    }
    const after = emptyLeaf ? [] : ancestors(id).slice(1);
    cycle ||= after.some(entry => member.has(entry.id));
    if (cycle) {
      const affected = new Set([...subtree, ...before, ...after]);
      const candidates = new Set();
      for (const entry of affected) {
        diagnostics.contextNodeVisits++;
        entry.including = undefined;
        entry.excluded = undefined;
        entry.snapshots.clear();
        touch(entry);
        for (const stream of entry.active) {
          diagnostics.streamVisits++;
          candidates.add(stream);
        }
        for (const stream of entry.localActive) {
          diagnostics.streamVisits++;
          candidates.add(stream);
        }
        entry.active.clear();
      }
      for (const stream of candidates) for (const ancestor of ancestors(stream.sessionID)) {
        diagnostics.streamVisits++;
        if (affected.has(ancestor)) ancestor.active.add(stream);
      }
    } else {
      transfer(after, weightedSubtree(id), true);
      for (const ancestor of after) for (const stream of active) {
        diagnostics.streamVisits++;
        ancestor.active.add(stream);
      }
    }
  };
  const applyClosed = (stream, interval, add) => {
    if (stream.hidden || stream.retired) return;
    diagnostics.intervalVisits++;
    const item = node(stream.sessionID);
    if (add) item.raw.add(interval);else item.raw.remove(interval);
    if (!excluded(stream.sessionID)) {
      const targets = [item.direct, ...ancestors(stream.sessionID).map(entry => entry.including)];
      for (const target of targets) if (target) {
        diagnostics.intervalVisits++;
        if (add) target.add(interval);else target.remove(interval);
      }
      for (const ancestor of ancestors(stream.sessionID)) for (const view of ancestor.snapshots.values()) {
        diagnostics.nodeVisits++;
        if (!view.including && ancestor.id !== stream.sessionID) continue;
        if (view.coverage) {
          diagnostics.intervalVisits++;
          if (add) view.coverage.add(interval);else view.coverage.remove(interval);
        }
      }
    }
  };
  const syncActive = stream => {
    const active = !stream.hidden && !stream.retired && stream.activeStart !== undefined;
    const item = node(stream.sessionID);
    if (active) item.localActive.add(stream);else item.localActive.delete(stream);
    for (const ancestor of ancestors(stream.sessionID)) {
      if (active) ancestor.active.add(stream);else ancestor.active.delete(stream);
      touch(ancestor);
    }
  };
  const prefixIntervals = (stream, range) => {
    const result = [];
    stream.live?.prefix.forEachCovered(interval => {
      diagnostics.intervalVisits++;
      diagnostics.intervalMaterializations++;
      result.push(interval);
    }, range);
    return result;
  };
  const ensureLive = stream => {
    const anchor = Math.max(stream.activeStart, stream.work.maxEnd, stream.maxLifecycle);
    if (!stream.live) {
      const start = stream.activeStart,
        prefix = coverage();
      for (const interval of stream.work.eligible({
        start,
        end: anchor
      })) {
        diagnostics.intervalVisits++;
        prefix.add(interval);
      }
      stream.live = {
        start,
        anchor,
        prefix
      };
    } else if (anchor > stream.live.anchor) {
      for (const interval of stream.work.eligible({
        start: stream.live.anchor,
        end: anchor
      })) {
        diagnostics.intervalVisits++;
        stream.live.prefix.add(interval);
      }
      stream.live.anchor = anchor;
    }
    return stream.live;
  };
  const streamViews = (stream, visit) => {
    for (const item of ancestors(stream.sessionID)) for (const view of item.snapshots.values()) {
      diagnostics.nodeVisits++;
      if (view.including || item.id === stream.sessionID) visit(view);
    }
  };
  const changeView = (view, intervals, range, add) => {
    for (const interval of intervals) {
      diagnostics.intervalVisits++;
      const start = Math.max(interval.start, range.start),
        end = Math.min(interval.end, range.end);
      if (end > start) {
        if (!view.coverage) {
          view.coverage = coverage();
          view.base.forEachCovered((item, count) => {
            diagnostics.intervalVisits++;
            diagnostics.intervalMaterializations++;
            view.coverage.add(item, count);
          });
        }
        diagnostics.intervalMaterializations++;
        if (add) view.coverage.add({
          start,
          end
        });else view.coverage.remove({
          start,
          end
        });
      }
    }
  };
  const detachLive = stream => streamViews(stream, view => {
    const old = view.prefixes.get(stream);
    if (old) {
      changeView(view, prefixIntervals(stream, old), old, false);
      view.prefixes.delete(stream);
    }
    view.tails.delete(stream);
  });
  const refreshView = (stream, view, delta) => {
    if (stream.hidden || stream.retired || stream.activeStart === undefined || excluded(stream.sessionID)) return;
    const live = ensureLive(stream),
      trusted = view.trusted === stream.instanceID;
    const boundary = firstBoundary(stream.end, stream.observed) ?? (trusted && view.clock ? undefined : stream.maxLifecycle);
    const liveLimit = trusted && view.liveNow !== undefined ? Math.max(view.liveNow, stream.activeObserved ?? live.start) : Infinity;
    const range = {
      start: live.start,
      end: Math.min(live.anchor, boundary ?? Infinity, liveLimit)
    };
    const old = view.prefixes.get(stream);
    if (old && delta) {
      changeView(view, delta.before, old, false);
      changeView(view, delta.after, range, true);
    } else if (!old) changeView(view, prefixIntervals(stream, range), range, true);else if (old.end !== range.end) {
      const difference = {
        start: Math.min(old.end, range.end),
        end: Math.max(old.end, range.end)
      };
      changeView(view, prefixIntervals(stream, difference), difference, range.end > old.end);
    }
    view.prefixes.set(stream, range);
    if (trusted && stream.end === undefined && stream.observed === undefined) view.tails.set(stream, live.anchor);else view.tails.delete(stream);
  };
  const refreshLive = (stream, delta) => {
    streamViews(stream, view => refreshView(stream, view, delta));
  };
  const appendWork = (stream, event) => {
    const live = stream.activeStart === undefined ? undefined : ensureLive(stream),
      changed = stream.work.update(event);
    const pure = stream.work.pure(stream.pureRange, firstBoundary(stream.end, stream.observed));
    if (pure !== !!stream.pure) {
      stream.dirty = true;
      repair(stream);
      return;
    }
    const anchor = live ? Math.max(live.anchor, stream.work.maxEnd) : undefined;
    if (live && anchor > live.anchor) {
      changed.push({
        start: live.anchor,
        end: anchor
      });
      diagnostics.intervalMaterializations++;
    }
    if (changed.length === 0) return;
    if (live) live.anchor = anchor;
    const before = [],
      after = [];
    for (const interval of mergeProjectionIntervals(changed, diagnostics)) {
      if (!pure) {
        const previous = [],
          next = [];
        stream.closed.forEachCovered(item => {
          diagnostics.intervalVisits++;
          previous.push(item);
          diagnostics.intervalMaterializations++;
        }, interval);
        stream.busy.forEachCovered(busy => {
          diagnostics.intervalVisits++;
          for (const item of stream.work.eligible(busy)) {
            next.push(item);
            diagnostics.intervalMaterializations++;
          }
        }, interval);
        if (previous.length || next.length) {
          const removed = subtractIntervalsMeasured(previous, next, diagnostics),
            added = subtractIntervalsMeasured(next, previous, diagnostics);
          for (const item of removed) {
            stream.closed.remove(item);
            applyClosed(stream, item, false);
          }
          for (const item of added) {
            stream.closed.add(item);
            applyClosed(stream, item, true);
          }
        }
      }
      if (live) {
        const range = {
          start: Math.max(live.start, interval.start),
          end: Math.min(anchor, interval.end)
        };
        if (range.end <= range.start) continue;
        const previous = prefixIntervals(stream, range),
          next = stream.work.eligible(range);
        for (const item of previous) {
          diagnostics.intervalVisits++;
          live.prefix.remove(item);
          before.push(item);
          diagnostics.intervalMaterializations++;
        }
        for (const item of next) {
          diagnostics.intervalVisits++;
          live.prefix.add(item);
          after.push(item);
          diagnostics.intervalMaterializations++;
        }
      }
    }
    if (live) refreshLive(stream, {
      before,
      after
    });
  };
  const patchOne = (id, parentChange, scopeChange) => {
    const proof = factScopes[id] ?? (scopeChange ? scopeChange.value : scopeContext[id]);
    const hasParent = parentChange ? parentChange.value !== undefined : parentContext.has(id);
    const parentValue = parentChange ? parentChange.value : parentContext.get(id);
    const parent = hasParent ? parentValue || undefined : factParents.has(id) ? factParents.get(id) : proof?.parentSessionID;
    const changed = node(id).parent !== parent || scopes[id]?.sourceScope === "magic-session" !== (proof?.sourceScope === "magic-session");
    const apply = () => {
      if (parentChange) {
        if (parentChange.value === undefined) parentContext.delete(id);else parentContext.set(id, parentChange.value);
      }
      if (scopeChange) {
        if (scopeChange.value === undefined) delete scopeContext[id];else scopeContext[id] = scopeChange.value;
      }
      if (proof) scopes[id] = proof;else delete scopes[id];
    };
    if (changed) mutateMetadata(id, apply);else apply();
  };
  const repair = stream => {
    if (!stream.dirty) return;
    detachLive(stream);
    diagnostics.coldFactVisits += stream.facts.length;
    diagnostics.factVisits += stream.facts.length;
    diagnostics.factMaterializations += stream.facts.length;
    const facts = [...stream.facts].sort((a, b) => {
      diagnostics.factSortComparisons++;
      return compareStreamFacts(a, b);
    });
    const lifecycle = facts.filter(event => {
      diagnostics.factVisits++;
      if (isLifecycleEvent(event)) {
        diagnostics.factMaterializations++;
        return true;
      }
      return false;
    });
    let start, activeObserved;
    let terminal = false;
    const base = [];
    stream.end = undefined;
    stream.observed = undefined;
    stream.maxLifecycle = -Infinity;
    for (const event of lifecycle) {
      diagnostics.factVisits++;
      stream.maxLifecycle = Math.max(stream.maxLifecycle, event.timestamp);
      if (event.instanceEndedAt !== undefined) stream.end = firstBoundary(stream.end, event.instanceEndedAt);
      if (event.lastObservedAt !== undefined) stream.observed = Math.max(stream.observed ?? -Infinity, event.lastObservedAt);
      if (terminal && isActiveState(event.state)) continue;
      if (isActiveState(event.state)) {
        start ??= event.timestamp;
        activeObserved = Math.max(activeObserved ?? event.timestamp, event.timestamp);
      } else if (start !== undefined) {
        pushInterval(base, start, event.timestamp);
        start = undefined;
        activeObserved = undefined;
      }
      terminal ||= event.executionID !== undefined && isTerminalState(event.state);
    }
    if (start !== undefined && stream.superseded) {
      pushInterval(base, start, stream.maxLifecycle);
      start = undefined;
    }
    const work = collectWorkSpans(facts, () => diagnostics.workFactVisits++, () => diagnostics.workSpanVisits++);
    // Respect explicit observation boundaries in the same shared cold math.
    const bound = firstBoundary(stream.end, stream.observed);
    const pure = completeMaintenance(facts, lifecycle, work, bound, () => diagnostics.factVisits++, () => diagnostics.workSpanVisits++);
    diagnostics.intervalMaterializations += base.length;
    const bounded = bound === undefined ? base : intersectIntervals(base, [{
      start: -Number.MAX_VALUE,
      end: bound
    }], diagnostics);
    const previous = stream.closed;
    stream.closed = coverage();
    stream.busy = coverage();
    for (const interval of mergeProjectionIntervals(bounded, diagnostics)) stream.busy.add(interval);
    for (const interval of eligibleBusyIntervals(bounded, work.values(), pure, () => diagnostics.workSpanVisits++, diagnostics)) stream.closed.add(interval);
    // Replace only this execution's coverage. Invalidating a session here made
    // ordinary complete proofs rebuild all historical streams quadratically.
    previous.forEachCovered(interval => applyClosed(stream, interval, false));
    stream.closed.forEachCovered(interval => applyClosed(stream, interval, true));
    stream.activeStart = start;
    stream.activeObserved = start === undefined ? undefined : activeObserved;
    stream.terminal = terminal;
    stream.pure = pure;
    const first = lifecycle[0],
      last = lifecycle[lifecycle.length - 1];
    stream.pureRange = stream.hasCertificate && first?.state === "busy" && lifecycle.length > 1 && !isActiveState(last.state) && last.timestamp >= first.timestamp ? {
      start: first.timestamp,
      end: last.timestamp
    } : undefined;
    stream.work = new WorkSpanIndex(coverage, diagnostics);
    for (const event of facts) {
      diagnostics.factVisits++;
      if (event.kind === "work") stream.work.update(event);
    }
    stream.live = undefined;
    stream.last = facts[facts.length - 1];
    stream.dirty = false;
    syncActive(stream);
    refreshLive(stream);
  };
  const index = (id, including) => {
    const item = node(id);
    const cached = including ? item.including : item.direct;
    if (cached) return cached;
    diagnostics.indexBuilds++;
    const result = coverage();
    for (const entry of including ? descendants(id) : [item]) {
      if (excluded(entry.id)) continue;
      entry.raw.forEachCovered((interval, count) => {
        diagnostics.intervalVisits++;
        result.add(interval, count);
      });
    }
    if (including) item.including = result;else item.direct = result;
    return result;
  };
  const measure = (id, including, options) => {
    if (excluded(id)) return {
      milliseconds: 0,
      active: false
    };
    const item = node(id),
      closed = index(id, including),
      cutoff = resolveGlobalCutoff(options);
    const key = `${including ? "tree" : "direct"}:${JSON.stringify([options.trustedCurrentInstanceID ?? null, cutoff !== undefined, options.liveNow !== undefined])}`;
    let snapshot = item.snapshots.get(key);
    if (!snapshot) {
      // Keep default plus the current epoch's two clock modes. Alternating a
      // trusted/live query and an untrusted closed read must not copy history.
      const prefix = including ? "tree:" : "direct:";
      if (options.trustedCurrentInstanceID !== undefined) for (const [previous, view] of item.snapshots) {
        diagnostics.nodeVisits++;
        if (previous.startsWith(prefix) && view.trusted !== undefined && view.trusted !== options.trustedCurrentInstanceID) item.snapshots.delete(previous);
      }
      diagnostics.snapshotBuilds++;
      snapshot = {
        base: closed,
        including,
        trusted: options.trustedCurrentInstanceID,
        clock: cutoff !== undefined || options.liveNow !== undefined,
        liveNow: options.liveNow,
        prefixes: new Map(),
        tails: new Map()
      };
      for (const stream of item.active) {
        diagnostics.snapshotStreamVisits++;
        if (!including && stream.sessionID !== id) continue;
        repair(stream);
        refreshView(stream, snapshot);
      }
      item.snapshots.set(key, snapshot);
    } else if (options.liveNow !== undefined && snapshot.liveNow !== options.liveNow) {
      snapshot.liveNow = options.liveNow;
      for (const stream of snapshot.prefixes.keys()) {
        diagnostics.clockStreamVisits++;
        refreshView(stream, snapshot);
      }
    }
    const live = [];
    for (const [stream, start] of snapshot.tails) {
      diagnostics.clockStreamVisits++;
      // No implicit clock: trustedCurrentInstanceID alone never manufactures now.
      pushInterval(live, start, options.liveNow === undefined ? cutoff ?? stream.maxLifecycle : Math.max(options.liveNow, stream.activeObserved ?? stream.activeStart));
      diagnostics.intervalMaterializations++;
    }
    const projected = snapshot.coverage ?? closed;
    let milliseconds = projected.total;
    for (const interval of mergeProjectionIntervals(live, diagnostics)) milliseconds += interval.end - interval.start - projected.overlap(interval);
    return {
      milliseconds,
      active: snapshot.tails.size > 0
    };
  };
  const projector = {
    ingest(events) {
      for (const raw of events) {
        const event = normalizeActivityEvent(raw);
        if (!event) continue;
        diagnostics.factMaterializations++;
        const key = fullKey(event);
        if (selections.get(key)?.retired) continue;
        const identity = activityEventDedupeKey(event);
        diagnostics.identityVisits++;
        if (identities.has(identity)) continue;
        identities.add(identity);
        diagnostics.ingested++;
        diagnostics.factVisits++;
        let owned = identitySets.get(key);
        if (!owned) {
          owned = new Set();
          identitySets.set(key, owned);
        }
        owned.add(identity);
        maximumTimestamp = Math.max(maximumTimestamp, event.timestamp);
        const item = node(event.sessionID);
        const parentFact = event.kind === "parent" || event.parentSessionID !== undefined;
        const hiddenFact = event.scope?.sourceScope === "magic-session";
        const prospectiveScope = hiddenFact ? event.scope : scopes[event.sessionID];
        const nextParent = parentContext.has(event.sessionID) ? parentContext.get(event.sessionID) || undefined : parentFact ? event.parentSessionID : factParents.has(event.sessionID) ? factParents.get(event.sessionID) : prospectiveScope?.parentSessionID;
        const applyMetadata = () => {
          if (hiddenFact) {
            factScopes[event.sessionID] = event.scope;
            scopes[event.sessionID] = event.scope;
          }
          if (parentFact) factParents.set(event.sessionID, event.parentSessionID);
        };
        if (item.parent !== nextParent || hiddenFact && scopes[event.sessionID]?.sourceScope !== "magic-session") mutateMetadata(event.sessionID, applyMetadata);else applyMetadata();
        if (event.kind === "parent" || event.scope?.sourceScope === "magic-message") continue;
        diagnostics.streamVisits++;
        let stream = streams.get(key);
        if (!stream) {
          const selection = selections.get(key);
          stream = {
            sessionID: event.sessionID,
            instanceID: event.instanceID,
            facts: [],
            closed: coverage(),
            busy: coverage(),
            maxLifecycle: -Infinity,
            dirty: false,
            work: new WorkSpanIndex(coverage, diagnostics),
            identities: owned,
            hidden: selection?.hidden ?? false,
            retired: false
          };
          streams.set(key, stream);
          item.streams.add(stream);
        }
        if (event.kind === "lifecycle" && isActiveState(event.state) && !stream.startFact) {
          stream.startFact = event;
          const epochKey = streamKey(event.sessionID, event.instanceID);
          const previous = latestExecutions.get(epochKey);
          if (!previous || compareStreamFacts(previous.startFact, event) <= 0) {
            if (previous && previous !== stream) {
              previous.superseded = true;
              if (previous.activeStart !== undefined) {
                previous.dirty = true;
                repair(previous);
              }
            }
            latestExecutions.set(epochKey, stream);
          } else stream.superseded = true;
        }
        stream.facts.push(event);
        diagnostics.factMaterializations++;
        stream.hasCertificate ||= event.kind === "execution-scope";
        const ordered = !stream.last || compareStreamFacts(stream.last, event) <= 0;
        const inspected = event.kind === "work" ? stream.work.inspect(event, stream.activeStart) : undefined;
        const refinement = inspected?.refinement;
        const lateWork = event.kind === "work" && !refinement && (stream.activeStart === undefined || event.timestamp < stream.activeStart || inspected?.earlier);
        if (!refinement && (!ordered || lateWork || stream.superseded) || event.kind === "execution-scope" || stream.dirty || stream.hasCertificate && isLifecycleEvent(event) && (!isActiveState(event.state) || stream.pure) || event.instanceEndedAt !== undefined || event.lastObservedAt !== undefined) {
          stream.dirty = true;
          repair(stream);
        } else if (event.kind === "work") {
          appendWork(stream, event);
        } else {
          diagnostics.lifecycleTransitions++;
          stream.maxLifecycle = Math.max(stream.maxLifecycle, event.timestamp);
          if (isActiveState(event.state)) {
            if (!stream.terminal) {
              stream.activeStart ??= event.timestamp;
              stream.activeObserved = Math.max(stream.activeObserved ?? event.timestamp, event.timestamp);
              stream.pureRange = undefined;
            }
          } else if (stream.activeStart !== undefined) {
            detachLive(stream);
            if (event.timestamp > stream.activeStart) stream.busy.add({
              start: stream.activeStart,
              end: event.timestamp
            });
            const additions = stream.work.eligible({
              start: stream.activeStart,
              end: event.timestamp
            });
            for (const interval of additions) {
              stream.closed.add(interval);
              applyClosed(stream, interval, true);
            }
            stream.activeStart = undefined;
            stream.activeObserved = undefined;
            stream.live = undefined;
          }
          stream.terminal ||= event.executionID !== undefined && isTerminalState(event.state);
          refreshLive(stream);
        }
        // A late arrival must not rewind the sorted watermark restored by repair.
        if (!stream.last || compareStreamFacts(stream.last, event) <= 0) stream.last = event;
        syncActive(stream);
      }
    },
    setContext(next) {
      const parents = next.parentBySessionID instanceof Map ? new Map(next.parentBySessionID) : new Map(Object.entries(next.parentBySessionID ?? {}));
      // Legacy full snapshots treat a present undefined parent as an explicit
      // root; only the new patch API uses undefined to withdraw an override.
      for (const [id, value] of parents) {
        diagnostics.contextNodeVisits++;
        if (value === undefined) parents.set(id, null);
      }
      const proofs = new Map(Object.entries(next.sessionScopes ?? {}));
      for (const id of parentContext.keys()) {
        diagnostics.contextNodeVisits++;
        if (!parents.has(id)) parents.set(id, undefined);
      }
      for (const id of Object.keys(scopeContext)) {
        diagnostics.contextNodeVisits++;
        if (!proofs.has(id)) proofs.set(id, undefined);
      }
      projector.patchContext({
        parents,
        sessionScopes: proofs
      });
    },
    patchContext(changes) {
      const staged = new Map();
      for (const [id, value] of changes.parents ?? []) {
        diagnostics.contextNodeVisits++;
        if (typeof id !== "string" || value !== undefined && value !== null && typeof value !== "string") throw new TypeError("Invalid activity parent patch");
        staged.set(id, {
          parent: {
            value
          }
        });
      }
      for (const [id, value] of changes.sessionScopes ?? []) {
        diagnostics.contextNodeVisits++;
        const proof = value === undefined ? undefined : coerceScopeEvidence(value);
        if (typeof id !== "string" || value !== undefined && !proof) throw new TypeError("Invalid activity scope patch");
        const entry = staged.get(id) ?? {};
        entry.scope = {
          value: proof
        };
        staged.set(id, entry);
      }
      for (const [id, patch] of staged) {
        diagnostics.contextNodeVisits++;
        patchOne(id, patch.parent, patch.scope);
      }
      context = {
        sessionScopes: scopeContext,
        parentBySessionID: parentContext
      };
    },
    updateStreams(changes) {
      // Validate the ENTIRE batch before touching selection, identities or time.
      const staged = changes.map(change => {
        const key = change?.key;
        if (!key || !nonEmptyString(key.sessionID) || !nonEmptyString(key.instanceID) || key.executionID !== undefined && !nonEmptyString(key.executionID) || !["visible", "hidden", "replace"].includes(change.mode)) throw new TypeError("Invalid activity stream selector");
        const encoded = fullKey(key);
        const events = change.mode === "replace" ? change.events.map(raw => {
          diagnostics.factVisits++;
          const event = normalizeActivityEvent(raw);
          diagnostics.factMaterializations++;
          if (!event || fullKey(event) !== encoded) throw new TypeError("Replacement activity fact does not match full stream key");
          return event;
        }) : undefined;
        return {
          encoded,
          mode: change.mode,
          events
        };
      });
      for (const change of staged) {
        diagnostics.streamVisits++;
        const stream = streams.get(change.encoded),
          previous = selections.get(change.encoded) ?? {
            hidden: stream?.hidden ?? false,
            retired: false
          };
        if (stream) for (const ancestor of ancestors(stream.sessionID)) ancestor.snapshots.clear();
        if (change.mode === "replace") {
          if (stream) {
            stream.closed.forEachCovered(interval => applyClosed(stream, interval, false));
            stream.hidden = true;
            stream.retired = true;
            stream.activeStart = undefined;
            syncActive(stream);
            stream.facts = [];
            stream.work = new WorkSpanIndex(coverage, diagnostics);
            stream.closed = coverage();
            stream.busy = coverage();
            stream.live = undefined;
            stream.activeObserved = undefined;
            stream.hasCertificate = false;
            stream.pure = false;
            stream.pureRange = undefined;
            stream.last = undefined;
            stream.maxLifecycle = -Infinity;
            stream.end = undefined;
            stream.observed = undefined;
            stream.terminal = false;
            stream.dirty = false;
          }
          const owned = identitySets.get(change.encoded);
          if (owned) for (const identity of owned) {
            diagnostics.identityVisits++;
            identities.delete(identity);
          }
          owned?.clear();
          const retired = change.events.length === 0;
          const selection = {
            hidden: retired || previous.hidden,
            retired
          };
          selections.set(change.encoded, selection);
          if (stream) {
            stream.hidden = selection.hidden;
            stream.retired = retired;
          }
          if (!retired) projector.ingest(change.events);
        } else {
          const hidden = change.mode === "hidden";
          const selection = {
            hidden,
            retired: hidden ? previous.retired : false
          };
          if (stream && stream.hidden !== hidden) {
            if (hidden) stream.closed.forEachCovered(interval => applyClosed(stream, interval, false));
            stream.hidden = hidden;
            stream.retired = selection.retired;
            if (!hidden) stream.closed.forEachCovered(interval => applyClosed(stream, interval, true));
            syncActive(stream);
          } else if (stream) stream.retired = selection.retired;
          selections.set(change.encoded, selection);
        }
      }
    },
    totals(sessionID, options = {}) {
      validateActivityClockOptions(options);
      if (options.sessionScopes || options.parentBySessionID) projector.setContext({
        ...context,
        ...options
      });
      const cutoff = resolveGlobalCutoff(options);
      if (cutoff !== undefined && cutoff < maximumTimestamp || options.instanceEndedAt !== undefined || options.instanceEndTimes !== undefined || options.lastObservedAt !== undefined) {
        const selected = descendants(sessionID);
        const facts = selected.flatMap(item => [...historicalStreams(item)].filter(stream => !stream.hidden && !stream.retired).flatMap(stream => {
          diagnostics.factVisits += stream.facts.length;
          diagnostics.factMaterializations += stream.facts.length * 2;
          if (!stream.superseded || stream.terminal) return stream.facts;
          // A selected-facts cold read must retain the compact observation
          // boundary after the newer stream has been hidden/retired. Otherwise
          // independent replay would mistake the old epoch stream for current.
          let bounded = false;
          return stream.facts.map(event => {
            diagnostics.factVisits++;
            diagnostics.factMaterializations++;
            if (bounded || event.kind !== "lifecycle") return event;
            bounded = true;
            diagnostics.factMaterializations++;
            return {
              ...event,
              instanceEndedAt: firstBoundary(event.instanceEndedAt, stream.maxLifecycle)
            };
          });
        }));
        // Explicit cold reads use the very same execution/epoch math as replay,
        // without constructing unrelated root summaries. Every cold operation
        // is instrumented; the independent public replay remains the oracle.
        diagnostics.coldFactVisits += facts.length;
        diagnostics.factMaterializations += facts.length;
        const ordered = [...facts].sort((a, b) => {
          diagnostics.factSortComparisons++;
          return compareActivityEvents(a, b);
        });
        const grouped = new Map();
        for (const event of ordered) {
          diagnostics.factVisits++;
          if (event.kind === "parent" || cutoff !== undefined && event.timestamp > cutoff || excluded(event.sessionID)) continue;
          const key = streamKey(event.sessionID, event.instanceID),
            group = grouped.get(key) ?? {
              sessionID: event.sessionID,
              instanceID: event.instanceID,
              facts: []
            };
          group.facts.push(event);
          diagnostics.factMaterializations++;
          grouped.set(key, group);
        }
        const direct = [],
          including = [];
        for (const group of grouped.values()) {
          diagnostics.streamVisits++;
          const projected = projectInstanceFacts(group.facts, group.sessionID, group.instanceID, options, diagnostics);
          for (const interval of projected.intervals) {
            diagnostics.intervalVisits++;
            diagnostics.intervalMaterializations++;
            including.push(interval);
            if (group.sessionID === sessionID) {
              direct.push(interval);
              diagnostics.intervalMaterializations++;
            }
          }
        }
        return {
          directMilliseconds: intervalSum(mergeProjectionIntervals(direct, diagnostics), diagnostics),
          includingMilliseconds: intervalSum(mergeProjectionIntervals(including, diagnostics), diagnostics),
          active: selected.some(item => {
            diagnostics.nodeVisits++;
            if (excluded(item.id)) return false;
            for (const stream of item.active) {
              diagnostics.streamVisits++;
              if (stream.sessionID === item.id && stream.activeStart !== undefined && stream.instanceID === options.trustedCurrentInstanceID && stream.end === undefined && stream.observed === undefined && (cutoff === undefined || cutoff >= stream.maxLifecycle) && resolveBoundarySpec(options.instanceEndedAt, stream.instanceID, stream.sessionID) === undefined && resolveBoundarySpec(options.instanceEndTimes, stream.instanceID, stream.sessionID) === undefined && resolveBoundarySpec(options.lastObservedAt, stream.instanceID, stream.sessionID) === undefined) return true;
            }
            return false;
          })
        };
      }
      const direct = measure(sessionID, false, options),
        including = measure(sessionID, true, options);
      return {
        directMilliseconds: direct.milliseconds,
        includingMilliseconds: including.milliseconds,
        active: including.active
      };
    }
  };
  projectionDiagnostics.set(projector, diagnostics);
  projector.ingest(initial);
  return projector;
}
function calculateInstanceIntervals(events, sessionID, instanceID, options, diagnostics) {
  const boundary = resolveInstanceBoundary(events, sessionID, instanceID, options, diagnostics);
  const boundedEvents = events.filter(event => {
    if (diagnostics) diagnostics.factVisits++;
    const keep = boundary === undefined || event.timestamp <= boundary;
    if (keep && diagnostics) diagnostics.factMaterializations++;
    return keep;
  }).sort((a, b) => {
    if (diagnostics) diagnostics.factSortComparisons++;
    return compareStreamFacts(a, b);
  });
  const intervals = [];
  let currentState;
  let activeStart;
  let activeObserved;
  let terminal = false;
  for (const event of boundedEvents) {
    if (diagnostics) diagnostics.factVisits++;
    const nextIsActive = isActiveState(event.state);
    if (terminal && nextIsActive) continue;
    if (nextIsActive) {
      if (activeStart === undefined) activeStart = event.timestamp;
      activeObserved = Math.max(activeObserved ?? event.timestamp, event.timestamp);
    } else if (activeStart !== undefined) {
      pushInterval(intervals, activeStart, event.timestamp);
      activeStart = undefined;
      activeObserved = undefined;
    }
    currentState = event.state;
    terminal ||= event.executionID !== undefined && isTerminalState(event.state);
  }
  const open = activeStart !== undefined;
  let tailBoundary = boundary;
  if (activeStart !== undefined && options.liveNow !== undefined && options.trustedCurrentInstanceID === instanceID) {
    tailBoundary = Math.min(Math.max(options.liveNow, activeObserved ?? activeStart), resolveInstanceBoundary(events, sessionID, instanceID, options, diagnostics, false) ?? Infinity);
  }
  if (activeStart !== undefined && tailBoundary !== undefined) {
    pushInterval(intervals, activeStart, tailBoundary);
  }
  if (diagnostics) {
    diagnostics.intervalMaterializations += intervals.length;
    diagnostics.factMaterializations += boundedEvents.length;
  }
  const activeIntervals = diagnostics ? mergeProjectionIntervals(intervals, diagnostics) : mergeIntervals(intervals);
  return {
    sessionID,
    instanceID,
    events: [...boundedEvents],
    activeIntervals,
    intervals: activeIntervals,
    activeMilliseconds: diagnostics ? intervalSum(activeIntervals, diagnostics) : calculateActiveMilliseconds(activeIntervals),
    open,
    ...(currentState === undefined ? {} : {
      currentState
    }),
    ...(tailBoundary === undefined ? {} : {
      boundary: tailBoundary
    })
  };
}
function resolveInstanceBoundary(events, sessionID, instanceID, options, diagnostics, fallback = true) {
  const candidates = [];
  const globalCutoff = resolveGlobalCutoff(options);
  if (globalCutoff !== undefined && options.trustedCurrentInstanceID === instanceID) candidates.push(globalCutoff);
  const instanceEnd = firstBoundary(resolveBoundarySpec(options.instanceEndedAt, instanceID, sessionID), resolveBoundarySpec(options.instanceEndTimes, instanceID, sessionID));
  if (instanceEnd !== undefined) candidates.push(instanceEnd);
  const observedBoundary = resolveBoundarySpec(options.lastObservedAt, instanceID, sessionID);
  if (observedBoundary !== undefined) candidates.push(observedBoundary);
  const eventInstanceEnds = events.map(event => {
    if (diagnostics) diagnostics.factVisits++;
    return event.instanceEndedAt;
  }).filter(value => value !== undefined && Number.isFinite(value));
  if (eventInstanceEnds.length > 0) candidates.push(Math.min(...eventInstanceEnds));
  const eventObservations = events.map(event => {
    if (diagnostics) diagnostics.factVisits++;
    return event.lastObservedAt;
  }).filter(value => value !== undefined && Number.isFinite(value));
  if (eventObservations.length > 0) candidates.push(Math.max(...eventObservations));

  // An untrusted/open instance cannot extend to the reader's clock. Its own
  // lifecycle facts still prove the interval up to their latest timestamp
  // (e.g. busy -> retry); dropping that tail loses time on every fresh reader.
  // Explicit process/observation boundaries remain authoritative, including
  // when they conservatively truncate later or out-of-order facts.
  return candidates.length === 0 ? !fallback || events.length === 0 ? undefined : Math.max(...events.map(event => {
    if (diagnostics) diagnostics.factVisits++;
    return event.timestamp;
  })) : Math.min(...candidates);
}
function resolveGlobalCutoff(options) {
  validateActivityClockOptions(options);
  const candidates = [options.replayCutoff, options.cutoff, options.until].filter(value => value !== undefined && Number.isFinite(value));
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}
function normalizeReplayInput(input) {
  const options = typeof input === "number" ? {
    replayCutoff: input
  } : input;
  validateActivityClockOptions(options);
  return options;
}
function validateActivityClockOptions(options) {
  if (options.liveNow === undefined) return;
  if (options.replayCutoff !== undefined || options.cutoff !== undefined || options.until !== undefined) throw new TypeError("liveNow cannot be combined with a historical activity cutoff");
  if (!Number.isFinite(options.liveNow) || options.liveNow < 0) throw new RangeError("liveNow must be a finite non-negative clock");
}
function resolveBoundarySpec(spec, instanceID, sessionID) {
  if (spec === undefined) return undefined;
  if (typeof spec === "number") return Number.isFinite(spec) ? spec : undefined;
  if (typeof spec === "function") {
    const value = spec(instanceID, sessionID);
    return Number.isFinite(value) ? value : undefined;
  }
  const keys = [`${sessionID}:${instanceID}`, `${sessionID}/${instanceID}`, instanceID, sessionID];
  for (const key of keys) {
    const value = isReadonlyMap(spec) ? spec.get(key) : Object.prototype.hasOwnProperty.call(spec, key) ? spec[key] : undefined;
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}
function streamKey(sessionID, instanceID) {
  return `${sessionID.length}:${sessionID}${instanceID.length}:${instanceID}`;
}
function splitStreamKey(key) {
  const firstColon = key.indexOf(":");
  const sessionLength = Number(key.slice(0, firstColon));
  const sessionStart = firstColon + 1;
  const instanceLengthStart = sessionStart + sessionLength;
  const secondColon = key.indexOf(":", instanceLengthStart);
  const instanceLength = Number(key.slice(instanceLengthStart, secondColon));
  const instanceStart = secondColon + 1;
  return [key.slice(sessionStart, sessionStart + sessionLength), key.slice(instanceStart, instanceStart + instanceLength)];
}
function splitStreamKeyObject(key) {
  const [sessionID, instanceID] = splitStreamKey(key);
  return {
    sessionID,
    instanceID
  };
}
function inferEventKind(value) {
  if (isLifecycleState(value.state)) return "lifecycle";
  if (Object.prototype.hasOwnProperty.call(value, "parentSessionID") || Object.prototype.hasOwnProperty.call(value, "parentSessionId")) {
    return "parent";
  }
  return undefined;
}
function normalizeParentSessionID(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isLifecycleEvent(event) {
  return event.kind === "lifecycle";
}
function pushInterval(intervals, start, end) {
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({
    start,
    end
  });
}
function firstBoundary(...values) {
  const valid = values.filter(value => value !== undefined && Number.isFinite(value));
  return valid.length === 0 ? undefined : Math.min(...valid);
}
function fnv1a(value) {
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = hash * 0x100000001b3n & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function finiteNumberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isReadonlyMap(value) {
  return typeof value === "object" && value !== null && typeof value.get === "function";
}
