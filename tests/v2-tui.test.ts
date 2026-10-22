import type { OpenCodeEvent,SessionInfo,SessionStepEnded,SessionStepStarted } from "@opencode/client";
import type { KeymapLayer,Page,Route,SlotClaim } from "@opencode/plugin/tui/context";
import { RGBA } from "@opentui/core";
import assert from "node:assert/strict";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { normalizeActivityEvent,replayActivity,type ActivityEvent } from "../src/activity.js";
import { parentProofPort,tuiReadModel } from "../src/tui-read-model.js";
import { createV2TuiBridge,type V2TuiContext } from "../src/tui-v2.js";
import {
buildSessionDetailsTree,
cacheSessionParentFromEvent,
createRuntimeStore,handleMessageUpdated,handleSessionLifecycle,
hasLiveTaskWallActivity,
projectSessionTotals,
recordStepStarted,
recordTuiActivityFact,recordTuiObservationLifecycle,
registerTokenPulseCommands,
reloadActivity,
reloadHistory,
resolveOptions,
retireCanonicalResponses,
taskWallTimeForSession,
tokenPulseBindings,
tuiActivityDiagnostics,tuiActivityTimes
} from "../src/tui.js";
import type { createV2EventAdapter } from "../src/v2-server.js";

const tokens = { input: 12, output: 7, reasoning: 3, cache: { read: 9, write: 2 } };
const model = { providerID: "fixture", id: "fixture-model" };

/** Typed implementations for the consumed contracts; touching any unimplemented
 * host capability is an immediate failure, not a permissive any/no-op fallback. */
function strictPartial<Type extends object>(value: Partial<Type>, name: string): Type {
  return new Proxy(value as Type, { get(target, key, receiver) {
    if (!Reflect.has(target, key)) throw new Error(`TUI unexpectedly accessed ${name}.${String(key)}`);
    return Reflect.get(target, key, receiver);
  } });
}

function session(id: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return { id, projectID: "fixture", tokens, cost: 0, time: { created: 1, updated: 1 }, location: { directory: "/fixture" }, ...patch };
}

type FixtureEvent = Extract<OpenCodeEvent, { data: { sessionID: string } }>;
type FixtureData = { [Event in FixtureEvent as Event["type"]]: Event["data"] };
type NormalizedEvent = ReturnType<ReturnType<typeof createV2EventAdapter>["events"]>[number];

function host(directory = "/fixture", options: Record<string, unknown> = {}) {
  let listener: ((event: { details: OpenCodeEvent }) => void) | undefined;
  let stopCount = 0;
  let listenCount = 0;
  let lookups = 0;
  let mode = "base";
  let route: Route = { type: "session", sessionID: "root" };
  let dialogClosed: (() => void) | undefined;
  let dialogCount = 0;
  let dialogClearCount = 0;
  const dialogs: unknown[] = [];
  const slots: SlotClaim[] = [];
  const pages: Page[] = [];
  const layers: KeymapLayer[] = [];
  const sessions = new Map<string, SessionInfo>();
  const color = (id: string) => RGBA.fromHex(id === "background" ? "#111111" : "#eeeeee");
  const theme = {
    hue: { interactive: { 500: color("primary") }, accent: { 500: color("accent") } },
    text: { base: color("text"), muted: color("muted"), action: { secondary: { base: color("secondary") } }, feedback: { info: { base: color("info") } } },
    background: { base: color("background"), raised: { base: color("panel"), high: color("element") } }, border: { base: color("border") },
  };
  type Theme = V2TuiContext["theme"];
  const resolvedTheme = strictPartial<Theme>({
    hue: strictPartial<Theme["hue"]>({
      interactive: strictPartial<Theme["hue"]["interactive"]>(theme.hue.interactive, "theme.hue.interactive"),
      accent: strictPartial<Theme["hue"]["accent"]>(theme.hue.accent, "theme.hue.accent"),
    }, "theme.hue"),
    text: strictPartial<Theme["text"]>({
      get base() { return theme.text.base; }, muted: theme.text.muted,
      action: strictPartial<Theme["text"]["action"]>({
        secondary: strictPartial<Theme["text"]["action"]["secondary"]>(theme.text.action.secondary, "theme.text.action.secondary"),
      }, "theme.text.action"),
      feedback: strictPartial<Theme["text"]["feedback"]>({
        info: strictPartial<Theme["text"]["feedback"]["info"]>(theme.text.feedback.info, "theme.text.feedback.info"),
      }, "theme.text.feedback"),
    }, "theme.text"),
    background: strictPartial<Theme["background"]>({ base: theme.background.base,
      raised: strictPartial<Theme["background"]["raised"]>(theme.background.raised, "theme.background.raised"),
    }, "theme.background"),
    border: strictPartial<Theme["border"]>(theme.border, "theme.border"),
  }, "theme");
  const context: V2TuiContext = {
    options, location: { directory }, app: { version: "2.0.27", channel: "fixture" },
    renderer: strictPartial<V2TuiContext["renderer"]>({ width: 100, height: 40 }, "renderer"),
    theme: resolvedTheme, themeMode: "dark",
    attention: strictPartial<V2TuiContext["attention"]>({}, "attention"),
    markdown: strictPartial<V2TuiContext["markdown"]>({}, "markdown"),
    storage: strictPartial<V2TuiContext["storage"]>({}, "storage"),
    client: strictPartial<V2TuiContext["client"]>({}, "client"),
    data: strictPartial<V2TuiContext["data"]>({
      listen(callback) { listener = callback; listenCount++; return () => { stopCount++; }; },
      location: strictPartial<V2TuiContext["data"]["location"]>({ default: () => ({ directory }) }, "data.location"),
      session: strictPartial<V2TuiContext["data"]["session"]>({
        get(id) { lookups++; return sessions.get(id); },
        message: strictPartial<V2TuiContext["data"]["session"]["message"]>({}, "data.session.message"),
      }, "data.session"),
    }, "data"),
    keymap: strictPartial<V2TuiContext["keymap"]>({ layer(factory) { layers.push(factory()); }, mode: {
      current: () => mode, push(next: string) { const previous = mode; mode = next; return () => { mode = previous; }; },
    } }, "keymap"),
    ui: strictPartial<V2TuiContext["ui"]>({
      router: { current: () => route, register(page) { pages.push(page); return () => { pages.splice(pages.indexOf(page), 1); }; },
        navigate(next) { route = next.type === "plugin" ? { id: "fixture-plugin-route", ...next } : next; } },
      slot(claim) { slots.push(claim); return () => { slots.splice(slots.indexOf(claim), 1); }; },
      toast: { show() {} },
      dialog: strictPartial<V2TuiContext["ui"]["dialog"]>({
        show(render, closed) { dialogCount++; dialogs.push(render); dialogClosed = closed; mode = "dialog"; }, set(value) { dialogs.push(value); },
        clear() { dialogClearCount++; mode = "base"; dialogClosed?.(); dialogClosed = undefined; },
      }, "ui.dialog"),
    }, "ui"),
  };
  let seq = 0;
  const base = Date.now();
  const raw = <Type extends keyof FixtureData>(type: Type, data: FixtureData[Type], offset = 0, extra = {}) => ({ id: `evt_${++seq}`, created: base + offset,
    type, data, durable: { seq, aggregateID: data.sessionID, version: 1 as const }, location: { directory }, ...extra });
  const send = <Type extends keyof FixtureData>(type: Type, data: FixtureData[Type], offset = 0, extra = {}) => listener?.({ details: raw<Type>(type, data, offset, extra) as OpenCodeEvent });
  return { context, raw, send, base, slots, pages, layers, sessions, theme, dialogs,
    listener: () => listener!, counts: () => ({ stopCount, listenCount, lookups, dialogCount, dialogClearCount }),
    setMode: (value: string) => { mode = value; }, setRoute: (value: Route) => { route = value; }, route: () => route,
    closeDialog: () => { mode = "base"; dialogClosed?.(); },
  };
}

