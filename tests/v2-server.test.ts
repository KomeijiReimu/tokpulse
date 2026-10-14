import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { SessionStepStarted, SessionStepEnded, SessionStepFailed, SessionCreated,
  SessionExecutionFailed, SessionExecutionInterrupted } from "@opencode/client";
import plugin from "../src/server.js";
import { createV2EventAdapter, readV2Idle, type V2ServerContext } from "../src/v2-server.js";
import { ActivityLedger } from "../src/runs-storage.js";
import { replayActivity } from "../src/activity.js";

// Step fixtures are checked against @opencode/client 2.0.27, including
// event.data/created/durable.seq, Model.Ref.id, assistantMessageID and
// TokenUsage.Info.cache. The fake session domain returns direct get results.
const tokens = { input: 12, output: 7, reasoning: 3, cache: { read: 9, write: 2 } };
const model = { providerID: "fixture", id: "fixture-model" } satisfies SessionStepStarted["data"]["model"];

type StepEnvelope = Pick<SessionStepStarted, "id" | "created" | "durable" | "location">;
const stepStarted = (envelope: StepEnvelope, data: SessionStepStarted["data"]) =>
  ({ ...envelope, type: "session.step.started", data } satisfies SessionStepStarted);
const stepEnded = (envelope: StepEnvelope, data: SessionStepEnded["data"]) =>
  ({ ...envelope, type: "session.step.ended", data } satisfies SessionStepEnded);
type Send = <Type extends string>(type: Type,
  data: Type extends "session.step.started" ? SessionStepStarted["data"]
    : Type extends "session.step.ended" ? SessionStepEnded["data"]
    : Type extends "session.step.failed" ? SessionStepFailed["data"]
    : Type extends "session.execution.failed" ? SessionExecutionFailed["data"]
    : Type extends "session.execution.interrupted" ? SessionExecutionInterrupted["data"] : Record<string, any>,
  offset: number, extra?: Partial<StepEnvelope>) => Promise<void>;
interface FixtureContext {
  directory: string;
  path: string;
  base: number;
  send: Send;
  read: () => Promise<any>;
  calls: any[];
  cleanup: () => Promise<void>;
  restart: () => Promise<void>;
  signal: () => AbortSignal;
  returned: () => boolean;
}

