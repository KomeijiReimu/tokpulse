import { createHash, randomUUID } from "node:crypto";
import type { Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin";
import {
  HISTORY_VERSION,
  HistoryRecord,
  HistoryRecordQuality,
  TokenCounts,
  normalizeTokenCounts,
  timeToFirstToken,
  utf8ByteLength,
} from "./core.js";
import {
  ACTIVITY_VERSION,
  ActivityEvent,
  LifecycleActivityEvent,
  LifecycleState,
  isActiveState,
  normalizeActivityEvent,
  replayActivity,
} from "./activity.js";
import { ActivityLedger, createActivityLedger } from "./runs-storage.js";
import { type CompletionUpdate, type ContentMetadataCache, type ContentProgress, type MeasuredHistoryRecord, cachedContentProgress, coerceCompletionUpdate, createContentMetadataCache, createContentProgress, earliestFirstOutput, isNewerCompletionUpdate, mergeContentProgress, noteStepIdentity, taintContentProgress } from './statistics.js';
import { createHistoryStorage, HistoryStorage, readHistoryFile } from "./storage.js";
import { applyFirstResponseSignal, recordContentArrival, thinkingFirstResponseSignal } from "./statistics.js";
import { createTotalsStorage, isCorruptTotalsError, type TotalsStorage } from "./totals-storage.js";
import { normalizeAgentName } from "./agent-names.js";
import { createScopeRegistry, coerceScopeEvidence, type ScopeRegistry, type CompactScopeEvidence } from "./scope.js";

export interface ServerOptions {
  historyPath?: string;
  runsPath?: string;
  totalsPath?: string;
  maxRecords?: number;
  bytesPerToken?: number;
}

interface CandidateStream {
  hasData: boolean;
}

interface ActiveState {
  messageID: string;
  sessionID: string;
  startedAt: number;
  firstTokenAt?: number;
  timing?: HistoryRecord["time"];
  liveAssistant?: boolean;
  observedFromStart?: boolean;
  progress?: ContentProgress;
  model?: string;
  agent?: string;
  cost?: number;
  fallbackTokens: Partial<TokenCounts>;
  legacy: CandidateStream;
  v2: CandidateStream;
}

interface AnyRecord {
  [key: string]: any;
}

interface ActivityRuntime {
  ledger: ActivityLedger;
  instanceID: string;
  nextSeq: number;
  assignments: Map<string, ActivityEvent>;
  writtenFacts: Set<string>;
  rawTimestamps: Map<string, number>;
}

interface PreparedActivityEvent<T extends ActivityEvent> {
  event: T;
  assignmentKey: string;
}

const DEFAULT_HISTORY_PATH = ".opencode/oc-tps/history.jsonl";
const ACTIVITY_EVENT_NAMESPACE = "oc-tps";
const PARENT_LOOKUP_TIMEOUT_MS = 200;
const QUERY_CONCURRENCY = 4;
const QUERY_RETRY_MS = 30_000;
const QUERY_CACHE_LIMIT = 2048;
const PENDING_PERSISTENCE_LIMIT = 128;
const PENDING_PERSISTENCE_BYTES = 4 * 1024 * 1024;
const PERSISTENCE_RETRY_BATCH = 4;
const PERSISTENCE_RETRY_LIMIT = 3;
interface PendingPersistence {
  record: HistoryRecord;
  bytes: number;
  retries: number;
}
interface SourceRuntime {
  scopes: ScopeRegistry;
  persistedScopes: Map<string, string>;
  messageScopes: Map<string, CompactScopeEvidence>;
  metadataGeneration: Map<string, number>;
  queried: Map<string, number>;
  outstanding: Set<string>;
  jobs: Array<() => Promise<void>>;
  workers: number;
  epochs: Map<string, number>;
  responses: Map<string, string>;
  pendingPersistence: Map<string, PendingPersistence>;
  pendingBytes: number;
  states: Map<string, LifecycleState>;
  tools: Map<string, { sessionID: string; pending: boolean }>;
  reconciled: Set<string>;
  enqueue: (job: () => Promise<void>) => Promise<void>;
  requestMetadata: (sessionID: string, prioritize?: boolean) => void;
  retryPersistence: (sessionID: string) => Promise<void>;
}
const sourcesByRuntime = new WeakMap<Map<string, ActiveState>, SourceRuntime>();

function runDeferred(runtime: SourceRuntime, job: () => Promise<void>, prioritize = false): void {
  if (prioritize) runtime.jobs.unshift(job);
  else runtime.jobs.push(job);
  const pump = () => {
    while (runtime.workers < QUERY_CONCURRENCY && runtime.jobs.length) {
      runtime.workers++;
      const next = runtime.jobs.shift()!;
      void Promise.resolve().then(next).catch((error) => warn("background reconciliation failed", error))
        .finally(() => { runtime.workers--; pump(); });
    }
  };
  pump();
}

async function persistScopeRegistry(runtime: SourceRuntime, totals: TotalsStorage): Promise<void> {
  for (const [id, proof] of Object.entries(runtime.scopes.serialize())) {
    const key = JSON.stringify(proof);
    if (runtime.persistedScopes.get(id) === key) continue;
    await totals.setSessionScope(id, proof);
    runtime.persistedScopes.set(id, key);
  }
}

function retireResponse(active: Map<string, ActiveState>, messageID: string, sessionID: string): void {
  const runtime = responseRuntime(active);
  active.delete(messageID);
  if (!runtime.current.has(sessionID) || runtime.current.get(sessionID) === messageID) {
    active.delete(pendingKey(sessionID));
    runtime.current.delete(sessionID);
    runtime.closed.add(sessionID);
    runtime.pendingTaints.delete(sessionID);
  }
  runtimeContentMetadata(active).completed.add(messageID);
}

function eligibleSession(runtime: SourceRuntime, sessionID: string): boolean {
  // ScopeRegistry delegates inherited identity to the shared scope helper.
  return !runtime.scopes.isExcluded(sessionID);
}

function forgetPendingPersistence(source: SourceRuntime, messageID: string): void {
  const pending = source.pendingPersistence.get(messageID);
  if (pending) source.pendingBytes -= pending.bytes;
  source.pendingPersistence.delete(messageID);
}

function discardExcludedPersistence(source: SourceRuntime): void {
  for (const [id, pending] of source.pendingPersistence) {
    if (!eligibleSession(source, pending.record.sessionID) || source.messageScopes.has(id)
      || ["magic-message", "magic-session"].includes(pending.record.scope?.sourceScope ?? "")) {
      forgetPendingPersistence(source, id);
    }
  }
}

function retainPendingPersistence(source: SourceRuntime, record: HistoryRecord): void {
  const prior = source.pendingPersistence.get(record.messageID);
  const bytes = utf8ByteLength(JSON.stringify(record));
  if ((!prior && source.pendingPersistence.size >= PENDING_PERSISTENCE_LIMIT)
    || source.pendingBytes - (prior?.bytes ?? 0) + bytes > PENDING_PERSISTENCE_BYTES) {
    // Finite in-memory retry, not a new durable journal. Never silently evict an
    // exact record or restore it as LIVE/provisional under persistent failure.
    warn(`pending completion capacity exceeded; unpersisted message ${record.messageID}`);
    return;
  }
  const sameUpdate = (prior?.record as MeasuredHistoryRecord | undefined)?.update?.fingerprint
    === (record as MeasuredHistoryRecord).update?.fingerprint;
  forgetPendingPersistence(source, record.messageID);
  source.pendingPersistence.set(record.messageID, { record, bytes, retries: sameUpdate ? prior?.retries ?? 0 : 0 });
  source.pendingBytes += bytes;
}

async function persistCompletedRecord(
  source: SourceRuntime, storage: HistoryStorage, totals: TotalsStorage, record: HistoryRecord,
): Promise<boolean> {
  const wrote = await safeUpsert(storage, totals, record);
  if (wrote) forgetPendingPersistence(source, record.messageID);
  else retainPendingPersistence(source, record);
  return wrote;
}

async function retryPendingPersistence(
  source: SourceRuntime, storage: HistoryStorage, totals: TotalsStorage, sessionID: string | undefined,
): Promise<void> {
  discardExcludedPersistence(source);
  let attempted = 0;
  for (const [id, pending] of source.pendingPersistence) {
    if (pending.record.sessionID !== sessionID || pending.retries >= PERSISTENCE_RETRY_LIMIT) continue;
    if (attempted++ >= PERSISTENCE_RETRY_BATCH) break;
    pending.retries++;
    if (await safeUpsert(storage, totals, pending.record)) forgetPendingPersistence(source, id);
    else if (pending.retries === PERSISTENCE_RETRY_LIMIT) {
      warn(`completion retry budget exhausted; retaining non-LIVE message ${id}`);
    }
  }
}

function scheduleIdleReconciliation(
  input: PluginInput, source: SourceRuntime, activity: ActivityRuntime,
  active: Map<string, ActiveState>,
  sessionID: string, messageID: string, info: AnyRecord, epoch: number,
): void {
  const sessionClient = (input as AnyRecord).client?.session;
  const status = sessionClient?.status;
  // A tool-call/next-loop completion is never a final-answer candidate.
  if (typeof status !== "function" || !["stop", "end_turn"].includes(info.finish)
    || source.reconciled.has(messageID) || !eligibleSession(source, sessionID)) return;
  // A status result closes only the queried participant. Children keep their
  // own activity intervals; they never suppress an authoritative parent idle.
  const activeOwn = () => [...active.values()].some((state) => state.sessionID === sessionID)
    || [...source.tools.values()].some((tool) => tool.pending && tool.sessionID === sessionID);
  const fresh = () => (source.epochs.get(sessionID) ?? 0) === epoch
    && source.responses.get(sessionID) === messageID && eligibleSession(source, sessionID) && !activeOwn();
  if (!fresh()) return;
  source.reconciled.add(messageID);
  runDeferred(source, async () => {
    if (!fresh()) return;
    const controller = new AbortController();
    try {
      const directory = typeof input.directory === "string" && input.directory.length ? input.directory : undefined;
      // One deadline covers status and (only for a missing SID) fresh existence
      // proof. No polling, cached existence, or second independent 200ms wait.
      const confirmed = await withTimeout((async () => {
        const v2 = status.length >= 2;
        const response = await (v2
          ? status.call(sessionClient, { directory }, { signal: controller.signal })
          : status.call(sessionClient, { query: { directory }, signal: controller.signal }));
        const receivedAt = Date.now();
        const receivedMono = performance.now();
        if (controller.signal.aborted || !fresh() || !isRecord(response) || response.error !== undefined) return;
        const envelope = ["data", "error", "request", "response"].some((key) => Object.prototype.hasOwnProperty.call(response, key));
        const states = plainSDKRecord(envelope ? response.data : response);
        if (!states) return;
        if (Object.prototype.hasOwnProperty.call(states, sessionID)) {
          const names = statusNames(states[sessionID]);
          if (!names.includes("idle") || names.includes("busy") || names.includes("retry")) return;
          // Keep successful legacy explicit-idle fixtures without HTTP fields.
          if (response.response !== undefined && response.response?.status !== 200) return;
        } else {
          // Official status.list is ACTIVE-ONLY: a missing SID is default-idle
          // only with successful scoped HTTP evidence and fresh same-dir get.
          if (!directory || response.response?.status !== 200
            || !Object.values(states).every((value) => ["busy", "retry", "idle"].includes(plainSDKRecord(value)?.type))
            || reconciliationRequestDirectory(response, directory) !== directory) return;
          const get = sessionClient?.get;
          if (typeof get !== "function" || controller.signal.aborted || !fresh()) return;
          const sessionResponse = await (get.length >= 2
            ? get.call(sessionClient, { sessionID, directory }, { signal: controller.signal })
            : get.call(sessionClient, { path: { id: sessionID }, query: { directory }, signal: controller.signal }));
          if (controller.signal.aborted || !fresh() || !isRecord(sessionResponse)
            || sessionResponse.error !== undefined || sessionResponse.response?.status !== 200) return;
          const session = plainSDKRecord(sessionResponse.data);
          if (!session || session.id !== sessionID || plainSDKRecord(session.location)?.directory !== directory
            || reconciliationRequestDirectory(sessionResponse, directory) !== directory) return;
          // This get is existence proof only, not a second metadata classifier.
          // Existing gated metadata resolution remains the owner of scope facts.
        }
        // Fresh get proves scope/existence only; its wait is not user task time.
        return { receivedAt, receivedMono };
      })(), PARENT_LOOKUP_TIMEOUT_MS);
      if (!confirmed) return;
      const { receivedAt, receivedMono } = confirmed;
      await source.enqueue(async () => {
        if (!fresh()) return;
        // Only an authoritative query boundary closes task activity. Part-end
        // timestamps are not generation-end evidence. This is participant idle,
        // not a force-close of the root's independently active descendants.
        source.states.set(sessionID, "idle");
        await captureActivityForEvent(activity, "session.status", { sessionID, status: { type: "idle" },
          observedAt: receivedAt, lastObservedAt: receivedAt }, {}, receivedAt);
        await source.retryPersistence(sessionID);
        void receivedMono;
      });
    } catch { /* Unknown/failure/timeout leaves lifecycle unchanged. */ }
    finally { controller.abort(); }
  }, true);
}

function plainSDKRecord(value: unknown): AnyRecord | undefined {
  if (!isRecord(value)) return;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : undefined;
}

/** Verify the effective request scope, never infer a directory from cwd.
 * An explicit supplied query is fallback proof only if request fields are absent. */
function reconciliationRequestDirectory(result: AnyRecord, suppliedDirectory: string): string | undefined {
  if (result.request === undefined) return suppliedDirectory;
  const request = asRecord(result.request);
  if (!request || typeof request.url !== "string") return;
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key.toLowerCase().includes("workspace"))) return;
    const headers = new Headers(request.headers);
    if ([...headers.keys()].some((key) => key.toLowerCase().includes("workspace"))) return;
    if (url.searchParams.has("directory")) {
      const directories = url.searchParams.getAll("directory");
      if (directories.length !== 1 || !directories[0]) return;
      // GET rewrite can place an already percent-encoded SDK header into query,
      // so URLSearchParams removes only the outer URL-serialization layer.
      // Preserve a matching plaintext directory (including literal '%' names).
      return directories[0] === suppliedDirectory ? directories[0] : decodeURIComponent(directories[0]);
    }
    const header = headers.get("x-opencode-directory");
    return header ? decodeURIComponent(header) || undefined : undefined;
  } catch { return; }
}
const activityInitializationQueues = new Map<string, Promise<void>>();
const contentMetadataByRuntime = new WeakMap<Map<string, ActiveState>, ContentMetadataCache>();
interface ResponseRuntime {
  current: Map<string, string>;
  closed: Set<string>;
  pendingTaints: Map<string, Set<string>>;
  tainted: Set<string>;
  connected: boolean;
  observedSince: number;
}
const responsesByRuntime = new WeakMap<Map<string, ActiveState>, ResponseRuntime>();
function responseRuntime(active: Map<string, ActiveState>): ResponseRuntime {
  let runtime = responsesByRuntime.get(active);
  if (!runtime) { runtime = { current: new Map(), closed: new Set(), pendingTaints: new Map(), tainted: new Set(), connected: false, observedSince: Infinity }; responsesByRuntime.set(active, runtime); }
  return runtime;
}
function taintResponse(active: Map<string, ActiveState>, state: ActiveState, reason: string): void {
  state.progress ??= cachedContentProgress(runtimeContentMetadata(active), state.messageID);
  taintContentProgress(state.progress, reason);
  responseRuntime(active).tainted.add(state.messageID);
}
function bindPendingTaint(active: Map<string, ActiveState>, state: ActiveState): void {
  if (state.messageID.startsWith("__pending__:")) return;
  const runtime = responseRuntime(active);
  for (const reason of runtime.pendingTaints.get(state.sessionID) ?? []) taintResponse(active, state, reason);
  runtime.pendingTaints.delete(state.sessionID);
}
function recordResponseLifecycle(active: Map<string, ActiveState>, type: string, properties: AnyRecord, event: AnyRecord, receivedAt: number): void {
  const runtime = responseRuntime(active);
  const status = typeof properties.status === "string" ? properties.status : properties.status?.type;
  const disruption = type === "server.connected" ? runtime.connected
    : type.startsWith("workspace.") && (type.includes("status") || type.includes("disposed") || type.includes("deleted"));
  if (type === "server.connected") runtime.connected = true;
  if (disruption) {
    runtime.observedSince = Math.max(runtime.observedSince, receivedAt);
    for (const state of active.values()) taintResponse(active, state, "transport-disruption");
  }
  const failure = status === "retry" || (type.startsWith("session.next.") && (type.endsWith(".retried") || type.endsWith(".failed")))
    || type === "session.error" || type.includes("provider.error") || type.includes("provider-error")
    || eventInfo(properties, event)?.error !== undefined;
  if (!failure) return;
  const sessionID = readSessionIDFromEvent(type, properties, event);
  const current = sessionID ? runtime.current.get(sessionID) : undefined;
  const info = eventInfo(properties, event);
  // Lifecycle info.id often names the SESSION, not an assistant response.
  const explicitMessageID = [properties.messageID, properties.assistantMessageID, properties.part?.messageID,
    info?.messageID, info?.assistantMessageID, event.messageID, event.assistantMessageID,
    info?.role === "assistant" ? info.id : undefined].find((id) => typeof id === "string" && id.length > 0);
  const messageID = explicitMessageID ?? (current && active.has(current) ? current : undefined)
    ?? [...active.values()].find((state) => state.sessionID === sessionID && !state.messageID.startsWith("__pending__:"))?.messageID;
  const reason = status === "retry" || type.includes("retried") ? "retry" : "failed";
  if (messageID) {
    runtime.tainted.add(messageID);
    const state = active.get(messageID);
    if (state) taintResponse(active, state, reason);
  } else if (sessionID) {
    const pending = runtime.pendingTaints.get(sessionID) ?? new Set<string>();
    pending.add(reason); runtime.pendingTaints.set(sessionID, pending);
  }
}
function runtimeContentMetadata(active: Map<string, ActiveState>): ContentMetadataCache {
  let metadata = contentMetadataByRuntime.get(active);
  if (!metadata) { metadata = createContentMetadataCache(); contentMetadataByRuntime.set(active, metadata); }
  return metadata;
}
function isSnapshotIngress(event: AnyRecord, properties: AnyRecord): boolean {
  return event.replay === true || properties.replay === true
    || [event.source, properties.source].some((source) => ["snapshot", "history", "reconnect"].includes(source));
}
/** Two-argument snapshots only cache metadata. Live ingress may attach a signal
 * to an already-owned current assistant, but never creates activity/samples. */
