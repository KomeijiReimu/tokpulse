import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { recordPartMetadata, server } from "../src/server.js";
import { ActivityLedger } from "../src/runs-storage.js";
import { getSessionAverageSummary } from "../src/statistics.js";

async function readRecords(historyPath: string): Promise<any[]> {
  const content = await readFile(historyPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readTotals(historyPath: string): Promise<any> {
  return JSON.parse(await readFile(join(dirname(historyPath), "totals.json"), "utf8"));
}

async function backendCase(run: (context: { path: string; send: (event: any) => Promise<void>; restart: () => Promise<(event: any) => Promise<void>> }) => Promise<void>, maxRecords = 1000): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-backend-p1-"));
  const path = join(directory, "history.jsonl");
  const input = { directory, worktree: directory } as unknown as PluginInput;
  const restart = async () => {
    const hooks = await server(input, { historyPath: path, maxRecords });
    return async (event: any) => { await hooks.event!({ event }); };
  };
  try { await run({ path, send: await restart(), restart }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function completionFact(id: string, output: number, reasoning: number, start: number, end: number) {
  return { type: "message.updated", timestamp: end, properties: { info: {
    id, sessionID: "s", role: "assistant", tokens: { input: 1, output, reasoning }, cost: output,
    time: { created: start, completed: end },
  } } };
}
function snapshotFact(id: string, messageID: string, type: string, end?: number, text = "", start?: number) {
  return { type: "message.part.updated", timestamp: end ?? 10, properties: { part: {
    id, messageID, sessionID: "s", type, text,
    ...(start !== undefined || end !== undefined ? { time: { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) } } : {}),
  } } };
}
async function textGeneration(send: (event: any) => Promise<void>, messageID: string) {
  await send(snapshotFact(`${messageID}-p`, messageID, "text", undefined, "", 100));
  await send({ type: "message.part.delta", timestamp: 100, properties: { sessionID: "s", messageID, partID: `${messageID}-p`, field: "text", delta: "hello" } });
  await send(snapshotFact(`${messageID}-p`, messageID, "text", 200, "hello", 100));
  await send(completionFact(messageID, 10, 0, 0, 300));
}

test("authoritative corrections accept zero, smaller usage and shorter duration; known replay cannot revert", async () => {
  await backendCase(async ({ path, send, restart }) => {
    const original = completionFact("m", 10, 0, 0, 100);
    await send(original);
    await send(completionFact("m", 0, 0, 0, 200));
    assert.equal((await readRecords(path))[0].tokens.output, 0);
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 0);
    await send(completionFact("m", 8, 0, 0, 300));
    await send(completionFact("m", 2, 0, 250, 300));
    assert.equal((await readRecords(path))[0].time.duration, 50);
    await send(original);
    await (await restart())(original);
    const [record] = await readRecords(path);
    const totals = await readTotals(path);
    assert.equal(record.tokens.output, 2);
    assert.equal(totals.sessions.s.tokens.output, 2);
    assert.equal(totals.sessions.s.speed.response.durationMs, 50);
    assert.equal(totals.sessions.s.responseCount, 1);
  });
});
test("trimmed completion replay and restart preserve settled generation evidence", async () => {
  await backendCase(async ({ path, send, restart }) => {
    await textGeneration(send, "m");
    await send(completionFact("new", 0, 0, 300, 400));
    const before = await readTotals(path);
    assert.equal(before.settled.m.speed.generation.durationMs, 100);
    assert.equal(before.settled.m.speed.generationEvidence.start, 100);
    await send(completionFact("m", 10, 0, 0, 300));
    await (await restart())(completionFact("m", 10, 0, 0, 300));
    assert.deepEqual(await readTotals(path), before);
    assert.equal((await readRecords(path))[0].messageID, "new");
  }, 1);
});

for (const trimmed of [false, true]) {
  test(`${trimmed ? "settled" : "retained"} exact completion rejects partial live usage before and after restart, but accepts exact zero`, async () => {
    await backendCase(async ({ path, send, restart }) => {
      await textGeneration(send, "m");
      if (trimmed) await send(completionFact("new", 20, 0, 300, 400));
      const before = await readTotals(path);
      const historyBefore = await readRecords(path);
      const coverageBefore = getSessionAverageSummary(before.sessions.s);
      const expectedCount = trimmed ? 2 : 1;
      assert.equal(before.sessions.s.tokens.output, trimmed ? 30 : 10);
      assert.equal(before.sessions.s.responseCount, expectedCount);
      assert.equal(coverageBefore.generation.coveredResponseCount, 1);
      assert.equal(coverageBefore.response.coveredResponseCount, expectedCount);
      assert.equal((trimmed ? before.settled.m : before.open.m).quality, "exact");

      await send(assistantCompleted("m", { input: 1 }, 500, 0, "s"));
      assert.deepEqual(await readRecords(path), historyBefore);
      assert.deepEqual(await readTotals(path), before);
      const restarted = await restart();
      await restarted(assistantCompleted("m", { input: 1 }, 600, 0, "s"));
      const after = await readTotals(path);
      assert.deepEqual(await readRecords(path), historyBefore);
      assert.deepEqual(after, before);
      assert.deepEqual(after.sessions.s.tokens, before.sessions.s.tokens);
      assert.deepEqual(after.sessions.s.speed, before.sessions.s.speed);
      assert.equal(after.sessions.s.responseCount, expectedCount);
      assert.deepEqual(getSessionAverageSummary(after.sessions.s), coverageBefore);

      // Explicit complete zero usage is an authoritative correction, not partial data.
      await restarted(completionFact("m", 0, 0, 0, 700));
      const corrected = await readTotals(path);
      assert.equal(corrected.sessions.s.tokens.output, trimmed ? 20 : 0);
      assert.equal(corrected.sessions.s.tokens.reasoning, 0);
      assert.equal(corrected.sessions.s.responseCount, expectedCount);
      assert.equal(corrected.sessions.s.speed.generation.generatedTokens, 0);
      assert.equal(corrected.sessions.s.speed.generation.durationMs, 100);
      assert.equal(corrected.sessions.s.speed.generation.responseCount, 1);
      assert.equal(corrected.sessions.s.speed.response.generatedTokens, trimmed ? 20 : 0);
      assert.equal(corrected.sessions.s.speed.response.durationMs, trimmed ? 800 : 700);
      assert.equal(corrected.sessions.s.speed.response.responseCount, expectedCount);
      const records = await readRecords(path);
      assert.equal(records.length, 1);
      assert.equal(records[0].messageID, "m");
      assert.equal(records[0].quality, "exact");
      assert.equal(records[0].tokens.output, 0);
    }, 1);
  });
}

test("hidden reasoning correction and incompatible response times invalidate old generation", async () => {
  await backendCase(async ({ path, send }) => {
    await textGeneration(send, "hidden");
    await textGeneration(send, "timing");
    assert.equal((await readTotals(path)).sessions.s.speed.generation.responseCount, 2);
    await send(completionFact("hidden", 10, 100, 0, 300));
    await send(completionFact("timing", 10, 0, 150, 180));
    assert.ok((await readRecords(path)).every((r) => r.speed.generation === undefined));
    const totals = await readTotals(path);
    assert.equal(totals.sessions.s.speed.generation.responseCount, 0);
    assert.equal(totals.sessions.s.speed.response.generatedTokens, 120);
    assert.equal(totals.sessions.s.responseCount, 2);
  });
});
test("real legacy reasoning metadata classifies field:text without kind and calibrates final usage", async () => {
  await backendCase(async ({ path, send }) => {
    await send(snapshotFact("p", "m", "reasoning", undefined, "", 100));
    await send({ type: "message.part.delta", timestamp: 100, properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "think" } });
    await send(snapshotFact("p", "m", "reasoning", 200, "think", 100));
    await send(completionFact("m", 0, 100, 0, 300));
    const [record] = await readRecords(path);
    assert.equal(record.samples[0].kind, "reasoning");
    assert.equal(record.samples.reduce((sum: number, sample: any) => sum + sample.tokens, 0), 100);
    assert.equal(record.time.firstToken, 100);
    assert.equal(record.speed.generation.durationMs, 100);
  });
});
test("snapshot-only entry point never rebuilds active and known user deltas cannot generate", async () => {
  const active = new Map();
  recordPartMetadata(active, snapshotFact("p", "completed", "text", 200).properties);
  recordPartMetadata(active, { part: { id: "tool", messageID: "completed", sessionID: "s", type: "tool", state: { status: "completed", time: { end: 1000 } } } });
  recordPartMetadata(active, snapshotFact("user-p", "user", "text").properties);
  assert.equal(active.size, 0);
  await backendCase(async ({ path, send }) => {
    await send(completionFact("completed", 10, 0, 0, 300));
    const before = await readTotals(path);
    await send(snapshotFact("p", "completed", "text", 200));
    await send({ type: "message.part.updated", properties: { part: { id: "tool", messageID: "completed", sessionID: "s", type: "tool", state: { status: "completed", time: { end: 1000 } } } } });
    await send({ type: "message.updated", properties: { info: { id: "user", sessionID: "s", role: "user" } } });
    await send(snapshotFact("user-p", "user", "text"));
    await send({ type: "message.part.delta", timestamp: 400, properties: { sessionID: "s", messageID: "user", partID: "user-p", field: "text", delta: "user text" } });
    await send({ type: "session.idle", timestamp: 1000, properties: { sessionID: "s" } });
    assert.deepEqual(await readTotals(path), before);
    assert.equal((await readRecords(path)).length, 1);
  });
});
test("real v2 IDs associate complete content metadata, but tool-input coverage still downgrades generation", async () => {
  await backendCase(async ({ path, send }) => {
    await send({ type: "session.next.text.delta", timestamp: 100, properties: { sessionID: "s", assistantMessageID: "m", textID: "text", delta: "hello" } });
    await send({ type: "session.next.reasoning.delta", timestamp: 150, properties: { sessionID: "s", assistantMessageID: "m", reasoningID: "reason", delta: "think" } });
    await send({ type: "session.next.tool.input.delta", timestamp: 200, properties: { sessionID: "s", assistantMessageID: "m", callID: "call", delta: "{}" } });
    await send(snapshotFact("text", "m", "text", 190, "hello", 100));
    await send(snapshotFact("reason", "m", "reasoning", 180, "think", 150));
    await send({ type: "message.part.updated", timestamp: 250, properties: { part: { id: "tool-part", callID: "call", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 250 } } } } });
    await send(completionFact("m", 10, 5, 0, 1000));
    const [record] = await readRecords(path);
    assert.equal(record.samples.length, 3);
    assert.equal(record.samples.filter((s: any) => s.kind === "reasoning").reduce((sum: number, s: any) => sum + s.tokens, 0), 5);
    assert.equal(record.speed.generation, undefined);
    assert.equal(record.speed.generationEvidence, undefined);
    assert.equal(record.speed.response.durationMs, 1000);
    assert.equal((await readTotals(path)).sessions.s.speed.generation.responseCount, 0);
  });
});
test("explicit envelope revisions reject stale updates and permit a genuinely newer return to old facts", async () => {
  await backendCase(async ({ path, send }) => {
    await send({ ...completionFact("m", 10, 0, 0, 100), revision: 1 });
    await send({ ...completionFact("m", 0, 0, 0, 200), revision: 3 });
    await send({ ...completionFact("m", 5, 0, 0, 300), revision: 2 });
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 0);
    await send({ ...completionFact("m", 10, 0, 0, 100), revision: 4 });
    assert.equal((await readRecords(path))[0].tokens.output, 10);
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 10);
    assert.equal((await readTotals(path)).sessions.s.responseCount, 1);
  });
});
test("server restart replay cannot backfill or double-add a legacy settled true marker", async () => {
  await backendCase(async ({ path, send, restart }) => {
    await textGeneration(send, "m");
    await send(completionFact("new", 0, 0, 300, 400));
    const ledger = await readTotals(path);
    ledger.settled.m = true;
    await writeFile(join(dirname(path), "totals.json"), JSON.stringify(ledger));
    const restarted = await restart();
    await restarted(completionFact("m", 100, 0, 0, 300));
    await restarted(completionFact("m", 100, 0, 0, 300));
    assert.deepEqual(await readTotals(path), ledger);
  }, 1);
});

