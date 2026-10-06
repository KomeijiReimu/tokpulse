import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginInput } from "@opencode-ai/plugin";
import { recordPartMetadata, server } from "../src/server.js";
import { createTotalsStorage } from "../src/totals-storage.js";
import { parseHistoryJsonl } from "../src/storage.js";
import { calculateTTFT, type HistoryRecord } from "../src/core.js";

async function backend(run: (ctx: { path: string; send: (event: any) => Promise<void>; restart: () => Promise<(event: any) => Promise<void>> }) => Promise<void>, initial?: HistoryRecord[], maxRecords = 1000) {
  const cache = join(homedir(), ".cache", "oc-tps-tests");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "thinking-server-"));
  const path = join(directory, "history.jsonl");
  if (initial) await writeFile(path, initial.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const restart = async () => {
    const hooks = await server({ directory, worktree: directory } as PluginInput, { historyPath: path, maxRecords });
    return async (event: any) => { await hooks.event!({ event }); };
  };
  try { await run({ path, send: await restart(), restart }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const started = (id = "m", created = 0, timestamp = created, extra = {}) => ({ type: "message.updated", timestamp, ...extra,
  properties: { info: { id, sessionID: "s", role: "assistant", time: { created } } } });
const thinking = (id = "m", start: number | undefined = 100, timestamp = 200, extra: any = {}) => ({ type: "message.part.updated", timestamp,
  properties: { part: { id: `${id}-r`, messageID: id, sessionID: "s", type: "reasoning", text: "", metadata: {},
    ...(start === undefined ? {} : { time: { start } }), ...extra } } });
const delta = (id = "m", timestamp = 500, partID = `${id}-r`, text = "think") => ({ type: "message.part.delta", timestamp,
  properties: { sessionID: "s", messageID: id, partID, field: "text", delta: text } });
const completed = (id = "m", output = 0, reasoning = 10, end = 1000) => ({ type: "message.updated", timestamp: end,
  properties: { info: { id, sessionID: "s", role: "assistant", tokens: { input: 1, output, reasoning }, cost: 2,
    time: { created: 0, completed: end } } } });
async function records(path: string) { return parseHistoryJsonl(await readFile(path, "utf8")); }

test("metadata-only Thinking precedes content, keeps earliest provenance and adds no samples", async () => {
  await backend(async ({ path, send }) => {
    await send(started());
    await send(thinking());
    await send(thinking("m", 150, 250));
    await send(completed("m", 0, 0));
    const [record] = await records(path);
    assert.equal(record.time.firstResponse, 100);
    assert.equal(record.time.firstResponseSource, "thinking");
    assert.equal(record.time.firstResponseTimeSource, "part-start");
    assert.equal(record.time.firstResponseEstimated, false);
    assert.equal(record.time.firstContent, undefined);
    assert.equal(record.time.firstToken, undefined);
    assert.equal(record.samples.length, 0);
    assert.equal(calculateTTFT(record), 100);
  });
  await backend(async ({ path, send }) => {
    await send(started()); await send(thinking()); await send(delta()); await send(completed());
    const [record] = await records(path);
    assert.equal(record.time.firstResponse, 100);
    assert.equal(record.time.firstContent, 500);
    assert.equal(record.time.firstToken, 500);
    assert.equal(record.samples.length, 1);
    assert.equal(record.samples[0].tokens, 10);
    assert.equal(record.speed?.generation, undefined);
  });
});

test("Thinking range validation uses estimated arrival and earlier valid content wins", async () => {
  await backend(async ({ path, send }) => {
    await send(started()); await send(thinking("m", -10, 200)); await send(delta("m", 150)); await send(completed());
    const [record] = await records(path);
    assert.equal(record.time.firstResponse, 150);
    assert.equal(record.time.firstResponseSource, "content");
    assert.equal(record.time.firstResponseEstimated, true);
  });
  await backend(async ({ path, send }) => {
    await send(started()); await send(thinking("m", 9999, 200)); await send(completed("m", 0, 0));
    const [record] = await records(path);
    assert.equal(record.time.firstResponse, 200);
    assert.equal(record.time.firstResponseTimeSource, "arrival");
    assert.equal(record.time.firstResponseEstimated, true);
  });
});

test("busy/user/historical/completed/reconnect snapshots cannot create metadata-only responses", async () => {
  const active = new Map();
  recordPartMetadata(active, thinking().properties, 200);
  assert.equal(active.size, 0);
  await backend(async ({ path, send }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    await send(thinking("busy"));
    await send(started("history", 0, 5000)); await send(thinking("history"));
    await send(started("snapshot", 0, 0, { source: "snapshot" })); await send(thinking("snapshot"));
    await send({ type: "message.updated", timestamp: 0, properties: { info: { id: "user", sessionID: "s", role: "user", time: { created: 0 } } } });
    await send(thinking("user"));
    await send(started("ended")); await send(thinking("ended", 100, 200, { time: { start: 100, end: 150 } }));
    for (const id of ["busy", "history", "snapshot", "user", "ended"]) await send(completed(id, 0, 0));
    assert.ok((await records(path)).every((record) => record.time.firstResponse === undefined));
    await send(thinking("ended", 100, 1200));
    assert.ok((await records(path)).every((record) => record.time.firstResponse === undefined));
  });
});

test("event and properties snapshot/history/reconnect sources cannot create, signal or complete live responses", async () => {
  await backend(async ({ path, send }) => {
    for (const source of ["snapshot", "history", "reconnect"]) {
      for (const location of ["event", "properties"]) {
        const replay = (event: any) => location === "event" ? { ...event, source }
          : { ...event, properties: { ...event.properties, source } };
        const historic = `${source}-${location}-historic`;
        await send(replay(started(historic)));
        await send(thinking(historic));
        await send(completed(historic, 0, 0));
        const current = `${source}-${location}-current`;
        await send(started(current));
        await send(replay(thinking(current)));
        await send(replay(completed(current, 999, 0)));
        await send(completed(current, 0, 0));
      }
    }
    const stored = await records(path);
    assert.equal(stored.length, 12);
    assert.ok(stored.every((record) => record.time.firstResponse === undefined && record.samples.length === 0 && record.tokens.output === 0));
  });
});

test("complete generation excludes tool wait, while response includes it", async () => {
  await backend(async ({ path, send }) => {
    await send(started());
    await send({ type: "message.part.updated", timestamp: 100, properties: { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "", time: { start: 100 } } } });
    await send(delta("m", 100, "p", "hello"));
    await send({ type: "message.part.updated", timestamp: 200, properties: { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "hello", time: { start: 100, end: 200 } } } });
    await send({ type: "message.part.updated", timestamp: 200, properties: { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 200 } } } } });
    await send({ type: "message.part.updated", timestamp: 4500, properties: { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", time: { start: 200, end: 4500 } } } } });
    await send(completed("m", 10, 0, 5000));
    const [record] = await records(path);
    assert.equal(record.speed?.generation?.durationMs, 100);
    assert.equal(record.speed?.generationEvidence?.version, 2);
    assert.equal(record.speed?.response?.durationMs, 5000);
  });
});

test("metadata for superseded assistants cannot claim the current response signal", async () => {
  await backend(async ({ path, send }) => {
    await send(started("old", 0));
    await send(started("current", 100));
    await send(started("old", 0, 200));
    await send(thinking("old", 50, 300));
    await send(thinking("current", 150, 300));
    await send(completed("old", 0, 0)); await send(completed("current", 0, 0));
    const stored = await records(path);
    assert.equal(stored.find((record) => record.messageID === "old")?.time.firstResponse, undefined);
    assert.equal(stored.find((record) => record.messageID === "current")?.time.firstResponse, 150);
  });
});

function legacy(id: string, time: any = { start: 0, completed: 1000 }): HistoryRecord {
  return { version: 1, messageID: id, sessionID: "s", tokens: { input: 1, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 2, quality: "exact", time, samples: [] };
}
test("server legacy backfill survives replay, restart and pruning, skips fabricated timing", async () => {
  await backend(async ({ path, send, restart }) => {
    const totals = createTotalsStorage({ historyPath: path });
    const before = await totals.read();
    assert.equal(before.sessions.s.speed?.response.responseCount, 1);
    assert.equal(before.settled.good === true, false);
    assert.equal((before.settled.good as any).speedBackfill.source, "server");
    assert.equal(before.sessions.s.responseCount, 2);
    assert.equal(before.open.missing.speed, undefined);
    await restart();
    assert.deepEqual(await totals.read(), before);
    await send(completed("new", 20, 0, 2000));
    const after = await totals.read();
    await (await restart())({ ...completed("good", 10, 0), source: "snapshot" });
    assert.deepEqual(await totals.read(), after);
    assert.equal(after.sessions.s.tokens.output, 40);
    assert.equal(after.sessions.s.responseCount, 3);
    assert.equal(after.sessions.s.cost, 6);
    assert.equal(after.sessions.s.speed?.response.responseCount, 2);
  }, [legacy("good"), legacy("missing", { completed: 1000 })], 1);
});