export function recordPartMetadata(active: Map<string, ActiveState>, properties: AnyRecord, now?: number, event: AnyRecord = {}): void {
  const metadata = runtimeContentMetadata(active);
  const part = asRecord(properties.part);
  // Part snapshots repeat the whole text. Speed digests are gone, so do not hash them.
  if (part && typeof part.messageID === "string" && typeof part.role === "string") metadata.roles.set(part.messageID, part.role);
  if (part?.type === "step-start") {
    noteStepIdentity(cachedContentProgress(metadata, part.messageID), part.stepID ?? properties.stepID ?? part.id);
  }
  if (!part || now === undefined || isSnapshotIngress(event, properties)) return;
  const state = active.get(part.messageID);
  if (!state?.liveAssistant || metadata.completed.has(part.messageID)) return;
  const signal = thinkingFirstResponseSignal(part, { messageID: state.messageID, sessionID: state.sessionID,
    role: metadata.roles.get(state.messageID) ?? "unknown", start: state.startedAt, now, live: true });
  if (signal) state.timing = applyFirstResponseSignal(state.timing ?? { start: state.startedAt }, signal);
}

export const server: Plugin = async (input: PluginInput, pluginOptions?: PluginOptions) => {
  const options = resolveOptions(pluginOptions ?? (input as AnyRecord).options ?? (input as AnyRecord).config);
  const baseDirectory = resolveProjectDirectory(input);
  const historyPath = resolveHistoryPath(baseDirectory, options.historyPath);
  const storage = createHistoryStorage(historyPath, {
    maxRecords: options.maxRecords,
  });
  const totals = createTotalsStorage({
    historyPath,
    totalsPath: options.totalsPath,
  });
  const activity: ActivityRuntime = {
    ledger: createActivityLedger({ historyPath, runsPath: options.runsPath }),
    instanceID: randomUUID(),
    nextSeq: 1,
    assignments: new Map(),
    writtenFacts: new Set(),
    rawTimestamps: new Map(),
  };
  let eventQueue: Promise<void> = Promise.all([
    initializeActivityRuntime(activity).catch((error: unknown) => {
      warn("activity ledger initialization failed", error);
    }),
    initializeTotals(storage, totals, historyPath).catch((error: unknown) => {
      warn("totals ledger initialization failed", error);
    }),
  ]).then(() => undefined);
  await eventQueue;
  const active = new Map<string, ActiveState>();
  const completedMessageIDs = new Set<string>();
  const metadata = runtimeContentMetadata(active);
  const persisted = await totals.read().catch(() => undefined);
  for (const [id, contribution] of Object.entries(persisted?.open ?? {})) {
    if (contribution.quality === "exact") { completedMessageIDs.add(id); metadata.completed.add(id); }
  }
  for (const id of Object.keys(persisted?.settled ?? {})) { completedMessageIDs.add(id); metadata.completed.add(id); }
  const parentSessionCache = new Map<string, string | undefined>();
  const source: SourceRuntime = {
    scopes: createScopeRegistry(persisted?.sessionScopes),
    persistedScopes: new Map(Object.entries(persisted?.sessionScopes ?? {}).map(([id, proof]) => [id, JSON.stringify(proof)])),
    messageScopes: new Map(), metadataGeneration: new Map(), queried: new Map(), outstanding: new Set(),
    jobs: [], workers: 0, epochs: new Map(), responses: new Map(), pendingPersistence: new Map(), pendingBytes: 0,
    states: new Map(), tools: new Map(), reconciled: new Set(),
    retryPersistence: (sessionID) => retryPendingPersistence(source, storage, totals, sessionID),
    enqueue: (job) => {
      const next = eventQueue.then(job).catch((error) => warn("reconciliation apply failed", error));
      eventQueue = next;
      return next;
    },
    requestMetadata: (sessionID, prioritize = true) => {
      const sessionClient = (input as AnyRecord).client?.session;
      const get = sessionClient?.get;
      if (typeof get !== "function" || source.scopes.isExcluded(sessionID) || source.outstanding.has(sessionID)) return;
      const now = performance.now();
      if (now - (source.queried.get(sessionID) ?? -Infinity) < QUERY_RETRY_MS) return;
      source.queried.delete(sessionID); source.queried.set(sessionID, now);
      while (source.queried.size > QUERY_CACHE_LIMIT) source.queried.delete(source.queried.keys().next().value!);
      source.outstanding.add(sessionID);
      const generation = source.metadataGeneration.get(sessionID) ?? 0;
      runDeferred(source, async () => {
        const controller = new AbortController();
        try {
          // SDK v1's generated get(options) takes path.id. SDK v2's generated
          // get(parameters, options) takes sessionID; raw fields remain intact.
          const v2 = get.length >= 2;
          const response = await withTimeout(Promise.resolve().then(() => v2
            ? get.call(sessionClient, { sessionID }, { signal: controller.signal })
            : get.call(sessionClient, { path: { id: sessionID }, signal: controller.signal })), PARENT_LOOKUP_TIMEOUT_MS);
          const arrivedAt = Date.now();
          if (!response || response.error) return;
          const raw = asRecord(response.data) ?? asRecord(response);
          const session = asRecord(raw?.session) ?? raw;
          if (!session || session.id !== sessionID) return;
          const sessionAgent = normalizeAgentName(session.agent);
          await source.enqueue(async () => {
            if ((source.metadataGeneration.get(sessionID) ?? 0) !== generation) return;
            source.scopes.observeSessionMetadata(sessionID, session);
            discardExcludedPersistence(source);
            const parent = source.scopes.getEvidence(sessionID)?.parentSessionID;
            if (parent) {
              parentSessionCache.set(sessionID, parent);
              await safeRecordParentFact(activity, "session.metadata.resolved", sessionID, parent, arrivedAt, {}, {});
              source.requestMetadata(parent);
              // Late ancestry is a separate canonical fact in sessionScopes
              // and runs. Do not forge a newer completion to rewrite history.
            }
            await persistScopeRegistry(source, totals);
            if (sessionAgent) await totals.setSessionAgent(sessionID, sessionAgent);
          });
        } catch { /* SDK failure/404 is unknown, never negative source proof. */ }
        finally { controller.abort(); source.outstanding.delete(sessionID); }
      }, prioritize);
    },
  };
  sourcesByRuntime.set(active, source);
  for (const [id, raw] of Object.entries(persisted?.messageScopes ?? {})) {
    const proof = coerceScopeEvidence(raw);
    if (proof?.sourceScope === "magic-message") source.messageScopes.set(id, proof);
  }
  for (const [id, contribution] of Object.entries({ ...persisted?.settled, ...persisted?.open })) {
    const proof = contribution !== true ? coerceScopeEvidence(contribution.excluded) : undefined;
    if (proof?.sourceScope === "magic-message") source.messageScopes.set(id, proof);
  }
  for (const [id, proof] of Object.entries(source.scopes.serialize())) {
    if (proof.parentSessionID) parentSessionCache.set(id, proof.parentSessionID);
  }
  // Bootstrap old retained identities with the same bounded background workers;
  // startup and the serial event queue never wait for a thousand SDK requests.
  for (const id of Object.keys(persisted?.sessions ?? {})) source.requestMetadata(id, false);
  // Establish the epoch when ingress is ready, not before asynchronous startup.
  responseRuntime(active).observedSince = Date.now();

  const event = (payload: { event?: unknown }): Promise<void> => {
    const rawEvent = payload?.event;
    const receivedAt = Date.now();
    const incoming = unwrapIncomingEvent(rawEvent);
    let ingressEpoch = 0;
    if (incoming) {
      const properties = asRecord(incoming.properties) ?? asRecord(incoming.data) ?? {};
      const sid = readSessionIDFromEvent(incoming.type, properties, incoming);
      if (sid && eligibleSession(source, sid)) {
        const info = eventInfo(properties, incoming);
        const id = readMessageID(properties, info ?? {});
        const live = !isSnapshotIngress(incoming, properties);
        const assistantWork = live && info?.role === "assistant" && id && !metadata.completed.has(id);
        const deltaWork = live && (incoming.type.endsWith(".delta") || incoming.type.startsWith("session.next.step."))
          && (id ? !metadata.completed.has(id) : responseRuntime(active).current.has(sid));
        const toolWork = live && properties.part?.type === "tool" && !["completed", "error"].includes(properties.part.state?.status);
        if (assistantWork) source.responses.set(sid, id);
        if (assistantWork || deltaWork || toolWork || lifecycleStateForEvent(incoming.type, properties, incoming)) {
          source.epochs.set(sid, (source.epochs.get(sid) ?? 0) + 1);
        }
        ingressEpoch = source.epochs.get(sid) ?? 0;
      }
    }
    const next = eventQueue
      .then(() => handleEvent(
        rawEvent,
        input,
        storage,
        totals,
        activity,
        active,
        completedMessageIDs,
        parentSessionCache,
        receivedAt,
        ingressEpoch,
      ))
      .catch((error) => {
        warn("event handling failed", error);
      });
    eventQueue = next;
    return next;
  };

  return { event };
};

