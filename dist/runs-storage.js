import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dedupeActivityEvents, normalizeActivityEvent, replayActivity, filterActivityEvents } from "./activity.js";
export const DEFAULT_RUNS_FILENAME = "runs.jsonl";
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
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return parseActivityJsonl(content, options);
}

/** Atomically rewrites a runs file; normal reads never call this function. */
export async function writeActivityFile(path, events) {
  const directory = dirname(path);
  await mkdir(directory, {
    recursive: true
  });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(temporaryPath, serializeActivityJsonl(events), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, {
      force: true
    }).catch(() => undefined);
    throw error;
  }
}
const pathQueues = new Map();

/**
 * A small append-only ledger. Queues are shared by instances in this process,
 * so two consumers targeting the same path cannot interleave their writes.
 */
export class ActivityLedger {
  path;
  constructor(pathOrOptions) {
    // A bare string is an explicit runs file. Use { historyPath } when the
    // default sibling runs.jsonl path is desired.
    this.path = typeof pathOrOptions === "string" ? pathOrOptions : resolveRunsPath(pathOrOptions);
  }
  append(event) {
    const normalized = requireActivityEvent(event);
    return enqueuePath(this.path, async () => {
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
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }
  appendMany(events) {
    const normalized = events.map(requireActivityEvent);
    return enqueuePath(this.path, async () => {
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
    return enqueuePath(this.path, () => writeActivityFile(this.path, events));
  }
  compact() {
    return enqueuePath(this.path, async () => {
      const events = await readActivityFile(this.path);
      await writeActivityFile(this.path, events);
      return events;
    });
  }
}
export function createActivityLedger(pathOrOptions) {
  return new ActivityLedger(pathOrOptions);
}
export const createRunsStorage = createActivityLedger;
async function appendEventsToFile(path, events) {
  if (events.length === 0) return;
  await mkdir(dirname(path), {
    recursive: true
  });
  // A delimiter before every append avoids an O(file-size) read just to
  // inspect the previous final byte. Empty lines are ignored by the parser.
  const content = `\n${events.map(event => JSON.stringify(event)).join("\n")}\n`;
  await appendFile(path, content, "utf8");
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
  pathQueues.set(key, result.then(() => undefined, () => undefined));
  return result;
}
function isNodeError(value) {
  return value instanceof Error || typeof value === "object" && value !== null;
}