function runtime(f: ReturnType<typeof host>) {
  const bridge = createV2TuiBridge(f.context, tokenPulseBindings(resolveOptions(f.context.options)));
  const store = createRuntimeStore(1, f.base);
  const facts: ActivityEvent[] = [];
  const save = (input: Record<string, any>, event: NormalizedEvent) => {
    const fact = normalizeActivityEvent({ ...input, version: 2, instanceID: "backend", observedAt: f.base + 10000000,
      sourceEventID: event.sourceEventID, sourceSequence: event.sourceSequence,
      eventID: input.eventID ?? `canonical:${event.sourceEventID}`, executionID: input.executionID ?? event.executionID });
    if (fact) facts.push(fact);
  };
  const on = bridge.api.event.on as (type: string, callback: (event: NormalizedEvent) => void) => () => void;
  on("message.updated", (event) => handleMessageUpdated(store, bridge.api, event.properties, event, 4, f.base + 1000));
  on("session.next.step.started", (event) => recordStepStarted(store, event.properties, event));
  on("session.updated", (event) => cacheSessionParentFromEvent(store, event));
  on("pulse.activity", (event) => { recordTuiActivityFact(store, event.properties.fact, event); save(event.properties.fact, event); });
  for (const type of ["server.connected", "server.instance.disposed"]) on(type, (event) => recordTuiObservationLifecycle(store, type, event.properties, event));
  for (const type of ["session.status", "session.completed", "session.error", "session.aborted", "session.next.retried"]) {
    on(type, (event) => {
      save({ kind: "lifecycle", sessionID: event.properties.sessionID, timestamp: event.timestamp,
        state: type === "session.status" ? "busy" : type === "session.next.retried" ? "retry" : "idle" }, event);
      return handleSessionLifecycle(store, bridge.api, type, event.properties, event, 4);
    });
  }
  return { bridge, store, facts, totals: (id = "root") => projectSessionTotals(store.totalsLedger,
    [...store.optimistic.values()], store.sessionParents, id), async dispose() { await bridge.dispose(); store.disposeSignals(); } };
}