export function resolveProjectDirectory(input: Pick<PluginInput, "directory" | "worktree">): string {
  if (typeof input.worktree === "string" && input.worktree.length > 0 && input.worktree !== "/") {
    return input.worktree;
  }
  return input.directory;
}

export function resolveHistoryPath(baseDirectory: string, configuredPath?: string): string {
  if (!configuredPath || configuredPath.trim().length === 0) {
    return joinPath(baseDirectory, DEFAULT_HISTORY_PATH);
  }
  if (configuredPath.startsWith("/")) return configuredPath;
  return joinPath(baseDirectory, configuredPath);
}

function initializeActivityRuntime(runtime: ActivityRuntime): Promise<void> {
  const key = runtime.ledger.path;
  const previous = activityInitializationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(() => initializeActivityRuntimeNow(runtime));
  const settled = result.then(() => undefined, () => undefined);
  activityInitializationQueues.set(key, settled);
  return result;
}

async function initializeTotals(storage: HistoryStorage, totals: TotalsStorage, historyPath: string): Promise<void> {
  const retained = await storage.read();
  const recoverable = await readHistoryFile(historyPath);
  try {
    await seedRetainedTotals(totals, retained, recoverable);
  } catch (error) {
    if (!isCorruptTotalsError(error)) throw error;
    warn("totals ledger is corrupt", error);
    await totals.quarantine();
    await seedRetainedTotals(totals, retained, recoverable);
  }
}

async function seedRetainedTotals(
  totals: TotalsStorage,
  retained: readonly HistoryRecord[],
  recoverable: readonly HistoryRecord[] = retained,
): Promise<void> {
  await totals.seed(recoverable);
  await totals.backfillSpeed(recoverable);
  await totals.applyMany(retained, {
    retainedMessageIDs: retained.map((record) => record.messageID),
  });
}

async function initializeActivityRuntimeNow(runtime: ActivityRuntime): Promise<void> {
  const existing = await runtime.ledger.read({ dedupe: false });
  const maxSeqByInstance = new Map<string, number>();
  const recoveryEventIDs = new Set<string>();
  for (const event of existing) {
    runtime.writtenFacts.add(activityFactKey(event));
    if (event.seq !== undefined) {
      maxSeqByInstance.set(
        event.instanceID,
        Math.max(maxSeqByInstance.get(event.instanceID) ?? 0, event.seq),
      );
    }
    if (event.eventID.startsWith(`${ACTIVITY_EVENT_NAMESPACE}:recovery:`)) {
      recoveryEventIDs.add(event.eventID);
    }
  }
  runtime.nextSeq = (maxSeqByInstance.get(runtime.instanceID) ?? 0) + 1;

  const replay = replayActivity(existing);
  const recovery: LifecycleActivityEvent[] = [];
  for (const timeline of replay.timelines.values()) {
    for (const instance of timeline.instances) {
      if (!instance.open || instance.instanceID === runtime.instanceID) continue;
      const timestamp = reliableInstanceBoundary(instance.events, instance.boundary);
      if (timestamp === undefined) continue;
      const lastEvent = instance.events.at(-1);
      if (!lastEvent) continue;
      const eventID = recoveryEventID(
        instance.instanceID,
        instance.sessionID,
        lastEvent.eventID,
        timestamp,
      );
      if (recoveryEventIDs.has(eventID)) continue;
      const seq = (maxSeqByInstance.get(instance.instanceID) ?? 0) + 1;
      maxSeqByInstance.set(instance.instanceID, seq);
      const parentSessionID = lastEvent.parentSessionID;
      const normalized = normalizeActivityEvent({
        kind: "lifecycle",
        state: "stopped",
        sessionID: instance.sessionID,
        timestamp,
        observedAt: timestamp,
        instanceID: instance.instanceID,
        seq,
        eventID,
        instanceEndedAt: timestamp,
        lastObservedAt: timestamp,
        ...(parentSessionID ? { parentSessionID } : {}),
      });
      if (normalized?.kind === "lifecycle") recovery.push(normalized);
    }
  }

  if (recovery.length === 0) return;
  try {
    const appended = await runtime.ledger.appendMany(recovery);
    for (const event of appended) runtime.writtenFacts.add(activityFactKey(event));
  } catch (error) {
    warn("activity recovery write failed", error);
  }
}

