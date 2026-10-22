import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import type { HistoryRecord } from "../src/core.js";
import type { MeasuredHistoryRecord } from "../src/statistics.js";
import {
  createHistoryStorage,
  mergeHistoryRecords,
  parseHistoryJsonl,
  readHistoryFile,
  recoverHistoryFile,
  serializeHistoryJsonl,
  hasOriginalResponseTiming,
  filterHistoryRecords,
  type ScopedHistoryRecord,
} from "../src/storage.js";
import { acquireWriterLease, prepareLedgerPaths } from "../src/persistence.js";
import { classifyMessageMetadata, createScopeRegistry } from "../src/scope.js";


test("late session scope projects old history without destroying raw records or normal users", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "history.jsonl");
  const storage = createHistoryStorage(path);
  const records = [historyRecord("root", { sessionID: "root" }), historyRecord("mc", { sessionID: "mc", parentSessionID: "root" }), historyRecord("grand", { sessionID: "grand", parentSessionID: "mc" }), historyRecord("real", { sessionID: "real", parentSessionID: "root" })];
  for (const record of records) await storage.upsert(record);
  const raw = await readFile(path, "utf8");
  const registry = createScopeRegistry();
  registry.observeSessionMetadata("mc", { agent: "historian-editor" });
  assert.deepEqual(filterHistoryRecords(await storage.read(), registry.serialize()), [records[0], records[3]]);
  assert.equal(await readFile(path, "utf8"), raw);
  assert.equal((await storage.read()).length, 4);
});

test("stored compaction proof round-trips and cannot hide other messages on same SID or be erased by replay", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createHistoryStorage(join(directory, "history.jsonl"));
  const compact: ScopedHistoryRecord = { ...historyRecord("compact"), scope: classifyMessageMetadata({ agent: "compaction" }) };
  await storage.upsert(compact);
  await storage.upsert(historyRecord("normal"));
  await storage.upsert(historyRecord("compact", { cost: 2 }));
  const records = await storage.read();
  assert.deepEqual((records.find((record) => record.messageID === "compact") as ScopedHistoryRecord).scope, compact.scope);
  assert.deepEqual(filterHistoryRecords(records).map((record) => record.messageID), ["normal"]);
  assert.deepEqual((parseHistoryJsonl(serializeHistoryJsonl([compact]))[0] as ScopedHistoryRecord).scope, compact.scope);
  const stale: ScopedHistoryRecord = { ...compact, quality: "provisional" };
  const chosen = parseHistoryJsonl(serializeHistoryJsonl([historyRecord("compact", { quality: "exact" }), stale]));
  assert.equal(chosen[0].quality, "exact");
  assert.deepEqual(filterHistoryRecords(chosen), []);
});

test("merges orphan records with the main file and keeps the more complete duplicate", async (context) => {
  const directory = await makeTestDirectory(context);
  const historyPath = join(directory, "history.jsonl");
  const mainOnly = historyRecord("main-only");
  const tempOnly = historyRecord("temp-only", { cost: 4 });
  const mainDuplicate = historyRecord("same", {
    tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    time: { start: 10 },
  });
  const recoveredDuplicate = historyRecord("same", {
    model: "provider/model",
    tokens: { input: 3, output: 12, reasoning: 2, cacheRead: 4, cacheWrite: 5 },
    time: { start: 10, firstToken: 20, completed: 40, ttft: 10, duration: 30 },
    samples: [{ timestamp: 20, tokens: 12, estimatedTokens: 12, kind: "output" }],
  });
  await writeFile(historyPath, serializeHistoryJsonl([mainOnly, mainDuplicate]), "utf8");
  const tempPath = tempFilePath(historyPath, exitedPid(), 200);
  await writeFile(tempPath, serializeHistoryJsonl([tempOnly, recoveredDuplicate]), "utf8");

  const records = await recoverForTest(historyPath, context);
  const byMessage = new Map(records.map((record) => [record.messageID, record]));

  assert.deepEqual([...byMessage.keys()], ["main-only", "same", "temp-only"]);
  assert.equal(byMessage.get("same")?.model, "provider/model");
  assert.equal(byMessage.get("same")?.tokens.output, 12);
  assert.equal(byMessage.get("temp-only")?.cost, 4);
  assert.equal(await exists(tempPath), false);
});

