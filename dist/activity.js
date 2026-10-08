import { coerceScopeEvidence, collectSessionScopeEvidence, isMeasurementScopeEligible, isSessionScopeExcluded } from "./scope.js";
export const ACTIVITY_VERSION = 1;
export const DEFAULT_ACTIVITY_INSTANCE_ID = "default";
export const LIFECYCLE_STATES = ["busy", "retry", "idle", "completed", "failed", "aborted", "cancelled", "stopped"];
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
  if (value.version !== undefined && value.version !== ACTIVITY_VERSION) return undefined;
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
  const kind = explicitKind === "lifecycle" || explicitKind === "parent" ? explicitKind : explicitKind === undefined ? inferEventKind(value) : undefined;
  if (!kind) return undefined;
  const common = {
    version: ACTIVITY_VERSION,
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
  } else {
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

  // A supplied sequence is the authoritative tie-breaker for equal timestamps.
  const leftSeq = left.seq ?? Number.POSITIVE_INFINITY;
  const rightSeq = right.seq ?? Number.POSITIVE_INFINITY;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt;
  const eventIDComparison = left.eventID.localeCompare(right.eventID);
  if (eventIDComparison !== 0) return eventIDComparison;
  return activityEventSemanticCanonical(left).localeCompare(activityEventSemanticCanonical(right));
}
export function sortActivityEvents(values) {
  return dedupeActivityEvents(values).sort(compareActivityEvents);
}