async function captureActivityForEvent(
  runtime: ActivityRuntime,
  type: string,
  properties: AnyRecord,
  event: AnyRecord,
  timestamp: number,
): Promise<void> {
  const sessionID = readSessionIDFromEvent(type, properties, event);
  if (!sessionID) return;

  const parentSessionID = readParentSessionIDFromEvent(type, properties, event);
  await safeRecordParentFact(
    runtime,
    type,
    sessionID,
    parentSessionID,
    timestamp,
    properties,
    event,
  );

  const state = lifecycleStateForEvent(type, properties, event);
  if (!state) return;
  const lifecycleEvent = prepareLifecycleActivityEvent(
    runtime,
    type,
    sessionID,
    state,
    timestamp,
    parentSessionID,
    properties,
    event,
  );
  await safeAppendLifecycle(runtime, lifecycleEvent.event);
}

function activityFactKey(event: ActivityEvent): string {
  return JSON.stringify([
    event.kind,
    event.eventID,
    event.sessionID,
    event.kind === "lifecycle" ? event.state : null,
    event.parentSessionID ?? null,
    event.timestamp,
    event.observedAt,
    event.instanceID,
    event.seq ?? null,
    event.instanceEndedAt ?? null,
    event.lastObservedAt ?? null,
  ]);
}

function recoveryEventID(
  instanceID: string,
  sessionID: string,
  lastEventID: string,
  timestamp: number,
): string {
  return `${ACTIVITY_EVENT_NAMESPACE}:recovery:${encodeURIComponent(instanceID)}:${encodeURIComponent(sessionID)}:${encodeURIComponent(lastEventID)}:${timestamp}`;
}

function reliableInstanceBoundary(
  events: readonly LifecycleActivityEvent[],
  replayBoundary?: number,
): number | undefined {
  const boundary = numberOrUndefined(replayBoundary);
  if (boundary !== undefined) return boundary;
  const timestamps = events
    .map((event) => event.timestamp)
    .filter((value): value is number => numberOrUndefined(value) !== undefined);
  return timestamps.length === 0 ? undefined : Math.max(...timestamps);
}

function rawEventKey(type: string, event: AnyRecord): string {
  return stableSerialize([type, event]);
}

function needsActivityIdentity(type: string, properties: AnyRecord, event: AnyRecord): boolean {
  if (lifecycleStateForEvent(type, properties, event) !== undefined) return true;
  if (readParentSessionIDFromEvent(type, properties, event) !== undefined) return true;
  if (type !== "message.updated") return false;
  const info = eventInfo(properties, event);
  return info?.role === "assistant" && isCompleted(info, properties, event);
}

function runtimeEventTimestamp(
  runtime: ActivityRuntime,
  rawKey: string,
  event: AnyRecord,
  properties: AnyRecord,
  receivedAt = Date.now(),
): number {
  const explicit = explicitEventTimestamp(event, properties);
  if (explicit !== undefined) return explicit;
  const previous = runtime.rawTimestamps.get(rawKey);
  if (previous !== undefined) return previous;
  const timestamp = receivedAt;
  runtime.rawTimestamps.set(rawKey, timestamp);
  return timestamp;
}

function prepareLifecycleActivityEvent(
  runtime: ActivityRuntime,
  type: string,
  sessionID: string,
  state: LifecycleState,
  timestamp: number,
  parentSessionID: string | undefined,
  properties: AnyRecord,
  event: AnyRecord,
): PreparedActivityEvent<LifecycleActivityEvent> {
  const boundary = activityBoundaries(properties, event);
  const observedAt = activityObservedAt(properties, event, timestamp);
  const sourceID = sourceEventID(type, properties, event);
  const assignmentKey = stableSerialize([
    "lifecycle",
    type,
    sourceID ?? null,
    sessionID,
    state,
    parentSessionID ?? null,
    timestamp,
    observedAt,
    boundary.instanceEndedAt ?? null,
    boundary.lastObservedAt ?? null,
  ]);
  const existing = runtime.assignments.get(assignmentKey);
  if (existing?.kind === "lifecycle") return { event: existing, assignmentKey };

  const base = {
    version: ACTIVITY_VERSION,
    kind: "lifecycle" as const,
    state,
    sessionID,
    timestamp,
    observedAt,
    instanceID: runtime.instanceID,
    ...(parentSessionID ? { parentSessionID } : {}),
    ...boundary,
  } as const;
  const eventID = sourceID
    ? namespacedSourceEventID(type, sourceID, "lifecycle")
    : normalizeActivityEvent(base)?.eventID;
  const normalized = normalizeActivityEvent({
    ...base,
    seq: runtime.nextSeq++,
    ...(eventID ? { eventID } : {}),
  });
  if (!normalized || normalized.kind !== "lifecycle") {
    throw new TypeError("Unable to normalize lifecycle activity event");
  }
  runtime.assignments.set(assignmentKey, normalized);
  return { event: normalized, assignmentKey };
}

function prepareParentActivityEvent(
  runtime: ActivityRuntime,
  type: string,
  sessionID: string,
  parentSessionID: string,
  timestamp: number,
  properties: AnyRecord,
  event: AnyRecord,
): PreparedActivityEvent<ActivityEvent & { kind: "parent" }> {
  const boundary = activityBoundaries(properties, event);
  const observedAt = activityObservedAt(properties, event, timestamp);
  const sourceID = sourceEventID(type, properties, event);
  const assignmentKey = stableSerialize([
    "parent",
    type,
    sourceID ?? null,
    sessionID,
    parentSessionID,
    timestamp,
    observedAt,
    boundary.instanceEndedAt ?? null,
    boundary.lastObservedAt ?? null,
  ]);
  const existing = runtime.assignments.get(assignmentKey);
  if (existing?.kind === "parent") return { event: existing as ActivityEvent & { kind: "parent" }, assignmentKey };

  const base = {
    version: ACTIVITY_VERSION,
    kind: "parent" as const,
    sessionID,
    parentSessionID,
    timestamp,
    observedAt,
    instanceID: runtime.instanceID,
    ...boundary,
  } as const;
  const eventID = sourceID
    ? namespacedSourceEventID(type, sourceID, "parent")
    : normalizeActivityEvent(base)?.eventID;
  const normalized = normalizeActivityEvent({
    ...base,
    seq: runtime.nextSeq++,
    ...(eventID ? { eventID } : {}),
  });
  if (!normalized || normalized.kind !== "parent") {
    throw new TypeError("Unable to normalize parent activity event");
  }
  runtime.assignments.set(assignmentKey, normalized);
  return { event: normalized, assignmentKey };
}

async function safeAppendLifecycle(
  runtime: ActivityRuntime,
  event: LifecycleActivityEvent,
): Promise<void> {
  const factKey = activityFactKey(event);
  if (runtime.writtenFacts.has(factKey)) return;
  try {
    const appended = await runtime.ledger.appendLifecycle(event);
    runtime.writtenFacts.add(activityFactKey(appended));
  } catch (error) {
    warn("activity lifecycle write failed", error);
  }
}

async function safeAppendParent(
  runtime: ActivityRuntime,
  event: ActivityEvent & { kind: "parent" },
): Promise<void> {
  const factKey = activityFactKey(event);
  if (runtime.writtenFacts.has(factKey)) return;
  try {
    const appended = await runtime.ledger.appendParent(event);
    runtime.writtenFacts.add(activityFactKey(appended));
  } catch (error) {
    warn("activity parent write failed", error);
  }
}

async function safeRecordParentFact(
  runtime: ActivityRuntime,
  type: string,
  sessionID: string,
  parentSessionID: string | undefined,
  timestamp: number,
  properties: AnyRecord,
  event: AnyRecord,
): Promise<void> {
  if (!parentSessionID || parentSessionID === sessionID) return;
  try {
    const parentEvent = prepareParentActivityEvent(
      runtime,
      type,
      sessionID,
      parentSessionID,
      timestamp,
      properties,
      event,
    );
    await safeAppendParent(runtime, parentEvent.event);
  } catch (error) {
    warn("parent fact handling failed", error);
  }
}

function sourceEventID(type: string, properties: AnyRecord, event: AnyRecord): string | undefined {
  const explicit = readStringFrom(
    [
      event,
      properties,
      asRecord(event.event),
      asRecord(properties.event),
      asRecord(properties.info),
      asRecord(properties.session),
      asRecord(event.info),
      asRecord(event.session),
    ],
    ["eventID", "eventId"],
  );
  if (explicit) return explicit;
  const eventID = readStringFrom([
    event,
    properties,
    asRecord(event.event),
    asRecord(properties.event),
    asRecord(properties.info),
    asRecord(properties.session),
    asRecord(event.info),
    asRecord(event.session),
  ], ["id"]);
  if (eventID) return eventID;
  return undefined;
}

function namespacedSourceEventID(
  type: string,
  sourceID: string,
  kind: "lifecycle" | "parent",
): string {
  return `${ACTIVITY_EVENT_NAMESPACE}:source:${kind}:${encodeURIComponent(type)}:${encodeURIComponent(sourceID)}`;
}

function activityObservedAt(properties: AnyRecord, event: AnyRecord, timestamp: number): number {
  return numberFromSources([
    event,
    properties,
    asRecord(event.event),
    asRecord(properties.event),
    asRecord(properties.info),
    asRecord(properties.session),
    asRecord(event.info),
    asRecord(event.session),
  ], ["observedAt"])
    ?? timestamp;
}

function activityBoundaries(
  properties: AnyRecord,
  event: AnyRecord,
): { instanceEndedAt?: number; lastObservedAt?: number } {
  const sources = [
    event,
    properties,
    asRecord(event.event),
    asRecord(properties.event),
    asRecord(properties.info),
    asRecord(properties.session),
    asRecord(event.info),
    asRecord(event.session),
  ];
  const instanceEndedAt = numberFromSources(sources, ["instanceEndedAt", "instanceEndAt"]);
  const lastObservedAt = numberFromSources(sources, ["lastObservedAt"]);
  return {
    ...(instanceEndedAt === undefined ? {} : { instanceEndedAt }),
    ...(lastObservedAt === undefined ? {} : { lastObservedAt }),
  };
}