function assistantCompleted(
  messageID: string,
  tokens: { input?: number; output?: number; reasoning?: number },
  timestamp: number,
  cost = 1,
  sessionID = "session",
) {
  return {
    type: "message.updated",
    timestamp,
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        cost,
        time: { created: Math.max(0, timestamp - 50), completed: timestamp },
        tokens,
      },
    },
  };
}

test("known snapshot gap and uncertain tool input downgrade generation without sampling snapshots or tool output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-content-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    const send = async (type: string, timestamp: number, properties: any) => hooks.event!({ event: { type, timestamp, properties } as never });
    await send("message.part.updated", 10, { part: { id: "text", messageID: "m", sessionID: "s", type: "text", text: "old snapshot", time: { start: 300 } } });
    await send("session.next.text.delta", 300, { sessionID: "s", assistantMessageID: "m", partID: "text", delta: "hi" });
    await send("message.part.delta", 100, { sessionID: "s", messageID: "m", partID: "reason", kind: "reasoning", field: "text", delta: "think" });
    await send("session.next.tool.input.delta", 400, { sessionID: "s", assistantMessageID: "m", partID: "tool", delta: "{}" });
    await send("message.part.updated", 500, { part: { id: "reason", messageID: "m", sessionID: "s", type: "reasoning", text: "think", time: { start: 100, end: 200 } } });
    await send("message.part.updated", 510, { part: { id: "text", messageID: "m", sessionID: "s", type: "text", text: "hi", time: { start: 300, end: 350 } } });
    await send("message.part.updated", 520, { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 450 } } } });
    await send("message.part.delta", 600, { sessionID: "s", messageID: "m", partID: "tool", field: "output", delta: "tool result must not count" });
    await send("message.part.updated", 950, { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", time: { start: 450, end: 900 } } } });
    const info = { id: "m", sessionID: "s", role: "assistant", tokens: { input: 10, output: 20, reasoning: 5 }, time: { created: 0, firstToken: 300, completed: 1000 } };
    await send("message.updated", 1000, { info });
    let records = await readRecords(historyPath);
    assert.equal(records[0].time.firstToken, 100);
    assert.equal(records[0].time.ttft, 100);
    assert.equal(records[0].samples.length, 2); // v2 final priority, no snapshot/result duplication
    assert.equal(records[0].speed.generation, undefined);
    assert.equal(records[0].speed.generationEvidence, undefined);
    assert.equal(records[0].speed.response.durationMs, 1000);
    await send("message.updated", 1200, { info: { ...info, time: { created: 0, firstToken: 300, completed: 1200 } } });
    records = await readRecords(historyPath);
    assert.equal(records[0].time.firstToken, 100);
    assert.equal(records[0].speed.response.durationMs, 1200);
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.s.responseCount, 1);
    assert.equal(totals.sessions.s.speed.response.durationMs, 1200);
    assert.equal(totals.sessions.s.speed.generation.responseCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unknown multistep usage is not summed and missing final usage is provisional", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-steps-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    for (const output of [10, 20]) await hooks.event!({ event: { type: "session.next.step.ended", timestamp: output,
      properties: { sessionID: "s", assistantMessageID: "m", tokens: { input: 5, output, reasoning: 0 } } } as never });
    await hooks.event!({ event: { type: "message.updated", timestamp: 100, properties: { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 0, completed: 100 } } } } as never });
    const [record] = await readRecords(historyPath);
    assert.equal(record.tokens.output, 20);
    assert.equal(record.quality, "provisional");
    assert.equal(record.speed.response.estimated, true);
    assert.equal(record.speed.generation, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cumulative direct speed outlives the retained history window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-speed-window-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath, maxRecords: 1 });
    await hooks.event!({ event: assistantCompleted("old", { input: 1, output: 10, reasoning: 0 }, 100) as never });
    await hooks.event!({ event: assistantCompleted("new", { input: 1, output: 30, reasoning: 0 }, 200) as never });
    assert.equal((await readRecords(historyPath)).length, 1);
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.speed.response.generatedTokens, 40);
    assert.equal(totals.sessions.session.speed.response.durationMs, 100);
    assert.equal(totals.sessions.session.speed.response.responseCount, 2);
    assert.equal(totals.settled.old.speed.response.generatedTokens, 10);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("tool-only snapshots have no invented first output or generation interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-tool-only-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    await hooks.event!({ event: { type: "message.part.updated", timestamp: 100, properties: { part: {
      id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", input: { command: "echo hi" }, time: { start: 100 } },
    } } } as never });
    await hooks.event!({ event: { type: "session.next.tool.result", timestamp: 800, properties: { sessionID: "s", assistantMessageID: "m", delta: "result" } } as never });
    await hooks.event!({ event: assistantCompleted("m", { input: 1, output: 10, reasoning: 0 }, 1000, 0, "s") as never });
    const [record] = await readRecords(historyPath);
    assert.equal(record.time.firstToken, undefined);
    assert.equal(record.samples.length, 0);
    assert.equal(record.speed.generation, undefined);
    assert.equal(record.speed.response.durationMs, 50);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function readRunEvents(runsPath: string): Promise<any[]> {
  return new ActivityLedger(runsPath).read({ dedupe: false });
}

