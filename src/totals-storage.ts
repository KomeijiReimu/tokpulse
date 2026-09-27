import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type HistoryRecord,
  type HistoryRecordQuality,
  type TokenCounts,
  addTokenCounts,
  emptyTokenCounts,
  normalizeTokenCounts,
} from "./core.js";

export const TOTALS_VERSION = 1 as const;
export const DEFAULT_TOTALS_FILENAME = "totals.json";

const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

/**
 * Cumulative direct usage per session. History keeps only a detail window;
 * once an exact contribution leaves that window it is dropped from `open`
 * and must not be subtracted from the session totals.
 */
export interface SessionDirectTotals {
  tokens: TokenCounts;
  cost: number;
  responseCount: number;
}

export interface OpenContribution {
  sessionID: string;
  quality: HistoryRecordQuality;
  tokens: TokenCounts;
  cost: number;
}

export interface TotalsLedger {
  version: typeof TOTALS_VERSION;
  sessions: Record<string, SessionDirectTotals>;
  open: Record<string, OpenContribution>;
  /**
   * Exact contributions dropped from `open` after leaving the history window.
   * The snapshot is already included in `sessions`, so a later correction is a
   * delta. Legacy `true` has no snapshot and must not be added again.
   */
  settled: Record<string, OpenContribution | true>;
}

export interface TotalsPathOptions {
  historyPath?: string;
  totalsPath?: string;
}

export interface TotalsApplyOptions {
  retainedMessageIDs?: ReadonlySet<string> | readonly string[];
}

export interface TotalsStorage {
  readonly path: string;
  apply(record: HistoryRecord, options?: TotalsApplyOptions): Promise<TotalsLedger>;
  applyMany(records: readonly HistoryRecord[], options?: TotalsApplyOptions): Promise<TotalsLedger>;
  seed(records: readonly HistoryRecord[]): Promise<TotalsLedger>;
  read(): Promise<TotalsLedger>;
  quarantine(): Promise<void>;
}

const pathQueues = new Map<string, Promise<void>>();

/** Explicit totalsPath wins. Otherwise the ledger sits beside history as totals.json. */
export function resolveTotalsPath(input: TotalsPathOptions): string {
  const historyPath = input.historyPath;
  const explicitPath = input.totalsPath;
  if (typeof explicitPath === "string" && explicitPath.length > 0) {
    if (isAbsolute(explicitPath) || typeof historyPath !== "string" || historyPath.length === 0) {
      return explicitPath;
    }
    return join(dirname(historyPath), explicitPath);
  }
  if (typeof historyPath === "string" && historyPath.length > 0) {
    return join(dirname(historyPath), DEFAULT_TOTALS_FILENAME);
  }
  throw new TypeError("Provide historyPath or an explicit totalsPath");
}

export function createTotalsStorage(pathOrOptions: string | TotalsPathOptions): TotalsStorage {
  const path = typeof pathOrOptions === "string"
    ? requireExplicitPath(pathOrOptions)
    : resolveTotalsPath(pathOrOptions);

  return {
    path,
    apply: (record, options = {}) => enqueuePath(path, async () => {
      const ledger = await loadLedger(path);
      applyRecord(ledger, record, options);
      return persistLedger(path, ledger);
    }),
    applyMany: (records, options = {}) => enqueuePath(path, async () => {
      if (!Array.isArray(records)) throw new TypeError("Totals apply records must be an array");
      const ledger = await loadLedger(path);
      for (const record of records) applyOpenRecord(ledger, record);
      freezeRetained(ledger, options.retainedMessageIDs);
      return persistLedger(path, ledger);
    }),
    seed: (records) => enqueuePath(path, () => seedLedger(path, records)),
    read: () => enqueuePath(path, () => loadLedger(path)),
    quarantine: () => enqueuePath(path, () => quarantineFile(path)),
  };
}

/** Syntax errors and rejected ledgers only. Ordinary disk failures are not corrupt. */
export function isCorruptTotalsError(error: unknown): boolean {
  return error instanceof SyntaxError
    || (error instanceof TypeError && error.message === "Invalid totals ledger");
}

function requireExplicitPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("totals path must be a non-empty string");
  }
  return path;
}

async function seedLedger(path: string, records: readonly HistoryRecord[]): Promise<TotalsLedger> {
  if (!Array.isArray(records)) throw new TypeError("Totals seed records must be an array");
  const existing = await readExistingLedger(path);
  if (existing) return cloneLedger(existing);

  const ledger = emptyLedger();
  for (const record of records) applyRecord(ledger, record);
  return persistLedger(path, ledger);
}

async function loadLedger(path: string): Promise<TotalsLedger> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyLedger();
    throw error;
  }
  return cloneLedger(parseTotalsJson(content));
}

async function readExistingLedger(path: string): Promise<TotalsLedger | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return parseTotalsJson(content);
}

async function persistLedger(path: string, ledger: TotalsLedger): Promise<TotalsLedger> {
  await writeTotalsFile(path, ledger);
  return cloneLedger(ledger);
}

