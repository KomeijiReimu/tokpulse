import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginInput } from "@opencode-ai/plugin";
import { server } from "../src/server.js";
import { createTotalsStorage } from "../src/totals-storage.js";
import { parseHistoryJsonl } from "../src/storage.js";
import { calculateTTFT, type HistoryRecord } from "../src/core.js";

async function backend(run: (ctx: { path: string; send: (event: any) => Promise<void>; restart: (observedSince?: number) => Promise<(event: any) => Promise<void>> }) => Promise<void>, initial?: HistoryRecord[], maxRecords = 1000) {
  const cache = join(homedir(), ".cache", "oc-tps-tests");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "thinking-server-"));
  const path = join(directory, "history.jsonl");
  if (initial) await writeFile(path, initial.map((record) => JSON.stringify(record)).join("\n") + "\n");
  let currentHooks: any;
  let currentSend: (event: any) => Promise<void>;
  const restart = async (observedSince = 0) => {
    await currentHooks?.dispose?.();
    const startupNow = Date.now;
    let hooks: Awaited<ReturnType<typeof server>>;
    try {
      Date.now = () => observedSince;
      hooks = await server({ directory, worktree: directory } as PluginInput, { historyPath: path, maxRecords });
      currentHooks = hooks;
    } finally { Date.now = startupNow; }
    currentSend = async (event: any) => {
      const dateNow = Date.now;
      let pending: ReturnType<NonNullable<typeof hooks.event>>;
      try {
        Date.now = () => event.timestamp ?? dateNow();
        pending = hooks.event!({ event });
      } finally {
        Date.now = dateNow;
      }
      await pending!;
    };
    return currentSend;
  };
  try { await restart(); await run({ path, send: (event) => currentSend(event), restart }); }
  finally { await currentHooks?.dispose?.(); await rm(directory, { recursive: true, force: true }); }
}
const started = (id = "m", created = 0, timestamp = created, extra = {}) => ({ type: "message.updated", timestamp, ...extra,
  properties: { info: { id, sessionID: "s", role: "assistant", time: { created } } } });
const thinking = (id = "m", start: number | undefined = 100, timestamp = 200, extra: any = {}) => ({ type: "message.part.updated", timestamp,
  properties: { part: { id: `${id}-r`, messageID: id, sessionID: "s", type: "reasoning", text: "", metadata: {},
    ...(start === undefined ? {} : { time: { start } }), ...extra } } });
const delta = (id = "m", timestamp = 500, partID = `${id}-r`, text = "think") => ({ type: "message.part.delta", timestamp,
  properties: { sessionID: "s", messageID: id, partID, field: "text", delta: text } });
const completed = (id = "m", output = 0, reasoning = 10, end = 1000) => {
  const info: {
    id: string;
    sessionID: string;
    role: string;
    tokens: { input: number; output: number; reasoning: number };
    cost: number;
    time: { created: number; completed: number };
    agent?: string;
    mode?: string;
    title?: string;
  } = {
    id, sessionID: "s", role: "assistant", tokens: { input: 1, output, reasoning }, cost: 2,
    time: { created: 0, completed: end },
  };
  return { type: "message.updated", timestamp: end, properties: { info } };
};
async function records(path: string) { return parseHistoryJsonl(await readFile(path, "utf8")); }

test("content ingress leaves completion usage authoritative without new timing or speed", async () => {
  await backend(async ({ path, send }) => {
    await send(started());
    await send(thinking());
    await send(thinking("m", 150, 250));
    await send(delta());
    await send(completed());
    const [record] = await records(path);
    assert.equal(record.time.firstResponse, undefined);
    assert.equal(record.time.firstResponseSource, undefined);
    assert.equal(record.time.firstResponseTimeSource, undefined);
    assert.equal(record.time.firstResponseEstimated, undefined);
    assert.equal(record.time.firstContent, undefined);
    assert.equal(record.time.firstToken, undefined);
    assert.equal(record.samples.length, 0);
    assert.equal(calculateTTFT(record), undefined);
    assert.equal(record.tokens.reasoning, 10);
    assert.equal(record.speed, undefined);
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

function legacy(id: string, time: any = { start: 0, completed: 1000 }): HistoryRecord {
  return { version: 1, messageID: id, sessionID: "s", tokens: { input: 1, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 2, quality: "exact", time, samples: [] };
}
test("legacy usage survives restart, pruning and replay without reconstructing speed", async () => {
  await backend(async ({ path, send, restart }) => {
    const totals = createTotalsStorage({ historyPath: path });
    const before = await totals.read();
    assert.equal(before.generationBasisVersion, 3);
    assert.equal(before.sessions.s.speed?.response.responseCount ?? 0, 0);
    assert.equal(before.settled.good === true, false);
    assert.equal((before.settled.good as any).speed?.generation, undefined);
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
    assert.equal(after.sessions.s.speed, undefined);
  }, [legacy("good"), legacy("missing", { completed: 1000 })], 1);
});

test("assistant completion keeps fixer then oracle without recounting, and ignores mode, title, and compaction", async () => {
  await backend(async ({ path, send }) => {
    await send({ ...started(), properties: { info: { ...started().properties.info, agent: " fixer " } } });
    await send(completed("m", 4, 0, 100));
    assert.equal((await records(path))[0].agent, "fixer");
    const oracle = completed("m", 4, 0, 200);
    oracle.properties.info = { ...oracle.properties.info, agent: "oracle" };
    await send(oracle);
    const [record] = await records(path);
    assert.equal(record.agent, "oracle");
    assert.equal(record.tokens.output, 4);
    assert.equal(record.cost, 2);
    assert.equal(record.samples.length, 0);
    const ledger = await createTotalsStorage({ historyPath: path }).read();
    assert.deepEqual(ledger.sessionAgents?.s, ["fixer", "oracle"]);
    assert.equal(ledger.sessions.s.tokens.output, 4);
    assert.equal(ledger.sessions.s.cost, 2);
    assert.equal(ledger.sessions.s.responseCount, 1);
    const plain = completed("plain", 3, 0, 300);
    plain.properties.info = { ...plain.properties.info, mode: "designer", title: "fixer" };
    await send(plain);
    assert.equal((await records(path)).find((entry) => entry.messageID === "plain")?.agent, undefined);
    const hidden = completed("hidden", 9, 0, 400);
    hidden.properties.info = { ...hidden.properties.info, agent: "compaction", mode: "designer", title: "oracle" };
    await send(hidden);
    const stored = await records(path);
    assert.equal(stored.find((entry) => entry.messageID === "hidden"), undefined);
    assert.equal(stored.find((entry) => entry.messageID === "m")?.agent, "oracle");
    const after = await createTotalsStorage({ historyPath: path }).read();
    assert.deepEqual(after.sessionAgents?.s, ["fixer", "oracle"]);
    assert.equal(after.sessions.s.tokens.output, 7);
    assert.equal(after.sessions.s.responseCount, 2);
    assert.equal(after.sessions.s.cost, 4);
  });
});
