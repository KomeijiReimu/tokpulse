import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HistoryRecord } from "../src/core.js";
import { measureRecordSpeed, mergeRecordSpeed, type MeasuredHistoryRecord } from "../src/statistics.js";
import {
  createHistoryStorage,
  mergeHistoryRecords,
  parseHistoryJsonl,
  readHistoryFile,
  serializeHistoryJsonl,
  hasOriginalResponseTiming,
  filterHistoryRecords,
  type ScopedHistoryRecord,
} from "../src/storage.js";
import { classifyMessageMetadata, createScopeRegistry } from "../src/scope.js";

test("late session scope projects old history without destroying raw records or normal users", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "history.jsonl");
  const storage = createHistoryStorage(path);
  const records = [historyRecord("root", { sessionID: "root" }), historyRecord("mc", { sessionID: "mc", parentSessionID: "root" }), historyRecord("grand", { sessionID: "grand", parentSessionID: "mc" }), historyRecord("real", { sessionID: "real", parentSessionID: "root" })];
  for (const record of records) await storage.upsert(record);
  const raw = await readFile(path, "utf8");
  const registry = createScopeRegistry();
  registry.observeMessageMetadata("mc", { agent: "historian-editor" });
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

test("history normalization, upsert and scope projection preserve short observation quality and clock evidence", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createHistoryStorage(join(directory, "history.jsonl"));
  const record = historyRecord("short-quality", { time: { start: 0, completed: 3000 } });
  record.speed = measureRecordSpeed(record, { usageExact: true, responseTimingExact: true, generation: {
    version: 3, coverage: "complete", complete: true, estimated: true,
    start: 100, end: 300, firstReceiveMono: 10, lastReceiveMono: 210, observationCount: 2,
    timeSource: "receive-monotonic", fromCurrentStart: true, selectedStream: "v2", stepID: "short-step",
    outputObserved: true, reasoningObserved: false,
    bytes: { output: { total: 100, firstBatch: 25 }, reasoning: { total: 0, firstBatch: 0 } },
    usage: { output: 5, reasoning: 0 }, clockSource: "performance.now", clockResolutionMs: 1, observationQuality: "short",
  } });
  assert.equal(record.speed.generation?.observationQuality, "short");
  await storage.upsert(record);
  const correction = { ...record, cost: 2 };
  delete correction.speed;
  await storage.upsert(correction);
  const projected = filterHistoryRecords(await storage.read());
  assert.equal(projected[0].speed?.generation?.observationQuality, "short");
  assert.equal(projected[0].speed?.generationEvidence?.observationQuality, "short");
  assert.equal(projected[0].speed?.generationEvidence?.clockSource, "performance.now");
  assert.equal(projected[0].speed?.generationEvidence?.clockResolutionMs, 1);
  assert.equal(parseHistoryJsonl(serializeHistoryJsonl(projected))[0].speed?.generation?.observationQuality, "short");
});

test("recovers valid records from a temp-only file", async (context) => {
  const directory = await makeTestDirectory(context);
  const historyPath = join(directory, "history.jsonl");
  const tempPath = tempFilePath(historyPath, exitedPid(), 100);
  const expected = historyRecord("temp-only", { tokens: { input: 2, output: 9, reasoning: 0, cacheRead: 0, cacheWrite: 0 } });
  await writeFile(tempPath, serializeHistoryJsonl([expected]), "utf8");

  const records = await readHistoryFile(historyPath);

  assert.deepEqual(records.map((record) => record.messageID), ["temp-only"]);
  assert.equal(records[0].tokens.output, 9);
  assert.equal(await exists(tempPath), false);
  assert.equal((await readFile(historyPath, "utf8")).includes("temp-only"), true);
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

  const records = await readHistoryFile(historyPath);
  const byMessage = new Map(records.map((record) => [record.messageID, record]));

  assert.deepEqual([...byMessage.keys()], ["main-only", "same", "temp-only"]);
  assert.equal(byMessage.get("same")?.model, "provider/model");
  assert.equal(byMessage.get("same")?.tokens.output, 12);
  assert.equal(byMessage.get("temp-only")?.cost, 4);
  assert.equal(await exists(tempPath), false);
});

test("does not read or remove a current-process temp file", async (context) => {
  const directory = await makeTestDirectory(context);
  const historyPath = join(directory, "history.jsonl");
  const tempPath = tempFilePath(historyPath, process.pid, 300);
  await writeFile(tempPath, serializeHistoryJsonl([historyRecord("live")]), "utf8");

  const records = await readHistoryFile(historyPath);

  assert.deepEqual(records, []);
  assert.equal(await exists(historyPath), false);
  assert.equal(await exists(tempPath), true);
});

test("skips corrupt lines and cleans an exited orphan temp", async (context) => {
  const directory = await makeTestDirectory(context);
  const historyPath = join(directory, "history.jsonl");
  const tempPath = tempFilePath(historyPath, exitedPid(), 400);
  const corruptOnlyPath = tempFilePath(historyPath, exitedPid(), 401);
  const valid = historyRecord("valid-after-corruption");
  await writeFile(tempPath, `not-json\n${JSON.stringify(valid)}\n{broken\n`, "utf8");
  await writeFile(corruptOnlyPath, "not-json\n{broken\n", "utf8");

  const records = await readHistoryFile(historyPath);

  assert.deepEqual(records.map((record) => record.messageID), ["valid-after-corruption"]);
  assert.equal(await exists(tempPath), false);
  assert.equal(await exists(corruptOnlyPath), false);
});