test("final usage supersedes fallback cache counts, preserves output zero, and deduplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, {
      historyPath,
    });
    assert.ok(hooks.event);

    const stepEnded = {
      type: "session.next.step.ended",
      timestamp: 100,
      properties: {
        sessionID: "session",
        assistantMessageID: "message",
        cost: 1,
        tokens: {
          input: 12,
          output: 8,
          reasoning: 3,
          cache: { read: 7, write: 11 },
        },
      },
    };
    const partialStepEnded = {
      type: "session.next.step.ended",
      timestamp: 110,
      properties: {
        sessionID: "session",
        assistantMessageID: "message",
        tokens: { cache: { read: 9 } },
      },
    };
    const completed = {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "message",
          sessionID: "session",
          role: "assistant",
          cost: 1,
          time: { created: 0, completed: 200 },
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    };

    await Promise.all([
      hooks.event({ event: stepEnded as never }),
      hooks.event({ event: partialStepEnded as never }),
      hooks.event({ event: completed as never }),
      hooks.event({ event: completed as never }),
    ]);

    const records = await readRecords(historyPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tokens, {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.equal(records[0].quality, "exact");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late fallback after exact completion is ignored before idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const exact = {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "exact-first",
          sessionID: "session",
          role: "assistant",
          cost: 2,
          time: { created: 0, completed: 200 },
          tokens: { input: 5, output: 6, reasoning: 1, cache: { read: 7, write: 8 } },
        },
      },
    };
    const lateFallback = {
      type: "session.next.step.ended",
      timestamp: 210,
      properties: {
        sessionID: "session",
        assistantMessageID: "exact-first",
        tokens: { input: 50, output: 60, reasoning: 10, cache: { read: 70, write: 80 } },
      },
    };
    const idle = {
      type: "session.idle",
      timestamp: 300,
      properties: { sessionID: "session" },
    };
    await hooks.event({ event: exact as never });
    await hooks.event({ event: lateFallback as never });
    await hooks.event({ event: idle as never });
    const records = await readRecords(historyPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tokens, {
      input: 5,
      output: 6,
      reasoning: 1,
      cacheRead: 7,
      cacheWrite: 8,
    });
    assert.equal(records[0].quality, "exact");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fallback then exact completion remains one exact record through duplicate events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const fallback = {
      type: "session.next.step.ended",
      timestamp: 100,
      properties: {
        sessionID: "session",
        assistantMessageID: "fallback-first",
        tokens: { input: 50, output: 60, reasoning: 10, cache: { read: 70, write: 80 } },
      },
    };
    const exact = {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "fallback-first",
          sessionID: "session",
          role: "assistant",
          cost: 2,
          time: { created: 0, completed: 200 },
          tokens: { input: 5, output: 6, reasoning: 1, cache: { read: 7, write: 8 } },
        },
      },
    };
    await hooks.event({ event: fallback as never });
    await hooks.event({ event: exact as never });
    await hooks.event({ event: fallback as never });
    await hooks.event({ event: exact as never });
    await hooks.event({ event: { type: "session.idle", timestamp: 300, properties: { sessionID: "session" } } as never });
    const records = await readRecords(historyPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tokens, {
      input: 5,
      output: 6,
      reasoning: 1,
      cacheRead: 7,
      cacheWrite: 8,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle flush persists a provisional quality marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "idle-fallback", delta: "hello" },
    } as never });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });
    const records = await readRecords(historyPath);
    assert.equal(records[0]?.quality, "provisional");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session status lifecycle events persist and replay active duration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: { type: "session.status", timestamp: 100, properties: { sessionID: "session", status: "busy" } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 200, properties: { sessionID: "session", status: { type: "retry" } } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 300, properties: { sessionID: "session", status: "idle" } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 400, properties: { sessionID: "session", status: "busy" } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 500, properties: { sessionID: "session", status: "failed" } } as never });

    const events = await readRunEvents(runsPath);
    assert.deepEqual(events.map((event) => event.state), ["busy", "retry", "idle", "busy", "failed"]);
    assert.equal((await new ActivityLedger(runsPath).replay()).rootActiveMilliseconds.session, 300);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parent facts are persisted and root replay unions child overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 0,
      properties: { sessionID: "root", status: "busy" },
    } as never });
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 50,
      properties: { sessionID: "child", parentSessionID: "root", status: "busy" },
    } as never });
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 150,
      properties: { sessionID: "child", status: "idle" },
    } as never });
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 200,
      properties: { sessionID: "root", status: "idle" },
    } as never });

    const replay = await new ActivityLedger(runsPath).replay();
    const root = replay.roots.find((entry) => entry.rootSessionID === "root");
    assert.ok(root);
    assert.equal(root.activeMilliseconds, 200);
    assert.equal(replay.parentBySessionID.get("child"), "root");
    assert.equal((await readRunEvents(runsPath)).filter((event) => event.kind === "parent").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate lifecycle delivery is stable while conflicting facts remain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const busy = {
      type: "session.status",
      eventId: "source-event",
      timestamp: 100,
      properties: { sessionID: "session", status: "busy" },
    };
    await hooks.event({ event: busy as never });
    await hooks.event({ event: { ...busy } as never });
    await hooks.event({ event: {
      ...busy,
      timestamp: 200,
      properties: { sessionID: "session", status: "idle" },
    } as never });

    const events = await readRunEvents(runsPath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventID, events[1]?.eventID);
    assert.equal(events[0]?.seq, 1);
    assert.equal(events[1]?.seq, 2);
    assert.deepEqual(events.map((event) => event.state), ["busy", "idle"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initializing a new instance recovers old open activity at its last event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const first = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(first.event);
    await first.event({ event: {
      type: "session.status",
      timestamp: 1234,
      properties: { sessionID: "session", status: "busy" },
    } as never });
    await first.event({ event: {
      type: "session.status",
      timestamp: 1500,
      properties: { sessionID: "session", status: "retry" },
    } as never });

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    const afterRecovery = await readRunEvents(runsPath);
    assert.equal(afterRecovery.length, 3);
    assert.equal(afterRecovery[2]?.state, "stopped");
    assert.equal(afterRecovery[2]?.timestamp, 1500);
    assert.equal(afterRecovery[2]?.instanceEndedAt, 1500);
    assert.equal((await new ActivityLedger(runsPath).replay()).rootActiveMilliseconds.session, 266);

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.equal((await readRunEvents(runsPath)).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical v2 retry and step failure lifecycle events are recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "message", delta: "hello" },
    } as never });
    await hooks.event({ event: {
      type: "session.next.retried",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });
    await hooks.event({ event: {
      type: "session.next.step.failed",
      timestamp: 300,
      properties: { sessionID: "session" },
    } as never });

    const events = await readRunEvents(runsPath);
    assert.deepEqual(events.map((event) => event.state), ["retry", "failed"]);
    assert.equal((await new ActivityLedger(runsPath).replay()).rootActiveMilliseconds.session, 100);
    assert.equal((await readRecords(historyPath))[0]?.quality, "provisional");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never-resolving parent lookup times out without blocking later events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    let lookupCalls = 0;
    const never = new Promise<never>(() => undefined);
    const hooks = await server({
      directory,
      worktree: directory,
      client: { session: { get: () => {
        lookupCalls += 1;
        return never;
      } } },
    } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const completed = hooks.event({ event: {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "message",
          sessionID: "child",
          role: "assistant",
          time: { created: 100, completed: 200 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });
    const completedWithinBound = await Promise.race([
      completed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(completedWithinBound, true);

    const later = hooks.event({ event: {
      type: "session.status",
      timestamp: 300,
      properties: { sessionID: "later", status: "busy" },
    } as never });
    const laterWithinBound = await Promise.race([
      later.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(laterWithinBound, true);
    assert.equal((await readRecords(historyPath)).length, 1);
    assert.deepEqual((await readRunEvents(runsPath)).map((event) => event.state), ["busy"]);
    assert.equal(lookupCalls, 1);
    assert.equal(warnings.some((args) => String(args[0]).includes("parent lookup")), false);

    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 400,
      properties: {
        info: {
          id: "message-2",
          sessionID: "child",
          role: "assistant",
          time: { created: 300, completed: 400 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });
    assert.equal(lookupCalls, 1);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runsPath may be explicit and otherwise follows historyPath", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "nested", "history.jsonl");
  const explicitRunsPath = join(directory, "custom", "activity.jsonl");
  try {
    const explicit = await server({ directory, worktree: directory } as unknown as PluginInput, {
      historyPath,
      runsPath: explicitRunsPath,
    });
    assert.ok(explicit.event);
    await explicit.event({ event: { type: "session.idle", timestamp: 1, properties: { sessionID: "explicit" } } as never });
    assert.equal((await readRunEvents(explicitRunsPath)).length, 1);

    const defaultHistoryPath = join(directory, "default", "history.jsonl");
    const defaults = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath: defaultHistoryPath });
    assert.ok(defaults.event);
    await defaults.event({ event: { type: "session.idle", timestamp: 2, properties: { sessionID: "default" } } as never });
    assert.equal((await readRunEvents(join(directory, "default", "runs.jsonl"))).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed response parent lookup is supplemental and persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    let lookupCalls = 0;
    const sessionClient = {
      get: async (request: unknown) => {
        lookupCalls += 1;
        assert.deepEqual(request, { path: { id: "child" } });
        return { data: { parentID: "root" } };
      },
    };
    const hooks = await server({
      directory,
      worktree: directory,
      client: { session: sessionClient },
    } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "message",
          sessionID: "child",
          parentID: "message-parent-only",
          role: "assistant",
          time: { created: 100, completed: 200 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });

    const parentEvents = (await readRunEvents(runsPath)).filter((event) => event.kind === "parent");
    assert.equal(parentEvents.length, 1);
    assert.equal(parentEvents[0]?.parentSessionID, "root");
    assert.equal((await readRecords(historyPath))[0]?.parentSessionID, "root");
    assert.equal(lookupCalls, 1);

    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 400,
      properties: {
        info: {
          id: "message-2",
          sessionID: "child",
          role: "assistant",
          time: { created: 300, completed: 400 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });
    assert.equal(lookupCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed message writes direct usage into the sibling totals ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("message", {
      input: 4,
      output: 5,
      reasoning: 1,
    }, 200, 3) as never });

    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.equal(totals.sessions.session.cost, 3);
    assert.deepEqual(totals.sessions.session.tokens, {
      input: 4,
      output: 5,
      reasoning: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual((await readRecords(historyPath))[0]?.tokens, totals.sessions.session.tokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second completion accumulates and a repeated message.updated does not double count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const second = assistantCompleted("second", { input: 3, output: 1 }, 300, 2);
    await hooks.event({ event: assistantCompleted("first", { input: 4, output: 5 }, 200, 3) as never });
    await hooks.event({ event: second as never });

    const accumulated = await readTotals(historyPath);
    assert.equal(accumulated.sessions.session.responseCount, 2);
    assert.equal(accumulated.sessions.session.cost, 5);
    assert.deepEqual(accumulated.sessions.session.tokens, {
      input: 7,
      output: 6,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });

    await hooks.event({ event: second as never });
    const repeated = await readTotals(historyPath);
    assert.equal(repeated.sessions.session.responseCount, 2);
    assert.deepEqual(repeated.sessions.session.tokens, accumulated.sessions.session.tokens);
    assert.equal(repeated.sessions.session.cost, accumulated.sessions.session.cost);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("history window eviction keeps settled usage in the cumulative ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, {
      historyPath,
      maxRecords: 2,
    });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("m1", { input: 10 }, 100, 1) as never });
    await hooks.event({ event: assistantCompleted("m2", { input: 20 }, 200, 1) as never });
    await hooks.event({ event: assistantCompleted("m3", { input: 40 }, 300, 1) as never });

    const records = await readRecords(historyPath);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.messageID), ["m2", "m3"]);
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 3);
    assert.equal(totals.sessions.session.tokens.input, 70);
    assert.equal(totals.sessions.session.cost, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening another server on the same directory does not change totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("message", { input: 4, output: 5 }, 200, 3) as never });
    const before = await readTotals(historyPath);

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    const after = await readTotals(historyPath);
    assert.deepEqual(after.sessions, before.sessions);
    assert.deepEqual(after.open, before.open);
    assert.deepEqual(after.settled, before.settled);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an idle provisional replaced by a smaller exact is not added twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "idle-fallback", delta: "x".repeat(55) },
    } as never });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });

    const provisionalHistory = await readRecords(historyPath);
    assert.equal(provisionalHistory[0]?.quality, "provisional");
    const provisional = await readTotals(historyPath);
    assert.equal(provisional.sessions.session.responseCount, 1);
    assert.ok(provisional.sessions.session.tokens.output > 3);

    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 300,
      properties: {
        info: {
          id: "idle-fallback",
          sessionID: "session",
          role: "assistant",
          cost: 1,
          time: { created: 100, completed: 300 },
          tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
        },
      },
    } as never });

    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.equal(totals.sessions.session.cost, 1);
    assert.deepEqual(totals.sessions.session.tokens, {
      input: 2,
      output: 3,
      reasoning: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const history = await readRecords(historyPath);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.quality, "exact");
    assert.deepEqual(history[0]?.tokens, totals.sessions.session.tokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt totals file is quarantined and rebuilt from the history window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("message", { input: 4, output: 5 }, 200, 3) as never });
    await writeFile(join(directory, "totals.json"), "{not-json", "utf8");

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });

    const quarantined = (await readdir(directory)).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0] ?? "", /^totals\.json\.corrupt-\d+/);
    assert.equal(await readFile(join(directory, quarantined[0] ?? ""), "utf8"), "{not-json");
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.tokens.input, 4);
    assert.equal(totals.sessions.session.tokens.output, 5);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.equal(totals.sessions.session.cost, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an idle totals write failure keeps the active state for a later retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await rm(totalsPath);
    await mkdir(totalsPath);

    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "idle-retry", delta: "x".repeat(55) },
    } as never });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });

    const provisional = await readRecords(historyPath);
    assert.equal(provisional.length, 1);
    assert.equal(provisional[0]?.quality, "provisional");

    await rm(totalsPath, { recursive: true, force: true });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 300,
      properties: { sessionID: "session" },
    } as never });

    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.ok(totals.sessions.session.tokens.output > 0);
    assert.equal((await readRecords(historyPath)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
