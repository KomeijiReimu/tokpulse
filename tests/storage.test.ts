import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HistoryRecord } from "../src/core.js";
import {
  createHistoryStorage,
  mergeHistoryRecords,
  parseHistoryJsonl,
  readHistoryFile,
  serializeHistoryJsonl,
} from "../src/storage.js";

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