test("V2 bridge accepts special MID/SID keys through first usage, replay, correction, canonical retirement and fresh JSON", async () => {
  for (const key of ["constructor", "toString", "__proto__"]) for (const [sid, mid] of [["root", key], [key, "message"], [key, key]]) {
    const f = host(); const r = runtime(f); let fresh: ReturnType<typeof runtime> | undefined; let directory: string | undefined;
    const commitCanonical = (target: "open" | "settled") => {
      const record = r.store.optimistic.get(mid)!;
      const ledger = { ...r.store.totalsLedger, sessions: Object.fromEntries([[sid, r.totals(sid).direct]]), open: {}, settled: {},
        [target]: Object.fromEntries([[mid, { sessionID: sid, tokens: record.tokens, cost: record.cost, quality: "exact", update: (record as any).update }]]) };
      r.store.totalsLedger = JSON.parse(JSON.stringify(ledger));
      retireCanonicalResponses(r.store);
      assert.equal(r.store.optimistic.size, 0); assert.equal(tuiActivityDiagnostics(r.store).runtimeResponses, 0);
    };
    try {
      f.send("session.step.started", { sessionID: sid, assistantMessageID: mid, model, started: f.base, agent: "build" });
      assert.ok(r.store.active.has(mid), `${sid}/${mid}: inherited dictionary members must not reject a first start`);
      const ended = f.raw("session.step.ended", { sessionID: sid, assistantMessageID: mid, tokens, cost: 2, finish: "stop" }, 10);
      assert.doesNotThrow(() => f.listener()({ details: ended as OpenCodeEvent }));
      assert.equal(r.totals(sid).direct.responseCount, 1); assert.equal(r.totals(sid).direct.tokens.output, 7);
      f.listener()({ details: ended as OpenCodeEvent });
      assert.equal(r.totals(sid).direct.responseCount, 1);
      commitCanonical("open");
      const corrected = f.raw("session.step.ended", { sessionID: sid, assistantMessageID: mid,
        tokens: { input: 12, output: 2, reasoning: 3 }, cost: 0, finish: "stop" } as any, 20);
      f.listener()({ details: corrected as OpenCodeEvent });
      assert.equal(r.totals(sid).direct.responseCount, 1); assert.equal(r.totals(sid).direct.tokens.output, 2);
      assert.equal(r.totals(sid).direct.tokens.cacheRead, 9); assert.equal(r.totals(sid).direct.cost, 0);
      commitCanonical("settled");
      fresh = runtime(f); fresh.store.totalsLedger = JSON.parse(JSON.stringify(r.store.totalsLedger));
      f.listener()({ details: ended as OpenCodeEvent }); f.listener()({ details: corrected as OpenCodeEvent });
      assert.equal(fresh.totals(sid).direct.responseCount, 1); assert.equal(fresh.totals(sid).direct.tokens.output, 2);
      const cache = process.env.TMPDIR ?? join(process.env.HOME!, ".cache", "tokpulse-test-tmp");
      await mkdir(cache, { recursive: true }); directory = await mkdtemp(join(cache, "tui-special-keys-"));
      const path = join(directory, "history.jsonl");
      await writeFile(path, ""); await writeFile(join(directory, "totals.json"), JSON.stringify(r.store.totalsLedger));
      const beforeRead = fresh.store.totalsLedger;
      await reloadHistory(fresh.store, fresh.bridge.api, path, join(directory, "totals.json"), 1);
      assert.notEqual(fresh.store.totalsLedger, beforeRead, "fresh safe-fd JSON snapshot must actually be consumed");
      assert.ok(Object.hasOwn(fresh.store.totalsLedger.sessions, sid)); assert.ok(Object.hasOwn(fresh.store.totalsLedger.settled, mid));
      f.listener()({ details: corrected as OpenCodeEvent });
      assert.equal(fresh.totals(sid).direct.responseCount, 1); assert.equal(fresh.totals(sid).direct.tokens.output, 2);
      assert.equal(buildSessionDetailsTree(fresh.store, sid).nodes.find((node) => node.sessionID === sid)!.direct.responseCount, 1);
      f.send("session.agent.selected", { sessionID: sid, agent: "dreamer" } as any, 30);
      assert.equal(buildSessionDetailsTree(fresh.store, sid).nodes.length, 0, "late scope proof must remain an own SID key");
      assert.equal(Object.hasOwn(Object.prototype, "tokens"), false);
    } finally { await fresh?.dispose(); await r.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); }
  }
});

test("V2 stale in-flight ownership sync cannot prove or flush fresh reconnect pending and fresh RPC retries", async () => {
  for (const transport of ["server.connected", "server.instance.disposed"]) {
  const f = host(); const r = runtime(f);
  const ids = ["root", "sid-1", "sid-2", "sid-3"];
  const release: (() => void)[] = [];
  let active = 0; let peak = 0;
  Object.assign(f.context.data.session, { async sync(id: string) {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => { release.push(resolve); });
    f.sessions.set(id, session(id)); active--;
  } });
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    f.listener()({ details: { type: "server.connected" } as any });
    for (const id of ids) f.send("session.execution.started", { sessionID: id }, 0, { location: undefined });
    await drain(); assert.equal(release.length, 4);
    f.listener()({ details: { type: transport } as any });
    for (const id of ids) f.send("session.execution.started", { sessionID: id }, 100, { location: undefined });
    for (let i = 0; i < 4; i++) {
      release[i](); await drain();
      assert.equal(tuiActivityDiagnostics(r.store).ingested, 0, "stale RPC cannot flush fresh epoch based on its old metadata result");
      assert.equal(release.length, 5 + i, "fresh same-SID pending remains schedulable when its old RPC frees the slot");
    }
    f.send("session.retry.scheduled", { sessionID: "root" } as any, 110, { location: undefined });
    assert.equal(tuiActivityDiagnostics(r.store).ingested, 0, "old host cache cannot bypass the fresh sync still in flight");
    for (let i = 4; i < 8; i++) release[i](); await drain();
    assert.equal(tuiActivityDiagnostics(r.store).ingested, 5);
    assert.equal(r.bridge.retainedState().pendingSessions, 0); assert.equal(peak, 4); assert.equal(r.bridge.retainedState().lookupCount, 8);
  } finally { await r.dispose(); for (const finish of release) finish(); await drain(); }
  }
});

