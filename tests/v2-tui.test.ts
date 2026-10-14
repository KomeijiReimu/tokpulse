import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { OpenCodeEvent, SessionInfo, SessionStepStarted, SessionStepEnded } from "@opencode/client";
import type { KeymapLayer, Page, Route, SlotClaim } from "@opencode/plugin/tui/context";
import { Plugin } from "@opencode/plugin/tui";
import { RGBA } from "@opentui/core";
import type { createV2EventAdapter } from "../src/v2-server.js";
import plugin, { createRuntimeStore, handleMessageUpdated, handleSessionLifecycle, recordStepStarted,
  cacheSessionParentFromEvent, projectSessionTotals, buildSessionDetailsTree, taskWallTimeForSession,
  resolveOptions, tokenPulseBindings, registerTokenPulseCommands, hasLiveTaskWallActivity } from "../src/tui.js";
import { createV2TuiBridge, type V2TuiContext } from "../src/tui-v2.js";

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
  const on = bridge.api.event.on as (type: string, callback: (event: NormalizedEvent) => void) => () => void;
  on("message.updated", (event) => handleMessageUpdated(store, bridge.api, event.properties, event, 4, f.base + 1000));
  on("session.next.step.started", (event) => recordStepStarted(store, event.properties, event));
  on("session.updated", (event) => cacheSessionParentFromEvent(store, event));
  for (const type of ["session.status", "session.completed", "session.error", "session.aborted", "session.next.retried"]) {
    on(type, (event) => handleSessionLifecycle(store, bridge.api, type, event.properties, event, 4));
  }
  return { bridge, store, totals: (id = "root") => projectSessionTotals(store.totalsLedger,
    [...store.optimistic.values()], store.sessionParents, id), async dispose() { await bridge.dispose(); store.disposeSignals(); } };
}

test("V2 TUI default Plugin.define setup keeps V1 entry, scrollable sidebar/route/commands and read-only lifecycle", async () => {
  const root = join(process.env.HOME!, ".cache", "tokpulse-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "v2-tui-"));
  try {
    assert.equal(plugin.id, "oc-tps"); assert.equal(typeof plugin.tui, "function");
    const definition: Plugin.Definition = plugin;
    assert.equal(Plugin.define(definition), plugin, "entry conforms to the installed V2 runtime, not a mocked define");
    const f = host(directory);
    const cleanup = await plugin.setup(f.context);
    assert.ok(typeof cleanup === "function");
    assert.equal(f.counts().listenCount, 1);
    assert.equal(f.slots[0].append, "sidebar.content");
    assert.equal(f.pages[0].name, "oc-tps-history");
    assert.deepEqual(f.layers[0].bindings, []);
    const history = f.layers[0].commands!.find((command) => command.id === "oc-tps.history")!;
    assert.equal(history.palette, true); assert.equal(history.slash?.name, "tps"); assert.equal(history.bind, false);
    await history.run();
    assert.deepEqual(f.route(), { type: "plugin", id: "fixture-plugin-route", name: "oc-tps-history", data: { sessionID: "root" } });
    assert.equal(f.layers[1].mode, "base");
    assert.deepEqual(f.layers[1].bindings, []);
    assert.equal(f.layers[1].commands![0].bind, "ctrl+shift+t");
    assert.equal(f.layers[1].commands![1].bind, "ctrl+shift+y");
    assert.equal(f.layers[1].commands![0].palette, true); assert.equal(f.layers[1].commands![0].slash?.name, "tps");
    assert.equal(f.layers[1].commands![1].palette, true); assert.equal(f.layers[1].commands![1].slash?.name, "tps-details");
    assert.equal(f.layers[2].commands![0].bind, "escape");
    await f.layers[2].commands![0].run();
    assert.deepEqual(f.route(), { type: "session", sessionID: "root" });
    const details = f.layers[0].commands!.find((command) => command.id === "oc-tps.details")!;
    f.setMode("dialog"); await details.run(); assert.equal(f.counts().dialogCount, 0);
    f.setMode("base"); await details.run(); assert.equal(f.counts().dialogCount, 1);
    assert.deepEqual(f.dialogs[1], { size: "large" });
    await details.run(); assert.equal(f.counts().dialogCount, 1);
    f.closeDialog();
    await cleanup(); await cleanup();
    assert.equal(f.counts().stopCount, 1);
    assert.equal(f.slots.length, 0); assert.equal(f.pages.length, 0);
    assert.equal((f.layers[0].enabled as () => boolean)(), false);
    assert.deepEqual(await readdir(directory), [], "TUI initialization/cleanup never creates ledger files");
  } finally { await rm(directory, { recursive: true, force: true }); }
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
      "session.reasoning.ended", "session.tool.input.delta", "session.tool.called", "session.tool.success", "session.step.streamed", "session.usage.updated"]) {
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

test("V2 TUI cached ancestry, agent names and Magic Context scope survive normalization", async () => {
  const f = host(); const r = runtime(f);
  try {
    f.sessions.set("child", session("child", { parentID: "root", agent: "review", title: "Review" }));
    f.sessions.set("hidden", session("hidden", { metadata: { magic_context: "hidden-run", role: "historian" } }));
    f.sessions.set("hidden-child", session("hidden-child", { parentID: "hidden", agent: "build" }));
    for (const [id, agent] of [["child", "review"], ["hidden-child", "build"]]) {
      f.send("session.created", { sessionID: id, agent, parentID: id === "child" ? "root" : "hidden",
        projectID: "fixture", slug: id, version: "2.0.27", location: { directory: "/fixture" } });
      f.send("session.step.started", { sessionID: id, assistantMessageID: `msg_${id}`, agent, model, started: f.base + 10 }, 10);
      f.send("session.step.ended", { sessionID: id, assistantMessageID: `msg_${id}`, tokens, cost: 0.5, finish: "stop" }, 20);
    }
    assert.equal(r.totals().direct.responseCount, 0); assert.equal(r.totals().including.responseCount, 1);
    assert.equal(r.store.optimistic.has("msg_hidden-child"), false);
    const tree = buildSessionDetailsTree(r.store, "root");
    assert.equal(r.store.optimistic.get("msg_child")?.agent, "review");
    assert.equal(tree.nodes.some((node) => node.sessionID === "child"), true);
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "msg_other", tokens, cost: 10, finish: "stop" }, 25, { location: { directory: "/other" } });
    assert.equal(r.totals().including.responseCount, 1);
  } finally { await r.dispose(); }
});

test("V2 TUI reactive theme tokens, absent location fallback and configured native keys", async () => {
  const f = host("/fallback", { keybinds: { "oc-tps.history": ["ctrl+alt+t", "<leader>t"], "oc-tps.details": false } });
  const context = { ...f.context, location: undefined };
  const r = createV2TuiBridge(context, tokenPulseBindings(resolveOptions(context.options)));
  const store = createRuntimeStore(1);
  try {
    assert.equal(r.api.state.path.directory, "/fallback");
    assert.equal(r.api.theme.current.text, f.theme.text.base);
    const replacement = RGBA.fromHex("#aaaaaa"); f.theme.text.base = replacement;
    assert.equal(r.api.theme.current.text, replacement);
    registerTokenPulseCommands(r.api, store, resolveOptions(context.options), () => {});
    assert.equal(f.layers[0].commands![0].bind, false);
    assert.equal(f.layers[1].commands![0].bind, "ctrl+alt+t,<leader>t");
    assert.equal(f.layers[0].commands![1].bind, false);
    assert.deepEqual(f.layers[1].bindings, []);
  } finally { await r.dispose(); store.disposeSignals(); }
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