/** Session-entity agent only. Assistant message ids are not session ids, and mode/title are ignored. */
function matchingSessionAgent(sessionID: string, candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    const entity = asRecord(candidate);
    if (!entity || entity.id !== sessionID) continue;
    if (entity.role === "assistant" || entity.role === "user") continue;
    const name = normalizeAgentName(entity.agent);
    if (name) return name;
  }
  return undefined;
}

function readSessionIDFromEvent(type: string, properties: AnyRecord, event: AnyRecord): string | undefined {
  const direct = readStringFrom([properties, event], [
    "sessionID",
    "sessionId",
    "session.id",
  ]);
  if (direct) return direct;
  const sessionObjectID = readStringFrom([
    asRecord(properties.session),
    asRecord(event.session),
    asRecord(properties.event),
    asRecord(event.event),
  ], ["id"]);
  if (sessionObjectID) return sessionObjectID;
  const nested = [
    asRecord(properties.part),
    asRecord(event.part),
    asRecord(properties.session),
    asRecord(properties.event),
    asRecord(event.session),
    asRecord(event.event),
    asRecord(properties.info),
    asRecord(event.info),
  ];
  const sessionID = readStringFrom(nested, ["sessionID", "sessionId", "session.id"]);
  if (sessionID) return sessionID;
  if (type === "session.status" || type.startsWith("session.")) {
    const nestedID = readStringFrom([
      asRecord(properties.info),
      asRecord(event.info),
      asRecord(properties.event),
      asRecord(event.event),
    ], ["id"]);
    if (nestedID) return nestedID;
    if (type === "session.created" || type === "session.updated") {
      return readStringFrom([properties, event], ["id"]);
    }
  }
  return undefined;
}

function readParentSessionIDFromEvent(
  type: string,
  properties: AnyRecord,
  event: AnyRecord,
): string | undefined {
  const normalizedType = type.toLowerCase();
  const sources = [
    properties,
    event,
    asRecord(properties.info),
    asRecord(properties.message),
    asRecord(properties.event),
    asRecord(event.info),
    asRecord(event.message),
    asRecord(event.event),
  ];
  const explicit = readStringFrom(sources, ["parentSessionID", "parentSessionId"]);
  if (explicit) return explicit;

  const sessionSources = sessionEntitySources([
    properties,
    event,
    asRecord(properties.info),
    asRecord(event.info),
    asRecord(properties.event),
    asRecord(event.event),
  ]);
  if (normalizedType === "session.created" || normalizedType === "session.updated") {
    for (const source of [
      properties,
      event,
      asRecord(properties.info),
      asRecord(properties.event),
      asRecord(event.info),
      asRecord(event.event),
    ]) {
      if (source) sessionSources.push(source);
    }
  }
  return readStringFrom(sessionSources, [
    "parentID",
    "parentSessionID",
    "parentSessionId",
    "parent.id",
  ]);
}

function sessionEntitySources(sources: readonly (AnyRecord | undefined)[]): AnyRecord[] {
  const entities: AnyRecord[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const key of ["session", "data.session", "event.session"]) {
      const entity = asRecord(getPath(source, key));
      if (entity) entities.push(entity);
    }
  }
  return entities;
}

function numberFromSources(
  sources: readonly (AnyRecord | undefined)[],
  keys: readonly string[],
): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = numberOrUndefined(getPath(source, key));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function lifecycleStateForEvent(
  type: string,
  properties: AnyRecord,
  event: AnyRecord,
): LifecycleState | undefined {
  const normalizedType = type.toLowerCase();
  const isStatusEvent = normalizedType === "session.status" || normalizedType.endsWith(".status");
  const isTerminalEvent = normalizedType === "session.error"
    || normalizedType === "session.abort"
    || normalizedType === "session.aborted"
    || normalizedType === "session.cancel"
    || normalizedType === "session.cancelled"
    || normalizedType === "session.stop"
    || normalizedType === "session.stopped"
    || normalizedType === "session.completed";
  const isCanonicalRetry = normalizedType === "session.next.retried";
  const isCanonicalFailure = normalizedType === "session.next.step.failed";
  if (
    normalizedType !== "session.idle"
    && !isStatusEvent
    && !isTerminalEvent
    && !isCanonicalRetry
    && !isCanonicalFailure
  ) return undefined;
  const values = [
    properties.status,
    properties.state,
    event.status,
    event.state,
    asRecord(properties.info)?.status,
    asRecord(properties.info)?.state,
    asRecord(properties.session)?.status,
    asRecord(properties.session)?.state,
    asRecord(properties.event)?.status,
    asRecord(properties.event)?.state,
    asRecord(event.info)?.status,
    asRecord(event.info)?.state,
    asRecord(event.session)?.status,
    asRecord(event.session)?.state,
    asRecord(event.event)?.status,
    asRecord(event.event)?.state,
  ];
  const names = values.flatMap((value) => statusNames(value));
  const normalized = names.map((value) => value.toLowerCase());
  if (normalizedType === "session.idle") return "idle";
  if (normalizedType === "session.error") return "failed";
  if (normalizedType === "session.abort" || normalizedType === "session.aborted") return "aborted";
  if (normalizedType === "session.cancel" || normalizedType === "session.cancelled") return "cancelled";
  if (normalizedType === "session.stop" || normalizedType === "session.stopped") return "stopped";
  if (normalizedType === "session.completed") return "completed";
  if (isCanonicalRetry) return "retry";
  if (isCanonicalFailure) return "failed";
  if (normalized.includes("busy")) return "busy";
  if (normalized.includes("retry")) return "retry";
  if (normalized.includes("idle")) return "idle";
  if (normalized.includes("completed") || normalized.includes("complete") || normalized.includes("done")) return "completed";
  if (normalized.includes("failed") || normalized.includes("failure") || normalized.includes("error")) return "failed";
  if (normalized.includes("aborted") || normalized.includes("abort")) return "aborted";
  if (normalized.includes("cancelled") || normalized.includes("canceled") || normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("stopped") || normalized.includes("stop")) return "stopped";
  return undefined;
}

function statusNames(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (!isRecord(value) || seen.has(value)) return [];
  seen.add(value);
  const names = ["status", "state", "type", "name"].flatMap((key) => statusNames(value[key], seen));
  seen.delete(value);
  return names;
}

function stableSerialize(value: unknown, seen = new Set<unknown>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = `[${value.map((entry) => stableSerialize(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  const record = value as Record<string, unknown>;
  const result = `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`
  )).join(",")}}`;
  seen.delete(value);
  return result;
}

function unwrapIncomingEvent(value: unknown): AnyRecord | undefined {
  const outer = asRecord(value);
  if (!outer) return undefined;
  if (typeof outer.type === "string") return outer;
  const nested = asRecord(outer.event) ?? asRecord(outer.payload);
  if (nested && typeof nested.type === "string") return nested;
  return outer;
}

async function handleEvent(
  rawEvent: unknown,
  input: PluginInput,
  storage: HistoryStorage,
  totals: TotalsStorage,
  activity: ActivityRuntime,
  active: Map<string, ActiveState>,
  completedMessageIDs: Set<string>,
  parentSessionCache: Map<string, string | undefined>,
  receivedAt: number,
  ingressEpoch: number,
): Promise<void> {
  try {
    const event = unwrapIncomingEvent(rawEvent);
    if (!event) return;
    const type = typeof event.type === "string" ? event.type : "";
    const properties = asRecord(event.properties) ?? asRecord(event.data) ?? {};
    const source = sourcesByRuntime.get(active)!;
    const sessionID = readSessionIDFromEvent(type, properties, event);
    const info = eventInfo(properties, event);
    let messageProof: CompactScopeEvidence | undefined;
    let scopeChanged = false;
    if (sessionID) {
      const before = source.scopes.revision;
      const parent = readParentSessionIDFromEvent(type, properties, event);
      if (parent) {
        parentSessionCache.set(sessionID, parent);
        source.scopes.observeSessionMetadata(sessionID, { parentSessionID: parent });
      }
      for (const raw of [asRecord(properties.session), asRecord(event.session)]) {
        if (raw) source.scopes.observeSessionMetadata(sessionID, raw);
      }
      if (type === "session.created" || type === "session.updated") {
        // Observe the raw SDK entity (including fields absent from SDK typings).
        for (const raw of [properties, event, asRecord(properties.session), asRecord(event.session), info]) {
          if (raw) source.scopes.observeSessionMetadata(sessionID, raw);
        }
        source.metadataGeneration.set(sessionID, (source.metadataGeneration.get(sessionID) ?? 0) + 1);
        const sessionAgent = matchingSessionAgent(sessionID, [
          asRecord(properties.session), asRecord(event.session), properties, event,
          asRecord(properties.info), asRecord(event.info), info,
        ]);
        if (sessionAgent) await totals.setSessionAgent(sessionID, sessionAgent);
      }
      if (info?.role === "assistant") {
        messageProof = source.scopes.observeMessageMetadata(sessionID, info);
        const id = readMessageID(properties, info);
        if (id && messageProof.sourceScope === "magic-message") {
          source.messageScopes.set(id, messageProof);
          await totals.excludeMessage(id, messageProof);
          const old = (await storage.read()).find((record) => record.messageID === id);
          if (old) { const annotated = { ...old, scope: messageProof }; await storage.upsert(annotated); }
          retireResponse(active, id, sessionID);
          completedMessageIDs.add(id);
        }
      }
      scopeChanged = source.scopes.revision !== before;
      if (scopeChanged) source.metadataGeneration.set(sessionID, (source.metadataGeneration.get(sessionID) ?? 0) + 1);
      discardExcludedPersistence(source);
      source.requestMetadata(sessionID);
      if (parent) source.requestMetadata(parent);
    }
    const messageID = readMessageID(properties, info ?? {});
    const excluded = sessionID && (!eligibleSession(source, sessionID)
      || (messageID && source.messageScopes.has(messageID)));
    if (excluded) {
      if (scopeChanged) await persistScopeRegistry(source, totals);
      if (messageID && sessionID) { retireResponse(active, messageID, sessionID); completedMessageIDs.add(messageID); }
      // Known hidden activity never extends the user task or creates counters.
      return;
    }
    if (type === "message.part.delta" || type === "session.next.text.delta" || type === "session.next.reasoning.delta" || type === "session.next.tool.input.delta") {
      recordDelta(active, properties, event, receivedAt, type === "message.part.delta" ? "legacy" : "v2");
      if (scopeChanged) await persistScopeRegistry(source, totals);
      return;
    }
    if (scopeChanged) await persistScopeRegistry(source, totals);
    const lifecycle = lifecycleStateForEvent(type, properties, event);
    if (sessionID && lifecycle) source.states.set(sessionID, lifecycle);
    const part = asRecord(properties.part);
    if (part?.type === "tool" && typeof part.id === "string" && sessionID) {
      source.tools.set(part.id, { sessionID, pending: !["completed", "error"].includes(part.state?.status) });
    }
    recordResponseLifecycle(active, type, properties, event, receivedAt);
    const explicitTimestamp = explicitEventTimestamp(event, properties);
    const rawKey = explicitTimestamp === undefined && needsActivityIdentity(type, properties, event)
      ? rawEventKey(type, event)
      : undefined;
    const timestamp = explicitTimestamp ?? (rawKey === undefined
      ? receivedAt
      : runtimeEventTimestamp(activity, rawKey, event, properties, receivedAt));
    try {
      await captureActivityForEvent(activity, type, properties, event, timestamp);
    } catch (error) {
      warn("activity event handling failed", error);
    }

    if (type === "message.part.updated") {
      recordPartMetadata(active, properties, timestamp, event);
      return;
    }
    if (type === "message.updated") {
      try { await handleMessageUpdated(
        input,
        storage,
        totals,
        activity,
        active,
        completedMessageIDs,
        parentSessionCache,
        event,
        properties,
        timestamp,
        receivedAt,
      ); } finally {
        if (info?.role === "assistant" && messageID && sessionID && !isSnapshotIngress(event, properties) && isCompleted(info, properties, event)) {
          // Lifecycle ownership is independent of accepting a usage correction.
          retireResponse(active, messageID, sessionID);
          completedMessageIDs.add(messageID);
          scheduleIdleReconciliation(input, source, activity, active, sessionID, messageID, info, ingressEpoch);
        }
      }
      return;
    }
    if (type === "session.next.step.started") {
      recordResponseStep(active, properties, event, timestamp);
      return;
    }
    if (type === "session.next.step.ended") {
      recordStepFallback(active, completedMessageIDs, properties, event, timestamp);
      return;
    }
    if (isIdleEvent(type, properties, event)) {
      await flushIdleStates(
        input,
        storage,
        totals,
        activity,
        active,
        completedMessageIDs,
        parentSessionCache,
        properties,
        event,
        timestamp,
      );
      // An authoritative terminal event retires only this session's tool
      // ownership. A still-busy legitimate child remains independently active.
      for (const [id, tool] of source.tools) if (tool.sessionID === sessionID) source.tools.delete(id);
      await retryPendingPersistence(source, storage, totals, sessionID);
    }
  } catch (error) {
    warn("event parsing failed", error);
  }
}