test("V2 directory proof rejects foreign/conflicting envelopes and bounds unknown SID lookup without route inference", async () => {
  const f = host(); const r = runtime(f);
  try {
    for (const extra of [{ location: undefined }, { location: undefined, data: { sessionID: "root", location: { directory: "/foreign" } } },
      { data: { sessionID: "root", location: { directory: "/foreign" } } }, { location: { directory: "/foreign" } }]) {
      f.send("session.execution.started", { sessionID: "root" }, 0, extra);
    }
    assert.equal(r.store.taskRuns.size, 0, "current route is not ownership proof");
    assert.equal(r.store.active.size, 0); assert.equal(r.store.optimistic.size, 0);
    f.send("session.step.started", { sessionID: "root", assistantMessageID: "proof-model", model, agent: "build", started: f.base }, 0, { location: undefined });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(r.bridge.retainedState().lookupCount, 1);
    f.sessions.set("root", session("root"));
    f.send("session.retry.scheduled", { sessionID: "root" } as any, 10, { location: undefined });
    assert.match(r.store.active.get("proof-model")!.model!, /fixture-model/, "queued controls retain official model.id without tool input");
    f.send("session.execution.succeeded", { sessionID: "root" }, 20, { location: undefined });
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 100), 20, "lookup proof releases original pending start");
    const before = r.bridge.retainedState();
    const bump = r.store.revision();
    for (const type of ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "message.part.updated", "message.part.delta", "session.tool.progress"]) {
      for (let i = 0; i < 100; i++) f.listener()({ details: { type,
        get data() { throw new Error("payload was read"); }, get location() { throw new Error("location was read"); } } as any });
    }
    assert.deepEqual(r.bridge.retainedState(), before); assert.equal(r.store.revision(), bump);
  } finally { await r.dispose(); }
});

test("V2 missing-location metadata sync has four host requests maximum and bounded unproven queues", async () => {
  const f = host(); const r = runtime(f);
  const releases: (() => void)[] = [];
  let peak = 0; let active = 0;
  Object.assign(f.context.data.session, { async sync(id: string) {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => { releases.push(resolve); });
    active--; f.sessions.set(id, session(id));
  } });
  try {
    for (let i = 0; i < 400; i++) f.send("session.execution.started", { sessionID: `unknown-${i}` }, i, { location: undefined });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(peak, 4); assert.equal(r.bridge.retainedState().inFlight, 4);
    assert.equal(r.bridge.retainedState().pendingSessions, 256);
    assert.equal(r.store.taskRuns.size, 0);
    f.send("session.tool.called", { sessionID: "unknown-399", assistantMessageID: "m", id: "tool",
      get input() { throw new Error("unproven control queue must not read tool body"); },
      get parts() { throw new Error("unproven control queue must not read parts"); } } as any, 400, { location: undefined });
    for (let i = 0; i < 150; i++) {
      f.send("session.retry.scheduled", { sessionID: "unknown-399" } as any, 401 + i, { location: undefined });
      const retained = r.bridge.retainedState();
      assert.equal(retained.pendingSessions, 256);
      assert.ok(retained.pendingEvents - 255 <= 64, "the other 255 SID queues each have one event; this SID cannot exceed 64");
    }
    const before = r.bridge.retainedState();
    for (const type of ["message.part.delta", "message.part.updated", "session.text.delta", "session.reasoning.delta", "session.tool.input.delta"]) {
      f.listener()({ details: { type, get data() { throw new Error("pending delta must not release proof or query"); } } as any });
    }
    assert.deepEqual(r.bridge.retainedState(), before);
    await r.bridge.dispose();
    for (const release of releases) release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(r.bridge.retainedState().inFlight, 0);
    assert.equal(r.bridge.retainedState().pendingSessions, 0);
    assert.equal(r.store.taskRuns.size, 0, "late host sync cannot deliver after disposal");
  } finally { for (const release of releases) release(); await r.dispose(); }
});