test("skips corrupt lines and cleans an exited orphan temp", async (context) => {
  const directory = await makeTestDirectory(context);
  const historyPath = join(directory, "history.jsonl");
  const tempPath = tempFilePath(historyPath, exitedPid(), 400);
  const corruptOnlyPath = tempFilePath(historyPath, exitedPid(), 401);
  const valid = historyRecord("valid-after-corruption");
  await writeFile(tempPath, `not-json\n${JSON.stringify(valid)}\n{broken\n`, "utf8");
  await writeFile(corruptOnlyPath, "not-json\n{broken\n", "utf8");

  const records = await recoverForTest(historyPath, context);

  assert.deepEqual(records.map((record) => record.messageID), ["valid-after-corruption"]);
  assert.equal(await exists(tempPath), false);
  assert.equal(await exists(corruptOnlyPath), false);
});

test("quality survives JSONL round trips and exact beats a later provisional snapshot", async (context) => {
  const exact = historyRecord("quality", { quality: "exact" });
  const provisional = historyRecord("quality", {
    quality: "provisional",
    time: { start: 1, completed: 30, duration: 29 },
  });
  const parsed = parseHistoryJsonl(serializeHistoryJsonl([provisional, exact]));
  assert.equal(parsed[0]?.quality, "exact");

  const merged = mergeHistoryRecords([exact], [provisional]);
  assert.equal(merged[0]?.quality, "exact");

  const directory = await makeTestDirectory(context);
  const storage = createHistoryStorage(join(directory, "quality.jsonl"));
  await storage.upsert(exact);
  await storage.upsert(provisional);
  const stored = await storage.read();
  assert.equal(stored[0]?.quality, "exact");
});

test("legacy quality, samples and response measurements parse without changing usage", () => {
  const original = { ...historyRecord("legacy"), quality: undefined,
    tokens: { input: 1, output: 5, reasoning: 0, cacheRead: 3, cacheWrite: 4 },
    speed: { response: { generatedTokens: 5, durationMs: 2, estimated: true } } };
  const legacy = JSON.stringify(original);
  const parsed = parseHistoryJsonl(`${legacy}\n`);
  assert.equal(parsed[0]?.quality, undefined);
  assert.equal(parsed[0]?.messageID, "legacy");
  assert.deepEqual(parsed[0].tokens, original.tokens);
  assert.equal(parsed[0].cost, original.cost);
  assert.deepEqual(parsed[0].samples, original.samples);
  assert.equal(parsed[0].speed?.response?.generatedTokens, 5);
});

test("separate Thinking/content timing and normalization provenance survive repeated JSONL round trips", () => {
  const original = historyRecord("thinking", { time: { start: 0, completed: 1000, firstToken: 500, firstContent: 500,
    firstResponse: 100, firstResponseSource: "thinking", firstResponseTimeSource: "part-start", firstResponseEstimated: false } });
  const [roundTrip] = parseHistoryJsonl(serializeHistoryJsonl(parseHistoryJsonl(JSON.stringify(original))));
  assert.deepEqual(roundTrip.time, original.time);
  assert.equal(hasOriginalResponseTiming(roundTrip), true);
  const [missing] = parseHistoryJsonl(JSON.stringify({ ...original, time: { completed: 1000 } }));
  assert.equal(missing.time.start, 0);
  assert.equal(hasOriginalResponseTiming(missing), false);
  const [reloaded] = parseHistoryJsonl(serializeHistoryJsonl([missing]));
  assert.equal(hasOriginalResponseTiming(reloaded), false);
});

test("explicit live update order outranks nonzero completeness; unversioned recovery does not", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createHistoryStorage(join(directory, "authority.jsonl"));
  const live = (sequence: number, output: number): MeasuredHistoryRecord => ({ ...historyRecord("m", { quality: "exact",
    tokens: { input: 1, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }), update: {
      source: "live", instanceID: "server", sequence, receivedAt: sequence, fingerprint: String(sequence), seenFingerprints: Array.from({ length: sequence }, (_, i) => String(i + 1)),
    } });
  await storage.upsert(live(1, 10));
  await storage.upsert(live(2, 0));
  assert.equal((await storage.read())[0].tokens.output, 0);
  await storage.upsert(live(1, 10));
  assert.equal((await storage.read())[0].tokens.output, 0);
  const merged = mergeHistoryRecords(await storage.read(), [historyRecord("m", { quality: "exact" })]);
  assert.equal(merged[0].tokens.output, 0);
  assert.equal((merged[0] as MeasuredHistoryRecord).update?.sequence, 2);
});

