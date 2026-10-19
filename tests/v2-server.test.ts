import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { SessionStepStarted, SessionStepEnded, SessionStepFailed, SessionCreated,
  SessionExecutionFailed, SessionExecutionInterrupted } from "@opencode/client";
import plugin from "../src/server.js";
import { createV2EventAdapter, readV2Idle, type V2ServerContext } from "../src/v2-server.js";
import { ActivityLedger } from "../src/runs-storage.js";
import { replayActivity, createActivityProjector } from "../src/activity.js";
import { createRuntimeStore, reloadActivity, taskWallTimeForSession } from "../src/tui.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
// Bun is the assigned test runner; avoid adding @types/bun as a dependency.
const { spyOn } = require("bun:test");
import * as fileSystem from "node:fs/promises";
import * as crypto from "node:crypto";

// Step fixtures are checked against @opencode/client 2.0.27, including
// event.data/created/durable.seq, Model.Ref.id, assistantMessageID and
// TokenUsage.Info.cache. The fake session domain returns direct get results.
const tokens = { input: 12, output: 7, reasoning: 3, cache: { read: 9, write: 2 } };
const model = { providerID: "fixture", id: "fixture-model" } satisfies SessionStepStarted["data"]["model"];

test("A2-02 late old step end uses old namespace without reading or retiring the fresh reused MID", () => {
  const adapter = createV2EventAdapter();
  const emit = (sid: string, type: string, time: number, seq: number, extra: any = {}) => adapter.events({
    id: `${sid}_${type}_${seq}_${extra.suffix ?? "event"}`, type, created: time, durable: { seq },
    data: { sessionID: sid, assistantMessageID: "same", ...extra },
  });
  for (const sid of ["a", "b"]) {
    emit(sid, "session.execution.started", 0, 0);
    emit(sid, "session.step.started", 1, 1, { agent: "build", model: { providerID: "fixture", id: `${sid}-old-model` }, started: 1 });
    emit(sid, "session.execution.succeeded", 3, 3);
    emit(sid, "session.execution.started", 10, 10);
    emit(sid, "session.step.started", 11, 11, { agent: "build", model: { providerID: "fixture", id: `${sid}-new-model` }, started: 11 });
  }
  assert.equal(adapter.retainedState().activeResponses, 2);
  for (const sid of ["a", "b"]) {
    const completed = emit(sid, "session.step.ended", 2, 2, { tokens, cost: 1, finish: "stop" })
      .find((event: any) => event.type === "message.updated")!.properties;
    assert.equal(completed.executionID, `${sid}_session.execution.started_0_event`);
    assert.equal(completed.info.model.id, `${sid}-old-model`);
    assert.equal(completed.info.time.created, 1);
    assert.equal(completed.info.time.completed, 2);
    assert.equal(completed.info.id, "same");
    assert.equal(adapter.retainedState().activeResponses, 2, "both fresh full starts survive the old end");
    emit(sid, "session.step.started", 4, 1, { suffix: "late", agent: "build", model: { providerID: "fixture", id: `${sid}-old-model` }, started: 1 });
    emit(sid, "session.step.ended", 2, 2, { suffix: "duplicate", tokens, cost: 1, finish: "stop" });
    assert.equal(adapter.retainedState().activeResponses, 2, "late old start/end cannot change fresh ownership");
  }
  const fresh = emit("a", "session.step.ended", 12, 12, { tokens, cost: 1, finish: "stop" })
    .find((event: any) => event.type === "message.updated")!.properties.info;
  assert.equal(fresh.model.id, "a-new-model");
  assert.equal(fresh.time.created, 11);
  assert.equal(adapter.retainedState().activeResponses, 1);
  emit("b", "session.execution.succeeded", 13, 13);
  assert.equal(adapter.retainedState().activeResponses, 0);
});

test("A2-02 late missing old start repairs only its closed namespace while a reused MID remains active", () => {
  const adapter = createV2EventAdapter();
  const emit = (type: string, time: number, seq: number, extra: any = {}) => adapter.events({
    id: `${type}_${seq}_${extra.suffix ?? "event"}`, type, created: time, durable: { seq },
    data: { sessionID: "s", assistantMessageID: "same", ...extra },
  });
  emit("session.execution.started", 0, 0);
  emit("session.step.ended", 2, 2, { tokens, cost: 1, finish: "stop" });
  emit("session.execution.succeeded", 3, 3);
  emit("session.execution.started", 10, 10);
  emit("session.step.started", 11, 11, { agent: "build", model: { providerID: "fixture", id: "new-model" }, started: 11 });
  emit("session.step.started", 15, 1, { suffix: "late", agent: "build", model: { providerID: "fixture", id: "old-model" }, started: 1 });
  const old = emit("session.step.ended", 2, 2, { suffix: "late", tokens, cost: 1, finish: "stop" })
    .find((event: any) => event.type === "message.updated")!.properties.info;
  assert.equal(old.model.id, "old-model"); assert.equal(old.time.created, 1); assert.equal(old.time.completed, 2);
  assert.equal(adapter.retainedState().activeResponses, 1);
  const fresh = emit("session.step.ended", 12, 12, { tokens, cost: 1, finish: "stop" })
    .find((event: any) => event.type === "message.updated")!.properties.info;
  assert.equal(fresh.model.id, "new-model"); assert.equal(fresh.time.created, 11);
  assert.equal(adapter.retainedState().activeResponses, 0);
});

for (const tail of ["step.ended", "step.failed", "tool.success", "tool.failed", "tool.called"]) test(`A2-03 late ${tail} completes pure MC proof through setup, dispose and restart`, async () => {
  await fixture(async ({ base, send, read, cleanup, restart }) => {
    const tool = tail.startsWith("tool.");
    const durable = (seq: number) => ({ aggregateID: "s", seq, version: 1 as const });
    await send("session.execution.started", { sessionID: "s" }, 0, { durable: durable(1) });
    await send("session.step.started", { sessionID: "s", assistantMessageID: "mc", agent: "build",
      model: { providerID: "fixture", id: "magic-context" }, started: base + 10 }, 10, { durable: durable(2) });
    if (tool) {
      if (tail === "tool.called") await send("session.tool.success", { sessionID: "s", assistantMessageID: "mc", id: "raw-call" }, 60, { durable: durable(4) });
      else await send("session.tool.called", { sessionID: "s", assistantMessageID: "mc", id: "raw-call" }, 20, { durable: durable(3) });
      await send("session.step.ended", { sessionID: "s", assistantMessageID: "mc", tokens, cost: 1, finish: "stop" }, 80, { durable: durable(5) });
    }
    await send("session.execution.succeeded", { sessionID: "s" }, 100, { durable: durable(tool ? 6 : 4) });
    assert.equal((await read()).facts.some((fact: any) => fact.kind === "execution-scope"), false, "terminal cannot certify the unfinished work");
    const data = tool ? { sessionID: "s", assistantMessageID: "mc", id: "raw-call" }
      : { sessionID: "s", assistantMessageID: "mc", ...(tail === "step.ended" ? { tokens, cost: 1, finish: "stop" } : { error: { type: "fixture" } }) };
    const extra = { id: `late-${tail}`, durable: durable(tail === "tool.called" ? 3 : tool ? 4 : 3) };
    const offset = tail === "tool.called" ? 20 : tool ? 60 : 80;
    await send(`session.${tail}`, data, offset, extra);
    const verify = async () => {
      const { facts, totals } = await read();
      assert.equal(replayActivity(facts).rootActiveMilliseconds.s ?? 0, 0);
      const projector = createActivityProjector(); projector.ingest(facts);
      assert.equal(projector.totals("s", { until: base + 10000 }).includingMilliseconds, 0);
      assert.equal(facts.filter((fact: any) => fact.kind === "execution-scope").length, 1);
      assert.equal(totals.sessions.s?.responseCount ?? 0, 0);
    };
    await verify();
    const count = (await read()).facts.length;
    await send(`session.${tail}`, data, offset, extra);
    assert.equal((await read()).facts.length, count, "duplicate late tail cannot add proof or new LIVE activity");
    await send(`session.${tail}`, data, offset, { ...extra, id: `${extra.id}-equivalent` });
    assert.equal((await read()).facts.filter((fact: any) => fact.state === "busy").length, 1);
    await verify();
    await cleanup(); await verify(); await restart(); await verify();
  });
});

