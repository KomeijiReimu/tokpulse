import { appendLedgerText, inspectLedgerFile, openLedgerFile, readLedgerText, replaceLedgerText } from "./persistence-files.js";
import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { WriterLease } from "./persistence.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ActivityEvent,
  ActivityEventInput,
  ActivityReplay,
  ActivityReplayInput,
  LifecycleActivityEvent,
  LifecycleActivityEventInput,
  ParentActivityEvent,
  ParentActivityEventInput,
  dedupeActivityEvents,
  normalizeActivityEvent,
  replayActivity,
  filterActivityEvents,
} from "./activity.js";
import type { ScopeParents, SessionScopes } from "./scope.js";

export const DEFAULT_RUNS_FILENAME = "runs.jsonl";

export interface RunsPathOptions {
  historyPath?: string;
  runsPath?: string;
  /** Alias for an explicit runsPath. */
  path?: string;
  lease?: WriterLease;
}

export interface ActivityReadOptions {
  dedupe?: boolean;
  /** Optional display projection. Default reads and compaction preserve raw facts. */
  sessionScopes?: SessionScopes;
  parentBySessionID?: ScopeParents;
}

const activityReadCursorBrand: unique symbol = Symbol("ActivityReadCursor");
/** Opaque immutable checkpoint. Save only after applying a current-generation result. */
export interface ActivityReadCursor { readonly [activityReadCursorBrand]: true; }
export interface ActivityReadDelta {
  mode: "reset" | "append" | "unchanged";
  events: readonly ActivityEvent[];
  cursor: ActivityReadCursor | undefined;
}

const ACTIVITY_GUARD_BYTES = 4096;
interface ActivityCheckpoint {
  readonly path: string;
  readonly stat: BigIntStats;
  readonly size: number;
  /** Re-read an unfinished last line, even if a legacy valid EOF was emitted. */
  readonly lineStart: number;
  readonly head: Buffer;
  readonly tail: Buffer;
}
class ActivityCursor implements ActivityReadCursor {
  readonly [activityReadCursorBrand] = true;
  readonly #checkpoint: ActivityCheckpoint;
  constructor(checkpoint: ActivityCheckpoint) { this.#checkpoint = checkpoint; Object.freeze(this); }
  static checkpoint(cursor: ActivityReadCursor | undefined): ActivityCheckpoint | undefined {
    return cursor instanceof ActivityCursor ? cursor.#checkpoint : undefined;
  }
}

/**
 * Pure safe-FD snapshot reader for the lease writer's append/atomic-replace
 * protocol. There is no singleton cursor and no retained historical event set.
 * Growth validates the old first/last 4KiB before trusting an append; equal-size
 * timestamp changes, truncation, replacement and changed guards reset. Bounded
 * checks cannot detect arbitrary middle-only overwrite combined with growth;
 * this is not an integrity monitor for writers violating that protocol.
 * Cross-batch stable-ID deduplication belongs to the consumer (notably legacy
 * valid EOF can be emitted again when its terminating newline later arrives).
 */
export async function readActivityDelta(path: string, cursor?: ActivityReadCursor): Promise<ActivityReadDelta> {
  let file: FileHandle;
  try { file = await openLedgerFile(path, constants.O_RDONLY); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { mode: "reset", events: [], cursor: undefined };
    throw error;
  }
  try {
    const stat = await file.stat({ bigint: true });
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Activity ledger size exceeds safe offsets");
    const key = resolve(path);
    const previous = ActivityCursor.checkpoint(cursor);
    let append = previous !== undefined && previous.path === key
      && previous.stat.dev === stat.dev && previous.stat.ino === stat.ino && size > previous.size;
    if (previous && previous.path === key && sameActivitySnapshot(previous.stat, stat)) {
      await assertActivitySnapshot(file, path, stat);
      return { mode: "unchanged", events: [], cursor };
    }
    if (append && previous) {
      const head = await readActivityRange(file, 0, previous.head.length);
      const tail = await readActivityRange(file, previous.size - previous.tail.length, previous.tail.length);
      append = head.equals(previous.head) && tail.equals(previous.tail);
    }
    const start = append && previous ? previous.lineStart : 0;
    const data = await readActivityRange(file, start, size - start);
    await assertActivitySnapshot(file, path, stat);
    const lineStart = start + data.lastIndexOf(10) + 1;
    let head: Buffer, tail: Buffer;
    if (append && previous) {
      const added = data.subarray(previous.size - start);
      head = Buffer.concat([previous.head, added.subarray(0, ACTIVITY_GUARD_BYTES - previous.head.length)]);
      const tailWindow = Buffer.concat([previous.tail, added.subarray(-ACTIVITY_GUARD_BYTES)]);
      tail = Buffer.from(tailWindow.subarray(-ACTIVITY_GUARD_BYTES));
    } else {
      // Copy bounded guards, rather than keeping a slice that retains the
      // entire cold-read buffer through the cursor's lifetime.
      head = Buffer.from(data.subarray(0, ACTIVITY_GUARD_BYTES));
      tail = Buffer.from(data.subarray(-ACTIVITY_GUARD_BYTES));
    }
    const events = parseActivityJsonl(`${start === 0 ? "" : "\n"}${data.toString("utf8")}`);
    return { mode: append ? "append" : "reset", events,
      cursor: new ActivityCursor({ path: key, stat, size, lineStart, head, tail }) };
  } finally { await file.close(); }
}

function sameActivitySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function assertActivitySnapshot(file: FileHandle, path: string, snapshot: BigIntStats): Promise<void> {
  const after = await file.stat({ bigint: true });
  const named = await inspectLedgerFile(path);
  if (!sameActivitySnapshot(snapshot, after) || !named || BigInt(named.dev) !== after.dev || BigInt(named.ino) !== after.ino) {
    throw new Error(`Activity ledger changed during read: ${path}`);
  }
}
async function readActivityRange(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Activity ledger truncated during read");
    offset += bytesRead;
  }
  return buffer;
}