async function fixture(run: (ctx: FixtureContext) => Promise<void>, getSession?: (id: string, directory: string) => any) {
  const root = join(process.env.HOME!, ".cache", "tokpulse-server-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "v2-"));
  const path = join(directory, "history.jsonl");
  const items: Array<{ event: any; done: () => void }> = [];
  let wake: (() => void) | undefined;
  let subscriptionSignal: AbortSignal | undefined;
  let returned = false;
  let seq = 0;
  const calls: any[] = [];
  const ctx = {
    location: { directory, project: { id: "project", directory, canonical: directory } },
    options: { historyPath: path, maxRecords: 1 },
    session: {
      async get(parameters: any, options: any) {
        assert.deepEqual(Object.keys(parameters), ["sessionID"]);
        assert.ok(options.signal instanceof AbortSignal);
        calls.push({ ...parameters, signal: options.signal });
        return getSession?.(parameters.sessionID, directory) ?? { id: parameters.sessionID,
          location: { directory }, agent: "build", time: {}, tokens, cost: 0 };
      },
    },
    event: { async *subscribe({ signal }: { signal: AbortSignal }) {
      subscriptionSignal = signal;
      signal.addEventListener("abort", () => wake?.(), { once: true });
      try {
        while (!signal.aborted) {
          if (!items.length) await new Promise<void>((resolve) => { wake = resolve; });
          if (signal.aborted) break;
          const item = items.shift()!;
          yield item.event;
          item.done();
        }
      } finally { returned = true; }
    } },
  } as unknown as V2ServerContext;
  let cleanup = await plugin.setup(ctx);
  const dispose = () => cleanup();
  const restart = async () => { await cleanup(); returned = false; cleanup = await plugin.setup(ctx); };
  const base = Date.now();
  const send: Send = (type, data, offset, extra = {}) => new Promise<void>((done) => {
    const number = ++seq;
    const envelope: StepEnvelope = { id: `evt_${number}`, created: base + offset,
      durable: { aggregateID: data.sessionID, seq: number, version: 1 }, location: { directory }, ...extra };
    const event = type === "session.step.started" ? stepStarted(envelope, data as SessionStepStarted["data"])
      : type === "session.step.ended" ? stepEnded(envelope, data as SessionStepEnded["data"])
      : { ...envelope, type, data };
    items.push({ event, done });
    wake?.();
  });
  const read = async () => ({
    totals: JSON.parse(await readFile(join(directory, "totals.json"), "utf8")),
    records: (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    facts: await new ActivityLedger(join(directory, "runs.jsonl")).read(),
  });
  try { await run({ directory, path, base, send, read, calls, cleanup: dispose, restart, signal: () => subscriptionSignal!, returned: () => returned }); }
  finally { await cleanup(); await new Promise((resolve) => setTimeout(resolve, 20)); await rm(directory, { recursive: true, force: true }); }
}

test("V2 default setup subscribes, honors options/location and aborts cleanup; retains V1 server", async () => {
  assert.equal(plugin.id, "oc-tps");
  assert.equal(typeof plugin.server, "function");
  await fixture(async ({ send, cleanup, signal, returned, read, directory }) => {
    await send("session.created", { sessionID: "s", agent: "build" }, 0);
    await send("session.execution.started", { sessionID: "s" }, 1, { location: { directory: `${directory}/other` } });
    assert.equal((await read()).facts.length, 0);
    assert.equal(signal().aborted, false);
    await cleanup();
    assert.equal(signal().aborted, true);
    assert.equal(returned(), true);
  });
});

test("V2 step usage is per assistant request, cumulative usage is not double-counted, exact corrections survive trimming", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.created", { sessionID: "s", agent: "build" }, 0);
    await send("session.execution.started", { sessionID: "s" }, 0);
    for (const [id, offset] of [["msg_a", 10], ["msg_b", 30]] as const) {
      await send("session.step.started", { sessionID: "s", assistantMessageID: id, agent: "build", model, started: base + offset }, offset);
      await send("session.step.ended", { sessionID: "s", assistantMessageID: id, finish: "tool-calls", tokens, cost: 0.5 }, offset + 10);
    }
    await send("session.usage.updated", { sessionID: "s", tokens: { ...tokens, output: 99999 }, cost: 99 }, 55);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_a", finish: "tool-calls", tokens: { ...tokens, output: 4 }, cost: 0.25 }, 60);
    // Replay of an older correction must not undo the newer exact contribution.
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_a", finish: "tool-calls", tokens, cost: 0.5 }, 20,
      { id: "evt_4", durable: { aggregateID: "s", seq: 4, version: 1 } });
    await send("session.execution.succeeded", { sessionID: "s" }, 100);
    const { records, totals, facts } = await read();
    assert.equal(records.length, 1);
    assert.equal(totals.sessions.s.responseCount, 2);
    assert.equal(totals.sessions.s.cost, 0.75);
    assert.deepEqual(totals.sessions.s.tokens, { input: 24, output: 11, reasoning: 6, cacheRead: 18, cacheWrite: 4 });
    assert.equal(records[0].model, "fixture-model");
    assert.equal(records[0].speed, undefined);
    assert.deepEqual(records[0].samples, []);
    const last = facts.at(-1);
    assert.equal(replayActivity(facts, { trustedCurrentInstanceID: last.instanceID, cutoff: base + 1000 }).rootActiveMilliseconds.s, 100);
  });
});

test("V2 streaming and full text boundaries perform no ledger writes and streamed does not end execution", async () => {
  await fixture(async ({ base, directory, send, read }) => {
    await send("session.created", { sessionID: "s", agent: "build" }, 0);
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_a", agent: "build", model, started: base + 10 }, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const files = ["history.jsonl", "totals.json", "runs.jsonl"];
    const contents = () => Promise.all(files.map((name) => readFile(join(directory, name), "utf8").catch(() => "")));
    const before = await contents();
    for (const type of ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.text.ended", "session.reasoning.ended", "session.step.streamed"]) {
      await send(type, { sessionID: "s", assistantMessageID: "msg_a", ordinal: 0, id: "tool-id", delta: "hello", text: "hello" }, 20);
    }
    assert.deepEqual(await contents(), before);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_a", finish: "tool-calls", tokens, cost: 0.5 }, 30);
    assert.equal((await read()).facts.some((fact: any) => fact.state === "completed"), false);
    await send("session.execution.interrupted", { sessionID: "s", reason: "user" }, 40);
    assert.equal((await read()).facts.at(-1).state, "aborted");
  });
});