function recordDelta(
  active: Map<string, ActiveState>,
  properties: AnyRecord,
  event: AnyRecord,
  timestamp: number,
  stream: "legacy" | "v2",
): void {
  const sessionID = readSessionIDFromEvent("message.part.delta", properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  const metadata = runtimeContentMetadata(active);
  if (isSnapshotIngress(event, properties)) return;
  if (!messageID && responseRuntime(active).closed.has(sessionID)) return;
  if (messageID && (metadata.completed.has(messageID) || (metadata.roles.has(messageID) && metadata.roles.get(messageID) !== "assistant"))) return;
  const delta = readDelta(properties, event);
  if (!acceptedContentDelta(properties, event, stream, delta)) return;
  const key = messageID ?? pendingKey(sessionID);
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  if (state.sessionID !== sessionID) return;
  bindPendingTaint(active, state);
  if (!state.observedFromStart || !messageID) taintResponse(active, state, "unobserved-response-start");
  if (!state.liveAssistant || responseRuntime(active).current.get(sessionID) !== messageID) taintResponse(active, state, "not-current-assistant");
  if (timestamp < state.startedAt) state.startedAt = timestamp;
  state.firstTokenAt = Math.min(state.firstTokenAt ?? timestamp, timestamp);
  state.timing = recordContentArrival({ ...state.timing, start: state.startedAt }, timestamp);
  state[stream].hasData = true;
  active.set(messageID ?? key, state);
}

/** Accept a content delta without hashing its text or recording a speed sample. */
function acceptedContentDelta(
  properties: AnyRecord,
  event: AnyRecord,
  stream: "legacy" | "v2",
  delta: string | undefined,
): delta is string {
  if (!delta) return false;
  const type = properties.part?.type ?? properties.kind ?? properties.type
    ?? (properties.reasoningID !== undefined || properties.field === "reasoning" || event.type === "session.next.reasoning.delta" ? "reasoning"
      : properties.callID !== undefined || event.type === "session.next.tool.input.delta" ? "tool" : "text");
  const field = properties.field;
  if (stream === "legacy") {
    if (typeof type === "string" && !["text", "reasoning", "tool", "output"].includes(type)) return false;
    if (type === "tool" && field !== "input" && field !== "state.input" && field !== "state.raw") return false;
    if (typeof field === "string" && !["text", "reasoning", "input", "state.input", "state.raw"].includes(field)) return false;
    if (properties.output !== undefined || properties.result !== undefined) return false;
  }
  return true;
}

function recordResponseStep(active: Map<string, ActiveState>, properties: AnyRecord, event: AnyRecord, timestamp: number): void {
  const sessionID = readSessionIDFromEvent(event.type, properties, event);
  const messageID = readMessageID(properties);
  if (!sessionID || (messageID && runtimeContentMetadata(active).completed.has(messageID))) return;
  if (!messageID && responseRuntime(active).closed.has(sessionID)) return;
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  bindPendingTaint(active, state);
  const id = properties.stepID ?? properties.stepId ?? properties.step?.id ?? properties.part?.id ?? properties.id;
  state.progress ??= cachedContentProgress(runtimeContentMetadata(active), messageID ?? pendingKey(sessionID));
  noteStepIdentity(state.progress, typeof id === "string" ? id : undefined);
  active.set(messageID ?? pendingKey(sessionID), state);
}

function recordStepFallback(
  active: Map<string, ActiveState>,
  completedMessageIDs: Set<string>,
  properties: AnyRecord,
  event: AnyRecord,
  timestamp: number,
): void {
  const sessionID = readSessionIDFromEvent("session.next.step.ended", properties, event);
  if (!sessionID) return;
  const messageID = readMessageID(properties);
  if (messageID && completedMessageIDs.has(messageID)) return;
  if (!messageID && responseRuntime(active).closed.has(sessionID)) return;
  const state = getOrCreateState(active, messageID, sessionID, timestamp);
  const info = eventInfo(properties, event);
  state.progress ??= cachedContentProgress(runtimeContentMetadata(active), messageID ?? pendingKey(sessionID));
  active.set(messageID ?? pendingKey(sessionID), state);
  recordResponseStep(active, properties, event, timestamp);
  const tokens = tokenFields(info?.tokens ?? properties.tokens ?? properties);
  state.fallbackTokens = mergeFallbackTokens(state.fallbackTokens, tokens);
  state.model = state.model ?? modelName(info);
  const notedAgent = normalizeAgentName(info?.agent);
  if (notedAgent) state.agent = notedAgent;
  state.cost = numberOrUndefined(info?.cost ?? properties.cost) ?? state.cost;
  active.set(messageID ?? pendingKey(sessionID), state);
}

async function handleMessageUpdated(
  input: PluginInput,
  storage: HistoryStorage,
  totals: TotalsStorage,
  activity: ActivityRuntime,
  active: Map<string, ActiveState>,
  completedMessageIDs: Set<string>,
  parentSessionCache: Map<string, string | undefined>,
  event: AnyRecord,
  properties: AnyRecord,
  timestamp: number,
  receivedAt: number,
): Promise<void> {
  const info = eventInfo(properties, event);
  if (!info) return;
  const messageID = readMessageID(properties, info);
  const sessionID = readSessionIDFromEvent("message.updated", properties, event);
  if (!messageID || !sessionID) return;
  const metadata = runtimeContentMetadata(active);
  if (typeof info.role === "string") metadata.roles.set(messageID, info.role);
  if (info.role !== "assistant") { active.delete(messageID); return; }
  if (!isCompleted(info, properties, event)) {
    // Only a newly created live assistant may receive metadata-only Thinking.
    // Old unfinished snapshots are not evidence of a new response in this runtime.
    if (metadata.completed.has(messageID) || isSnapshotIngress(event, properties)) return;
    const created = numberOrUndefined(info.time?.created ?? info.time?.start);
    if (created === undefined || created < responseRuntime(active).observedSince || created > timestamp) return;
    if (active.get(messageID)?.liveAssistant === false) return;
    for (const candidate of active.values()) {
      if (candidate.sessionID !== sessionID || candidate.messageID === messageID || !candidate.liveAssistant) continue;
      if (candidate.startedAt > created) return;
      candidate.liveAssistant = false;
      taintResponse(active, candidate, "superseded-assistant");
    }
    const state = getOrCreateState(active, messageID, sessionID, created);
    if (state.sessionID !== sessionID) return;
    state.startedAt = Math.min(state.startedAt, created);
    state.timing = { ...state.timing, start: state.startedAt };
    state.liveAssistant = true;
    const cached = cachedContentProgress(metadata, messageID);
    if (state.observedFromStart === undefined) {
      const reportedUsage = tokenFields(info.tokens);
      const alreadyGenerating = [info.time?.firstToken, info.time?.firstContent, info.time?.firstResponse].some(hasNumber)
        || (reportedUsage.output ?? 0) > 0 || (reportedUsage.reasoning ?? 0) > 0
        || ["in_progress", "in-progress", "recovering", "recovered"].includes(info.status);
      state.observedFromStart = created <= receivedAt
        && created >= responseRuntime(active).observedSince
        && !alreadyGenerating && !state.legacy.hasData && !state.v2.hasData
        && ![...(cached.parts.values())].some((part) => part.snapshotBytes > 0 || part.deltaBytes > 0);
      state.progress = mergeContentProgress(createContentProgress({ fromCurrentStart: state.observedFromStart }), state.progress ?? cached);
      metadata.progress.set(messageID, state.progress!);
    }
    bindPendingTaint(active, state);
    const notedAgent = normalizeAgentName(info.agent);
    if (notedAgent) state.agent = notedAgent;
    responseRuntime(active).current.set(sessionID, messageID);
    responseRuntime(active).closed.delete(sessionID);
    active.set(messageID, state);
    return;
  }
  if (isSnapshotIngress(event, properties)) return;
  const source = sourcesByRuntime.get(active)!;
  // A failed history write must not prevent building the full completion from
  // LIVE evidence. A retained non-LIVE candidate also survives partial/replayed
  // completion facts without regenerating its calibrated samples or clocks.
  const retained = await storage.read().catch((error) => { warn("history read failed", error); return []; });
  const previous = source.pendingPersistence.get(messageID)?.record ?? retained.find((record) => record.messageID === messageID);
  const ledger = await totals.read().catch(() => undefined);
  const snapshot = ledger?.open[messageID] ?? ledger?.settled[messageID];
  if (snapshot === true) {
    // No reversible contribution survives. Do not reconstruct a history slot
    // or manufacture speed coverage from an already-accounted old response.
    completedMessageIDs.add(messageID); metadata.completed.add(messageID);
    forgetPendingPersistence(source, messageID);
    active.delete(messageID);
    return;
  }
  const prior = previous ?? snapshot;
  const exactTokens = tokenFields(info.tokens);
  // Missing reasoning is a partial correction, never an authoritative zero.
  // This applies to both retained history and reversible settled snapshots;
  // step fallback cannot make an incomplete completion correction authoritative.
  if (prior && (prior.quality ?? "exact") === "exact" && prior.tokens.reasoning > 0 && exactTokens.reasoning === undefined) {
    completedMessageIDs.add(messageID); metadata.completed.add(messageID);
    return;
  }
  const priorUpdate = coerceCompletionUpdate((prior as MeasuredHistoryRecord | undefined)?.update);
  const fingerprint = createHash("sha256").update(stableSerialize(info)).digest("hex");
  const update: CompletionUpdate = { source: "live", instanceID: activity.instanceID, sequence: metadata.nextSequence++, receivedAt,
    ...(numberOrUndefined(event.revision ?? properties.revision) !== undefined ? { revision: numberOrUndefined(event.revision ?? properties.revision) } : {}),
    fingerprint, seenFingerprints: [...new Set([...(priorUpdate?.seenFingerprints ?? []), ...(priorUpdate ? [priorUpdate.fingerprint] : []), fingerprint])] };
  if (!isNewerCompletionUpdate(update, priorUpdate)) {
    // A history write may have succeeded while its totals write failed. Replay
    // repairs that single-writer projection rather than dropping the retry.
    const repaired = previous ? await persistCompletedRecord(source, storage, totals, previous) : snapshot !== undefined;
    if (repaired) {
      completedMessageIDs.add(messageID); metadata.completed.add(messageID);
      active.delete(messageID);
    }
    return;
  }
  const state = takeState(active, messageID, sessionID, timestamp);
  const fallback = state?.fallbackTokens ?? {};
  const tokens: TokenCounts = {
    input: exactOrFallback(exactTokens.input, fallback.input, 0),
    output: exactOrFallback(exactTokens.output, fallback.output, 0),
    reasoning: exactOrFallback(exactTokens.reasoning, fallback.reasoning, 0),
    cacheRead: cacheOrFallback(exactTokens.cacheRead, fallback.cacheRead),
    cacheWrite: cacheOrFallback(exactTokens.cacheWrite, fallback.cacheWrite),
  };
  const quality: HistoryRecordQuality = exactTokens.output !== undefined && exactTokens.input !== undefined && (exactTokens.reasoning !== undefined || tokens.reasoning === 0) ? "exact" : "provisional";
  if (prior && (prior.quality ?? "exact") === "exact" && quality === "provisional") {
    // A trimmed exact response is still authoritative in the ledger. Reject
    // partial completion facts before they can reclaim a history window slot.
    completedMessageIDs.add(messageID); metadata.completed.add(messageID);
    return;
  }
  const parentSessionID = resolveParentSessionID(
    input,
    parentSessionCache,
    sessionID,
    "message.updated",
    properties,
    event,
  );
  await safeRecordParentFact(
    activity,
    "message.updated",
    sessionID,
    parentSessionID,
    timestamp,
    properties,
    event,
  );
  const record = makeHistoryRecord({
    messageID,
    sessionID,
    parentSessionID,
    model: modelName(info) ?? state?.model,
    cost: numberOrUndefined(info.cost) ?? state?.cost ?? 0,
    tokens,
    samples: [],
    state,
    info,
    completedAt: timestamp,
    quality,
  });
  if (!record.agent && previous?.agent) record.agent = previous.agent;
  if (previous) {
    const firstToken = earliestFirstOutput(record.time.start, record.time.completed ?? timestamp, previous.time.firstContent, previous.time.firstToken, record.time.firstToken);
    if (firstToken !== undefined) {
      record.time = recordContentArrival(record.time, firstToken);
    }
    if (previous.time.firstResponse !== undefined && previous.time.firstResponseSource && previous.time.firstResponseTimeSource) {
      record.time = applyFirstResponseSignal(record.time, { timestamp: previous.time.firstResponse,
        source: previous.time.firstResponseSource, timeSource: previous.time.firstResponseTimeSource,
        estimated: previous.time.firstResponseEstimated ?? true });
    }
  }
  record.time.ttft = timeToFirstToken(record);
  delete record.speed;
  (record as MeasuredHistoryRecord).update = update;
  if (await persistCompletedRecord(source, storage, totals, record)) { completedMessageIDs.add(messageID); metadata.completed.add(messageID); }
}

async function flushIdleStates(
  input: PluginInput,
  storage: HistoryStorage,
  totals: TotalsStorage,
  activity: ActivityRuntime,
  active: Map<string, ActiveState>,
  completedMessageIDs: Set<string>,
  parentSessionCache: Map<string, string | undefined>,
  properties: AnyRecord,
  event: AnyRecord,
  timestamp: number,
): Promise<void> {
  const sessionID = readSessionIDFromEvent("session.idle", properties, event);
  if (!sessionID) return;
  responseRuntime(active).pendingTaints.delete(sessionID);
  responseRuntime(active).current.delete(sessionID);
  responseRuntime(active).closed.add(sessionID);
  const entries = [...active.entries()].filter(([, state]) => state.sessionID === sessionID);
  for (const [key, state] of entries) {
    active.delete(key);
    if (!state.legacy.hasData && !state.v2.hasData && Object.keys(state.fallbackTokens).length === 0) continue;
    if (state.messageID.startsWith("__pending__:")) continue;
    if (completedMessageIDs.has(state.messageID)) continue;
    const tokens: TokenCounts = {
      input: state.fallbackTokens.input ?? 0,
      output: state.fallbackTokens.output ?? 0,
      reasoning: state.fallbackTokens.reasoning ?? 0,
      cacheRead: state.fallbackTokens.cacheRead ?? 0,
      cacheWrite: state.fallbackTokens.cacheWrite ?? 0,
    };
    const parentSessionID = resolveParentSessionID(
      input,
      parentSessionCache,
      sessionID,
      "session.idle",
      properties,
      event,
    );
    await safeRecordParentFact(
      activity,
      "session.idle",
      sessionID,
      parentSessionID,
      timestamp,
      properties,
      event,
    );
    const record = makeHistoryRecord({
      messageID: state.messageID,
      sessionID,
      parentSessionID,
      model: state.model,
      cost: state.cost ?? 0,
      tokens,
      samples: [],
      state,
      info: undefined,
      completedAt: timestamp,
      quality: "provisional",
    });
    const wrote = await safeUpsert(storage, totals, record);
    if (!wrote) active.set(key, state);
  }
}

function makeHistoryRecord(input: {
  messageID: string;
  sessionID: string;
  parentSessionID?: string;
  model?: string;
  cost: number;
  tokens: TokenCounts;
  samples: HistoryRecord["samples"];
  state?: ActiveState;
  info?: AnyRecord;
  completedAt: number;
  quality: HistoryRecordQuality;
}): HistoryRecord {
  const infoTime = asRecord(input.info?.time) ?? {};
  const start = numberOrUndefined(infoTime.start)
    ?? numberOrUndefined(infoTime.created)
    ?? input.state?.startedAt
    ?? input.completedAt;
  const completed = numberOrUndefined(infoTime.end)
    ?? numberOrUndefined(infoTime.completed)
    ?? input.completedAt;
  const firstToken = earliestFirstOutput(start, completed, numberOrUndefined(infoTime.firstToken), numberOrUndefined(infoTime.firstTokenAt), input.state?.firstTokenAt);
  const ttft = firstToken === undefined ? undefined : Math.max(0, firstToken - start);
  const duration = Math.max(0, completed - start);
  const agent = normalizeAgentName(input.info?.agent) ?? normalizeAgentName(input.state?.agent);
  const record: HistoryRecord = {
    version: HISTORY_VERSION,
    messageID: input.messageID,
    sessionID: input.sessionID,
    ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(agent ? { agent } : {}),
    tokens: input.tokens,
    cost: Math.max(0, numberOrUndefined(input.cost) ?? 0),
    time: {
      start,
      ...(firstToken !== undefined ? { firstToken } : {}),
      completed,
      ...(ttft !== undefined ? { ttft } : {}),
      duration,
    },
    samples: input.samples,
    quality: input.quality,
  };
  if (firstToken !== undefined) record.time = recordContentArrival(record.time, firstToken);
  const timing = input.state?.timing;
  if (timing?.firstResponse !== undefined && timing.firstResponseSource && timing.firstResponseTimeSource) {
    record.time = applyFirstResponseSignal(record.time, { timestamp: timing.firstResponse,
      source: timing.firstResponseSource, timeSource: timing.firstResponseTimeSource,
      estimated: timing.firstResponseEstimated ?? true });
  }
  record.time.ttft = timeToFirstToken(record);
  return record;
}

function takeState(
  active: Map<string, ActiveState>,
  messageID: string,
  sessionID: string,
  timestamp: number,
): ActiveState | undefined {
  const direct = active.get(messageID);
  const pending = runtimeContentMetadata(active).completed.has(messageID) ? undefined : active.get(pendingKey(sessionID));
  if (direct && pending && direct !== pending) {
    mergeStates(direct, pending);
    active.delete(pendingKey(sessionID));
  }
  if (direct) {
    active.delete(messageID);
    return direct;
  }
  if (pending) {
    active.delete(pendingKey(sessionID));
    pending.messageID = messageID;
    return pending;
  }
  return undefined;
}

function getOrCreateState(
  active: Map<string, ActiveState>,
  messageID: string | undefined,
  sessionID: string,
  timestamp: number,
): ActiveState {
  const direct = messageID ? active.get(messageID) : undefined;
  const pendingKeyValue = pendingKey(sessionID);
  const pending = active.get(pendingKeyValue);
  if (direct && pending && direct !== pending) {
    mergeStates(direct, pending);
    active.delete(pendingKeyValue);
  }
  const state = direct ?? pending ?? createState(messageID ?? pendingKeyValue, sessionID, timestamp);
  if (messageID) state.messageID = messageID;
  if (messageID && pending && state === pending) active.delete(pendingKeyValue);
  return state;
}

function mergeStates(target: ActiveState, source: ActiveState): void {
  target.progress = mergeContentProgress(target.progress, source.progress);
  target.startedAt = Math.min(target.startedAt, source.startedAt);
  target.liveAssistant ||= source.liveAssistant;
  target.observedFromStart &&= source.observedFromStart;
  if (source.timing?.firstContent !== undefined) target.timing = recordContentArrival({ ...target.timing, start: target.startedAt }, source.timing.firstContent);
  if (source.timing?.firstResponse !== undefined && source.timing.firstResponseSource && source.timing.firstResponseTimeSource) {
    target.timing = applyFirstResponseSignal({ ...target.timing, start: target.startedAt }, { timestamp: source.timing.firstResponse,
      source: source.timing.firstResponseSource, timeSource: source.timing.firstResponseTimeSource,
      estimated: source.timing.firstResponseEstimated ?? true });
  }
  if (target.firstTokenAt === undefined || (source.firstTokenAt !== undefined && source.firstTokenAt < target.firstTokenAt)) {
    target.firstTokenAt = source.firstTokenAt;
  }
  target.model = target.model ?? source.model;
  if (!target.agent && source.agent) target.agent = source.agent;
  target.cost = target.cost ?? source.cost;
  target.fallbackTokens = mergeFallbackTokens(source.fallbackTokens, target.fallbackTokens);
  target.legacy.hasData ||= source.legacy.hasData;
  target.v2.hasData ||= source.v2.hasData;
}

function createState(messageID: string, sessionID: string, timestamp: number): ActiveState {
  return {
    messageID,
    sessionID,
    startedAt: timestamp,
    fallbackTokens: {},
    legacy: { hasData: false },
    v2: { hasData: false },
  };
}

function eventInfo(properties: AnyRecord, event: AnyRecord): AnyRecord | undefined {
  return asRecord(properties.info)
    ?? asRecord(properties.message)
    ?? asRecord(event.info)
    ?? (properties.role ? properties : undefined);
}

function tokenFields(value: unknown): Partial<TokenCounts> {
  if (!isRecord(value)) return {};
  const normalized = normalizeTokenCounts(value);
  const inputDetails = isRecord(value.inputTokenDetails) ? value.inputTokenDetails : undefined;
  const outputDetails = isRecord(value.outputTokenDetails) ? value.outputTokenDetails : undefined;
  const fields: Partial<TokenCounts> = {};
  if (hasNumber(value.input) || hasNumber(value.inputTokens)) fields.input = normalized.input;
  if (hasNumber(value.output) || hasNumber(value.outputTokens)) fields.output = normalized.output;
  if (
    hasNumber(value.reasoning)
    || hasNumber(value.reasoningTokens)
    || hasNumber(outputDetails?.reasoningTokens)
    || hasNumber(outputDetails?.reasoning)
  ) {
    fields.reasoning = normalized.reasoning;
  }
  if (
    hasNumber(value.cacheRead)
    || hasNumber(value.cache_read)
    || (isRecord(value.cache) && hasNumber(value.cache.read))
    || hasNumber(value.cachedInputTokens)
    || hasNumber(value.cacheReadTokens)
    || hasNumber(inputDetails?.cacheReadTokens)
    || hasNumber(inputDetails?.cacheRead)
  ) {
    fields.cacheRead = normalized.cacheRead;
  }
  if (
    hasNumber(value.cacheWrite)
    || hasNumber(value.cache_write)
    || (isRecord(value.cache) && hasNumber(value.cache.write))
    || hasNumber(value.cacheWriteTokens)
    || hasNumber(inputDetails?.cacheWriteTokens)
    || hasNumber(inputDetails?.cacheWrite)
  ) {
    fields.cacheWrite = normalized.cacheWrite;
  }
  return fields;
}

function mergeFallbackTokens(
  previous: Partial<TokenCounts>,
  incoming: Partial<TokenCounts>,
): Partial<TokenCounts> {
  const result = { ...previous, ...incoming };
  if (previous.cacheRead !== undefined && incoming.cacheRead !== undefined) {
    result.cacheRead = Math.max(previous.cacheRead, incoming.cacheRead);
  }
  if (previous.cacheWrite !== undefined && incoming.cacheWrite !== undefined) {
    result.cacheWrite = Math.max(previous.cacheWrite, incoming.cacheWrite);
  }
  return result;
}

function exactOrFallback(exact: number | undefined, fallback: number | undefined, estimate: number): number {
  return exact ?? fallback ?? Math.max(0, Math.round(estimate));
}

function cacheOrFallback(exact: number | undefined, fallback: number | undefined): number {
  return exact ?? fallback ?? 0;
}

function isCompleted(info: AnyRecord, properties: AnyRecord, event: AnyRecord): boolean {
  const values = [info.completed, properties.completed, event.completed];
  if (values.some((value) => value === true || value === "completed")) return true;
  const status = info.status ?? properties.status ?? event.status;
  if (status === "completed" || (isRecord(status) && status.type === "completed")) return true;
  const time = asRecord(info.time);
  return numberOrUndefined(time?.end) !== undefined || numberOrUndefined(time?.completed) !== undefined;
}

function isIdleEvent(type: string, properties: AnyRecord, event: AnyRecord): boolean {
  const state = lifecycleStateForEvent(type, properties, event);
  return state !== undefined && !isActiveState(state);
}

function resolveParentSessionID(
  input: PluginInput,
  cache: Map<string, string | undefined>,
  sessionID: string,
  type: string,
  properties: AnyRecord,
  event: AnyRecord,
): string | undefined {
  const direct = readParentSessionIDFromEvent(type, properties, event);
  if (direct && direct !== sessionID) {
    cache.set(sessionID, direct);
    return direct;
  }
  // Metadata I/O is owned by the deferred worker. Serial completion/receipt
  // processing can only consume already-observed authoritative ancestry.
  return cache.get(sessionID);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function safeUpsert(
  storage: HistoryStorage,
  totals: TotalsStorage,
  record: HistoryRecord,
): Promise<boolean> {
  try {
    await storage.upsert(record);
  } catch (error) {
    warn("history write failed", error);
    return false;
  }

  let retained: readonly HistoryRecord[];
  try {
    retained = await storage.read();
  } catch (error) {
    warn("totals write failed", error);
    return false;
  }

  try {
    const retainedMessageIDs = retained.map((entry) => entry.messageID);
    const stored = retained.find((entry) => entry.messageID === record.messageID);
    if (stored) {
      await totals.apply(stored, { retainedMessageIDs });
    } else {
      await totals.apply(record, { retainedMessageIDs });
    }
    return true;
  } catch (error) {
    if (!isCorruptTotalsError(error)) {
      warn("totals write failed", error);
      return false;
    }
    warn("totals ledger is corrupt", error);
    try {
      await totals.quarantine();
      await seedRetainedTotals(totals, retained);
      return true;
    } catch (recoveryError) {
      warn("totals write failed", recoveryError);
      return false;
    }
  }
}

function resolveOptions(candidate: unknown): ServerOptions {
  if (!isRecord(candidate)) return {};
  return {
    historyPath: typeof candidate.historyPath === "string" ? candidate.historyPath : undefined,
    runsPath: typeof candidate.runsPath === "string" ? candidate.runsPath : undefined,
    totalsPath: typeof candidate.totalsPath === "string" ? candidate.totalsPath : undefined,
    maxRecords: numberOrUndefined(candidate.maxRecords),
    bytesPerToken: numberOrUndefined(candidate.bytesPerToken),
  };
}

function readMessageID(...sources: AnyRecord[]): string | undefined {
  return readStringFrom(sources, [
    "messageID",
    "messageId",
    "assistantMessageID",
    "assistantMessageId",
    "id",
    "message.id",
    "part.messageID",
  ]);
}

function readDelta(properties: AnyRecord, event: AnyRecord): string | undefined {
  const values = [
    properties.delta,
    properties.text,
    properties.content,
    properties.part?.delta,
    properties.part?.text,
    event.delta,
    event.text,
  ];
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function inferKind(properties: AnyRecord, event: AnyRecord): "output" | "reasoning" {
  const values = [
    properties.kind,
    properties.type,
    properties.field,
    properties.part?.type,
    event.kind,
    event.type,
  ];
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes("reason"))
    ? "reasoning"
    : "output";
}

function modelName(info: AnyRecord | undefined): string | undefined {
  if (!info) return undefined;
  if (typeof info.model === "string") return info.model;
  if (isRecord(info.model)) {
    return readStringFrom([info.model], ["modelID", "id", "name"]);
  }
  return readStringFrom([info], ["modelID", "modelId"]);
}

function explicitEventTimestamp(event: AnyRecord, properties: AnyRecord): number | undefined {
  return numberOrUndefined(event.timestamp)
    ?? numberOrUndefined(event.time)
    ?? numberOrUndefined(properties.timestamp)
    ?? numberOrUndefined(properties.time);
}

function readString(source: AnyRecord, fallback: AnyRecord, keys: string[]): string | undefined {
  return readStringFrom([source, fallback], keys);
}

function readStringFrom(sources: Array<AnyRecord | undefined>, keys: string[]): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = getPath(source, key);
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function getPath(source: AnyRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (
    isRecord(value) ? value[key] : undefined
  ), source);
}

function pendingKey(sessionID: string): string {
  return `__pending__:${sessionID}`;
}

function joinPath(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasNumber(value: unknown): value is number {
  return numberOrUndefined(value) !== undefined;
}

function warn(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : undefined;
  if (detail) console.warn(`[oc-tps] ${message}: ${detail}`);
  else console.warn(`[oc-tps] ${message}`);
}

function asRecord(value: unknown): AnyRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

const plugin: PluginModule = { id: "oc-tps", server };

export default plugin;
