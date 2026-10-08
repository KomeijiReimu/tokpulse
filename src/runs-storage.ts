import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
}

export interface ActivityReadOptions {
  dedupe?: boolean;
  /** Optional display projection. Default reads and compaction preserve raw facts. */
  sessionScopes?: SessionScopes;
  parentBySessionID?: ScopeParents;
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
    content = await readFile(path, "utf8");
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
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serializeActivityJsonl(events), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const pathQueues = new Map<string, Promise<void>>();

/**
 * A small append-only ledger. Queues are shared by instances in this process,
 * so two consumers targeting the same path cannot interleave their writes.
 */
export class ActivityLedger implements ActivityLedgerAPI {
  readonly path: string;

  constructor(pathOrOptions: string | RunsPathOptions) {
    // A bare string is an explicit runs file. Use { historyPath } when the
    // default sibling runs.jsonl path is desired.
    this.path = typeof pathOrOptions === "string"
      ? pathOrOptions
      : resolveRunsPath(pathOrOptions);
  }

  append(event: ActivityEventInput): Promise<ActivityEvent> {
    const normalized = requireActivityEvent(event);
    return enqueuePath(this.path, async () => {
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }

  appendLifecycle(event: LifecycleEventAppendInput): Promise<LifecycleActivityEvent> {
    const normalized = requireActivityEvent({ ...event, kind: "lifecycle" });
    if (normalized.kind !== "lifecycle") throw new TypeError("Invalid lifecycle activity event");
    return enqueuePath(this.path, async () => {
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }

  appendParent(event: ParentEventAppendInput): Promise<ParentActivityEvent> {
    const normalized = requireActivityEvent({ ...event, kind: "parent" });
    if (normalized.kind !== "parent") throw new TypeError("Invalid parent activity event");
    return enqueuePath(this.path, async () => {
      await appendEventsToFile(this.path, [normalized]);
      return normalized;
    });
  }

  appendMany(events: readonly ActivityEventInput[]): Promise<ActivityEvent[]> {
    const normalized = events.map(requireActivityEvent);
    return enqueuePath(this.path, async () => {
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
    return enqueuePath(this.path, () => writeActivityFile(this.path, events));
  }

  compact(): Promise<ActivityEvent[]> {
    return enqueuePath(this.path, async () => {
      const events = await readActivityFile(this.path);
      await writeActivityFile(this.path, events);
      return events;
    });
  }
}

export function createActivityLedger(pathOrOptions: string | RunsPathOptions): ActivityLedger {
  return new ActivityLedger(pathOrOptions);
}

export const createRunsStorage = createActivityLedger;

async function appendEventsToFile(path: string, events: readonly ActivityEvent[]): Promise<void> {
  if (events.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  // A delimiter before every append avoids an O(file-size) read just to
  // inspect the previous final byte. Empty lines are ignored by the parser.
  const content = `\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await appendFile(path, content, "utf8");
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
  pathQueues.set(key, result.then(() => undefined, () => undefined));
  return result;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error || (typeof value === "object" && value !== null);
}
