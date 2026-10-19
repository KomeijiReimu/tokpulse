import { appendLedgerText, inspectLedgerFile, openLedgerFile, readLedgerText, replaceLedgerText } from "./persistence-files.js";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { dedupeActivityEvents, normalizeActivityEvent, replayActivity, filterActivityEvents } from "./activity.js";
export const DEFAULT_RUNS_FILENAME = "runs.jsonl";
const activityReadCursorBrand = Symbol("ActivityReadCursor");
/** Opaque immutable checkpoint. Save only after applying a current-generation result. */

const ACTIVITY_GUARD_BYTES = 4096;
class ActivityCursor {
  [activityReadCursorBrand] = true;
  #checkpoint;
  constructor(checkpoint) {
    this.#checkpoint = checkpoint;
    Object.freeze(this);
  }
  static checkpoint(cursor) {
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
 * Concurrent append is allowed: validate the captured prefix with bounded
 * guards, keep that EOF in the cursor, and leave later bytes for the next read.
 * Cross-batch stable-ID deduplication belongs to the consumer (notably legacy
 * valid EOF can be emitted again when its terminating newline later arrives).
 */
export async function readActivityDelta(path, cursor) {
  let file;
  try {
    file = await openLedgerFile(path, constants.O_RDONLY);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {
      mode: "reset",
      events: [],
      cursor: undefined
    };
    throw error;
  }
  try {
    const stat = await file.stat({
      bigint: true
    });
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Activity ledger size exceeds safe offsets");
    const key = resolve(path);
    const previous = ActivityCursor.checkpoint(cursor);
    let append = previous !== undefined && previous.path === key && previous.stat.dev === stat.dev && previous.stat.ino === stat.ino && size > previous.size;
    if (previous && previous.path === key && sameActivitySnapshot(previous.stat, stat)) {
      await assertActivitySnapshot(file, path, stat, previous);
      return {
        mode: "unchanged",
        events: [],
        cursor
      };
    }
    if (append && previous) {
      const head = await readActivityRange(file, 0, previous.head.length);
      const tail = await readActivityRange(file, previous.size - previous.tail.length, previous.tail.length);
      append = head.equals(previous.head) && tail.equals(previous.tail);
    }
    const start = append && previous ? previous.lineStart : 0;
    const data = await readActivityRange(file, start, size - start);
    const lineStart = start + data.lastIndexOf(10) + 1;
    let head, tail;
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
    await assertActivitySnapshot(file, path, stat, {
      head,
      tail
    });
    const events = parseActivityJsonl(`${start === 0 ? "" : "\n"}${data.toString("utf8")}`);
    return {
      mode: append ? "append" : "reset",
      events,
      cursor: new ActivityCursor({
        path: key,
        stat,
        size,
        lineStart,
        head,
        tail
      })
    };
  } finally {
    await file.close();
  }
}
function sameActivitySnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function assertActivitySnapshot(file, path, snapshot, guards) {
  const after = await file.stat({
    bigint: true
  });
  const changed = () => new Error(`Activity ledger changed during read: ${path}`);
  if (after.dev !== snapshot.dev || after.ino !== snapshot.ino || after.size < snapshot.size || !after.isFile() || after.nlink !== 1n) throw changed();
  if (!sameActivitySnapshot(snapshot, after)) {
    // A lease writer may keep appending throughout this read. Validate the
    // captured prefix, not a moving EOF: the returned cursor still ends at
    // snapshot.size. Metadata can become visible just before append's size;
    // check guards and then observe size again, without waiting for quiescence.
    // Only a detected race pays these bounded guard reads.
    const head = await readActivityRange(file, 0, guards.head.length);
    const tail = await readActivityRange(file, Number(snapshot.size) - guards.tail.length, guards.tail.length);
    if (!head.equals(guards.head) || !tail.equals(guards.tail)) throw changed();
    const final = await file.stat({
      bigint: true
    });
    if (final.size < after.size || final.dev !== after.dev || final.ino !== after.ino || !final.isFile() || final.nlink !== 1n || final.size === snapshot.size && !sameActivitySnapshot(snapshot, final)) throw changed();
  }
  const named = await inspectLedgerFile(path);
  if (!named || BigInt(named.dev) !== after.dev || BigInt(named.ino) !== after.ino || BigInt(named.size) < snapshot.size) throw changed();
}
async function readActivityRange(file, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const {
      bytesRead
    } = await file.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Activity ledger truncated during read");
    offset += bytesRead;
  }
  return buffer;
}
/** Derives the independent activity ledger beside a history.jsonl file. */
export function deriveRunsPath(historyPath) {
  if (typeof historyPath !== "string" || historyPath.length === 0) {
    throw new TypeError("historyPath must be a non-empty string");
  }
  return join(dirname(historyPath), DEFAULT_RUNS_FILENAME);
}
export const runsPathForHistoryPath = deriveRunsPath;

/** Resolves configured paths without consulting or modifying the history file. */

export function resolveRunsPath(input, configuredRunsPath) {
  if (typeof input === "string") {
    if (!configuredRunsPath) return deriveRunsPath(input);
    return isAbsolute(configuredRunsPath) ? configuredRunsPath : join(dirname(input), configuredRunsPath);
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
export function parseActivityJsonl(content, options = {}) {
  const parsed = [];
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
  const eligible = new Set(filterActivityEvents(events, options.sessionScopes, options.parentBySessionID).map(event => event.sessionID));
  return events.filter(event => eligible.has(event.sessionID) && event.scope?.sourceScope !== "magic-message");
}
export function serializeActivityJsonl(events) {
  const normalized = dedupeActivityEvents(events);
  if (normalized.length === 0) return "";
  return `${normalized.map(event => JSON.stringify(event)).join("\n")}\n`;
}
export async function readActivityFile(path, options = {}) {
  let content;
  try {
    content = await readLedgerText(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseActivityJsonl(content, options);
}

/** Atomically rewrites a runs file; normal reads never call this function. */
export async function writeActivityFile(path, events) {
  await replaceLedgerText(path, serializeActivityJsonl(events));
}
const pathQueues = new Map();

/**
 * A small append-only ledger. Queues are shared by instances in this process,
 * so two consumers targeting the same path cannot interleave their writes.
 */
export class ActivityLedger {
  path;
  lease;
  constructor(pathOrOptions, options = {}) {
    // A bare string is an explicit runs file. Use { historyPath } when the
    // default sibling runs.jsonl path is desired.
    this.path = typeof pathOrOptions === "string" ? pathOrOptions : resolveRunsPath(pathOrOptions);
    this.lease = typeof pathOrOptions === "string" ? options.lease : pathOrOptions.lease;
  }
  append(event) {
    const normalized = requireActivityEvent(event);
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }
  appendLifecycle(event) {
    const normalized = requireActivityEvent({
      ...event,
      kind: "lifecycle"
    });
    if (normalized.kind !== "lifecycle") throw new TypeError("Invalid lifecycle activity event");
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }
  appendParent(event) {
    const normalized = requireActivityEvent({
      ...event,
      kind: "parent"
    });
    if (normalized.kind !== "parent") throw new TypeError("Invalid parent activity event");
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }
  appendMany(events) {
    const normalized = events.map(requireActivityEvent);
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      await appendEventsToFile(this.path, normalized);
      return normalized;
    });
  }
  read(options = {}) {
    return enqueuePath(this.path, () => readActivityFile(this.path, options));
  }
  async replay(options = {}) {
    return replayActivity(await this.read(), options);
  }
  rewrite(events) {
    return enqueuePath(this.path, () => {
      this.lease?.assertOwned(this.path);
      return writeActivityFile(this.path, events);
    });
  }
  compact() {
    return enqueuePath(this.path, async () => {
      this.lease?.assertOwned(this.path);
      const events = await readActivityFile(this.path);
      await writeActivityFile(this.path, events);
      return events;
    });
  }
}
export function createActivityLedger(pathOrOptions, options = {}) {
  return new ActivityLedger(pathOrOptions, options);
}
export const createRunsStorage = createActivityLedger;
async function appendEventsToFile(path, events) {
  if (events.length === 0) return;
  // A delimiter before every append avoids an O(file-size) read just to
  // inspect the previous final byte. Empty lines are ignored by the parser.
  const content = `\n${events.map(event => JSON.stringify(event)).join("\n")}\n`;
  await appendLedgerText(path, content);
}
function requireActivityEvent(value) {
  const event = normalizeActivityEvent(value);
  if (!event) throw new TypeError("Invalid activity event");
  return event;
}
function enqueuePath(path, operation) {
  const key = resolve(path);
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  pathQueues.set(key, tail);
  void tail.then(() => {
    if (pathQueues.get(key) === tail) pathQueues.delete(key);
  });
  return result;
}
function isNodeError(value) {
  return value instanceof Error || typeof value === "object" && value !== null;
}