test("A2-03 late start and classification repair a known closed end without manufacturing a LIVE start", async () => {
  await fixture(async ({ base, send, read, cleanup, restart }) => {
    const durable = (seq: number) => ({ aggregateID: "s", seq, version: 1 as const });
    await send("session.execution.started", { sessionID: "s" }, 0, { durable: durable(1) });
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "mc", tokens, cost: 1, finish: "stop" }, 80, { durable: durable(3) });
    await send("session.execution.succeeded", { sessionID: "s" }, 100, { durable: durable(4) });
    assert.equal((await read()).facts.some((fact: any) => fact.kind === "execution-scope"), false);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "mc", agent: "build",
      model: { providerID: "fixture", id: "magic-context" }, started: base + 10 }, 10, { durable: durable(2) });
    const verify = async () => {
      const { facts, totals } = await read();
      assert.equal(replayActivity(facts).rootActiveMilliseconds.s ?? 0, 0);
      const projector = createActivityProjector(); projector.ingest(facts);
      assert.equal(projector.totals("s", { until: base + 10000 }).includingMilliseconds, 0);
      assert.equal(totals.sessions.s?.responseCount ?? 0, 0);
    };
    await verify(); await cleanup(); await verify(); await restart(); await verify();
  });
});

for (const incomplete of ["execution-start", "work-start", "tool-start", "gap"]) test(`A2-03 ${incomplete} missing or untrusted does not certify pure after a late tail`, async () => {
  await fixture(async ({ base, send, read }) => {
    const durable = (seq: number) => ({ aggregateID: "s", seq, version: 1 as const });
    if (incomplete !== "execution-start") await send("session.execution.started", { sessionID: "s" }, 0, { durable: durable(1) });
    if (incomplete !== "work-start") await send("session.step.started", { sessionID: "s", assistantMessageID: "mc", agent: "build",
      model: { providerID: "fixture", id: "magic-context" }, started: base + 10 }, 10, { durable: durable(2) });
    await send("session.execution.succeeded", { sessionID: "s" }, 100, { durable: durable(5) });
    if (incomplete === "tool-start") await send("session.tool.success", { sessionID: "s", assistantMessageID: "mc", id: "unstarted" }, 60, { durable: durable(3) });
    if (incomplete === "gap") {
      await send("server.connected", {}, 101);
      await send("server.connected", {}, 102);
    }
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "mc", tokens, cost: 1, finish: "stop" }, 80, { durable: durable(4) });
    const { facts } = await read();
    assert.equal(facts.some((fact: any) => fact.kind === "execution-scope"), false);
    if (incomplete !== "execution-start") assert.ok((replayActivity(facts).rootActiveMilliseconds.s ?? 0) > 0, "unknown/gap cannot erase the observed non-maintenance prefix");
  });
});

for (const participant of ["normal-tool", "real-child"]) test(`A2-03 late MC completion preserves ${participant} time`, async () => {
  await fixture(async ({ base, send, read, cleanup, restart }) => {
    const durable = (seq: number) => ({ aggregateID: "s", seq, version: 1 as const });
    await send("session.execution.started", { sessionID: "s" }, 0, { durable: durable(1) });
    await send("session.step.started", { sessionID: "s", assistantMessageID: "mc", agent: "build",
      model: { providerID: "fixture", id: "magic-context" }, started: base + 10 }, 10, { durable: durable(2) });
    if (participant === "real-child") {
      await send("session.created", { sessionID: "child", parentID: "s", agent: "build" }, 0);
      await send("session.execution.started", { sessionID: "child" }, 20);
      await send("session.execution.succeeded", { sessionID: "child" }, 90);
    } else {
      await send("session.step.started", { sessionID: "s", assistantMessageID: "normal", agent: "build", model, started: base + 40 }, 40, { durable: durable(3) });
      await send("session.tool.called", { sessionID: "s", assistantMessageID: "normal", id: "raw-normal" }, 40, { durable: durable(4) });
      await send("session.tool.success", { sessionID: "s", assistantMessageID: "normal", id: "raw-normal" }, 60, { durable: durable(5) });
      await send("session.step.ended", { sessionID: "s", assistantMessageID: "normal", tokens, cost: 1, finish: "stop" }, 60, { durable: durable(6) });
    }
    await send("session.execution.succeeded", { sessionID: "s" }, 100, { durable: durable(8) });
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "mc", tokens, cost: 1, finish: "stop" }, 80, { durable: durable(7) });
    const expected = participant === "real-child" ? 70 : 50;
    const verify = async () => {
      const { facts } = await read();
      assert.equal(replayActivity(facts).rootActiveMilliseconds.s, expected);
      const projector = createActivityProjector(); projector.ingest(facts);
      const total = projector.totals("s", { until: base + 10000 });
      assert.equal(total.includingMilliseconds, expected);
      assert.equal(total.directMilliseconds, participant === "real-child" ? 0 : expected);
    };
    await verify(); await cleanup(); await verify(); await restart(); await verify();
  });
});

