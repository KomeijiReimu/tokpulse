export const ACTIVITY_VERSION = 1 as const;
export const DEFAULT_ACTIVITY_INSTANCE_ID = "default";

export const LIFECYCLE_STATES = [
  "busy",
  "retry",
  "idle",
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "stopped",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export type ActivityState = LifecycleState;
export type ActivityEventKind = "lifecycle" | "parent";

export interface ActivityEventInputBase {
  version?: number;
  kind?: ActivityEventKind;
  eventID?: string;
  sessionID: string;
  timestamp: number;
  observedAt?: number;
  instanceID?: string;
  seq?: number;
  /** An explicit end boundary for this process instance, if known. */
  instanceEndedAt?: number;
  /** A reliable last-observed boundary for this process instance, if known. */
  lastObservedAt?: number;
  /** Lifecycle events may carry this as a convenience; parent events use it as their payload. */
  parentSessionID?: string | null;
}

export interface LifecycleActivityEventInput extends ActivityEventInputBase {
  kind?: "lifecycle";
  state: LifecycleState;
}

export interface ParentActivityEventInput extends ActivityEventInputBase {
  kind?: "parent";
  parentSessionID?: string | null;
}

export type ActivityEventInput = LifecycleActivityEventInput | ParentActivityEventInput;

export interface ActivityEventBase {
  version: typeof ACTIVITY_VERSION;
  kind: ActivityEventKind;
  eventID: string;
  sessionID: string;
  timestamp: number;
  observedAt: number;
  instanceID: string;
  seq?: number;
  instanceEndedAt?: number;
  lastObservedAt?: number;
}

export interface LifecycleActivityEvent extends ActivityEventBase {
  kind: "lifecycle";
  state: LifecycleState;
  parentSessionID?: string;
}

export interface ParentActivityEvent extends ActivityEventBase {
  kind: "parent";
  parentSessionID?: string;
}

export type ActivityEvent = LifecycleActivityEvent | ParentActivityEvent;

export interface ActivityInterval {
  /** Inclusive start of a half-open interval. */
  start: number;
  /** Exclusive end of a half-open interval. */
  end: number;
}

export interface ActivityInstanceTimeline {
  sessionID: string;
  instanceID: string;
  events: LifecycleActivityEvent[];
  activeIntervals: ActivityInterval[];
  /** Alias for activeIntervals for callers that use interval terminology. */
  intervals: ActivityInterval[];
  activeMilliseconds: number;
  /** True when the last state was active and no terminal event closed it. */
  open: boolean;
  currentState?: LifecycleState;
  boundary?: number;
}

export interface ActivityParticipantTimeline {
  sessionID: string;
  parentSessionID?: string;
  events: LifecycleActivityEvent[];
  instances: ActivityInstanceTimeline[];
  activeIntervals: ActivityInterval[];
  /** Alias for activeIntervals for callers that use interval terminology. */
  intervals: ActivityInterval[];
  activeMilliseconds: number;
  open: boolean;
}

export type ParticipantTimeline = ActivityParticipantTimeline;

export interface ActivityRootSummary {
  rootSessionID: string;
  /** Includes the root and every recursively resolved descendant. */
  sessionIDs: string[];
  descendantSessionIDs: string[];
  participants: ActivityParticipantTimeline[];
  activeIntervals: ActivityInterval[];
  /** Alias for activeIntervals for callers that use interval terminology. */
  intervals: ActivityInterval[];
  activeMilliseconds: number;
}

export interface ActivityReplay {
  events: ActivityEvent[];
  participants: ActivityParticipantTimeline[];
  participantTimelines: ActivityParticipantTimeline[];
  timelines: Map<string, ActivityParticipantTimeline>;
  parentBySessionID: Map<string, string | undefined>;
  roots: ActivityRootSummary[];
  rootTasks: ActivityRootSummary[];
  activeMillisecondsByRoot: Map<string, number>;
  rootActiveMilliseconds: Record<string, number>;
}

export type ActivityBoundarySpec =
  | number
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>
  | ((instanceID: string, sessionID: string) => number | undefined);

export interface ActivityReplayOptions {
  /** A global exclusive replay cutoff. Open active intervals end here when supplied. */
  replayCutoff?: number;
  /** Alias for replayCutoff. */
  cutoff?: number;
  /** Alias for replayCutoff. */
  until?: number;
  /** Explicit per-instance or global process-instance end boundary. */
  instanceEndedAt?: ActivityBoundarySpec;
  /** Alias for instanceEndedAt. */
  instanceEndTimes?: ActivityBoundarySpec;
  /** Explicit per-instance or global last-observed boundary. */
  lastObservedAt?: ActivityBoundarySpec;
}

export type ActivityReplayInput = ActivityReplayOptions | number;

export interface ActivityReadOptions {
  dedupe?: boolean;
}

const ACTIVE_STATES = new Set<LifecycleState>(["busy", "retry"]);
const TERMINAL_STATES = new Set<LifecycleState>([
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "stopped",
]);

/** Returns true for the only states that contribute to active time. */
export function isActiveState(state: LifecycleState): boolean {
  return ACTIVE_STATES.has(state);
}

export function isTerminalState(state: LifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * Normalizes an untrusted JSON-ish event without depending on OpenCode or a
 * clock. Missing event IDs are replaced with a deterministic fingerprint.
 */
export function normalizeActivityEvent(value: unknown): ActivityEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== undefined && value.version !== ACTIVITY_VERSION) return undefined;

  const sessionID = nonEmptyString(value.sessionID);
  const timestamp = finiteNumberOrUndefined(value.timestamp);
  if (!sessionID || timestamp === undefined) return undefined;

  const observedAt = finiteNumberOrUndefined(value.observedAt) ?? timestamp;
  const instanceID = nonEmptyString(value.instanceID) ?? DEFAULT_ACTIVITY_INSTANCE_ID;
  const seqValue = finiteNumberOrUndefined(value.seq);
  const seq = seqValue === undefined ? undefined : Math.trunc(seqValue);
  const instanceEndedAt = finiteNumberOrUndefined(
    value.instanceEndedAt ?? value.instanceEndAt,
  );
  const lastObservedAt = finiteNumberOrUndefined(value.lastObservedAt);
  const explicitKind = value.kind;
  const kind: ActivityEventKind | undefined = explicitKind === "lifecycle" || explicitKind === "parent"
    ? explicitKind
    : explicitKind === undefined
      ? inferEventKind(value)
      : undefined;
  if (!kind) return undefined;

  const common = {
    version: ACTIVITY_VERSION,
    kind,
    sessionID,
    timestamp,
    observedAt,
    instanceID,
    ...(seq === undefined ? {} : { seq }),
    ...(instanceEndedAt === undefined ? {} : { instanceEndedAt }),
    ...(lastObservedAt === undefined ? {} : { lastObservedAt }),
  };

  let event: Omit<LifecycleActivityEvent, "eventID"> | Omit<ParentActivityEvent, "eventID">;
  if (kind === "lifecycle") {
    if (!isLifecycleState(value.state)) return undefined;
    const parentSessionID = normalizeParentSessionID(value.parentSessionID ?? value.parentSessionId);
    event = {
      ...common,
      kind: "lifecycle",
      state: value.state,
      ...(parentSessionID === undefined ? {} : { parentSessionID }),
    };
  } else {
    const rawParentSessionID = value.parentSessionID ?? value.parentSessionId;
    if (rawParentSessionID !== undefined
      && rawParentSessionID !== null
      && typeof rawParentSessionID !== "string") {
      return undefined;
    }
    const parentSessionID = normalizeParentSessionID(rawParentSessionID);
    event = {
      ...common,
      kind: "parent",
      ...(parentSessionID === undefined ? {} : { parentSessionID }),
    };
  }

  const suppliedEventID = nonEmptyString(value.eventID) ?? nonEmptyString(value.eventId);
  const eventID = suppliedEventID ?? activityEventFingerprint(event);
  return { ...event, eventID } as ActivityEvent;
}