test("mergeHistoryRecords keeps temp-only records and resolves newer ties", () => {
  const older = historyRecord("same", { time: { start: 10, completed: 20 } });
  const newer = historyRecord("same", { time: { start: 10, completed: 30 }, cost: 2 });
  const merged = mergeHistoryRecords([older], [newer, historyRecord("only-temp")]);

  assert.equal(merged.length, 2);
  assert.equal(merged.find((record) => record.messageID === "same")?.cost, 2);
  assert.equal(merged.some((record) => record.messageID === "only-temp"), true);
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

test("legacy records without quality remain readable", () => {
  const legacy = JSON.stringify({ ...historyRecord("legacy"), quality: undefined });
  const parsed = parseHistoryJsonl(`${legacy}\n`);
  assert.equal(parsed[0]?.quality, undefined);
  assert.equal(parsed[0]?.messageID, "legacy");
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

test("v3 evidence round trips and authoritative history corrections rescale interval tokens", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "v3.jsonl");
  const original: MeasuredHistoryRecord = { ...historyRecord("m", { quality: "exact", time: { start: 0, completed: 3000 },
    tokens: { input: 1, output: 10, reasoning: 2, cacheRead: 0, cacheWrite: 0 } }),
    update: { source: "live", instanceID: "writer", sequence: 1, receivedAt: 1, fingerprint: "first", seenFingerprints: ["first"] } };
  original.speed = measureRecordSpeed(original, { usageExact: true, responseTimingExact: true, generation: {
    version: 3, coverage: "complete", complete: true, estimated: true, start: 100, end: 2100,
    firstReceiveMono: 10, lastReceiveMono: 2010, observationCount: 2, timeSource: "receive-monotonic",
    fromCurrentStart: true, selectedStream: "v2", stepID: "step-1", outputObserved: true, reasoningObserved: true,
    bytes: { output: { total: 100, firstBatch: 25 }, reasoning: { total: 100, firstBatch: 50 } },
    usage: { output: 10, reasoning: 2 },
  } });
  const [roundTrip] = parseHistoryJsonl(serializeHistoryJsonl([original]));
  assert.deepEqual(roundTrip.speed, original.speed);
  assert.equal(roundTrip.speed?.generation?.generatedTokens, 8.5);
  assert.equal(roundTrip.speed?.generation?.coverageGeneratedTokens, 12);
  const correction: MeasuredHistoryRecord = { ...original, tokens: { ...original.tokens, output: 20, reasoning: 4 },
    speed: { response: { generatedTokens: 24, durationMs: 3000, estimated: false } },
    update: { ...original.update!, sequence: 2, receivedAt: 2, fingerprint: "second", seenFingerprints: ["first", "second"] } };
  correction.speed = mergeRecordSpeed(correction, original);
  const check = (record: HistoryRecord) => {
    assert.equal(record.speed?.generation?.generatedTokens, 17);
    assert.equal(record.speed?.generation?.coverageGeneratedTokens, 24);
    assert.equal(record.speed?.generation?.durationMs, 2000);
    assert.equal(record.speed?.generation?.estimated, true);
    assert.equal(record.speed?.generationEvidence?.usage?.output, 20);
  };
  check(mergeHistoryRecords([roundTrip], [correction])[0]);
  check(parseHistoryJsonl(`${serializeHistoryJsonl([original])}${JSON.stringify(correction)}\n`)[0]);
  check(parseHistoryJsonl(serializeHistoryJsonl([original, correction]))[0]);
  await createHistoryStorage(path).upsert(original);
  await createHistoryStorage(path).upsert(correction);
  check((await createHistoryStorage(path).read())[0]);
  const provisional: MeasuredHistoryRecord = { ...correction, quality: "provisional", tokens: { ...original.tokens, output: 100 },
    update: { ...correction.update!, sequence: 3, fingerprint: "third", seenFingerprints: ["first", "second", "third"] } };
  await createHistoryStorage(path).upsert(provisional);
  await createHistoryStorage(path).upsert(original);
  check((await createHistoryStorage(path).read())[0]);
  const revoked: MeasuredHistoryRecord = { ...correction, speed: { response: correction.speed.response },
    update: { ...correction.update!, sequence: 3, fingerprint: "revoked", seenFingerprints: ["first", "second", "revoked"] } };
  await createHistoryStorage(path).upsert(revoked);
  const [removed] = await createHistoryStorage(path).read();
  assert.equal(removed.speed?.generation, undefined);
  assert.equal(removed.speed?.generationEvidence, undefined);
  assert.equal(removed.speed?.response?.generatedTokens, 24);
  const empty: MeasuredHistoryRecord = { ...revoked, speed: {}, update: { ...revoked.update!, sequence: 4, fingerprint: "empty", seenFingerprints: ["first", "second", "revoked", "empty"] } };
  const [normalizedEmpty] = parseHistoryJsonl(serializeHistoryJsonl([empty]));
  assert.deepEqual(normalizedEmpty.speed, {});
  assert.deepEqual(mergeHistoryRecords([original], [normalizedEmpty])[0].speed,
    { generationCoverage: { status: "unknown", reasons: ["generation-invalidated"] } });
  await createHistoryStorage(path).upsert(empty);
  assert.deepEqual((await createHistoryStorage(path).read())[0].speed,
    { generationCoverage: { status: "unknown", reasons: ["generation-invalidated"] } });
});

async function makeTestDirectory(context: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-storage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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