test("A2-03 1k/2k/4k late tails reevaluate only their own readiness, not every prior work", () => {
  for (const count of [1000, 2000, 4000]) {
    const adapter = createV2EventAdapter();
    const emit = (type: string, created: number, seq: number, data: any) => adapter.events({
      id: `${type}_${seq}`, type, created, durable: { seq }, data: { sessionID: "s", ...data },
    });
    emit("session.execution.started", 0, 0, {});
    for (let index = 0; index < count; index++) emit("session.step.started", index + 1, index + 1, {
      assistantMessageID: `mc_${index}`, agent: "build", model: { providerID: "fixture", id: "magic-context" }, started: index + 1,
    });
    assert.equal(emit("session.execution.succeeded", count * 2 + 1, count * 2 + 1, {}).some((event: any) => event.properties.fact?.kind === "execution-scope"), false);
    const before = adapter.retainedState().proofWorkChecks;
    const began = performance.now();
    let proofs = 0;
    for (let index = 0; index < count; index++) proofs += emit("session.step.failed", count + index + 1, count + index + 1, {
      assistantMessageID: `mc_${index}`, error: { type: "fixture" },
    }).filter((event: any) => event.properties.fact?.kind === "execution-scope").length;
    assert.equal(adapter.retainedState().proofWorkChecks - before, count);
    assert.equal(adapter.retainedState().activeResponses, 0);
    assert.equal(proofs, 1);
    console.log(`[A2-03 late readiness ${count}] checks=${count}, proof=1, elapsed=${(performance.now() - began).toFixed(2)}ms`);
  }
});

test("G1-01 queried terminal closes the proven execution across replay, advance, dispose and restart", async () => {
  let end = 0;
  await fixture(async ({ base, send, read, cleanup, restart }) => {
    end = base + 40;
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "m", agent: "build", model, started: base + 10 }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "m", tokens, cost: 1, finish: "stop" }, 30);
    for (let index = 0; index < 100; index++) {
      if ((await read()).facts.some((fact: any) => fact.state === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const verify = async () => {
      const { facts } = await read();
      assert.equal(replayActivity(facts).rootActiveMilliseconds.s, 40);
      const projector = createActivityProjector(); projector.ingest(facts);
      assert.equal(projector.totals("s", { until: base + 100000 }).includingMilliseconds, 40);
    };
    await verify(); await cleanup(); await verify(); await restart(); await verify();
  }, (id, directory) => ({ id, location: { directory }, agent: "build", outcome: "succeeded", time: { idle: end } }));
});

test("G1-02 repeated connected in one iterator freezes only known prefix and allows a new epoch", async () => {
  await fixture(async ({ send, read }) => {
    await send("server.connected", {}, 0);
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.retry.scheduled", { sessionID: "s" }, 10);
    await send("server.connected", {}, 1000);
    await send("session.execution.succeeded", { sessionID: "s" }, 1100);
    assert.equal(replayActivity((await read()).facts).rootActiveMilliseconds.s, 10);
    await send("session.execution.started", { sessionID: "s" }, 1000);
    await send("session.execution.succeeded", { sessionID: "s" }, 1100);
    assert.equal(replayActivity((await read()).facts).rootActiveMilliseconds.s, 110);
  });
});