export interface ActivityLedgerAPI {
  readonly path: string;
  append(event: ActivityEventInput): Promise<ActivityEvent>;
  appendLifecycle(event: LifecycleEventAppendInput): Promise<LifecycleActivityEvent>;
  appendParent(event: ParentEventAppendInput): Promise<ParentActivityEvent>;
  appendMany(events: readonly ActivityEventInput[]): Promise<ActivityEvent[]>;
  read(options?: ActivityReadOptions): Promise<ActivityEvent[]>;
  replay(options?: ActivityReplayInput): Promise<ActivityReplay>;
  rewrite(events: readonly ActivityEventInput[]): Promise<void>;
  compact(): Promise<ActivityEvent[]>;
}

export type LifecycleEventAppendInput = Omit<LifecycleActivityEventInput, "kind"> & {
  kind?: "lifecycle";
};

export type ParentEventAppendInput = Omit<ParentActivityEventInput, "kind"> & {
  kind?: "parent";
};

/** Derives the independent activity ledger beside a history.jsonl file. */
export function deriveRunsPath(historyPath: string): string {
  if (typeof historyPath !== "string" || historyPath.length === 0) {
    throw new TypeError("historyPath must be a non-empty string");
  }
  return join(dirname(historyPath), DEFAULT_RUNS_FILENAME);
}

export const runsPathForHistoryPath = deriveRunsPath;

/** Resolves configured paths without consulting or modifying the history file. */
export function resolveRunsPath(historyPath: string, runsPath?: string): string;
export function resolveRunsPath(input: RunsPathOptions): string;
export function resolveRunsPath(
  input: string | RunsPathOptions,
  configuredRunsPath?: string,
): string {
  if (typeof input === "string") {
    if (!configuredRunsPath) return deriveRunsPath(input);
    return isAbsolute(configuredRunsPath)
      ? configuredRunsPath
      : join(dirname(input), configuredRunsPath);
  }
  const historyPath = input.historyPath;
  const explicitPath = input.runsPath ?? input.path;
  if (explicitPath) {
    if (isAbsolute(explicitPath) || !historyPath) return explicitPath;
    return join(dirname(historyPath), explicitPath);
  }
  if (historyPath) return deriveRunsPath(historyPath);
  throw new TypeError("Provide historyPath or an explicit runsPath");
}

export const getRunsPath = resolveRunsPath;

/**
 * JSONL parser used by both the ledger and read-only callers. Invalid or
 * truncated lines are ignored while valid neighboring events remain usable.
 */