test("V2 same-millisecond order and transport epochs use shared time without unknown gap or stale terminal closure", async () => {
  const f = host(); const r = runtime(f);
  const now = Date.now;
  try {
    Date.now = () => f.base;
    f.listener()({ details: { type: "server.connected" } as any });
    f.send("session.execution.started", { sessionID: "root" });
    f.send("session.execution.succeeded", { sessionID: "root" });
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 10000), 0);
    assert.equal(hasLiveTaskWallActivity(r.store), false);
    f.send("session.execution.started", { sessionID: "root" });
    assert.equal(tuiActivityTimes(r.store, "root", f.base + 10).active, true);
    f.send("session.retry.scheduled", { sessionID: "root" } as any, 10);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 10), 10);
    Date.now = () => f.base + 1000;
    f.listener()({ details: { type: "server.connected" } as any });
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 5000), 10);
    assert.equal(hasLiveTaskWallActivity(r.store), false);
    const stale = f.raw("session.execution.succeeded", { sessionID: "root" }, 20);
    f.send("session.execution.started", { sessionID: "root" }, 1000);
    f.listener()({ details: stale as OpenCodeEvent });
    assert.equal(tuiActivityTimes(r.store, "root", f.base + 1100).active, true);
    assert.equal(r.store.sessionRuntime.get("root")?.status, "busy");
    f.send("session.execution.succeeded", { sessionID: "root" }, 1200);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 3600000), 210);
    assert.equal(hasLiveTaskWallActivity(r.store), false);
    f.send("session.execution.started", { sessionID: "root" }, 2000);
    f.send("session.retry.scheduled", { sessionID: "root" } as any, 2010);
    f.listener()({ details: { type: "server.instance.disposed" } as any });
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 3600000), 220);
    assert.equal(hasLiveTaskWallActivity(r.store), false);
    const oldTerminal = f.raw("session.execution.succeeded", { sessionID: "root" }, 2015);
    f.send("session.retry.scheduled", { sessionID: "root" } as any, 3000);
    f.listener()({ details: oldTerminal as OpenCodeEvent });
    assert.equal(tuiActivityTimes(r.store, "root", f.base + 3010).active, true);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 3010), 230, "same-execution retry resumes only its fresh observed suffix");
    f.send("session.execution.succeeded", { sessionID: "root" }, 3020);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 3600000), 240);
  } finally { Date.now = now; await r.dispose(); }
});

test("V2 partial exact corrections preserve absent cost/cache while explicit zeros remain authoritative", async () => {
  const f = host(); const r = runtime(f);
  try {
    f.send("session.step.started", { sessionID: "root", assistantMessageID: "m", model, started: f.base, agent: "build" });
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "m", tokens, cost: 2, finish: "stop" }, 10);
    r.store.totalsLedger.sessions.root = r.totals().direct;
    r.store.totalsLedger.settled.m = { sessionID: "root", tokens: { input: 8, output: 7, reasoning: 3, cacheRead: 9, cacheWrite: 2 }, cost: 2,
      quality: "exact", update: (r.store.optimistic.get("m") as any).update };
    retireCanonicalResponses(r.store);
    r.store.records = []; r.store.diskRecords = [];
    assert.equal(tuiActivityDiagnostics(r.store).runtimeResponses, 0);
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "m", tokens: { input: 4, output: 5, reasoning: 6 }, finish: "stop" } as any, 20);
    assert.equal(r.totals().direct.cost, 2); assert.equal(r.totals().direct.tokens.cacheRead, 9); assert.equal(r.totals().direct.tokens.cacheWrite, 2);
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "m", tokens: { input: 4, output: 5, reasoning: 6, cache: { read: 0, write: 0 } }, cost: 0, finish: "stop" }, 30);
    assert.equal(r.totals().direct.cost, 0); assert.equal(r.totals().direct.tokens.cacheRead, 0); assert.equal(r.totals().direct.responseCount, 1);
  } finally { await r.dispose(); }
});

test("V2 out-of-order execution start refines a retry-only partial observation without leaving a live tail", async () => {
  const f = host(); const r = runtime(f);
  try {
    const started = f.raw("session.execution.started", { sessionID: "root" }, 0);
    f.send("session.retry.scheduled", { sessionID: "root" } as any, 10);
    f.listener()({ details: started as OpenCodeEvent });
    f.send("session.execution.succeeded", { sessionID: "root" }, 20);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 3600000), 20);
    assert.equal(hasLiveTaskWallActivity(r.store), false);
    assert.equal(r.store.sessionRuntime.get("root")?.status, "idle");
  } finally { await r.dispose(); }
});

test("V2 canonical replay and optimistic overlay share pure/mixed math, retaining normal tool and child intersections", async () => {
  for (const pure of [false, true]) {
    const f = host(); const r = runtime(f);
    try {
      f.send("session.execution.started", { sessionID: "root" });
      if (!pure) {
        f.send("session.step.started", { sessionID: "root", assistantMessageID: "normal", model, started: f.base, agent: "build" });
        f.send("session.step.ended", { sessionID: "root", assistantMessageID: "normal", finish: "tool-calls" } as any, 10);
        f.send("session.tool.called", { sessionID: "root", assistantMessageID: "normal", id: "tool" } as any, 15);
      }
      f.send("session.step.started", { sessionID: "root", assistantMessageID: "mc", model, started: f.base + 20, agent: "historian" }, 20);
      f.send("session.step.ended", { sessionID: "root", assistantMessageID: "mc", finish: "stop" } as any, 80);
      if (!pure) f.send("session.tool.success", { sessionID: "root", assistantMessageID: "normal", id: "tool" } as any, 70);
      f.send("session.execution.succeeded", { sessionID: "root" }, 100);
      assert.equal(tuiActivityTimes(r.store, "root", f.base + 1000).directMilliseconds, pure ? 0 : 90);
      r.store.sessionParents = new Map([["child", "root"]]);
      f.send("session.execution.started", { sessionID: "child" }, 30);
      f.send("session.execution.succeeded", { sessionID: "child" }, 90);
      const live = taskWallTimeForSession(r.store, "root", f.base + 1000);
      assert.equal(live, pure ? 60 : 100);
      r.store.activityEvents = r.facts.filter((fact) => fact.kind === "lifecycle");
      assert.equal(taskWallTimeForSession(r.store, "root", f.base + 1000), live,
        "a canonical terminal without all work/scope proof cannot retire or weaken a complete local observation");
      assert.ok(tuiActivityDiagnostics(r.store).overlayFacts > 0);
      r.store.activityEvents = r.facts;
      assert.equal(taskWallTimeForSession(r.store, "root", f.base + 3600000), live);
      assert.equal(tuiActivityDiagnostics(r.store).overlayFacts, 0, "source/execution identity retires the entire confirmed overlay, not a timestamp guess");
      assert.equal(hasLiveTaskWallActivity(r.store), false);
      const fresh = createRuntimeStore(1, f.base + 3600000);
      fresh.activityEvents = r.facts; fresh.sessionParents = r.store.sessionParents;
      assert.equal(taskWallTimeForSession(fresh, "root", f.base + 3600000), live);
      fresh.disposeSignals();
    } finally { await r.dispose(); }
  }
});