test("G1-02 repeated connected invalidates unresolved directory proof and late lookup output", async () => {
  let release!: (value: any) => void;
  const proof = new Promise((resolve) => { release = resolve; });
  await fixture(async ({ directory, send, read, calls }) => {
    await send("server.connected", {}, 0);
    await send("session.execution.started", { sessionID: "pending" }, 0, { location: undefined });
    for (let index = 0; index < 100 && !calls.some((call) => call.sessionID === "pending"); index++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(calls.some((call) => call.sessionID === "pending"));
    await send("server.connected", {}, 1000);
    release({ id: "pending", location: { directory }, agent: "build", time: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await send("session.execution.started", { sessionID: "fresh" }, 1000);
    await send("session.execution.succeeded", { sessionID: "fresh" }, 1100);
    const { facts } = await read();
    assert.equal(facts.some((fact: any) => fact.sessionID === "pending"), false);
    assert.equal(replayActivity(facts).rootActiveMilliseconds.fresh, 100);
  }, (id, directory) => id === "pending" ? proof : { id, location: { directory }, agent: "build", time: {} });
});

test("G1-01 a late query watermark owned by an old response cannot terminate the newer execution", async () => {
  let release!: (value: any) => void; let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  await fixture(async ({ base, directory, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "old_m", agent: "build", model, started: base + 10 }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "old_m", tokens, cost: 1, finish: "stop" }, 30);
    for (let index = 0; index < 100 && calls < 2; index++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(calls, 2);
    await send("session.execution.started", { sessionID: "s" }, 1000);
    release({ id: "s", location: { directory }, outcome: "succeeded", time: { idle: base + 40 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await read()).facts.some((fact: any) => fact.state === "completed"), false);
    await send("session.execution.succeeded", { sessionID: "s" }, 1100);
    const { facts } = await read();
    const busy = facts.filter((fact: any) => fact.state === "busy");
    assert.equal(facts.find((fact: any) => fact.state === "completed").executionID, busy[1].executionID);
  }, (id, directory) => ++calls === 1 ? { id, location: { directory }, agent: "build", time: {} } : gate);
});

test("G1-04 tool call identity is isolated by session, execution and step", () => {
  const adapter = createV2EventAdapter(); let seq = 0;
  const emit = (type: string, data: any) => adapter.events({ id: `g1_${++seq}`, type, data, created: seq, durable: { seq } });
  for (const sid of ["a", "b"]) {
    emit("session.execution.started", { sessionID: sid });
    emit("session.step.started", { sessionID: sid, assistantMessageID: `${sid}_m`, agent: sid === "a" ? "historian" : "build", model, started: seq });
    const [work] = emit("session.tool.called", { sessionID: sid, assistantMessageID: `${sid}_m`, id: "same" });
    assert.equal(work.properties.fact.sessionID, sid);
    assert.equal(work.properties.fact.stepID, `${sid}_m`);
  }
  const [ended] = emit("session.tool.success", { sessionID: "a", assistantMessageID: "a_m", id: "same" });
  assert.equal(ended.properties.fact.stepID, "a_m");
  assert.equal(ended.properties.fact.measurementScope.sourceScope, "magic-message");
  const oldExecution = ended.properties.fact.executionID;
  emit("session.execution.started", { sessionID: "a" });
  for (const messageID of ["a_m", "a_next", "a_next_step"]) {
    emit("session.step.started", { sessionID: "a", assistantMessageID: messageID, agent: "build", model, started: seq });
    const [work] = emit("session.tool.called", { sessionID: "a", assistantMessageID: messageID, id: "same" });
    assert.notEqual(work.properties.fact.executionID, oldExecution);
    assert.equal(work.properties.fact.stepID, messageID);
    assert.equal(work.properties.fact.workID, "same");
    assert.equal(work.properties.fact.measurementScope.sourceScope, "user");
  }
});

test("G1-05 failed and interrupted executions retire unfinished starts but retain late usage metadata", () => {
  const adapter = createV2EventAdapter(); let seq = 0;
  const emit = (type: string, data: any) => adapter.events({ id: `retire_${++seq}`, type, data, created: seq, durable: { seq } });
  for (let index = 0; index < 42; index++) {
    emit("session.execution.started", { sessionID: "s" });
    emit("session.step.started", { sessionID: "s", assistantMessageID: `m_${index}`, agent: "build", model, started: seq });
    emit(index % 2 ? "session.execution.failed" : "session.execution.interrupted", { sessionID: "s" });
  }
  assert.equal(adapter.retainedState().activeResponses, 0);
  const late = emit("session.step.ended", { sessionID: "s", assistantMessageID: "m_0", tokens, cost: 1, finish: "stop" });
  assert.equal(late.find((event: any) => event.type === "message.updated")?.properties.info.model.id, model.id);
  emit("session.execution.started", { sessionID: "s" });
  emit("session.step.started", { sessionID: "s", assistantMessageID: "fresh", model, agent: "build", started: seq });
  adapter.events({ id: "old-terminal", type: "session.execution.failed", data: { sessionID: "s" }, created: 3, durable: { seq: 3 } });
  assert.equal(adapter.retainedState().activeResponses, 1, "old terminal cannot retire the fresh execution response");
  emit("session.execution.succeeded", { sessionID: "s" });
  assert.equal(adapter.retainedState().activeResponses, 0);
});

test("G1-08 special message IDs survive first admission, duplicate, correction and restart", async () => {
  await fixture(async ({ send, read, restart }) => {
    for (const id of ["constructor", "toString", "__proto__"]) {
      await send("session.step.ended", { sessionID: "s", assistantMessageID: id, tokens, cost: 1, finish: "stop" }, 10);
    }
    assert.equal((await read()).totals.sessions.s.responseCount, 3);
    await restart();
    for (const id of ["constructor", "toString", "__proto__"]) {
      await send("session.step.ended", { sessionID: "s", assistantMessageID: id, tokens, cost: 2, finish: "stop" }, 20);
    }
    assert.equal((await read()).totals.sessions.s.responseCount, 3);
    assert.equal((await read()).totals.sessions.s.cost, 6);
    assert.equal(({} as any).polluted, undefined);
  });
});

for (const correction of [false, true]) test(`G1-03 129 completions survive admission saturation, scope correction=${correction} and shutdown`, async () => {
  const rename = fileSystem.rename;
  let blocked = false;
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const failure = spyOn(fileSystem, "rename").mockImplementation(async (from: any, to: any) => {
    if (blocked && String(to).endsWith("totals.json")) throw Object.assign(new Error("totals EIO"), { code: "EIO" });
    return rename(from, to);
  });
  try {
    await fixture(async ({ base, send, read, cleanup, restart }) => {
      blocked = true;
      for (let index = 0; index < 129; index++) await send("session.step.ended", {
        sessionID: "s", assistantMessageID: `budget_${index}`, tokens, cost: 1, finish: "stop",
      }, index);
      blocked = false;
      if (correction) await send("session.step.started", { sessionID: "s", assistantMessageID: "budget_128", agent: "build",
        model: { providerID: "magic-context", id: "maintenance" }, started: base + 300 }, 300);
      else for (let index = 0; index < 8; index++) await send("session.created", { sessionID: `healthy_${index}`, agent: "build" }, 200 + index);
      await cleanup();
      assert.equal((await read()).totals.sessions.s.responseCount, correction ? 128 : 129);
      assert.equal((await read()).totals.sessions.s.cost, correction ? 128 : 129);
      await restart();
      assert.equal((await read()).totals.sessions.s.responseCount, correction ? 128 : 129);
    });
  } finally { failure.mockRestore(); warnings.mockRestore(); }
});

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
  raw: (event: any) => Promise<void>;
  disconnect: (mode: "throw" | "eof") => Promise<void>;
  subscriptions: () => number;
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
  let subscriptionCount = 0;
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
      subscriptionCount++;
      subscriptionSignal = signal;
      signal.addEventListener("abort", () => wake?.(), { once: true });
      try {
        while (!signal.aborted) {
          if (!items.length) await new Promise<void>((resolve) => { wake = resolve; });
          if (signal.aborted) break;
          const item = items.shift()!;
          if (item.event === "throw" || item.event === "eof") {
            item.done();
            if (item.event === "throw") throw new Error("transient fixture disconnect");
            return;
          }
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
  const raw = (event: any) => new Promise<void>((done) => { items.push({ event, done }); wake?.(); });
  try { await run({ directory, path, base, send, read, calls, cleanup: dispose, restart, signal: () => subscriptionSignal!, returned: () => returned,
    raw, disconnect: raw, subscriptions: () => subscriptionCount }); }
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

test("V2 server ledger restores a fresh TUI through retry, frontend absence, parallel children and idle", async () => {
  await fixture(async ({ base, directory, send, read }) => {
    const api = { ui: { toast: () => {} }, state: { session: { get: () => undefined } } } as unknown as TuiPluginApi;
    const open = async () => {
      const store = createRuntimeStore(1, base + 100_000);
      await reloadActivity(store, api, join(directory, "runs.jsonl"));
      return store;
    };
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.retry.scheduled", { sessionID: "s", attempt: 1 }, 100);
    const first = await open();
    try {
      assert.equal(taskWallTimeForSession(first, "s", base + 100_000), 100,
        "fresh frontend must retain the proven busy-to-retry interval, not zero or a guessed now cutoff");
    } finally { first.disposeSignals(); }
    // There is no frontend/store alive while the backend handles this work.
    await send("session.created", { sessionID: "child", parentID: "s", agent: "build" }, 110);
    await send("session.execution.started", { sessionID: "child" }, 150);
    await send("session.execution.succeeded", { sessionID: "s" }, 200);
    await send("session.execution.succeeded", { sessionID: "child" }, 300);
    await send("session.execution.started", { sessionID: "s" }, 1_000);
    await send("session.execution.succeeded", { sessionID: "s" }, 1_100);
    const bytes = await readFile(join(directory, "runs.jsonl"), "utf8");
    const reopened = await open();
    try {
      assert.equal(taskWallTimeForSession(reopened, "s", base + 100_000), 400);
      assert.equal(taskWallTimeForSession(reopened, "s", base + 200_000), 400,
        "completion must stop time, parallel work is unioned, and the idle gap is excluded");
      assert.equal(reopened.taskRuns.size, 0, "restoration must use the server ledger, not a synthetic live overlay");
      assert.equal((await read()).facts.length, reopened.activityEvents.length);
      assert.equal(await readFile(join(directory, "runs.jsonl"), "utf8"), bytes, "TUI is read-only");
    } finally { reopened.disposeSignals(); }
  });
});

test("V2 fresh TUI conservatively retains an open instance across server restart and late terminal replay", async () => {
  await fixture(async ({ base, directory, send, restart }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.retry.scheduled", { sessionID: "s", attempt: 1 }, 100);
    const path = join(directory, "runs.jsonl");
    const api = { ui: { toast: () => {} } } as unknown as TuiPluginApi;
    const total = async () => {
      const store = createRuntimeStore(1, base + 100_000);
      try {
        await reloadActivity(store, api, path);
        return taskWallTimeForSession(store, "s", base + 100_000);
      } finally { store.disposeSignals(); }
    };
    assert.equal(await total(), 100);
    await restart();
    assert.equal(await total(), 100, "a new server instance cannot extend an old open run to startup time");
    await send("session.execution.succeeded", { sessionID: "s" }, 200);
    assert.equal(await total(), 100, "a terminal in the new process is not a bridge over the unobserved restart gap");
    await send("session.execution.started", { sessionID: "s" }, 1_000);
    await send("session.execution.succeeded", { sessionID: "s" }, 1_100);
    assert.equal(await total(), 200);
  });
});

test("V2 locationless execution transitions retain their original times when a scoped step proves ownership", async () => {
  await fixture(async ({ base, directory, send, read }) => {
    // Captured 2.0.32 public shape: execution.started has no location and its
    // data contains only sessionID. Adjacent step.started/ended are scoped.
    await send("session.execution.started", { sessionID: "s" }, 0, { location: undefined });
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_live", agent: "build", model, started: base + 10 }, 10);
    const started = (await read()).facts;
    assert.ok(started.some((fact: any) => fact.kind === "lifecycle" && fact.state === "busy" && fact.timestamp === base),
      "scoped step must release the original execution start, not invent a later busy boundary");
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_live", tokens, cost: 0.5, finish: "stop" }, 80);
    await send("session.execution.succeeded", { sessionID: "s" }, 100, { location: undefined });
    const store = createRuntimeStore(1, base + 100_000);
    try {
      await reloadActivity(store, { ui: { toast: () => {} } } as unknown as TuiPluginApi, join(directory, "runs.jsonl"));
      assert.equal(taskWallTimeForSession(store, "s", base + 100_000), 100,
        "completed-only ledger cannot restore elapsed time in a fresh frontend");
    } finally { store.disposeSignals(); }
  }, () => { throw new Error("metadata unavailable: scoped step must independently establish ownership"); });
});

test("V2 locationless lifecycle can use bounded session.get proof without waiting on the serial event stream", async () => {
  let release!: (value: any) => void;
  const proof = new Promise((resolve) => { release = resolve; });
  await fixture(async ({ base, directory, send, read, calls }) => {
    await send("session.execution.started", { sessionID: "pending" }, 0, { location: undefined });
    assert.equal((await read()).facts.length, 0, "an unresolved lookup is not directory evidence");
    await send("session.execution.started", { sessionID: "independent" }, 20);
    assert.ok((await read()).facts.some((fact: any) => fact.sessionID === "independent" && fact.state === "busy"),
      "pending location lookup must not block another scoped session");
    release({ id: "pending", location: { directory }, agent: "build", time: {} });
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await read()).facts.some((fact: any) => fact.sessionID === "pending")) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const start = (await read()).facts.find((fact: any) => fact.sessionID === "pending" && fact.state === "busy");
    assert.equal(start?.timestamp, base, "proof arrival must not replace the original event timestamp");
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
    await send("session.execution.succeeded", { sessionID: "pending" }, 100, { location: undefined });
    assert.equal(replayActivity((await read()).facts).rootActiveMilliseconds.pending, 100);
  }, (id, directory) => id === "pending" ? proof : { id, location: { directory }, agent: "build", time: {} });
});

test("V2 two location instances attribute locationless execution to only its proven directory", async () => {
  await fixture(async (owner) => {
    await fixture(async (foreign) => {
      for (const target of [owner, foreign]) {
        await target.send("session.execution.started", { sessionID: "shared" }, 0, { location: undefined });
        await target.send("session.step.started", { sessionID: "shared", assistantMessageID: "msg_shared", agent: "build", model,
          started: owner.base + 10 }, 10, { location: { directory: owner.directory } });
        await target.send("session.execution.succeeded", { sessionID: "shared" }, 100, { location: undefined });
      }
      assert.equal(replayActivity((await owner.read()).facts).rootActiveMilliseconds.shared, 100);
      assert.deepEqual((await foreign.read()).facts, [], "foreign instance must never write an unscoped start or terminal");
    }, (id) => ({ id, location: { directory: owner.directory }, agent: "build", time: {} }));
  });
});

test("V2 failed location proof retains no activity until later scoped evidence and stale lookup cannot override it", async () => {
  let release!: (value: any) => void;
  const proof = new Promise((resolve) => { release = resolve; });
  await fixture(async ({ directory, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0, { location: undefined });
    await send("session.execution.succeeded", { sessionID: "s" }, 100, { location: undefined });
    assert.deepEqual((await read()).facts, []);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_late_proof", agent: "build", model,
      started: Date.now() }, 110, { location: { directory } });
    const before = JSON.stringify((await read()).facts);
    release({ id: "s", location: { directory: `${directory}/foreign` }, time: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(JSON.stringify((await read()).facts), before);
    assert.equal(replayActivity((await read()).facts).rootActiveMilliseconds.s, 100,
      "queued original lifecycle facts retain their ordering when scoped evidence arrives");
  }, () => proof);
});

test("V2 location proof uses known Magic Context ancestry before writing buffered user activity", async () => {
  let release!: (value: any) => void;
  const proof = new Promise((resolve) => { release = resolve; });
  await fixture(async ({ directory, send, read }) => {
    await send("session.execution.started", { sessionID: "mc" }, 0, { location: undefined });
    await send("session.execution.succeeded", { sessionID: "mc" }, 100, { location: undefined });
    release({ id: "mc", location: { directory }, agent: "historian", parentID: "s", time: {} });
    // A scoped unrelated event is a deterministic delivery-queue barrier after
    // the proof callback, with no synthetic frontend or content event.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send("session.execution.started", { sessionID: "visible" }, 200);
    const { facts, totals } = await read();
    assert.equal(totals.sessionScopes.mc?.sourceScope, "magic-session");
    assert.equal(facts.some((fact: any) => fact.sessionID === "mc" && fact.kind === "lifecycle"), false);
  }, (id, directory) => id === "mc" ? proof : { id, location: { directory }, agent: "build", time: {} });
});

test("V2 location proof lookup concurrency is bounded and cleanup aborts unresolved lifecycle proof", async () => {
  const proof = new Promise(() => {});
  await fixture(async ({ send, calls, cleanup, read }) => {
    for (let index = 0; index < 12; index++) {
      await send("session.execution.started", { sessionID: `pending_${index}` }, index, { location: undefined });
    }
    await send("session.created", { sessionID: "classification_contender", agent: "build" }, 20);
    await send("session.step.started", { sessionID: "idle_contender", assistantMessageID: "idle_contender_msg", agent: "build", model, started: Date.now() }, 21);
    await send("session.step.ended", { sessionID: "idle_contender", assistantMessageID: "idle_contender_msg", tokens, cost: 1, finish: "stop" }, 22);
    assert.equal(calls.length, 4);
    assert.equal((await read()).facts.some((fact: any) => fact.kind === "lifecycle"), false);
    await cleanup();
    assert.ok(calls.every((call) => call.signal.aborted));
    assert.equal(calls.length, 4, "queued lookups cannot start after cleanup");
    assert.equal((await read()).facts.some((fact: any) => fact.kind === "lifecycle"), false);
  }, () => proof);
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
    assert.deepEqual(facts.filter((fact: any) => fact.kind === "lifecycle").map((fact: any) => fact.state), ["busy", "retry", "failed"]);
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
  assert.equal(completion.tokens, end.data.tokens);
  assert.equal(completion.cost, end.data.cost);
  assert.equal(completion.finish, end.data.finish);
  assert.equal(Object.hasOwn(completion, "data"), false, "completion identity is whitelisted, not the full SDK payload");
  assert.deepEqual(completion, { sessionID: "s", messageID: "msg_magic_id", tokens: end.data.tokens,
    cost: end.data.cost, finish: end.data.finish, created: end.created });

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
      if (fresh) assert.equal(facts.find((fact: any) => fact.state === "completed")?.timestamp, idle);
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

test("R08 earliest V2 gate never reads poison data or flushes pending on content events", async () => {
  const pendingProof = new Promise(() => {});
  await fixture(async ({ send, raw, directory, calls, read }) => {
    await send("session.execution.started", { sessionID: "pending" }, 0, { location: undefined });
    const before = JSON.stringify(await read());
    const lookups = calls.length;
    const hashSpy = spyOn(crypto, "createHash");
    let reads = 0;
    try {
    for (const type of ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.tool.progress",
      "session.text.started", "session.text.ended", "session.reasoning.started", "session.reasoning.ended", "session.tool.input.started"]) {
      for (const location of [{ directory }, { directory: `${directory}/foreign` }, undefined]) {
        await raw({ type, location, get data() { reads++; throw new Error("content data must remain unread"); } });
      }
    }
    assert.equal(reads, 0);
    assert.equal(calls.length, lookups);
    assert.equal(JSON.stringify(await read()), before);
    assert.equal(hashSpy.mock.calls.length, 0);
    } finally { hashSpy.mockRestore(); }
    await send("session.step.started", { sessionID: "pending", assistantMessageID: "msg_gate", agent: "build", model, started: Date.now() }, 10);
    assert.ok((await read()).facts.some((fact: any) => fact.state === "busy"), "only the allowed control boundary releases ownership");
  }, () => pendingProof);
});

test("R04 one failed activity append is retried by healthy control traffic from another SID with fixed identity", async () => {
  const append = ActivityLedger.prototype.append;
  const attempts: any[] = [];
  let failures = 0;
  const spy = spyOn(ActivityLedger.prototype, "append").mockImplementation(async function(this: ActivityLedger, event: Parameters<typeof append>[0]) {
    const busy = "state" in event && event.state === "busy" ? event : undefined;
    if (busy) {
      attempts.push(JSON.parse(JSON.stringify(busy)));
      if (!failures++) throw Object.assign(new Error("once EIO"), { code: "EIO" });
    }
    return append.call(this, event);
  });
  try {
    await fixture(async ({ send, read }) => {
      await send("session.execution.started", { sessionID: "s" }, 0);
      assert.equal((await read()).facts.length, 0);
      await send("session.idle", { sessionID: "other" }, 10);
      await send("session.execution.succeeded", { sessionID: "s" }, 100);
      const facts = (await read()).facts;
      assert.equal(replayActivity(facts).rootActiveMilliseconds.s, 100);
      assert.equal(facts.filter((fact: any) => fact.sessionID === "s" && fact.state === "busy").length, 1);
      assert.ok(attempts.length >= 2);
      assert.deepEqual(attempts[0], attempts[1], "retry must not change seq, time, instance or event identity");
    });
  } finally { spy.mockRestore(); }
});

test("R04 exhausted activity admission replaces writer and observation epoch only after accepted prefix drains", async () => {
  const append = ActivityLedger.prototype.append;
  let blocked = true;
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const spy = spyOn(ActivityLedger.prototype, "append").mockImplementation(async function(this: ActivityLedger, event: Parameters<typeof append>[0]) {
    if (blocked) throw Object.assign(new Error("persistent activity EIO"), { code: "EIO" });
    return append.call(this, event);
  });
  try {
    await fixture(async ({ send, read }) => {
      await send("session.execution.started", { sessionID: "s" }, 0);
      for (let index = 1; index <= 1025; index++) await send("session.retry.scheduled", { sessionID: "s" }, index);
      assert.deepEqual((await read()).facts, []);
      blocked = false;
      await send("session.execution.started", { sessionID: "s" }, 5000);
      await send("session.execution.succeeded", { sessionID: "s" }, 5100);
      const { facts } = await read();
      const starts = facts.filter((fact: any) => fact.state === "busy");
      assert.equal(starts.length, 2);
      assert.notEqual(starts[0].instanceID, starts[1].instanceID);
      assert.equal(replayActivity(facts).rootActiveMilliseconds.s, 1123,
        "1023ms committed prefix plus 100ms new execution, not the failed observation gap");
      assert.ok(warnings.mock.calls.some((call: any[]) => String(call[0]).includes("new observation epoch")));
    });
  } finally { spy.mockRestore(); warnings.mockRestore(); }
});

test("R06 disposal waits for an admitted in-flight append before releasing ownership", async () => {
  const append = ActivityLedger.prototype.append;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let blockedOnce = false;
  const spy = spyOn(ActivityLedger.prototype, "append").mockImplementation(async function(this: ActivityLedger, event: Parameters<typeof append>[0]) {
    if (!blockedOnce && "state" in event && event.state === "busy") {
      blockedOnce = true; entered(); await blocked;
    }
    return append.call(this, event);
  });
  try {
    await fixture(async ({ send, cleanup, read }) => {
      void send("session.execution.started", { sessionID: "s" }, 0);
      await started;
      let closed = false;
      const closing = cleanup().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(closed, false, "ownership cannot release while admitted append is in flight");
      release(); await closing;
      const { facts } = await read();
      assert.ok(facts.some((fact: any) => fact.state === "busy"));
      assert.ok(facts.some((fact: any) => fact.state === "stopped"));
    });
  } finally { release?.(); spy.mockRestore(); }
});

test("R07 exact A survives totals EIO, unrelated B with window one, and backend restart", async () => {
  await fixture(async ({ base, directory, send, read, restart }) => {
    await send("session.step.started", { sessionID: "A", assistantMessageID: "msg_A", agent: "build", model, started: base }, 0);
    const rename = fileSystem.rename;
    let failures = 0;
    const spy = spyOn(fileSystem, "rename").mockImplementation(async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (String(to) === join(directory, "totals.json") && failures === 0) {
        failures++; throw Object.assign(new Error("once totals EIO"), { code: "EIO" });
      }
      return rename(from, to);
    });
    try {
      await send("session.step.ended", { sessionID: "A", assistantMessageID: "msg_A", tokens, cost: 2, finish: "tool-calls" }, 10);
      assert.equal(failures, 1, "fault injection must hit actual totals commit");
      assert.ok((await read()).records.some((record: any) => record.messageID === "msg_A"));
      await send("session.step.started", { sessionID: "B", assistantMessageID: "msg_B", agent: "build", model, started: base + 20 }, 20);
      await send("session.step.ended", { sessionID: "B", assistantMessageID: "msg_B", tokens, cost: 3, finish: "stop" }, 30);
      await restart();
      const { totals, records } = await read();
      assert.equal(records.length, 1);
      assert.equal(totals.sessions.A.responseCount, 1);
      assert.equal(totals.sessions.A.cost, 2);
      assert.equal(totals.sessions.B.responseCount, 1);
      assert.equal(totals.sessions.B.cost, 3);
    } finally { spy.mockRestore(); }
  });
});

test("R12 active directory proof survives inactive LRU pressure and does not enter a lossy pending stream", async () => {
  await fixture(async ({ send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    for (let index = 0; index < 2050; index++) await send("session.metadata.updated", { sessionID: `noise_${index}` }, 0);
    await send("session.execution.succeeded", { sessionID: "s" }, 10, { location: undefined });
    for (let index = 1; index < 33; index++) {
      await send("session.execution.started", { sessionID: "s" }, index * 50, { location: undefined });
      await send("session.execution.succeeded", { sessionID: "s" }, index * 50 + 10, { location: undefined });
    }
    assert.equal(replayActivity((await read()).facts).rootActiveMilliseconds.s, 330);
  }, () => new Promise(() => {}));
});

test("R12 pending prefix and SID budget losses never bridge a separately observed busy", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.execution.started", { sessionID: "truncated" }, 0, { location: undefined });
    for (let index = 1; index <= 65; index++) {
      await send("session.retry.scheduled", { sessionID: "truncated" }, index, { location: undefined });
    }
    await send("session.step.started", { sessionID: "truncated", assistantMessageID: "partial", agent: "build", model, started: base + 70 }, 70);
    await send("session.execution.succeeded", { sessionID: "truncated" }, 100, { location: undefined });
    for (let index = 0; index < 257; index++) {
      await send("session.execution.started", { sessionID: `unknown_${index}` }, 0, { location: undefined });
    }
    await send("session.step.started", { sessionID: "unknown_0", assistantMessageID: "evicted", agent: "build", model, started: base + 110 }, 110);
    await send("session.execution.succeeded", { sessionID: "unknown_0" }, 200, { location: undefined });
    await send("session.execution.succeeded", { sessionID: "s" }, 330, { location: undefined });
    const { facts } = await read();
    const replay = replayActivity(facts);
    assert.equal(replay.rootActiveMilliseconds.s, 330);
    assert.equal(replay.rootActiveMilliseconds.truncated, 36);
    assert.equal(replay.rootActiveMilliseconds.unknown_0 ?? 0, 0);
    assert.equal(facts.some((fact: any) => fact.kind === "execution-scope"), false, "loss of observation cannot certify complete pure execution");
  }, () => { throw new Error("ownership unknown until a scoped control event"); });
});

test("R11 missing start or malformed work cannot certify a complete pure maintenance execution", async () => {
  for (const missing of ["execution", "step-id"] as const) await fixture(async ({ base, raw, send, directory, read }) => {
    if (missing !== "execution") {
      await send("session.execution.started", { sessionID: "s" }, 0);
      await raw({ type: "session.step.started", id: "unknown_step", created: base + 1,
        location: { directory }, data: { sessionID: "s" } });
    }
    await send("session.step.started", { sessionID: "s", assistantMessageID: "mc_partial", agent: "historian", model, started: base + 10 }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "mc_partial", tokens, cost: 0, finish: "stop" }, 80);
    await send("session.execution.succeeded", { sessionID: "s" }, 100);
    const { facts } = await read();
    assert.equal(facts.some((fact: any) => fact.kind === "execution-scope"), false);
    assert.equal(replayActivity(facts).rootActiveMilliseconds.s ?? 0, missing === "execution" ? 0 : 30);
  });
});