async function makeTestDirectory(context: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const cache = join(homedir(), ".cache", "tokpulse-tests");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "oc-tps-storage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function recoverForTest(historyPath: string, context: { after: (callback: () => Promise<void>) => void }) {
  const lease = await acquireWriterLease(await prepareLedgerPaths(dirnameOf(historyPath), { historyPath }));
  context.after(() => lease.release());
  return recoverHistoryFile(historyPath, lease);
}

test("pure history readers ignore orphan files without creating directories or changing bytes", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "history.jsonl");
  const orphan = tempFilePath(path, exitedPid(), 500);
  const bytes = serializeHistoryJsonl([historyRecord("orphan")]);
  await writeFile(orphan, bytes);
  assert.deepEqual(await readHistoryFile(path), []);
  assert.deepEqual(await createHistoryStorage(path).readAll(), []);
  assert.equal(await readFile(orphan, "utf8"), bytes);
  assert.equal(await exists(path), false);
  const missing = join(directory, "missing", "history.jsonl");
  assert.deepEqual(await createHistoryStorage(missing).read(), []);
  assert.equal(await exists(join(directory, "missing")), false);
});

test("replayed and corrected completions retain first admission order; protected facts outlive the window", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createHistoryStorage(join(directory, "history.jsonl"), { maxRecords: 2 });
  await storage.upsert(historyRecord("old"));
  await storage.upsert(historyRecord("new"));
  await storage.upsert(historyRecord("old"));
  await storage.upsert(historyRecord("old", { cost: 2 }));
  await storage.upsert(historyRecord("newest", { time: { start: -10, completed: -1 } }));
  assert.deepEqual((await storage.readAll()).map((r) => r.messageID), ["new", "newest"]);
  const protectedMessageIDs = new Set(["new"]);
  await storage.upsert(historyRecord("four"), { protectedMessageIDs });
  await storage.upsert(historyRecord("five"), { protectedMessageIDs });
  assert.deepEqual((await storage.readAll()).map((r) => r.messageID), ["new", "four", "five"]);
  await storage.prune({ protectedMessageIDs });
  assert.equal((await storage.readAll()).length, 3);
  await storage.prune();
  assert.deepEqual((await storage.readAll()).map((r) => r.messageID), ["four", "five"]);
});

function tempFilePath(historyPath: string, pid: number, timestamp: number): string {
  return join(dirnameOf(historyPath), `.${basename(historyPath)}.${pid}.${timestamp}.test.tmp`);
}

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function exitedPid(): number {
  let candidate = process.pid + 1_000_000;
  while (candidate < 2_147_483_647) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
    candidate += 1;
  }
  throw new Error("Could not find an exited PID for the storage test");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function historyRecord(
  messageID: string,
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    version: 1,
    messageID,
    sessionID: "session",
    model: "model",
    tokens: { input: 1, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 1,
    time: { start: 1, firstToken: 2, completed: 3, ttft: 1, duration: 2 },
    samples: [{ timestamp: 2, tokens: 5, estimatedTokens: 5, kind: "output" }],
    ...overrides,
  };
}

test("history stores an exact agent and does not infer one from mode, title, or compaction", () => {
  const [named] = parseHistoryJsonl(serializeHistoryJsonl([historyRecord("m", { agent: " fixer " })]));
  assert.equal(named.agent, "fixer");
  assert.equal(parseHistoryJsonl(serializeHistoryJsonl([historyRecord("legacy")]))[0].agent, undefined);
  const raw = { ...historyRecord("plain"), mode: "designer", title: "fixer" };
  delete raw.agent;
  assert.equal(parseHistoryJsonl(`${JSON.stringify(raw)}\n`)[0].agent, undefined);
  assert.equal(parseHistoryJsonl(serializeHistoryJsonl([historyRecord("bad", { agent: "bad\u001bname" })]))[0].agent, undefined);
  assert.equal(parseHistoryJsonl(serializeHistoryJsonl([historyRecord("compact", { agent: "compaction" })]))[0].agent, undefined);
  const [kept] = parseHistoryJsonl(`${JSON.stringify(historyRecord("m", { agent: "oracle" }))}\n${JSON.stringify(historyRecord("m"))}\n`);
  assert.equal(kept.agent, "oracle");
  assert.equal(kept.tokens.output, 5);
  const [replaced] = parseHistoryJsonl(`${JSON.stringify(historyRecord("m", { agent: "fixer" }))}\n${JSON.stringify(historyRecord("m", { agent: " custom-worker " }))}\n`);
  assert.equal(replaced.agent, "custom-worker");
});