export function parseActivityJsonl(
  content: string,
  options: ActivityReadOptions = {},
): ActivityEvent[] {
  const parsed: ActivityEvent[] = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (!line.trim()) continue;
    try {
      const event = normalizeActivityEvent(JSON.parse(line));
      if (event) parsed.push(event);
    } catch {
      // A partial final line or a corrupt line must not hide valid facts.
    }
  }
  const events = options.dedupe === false ? parsed : dedupeActivityEvents(parsed);
  if (!options.sessionScopes && !options.parentBySessionID) return events;
  const eligible = new Set(filterActivityEvents(events, options.sessionScopes, options.parentBySessionID).map((event) => event.sessionID));
  return events.filter((event) => eligible.has(event.sessionID) && event.scope?.sourceScope !== "magic-message");
}

export function serializeActivityJsonl(events: readonly ActivityEventInput[]): string {
  const normalized = dedupeActivityEvents(events);
  if (normalized.length === 0) return "";
  return `${normalized.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export async function readActivityFile(
  path: string,
  options: ActivityReadOptions = {},
): Promise<ActivityEvent[]> {
  let content: string;
  try {
    content = await readLedgerText(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseActivityJsonl(content, options);
}

/** Atomically rewrites a runs file; normal reads never call this function. */
export async function writeActivityFile(
  path: string,
  events: readonly ActivityEventInput[],
): Promise<void> {
  await replaceLedgerText(path, serializeActivityJsonl(events));
}

const pathQueues = new Map<string, Promise<void>>();

/**
 * A small append-only ledger. Queues are shared by instances in this process,
 * so two consumers targeting the same path cannot interleave their writes.
 */
export class ActivityLedger implements ActivityLedgerAPI {
  readonly path: string;
  private readonly lease?: WriterLease;

  constructor(pathOrOptions: string | RunsPathOptions, options: { lease?: WriterLease } = {}) {
    // A bare string is an explicit runs file. Use { historyPath } when the
    // default sibling runs.jsonl path is desired.
    this.path = typeof pathOrOptions === "string"
      ? pathOrOptions
      : resolveRunsPath(pathOrOptions);
    this.lease = typeof pathOrOptions === "string" ? options.lease : pathOrOptions.lease;
  }

  append(event: ActivityEventInput): Promise<ActivityEvent> {
    const normalized = requireActivityEvent(event);
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }

  appendLifecycle(event: LifecycleEventAppendInput): Promise<LifecycleActivityEvent> {
    const normalized = requireActivityEvent({ ...event, kind: "lifecycle" });
    if (normalized.kind !== "lifecycle") throw new TypeError("Invalid lifecycle activity event");
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }

  appendParent(event: ParentEventAppendInput): Promise<ParentActivityEvent> {
    const normalized = requireActivityEvent({ ...event, kind: "parent" });
    if (normalized.kind !== "parent") throw new TypeError("Invalid parent activity event");
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }

  appendMany(events: readonly ActivityEventInput[]): Promise<ActivityEvent[]> {
    const normalized = events.map(requireActivityEvent);
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, normalized);
      return normalized;
    });
  }

  read(options: ActivityReadOptions = {}): Promise<ActivityEvent[]> {
    return enqueuePath(this.path, () => readActivityFile(this.path, options));
  }

  async replay(options: ActivityReplayInput = {}): Promise<ActivityReplay> {
    return replayActivity(await this.read(), options);
  }

  rewrite(events: readonly ActivityEventInput[]): Promise<void> {
    return enqueuePath(this.path, () => { this.lease?.assertOwned(this.path); return writeActivityFile(this.path, events); });
  }

  compact(): Promise<ActivityEvent[]> {
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      const events = await readActivityFile(this.path);
      await writeActivityFile(this.path, events);
      return events;
    });
  }
}

export function createActivityLedger(pathOrOptions: string | RunsPathOptions, options: { lease?: WriterLease } = {}): ActivityLedger {
  return new ActivityLedger(pathOrOptions, options);
}

export const createRunsStorage = createActivityLedger;

async function appendEventsToFile(path: string, events: readonly ActivityEvent[]): Promise<void> {
  if (events.length === 0) return;
  // A delimiter before every append avoids an O(file-size) read just to
  // inspect the previous final byte. Empty lines are ignored by the parser.
  const content = `\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await appendLedgerText(path, content);
}

function requireActivityEvent(value: unknown): ActivityEvent {
  const event = normalizeActivityEvent(value);
  if (!event) throw new TypeError("Invalid activity event");
  return event;
}

function enqueuePath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  pathQueues.set(key, tail);
  void tail.then(() => { if (pathQueues.get(key) === tail) pathQueues.delete(key); });
  return result;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error || (typeof value === "object" && value !== null);
}