export function normalizeActivityEvents(values: readonly unknown[]): ActivityEvent[] {
  return values
    .map(normalizeActivityEvent)
    .filter((event): event is ActivityEvent => event !== undefined);
}

/**
 * Dedupe by eventID plus the complete normalized event semantics. Identical
 * ID-less events share a fingerprint, while conflicting payloads that reuse
 * an explicit eventID remain distinct facts.
 */
export function dedupeActivityEvents(values: readonly unknown[]): ActivityEvent[] {
  const byDedupeKey = new Map<string, ActivityEvent>();
  for (const value of values) {
    const event = normalizeActivityEvent(value);
    if (!event) continue;
    const dedupeKey = activityEventDedupeKey(event);
    if (!byDedupeKey.has(dedupeKey)) byDedupeKey.set(dedupeKey, event);
  }
  return [...byDedupeKey.values()];
}

export function compareActivityEvents(left: ActivityEvent, right: ActivityEvent): number {
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

export function sortActivityEvents(values: readonly unknown[]): ActivityEvent[] {
  return dedupeActivityEvents(values).sort(compareActivityEvents);
}

/** Returns a stable, non-cryptographic fingerprint including boundary metadata. */
export function activityEventFingerprint(
  event: Omit<ActivityEvent, "eventID">,
): string {
  return `fp-${fnv1a(activityEventSemanticCanonical(event))}`;
}

function activityEventSemanticCanonical(event: Omit<ActivityEvent, "eventID">): string {
  return JSON.stringify([
    event.version,
    event.kind,
    event.sessionID,
    event.kind === "lifecycle" ? (event as LifecycleActivityEvent).state : null,
    event.parentSessionID ?? null,
    event.timestamp,
    event.observedAt,
    event.instanceID,
    event.seq ?? null,
    event.instanceEndedAt ?? null,
    event.lastObservedAt ?? null,
  ]);
}

function activityEventDedupeKey(event: ActivityEvent): string {
  return JSON.stringify([event.eventID, activityEventSemanticCanonical(event)]);
}

/** Merges overlapping or adjacent half-open intervals. */
export function mergeIntervals(intervals: readonly ActivityInterval[]): ActivityInterval[] {
  const ordered = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end))
    .map((interval) => ({
      start: Math.min(interval.start, interval.end),
      end: Math.max(interval.start, interval.end),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: ActivityInterval[] = [];
  for (const interval of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}

export function calculateActiveMilliseconds(intervals: readonly ActivityInterval[]): number {
  return mergeIntervals(intervals).reduce(
    (total, interval) => total + (interval.end - interval.start),
    0,
  );
}

export const unionDurationMilliseconds = calculateActiveMilliseconds;

/**
 * Calculates the union of all lifecycle intervals in the supplied events.
 * Multiple sessions and process instances are kept separate until the final
 * union, so overlapping participants are never counted twice.
 */
export function calculateActiveIntervals(
  values: readonly unknown[],
  options: ActivityReplayInput = {},
): ActivityInterval[] {
  const replayOptions = normalizeReplayInput(options);
  const events = sortActivityEvents(values).filter(isLifecycleEvent);
  const byInstance = groupLifecycleEvents(events);
  const intervals: ActivityInterval[] = [];
  for (const [key, stream] of byInstance) {
    const [sessionID, instanceID] = splitStreamKey(key);
    intervals.push(...calculateInstanceIntervals(stream, sessionID, instanceID, replayOptions).intervals);
  }
  return mergeIntervals(intervals);
}

export const calculateSessionActiveIntervals = calculateActiveIntervals;

/**
 * Replays an append-only activity log. No implicit `Date.now()` boundary is
 * used: an open interval is omitted unless a caller supplies a cutoff or an
 * explicit instance/observation boundary.
 */
export function replayActivity(
  values: readonly unknown[],
  options: ActivityReplayInput = {},
): ActivityReplay {
  const replayOptions = normalizeReplayInput(options);
  const ordered = sortActivityEvents(values);
  const replayCutoff = resolveGlobalCutoff(replayOptions);
  const events = replayCutoff === undefined
    ? ordered
    : ordered.filter((event) => event.timestamp <= replayCutoff);

  const parentBySessionID = new Map<string, string | undefined>();
  for (const event of events) {
    if (event.kind === "parent") {
      parentBySessionID.set(event.sessionID, event.parentSessionID);
    } else if (event.parentSessionID !== undefined) {
      parentBySessionID.set(event.sessionID, event.parentSessionID);
    }
  }

  const allSessionIDs = new Set<string>();
  const lifecycleByInstance = groupLifecycleEvents(events.filter(isLifecycleEvent));
  for (const event of events) {
    allSessionIDs.add(event.sessionID);
    if (event.parentSessionID) allSessionIDs.add(event.parentSessionID);
  }
  for (const parentSessionID of parentBySessionID.values()) {
    if (parentSessionID) allSessionIDs.add(parentSessionID);
  }

  const lifecycleBySession = new Map<string, Map<string, LifecycleActivityEvent[]>>();
  for (const [key, stream] of lifecycleByInstance) {
    const { sessionID, instanceID } = splitStreamKeyObject(key);
    const byInstance = lifecycleBySession.get(sessionID) ?? new Map();
    byInstance.set(instanceID, stream);
    lifecycleBySession.set(sessionID, byInstance);
  }

  const sortedSessionIDs = [...allSessionIDs].sort((left, right) => left.localeCompare(right));
  const timelines = new Map<string, ActivityParticipantTimeline>();
  for (const sessionID of sortedSessionIDs) {
    const instanceEvents = lifecycleBySession.get(sessionID) ?? new Map();
    const instances = [...instanceEvents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([instanceID, instanceLifecycleEvents]) =>
        calculateInstanceIntervals(instanceLifecycleEvents, sessionID, instanceID, replayOptions),
      );
    const activeIntervals = mergeIntervals(instances.flatMap((instance) => instance.intervals));
    const timeline: ActivityParticipantTimeline = {
      sessionID,
      ...(parentBySessionID.get(sessionID) ? { parentSessionID: parentBySessionID.get(sessionID) } : {}),
      events: instances.flatMap((instance) => instance.events).sort(compareActivityEvents),
      instances,
      activeIntervals,
      intervals: activeIntervals,
      activeMilliseconds: calculateActiveMilliseconds(activeIntervals),
      open: instances.some((instance) => instance.open),
    };
    timelines.set(sessionID, timeline);
  }

  const rootIDs = new Set<string>();
  const rootForSession = new Map<string, string>();
  for (const sessionID of allSessionIDs) {
    const rootSessionID = resolveRootSessionID(sessionID, parentBySessionID);
    rootForSession.set(sessionID, rootSessionID);
    rootIDs.add(rootSessionID);
    if (!timelines.has(rootSessionID)) {
      const emptyTimeline: ActivityParticipantTimeline = {
        sessionID: rootSessionID,
        ...(parentBySessionID.get(rootSessionID)
          ? { parentSessionID: parentBySessionID.get(rootSessionID) }
          : {}),
        events: [],
        instances: [],
        activeIntervals: [],
        intervals: [],
        activeMilliseconds: 0,
        open: false,
      };
      timelines.set(rootSessionID, emptyTimeline);
    }
  }

  const roots = [...rootIDs].sort((left, right) => left.localeCompare(right)).map((rootSessionID) => {
    const sessionIDs = [...allSessionIDs]
      .filter((sessionID) => rootForSession.get(sessionID) === rootSessionID)
      .sort((left, right) => left.localeCompare(right));
    if (!sessionIDs.includes(rootSessionID)) sessionIDs.unshift(rootSessionID);
    const participants = sessionIDs
      .map((sessionID) => timelines.get(sessionID))
      .filter((timeline): timeline is ActivityParticipantTimeline => timeline !== undefined);
    const activeIntervals = mergeIntervals(participants.flatMap((participant) => participant.activeIntervals));
    return {
      rootSessionID,
      sessionIDs,
      descendantSessionIDs: sessionIDs.filter((sessionID) => sessionID !== rootSessionID),
      participants,
      activeIntervals,
      intervals: activeIntervals,
      activeMilliseconds: calculateActiveMilliseconds(activeIntervals),
    } satisfies ActivityRootSummary;
  });

  const activeMillisecondsByRoot = new Map(
    roots.map((root) => [root.rootSessionID, root.activeMilliseconds] as const),
  );
  const rootActiveMilliseconds: Record<string, number> = {};
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
    rootActiveMilliseconds,
  };
}

export const replayActivityEvents = replayActivity;

export function resolveRootSessionID(
  sessionID: string,
  parentBySessionID: ReadonlyMap<string, string | undefined>,
): string {
  const seen = new Map<string, number>();
  const path: string[] = [];
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

function calculateInstanceIntervals(
  events: readonly LifecycleActivityEvent[],
  sessionID: string,
  instanceID: string,
  options: ActivityReplayOptions,
): ActivityInstanceTimeline & { intervals: ActivityInterval[] } {
  const boundary = resolveInstanceBoundary(events, sessionID, instanceID, options);
  const boundedEvents = events
    .filter((event) => boundary === undefined || event.timestamp <= boundary)
    .sort(compareActivityEvents);
  const intervals: ActivityInterval[] = [];
  let currentState: LifecycleState | undefined;
  let activeStart: number | undefined;

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
    ...(currentState === undefined ? {} : { currentState }),
    ...(boundary === undefined ? {} : { boundary }),
  };
}

function resolveInstanceBoundary(
  events: readonly LifecycleActivityEvent[],
  sessionID: string,
  instanceID: string,
  options: ActivityReplayOptions,
): number | undefined {
  const candidates: number[] = [];
  const globalCutoff = resolveGlobalCutoff(options);
  if (globalCutoff !== undefined) candidates.push(globalCutoff);

  const instanceEnd = firstBoundary(
    resolveBoundarySpec(options.instanceEndedAt, instanceID, sessionID),
    resolveBoundarySpec(options.instanceEndTimes, instanceID, sessionID),
  );
  if (instanceEnd !== undefined) candidates.push(instanceEnd);

  const observedBoundary = resolveBoundarySpec(options.lastObservedAt, instanceID, sessionID);
  if (observedBoundary !== undefined) candidates.push(observedBoundary);

  const eventInstanceEnds = events
    .map((event) => event.instanceEndedAt)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (eventInstanceEnds.length > 0) candidates.push(Math.min(...eventInstanceEnds));

  const eventObservations = events
    .map((event) => event.lastObservedAt)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (eventObservations.length > 0) candidates.push(Math.max(...eventObservations));

  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function resolveGlobalCutoff(options: ActivityReplayOptions): number | undefined {
  const candidates = [options.replayCutoff, options.cutoff, options.until]
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function normalizeReplayInput(input: ActivityReplayInput): ActivityReplayOptions {
  return typeof input === "number" ? { replayCutoff: input } : input;
}

function resolveBoundarySpec(
  spec: ActivityBoundarySpec | undefined,
  instanceID: string,
  sessionID: string,
): number | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "number") return Number.isFinite(spec) ? spec : undefined;
  if (typeof spec === "function") {
    const value = spec(instanceID, sessionID);
    return Number.isFinite(value) ? value : undefined;
  }
  const keys = [
    `${sessionID}:${instanceID}`,
    `${sessionID}/${instanceID}`,
    instanceID,
    sessionID,
  ];
  for (const key of keys) {
    const value = isReadonlyMap(spec)
      ? spec.get(key)
      : (spec as Readonly<Record<string, number>>)[key];
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function groupLifecycleEvents(
  events: readonly LifecycleActivityEvent[],
): Map<string, LifecycleActivityEvent[]> {
  const groups = new Map<string, LifecycleActivityEvent[]>();
  for (const event of events) {
    const key = streamKey(event.sessionID, event.instanceID);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort(compareActivityEvents);
  return groups;
}

function streamKey(sessionID: string, instanceID: string): string {
  return `${sessionID.length}:${sessionID}${instanceID.length}:${instanceID}`;
}

function splitStreamKey(key: string): [string, string] {
  const firstColon = key.indexOf(":");
  const sessionLength = Number(key.slice(0, firstColon));
  const sessionStart = firstColon + 1;
  const instanceLengthStart = sessionStart + sessionLength;
  const secondColon = key.indexOf(":", instanceLengthStart);
  const instanceLength = Number(key.slice(instanceLengthStart, secondColon));
  const instanceStart = secondColon + 1;
  return [key.slice(sessionStart, sessionStart + sessionLength), key.slice(instanceStart, instanceStart + instanceLength)];
}

function splitStreamKeyObject(key: string): { sessionID: string; instanceID: string } {
  const [sessionID, instanceID] = splitStreamKey(key);
  return { sessionID, instanceID };
}

function inferEventKind(value: Record<string, unknown>): ActivityEventKind | undefined {
  if (isLifecycleState(value.state)) return "lifecycle";
  if (Object.prototype.hasOwnProperty.call(value, "parentSessionID")
    || Object.prototype.hasOwnProperty.call(value, "parentSessionId")) {
    return "parent";
  }
  return undefined;
}

function normalizeParentSessionID(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isLifecycleEvent(event: ActivityEvent): event is LifecycleActivityEvent {
  return event.kind === "lifecycle";
}

function pushInterval(intervals: ActivityInterval[], start: number, end: number): void {
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ start, end });
}

function firstBoundary(...values: Array<number | undefined>): number | undefined {
  const valid = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return valid.length === 0 ? undefined : Math.min(...valid);
}

function fnv1a(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<string, number> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { get?: unknown }).get === "function";
}