async function quarantineFile(path: string): Promise<void> {
  const destination = join(dirname(path), `${basename(path)}.corrupt-${Date.now()}`);
  try {
    await rename(path, destination);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function writeTotalsFile(path: string, ledger: TotalsLedger): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cloneLedger(ledger))}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseTotalsJson(content: string): TotalsLedger {
  return coerceLedger(JSON.parse(content));
}

function applyRecord(
  ledger: TotalsLedger,
  record: HistoryRecord,
  options: TotalsApplyOptions = {},
): void {
  applyOpenRecord(ledger, record);
  freezeRetained(ledger, options.retainedMessageIDs);
}

function applyOpenRecord(ledger: TotalsLedger, record: HistoryRecord): void {
  const messageID = requireMessageID(record);
  const contribution = contributionFromRecord(record);
  const previous = ledger.open[messageID];

  if (!previous) {
    const frozen = ledger.settled[messageID];
    if (frozen === true) return;
    if (frozen) {
      if (sameContribution(frozen, contribution)) return;
      replaceContribution(ledger, frozen, contribution);
      delete ledger.settled[messageID];
      ledger.open[messageID] = contribution;
      return;
    }
    addContribution(ensureSession(ledger, contribution.sessionID), contribution);
    ledger.open[messageID] = contribution;
    return;
  }

  if (!sameContribution(previous, contribution)) {
    replaceContribution(ledger, previous, contribution);
    ledger.open[messageID] = contribution;
  }
}

function replaceContribution(
  ledger: TotalsLedger,
  previous: OpenContribution,
  contribution: OpenContribution,
): void {
  if (previous.sessionID !== contribution.sessionID) {
    const previousSession = ledger.sessions[previous.sessionID];
    if (previousSession) subtractContribution(previousSession, previous);
    addContribution(ensureSession(ledger, contribution.sessionID), contribution);
    return;
  }
  applyDelta(ensureSession(ledger, contribution.sessionID), previous, contribution);
}

function freezeRetained(
  ledger: TotalsLedger,
  retainedMessageIDs: TotalsApplyOptions["retainedMessageIDs"],
): void {
  const retained = retainedSet(retainedMessageIDs);
  if (retained) freezeExact(ledger, retained);
}

function contributionFromRecord(record: HistoryRecord): OpenContribution {
  if (!isPlainObject(record) || typeof record.sessionID !== "string" || record.sessionID.length === 0) {
    throw new TypeError("Invalid totals record");
  }
  const quality: HistoryRecordQuality = record.quality === "provisional" ? "provisional" : "exact";
  return {
    sessionID: record.sessionID,
    quality,
    tokens: normalizeTokenCounts(record.tokens),
    cost: nonNegativeCost(record.cost),
  };
}

function requireMessageID(record: HistoryRecord): string {
  if (!isPlainObject(record) || typeof record.messageID !== "string" || record.messageID.length === 0) {
    throw new TypeError("Invalid totals record");
  }
  return record.messageID;
}

function addContribution(session: SessionDirectTotals, contribution: OpenContribution): void {
  session.tokens = clampTokenCounts(addTokenCounts(session.tokens, contribution.tokens));
  session.cost = clampNonNegative(session.cost + contribution.cost);
  session.responseCount = clampNonNegative(session.responseCount + 1);
}

function subtractContribution(session: SessionDirectTotals, contribution: OpenContribution): void {
  session.tokens = subtractTokens(session.tokens, contribution.tokens);
  session.cost = clampNonNegative(session.cost - contribution.cost);
  session.responseCount = clampNonNegative(session.responseCount - 1);
}

function applyDelta(
  session: SessionDirectTotals,
  previous: OpenContribution,
  next: OpenContribution,
): void {
  const tokens = emptyTokenCounts();
  for (const field of TOKEN_FIELDS) {
    tokens[field] = clampNonNegative(session.tokens[field] + next.tokens[field] - previous.tokens[field]);
  }
  session.tokens = tokens;
  session.cost = clampNonNegative(session.cost + next.cost - previous.cost);
}

function freezeExact(ledger: TotalsLedger, retained: ReadonlySet<string>): void {
  for (const messageID of Object.keys(ledger.open)) {
    const contribution = ledger.open[messageID];
    if (contribution?.quality === "exact" && !retained.has(messageID)) {
      ledger.settled[messageID] = cloneContribution(contribution);
      delete ledger.open[messageID];
    }
  }
}

function retainedSet(
  value: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  throw new TypeError("retainedMessageIDs must be a Set or an array");
}

function ensureSession(ledger: TotalsLedger, sessionID: string): SessionDirectTotals {
  const existing = ledger.sessions[sessionID];
  if (existing) return existing;
  const created = emptySession();
  ledger.sessions[sessionID] = created;
  return created;
}

function sameContribution(left: OpenContribution, right: OpenContribution): boolean {
  return left.sessionID === right.sessionID
    && left.quality === right.quality
    && left.cost === right.cost
    && TOKEN_FIELDS.every((field) => left.tokens[field] === right.tokens[field]);
}