/** Returns a stable, non-cryptographic fingerprint including boundary metadata. */
export function activityEventFingerprint(event) {
  return `fp-${fnv1a(activityEventSemanticCanonical(event))}`;
}
function activityEventSemanticCanonical(event) {
  return JSON.stringify([event.version, event.kind, event.sessionID, event.kind === "lifecycle" ? event.state : null, event.parentSessionID ?? null, event.timestamp, event.observedAt, event.instanceID, event.seq ?? null, event.instanceEndedAt ?? null, event.lastObservedAt ?? null, event.scope ?? null]);
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
  const replayOptions = normalizeReplayInput(options);
  const replayCutoff = resolveGlobalCutoff(replayOptions);
  // Collect scope/ancestry from all facts before bounding lifecycle replay,
  // matching replayActivity without treating an untrusted cutoff as an end.
  const events = filterActivityEvents(values, replayOptions.sessionScopes, replayOptions.parentBySessionID).filter(event => replayCutoff === undefined || event.timestamp <= replayCutoff).filter(isLifecycleEvent);
  const byInstance = groupLifecycleEvents(events);
  const intervals = [];
  for (const [key, stream] of byInstance) {
    const [sessionID, instanceID] = splitStreamKey(key);
    intervals.push(...calculateInstanceIntervals(stream, sessionID, instanceID, replayOptions).intervals);
  }
  return mergeIntervals(intervals);
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

/** One shared eligibility decision for lifecycle, trees and interval metrics. */
export function filterActivityEvents(values, scopes = {}, parents) {
  const events = sortActivityEvents(values);
  scopes = collectSessionScopeEvidence(events, scopes);
  const links = activityParents(events, scopes, parents);
  const eligible = new Map();
  return events.filter(event => {
    if (event.scope?.sourceScope === "magic-message") return false;
    if (!eligible.has(event.sessionID)) eligible.set(event.sessionID, isMeasurementScopeEligible(event, scopes, links));
    return eligible.get(event.sessionID);
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
    if (!eligible.has(id)) eligible.set(id, !isSessionScopeExcluded(id, scopes, allParents));
    return eligible.get(id);
  };
  const events = bounded.filter(event => event.scope?.sourceScope !== "magic-message" && sessionEligible(event.sessionID));
  const parentBySessionID = new Map([...allParents].filter(([id]) => sessionEligible(id)));
  const allSessionIDs = new Set();
  const lifecycleByInstance = groupLifecycleEvents(events.filter(isLifecycleEvent));
  for (const event of events) {
    allSessionIDs.add(event.sessionID);
    if (event.parentSessionID) allSessionIDs.add(event.parentSessionID);
  }
  for (const sessionID of [...allSessionIDs]) {
    const parentSessionID = parentBySessionID.get(sessionID);
    if (parentSessionID) allSessionIDs.add(parentSessionID);
  }
  const lifecycleBySession = new Map();
  for (const [key, stream] of lifecycleByInstance) {
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
    const instances = [...instanceEvents.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([instanceID, instanceLifecycleEvents]) => calculateInstanceIntervals(instanceLifecycleEvents, sessionID, instanceID, replayOptions));
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
  for (const sessionID of allSessionIDs) {
    const rootSessionID = resolveRootSessionID(sessionID, parentBySessionID);
    rootForSession.set(sessionID, rootSessionID);
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
    const sessionIDs = [...allSessionIDs].filter(sessionID => rootForSession.get(sessionID) === rootSessionID).sort((left, right) => left.localeCompare(right));
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
  const rootActiveMilliseconds = {};
  for (const root of roots) rootActiveMilliseconds[root.rootSessionID] = root.activeMilliseconds;
  const participants = [...timelines.values()].sort((left, right) => left.sessionID.localeCompare(right.sessionID));
  return {
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
function calculateInstanceIntervals(events, sessionID, instanceID, options) {
  const boundary = resolveInstanceBoundary(events, sessionID, instanceID, options);
  const boundedEvents = events.filter(event => boundary === undefined || event.timestamp <= boundary).sort(compareActivityEvents);
  const intervals = [];
  let currentState;
  let activeStart;
  for (const event of boundedEvents) {
    const nextIsActive = isActiveState(event.state);
    if (nextIsActive) {
      if (activeStart === undefined) activeStart = event.timestamp;
    } else if (activeStart !== undefined) {
      pushInterval(intervals, activeStart, event.timestamp);
      activeStart = undefined;
    }
    currentState = event.state;
  }
  const open = activeStart !== undefined;
  if (activeStart !== undefined && boundary !== undefined) {
    pushInterval(intervals, activeStart, boundary);
  }
  const activeIntervals = mergeIntervals(intervals);
  return {
    sessionID,
    instanceID,
    events: [...boundedEvents],
    activeIntervals,
    intervals: activeIntervals,
    activeMilliseconds: calculateActiveMilliseconds(activeIntervals),
    open,
    ...(currentState === undefined ? {} : {
      currentState
    }),
    ...(boundary === undefined ? {} : {
      boundary
    })
  };
}
function resolveInstanceBoundary(events, sessionID, instanceID, options) {
  const candidates = [];
  const globalCutoff = resolveGlobalCutoff(options);
  if (globalCutoff !== undefined && options.trustedCurrentInstanceID === instanceID) candidates.push(globalCutoff);
  const instanceEnd = firstBoundary(resolveBoundarySpec(options.instanceEndedAt, instanceID, sessionID), resolveBoundarySpec(options.instanceEndTimes, instanceID, sessionID));
  if (instanceEnd !== undefined) candidates.push(instanceEnd);
  const observedBoundary = resolveBoundarySpec(options.lastObservedAt, instanceID, sessionID);
  if (observedBoundary !== undefined) candidates.push(observedBoundary);
  const eventInstanceEnds = events.map(event => event.instanceEndedAt).filter(value => value !== undefined && Number.isFinite(value));
  if (eventInstanceEnds.length > 0) candidates.push(Math.min(...eventInstanceEnds));
  const eventObservations = events.map(event => event.lastObservedAt).filter(value => value !== undefined && Number.isFinite(value));
  if (eventObservations.length > 0) candidates.push(Math.max(...eventObservations));
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}
function resolveGlobalCutoff(options) {
  const candidates = [options.replayCutoff, options.cutoff, options.until].filter(value => value !== undefined && Number.isFinite(value));
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}
function normalizeReplayInput(input) {
  return typeof input === "number" ? {
    replayCutoff: input
  } : input;
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
    const value = isReadonlyMap(spec) ? spec.get(key) : spec[key];
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}
function groupLifecycleEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = streamKey(event.sessionID, event.instanceID);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort(compareActivityEvents);
  return groups;
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