test("weaker canonical work cannot replace a confirmed live maintenance classification", async () => {
  const f = host(), r = runtime(f); const directory = await mkdtemp(join(process.env.TMPDIR!, "tui-weak-canonical-")), path = join(directory, "runs.jsonl");
  try {
    f.send("session.execution.started", { sessionID: "root" }, 0);
    f.send("session.step.started", { sessionID: "root", assistantMessageID: "m", model, agent: "historian", started: f.base + 20 }, 20);
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "m", tokens, cost: 1, finish: "stop" }, 80);
    f.send("session.execution.succeeded", { sessionID: "root" }, 100);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 1000), 0);
    const weak = r.facts.map((fact) => fact.kind === "work" ? normalizeActivityEvent({ ...fact, measurementScope: { version: 1, sourceScope: "user", reasons: [] } })! : fact);
    assert.ok((replayActivity(weak).activeMillisecondsByRoot.get("root") ?? 0) > 0, "the weaker canonical stream alone really would revive MC edges");
    await writeFile(path, weak.map((fact) => JSON.stringify(fact)).join("\n") + "\n"); await reloadActivity(r.store, r.bridge.api, path);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 1000), 0); assert.ok(tuiActivityDiagnostics(r.store).overlayFacts > 0);
    const before = tuiActivityDiagnostics(r.store);
    const strong = r.facts.filter((fact) => fact.kind === "work");
    await (await import("node:fs/promises")).appendFile(path, strong.map((fact) => JSON.stringify(fact)).join("\n") + "\n");
    await reloadActivity(r.store, r.bridge.api, path);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 1000), 0); assert.equal(tuiActivityDiagnostics(r.store).overlayFacts, 0);
    assert.equal(tuiActivityDiagnostics(r.store).canonicalResets, before.canonicalResets);
    assert.equal(tuiActivityDiagnostics(r.store).canonicalIngested - before.canonicalIngested, 2, "same IDs with genuinely stronger scope are accepted refinements, not duplicates");
  } finally { await r.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("parent ownership recovers from a transient metadata failure without a retry storm", async () => {
  const f = host(), r = runtime(f), model = tuiReadModel(r.store), calls = new Map<string, number>();
  let active = 0, peak = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  Object.assign(f.context.data.session, { sync: async (id: string) => {
    active++; peak = Math.max(peak, active); calls.set(id, (calls.get(id) ?? 0) + 1);
    try { if (id === "child" && calls.get(id) === 1) throw Error("isolated transient parent lookup failure");
      f.sessions.set(id, session(id, { parentID: "B" }));
    } finally { active--; }
  } });
  try {
    model.bindProof((r.bridge.api as any)[parentProofPort]);
    const canonical = (id: string) => model.canonicalParents([normalizeActivityEvent({ version: 2, kind: "parent", sessionID: id,
      parentSessionID: "A", instanceID: "disk", timestamp: f.base, observedAt: f.base, eventID: `parent:${id}` })!], false);
    canonical("child"); f.send("session.metadata.updated", { sessionID: "child", parentID: "B" } as any);
    const target = model.conflicts.get("child")!, version = target.version;
    for (let i = 0; i < 12; i++) await tick(); assert.ok((calls.get("child") ?? 0) <= 2, "no immediate unbounded retry storm");
    canonical("other"); f.send("session.metadata.updated", { sessionID: "other", parentID: "B" } as any);
    for (let i = 0; i < 12; i++) { await tick(); model.bindProof(); model.root("child"); model.eligible("child"); }
    for (let i = 0; i < 150 && r.store.sessionParents.get("child") !== "B"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const actual = { child: calls.get("child"), other: calls.get("other"), parent: r.store.sessionParents.get("child"),
      conflicts: model.diagnostics().parentConflicts, sameTargetVersion: target.version === version, inFlight: r.bridge.retainedState().inFlight }; assert.ok(peak <= 4);
    assert.deepEqual(actual, { child: 2, other: 1, parent: "B", conflicts: 0, sameTargetVersion: true, inFlight: 0 });
  } finally { r.store.disposed = true; await r.dispose(); }
});

test("stale parent metadata cannot roll back a newer parent across reconnect", async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const f = host(), r = runtime(f), model = tuiReadModel(r.store);
  (f.context.data.session as any).sync = async (id: string) => { f.sessions.set(id, session(id, { parentID: "C" })); };
  try {
    model.bindProof((r.bridge.api as any)[parentProofPort]); f.listener()({ details: { type: "server.connected", data: {} } as any });
    f.send("session.metadata.updated", { sessionID: "child", parentID: "B" } as any, 20, { durable: { seq: 20 }, sourceEpoch: "collector" });
    f.send("session.metadata.updated", { sessionID: "child", parentID: "A" } as any, 10, { durable: { seq: 10 }, sourceEpoch: "collector" });
    assert.equal(r.store.sessionParents.get("child"), "B");
    f.listener()({ details: { type: "server.connected", data: {} } as any });
    f.send("session.metadata.updated", { sessionID: "child", parentID: "C" } as any, 1, { durable: { seq: 1 } });
    for (let i = 0; i < 8; i++) await tick();
    assert.equal(r.store.sessionParents.get("child"), "C");
    const queries = r.bridge.retainedState().lookupCount;
    f.send("session.metadata.updated", { sessionID: "child", parentID: "A" } as any, 0, { durable: { seq: 0 } });
    await tick(); assert.equal(r.store.sessionParents.get("child"), "C"); assert.equal(r.bridge.retainedState().lookupCount, queries);
  } finally { await r.dispose(); }
});

test("late parent lookup cannot overwrite a newer canonical target or reconnect epoch", async () => {
  const f = host(), r = runtime(f); const path = await mkdtemp(join(process.env.TMPDIR!, "tui-parent-proof-")), runs = join(path, "runs.jsonl");
  const waiting: Array<() => void> = []; let requests = 0;
  Object.assign(f.context.data.session, { sync: async () => { requests++; await new Promise<void>((resolve) => waiting.push(resolve)); } });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  let seq = 0;
  const canonical = async (sid: string, parentID: string) => {
    const fact = normalizeActivityEvent({ version: 2, kind: "parent", sessionID: sid, parentSessionID: parentID, instanceID: "disk", timestamp: f.base, observedAt: f.base, seq: ++seq, eventID: `parent-${seq}` })!;
    const original = await import("node:fs/promises"); await original.appendFile(runs, JSON.stringify(fact) + "\n"); await reloadActivity(r.store, r.bridge.api, runs);
  };
  try {
    f.listener()({ details: { type: "server.connected", data: {} } as any });
    await canonical("child", "A");
    f.send("session.metadata.updated", { sessionID: "child", parentID: "B" } as any);
    await tick(); assert.equal(requests, 1);
    await canonical("child", "C"); await canonical("unrelated", "Z");
    f.sessions.set("child", session("child", { parentID: "B" })); waiting.shift()!(); await tick();
    assert.equal(requests, 2); assert.equal(r.store.sessionParents.get("child"), "A", "old result must not clear a newer target conflict");
    f.sessions.set("child", session("child", { parentID: "C" })); waiting.shift()!(); await tick();
    assert.equal(r.store.sessionParents.get("child"), "C"); assert.equal(tuiReadModel(r.store).diagnostics().parentConflicts, 0);
    await canonical("child", "A"); await tick();
    assert.equal(r.store.sessionParents.get("child"), "C", "old disk cannot erase the newer fresh witness while revalidation is pending");
    assert.equal(requests, 3); f.sessions.set("child", session("child", { parentID: "C" })); waiting.shift()!(); await tick();
    await canonical("child", "C"); assert.equal(requests, 3);
    f.send("session.metadata.updated", { sessionID: "child", parentID: "B" } as any); await tick(); assert.equal(requests, 4);
    f.listener()({ details: { type: "server.connected", data: {} } as any }); tuiReadModel(r.store).bindProof();
    f.sessions.set("child", session("child", { parentID: "B" })); waiting.shift()!(); await tick();
    assert.equal(requests, 5); assert.equal(r.store.sessionParents.get("child"), "C");
    f.sessions.set("child", session("child", { parentID: "B" })); waiting.shift()!(); await tick();
    assert.equal(r.store.sessionParents.get("child"), "B"); assert.equal(r.bridge.retainedState().inFlight, 0);
  } finally { for (const release of waiting) release(); await r.dispose(); await rm(path, { recursive: true, force: true }); }
});

test("V2 TUI real event.data usage/cache/cost/calls correct per request, exact corrections and replay dedupe", async () => {
  const f = host(); const r = runtime(f);
  try {
    // Compile-time fixtures use the installed 2.0.27 generated client contracts.
    const start = f.raw("session.step.started", {
      sessionID: "root", assistantMessageID: "msg_a", agent: "build", model, started: f.base + 10,
    }) satisfies SessionStepStarted;
    const ended = f.raw("session.step.ended", { sessionID: "root", assistantMessageID: "msg_a", tokens, cost: 0.5, finish: "tool-calls" }, 20) satisfies SessionStepEnded;
    f.send("session.execution.started", { sessionID: "root" });
    f.listener()({ details: start }); f.listener()({ details: ended });
    f.send("session.step.started", { sessionID: "root", assistantMessageID: "msg_b", agent: "review", model, started: f.base + 30 }, 30);
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "msg_b", tokens, cost: 0.5, finish: "stop" }, 40);
    f.send("session.usage.updated", { sessionID: "root", tokens: { ...tokens, output: 99999 }, cost: 99 }, 50);
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "msg_a", tokens: { ...tokens, output: 4 }, cost: 0.25, finish: "tool-calls" }, 60);
    f.listener()({ details: ended });
    assert.equal(r.totals().direct.responseCount, 2); assert.equal(r.totals().direct.cost, 0.75);
    assert.deepEqual(r.totals().direct.tokens, { input: 24, output: 11, reasoning: 6, cacheRead: 18, cacheWrite: 4 });
    assert.equal(r.store.optimistic.get("msg_b")?.model, "fixture-model");
    assert.equal(r.store.taskRuns.get("root")?.phase, "active", "step.ended does not end execution");
    f.send("session.execution.succeeded", { sessionID: "root" }, 100);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 10000), 100);
    assert.equal(r.store.optimistic.get("msg_a")?.samples.length, 0);
  } finally { await r.dispose(); }
});