test("R11 late maintenance proof appends corrections for a closed execution without reopening its response", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "late_mc", agent: "build", model, started: base + 10 }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "late_mc", tokens, cost: 1, finish: "stop" }, 80);
    await send("session.execution.succeeded", { sessionID: "s" }, 100);
    assert.equal(replayActivity((await read()).facts).rootActiveMilliseconds.s, 100);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "late_mc", agent: "build",
      model: { providerID: "fixture", id: "magic-context" }, started: base + 10 }, 110);
    const { facts, totals } = await read();
    assert.equal(replayActivity(facts).rootActiveMilliseconds.s ?? 0, 0);
    assert.equal(totals.sessions.s?.responseCount ?? 0, 0);
  });
});

for (const mode of ["throw", "eof"] as const) test(`R05 ${mode} recovers subscription without bridging unknown time`, async () => {
  await fixture(async ({ base, send, disconnect, subscriptions, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.retry.scheduled", { sessionID: "s" }, 10);
    await disconnect(mode);
    await send("session.execution.started", { sessionID: "s" }, 1000);
    await send("session.execution.succeeded", { sessionID: "s" }, 1100);
    assert.equal(subscriptions(), 2);
    const facts = (await read()).facts;
    assert.equal(replayActivity(facts).rootActiveMilliseconds.s, 110);
    const starts = facts.filter((fact: any) => fact.state === "busy");
    assert.notEqual(starts[0].instanceID, starts[1].instanceID);
    assert.equal(starts[0].timestamp, base);
  });
});

test("R10 verified foreign ancestor classifies a local child but foreign lifecycle remains unwritable", async () => {
  await fixture(async ({ send, read }) => {
    await send("session.created", { sessionID: "child", agent: "build", parentID: "hidden" }, 0);
    await send("session.execution.started", { sessionID: "child" }, 0);
    await send("session.execution.succeeded", { sessionID: "child" }, 1000);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await read()).totals.sessionScopes?.hidden?.sourceScope === "magic-session") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await send("session.execution.started", { sessionID: "hidden" }, 1100, { location: undefined });
    const { facts, totals } = await read();
    assert.equal(totals.sessionScopes.hidden.sourceScope, "magic-session");
    assert.equal(replayActivity(facts, { sessionScopes: totals.sessionScopes }).rootActiveMilliseconds.child ?? 0, 0);
    assert.equal(facts.some((fact: any) => fact.sessionID === "hidden" && fact.kind === "lifecycle"), false);
  }, (id, directory) => ({ id, agent: id === "hidden" ? "historian" : "build",
    parentID: id === "child" ? "hidden" : undefined, location: { directory: id === "hidden" ? `${directory}/other` : directory }, time: {} }));
});

