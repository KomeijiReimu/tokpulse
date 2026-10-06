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

async function backend(run: (ctx: { path: string; send: (event: any) => Promise<void>; restart: (observedSince?: number) => Promise<(event: any) => Promise<void>> }) => Promise<void>, initial?: HistoryRecord[], maxRecords = 1000) {
  const cache = join(homedir(), ".cache", "oc-tps-tests");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "thinking-server-"));
  const path = join(directory, "history.jsonl");
  if (initial) await writeFile(path, initial.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const restart = async (observedSince = 0) => {
    const startupNow = Date.now;
    let hooks: Awaited<ReturnType<typeof server>>;
    try {
      Date.now = () => observedSince;
      hooks = await server({ directory, worktree: directory } as PluginInput, { historyPath: path, maxRecords });
    } finally { Date.now = startupNow; }
    return async (event: any) => {
      const wall = event.receiveWall ?? event.timestamp ?? Date.now();
      const mono = event.receiveMono ?? wall;
      const dateNow = Date.now;
      const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
      let pending: ReturnType<NonNullable<typeof hooks.event>>;
      try {
        Date.now = () => wall;
        Object.defineProperty(performance, "now", { configurable: true, value: () => mono });
        pending = hooks.event!({ event });
      } finally {
        Date.now = dateNow;
        if (descriptor) Object.defineProperty(performance, "now", descriptor);
        else delete (performance as any).now;
      }
      await pending!;
    };
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

test("ambiguous tool tails cannot manufacture generation coverage from delta or part spans", async () => {
  await backend(async ({ path, send }) => {
    await send(started());
    await send({ type: "session.next.step.started", timestamp: 0, properties: { sessionID: "s", messageID: "m", stepID: "one" } });
    await send({ type: "message.part.updated", timestamp: 100, properties: { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "", time: { start: 100 } } } });
    await send(delta("m", 100, "p", "hello"));
    await send(delta("m", 1200, "p", "world"));
    await send({ type: "message.part.updated", timestamp: 1300, properties: { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "helloworld", time: { start: 100, end: 1300 } } } });
    await send({ type: "message.part.updated", timestamp: 1300, properties: { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 1300 } } } } });
    await send({ type: "message.part.updated", timestamp: 4500, properties: { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", time: { start: 200, end: 4500 } } } } });
    await send(completed("m", 10, 0, 5000));
    const [record] = await records(path);
    assert.equal(record.speed?.generation, undefined);
    assert.equal(record.speed?.generationEvidence, undefined);
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

async function v3Start(send: (event: any) => Promise<void>, id: string, created = 0) {
  await send(started(id, created));
  await send({ type: "session.next.step.started", timestamp: created, properties: { sessionID: "s", messageID: id, stepID: `${id}-step` } });
}
async function v3Deltas(send: (event: any) => Promise<void>, id: string, first = 100, last = 1200) {
  await send({ type: "message.part.updated", timestamp: first, properties: { part: {
    id: `${id}-p`, messageID: id, sessionID: "s", type: "text", text: "" } } });
  await send({ ...delta(id, first, `${id}-p`, "hello"), properties: { ...delta(id, first, `${id}-p`, "hello").properties, kind: "output" } });
  await send({ ...delta(id, last, `${id}-p`, "world"), properties: { ...delta(id, last, `${id}-p`, "world").properties, kind: "output" } });
  await send({ type: "message.part.updated", timestamp: last + 100, properties: { part: {
    id: `${id}-p`, messageID: id, sessionID: "s", type: "text", text: "helloworld", time: { start: first, end: last + 100 } } } });
}

// Official message/part events only: no synthetic session.next step ownership.
async function officialGeneration(send: (event: any) => Promise<void>, beforeDeltas?: () => Promise<void>) {
  await send(started("m"));
  await send({ type: "message.part.updated", timestamp: 0, properties: { part: {
    id: "official-step", messageID: "m", sessionID: "s", type: "step-start" } } });
  for (const [id, type] of [["text", "text"], ["reason", "reasoning"]]) await send({ type: "message.part.updated", timestamp: 0,
    properties: { part: { id, type, messageID: "m", sessionID: "s", text: "" } } });
  await beforeDeltas?.();
  for (const [timestamp, text, reasoning] of [[100, "hello", "think"], [1200, "world", "again"]] as const) {
    await send(delta("m", timestamp, "text", text));
    await send(delta("m", timestamp, "reason", reasoning));
  }
  for (const [id, type, text] of [["text", "text", "helloworld"], ["reason", "reasoning", "thinkagain"]]) await send({
    type: "message.part.updated", timestamp: 1300, properties: { part: { id, type, messageID: "m", sessionID: "s", text, time: { end: 1300 } } } });
  await send(completed("m", 10, 6, 1500));
}

test("official assistant/step-start/content/completion events qualify output plus reasoning v3", async () => {
  await backend(async ({ path, send }) => {
    await officialGeneration(send);
    const [record] = await records(path);
    assert.equal(record.speed?.generationEvidence?.stepID, "official-step");
    assert.equal(record.speed?.generationEvidence?.selectedStream, "legacy");
    assert.equal(record.speed?.generation?.durationMs, 1100);
    assert.equal(record.speed?.generation?.generatedTokens, 8);
    assert.equal(record.speed?.generation?.coverageGeneratedTokens, 16);
    assert.equal(record.speed?.generation?.estimated, true);
  });
});

test("nested session info.id retry targets current or pending assistant, never the session as a message", async () => {
  for (const pending of [false, true]) await backend(async ({ path, send }) => {
    const retry = async () => {
      await send({ type: "session.status", timestamp: 50, properties: { sessionID: "s", info: { id: "s" }, status: { type: "retry" } } });
      await send({ type: "session.status", timestamp: 60, properties: { sessionID: "s", info: { id: "s" }, status: { type: "busy" } } });
    };
    if (pending) await retry();
    await officialGeneration(send, pending ? undefined : retry);
    const [record] = await records(path);
    assert.equal(record.tokens.output, 10);
    assert.equal(record.tokens.reasoning, 6);
    assert.equal(record.speed?.generation, undefined);
  });
});

test("missing reasoning corrections preserve exact usage and TPS, while explicit zero is authoritative after reload/pruning", async () => {
  for (const trimmed of [false, true]) await backend(async ({ path, send, restart }) => {
    await officialGeneration(send);
    if (trimmed) await send(completed("new", 0, 0, 2000));
    const totals = createTotalsStorage({ historyPath: path });
    const before = await totals.read();
    const historyBefore = await records(path);
    const restarted = await restart(2000);
    const incomplete = completed("m", 12, 0, 3000);
    await restarted({ ...incomplete, properties: { info: { ...incomplete.properties.info, tokens: { input: 1, output: 12 } } } });
    assert.deepEqual(await totals.read(), before);
    assert.deepEqual(await records(path), historyBefore);
    await restarted(completed("m", 12, 0, 3100));
    const after = await totals.read();
    assert.equal(after.sessions.s.tokens.output, 12);
    assert.equal(after.sessions.s.tokens.reasoning, 0);
    assert.equal(after.sessions.s.responseCount, trimmed ? 2 : 1);
    assert.equal(after.sessions.s.speed?.generation.durationMs, 1100);
    assert.equal(after.sessions.s.speed?.generation.generatedTokens, 6);
    assert.equal(after.sessions.s.speed?.generation.coverageGeneratedTokens, 12);
    assert.equal((await records(path))[0].tokens.reasoning, 0);
  }, undefined, 1);
});

test("recent created time cannot predate startup or disruption observation epoch", async () => {
  await backend(async ({ path, restart }) => {
    const send = await restart(1000);
    for (const [id, created, received, first, last] of [["before-startup", 900, 1100, 1200, 2300], ["current", 1000, 1100, 1200, 2300]] as const) {
      await send(started(id, created, received));
      await send({ type: "message.part.updated", timestamp: received, properties: { part: { id: `${id}-step`, messageID: id, sessionID: "s", type: "step-start" } } });
      await v3Deltas(send, id, first, last);
      await send(completed(id, 10, 0, 2500));
    }
    await send({ type: "workspace.status", timestamp: 5000, properties: { status: "reconnecting" } });
    await send(started("before-disruption", 4900, 5100));
    await send({ type: "message.part.updated", timestamp: 5100, properties: { part: { id: "after-step", messageID: "before-disruption", sessionID: "s", type: "step-start" } } });
    await v3Deltas(send, "before-disruption", 5200, 6300);
    await send(completed("before-disruption", 10, 0, 6500));
    const stored = await records(path);
    assert.equal(stored[0].speed?.generation, undefined);
    assert.equal(stored[1].speed?.generation?.durationMs, 1100);
    assert.equal(stored[2].speed?.generation, undefined);
    assert.ok(stored.every((record) => record.tokens.output === 10));
  });
});

test("v3 uses paired ingress clocks, excluding precontent wait and cleanup/tool tails", async () => {
  await backend(async ({ path, send }) => {
    await v3Start(send, "m");
    await send(thinking("m", 100, 200));
    await send({ type: "message.part.updated", timestamp: 200, properties: { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "" } } });
    await Promise.all([
      send({ ...delta("m", 300, "p", "hello"), receiveWall: 5000, receiveMono: 100,
        properties: { ...delta("m", 300, "p", "hello").properties, kind: "output" } }),
      send({ ...delta("m", 400, "p", "world"), receiveWall: 6100, receiveMono: 1200,
        properties: { ...delta("m", 400, "p", "world").properties, kind: "output" } }),
    ]);
    await send({ type: "message.part.updated", timestamp: 15000, properties: { part: {
      id: "p", messageID: "m", sessionID: "s", type: "text", text: "helloworld", time: { start: 250, end: 14000 } } } });
    await send(thinking("m", 100, 15000, { time: { start: 100, end: 14000 } }));
    await send({ type: "session.next.step.ended", timestamp: 18000, properties: { sessionID: "s", messageID: "m", stepID: "m-step" } });
    await send(completed("m", 10, 0, 20000));
    const [record] = await records(path);
    assert.equal(record.time.firstResponse, 100);
    assert.equal(record.time.firstContent, 5000);
    assert.equal(record.speed?.generation?.durationMs, 1100);
    assert.equal(record.speed?.generation?.generatedTokens, 5);
    assert.equal(record.speed?.generation?.coverageGeneratedTokens, 10);
    assert.equal(record.speed?.generationEvidence?.start, 5000);
    assert.equal(record.speed?.generationEvidence?.end, 6100);
    assert.equal(record.speed?.generationEvidence?.firstReceiveMono, 100);
    assert.equal(record.speed?.generationEvidence?.lastReceiveMono, 1200);
    assert.equal(record.speed?.generation?.estimated, true);
    assert.equal(record.speed?.response?.durationMs, 20000);
    await send({ type: "message.part.updated", timestamp: 25000, properties: { part: {
      id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", time: { start: 21000, end: 25000 } } } } });
    assert.deepEqual((await records(path))[0].speed, record.speed);
  });
});

test("same-message retry remains tainted after busy, correction and reload", async () => {
  await backend(async ({ path, send, restart }) => {
    await v3Start(send, "m");
    await send({ type: "session.status", timestamp: 50, properties: { sessionID: "s", status: { type: "retry" } } });
    await send({ type: "session.status", timestamp: 60, properties: { sessionID: "s", status: { type: "busy" } } });
    await v3Deltas(send, "m"); await send(completed("m", 10, 0, 1500));
    assert.equal((await records(path))[0].speed?.generation, undefined);
    await send(completed("m", 20, 0, 1600));
    await (await restart())(completed("m", 15, 0, 1700));
    const [record] = await records(path);
    assert.equal(record.tokens.output, 15);
    assert.equal(record.cost, 2);
    assert.equal(record.speed?.generation, undefined);
  });
});

test("v2 category calibration excludes the entire first receive batch and deduplicates event identity", async () => {
  await backend(async ({ path, send }) => {
    await v3Start(send, "m");
    for (const [timestamp, text, reasoning] of [[100, "abc", "xy"], [1200, "def", "uv"]] as const) {
      await send({ type: "session.next.text.delta", timestamp, eventID: `text-${timestamp}`, properties: { sessionID: "s", assistantMessageID: "m", textID: "text", delta: text } });
      await send({ type: "session.next.reasoning.delta", timestamp, eventID: `reason-${timestamp}`, properties: { sessionID: "s", assistantMessageID: "m", reasoningID: "reason", delta: reasoning } });
    }
    await send({ type: "session.next.text.delta", timestamp: 5000, eventID: "text-1200", properties: { sessionID: "s", assistantMessageID: "m", textID: "text", delta: "def" } });
    for (const [id, type, text] of [["text", "text", "abcdef"], ["reason", "reasoning", "xyuv"]] as const) await send({
      type: "message.part.updated", timestamp: 5100, properties: { part: { id, messageID: "m", sessionID: "s", type, text, time: { end: 5100 } } } });
    await send(completed("m", 10, 4, 6000));
    const [record] = await records(path);
    assert.equal(record.samples.length, 4);
    assert.equal(record.speed?.generation?.durationMs, 1100);
    assert.equal(record.speed?.generation?.generatedTokens, 7);
    assert.equal(record.speed?.generation?.coverageGeneratedTokens, 14);
    assert.equal(record.speed?.generationEvidence?.selectedStream, "v2");
    assert.equal(record.speed?.generationEvidence?.observationCount, 2);
    assert.equal(record.speed?.generationEvidence?.end, 1200);
  });
});

test("unknown retry binds one response, not the subsequent clean response", async () => {
  await backend(async ({ path, send }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "retry" } });
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    await v3Start(send, "retry"); await v3Deltas(send, "retry"); await send(completed("retry", 10, 0, 1500));
    await v3Start(send, "clean"); await v3Deltas(send, "clean"); await send(completed("clean", 10, 0, 1500));
    const stored = await records(path);
    assert.equal(stored[0].speed?.generation, undefined);
    assert.equal(stored[1].speed?.generation?.durationMs, 1100);
  });
});

test("step identities deduplicate repeats, while distinct steps invalidate and usage replaces", async () => {
  await backend(async ({ path, send }) => {
    await v3Start(send, "m"); await v3Deltas(send, "m");
    for (const timestamp of [1300, 1350]) await send({ type: "session.next.step.ended", timestamp, properties: {
      sessionID: "s", messageID: "m", stepID: "m-step", tokens: { input: 1, output: 10, reasoning: 0 }, cost: 1 } });
    await send(completed("m", 10, 0, 1500));
    assert.equal((await records(path))[0].speed?.generation?.durationMs, 1100);
  });
  await backend(async ({ path, send }) => {
    await v3Start(send, "m"); await v3Deltas(send, "m");
    for (const [stepID, output] of [["m-step", 10], ["second", 20]] as const) await send({ type: "session.next.step.ended", timestamp: 1400, properties: {
      sessionID: "s", messageID: "m", stepID, tokens: { input: 1, output, reasoning: 0 }, cost: output / 10 } });
    const final = completed("m", 0, 0, 1500);
    await send({ ...final, properties: { info: { ...final.properties.info, tokens: { input: 1 }, cost: undefined } } });
    const [record] = await records(path);
    assert.equal(record.tokens.output, 20);
    assert.equal(record.cost, 2);
    assert.equal(record.speed?.generation, undefined);
  });
});

test("complete snapshots cannot supply missing, historic or already-in-progress response ownership", async () => {
  for (const ownership of ["missing", "historic", "in-progress"]) await backend(async ({ path, send }) => {
    if (ownership === "historic") await send(started("m", 0, 5000));
    if (ownership === "in-progress") {
      const event = started("m");
      await send({ ...event, properties: { info: { ...event.properties.info, status: "in_progress", tokens: { output: 1 } } } });
    }
    await send({ type: "session.next.step.started", timestamp: 5000, properties: { sessionID: "s", messageID: "m", stepID: "m-step" } });
    await v3Deltas(send, "m", 5100, 6200); await send(completed("m", 10, 0, 6500));
    const [record] = await records(path);
    assert.equal(record.tokens.output, 10);
    assert.equal(record.speed?.generation, undefined);
  });
});

test("v2 failures and known transport boundaries taint active messages without losing usage", async () => {
  for (const type of ["session.next.retried", "session.next.failed", "session.error", "provider.error", "workspace.status", "server.connected"]) {
    await backend(async ({ path, send }) => {
      if (type === "server.connected") await send({ type, timestamp: 0, properties: {} });
      await v3Start(send, "m");
      await send({ type, timestamp: 50, properties: { sessionID: "s", messageID: "m", status: "reconnecting" } });
      await v3Deltas(send, "m"); await send(completed("m", 10, 0, 1500));
      const [record] = await records(path);
      assert.equal(record.tokens.output, 10, type);
      assert.equal(record.speed?.generation, undefined, type);
    });
  }
});

function legacy(id: string, time: any = { start: 0, completed: 1000 }): HistoryRecord {
  return { version: 1, messageID: id, sessionID: "s", tokens: { input: 1, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 2, quality: "exact", time, samples: [] };
}
test("server v3 migration preserves legacy usage across replay/restart/pruning without reconstructing speed", async () => {
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
    assert.equal(after.sessions.s.speed?.response.responseCount, 1);
    assert.equal(after.sessions.s.speed?.generation.responseCount, 0);
  }, [legacy("good"), legacy("missing", { completed: 1000 })], 1);
});