function subtractTokens(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    input: clampNonNegative(left.input - right.input),
    output: clampNonNegative(left.output - right.output),
    reasoning: clampNonNegative(left.reasoning - right.reasoning),
    cacheRead: clampNonNegative(left.cacheRead - right.cacheRead),
    cacheWrite: clampNonNegative(left.cacheWrite - right.cacheWrite),
  };
}

function clampTokenCounts(tokens: TokenCounts): TokenCounts {
  return {
    input: clampNonNegative(tokens.input),
    output: clampNonNegative(tokens.output),
    reasoning: clampNonNegative(tokens.reasoning),
    cacheRead: clampNonNegative(tokens.cacheRead),
    cacheWrite: clampNonNegative(tokens.cacheWrite),
  };
}

function emptyLedger(): TotalsLedger {
  return {
    version: TOTALS_VERSION,
    sessions: {},
    open: {},
    settled: {},
  };
}

function emptySession(): SessionDirectTotals {
  return {
    tokens: emptyTokenCounts(),
    cost: 0,
    responseCount: 0,
  };
}

function cloneLedger(ledger: TotalsLedger): TotalsLedger {
  const sessions: Record<string, SessionDirectTotals> = {};
  for (const [sessionID, session] of Object.entries(ledger.sessions)) {
    sessions[sessionID] = cloneSession(session);
  }
  const open: Record<string, OpenContribution> = {};
  for (const [messageID, contribution] of Object.entries(ledger.open)) {
    open[messageID] = cloneContribution(contribution);
  }
  return {
    version: TOTALS_VERSION,
    sessions,
    open,
    settled: cloneSettled(ledger.settled),
  };
}

function cloneSession(session: SessionDirectTotals): SessionDirectTotals {
  return {
    tokens: { ...session.tokens },
    cost: session.cost,
    responseCount: session.responseCount,
  };
}

function cloneContribution(contribution: OpenContribution): OpenContribution {
  return {
    sessionID: contribution.sessionID,
    quality: contribution.quality,
    tokens: { ...contribution.tokens },
    cost: contribution.cost,
  };
}

function cloneSettled(
  settled: Record<string, OpenContribution | true> | undefined,
): Record<string, OpenContribution | true> {
  const copy: Record<string, OpenContribution | true> = {};
  if (!settled) return copy;
  for (const [messageID, value] of Object.entries(settled)) {
    if (value === true) copy[messageID] = true;
    else copy[messageID] = cloneContribution(value);
  }
  return copy;
}

function coerceLedger(value: unknown): TotalsLedger {
  if (!isPlainObject(value) || value.version !== TOTALS_VERSION) {
    throw new TypeError("Invalid totals ledger");
  }
  if (!isPlainObject(value.sessions) || !isPlainObject(value.open)) {
    throw new TypeError("Invalid totals ledger");
  }
  const sessions: Record<string, SessionDirectTotals> = {};
  for (const [sessionID, sessionValue] of Object.entries(value.sessions)) {
    sessions[sessionID] = coerceSession(sessionValue);
  }
  const open: Record<string, OpenContribution> = {};
  for (const [messageID, contributionValue] of Object.entries(value.open)) {
    open[messageID] = coerceContribution(contributionValue);
  }
  return {
    version: TOTALS_VERSION,
    sessions,
    open,
    settled: coerceSettled(value.settled),
  };
}

function coerceSettled(value: unknown): Record<string, OpenContribution | true> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  const settled: Record<string, OpenContribution | true> = {};
  for (const [messageID, marker] of Object.entries(value)) {
    if (messageID.length === 0) throw new TypeError("Invalid totals ledger");
    if (marker === true) {
      settled[messageID] = true;
      continue;
    }
    settled[messageID] = coerceContribution(marker);
  }
  return settled;
}

function coerceSession(value: unknown): SessionDirectTotals {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  return {
    tokens: coerceTokens(value.tokens),
    cost: requireNonNegative(value.cost),
    responseCount: requireNonNegative(value.responseCount),
  };
}

function coerceContribution(value: unknown): OpenContribution {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  if (typeof value.sessionID !== "string" || value.sessionID.length === 0) {
    throw new TypeError("Invalid totals ledger");
  }
  if (value.quality !== "provisional" && value.quality !== "exact") {
    throw new TypeError("Invalid totals ledger");
  }
  return {
    sessionID: value.sessionID,
    quality: value.quality,
    tokens: coerceTokens(value.tokens),
    cost: requireNonNegative(value.cost),
  };
}

function coerceTokens(value: unknown): TokenCounts {
  if (!isPlainObject(value)) throw new TypeError("Invalid totals ledger");
  return {
    input: requireNonNegative(value.input),
    output: requireNonNegative(value.output),
    reasoning: requireNonNegative(value.reasoning),
    cacheRead: requireNonNegative(value.cacheRead),
    cacheWrite: requireNonNegative(value.cacheWrite),
  };
}

function requireNonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("Invalid totals ledger");
  }
  return value;
}

function nonNegativeCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function enqueuePath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  pathQueues.set(key, result.then(() => undefined, () => undefined));
  return result;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error || isPlainObject(value);
}