test("R16 backend preserves omitted cost/cache and accepts explicit zero revisions", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_partial", agent: "build", model, started: base }, 0);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_partial", tokens, cost: 2, finish: "stop" }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_partial",
      tokens: { input: 24, output: 14, reasoning: 6 } as any, finish: "stop" } as any, 20);
    let result = await read();
    assert.equal(result.totals.sessions.s.cost, 2);
    assert.equal(result.totals.sessions.s.tokens.cacheRead, 9);
    assert.equal(result.totals.sessions.s.tokens.cacheWrite, 2);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_partial",
      tokens: { input: 24, output: 14, reasoning: 6, cache: { read: 0, write: 0 } }, cost: 0, finish: "stop" }, 30);
    result = await read();
    assert.equal(result.totals.sessions.s.cost, 0);
    assert.equal(result.totals.sessions.s.tokens.cacheRead, 0);
    assert.equal(result.totals.sessions.s.tokens.cacheWrite, 0);
    assert.equal(result.totals.sessions.s.responseCount, 1);
  });
});

test("R11 fully observed pure maintenance execution has zero own time without hiding the session", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0, { location: undefined });
    await send("session.step.started", { sessionID: "s", assistantMessageID: "msg_mc", agent: "build",
      model: { providerID: "fixture", id: "magic-context" }, started: base + 10 }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "msg_mc", tokens, cost: 2, finish: "stop" }, 80);
    await send("session.execution.succeeded", { sessionID: "s" }, 100, { location: undefined });
    const { facts, totals } = await read();
    assert.ok(facts.some((fact: any) => fact.kind === "execution-scope" && fact.coverage === "complete"));
    assert.equal(replayActivity(facts).rootActiveMilliseconds.s ?? 0, 0);
    assert.notEqual(totals.sessionScopes?.s?.sourceScope, "magic-session");
    assert.equal(totals.sessions.s?.responseCount ?? 0, 0);
    assert.ok(facts.filter((fact: any) => fact.kind === "lifecycle").every((fact: any) => fact.executionID && fact.sourceEventID && fact.sourceSequence));
  });
});