test("V2 TUI stream hot path does not read payload, lookup sessions, normalize, hash or bump", async () => {
  const f = host(); const r = runtime(f);
  try {
    const before = r.store.revision(); const lookups = f.counts().lookups;
    for (const type of ["session.text.delta", "session.text.started", "session.text.ended", "session.reasoning.delta",
      "session.reasoning.ended", "session.tool.input.delta", "session.tool.progress", "session.step.streamed", "session.usage.updated"]) {
      const event = { type, get data() { throw new Error("hot path read payload"); } } as unknown as OpenCodeEvent;
      f.listener()({ details: event });
    }
    assert.equal(r.store.revision(), before); assert.equal(f.counts().lookups, lookups);
    assert.equal(r.store.active.size, 0); assert.equal(r.store.optimistic.size, 0);
    await r.bridge.dispose(); f.send("session.execution.started", { sessionID: "root" });
    assert.equal(r.store.revision(), before);
  } finally { await r.dispose(); }
});

test("V2 TUI failed step/retry keep execution open; interruption closes without invented calls", async () => {
  const f = host(); const r = runtime(f);
  try {
    f.send("session.execution.started", { sessionID: "root" });
    f.send("session.step.started", { sessionID: "root", assistantMessageID: "msg_a", agent: "build", model, started: f.base + 10 }, 10);
    f.send("session.step.failed", { sessionID: "root", assistantMessageID: "msg_a", error: { type: "fixture", message: "failed" } }, 20);
    assert.equal(r.store.taskRuns.get("root")?.phase, "active");
    f.send("session.retry.scheduled", { sessionID: "root", assistantMessageID: "msg_a", attempt: 1, at: f.base + 40, error: { type: "fixture", message: "retry" } }, 30);
    assert.equal(r.store.sessionRuntime.get("root")?.status, "retry");
    f.send("session.execution.interrupted", { sessionID: "root", reason: "user" }, 100);
    assert.equal(r.totals().direct.responseCount, 0); assert.equal(r.store.optimistic.size, 0);
    assert.equal(taskWallTimeForSession(r.store, "root", f.base + 10000), 100);
  } finally { await r.dispose(); }
});