test("V2 retry/failed step does not terminate execution or fabricate billable usage", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_a", agent: "build", model, started: base + 10 }, 10);
    await send("session.step.failed", { sessionID: "s", assistantMessageID: "msg_a", error: { type: "UnknownError", message: "failed" } }, 20);
    assert.equal((await read()).facts.some((fact: any) => fact.state === "failed"), false);
    await send("session.retry.scheduled", { sessionID: "s", assistantMessageID: "msg_a", attempt: 1, at: base + 40, error: { type: "test", message: "retry" } }, 30);
    await send("session.execution.failed", { sessionID: "s", error: { type: "UnknownError", message: "failed" } }, 50);
    const { records, facts } = await read();
    assert.equal(records.length, 0);
    assert.deepEqual(facts.map((fact: any) => fact.state), ["busy", "retry", "failed"]);
  });
});

test("V2 created metadata, agent/model identity and deferred parent lookup exclude Magic Context ancestry", async () => {
  await fixture(async ({ base, send, read, calls }) => {
    await send("session.created", { sessionID: "hidden", metadata: { magic_context: "hidden-run", role: "historian" } }, 0);
    await send("session.created", { sessionID: "child", parentID: "hidden", agent: "build" }, 1);
    await send("session.execution.started", { sessionID: "child" }, 2);
    await send("session.step.started", { sessionID: "child", assistantMessageID: "msg_hidden", agent: "build", model, started: base + 3 }, 3);
    await send("session.step.ended", { sessionID: "child", assistantMessageID: "msg_hidden", tokens, cost: 2, finish: "stop" }, 4);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_magic", agent: "build", model: { providerID: "magic-context", id: "synthetic" }, started: base + 5 }, 5);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_magic", tokens, cost: 2, finish: "stop" }, 6);
    await send("session.created", { sessionID: "late", agent: "build" }, 7);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await send("session.step.ended", { sessionID: "late", assistantMessageID: "msg_late", tokens, cost: 2, finish: "stop" }, 8);
    const { records, totals, facts } = await read();
    assert.equal(records.length, 0);
    assert.equal(totals.sessionScopes.child.parentSessionID, "hidden");
    assert.equal(totals.sessionScopes.late.parentSessionID, "hidden");
    assert.ok(calls.some((call: any) => call.sessionID === "late"));
    assert.equal(facts.some((fact: any) => fact.kind === "lifecycle"), false);
  }, (id, directory) => ({ id, location: { directory }, agent: "build", time: {}, ...(id === "late" ? { parentID: "hidden" } : {}) }));
});

test("V2 ordinary provider with model.id magic-context excludes only that message without changing canonical data", async () => {
  const magicModel = { providerID: "fixture", id: "magic-context" } satisfies SessionStepStarted["data"]["model"];
  const adapter = createV2EventAdapter();
  const envelope = { id: "evt_start", created: 10, durable: { aggregateID: "s", seq: 1, version: 1 as const } };
  const start = stepStarted(envelope, { sessionID: "s", assistantMessageID: "msg_magic_id", agent: "build", model: magicModel, started: 10 });
  const info = adapter.events(start)[0].properties.info;
  assert.deepEqual(info.model, { ...magicModel, modelID: "magic-context" });
  assert.equal(Object.hasOwn(start.data.model, "modelID"), false);
  const end = stepEnded({ ...envelope, id: "evt_end", created: 20, durable: { ...envelope.durable, seq: 2 } },
    { sessionID: "s", assistantMessageID: "msg_magic_id", finish: "stop", tokens, cost: 2 });
  const completion = adapter.events(end)[0].properties.v2Completion;
  assert.equal(completion.data, end.data);
  assert.deepEqual(completion, { data: end.data, created: end.created });

  await fixture(async ({ base, send, read }) => {
    await send("session.created", { sessionID: "s", agent: "build" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_magic_id", agent: "build", model: magicModel, started: base + 10 }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_magic_id", finish: "stop", tokens, cost: 2 }, 20);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_user", agent: "build", model, started: base + 30 }, 30);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_user", finish: "tool-calls", tokens, cost: 0.5 }, 40);
    const { records, totals } = await read();
    assert.deepEqual(records.map((record: any) => record.messageID), ["msg_user"]);
    assert.equal(totals.sessions.s.responseCount, 1);
    assert.equal(totals.sessions.s.cost, 0.5);
    assert.deepEqual(totals.sessions.s.tokens, { input: 12, output: 7, reasoning: 3, cacheRead: 9, cacheWrite: 2 });
    assert.equal(totals.messageScopes.msg_magic_id.sourceScope, "magic-message");
    assert.notEqual(totals.sessionScopes?.s?.sourceScope, "magic-session");
  });
});