test("R11 mixed maintenance subtracts only proven span and restores overlapping normal tool and child work", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "normal", agent: "build", model, started: base + 10 }, 10);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "normal", tokens, cost: 1, finish: "tool-calls" }, 20);
    await send("session.step.started", { sessionID: "s", assistantMessageID: "mc", agent: "build",
      model: { providerID: "fixture", id: "magic-context" }, started: base + 30 }, 30);
    await send("session.created", { sessionID: "child", parentID: "s", agent: "build" }, 35);
    await send("session.execution.started", { sessionID: "child" }, 35);
    await send("session.tool.called", { sessionID: "s", assistantMessageID: "normal", id: "tool_ordinary", get input() { throw new Error("do not read tool input"); } }, 40);
    await send("session.tool.success", { sessionID: "s", assistantMessageID: "normal", id: "tool_ordinary", get output() { throw new Error("do not read tool output"); } }, 50);
    await send("session.step.ended", { sessionID: "s", assistantMessageID: "mc", tokens, cost: 2, finish: "stop" }, 60);
    await send("session.execution.succeeded", { sessionID: "child" }, 65);
    await send("session.execution.succeeded", { sessionID: "s" }, 100);
    const { facts } = await read();
    const replay = replayActivity(facts);
    assert.equal(replay.timelines.get("s")?.activeMilliseconds, 80);
    assert.equal(replay.rootActiveMilliseconds.s, 95);
    assert.equal(facts.some((fact: any) => fact.kind === "execution-scope"), false);
  });
});