test("V2 late maintenance metadata stops its live task clock and excludes subsequent requests and descendants", async () => {
  const f = host(); const r = runtime(f);
  try {
    f.send("session.execution.started", { sessionID: "maintenance" });
    f.send("session.step.started", { sessionID: "maintenance", assistantMessageID: "msg_hidden", agent: "build", model, started: f.base + 10 }, 10);
    assert.equal(hasLiveTaskWallActivity(r.store), true);
    f.send("session.metadata.updated", { sessionID: "maintenance", metadata: { magic_context: "hidden-run", role: "historian" } }, 20);
    assert.equal(hasLiveTaskWallActivity(r.store), false);
    assert.equal(taskWallTimeForSession(r.store, "maintenance", f.base + 10000), undefined);
    f.send("session.step.ended", { sessionID: "maintenance", assistantMessageID: "msg_hidden", tokens, cost: 99, finish: "stop" }, 30);
    f.send("session.created", { sessionID: "hidden-child", agent: "build", parentID: "maintenance",
      projectID: "fixture", slug: "hidden-child", version: "2.0.27", location: { directory: "/fixture" } }, 40);
    f.send("session.execution.started", { sessionID: "hidden-child" }, 50);
    f.send("session.step.started", { sessionID: "hidden-child", assistantMessageID: "msg_child", agent: "build", model, started: f.base + 60 }, 60);
    f.send("session.step.ended", { sessionID: "hidden-child", assistantMessageID: "msg_child", tokens, cost: 99, finish: "stop" }, 70);
    assert.equal(hasLiveTaskWallActivity(r.store), false);
    assert.equal(r.store.optimistic.size, 0); assert.equal(r.store.active.size, 0);
    assert.equal(buildSessionDetailsTree(r.store, "maintenance").including.responseCount, 0);
    assert.equal(buildSessionDetailsTree(r.store, "maintenance").including.cost, 0);
  } finally { await r.dispose(); }
});

test("V2 TUI cleanup closes only its own live details dialog, never a replacement host dialog", async () => {
  for (const replaced of [false, true]) {
    const f = host(); const bridge = createV2TuiBridge(f.context);
    const store = createRuntimeStore(1);
    try {
      const details = registerTokenPulseCommands(bridge.api, store, resolveOptions({}), () => {});
      assert.equal(details.open(), "root"); assert.equal(details.owned, true);
      if (replaced) { f.closeDialog(); f.setMode("dialog"); }
      await bridge.dispose(); await bridge.dispose();
      assert.equal(f.counts().dialogClearCount, replaced ? 0 : 1);
      assert.equal(details.owned, false);
      await f.layers[0].commands!.find((command) => command.id === "oc-tps.details")!.run();
      assert.equal(f.counts().dialogCount, 1, "captured commands cannot reopen after disable");
    } finally { await bridge.dispose(); store.disposeSignals(); }
  }
});