test("V2 fresh session.get idle watermark is direct API evidence, never invented status/active absence", async () => {
  const directory = "/fixture";
  const response = { id: "s", location: { directory }, outcome: "succeeded", time: { idle: 100 } };
  const ctx = { location: { directory }, session: { get: async () => response } } as unknown as V2ServerContext;
  for (const [outcome, state] of [["succeeded", "completed"], ["failed", "failed"], ["interrupted", "aborted"]]) {
    response.outcome = outcome;
    assert.deepEqual(await readV2Idle(ctx, "s", new AbortController().signal), { state, timestamp: 100 });
  }
  assert.equal(await readV2Idle(ctx, "other", new AbortController().signal), undefined);
  response.location.directory = "/other";
  assert.equal(await readV2Idle(ctx, "s", new AbortController().signal), undefined);
  response.location.directory = directory;
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await readV2Idle(ctx, "s", aborted.signal), undefined);
  const adapter = createV2EventAdapter();
  assert.deepEqual(adapter.events({ type: "session.usage.updated", created: 100, data: { sessionID: "s", tokens } }), []);
});

test("V2 restart replay does not reclaim trimmed history or lose retained model/start on a newer correction", async () => {
  await fixture(async ({ base, send, read, restart }) => {
    await send("session.created", { sessionID: "s", agent: "build" }, 0);
    for (const [id, offset] of [["msg_a", 10], ["msg_b", 30]] as const) {
      await send("session.step.started", { sessionID: "s", assistantMessageID: id, agent: "build", model, started: base + offset }, offset);
      await send("session.step.ended", { sessionID: "s", assistantMessageID: id, finish: "tool-calls", tokens, cost: 0.5 }, offset + 10);
    }
    await restart();
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_a", finish: "tool-calls", tokens, cost: 0.5 }, 20,
      { id: "evt_3", durable: { aggregateID: "s", seq: 3, version: 1 } });
    assert.equal((await read()).records[0].messageID, "msg_b");
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_b", finish: "tool-calls", tokens: { ...tokens, output: 1 }, cost: 0.25 }, 50);
    const { records, totals } = await read();
    assert.equal(records[0].model, "fixture-model");
    assert.equal(records[0].time.start, base + 30);
    assert.equal(totals.sessions.s.responseCount, 2);
    assert.equal(totals.sessions.s.tokens.output, 8);
  });
});

test("V2 idle reconciliation rejects a previous execution watermark and accepts a fresh terminal get", async () => {
  for (const fresh of [false, true]) {
    let idle = 0;
    await fixture(async ({ base, send, read }) => {
      idle = base + (fresh ? 40 : -100);
      await send("session.execution.started", { sessionID: "s" }, 0);
      await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_a", agent: "build", model, started: base + 10 }, 10);
      await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_a", finish: "stop", tokens, cost: 0.5 }, 30);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { facts } = await read();
      assert.equal(facts.some((fact: any) => fact.state === "completed"), fresh);
      if (fresh) assert.equal(facts.at(-1).timestamp, idle);
    }, (id, directory) => ({ id, location: { directory }, agent: "build", outcome: "succeeded", time: { idle } }));
  }
});

test("V2 parent completion does not stop an independently busy child execution", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.created", { sessionID: "s", agent: "build" }, 0);
    await send("session.created", { sessionID: "child", parentID: "s", agent: "fixer" }, 0);
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.execution.started", { sessionID: "child" }, 10);
    await send("session.execution.succeeded", { sessionID: "s" }, 30);
    await send("session.execution.interrupted", { sessionID: "child", reason: "user" }, 60);
    const { facts } = await read();
    assert.equal(replayActivity(facts, { cutoff: base + 1000, trustedCurrentInstanceID: facts.at(-1).instanceID }).rootActiveMilliseconds.s, 60);
  });
});

