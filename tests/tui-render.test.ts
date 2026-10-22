import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { BoxRenderable,RGBA,Renderable,ScrollBoxRenderable,SelectRenderable,TextRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { testRender,useRenderer } from "@opentui/solid";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdir,mkdtemp,readFile,rename,rm,writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname,join } from "node:path";
import test from "node:test";
import { fileURLToPath,pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { emptySpeedTotals,updateSpeedTotals,type SpeedContribution } from "../src/statistics.js";

function v3Generation(output: number, reasoning = 0, durationMs = 1000, start = 0): SpeedContribution {
  return {
    generation: { generatedTokens: (output + reasoning) / 2, coverageGeneratedTokens: output + reasoning, durationMs, estimated: true },
    generationEvidence: { version: 3, coverage: "complete", start, end: start + durationMs,
      firstReceiveMono: 0, lastReceiveMono: durationMs, observationCount: 2,
      timeSource: "receive-monotonic", fromCurrentStart: true, selectedStream: "legacy", stepID: "step",
      outputObserved: output > 0, reasoningObserved: reasoning > 0,
      bytes: { output: { total: output > 0 ? 2 : 0, firstBatch: output > 0 ? 1 : 0 },
        reasoning: { total: reasoning > 0 ? 2 : 0, firstBatch: reasoning > 0 ? 1 : 0 } }, usage: { output, reasoning } },
  };
}

const cacheRoot = process.env.TMPDIR || join(homedir(), ".cache", "tokpulse-tests");

// Compile only this isolated UI module as the real build does, without writing
// dist or changing how the non-rendering runtime tests import the source.
type RenderedTui = typeof import("../src/tui.js") & { __testRuntimeStores: ReturnType<typeof import("../src/tui.js").createRuntimeStore>[];
  __testSidebarList: (input: { render: () => JSX.Element; scrollRef: (node: ScrollBoxRenderable) => void }) => JSX.Element;
  __testHistoryView: (input: { api: TuiPluginApi; store: ReturnType<typeof import("../src/tui.js").createRuntimeStore>; sessionID: string; options: ReturnType<typeof import("../src/tui.js").resolveOptions> }) => JSX.Element };
async function loadRenderedTui(): Promise<RenderedTui> {
  const bunModule = "bun";
  const runtime = await import(bunModule);
  const babelModule = "@babel/core";
  const solidModule = "babel-preset-solid";
  const typescriptModule = "@babel/preset-typescript";
  const [{ transformAsync }, solid, typescript] = await Promise.all([
    import(babelModule), import(solidModule), import(typescriptModule),
  ]);
  const source = fileURLToPath(new URL("../src/tui.tsx", import.meta.url));
  const sourceText = await readFile(source, "utf8");
  // A read-only capture in the isolated test compilation exposes the actual
  // plugin's store. It does not replace event adapters, subscribers or hydration.
  const storeCreation = "const store = createRuntimeStore(options.maxRecords);";
  assert.equal(sourceText.split(storeCreation).length, 2);
  const observedSource = `export const __testRuntimeStores = [];\n${sourceText.replace(storeCreation, `${storeCreation}\n__testRuntimeStores.push(store);`)}
// Host layout evidence: OpenCode v2.0.27 packages/tui/src/routes/session/sidebar.tsx.
// Sidebar content is inside scrollbox; the host footer is its following sibling.
export function __testSidebarList(input) {
  return <box width={40} height={14} flexDirection="column">
    <text flexShrink={0}>SESSION TITLE</text>
    <scrollbox flexGrow={1} minHeight={0} ref={input.scrollRef}>
      <box flexShrink={0} gap={1}>
        <text flexShrink={0} height={18}>{Array.from({ length: 18 }, (_, i) => 'Existing list row ' + i).join('\\n')}</text>
        {input.render()}
      </box>
    </scrollbox>
    <text flexShrink={0}>HOST FOOTER</text>
  </box>;
}
export const __testHistoryView = HistoryView;`;
  const transformed = await transformAsync(observedSource, {
    filename: source, babelrc: false, configFile: false,
    presets: [[solid.default, { moduleName: "@opentui/solid", generate: "universal" }],
      [typescript.default, { allExtensions: true, isTSX: true }]],
  });
  assert.ok(transformed?.code);
  const code = transformed.code.replace(/from (["'])([^"']+)\1/g, (_match: string, _quote: string, spec: string) => {
    return `from ${JSON.stringify(spec.startsWith("node:") ? spec : runtime.resolveSync(spec, dirname(source)))}`;
  });
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(join(cacheRoot, "ui-render-"));
  try {
    const modulePath = join(directory, "tui.mjs");
    await writeFile(modulePath, code, "utf8");
    return await import(pathToFileURL(modulePath).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const nativeChild = process.env.TOKPULSE_NATIVE_RENDER === "1";
const uiPromise = nativeChild ? loadRenderedTui() : undefined;

function host(width: number, height: number, child = false): TuiPluginApi {
  const color = RGBA.fromHex("#eeeeee");
  return {
    theme: { current: new Proxy({}, { get: () => color }) },
    renderer: { width, height },
    state: { session: { get: () => child ? { parentID: "root" } : undefined } },
  } as unknown as TuiPluginApi;
}

function readyStore(ui: RenderedTui, maxRecords = 1): ReturnType<RenderedTui["createRuntimeStore"]> {
  const store = ui.createRuntimeStore(maxRecords);
  store.sourceState = { status: "ready", epoch: store.sourceEpoch, live: false, loaded: { history: true, totals: true, runs: true } };
  return store;
}

if (!nativeChild) {
  test("native OpenTUI sidebar and dialog render checks (isolated Solid host)", { timeout: 30000 }, async () => {
    // The host preloads Solid's client runtime. Isolate it so these checks do
    // not change the Solid instance used by the pure runtime test suite.
    const output = await promisify(execFile)(process.execPath, [
      "test", "--preload", "@opentui/solid/preload", fileURLToPath(import.meta.url),
    ], { timeout: 25000, cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
      ...process.env, TOKPULSE_NATIVE_RENDER: "1", TMPDIR: cacheRoot,
    } });
    assert.match(output.stderr + output.stdout, /\b[1-9]\d* pass\b/);
  });
}

if (nativeChild) {
test("source states render unknown rather than zero across sidebar, history and details, then recover on revision", async () => {
  const ui = (await uiPromise)!;
  const paths = { history: "/project/history.jsonl", totals: "/project/totals.json", runs: "/project/runs.jsonl" };
  for (const surface of ["sidebar", "history", "details"] as const) {
    const store = ui.createRuntimeStore(1);
    store.pulseExpanded = true;
    const api = host(100, 80);
    const rendered = await testRender(() => {
      api.renderer = useRenderer();
      return surface === "sidebar" ? ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.sidebar_content!({ theme: api.theme }, { session_id: "root" })
        : surface === "history" ? ui.__testHistoryView({ api, store, sessionID: "root", options: ui.resolveOptions({}) })
        : ui.TokenPulseDetails({ api, store, sessionID: "root" });
    }, { width: 100, height: 80 });
    try {
      for (const [state, label] of [
        [{ status: "waiting-metadata" }, "Waiting for session metadata"],
        [{ status: "loading", paths }, "Loading Token Pulse data"],
        [{ status: "missing", paths, missing: Object.values(paths) }, "Missing ledger: history, totals, task time"],
        [{ status: "error", paths, errors: { history: "unreadable", totals: "unreadable", runs: "unreadable" } }, "Unable to read: history, totals, task time"],
        [{ status: "error", paths, errors: { history: "unreadable" } }, "Unable to read: history"],
        [{ status: "error", paths, errors: { runs: "unreadable" } }, "Unable to read: task time"],
        [{ status: "error", errors: { metadata: "unavailable" } }, "Unable to read: session metadata"],
      ] as const) {
        store.sourceState = { epoch: store.sourceEpoch, live: false, loaded: {}, ...state, missing: "missing" in state && state.missing ? [...state.missing] : undefined };
        store.bump();
        await rendered.renderOnce(); await rendered.renderOnce();
        const frame = rendered.captureCharFrame();
        assert.ok(frame.includes(label), `${surface}: ${label}`);
        assert.doesNotMatch(frame, /\b0 total|time 0|\b0%|\$0|No completed responses yet|No recorded usage/);
        assert.match(frame, surface === "history" ? /Totals unavailable/ : /--/);
      }
      store.sourceState = { status: "ready", epoch: store.sourceEpoch, live: false, loaded: { history: true, totals: true, runs: true } };
      store.bump();
      await rendered.renderOnce(); await rendered.renderOnce();
      const ready = rendered.captureCharFrame();
      assert.doesNotMatch(ready, /Waiting for|Loading Token|Missing ledger|Unable to read|Totals unavailable/);
      assert.match(ready, surface === "history" ? /No completed responses yet/ : surface === "sidebar" ? /0 total/ : /No recorded usage/);
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("partial ledger failures retain available usage and cache while missing runs keep task time unknown", async () => {
  const ui = (await uiPromise)!;
  const paths = { history: "/project/history.jsonl", totals: "/project/totals.json", runs: "/project/runs.jsonl" };
  for (const surface of ["sidebar", "history", "details"] as const) {
    const store = readyStore(ui);
    store.totalsLedger.sessions.root = { tokens: { input: 10, output: 100, reasoning: 0, cacheRead: 10, cacheWrite: 0 }, cost: 1, responseCount: 1 };
    const run = ui.createTaskWallRun("root");
    ui.transitionTaskWallRun(run, "root", "busy", 1000);
    ui.transitionTaskWallRun(run, "root", "idle", 6000);
    store.taskRuns.set("root", run);
    store.pulseExpanded = true;
    const api = host(100, 80);
    const rendered = await testRender(() => {
      api.renderer = useRenderer();
      return surface === "sidebar" ? ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.sidebar_content!({ theme: api.theme }, { session_id: "root" })
        : surface === "history" ? ui.__testHistoryView({ api, store, sessionID: "root", options: ui.resolveOptions({}) })
        : ui.TokenPulseDetails({ api, store, sessionID: "root" });
    }, { width: 100, height: 80 });
    try {
      for (const state of [
        { status: "missing", paths, loaded: { history: true, totals: true, runs: false }, missing: [paths.runs] },
        { status: "missing", paths, loaded: { history: false, totals: true, runs: true }, missing: [paths.history] },
        { status: "error", paths, loaded: { history: false, totals: true, runs: true }, errors: { history: "unreadable" } },
        { status: "error", paths, loaded: { history: true, totals: true, runs: true }, errors: { totals: "unreadable" } },
        { status: "loading", paths, loaded: { history: true, totals: true, runs: true } },
      ] as const) {
        store.sourceState = { epoch: store.sourceEpoch, live: false, ...state, missing: "missing" in state && state.missing ? [...state.missing] : undefined };
        store.bump();
        await rendered.renderOnce(); await rendered.renderOnce();
        const frame = rendered.captureCharFrame();
        assert.match(frame, /120/);
        assert.match(frame, /50%/);
        assert.doesNotMatch(frame, /Totals unavailable/);
        if (surface === "sidebar" && state.status === "missing" && state.missing.includes(paths.runs)) {
          assert.match(frame, /time --/);
          assert.doesNotMatch(frame, /time 5s/);
        }
        if (surface === "history" && state.status === "missing" && state.missing.includes(paths.history)) {
          assert.match(frame, /Missing ledger: history/);
          assert.doesNotMatch(frame, /No completed responses yet/);
        }
      }
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("loaded snapshots, including valid empty ledgers, survive same-source refresh failures", async () => {
  const ui = (await uiPromise)!;
  const paths = { history: "/project/history.jsonl", totals: "/project/totals.json", runs: "/project/runs.jsonl" };
  for (const empty of [false, true]) for (const surface of ["sidebar", "history", "details"] as const) {
    const store = readyStore(ui);
    const tokens = { input: 10, output: 100, reasoning: 0, cacheRead: 10, cacheWrite: 0 };
    if (!empty) {
      store.totalsLedger.sessions.root = { tokens, cost: 1, responseCount: 1 };
      store.records = [{ version: 1, sessionID: "root", messageID: "kept", model: "kept-model", tokens, cost: 1,
        time: { start: 1000, completed: 6000 }, samples: [] }];
      store.diskRecords = store.records;
      store.totalsLedger.settled.kept = true;
    }
    // No totals/session entry at all in the empty case: loaded is the evidence
    // for a valid zero snapshot, not a heuristic based on nonzero usage.
    const run = ui.createTaskWallRun("root");
    ui.transitionTaskWallRun(run, "root", "busy", 1000);
    ui.transitionTaskWallRun(run, "root", "idle", 6000);
    store.taskRuns.set("root", run);
    store.pulseExpanded = true;
    const api = host(100, 80);
    const rendered = await testRender(() => {
      api.renderer = useRenderer();
      return surface === "sidebar" ? ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.sidebar_content!({ theme: api.theme }, { session_id: "root" })
        : surface === "history" ? ui.__testHistoryView({ api, store, sessionID: "root", options: ui.resolveOptions({}) })
        : ui.TokenPulseDetails({ api, store, sessionID: "root" });
    }, { width: 100, height: 80 });
    try {
      for (const state of [
        { status: "missing", missing: [paths.runs] },
        { status: "missing", missing: [paths.totals, paths.history] },
        { status: "error", errors: { history: "unreadable", totals: "unreadable", runs: "unreadable" } },
      ] as const) {
        store.sourceState = { epoch: store.sourceEpoch, live: false, paths, ...state,
          loaded: { history: true, totals: true, runs: true }, missing: "missing" in state && state.missing ? [...state.missing] : undefined };
        store.bump();
        await rendered.renderOnce(); await rendered.renderOnce();
        const frame = rendered.captureCharFrame();
        assert.match(frame, /Unable to refresh:/);
        assert.match(frame, /showing last known data/);
        assert.doesNotMatch(frame, /Totals unavailable|-- total/);
        if (surface === "sidebar") {
          assert.match(frame, empty ? /\b0 total/ : /120 total/);
          assert.match(frame, /time 5s/);
        } else if (surface === "history") {
          assert.match(frame, empty ? /Total tokens \(input \+ generated \+ cache\) 0/ : /120/);
          assert.match(frame, empty ? /No completed responses yet/ : /kept-model/);
        } else {
          assert.match(frame, empty ? /No recorded usage for this session/ : /120/);
        }
        if (!empty) assert.match(frame, /50%/);
      }
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

async function waitForLedger(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 1500;
  // Test synchronization only. The plugin never polls a ledger or closes on silence.
  for (let waited = 0; waited < 1500; waited += 10) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), `${message} (bounded wait ${deadline})`);
}

// Gate the actual safe-reader boundary, keeping nofollow/stat/close intact.
// A FIFO is intentionally invalid now; a path-level readFile mock is bypassed.
async function holdHistoryRead(path: string) {
  const originals = { ...fsPromises };
  const bunTestModule = "bun:test";
  const { mock } = await import(bunTestModule);
  let entered = false;
  let released = false;
  let release!: (bytes: string) => void;
  const gate = new Promise<string>((resolve) => { release = resolve; });
  mock.module("node:fs/promises", () => ({ ...originals, async open(...args: Parameters<typeof fsPromises.open>) {
    const file = await originals.open(...args);
    if (String(args[0]) !== path || entered) return file;
    return new Proxy(file, { get(target, key) {
      if (key === "readFile") return () => { entered = true; return gate; };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } }));
  return { entered: () => entered, release(bytes: string) { released = true; release(bytes); },
    restore() { if (!released) release(""); mock.module("node:fs/promises", () => originals); } };
}

async function ledgerPluginFixture(lateDirectory = false, gateInitialHistory = false) {
  const ui = (await uiPromise)!;
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(join(cacheRoot, "ledger-watch-"));
  const ledgerDirectory = lateDirectory ? join(directory, "late", "ledgers") : directory;
  const historyPath = join(ledgerDirectory, "history.jsonl");
  const runsPath = join(ledgerDirectory, "runs.jsonl");
  const handlers = new Map<string, (event: unknown, metadata: { directory: string; workspace: undefined }) => void>();
  const disposers: (() => void | Promise<void>)[] = [];
  const originalNow = Date.now;
  let clock = originalNow();
  const startedAt = clock + 10;
  Date.now = () => clock;
  let registered!: ReturnType<typeof ui.createTuiSlotPlugin>;
  const toasts: string[] = [];
  const api = { ...host(80, 40), state: { path: { worktree: directory, directory }, session: { get: (id: string) => ({ id, directory }) }, part: () => [] },
    route: { current: { name: "session", params: { sessionID: "s" } }, register: () => {}, navigate: () => {} },
    mode: { push: () => () => {} }, keymap: { registerLayer: () => () => {} }, ui: { toast: (value: { message: string }) => { toasts.push(value.message); }, dialog: { open: false } },
    slots: { register: (plugin: typeof registered) => { registered = plugin; return "ledger-watch"; } },
    event: { on: (type: string, callback: (event: unknown, metadata: { directory: string; workspace: undefined }) => void) => { assert.equal(handlers.has(type), false); handlers.set(type, callback); return () => handlers.delete(type); } },
    lifecycle: { onDispose: (dispose: () => void | Promise<void>) => { disposers.push(dispose); return () => {}; } },
  } as unknown as TuiPluginApi;
  let rendered: Awaited<ReturnType<typeof testRender>> | undefined;
  let release: (bytes: string) => void = () => {};
  let entered = false;
  let released = !gateInitialHistory;
  let restoreFilesystem = () => {};
  if (gateInitialHistory) {
    await writeFile(historyPath, "");
    const held = await holdHistoryRead(historyPath);
    release = held.release;
    restoreFilesystem = held.restore;
    // Updated after setup reaches the asynchronous fd read below.
    Object.defineProperty(api, "__historyReadEntered", { get: held.entered });
  }
  let initialization: Promise<void> | undefined;
  const dispose = async () => { for (const fn of disposers.splice(0).reverse()) await fn(); };
  try {
    initialization = ui.default.tui(api, { historyPath }, {} as never) as Promise<void>;
    if (!gateInitialHistory) await initialization;
    else { await waitForLedger(() => (api as any).__historyReadEntered, "safe fd reader must enter held initial read"); entered = true; }
    const store = ui.__testRuntimeStores.at(-1)!;
    rendered = await testRender(() => {
      api.renderer = useRenderer();
      const panel = new BoxRenderable(api.renderer, { width: 80, flexDirection: "column" });
      panel.add(registered.slots!.sidebar_content!({ theme: api.theme }, { session_id: "s" }) as unknown as Renderable);
      return panel as unknown as JSX.Element;
    }, { width: 80, height: 40 });
    const send = (offset: number, type: string, properties: Record<string, unknown>) => {
      clock = startedAt + offset; handlers.get(type)!({ type, properties, timestamp: clock }, { directory, workspace: undefined });
    };
    const fact = (sid: string, state: string, offset: number, actor = "current-server") => ({ version: 1, kind: "lifecycle", sessionID: sid, state,
      timestamp: startedAt + offset, observedAt: startedAt + offset, instanceID: actor });
    const commitRuns = async (facts: unknown[]) => {
      const staging = join(ledgerDirectory, "runs-write.pending");
      await writeFile(staging, facts.map((value) => JSON.stringify(value)).join("\n") + "\n");
      await rename(staging, runsPath);
    };
    const complete = () => send(100, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", tokens: { input: 1, output: 6, reasoning: 0 }, time: { created: startedAt, completed: startedAt + 100 } } });
    const start = () => {
      send(0, "session.status", { sessionID: "s", status: { type: "busy" } });
      send(0, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", time: { created: startedAt } } });
    };
    return { ui, store, rendered, directory, ledgerDirectory, historyPath, runsPath, startedAt, send, fact, commitRuns, complete, start, dispose, initialization, toasts,
      initialReadEntered: () => entered,
      releaseHistory: (bytes: string) => { released = true; release(bytes); },
      advance: (offset: number) => { clock = startedAt + offset; },
      close: async () => { await dispose(); if (!released) release(""); await initialization; restoreFilesystem(); rendered?.renderer.destroy(); Date.now = originalNow; await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await dispose(); if (!released) release(""); await initialization; restoreFilesystem(); rendered?.renderer.destroy(); Date.now = originalNow; await rm(directory, { recursive: true, force: true }); throw error; }
}

test("actual fs.watch accepts a concurrent append without warnings and renders the exact duration", async () => {
  const f = await ledgerPluginFixture(); const originals = { ...fsPromises };
  const bunTestModule = "bun:test"; const { mock } = await import(bunTestModule);
  let injected = false;
  try {
    f.advance(1001); await f.commitRuns([f.fact("s", "busy", 0), f.fact("s", "idle", 1000)]);
    await waitForLedger(() => f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 2000) === 1000, "actual watch must hydrate the first canonical generation");
    mock.module("node:fs/promises", () => ({ ...originals, async open(...args: Parameters<typeof fsPromises.open>) {
      const file = await originals.open(...args); if (String(args[0]) !== f.runsPath) return file;
      return new Proxy(file, { get(target, key) {
        if (key === "read") return async (...parameters: any[]) => {
          const result = await (target.read as any)(...parameters);
          if (!injected) { injected = true; writeFileSync(f.runsPath, [f.fact("s", "busy", 4000), f.fact("s", "idle", 5000)].map((value) => JSON.stringify(value)).join("\n") + "\n", { flag: "a" }); }
          return result;
        };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    } }));
    f.advance(5001); writeFileSync(f.runsPath, [f.fact("s", "busy", 2000), f.fact("s", "idle", 3000)].map((value) => JSON.stringify(value)).join("\n") + "\n", { flag: "a" });
    await waitForLedger(() => f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 6000) === 3000, "active append race must retry without waiting for a later control/prompt");
    assert.ok(injected);
    assert.deepEqual(f.toasts, [], "concurrent appends must not produce activity read warnings");
    await f.rendered.renderOnce(); const frame = f.rendered.captureCharFrame();
    assert.match(frame, /time 3s/); assert.doesNotMatch(frame, /TPS|TTFT|tok\/s/i);
    f.advance(3605001); assert.equal(f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 3605001), 3000);
  } finally { mock.module("node:fs/promises", () => originals); await f.close(); }
});

test("initialization drains watcher-invalidated authoritative hydration before returning or accepting late same-ID content", async () => {
  const f = await ledgerPluginFixture(false, true);
  try {
    f.start();
    const owned = f.store.active.get("m")!;
    assert.ok(f.initialReadEntered());
    assert.ok(owned);
    assert.equal(owned.sessionID, "s");
    assert.equal(f.store.sessionRuntime.get("s")!.activeMessageID, "m");
    assert.equal(owned.progress!.fromCurrentStart, true);
    assert.equal(owned.legacy.samples.length + owned.v2.samples.length, 0);
    await f.rendered.renderOnce();
    assert.match(f.rendered.captureCharFrame(), /-- total/);
    assert.match(f.rendered.captureCharFrame(), /Loading Token Pulse data|Missing ledger: task time/);
    assert.match(f.rendered.captureCharFrame(), /time --/);
    assert.doesNotMatch(f.rendered.captureCharFrame(), /tok\/s|LIVE|WARMUP|TTFT/i);
    const initialGeneration = f.store.historyGeneration;
    const record = { version: 1, messageID: "m", sessionID: "s", quality: "exact", tokens: { input: 1, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, time: { start: f.startedAt, completed: f.startedAt + 100 }, samples: [] };
    const bytes = JSON.stringify(record) + "\n";
    // Same real-file writes as the compiled harness. No completion/idle event
    // is fed, and the first read stays held until the watcher invalidates it.
    writeFileSync(f.historyPath, bytes);
    writeFileSync(join(f.ledgerDirectory, "totals.json"), JSON.stringify({ version: 1, generationBasisVersion: 3, open: {}, settled: { m: true },
      sessions: { s: { tokens: record.tokens, cost: 0, responseCount: 1 } } }));
    writeFileSync(f.runsPath, [f.fact("s", "busy", 0), f.fact("s", "idle", 100)].map((fact) => JSON.stringify(fact)).join("\n") + "\n");
    await waitForLedger(() => f.store.historyGeneration > initialGeneration, "actual filesystem watcher must invalidate the held initial history generation");
    assert.ok(f.initialReadEntered(), "the original history read is still held; a runs idle may independently retire only its participant");
    f.advance(101); f.releaseHistory(bytes);
    await f.initialization;
    const completedOnReturn = f.store.completedMessageIDs.has("m");
    const activeOnReturn = f.store.active.has("m");
    await f.rendered.renderOnce();
    const immediate = f.rendered.captureCharFrame();
    f.send(102, "message.part.delta", { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "late" });
    f.send(103, "session.next.step.started", { sessionID: "s", messageID: "m", stepID: "late-step" });
    const activeAfterLate = f.store.active.has("m");
    // Diagnose a temporary startup window separately from permanent loss. This
    // wait is AFTER observing the immediate result, never an initialization fix.
    await waitForLedger(() => f.store.completedMessageIDs.has("m"), "latest requested history generation must eventually commit");
    assert.deepEqual({ completedOnReturn, activeOnReturn, activeAfterLate, eventuallyClosed: !f.store.active.has("m") },
      { completedOnReturn: true, activeOnReturn: false, activeAfterLate: false, eventuallyClosed: true },
      "initialization must drain, not return during the stale-read/deferred-read window");
    assert.match(immediate, /7 total/);
    assert.doesNotMatch(immediate, /tok\/s|LAST|LIVE|WARMUP|TTFT|avg/i);
    assert.equal(f.store.sessionRuntime.get("s")!.activeMessageID, undefined);
    assert.equal(f.store.records.find((record) => record.messageID === "m")!.tokens.output, 6);
  } finally { await f.close(); }
});

test("ledger watcher root idle preserves child union and old terminal cannot close a new root epoch", async () => {
  const f = await ledgerPluginFixture();
  try {
    const busy = [f.fact("s", "busy", 0), { version: 1, kind: "parent", sessionID: "child", parentSessionID: "s", timestamp: f.startedAt }, f.fact("child", "busy", 20)];
    await f.commitRuns(busy);
    f.send(0, "session.created", { info: { id: "child", parentID: "s" } });
    f.start(); f.send(20, "session.status", { sessionID: "child", status: "busy" });
    f.complete();
    const rootIdle = [...busy, f.fact("s", "idle", 200)];
    await f.commitRuns(rootIdle);
    await waitForLedger(() => f.store.sessionRuntime.get("s")!.status === "idle", "root must close even while child is busy");
    assert.equal(f.store.taskRuns.get("s")!.activeSessions.has("s"), false);
    assert.equal(f.store.taskRuns.get("s")!.activeSessions.has("child"), true);
    assert.equal(f.ui.hasLiveTaskWallActivity(f.store), true);
    assert.equal(f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 500), 500);
    f.send(1000, "session.status", { sessionID: "s", status: "busy" });
    f.send(1000, "message.updated", { info: { id: "next", sessionID: "s", role: "assistant", time: { created: f.startedAt + 1000 } } });
    const oldAndChildIdle = [...rootIdle, f.fact("child", "idle", 1100), f.fact("s", "busy", -1000, "old-server"), f.fact("s", "idle", 1500, "old-server")];
    await f.commitRuns(oldAndChildIdle);
    await waitForLedger(() => f.store.sessionRuntime.get("child")!.status === "idle", "child's own disk idle must close it");
    assert.equal(f.store.sessionRuntime.get("s")!.status, "busy");
    assert.equal(f.store.sessionRuntime.get("s")!.activeMessageID, "next");
    assert.equal(f.store.active.has("next"), true);
    await f.commitRuns([...rootIdle, f.fact("child", "idle", 1100), f.fact("s", "busy", 1000), f.fact("s", "idle", 1200)]);
    await waitForLedger(() => !f.ui.hasLiveTaskWallActivity(f.store), "new root closes only on its own canonical epoch");
    assert.equal(f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 60000), 1200);
  } finally { await f.close(); }
});

test("ledger watcher re-arms through late directories and projects a later atomic totals scope proof", async () => {
  const f = await ledgerPluginFixture(true);
  try {
    f.start();
    f.send(20, "session.created", { info: { id: "mc", parentID: "s" } });
    f.send(20, "session.status", { sessionID: "mc", status: "busy" });
    f.send(20, "message.updated", { info: { id: "mc-message", sessionID: "mc", role: "assistant", time: { created: f.startedAt + 20 } } });
    f.send(40, "message.updated", { info: { id: "mc-message", sessionID: "mc", role: "assistant", tokens: { input: 1, output: 100, reasoning: 0 }, time: { created: f.startedAt + 20, completed: f.startedAt + 40 } } });
    f.send(60, "message.updated", { info: { id: "mc-live", sessionID: "mc", role: "assistant", time: { created: f.startedAt + 60 } } });
    f.complete();
    const retained = f.ui.buildSessionDetailsTree(f.store, "s").including;
    assert.equal(retained.tokens.output + retained.tokens.reasoning, 106, "unknown identity retains usage until positive proof arrives");
    await mkdir(f.ledgerDirectory, { recursive: true });
    await f.commitRuns([f.fact("s", "busy", 0), f.fact("s", "idle", 200)]);
    await waitForLedger(() => f.store.sessionRuntime.get("s")!.status === "idle", "new ledger directories and file creation must be observed");
    assert.equal(f.ui.hasLiveTaskWallActivity(f.store), true, "unknown maintenance identity is not guessed away");
    const { createScopeRegistry } = await import("../src/scope.js");
    const registry = createScopeRegistry();
    registry.observeSessionMetadata("mc", { id: "mc", agent: "dreamer" });
    const staging = join(f.ledgerDirectory, "totals-write.pending");
    await writeFile(staging, JSON.stringify({ ...f.store.totalsLedger, sessionScopes: registry.serialize() }));
    await rename(staging, join(f.ledgerDirectory, "totals.json"));
    await waitForLedger(() => f.store.sourceScopes.isExcluded("mc"), "a late totals scope proof must invalidate projections without host events");
    assert.equal(f.store.active.has("mc-live"), false);
    assert.ok(f.store.records.every((record) => record.sessionID !== "mc"), "late proof retracts maintenance history too");
    const projected = f.ui.buildSessionDetailsTree(f.store, "s").including;
    assert.equal(projected.tokens.output + projected.tokens.reasoning, 6, "raw usage overlays cannot restore excluded maintenance totals");
    assert.equal(f.store.taskRuns.get("s")!.activeSessions.has("mc"), false);
    assert.equal(f.ui.hasLiveTaskWallActivity(f.store), false);
    assert.equal(f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 60000), 200);
    const historyGeneration = f.store.historyGeneration;
    await writeFile(join(f.ledgerDirectory, "unrelated.txt"), "not a ledger");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(f.store.historyGeneration, historyGeneration);
  } finally { await f.close(); }
});

test("actual narrow sidebar preserves full metric fields and task time without ellipses, independently of terminal width", async () => {
  const ui = (await uiPromise)!;
  const elapsed = (123 * 3600 + 45 * 60 + 56) * 1000;
  const counts = { input: 3_900_000, cacheRead: 6_100_000, output: 6_300_000, reasoning: 0, cacheWrite: 0 };
  const sessionID = "ses_eee872613ffeAXfSAWtXsJbYB4";
  {
    const store = readyStore(ui);
    store.totalsLedger.sessions[sessionID] = { tokens: counts, cost: 1, responseCount: 100 };
    const run = ui.createTaskWallRun(sessionID);
    ui.transitionTaskWallRun(run, sessionID, "busy", 1000);
    ui.transitionTaskWallRun(run, sessionID, "idle", elapsed + 1000);
    store.taskRuns.set(sessionID, run);
    const api = host(120, 160);
    const sidebar = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.sidebar_content!;
    let panel!: BoxRenderable;
    const rendered = await testRender(() => {
      const renderer = useRenderer();
      api.renderer = renderer;
      panel = new BoxRenderable(renderer, { width: 20, flexDirection: "column", flexShrink: 0 });
      panel.add(sidebar({ theme: api.theme }, { session_id: sessionID }) as unknown as Renderable);
      return panel as unknown as JSX.Element;
    }, { width: 120, height: 160 });
    try {
      for (const width of [20, 32]) {
        panel.width = width;
        await rendered.renderOnce();
        await rendered.renderOnce(); // Settle the actual sidebar's measured width after resize.
        const frame = rendered.captureCharFrame();
        const visible = frame.split("\n").map((line) => line.slice(0, width).trim()).filter(Boolean);
        assert.equal(visible[0], "+ Token Pulse");
        assert.ok(frame.split("\n").every((line) => line.slice(width).trim() === ""), `${width}: metrics must not spill outside the sidebar`);
        assert.doesNotMatch(frame, /\.\.\.|…|tok\/s|TPS|avg/i);
        assert.ok(panel.getChildren()[0].height <= 5, `${width}: collapsed contains only toggle + at most three metric rows`);
        for (const field of ["16,300,000 total", "cache 61%", "time 123h45m56s"]) {
          assert.ok(visible.some((line) => line.includes(field)), `${width}: missing or clipped ${field}`);
        }
        ui.togglePulse(store);
        await rendered.renderOnce();
        const expanded = rendered.captureCharFrame().split("\n").map((line) => line.slice(0, width).trim()).join("\n");
        const visibleGlyphs = expanded.replace(/\s+/g, "");
        assert.ok(visibleGlyphs.includes(`session${sessionID}`), `${width}: wrapping must preserve every full session ID character`);
        assert.doesNotMatch(expanded, /\.\.\.|…/);
        assert.match(expanded, /SESSION ONLY/);
        assert.ok(visibleGlyphs.includes("16,300,000"));
        assert.doesNotMatch(expanded, /\b(?:16\.3M|3\.9M|6\.1M|6\.3M)\b/);
        assert.doesNotMatch(expanded, /tok\/s|TPS|TTFT|peak|throughput|low confidence/i);
        ui.togglePulse(store);
        await rendered.renderOnce();
      }
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("narrow child rows preserve full agent names, IDs, models, counts and units across root and child routes", async () => {
  const ui = (await uiPromise)!;
  const sessionID = "ses_eee872613ffeAXfSAWtXsJbYB4";
  const children = [
    { id: "ses_eee872613ffeAXfSAWtXsJbYB5", parent: sessionID, model: "openai/gpt-5.4-thinking-extended", output: 4_200_000, calls: 1200, agents: ["oracle", "fixer"], agent: "fixer", label: "fixer / oracle" },
    { id: "ses_eee872613ffeAXfSAWtXsJbYB6", parent: "ses_eee872613ffeAXfSAWtXsJbYB5", model: "openrouter/x-ai/grok-4.1-fast-reasoning", output: 3_200_000, calls: 9000, agents: [], agent: "custom-nested-reviewer", label: "custom-nested-reviewer" },
    { id: "ses_fff872613ffeAXfSAWtXsJbYB7", parent: sessionID, model: "openrouter/x-ai/grok-4-without-generation-timing", output: 1_100_000, calls: 100_000, agents: [], agent: undefined, label: "" },
  ];
  const frames = [{ width: 20, routeID: sessionID }, { width: 20, routeID: children[0].id }];
  for (const { width, routeID } of frames) {
    const store = readyStore(ui);
    const tokens = (output: number) => ({ input: 0, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    store.totalsLedger.sessions[sessionID] = { tokens: tokens(115_000), cost: 1, responseCount: 1,
      speed: updateSpeedTotals(emptySpeedTotals(), v3Generation(115_000), 1) };
    store.totalsLedger.sessionAgents = { [sessionID]: ["root-only"] };
    for (const child of children) {
      store.totalsLedger.sessions[child.id] = { tokens: tokens(child.output), cost: 1, responseCount: child.calls };
      store.totalsLedger.sessionAgents[child.id] = child.agents;
      store.sessionParents.set(child.id, child.parent);
      store.totalsLedger.settled[`${child.id}-last`] = true;
    }
    store.records = children.map((child) => ({ version: 1, messageID: `${child.id}-last`, sessionID: child.id,
      model: child.model, agent: child.agent, tokens: tokens(child.output), cost: 1, time: { start: 0, completed: 1 }, samples: [],
      speed: { response: { generatedTokens: child.output, durationMs: 1, estimated: false } } }));
    store.pulseExpanded = true;
    const api = host(120, 180);
    const sidebar = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.sidebar_content!;
    const rendered = await testRender(() => {
      const renderer = useRenderer();
      api.renderer = renderer;
      const panel = new BoxRenderable(renderer, { width, flexDirection: "column", flexShrink: 0 });
      panel.add(sidebar({ theme: api.theme }, { session_id: routeID }) as unknown as Renderable);
      return panel as unknown as JSX.Element;
    }, { width: 120, height: 180 });
    try {
      await rendered.renderOnce();
      await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      const visible = frame.split("\n").map((line) => line.slice(0, width).replace(/^[\s│┃┆┊┇┋]+/, "")).join("\n");
      const glyphs = visible.replace(/\s+/g, "");
      assert.doesNotMatch(visible, /\.\.\.|…/);
      assert.ok(frame.split("\n").every((line) => line.slice(width).trim() === ""), `${width}: child rows must stay within the sidebar`);
      assert.ok(glyphs.includes(`session${routeID}`));
      assert.doesNotMatch(visible, /tok\/s|TPS|TTFT|avg|root-only|Agent unknown/i);
      const childGlyphs = glyphs.slice(glyphs.indexOf("CHILDAGENTS") + "CHILDAGENTS".length);
      const expected = routeID === sessionID ? children : [children[1]];
      for (const child of expected) {
        assert.ok(glyphs.includes(`${child.id}${child.calls.toLocaleString("en-US")}responses${child.output.toLocaleString("en-US")}generated`), `${width}: full child ID, exact counts and units must survive wrapping`);
        assert.ok(glyphs.includes(`model${child.model}`), `${width}: full model must survive wrapping`);
        assert.ok(childGlyphs.includes(`${child.label.replace(/\s+/g, "")}${child.id}`), `${width}: actual names appear before their own full SID`);
      }
      if (routeID === sessionID) {
        assert.ok(childGlyphs.indexOf(children[0].id) < childGlyphs.indexOf(children[1].id));
        assert.ok(childGlyphs.indexOf(children[1].id) < childGlyphs.indexOf(children[2].id));
      } else {
        assert.doesNotMatch(childGlyphs, /fixer|oracle/);
        assert.ok(!childGlyphs.includes(children[0].id));
        assert.ok(!childGlyphs.includes(children[2].id));
      }
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("native detail content fits the host dialog wrapper with fixed title/footer and scrolls to the bottom", async () => {
  const ui = (await uiPromise)!;
  {
  const width = 110, height = 40;
  const store = readyStore(ui);
  const sessionID = "session-test-with-long-id";
  store.totalsLedger.sessions[sessionID] = {
    tokens: { input: 10, output: 100, reasoning: 20, cacheRead: 2, cacheWrite: 1 }, cost: 1, responseCount: 2,
    speed: updateSpeedTotals(emptySpeedTotals(), {
      ...v3Generation(100, 20, 2000),
      response: { generatedTokens: 120, durationMs: 4000, estimated: false },
    }, 1),
  };
  const api = host(width, height);
  let content: Renderable;
  let panel: BoxRenderable;
  let backdrop: BoxRenderable;
  const rendered = await testRender(() => {
    const renderer = useRenderer();
    api.renderer = renderer;
    // v1.18.34 Dialog: backdrop top padding = terminal height / 4;
    // large panel width = 88, maxWidth = terminal width - 2, paddingTop = 1.
    // Without this wrapper, the old height = terminal height - 8 passed.
    backdrop = new BoxRenderable(renderer, {
      width, height, alignItems: "center", position: "absolute", left: 0, top: 0, paddingTop: height / 4,
    });
    panel = new BoxRenderable(renderer, { width: 88, maxWidth: width - 2, paddingTop: 1 });
    content = ui.TokenPulseDetails({ api, store, sessionID }) as unknown as Renderable;
    panel.add(content);
    backdrop.add(panel);
    return backdrop as unknown as JSX.Element;
  }, { width, height });
  try {
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    assert.equal(frame.match(/Token Pulse details/g)?.length, 1);
    if (width === 110) {
      assert.match(frame, /133/);
      assert.match(frame, /Model calls/);
      assert.doesNotMatch(frame, /tok\/s|TPS|TTFT|throughput|peak/i);
    }
    assert.match(frame, /esc \/ ctrl\+c to close/);
    assert.ok(content!.y + content!.height <= height - 1, `${width}x${height}: content exceeds host-visible budget`);
    assert.ok(panel!.y + panel!.height <= height - 1);
    const children = content!.getChildren();
    const title = children[0];
    const closeHint = children.at(-1)!;
    const titleY = title.y;
    const closeHintY = closeHint.y;
    const scroll = children.find((child) => child instanceof ScrollBoxRenderable) as ScrollBoxRenderable;
    assert.ok(scroll);
    assert.equal(scroll.focused, true);
    assert.ok(title.y >= panel!.y + 1);
    assert.ok(closeHint.y + closeHint.height <= height - 1);
    assert.ok(scroll.viewport.height > 0, "short terminals must retain usable scroll space");
    assert.ok(scroll.viewport.y + scroll.viewport.height <= closeHint.y, "body must not overlap the fixed close hint");
    assert.ok(scroll.scrollHeight > scroll.viewport.height);
    assert.ok(scroll.verticalScrollBar.width < scroll.width);
    scroll.scrollTo(scroll.scrollHeight);
    await rendered.renderOnce();
    const bottom = rendered.captureCharFrame();
    assert.match(bottom, /Estimated cost/);
    assert.match(bottom, /Token Pulse details/);
    assert.ok(scroll.scrollTop > 0);
    assert.equal(children[0].y, titleY);
    assert.equal(children.at(-1)!.y, closeHintY);
    assert.doesNotMatch(bottom, /tok\/s|TPS|TTFT|throughput|peak/i);
    assert.match(bottom, /esc \/ ctrl\+c to close/);
    if (width === 110) {
      rendered.resize(80, 24);
      // Follow the host's reactive backdrop/panel dimensions on resize.
      backdrop!.width = 80;
      backdrop!.height = 24;
      backdrop!.paddingTop = 6;
      panel!.maxWidth = 78;
      await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /Token Pulse details/);
      assert.match(rendered.captureCharFrame(), /esc \/ ctrl\+c to close/);
      assert.ok(content!.y + content!.height <= 23);
      assert.equal(content!.height, 16);
      scroll.scrollTo(scroll.scrollHeight);
      await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /Estimated cost/);
    }
  } finally {
    rendered.renderer.destroy();
    store.disposeSignals();
  }
  }
});

test("native session-tree selector switches direct details, retains ledger-only nodes and leaves footer fixed", async () => {
  const ui = (await uiPromise)!;
  {
    const width = 40, height = 16;
    const store = readyStore(ui);
    const scope = "scope-session-with-long-id";
    const makeDirect = (generated: number, generationMs: number, responseMs: number) => ({
      tokens: { input: 10, output: generated, reasoning: 0, cacheRead: 2, cacheWrite: 1 }, cost: 1, responseCount: 1,
      speed: updateSpeedTotals(emptySpeedTotals(), {
        ...v3Generation(generated, 0, generationMs),
        response: { generatedTokens: generated, durationMs: responseMs, estimated: false },
      }, 1),
    });
    store.totalsLedger.sessions = { [scope]: makeDirect(100, 1000, 2000), child: makeDirect(600, 2000, 3000),
      grand: makeDirect(30, 3000, 6000), unrelated: makeDirect(9000, 1000, 2000) };
    store.sessionParents = new Map([["child", scope], ["grand", "child"]]);
    for (let i = 0; i < 35; i++) store.sessionParents.set(`zz-${String(i).padStart(2, "0")}`, scope);
    store.lastCompletedBySession.set("child", ui.makeLastCompletedSnapshot({
      version: 1, messageID: "child-last", sessionID: "child", model: "known-child-model",
      tokens: store.totalsLedger.sessions.child.tokens, cost: 1,
      time: { start: 0, firstToken: 222, completed: 3000 }, samples: [],
      speed: v3Generation(600, 0, 2000, 222),
    }));
    const api = host(width, height);
    api.state = { session: { get: (id: string) => ({ title: id === scope ? "Main work" : id === "child" ? "Child work" : id === "grand" ? "Grand work" : undefined }) } } as unknown as TuiPluginApi["state"];
    let content: Renderable;
    const rendered = await testRender(() => {
      const renderer = useRenderer();
      api.renderer = renderer;
      const backdrop = new BoxRenderable(renderer, { width, height, alignItems: "center", paddingTop: height / 4 });
      const panel = new BoxRenderable(renderer, { width: 88, maxWidth: width - 2, paddingTop: 1 });
      content = ui.TokenPulseDetails({ api, store, sessionID: scope }) as unknown as Renderable;
      panel.add(content); backdrop.add(panel);
      return backdrop as unknown as JSX.Element;
    }, { width, height });
    try {
      await rendered.renderOnce();
      const children = content!.getChildren();
      const fixed = children.flatMap((node) => [node, ...node.getChildren()]);
      const selector = fixed.find((node) => node instanceof SelectRenderable) as SelectRenderable;
      const scroll = children.find((node) => node instanceof ScrollBoxRenderable) as ScrollBoxRenderable;
      const footer = children.at(-1)!;
      assert.ok(selector && scroll);
      assert.equal(selector.options.length, 38);
      assert.equal(selector.getSelectedOption()?.value, scope);
      assert.equal(selector.options.some((option) => option.value === "unrelated"), false);
      assert.equal(selector.focused, true);
      assert.ok(scroll.viewport.height > 0);
      assert.ok(scroll.viewport.y + scroll.viewport.height <= footer.y);
      assert.ok(footer.y + footer.height <= height - 1);
      assert.match(rendered.captureCharFrame(), /Token Pulse details/);
      assert.match(rendered.captureCharFrame(), /esc \/ ctrl\+c to close/);
      rendered.mockInput.pressArrow("down");
      await rendered.renderOnce();
      assert.equal(selector.getSelectedOption()?.value, "child");
      store.bump(); await rendered.renderOnce();
      assert.equal(selector.getSelectedOption()?.value, "child", "usage refresh must retain the selected session");
      store.sessionParents.set("aaa-new-child", scope);
      store.bump(); await rendered.renderOnce();
      assert.equal(selector.getSelectedOption()?.value, "child", "a newly inserted sibling must not change the selected ID");
      let selectedFrames = "";
      const footerY = footer.y;
      const titleY = children[0].y;
      for (let offset = 0; offset <= scroll.scrollHeight; offset += Math.max(1, scroll.viewport.height - 1)) {
        scroll.scrollTo(offset); await rendered.renderOnce();
        selectedFrames += rendered.captureCharFrame();
        assert.equal(footer.y, footerY);
        assert.equal(children[0].y, titleY);
      }
      assert.match(selectedFrames, /known-child-model/);
      assert.match(selectedFrames, /INCLUDING SUBAGENTS/);
      assert.match(selectedFrames, /730/);
      assert.doesNotMatch(selectedFrames, /tok\/s|TPS|TTFT|throughput|peak|222ms/i);
      scroll.scrollTo(scroll.scrollHeight); await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /Estimated cost/);
      assert.match(rendered.captureCharFrame(), /esc \/ ctrl\+c to close/);
      const next = fixed.flatMap((node) => [node, ...node.getChildren()]).find((node) => node instanceof TextRenderable && node.plainText === "[next]")!;
      await rendered.mockMouse.click(next.x, next.y);
      await rendered.renderOnce();
      assert.equal(selector.getSelectedOption()?.value, "grand");
      assert.equal(scroll.scrollTop, 0, "selecting another session resets its detail scroll");
      rendered.mockInput.pressTab(); await rendered.renderOnce();
      assert.equal(scroll.focused, true);
      rendered.mockInput.pressTab(); await rendered.renderOnce();
      assert.equal(selector.focused, true);
      rendered.mockInput.pressEnter(); await rendered.renderOnce();
      assert.equal(scroll.focused, true);
      rendered.mockInput.pressTab(); await rendered.renderOnce();
      assert.equal(selector.focused, true);
      selector.moveDown(1000); await rendered.renderOnce();
      assert.equal(selector.getSelectedOption()?.value, "zz-34");
      assert.match(rendered.captureCharFrame(), /zz-34/);
      assert.match(rendered.captureCharFrame(), /esc \/ ctrl\+c to close/);
      assert.equal(store.records.length, 0);
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("native complete history page keeps summary lines separate from its scrollable records", async () => {
  const ui = await uiPromise!;
  for (const [width, height] of [[140, 50], [40, 40]]) {
    const store = readyStore(ui, 100);
    store.sessionParents.set("child", "root");
    store.records = Array.from({ length: 36 }, (_, index) => ({
      version: 1, messageID: `history-${index}`, sessionID: index % 2 ? "child" : "root",
      ...(index % 2 ? { parentSessionID: "root" } : {}), model: "fixture-model",
      tokens: { input: 12345, output: 6789, reasoning: 234, cacheRead: 90123, cacheWrite: 4567 },
      cost: 0.125, time: { start: 1000 + index * 1000, completed: 1500 + index * 1000 }, samples: [],
    }));
    const api = host(width, height);
    const rendered = await testRender(() => ui.__testHistoryView({ api, store, sessionID: "root", options: ui.resolveOptions({}) }), { width, height });
    try {
      await rendered.renderOnce(); await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      const page = rendered.renderer.root.getChildren()[0];
      const [header, summary, columns, records] = page.getChildren();
      const summaryRows = summary.getChildren() as TextRenderable[];
      assert.equal(header.height, 2);
      assert.equal(summaryRows.length, 15);
      for (const [index, row] of summaryRows.entries()) {
        assert.ok(row.height >= 1, `summary line has no drawable row: ${row.plainText}`);
        if (index) assert.ok(row.y >= summaryRows[index - 1].y + summaryRows[index - 1].height,
          `summary lines overlap: ${summaryRows[index - 1].plainText} / ${row.plainText}`);
      }
      assert.ok(summary.y >= header.y + header.height);
      assert.ok(columns.y >= summary.y + summary.height);
      assert.equal(columns.height, 1);
      assert.ok(records instanceof ScrollBoxRenderable);
      assert.ok(records.viewport.y >= columns.y + columns.height);
      assert.ok(records.viewport.height > 0);
      assert.ok(records.viewport.y + records.viewport.height <= height);
      assert.match(frame, /Token history/); assert.match(frame, /Session only/);
      assert.match(frame, /Including subagents/); assert.match(frame, /Cache hit rate/);
      assert.match(frame, /00:00:36 child/);
      if (width >= 80) assert.match(frame, /fixture-model/);
      assert.doesNotMatch(frame, /tok\/s|TPS|TTFT|SeTotal|Cachehh/i);
      const summaryBeforeScroll = summaryRows.map((row) => ({ text: row.plainText, y: row.y, height: row.height }));
      records.scrollTo(records.scrollHeight); await rendered.renderOnce();
      assert.deepEqual(summaryRows.map((row) => ({ text: row.plainText, y: row.y, height: row.height })), summaryBeforeScroll);
      assert.ok(records.scrollTop > 0);
      assert.match(rendered.captureCharFrame(), /00:00:13 root/);
      if (width >= 80) assert.match(rendered.captureCharFrame(), /fixture-model/);
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("native open details becomes an explicit empty state on late MC proof without clearing a host replacement", async () => {
  const ui = await uiPromise!;
  const store = readyStore(ui);
  const api = host(110, 40);
  api.route = { current: { name: "session", params: { sessionID: "root" } } } as TuiPluginApi["route"];
  let content = () => null as JSX.Element;
  let closed: (() => void) | undefined;
  let cleared = 0;
  api.ui = { dialog: { open: false, replace(render: () => JSX.Element, onClose?: () => void) { content = render; closed = onClose; }, setSize() {}, clear() { cleared++; } }, toast() {} } as unknown as TuiPluginApi["ui"];
  const controller = ui.createDetailsController(api, store);
  assert.equal(controller.open(), "root");
  const rendered = await testRender(content, { width: 110, height: 40 });
  try {
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /SELECTED SESSION/);
    ui.cacheSessionParentFromEvent(store, { type: "session.updated", properties: { info: { id: "root", agent: "historian" } } });
    store.bump(); await rendered.renderOnce(); await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    assert.match(frame, /Maintenance session excluded/);
    assert.doesNotMatch(frame, /SELECTED SESSION/);
    assert.equal(cleared, 0, "an empty tree updates in place, it does not clear a shared host dialog");
    assert.deepEqual(ui.buildSessionDetailsTree(store, "root").nodes, []);
    assert.doesNotThrow(() => ui.selectSessionDetails(ui.buildSessionDetailsTree(store, "root"), "root", store.lastCompletedBySession));
    closed?.(); // The host replaces this modal, relinquishing plugin ownership.
    assert.equal(controller.owned, false);
    store.bump(); await rendered.renderOnce();
    assert.equal(cleared, 0);
  } finally { rendered.renderer.destroy(); store.disposeSignals(); }
});

test("V2 TUI scrollable sidebar, history and details preserve native layout and usage without speed fields", async () => {
  const ui = await uiPromise!;
  const directory = await mkdtemp(join(cacheRoot, "v2-tui-render-"));
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const color = RGBA.fromHex("#eeeeee");
  let listener: (input: { details: any }) => void = () => {};
  let sidebarContent: any;
  let page: any;
  let dialog: () => JSX.Element = () => null;
  const layers: any[] = [];
  const context = {
    options: { maxRecords: 100 }, location: { directory }, app: { version: "2.0.27" },
    renderer: { width: 120, height: 100 },
    theme: { hue: { interactive: { 500: color }, accent: { 500: color } },
      text: { base: color, muted: color, action: { secondary: { base: color } }, feedback: { info: { base: color } } },
      background: { base: color, raised: { base: color, high: color } }, border: { base: color } },
    data: { listen(callback: typeof listener) { listener = callback; return () => {}; }, session: {
      get: (id: string) => ({ id, location: { directory }, title: id === "child" ? "Review" : "Root", ...(id === "child" ? { parentID: "root" } : {}) }),
    } },
    keymap: { layer(factory: () => unknown) { layers.push(factory()); }, mode: { current: () => "base", push: () => () => {} } },
    ui: { slot(claim: any) { sidebarContent = claim; return () => {}; },
      router: { register(value: any) { page = value; return () => {}; }, current: () => ({ type: "session", sessionID: "root" }), navigate: () => {} },
      dialog: { show(render: () => JSX.Element) { dialog = render; }, set: () => {}, clear: () => { dialog = () => null; } }, toast: { show: () => {} } },
  };
  let cleanup: (() => void | Promise<void>) | undefined;
  const renders: Awaited<ReturnType<typeof testRender>>[] = [];
  try {
    cleanup = await ui.default.setup(context as any) as () => Promise<void>;
    assert.equal(sidebarContent.append, "sidebar.content");
    const store = ui.__testRuntimeStores.at(-1)!;
    let seq = 0;
    const send = (type: string, data: any, elapsed: number) => { now += elapsed; listener({ details: {
      id: `evt_${++seq}`, created: now, type, data, durable: { aggregateID: data.sessionID, seq, version: 1 }, location: { directory },
    } }); };
    for (const [id, agent] of [["root", "build"], ["child", "review"]]) {
      send("session.execution.started", { sessionID: id }, 1);
      send("session.step.started", { sessionID: id, assistantMessageID: `msg_${id}`, agent,
        model: { providerID: "fixture", id: "fixture-model" }, started: now + 1 }, 1);
      send("session.step.ended", { sessionID: id, assistantMessageID: `msg_${id}`, finish: "stop", cost: 0.5,
        tokens: { input: 12, output: 7, reasoning: 3, cache: { read: 9, write: 2 } } }, 1000);
      send("session.execution.succeeded", { sessionID: id }, 1);
    }
    const noSpeed = (frame: string) => assert.doesNotMatch(frame, /tok\/s|TPS|TTFT|throughput|peak|WARMUP/i);
    {
      const width = 40;
      store.pulseExpanded = false; store.bump();
      const rendered = await testRender(() => sidebarContent.render({ sessionID: "root" }), { width, height: 100 });
      renders.push(rendered);
      await rendered.renderOnce(); await rendered.renderOnce();
      const collapsed = rendered.captureCharFrame();
      assert.match(collapsed, /\+ Token Pulse/); assert.match(collapsed, /66 total/);
      assert.match(collapsed, /cache 39%/); assert.match(collapsed, /time --/); noSpeed(collapsed);
      const header = rendered.renderer.root.getChildren()[0].getChildren()[0];
      await rendered.mockMouse.click(header.x + 1, header.y); await rendered.renderOnce();
      const expanded = rendered.captureCharFrame();
      assert.match(expanded, /SESSION ONLY/); assert.match(expanded, /INCLUDING\s+SUBAGENTS/);
      assert.match(expanded, /CHILD AGENTS/); assert.match(expanded, /review/); noSpeed(expanded);
      const dataRevision = store.revision();
      for (let i = 0; i < 20; i++) store.tick(); await rendered.renderOnce();
      assert.equal(store.revision(), dataRevision);
      assert.equal(rendered.captureCharFrame(), expanded, "clock-only frames cannot change completed usage");
      rendered.renderer.destroy(); renders.pop();
    }
    store.pulseExpanded = false; store.bump();
    let sidebarScroll!: ScrollBoxRenderable;
    const list = await testRender(() => ui.__testSidebarList({ render: () => sidebarContent.render({ sessionID: "root" }),
      scrollRef: (node) => { sidebarScroll = node; } }), { width: 40, height: 14 }); renders.push(list);
    await list.renderOnce(); await list.renderOnce();
    const descendants = (node: Renderable): Renderable[] => node.getChildren().flatMap((child) => [child, ...descendants(child)]);
    const pulse = descendants(sidebarScroll.content).find((node) => node instanceof TextRenderable && node.plainText === "+ Token Pulse")!;
    assert.ok(pulse, "Pulse is inside the sidebar scrollbox content, not the fixed footer");
    const fixedFooter = descendants(list.renderer.root).find((node) => node instanceof TextRenderable && node.plainText === "HOST FOOTER")!;
    const pulseY = pulse.y; const footerY = fixedFooter.y;
    assert.doesNotMatch(list.captureCharFrame(), /Token Pulse/, "Pulse follows existing list rows below the viewport");
    sidebarScroll.scrollTo(sidebarScroll.scrollHeight); await list.renderOnce();
    assert.match(list.captureCharFrame(), /\+ Token Pulse/);
    assert.ok(pulse.y < pulseY, "Pulse moves with the list when it scrolls");
    assert.equal(fixedFooter.y, footerY, "Only the host's footer remains fixed");
    noSpeed(list.captureCharFrame());
    list.renderer.destroy(); renders.pop();
    layers[0].commands.find((command: any) => command.id === "oc-tps.details").run();
    const details = await testRender(dialog, { width: 120, height: 100 }); renders.push(details);
    await details.renderOnce();
    assert.match(details.captureCharFrame(), /Token Pulse details/);
    assert.match(details.captureCharFrame(), /Estimated cost/); noSpeed(details.captureCharFrame());
    details.renderer.destroy(); renders.pop();
    const history = await testRender(() => page.render({ data: { sessionID: "root" } }), { width: 120, height: 40 }); renders.push(history);
    await history.renderOnce();
    assert.match(history.captureCharFrame(), /Token history/); assert.match(history.captureCharFrame(), /fixture-model/);
    noSpeed(history.captureCharFrame());
    const settled = ui.taskWallTimeForSession(store, "root", now)!;
    listener({ details: { type: "server.connected" } });
    send("session.execution.started", { sessionID: "root" }, 10);
    send("session.retry.scheduled", { sessionID: "root" }, 10);
    const preGapEpoch = store.sessionRuntime.get("root")!.runEpoch;
    now += 1000;
    listener({ details: { type: "server.connected" } });
    assert.equal(ui.taskWallTimeForSession(store, "root", now + 3600000), settled + 10,
      "actual initialized plugin freezes the last known prefix, not the reconnect gap");
    assert.equal(ui.hasLiveTaskWallActivity(store), false);
    send("session.execution.started", { sessionID: "root" }, 1000);
    assert.equal(store.sessionRuntime.get("root")!.runEpoch, preGapEpoch + 1, "a fresh observation starts a new runtime epoch without inventing an idle fact");
    send("session.execution.succeeded", { sessionID: "root" }, 5);
    assert.equal(ui.taskWallTimeForSession(store, "root", now + 3600000), settled + 15);
    await cleanup?.(); cleanup = undefined;
    const revision = store.revision(); const clock = store.clockRevision();
    listener({ details: { type: "server.connected" } });
    listener({ details: { type: "session.text.delta", get data() { throw new Error("disposed stream body must not be read"); } } });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(store.revision(), revision); assert.equal(store.clockRevision(), clock);
    assert.equal(store.active.size, 0); assert.equal(store.optimistic.size, 0); assert.equal(store.sessionRuntime.size, 0);
  } finally {
    for (const rendered of renders) rendered.renderer.destroy();
    await cleanup?.(); Date.now = originalNow;
    await rm(directory, { recursive: true, force: true });
  }
});

}