test("R17 adapter retires full starts while retaining compact identity for late exact corrections", () => {
  const adapter = createV2EventAdapter();
  for (let index = 0; index < 2000; index++) {
    const sessionID = "s"; const assistantMessageID = `msg_${index}`;
    adapter.events({ type: "session.step.started", id: `start_${index}`, created: index * 10,
      data: { sessionID, assistantMessageID, agent: "build", model, started: index * 10 } });
    adapter.events({ type: "session.step.ended", id: `end_${index}`, created: index * 10 + 1,
      data: { sessionID, assistantMessageID, tokens, cost: 1, finish: "stop" } });
  }
  assert.equal(adapter.retainedState().activeResponses, 0);
  const correction = adapter.events({ type: "session.step.ended", id: "correction", created: 30_000,
    data: { sessionID: "s", assistantMessageID: "msg_0", tokens, cost: 2, finish: "stop" } });
  const info = correction.find((event) => event.type === "message.updated")?.properties.info;
  assert.equal(info.model.modelID, "fixture-model");
  assert.equal(info.time.created, 0);
  assert.equal(adapter.retainedState().activeResponses, 0);
});

test("R08 content gate scaling keeps poison payload reads and retained metadata exactly zero", () => {
  for (const count of [1000, 2000, 4000]) {
    const adapter = createV2EventAdapter();
    let reads = 0;
    const before = performance.now();
    for (let index = 0; index < count; index++) {
      const event = { type: index % 2 ? "session.text.delta" : "session.tool.progress",
        get data() { reads++; throw new Error("poison body"); } };
      assert.deepEqual(adapter.events(event), []);
    }
    const elapsed = performance.now() - before;
    assert.equal(reads, 0);
    assert.deepEqual(adapter.retainedState(), { activeResponses: 0, compactWork: 0, compactExecutions: 0, durableIdentities: 0, proofWorkChecks: 0 });
    console.log(`[server content gate] ${count} ignored events: ${elapsed.toFixed(2)}ms, payloadReads=${reads}, retained=0`);
  }
});

test("R11 SDK ordering closes same-millisecond execution and old terminal cannot stop the newer execution", async () => {
  await fixture(async ({ base, send, read }) => {
    await send("session.execution.started", { sessionID: "s" }, 0);
    await send("session.execution.succeeded", { sessionID: "s" }, 0);
    await send("session.execution.started", { sessionID: "s" }, 0);
    // Original sequence 2 belongs to the first execution, despite late delivery.
    await send("session.execution.succeeded", { sessionID: "s" }, 0,
      { id: "late_old_terminal", durable: { aggregateID: "s", seq: 2, version: 1 } });
    await send("session.execution.succeeded", { sessionID: "s" }, 100);
    const { facts } = await read();
    assert.equal(replayActivity(facts).rootActiveMilliseconds.s, 100);
    const starts = facts.filter((fact: any) => fact.state === "busy");
    const late = facts.find((fact: any) => fact.sourceEventID === "late_old_terminal");
    assert.equal(late.executionID, starts[0].executionID);
    assert.notEqual(late.executionID, starts[1].executionID);
    assert.equal(late.timestamp, base);
  });
});