test("V2 failed billable steps keep non-overlapping usage and execution terminal freezes activity", async () => {
  for (const terminal of ["session.execution.failed", "session.execution.interrupted"] as const) {
    await fixture(async ({ base, send, read }) => {
      await send("session.execution.started", { sessionID: "s" }, 0);
      await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_a", agent: "build", model, started: base + 10 }, 10);
      await send("session.text.delta", { sessionID: "s", assistantMessageID: "msg_a", ordinal: 0, delta: "partial" }, 15);
      await send("session.step.failed", { sessionID: "s", assistantMessageID: "msg_a", error: { type: "content-filter", message: "blocked" },
        finish: "content-filter", tokens, cost: 0.25 }, 20);
      assert.equal((await read()).facts.some((fact: any) => ["failed", "aborted"].includes(fact.state)), false);
      if (terminal === "session.execution.failed") await send(terminal, { sessionID: "s", error: { type: "test", message: "failed" } }, 50);
      else await send(terminal, { sessionID: "s", reason: "shutdown" }, 50);
      const { records, totals, facts } = await read();
      assert.equal(records.length, 1);
      assert.equal(records[0].quality, "exact");
      assert.equal(records[0].speed, undefined);
      assert.equal(totals.sessions.s.responseCount, 1);
      assert.equal(totals.sessions.s.cost, 0.25);
      // TokenUsage.Info is already disjoint: do not subtract cache or reasoning again.
      assert.deepEqual(totals.sessions.s.tokens, { input: 12, output: 7, reasoning: 3, cacheRead: 9, cacheWrite: 2 });
      assert.equal(facts.at(-1).state, terminal.endsWith("failed") ? "failed" : "aborted");
      for (const cutoff of [base + 100, base + 100_000]) {
        assert.equal(replayActivity(facts, { cutoff, trustedCurrentInstanceID: facts.at(-1).instanceID }).rootActiveMilliseconds.s, 50);
      }
      const before = JSON.stringify(await read());
      await send("session.text.delta", { sessionID: "s", assistantMessageID: "msg_a", ordinal: 0, delta: "late" }, 60);
      assert.equal(JSON.stringify(await read()), before);
    });
  }
});

test("V2 terminal without usage or content retires an unfinished step without unknown TPS/TTFT or counters", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_a", agent: "build", model, started: base + 10 }, 10);
    await send("session.execution.interrupted", { sessionID: "s", reason: "user" }, 20);
    const { records, totals, facts } = await read();
    assert.equal(records.length, 0);
    assert.equal(totals.sessions.s?.responseCount ?? 0, 0);
    assert.equal(facts.at(-1).state, "aborted");
    assert.equal(replayActivity(facts, { cutoff: base + 100_000, trustedCurrentInstanceID: facts.at(-1).instanceID }).rootActiveMilliseconds.s, 20);
  });
});

test("V2 locationless events need same-directory data evidence; foreign session.get cannot write metadata", async () => {
  await fixture(async ({ directory, base, send, read }) => {
    const before = JSON.stringify(await read());
    await send("session.execution.started", { sessionID: "foreign" }, 0, { location: undefined });
    const created = { sessionID: "foreign", projectID: "project", location: { directory: `${directory}/foreign` },
      slug: "foreign", agent: "build", version: "2.0.27" } satisfies SessionCreated["data"];
    await send("session.created", created, 1, { location: undefined });
    // A same-directory envelope cannot override contradictory entity location.
    await send("session.created", created, 1);
    await send("session.step.ended", { sessionID: "foreign", assistantMessageID: "msg_foreign", tokens, cost: 99, finish: "stop" }, 2,
      { location: undefined });
    assert.equal(JSON.stringify(await read()), before);
    await send("session.created", { ...created, sessionID: "s", location: { directory } }, 3, { location: undefined });
    await send("session.execution.started", { sessionID: "s" }, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { totals, facts } = await read();
    assert.notEqual(totals.sessionScopes?.s?.parentSessionID, "foreign-parent");
    assert.notEqual(totals.sessions.s?.agent, "foreign-agent");
    assert.equal(facts.some((fact: any) => fact.kind === "parent"), false);
    assert.equal(facts.at(-1).timestamp, base + 4);
  }, (id, directory) => ({ id, location: { directory: `${directory}/foreign` }, agent: "foreign-agent",
    parentID: "foreign-parent", metadata: { magic_context: "hidden" }, time: {} }));
});

test("V2 cleanup aborts pending metadata and prevents late writes after subscription returns", async () => {
  let resolveSession!: (session: any) => void;
  const pending = new Promise<any>((resolve) => { resolveSession = resolve; });
  await fixture(async ({ directory, send, read, calls, cleanup, returned }) => {
    await send("session.created", { sessionID: "s", agent: "build" }, 0);
    assert.equal(calls.length, 1);
    const before = JSON.stringify(await read());
    await cleanup();
    assert.equal(returned(), true);
    assert.equal(calls[0].signal.aborted, true);
    resolveSession({ id: "s", location: { directory }, agent: "late-agent", parentID: "late-parent", time: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(await read()), before);
  }, () => pending);
});

test("V2 idle reads do not call the session domain after cleanup", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const ctx = { session: { get: async () => { calls++; throw new Error("must not read"); } } } as unknown as V2ServerContext;
  assert.equal(await readV2Idle(ctx, "s", controller.signal), undefined);
  assert.equal(calls, 0);
});
