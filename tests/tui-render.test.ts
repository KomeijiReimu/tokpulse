import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { writeFileSync, constants } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoxRenderable, RGBA, Renderable, ScrollBoxRenderable, SelectRenderable, TextRenderable } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { emptySpeedTotals, updateSpeedTotals, type SpeedContribution } from "../src/statistics.js";
import { tuiReadModel } from "../src/tui-read-model.js";
import type { ParentProofOutcome, ParentProofWake } from "../src/tui-read-model.js";

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
type RenderedTui = typeof import("../src/tui.js") & { __testRuntimeStores: ReturnType<typeof import("../src/tui.js").createRuntimeStore>[]; __testActivityReads: number[];
  __testHashCalls: number;
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
  const sourceText = process.env.TOKPULSE_TUI_BASELINE_FILE ? await readFile(process.env.TOKPULSE_TUI_BASELINE_FILE, "utf8") : process.env.TOKPULSE_TUI_BASELINE === "HEAD"
    ? (await promisify(execFile)("git", ["show", "HEAD:src/tui.tsx"], { cwd: dirname(source) })).stdout
    : await readFile(source, "utf8");
  // A read-only capture in the isolated test compilation exposes the actual
  // plugin's store. It does not replace event adapters, subscribers or hydration.
  const storeCreation = "const store = createRuntimeStore(options.maxRecords);";
  assert.equal(sourceText.split(storeCreation).length, 2);
  const observedSource = `export const __testRuntimeStores = []; export const __testActivityReads = []; export let __testHashCalls = 0;\n${sourceText.replace(storeCreation, `${storeCreation}\n__testRuntimeStores.push(store);`).replaceAll('createHash("sha256")', '(__testHashCalls++, createHash("sha256"))').replace("const delta = await readActivityDelta(path, selection.cursor);", "const delta = await readActivityDelta(path, selection.cursor); __testActivityReads.push(generation);")}
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

if (!nativeChild) {
  test("native OpenTUI sidebar and dialog render checks (isolated Solid host)", { timeout: 30000 }, async () => {
    // The host preloads Solid's client runtime. Isolate it so these checks do
    // not change the Solid instance used by the pure runtime test suite.
    const output = await promisify(execFile)(process.execPath, [
      "test", "--preload", "@opentui/solid/preload", fileURLToPath(import.meta.url),
    ], { timeout: 25000, cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
      ...process.env, TOKPULSE_NATIVE_RENDER: "1", TMPDIR: cacheRoot,
    } });
    assert.match(output.stderr + output.stdout, /28 pass/);
  });
}

if (nativeChild) {
function reportFrame(name: string, frame: string): void {
  if (process.env.TOKPULSE_UI_FRAMES === "1") console.log(`FRAME ${name}\n${frame.split("\n").map((line) => line.trimEnd()).filter(Boolean).join("\n")}\nEND FRAME`);
}

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
  const api = { ...host(80, 40), state: { path: { worktree: directory, directory }, session: { get: () => undefined }, part: () => [] },
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
    const awaitEventRead = async (before: number) => {
      await waitForLedger(() => ui.__testActivityReads.length > before && ui.__testActivityReads.at(-1) === store.activityGeneration,
        "the initial post-completion activity read must have returned before delayed server commit");
    };
    return { ui, store, rendered, directory, ledgerDirectory, historyPath, runsPath, startedAt, send, fact, commitRuns, complete, start, awaitEventRead, dispose, initialization, toasts,
      subscriptionCount: () => handlers.size,
      captureHandler: (type: string) => handlers.get(type),
      initialReadEntered: () => entered,
      releaseHistory: (bytes: string) => { released = true; release(bytes); },
      advance: (offset: number) => { clock = startedAt + offset; },
      close: async () => { await dispose(); if (!released) release(""); await initialization; restoreFilesystem(); rendered?.renderer.destroy(); Date.now = originalNow; await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await dispose(); if (!released) release(""); await initialization; restoreFilesystem(); rendered?.renderer.destroy(); Date.now = originalNow; await rm(directory, { recursive: true, force: true }); throw error; }
}

for (const shape of ["deep", "wide", "cycle"] as const) for (const n of [1000, 2000, 4000])
test(`A2-07 actual plugin disposal ${shape} ${n} stops resources and discards parent graph linearly`, async () => {
  const bunTestModule = "bun:test";
  const { mock } = await import(bunTestModule), originalFs = { ...await import("node:fs") };
  const watches = new Set<import("node:fs").FSWatcher>(); let opened = 0, closeRequests = 0, closed = 0;
  mock.module("node:fs", () => ({ ...originalFs, watch(...args: any[]) {
    const watcher = (originalFs.watch as (...values: any[]) => import("node:fs").FSWatcher)(...args), close = watcher.close.bind(watcher);
    opened++; watches.add(watcher); watcher.once("close", () => { closed++; watches.delete(watcher); });
    watcher.close = () => { closeRequests++; return close(); }; return watcher;
  } }));
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const id = set(handler, delay, ...args); if (String(handler).includes("hasLiveTaskWallActivity")) intervals.add(id); return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { intervals.delete(id as ReturnType<typeof setInterval>); return clear(id); }) as typeof clearInterval;
  let f: Awaited<ReturnType<typeof ledgerPluginFixture>> | undefined;
  try {
    f = await ledgerPluginFixture(); const model = tuiReadModel(f.store);
    model.canonicalParents(Array.from({ length: n }, (_, i) => ({ version: 2, kind: "parent", sessionID: `p${i}`,
      parentSessionID: shape === "wide" ? (i ? "p0" : undefined) : i ? `p${i - 1}` : shape === "cycle" ? `p${n - 1}` : undefined,
      instanceID: "cleanup-fixture", eventID: `cleanup:${i}`, seq: i, timestamp: i, observedAt: i } as const)), false);
    const proofListeners = new Set<(event: ParentProofWake) => void>(); let lateProof: ((outcome: ParentProofOutcome, version: number) => void) | undefined, targetVersion = 0;
    model.bindProof({ epoch: () => 0, request(_id, version, receive) { targetVersion = version; lateProof = receive; return true; },
      available(receive) { proofListeners.add(receive); return () => { proofListeners.delete(receive); }; } });
    model.observeParent("p0", { parent: "incomparable-live-parent", origin: "live", sourceEpoch: "other-source" });
    assert.ok(lateProof, "real read model must hold an admitted proof when teardown begins"); f.start();
    const lateEvent = f.captureHandler("session.updated")!, reads = f.ui.__testActivityReads.length;
    assert.ok(opened > 0, "instrument actual production watchers, not a standalone Map.clear"); assert.equal(intervals.size, 1);
    const before = model.diagnostics(), started = performance.now(); await f.dispose(); const cleanupMs = performance.now() - started;
    const operations = model.diagnostics().parentVisits - before.parentVisits, parentsAfterCleanup = f.store.sessionParents.size;
    const revision = f.store.revision(), clockRevision = f.store.clockRevision(), generation = f.store.activityGeneration;
    lateEvent({ type: "session.updated", properties: { sessionID: "late", parentID: "late-parent" } }, { directory: f.directory, workspace: undefined });
    lateProof!({ status: "success", parent: "late-after-disposal" }, targetVersion);
    await writeFile(f.runsPath, JSON.stringify(f.fact("s", "busy", 900)) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const actual = { opened, closeRequests, closed, watches: watches.size, intervals: intervals.size,
      subscriptions: f.subscriptionCount(), proofSubscriptions: proofListeners.size, parentsAfterCleanup, parentsAfterLate: f.store.sessionParents.size,
      stoppedReads: f.ui.__testActivityReads.length === reads, stoppedGeneration: f.store.activityGeneration === generation,
      stoppedRevision: f.store.revision() === revision, stoppedClock: f.store.clockRevision() === clockRevision,
      active: f.store.active.size, optimistic: f.store.optimistic.size, linear: operations <= n * 16 + 100 };
    console.log(`A2-07 ${JSON.stringify({ shape, n, cleanupMs, parentVisits: operations, actual })}`);
    assert.deepEqual(actual, { opened, closeRequests: opened, closed: opened, watches: 0, intervals: 0, subscriptions: 0, proofSubscriptions: 0,
      parentsAfterCleanup: 0, parentsAfterLate: 0, stoppedReads: true, stoppedGeneration: true, stoppedRevision: true, stoppedClock: true,
      active: 0, optimistic: 0, linear: true });
  } finally {
    await f?.close(); for (const watcher of watches) watcher.close();
    globalThis.setInterval = set; globalThis.clearInterval = clear; mock.module("node:fs", () => originalFs);
  }
});

test("actual fs.watch accepts a concurrent append without warnings and renders the exact duration", async () => {
  const f = await ledgerPluginFixture(); const originals = { ...fsPromises };
  const bunTestModule = "bun:test"; const { mock } = await import(bunTestModule);
  let injected = false;
  try {
    f.advance(1001); await f.commitRuns([f.fact("s", "busy", 0), f.fact("s", "idle", 1000)]);
    await waitForLedger(() => f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 2000) === 1000, "actual watch must hydrate the first canonical generation");
    const baseline = f.ui.tuiActivityDiagnostics(f.store), started = performance.now();
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
    const queryMs = performance.now() - started, after = f.ui.tuiActivityDiagnostics(f.store);
    assert.ok(injected);
    assert.equal(after.readRetries, baseline.readRetries, "normal appends must not reject the captured prefix");
    assert.deepEqual(f.toasts, [], "concurrent appends must not produce activity read warnings");
    assert.equal(after.canonicalIngested - baseline.canonicalIngested, 4); assert.equal(after.canonicalResets, baseline.canonicalResets);
    const frameStart = performance.now(); await f.rendered.renderOnce(); const frame = f.rendered.captureCharFrame();
    assert.match(frame, /time 3s/); assert.doesNotMatch(frame, /TPS|TTFT|tok\/s/i);
    assert.equal(tuiReadModel(f.store).counters.rowDerivations, 0, "collapsed native frame never derives hidden child rows");
    reportFrame("G2 watch committed append 80x40", frame);
    console.log(`G2 watch-query-ms=${queryMs.toFixed(2)} separate-frame-ms=${(performance.now() - frameStart).toFixed(2)} canonical-new=${after.canonicalIngested - baseline.canonicalIngested} retries=${after.readRetries - baseline.readRetries} stale=${after.staleReads - baseline.staleReads}`);
    f.advance(3605001); assert.equal(f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 3605001), 3000);
  } finally { mock.module("node:fs/promises", () => originals); await f.close(); }
});

test("G2 actual fs.watch publishes successive committed prefixes while the bounded writer is still active", async () => {
  const f = await ledgerPluginFixture(); let written = 0, active = true;
  let writer: ReturnType<typeof setInterval> | undefined;
  try {
    f.advance(1001); await f.commitRuns([f.fact("s", "busy", 0), f.fact("s", "idle", 1000)]);
    await waitForLedger(() => f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 1001) === 1000, "initial watch prefix");
    const started = performance.now(), baseline = f.ui.tuiActivityDiagnostics(f.store);
    writer = setInterval(() => {
      const begin = 2000 + written * 2000;
      writeFileSync(f.runsPath, [f.fact("s", "busy", begin), f.fact("s", "idle", begin + 1000)].map((value) => JSON.stringify(value)).join("\n") + "\n", { flag: "a" });
      f.advance(begin + 1001); written++;
      if (written === 40) { active = false; clearInterval(writer); }
    }, 15);
    await waitForLedger(() => active && f.ui.tuiActivityDiagnostics(f.store).canonicalIngested > baseline.canonicalIngested,
      "watch must publish without waiting for the writer to stop");
    const first = f.ui.tuiActivityDiagnostics(f.store).canonicalIngested;
    await waitForLedger(() => active && f.ui.tuiActivityDiagnostics(f.store).canonicalIngested > first,
      "a second committed prefix must publish while writes continue");
    assert.ok(written < 40); const progressMs = performance.now() - started, atProgress = written;
    clearInterval(writer); writer = undefined; active = false;
    await waitForLedger(() => f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 3600000) === (1 + written) * 1000,
      "final pending prefix drains after bounded writer cleanup");
    const after = f.ui.tuiActivityDiagnostics(f.store);
    assert.equal(after.canonicalResets, baseline.canonicalResets); assert.equal(after.canonicalIngested - baseline.canonicalIngested, written * 2);
    assert.deepEqual(f.toasts, [], "continuous append traffic must not produce activity read warnings");
    console.log(`G2 continuous-watch progress-ms=${progressMs.toFixed(2)} writes-before-second-prefix=${atProgress}/40 canonical-appends=${after.canonicalAppends - baseline.canonicalAppends}`);
  } finally { if (writer) clearInterval(writer); await f.close(); }
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
    assert.match(f.rendered.captureCharFrame(), /0 total/);
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

test("ledger watcher actual plugin observes delayed canonical root idle after its event read, without another host event", async () => {
  const f = await ledgerPluginFixture();
  try {
    await f.commitRuns([f.fact("s", "busy", 0)]);
    f.start();
    const before = f.ui.__testActivityReads.length;
    f.complete();
    await f.awaitEventRead(before);
    assert.equal(f.store.sessionRuntime.get("s")!.status, "busy");
    assert.ok(f.store.activityEvents.some((event) => event.kind === "lifecycle" && event.state === "busy"));
    // Server SDK idle query commits later than the one 30ms event-triggered read.
    await f.commitRuns([f.fact("s", "busy", 0), f.fact("s", "idle", 200)]);
    await waitForLedger(() => f.store.sessionRuntime.get("s")!.status === "idle", "delayed canonical root idle must retire the local participant");
    assert.equal(f.store.taskRuns.get("s")!.activeSessions.has("s"), false);
    assert.equal(f.ui.hasLiveTaskWallActivity(f.store), false);
    assert.equal(f.ui.taskWallTimeForSession(f.store, "s", f.startedAt + 1000), 200);
    await f.rendered.renderOnce(); await f.rendered.renderOnce();
    const frozen = f.rendered.captureCharFrame();
    f.advance(60000); await new Promise((resolve) => setTimeout(resolve, 520)); await f.rendered.renderOnce();
    assert.equal(f.rendered.captureCharFrame(), frozen);
    await f.dispose();
    const reads = f.ui.__testActivityReads.length;
    const generations = [f.store.activityGeneration, f.store.historyGeneration, f.store.clockRevision()];
    await f.commitRuns([f.fact("s", "busy", 61000)]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(f.ui.__testActivityReads.length, reads, "disposed file watchers cannot launch another read");
    assert.deepEqual([f.store.activityGeneration, f.store.historyGeneration, f.store.clockRevision()], generations);
  } finally { await f.close(); }
});

test("ledger watcher root idle preserves child union and old terminal cannot close a new root epoch", async () => {
  const f = await ledgerPluginFixture();
  try {
    const busy = [f.fact("s", "busy", 0), { version: 1, kind: "parent", sessionID: "child", parentSessionID: "s", timestamp: f.startedAt }, f.fact("child", "busy", 20)];
    await f.commitRuns(busy);
    f.send(0, "session.created", { info: { id: "child", parentID: "s" } });
    f.start(); f.send(20, "session.status", { sessionID: "child", status: "busy" });
    const before = f.ui.__testActivityReads.length; f.complete(); await f.awaitEventRead(before);
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
    const before = f.ui.__testActivityReads.length; f.complete(); await f.awaitEventRead(before);
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
    const reads = f.ui.__testActivityReads.length;
    const historyGeneration = f.store.historyGeneration;
    await writeFile(join(f.ledgerDirectory, "unrelated.txt"), "not a ledger");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(f.ui.__testActivityReads.length, reads, "unrelated directory changes must not replay activity");
    assert.equal(f.store.historyGeneration, historyGeneration);
  } finally { await f.close(); }
});

test("actual plugin content subscriptions do no session lookup or totals projection", async () => {
  const ui = (await uiPromise)!;
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(join(cacheRoot, "content-noop-"));
  const handlers = new Map<string, (event: unknown) => void>();
  const disposers: (() => void | Promise<void>)[] = [];
  let lookups = 0;
  let restoreWrites = () => {};
  const api = { ...host(80, 24),
    state: { path: { worktree: directory, directory }, session: { get: () => { lookups += 1; return undefined; } }, part: () => [] },
    route: { current: { name: "session", params: { sessionID: "s" } }, register: () => {}, navigate: () => {} },
    mode: { push: () => () => {} }, keymap: { registerLayer: () => () => {} }, ui: { toast: () => {}, dialog: { open: false } },
    slots: { register: () => "content-noop" },
    event: { on: (type: string, callback: (event: unknown) => void) => { handlers.set(type, callback); return () => handlers.delete(type); } },
    lifecycle: { onDispose: (dispose: () => void | Promise<void>) => { disposers.push(dispose); return () => {}; } },
  } as unknown as TuiPluginApi;
  try {
    await ui.default.tui(api, { historyPath: join(directory, "history.jsonl") }, {} as never);
    const store = ui.__testRuntimeStores.at(-1)!;
    const revision = store.revision();
    const clockRevision = store.clockRevision();
    const ledger = store.totalsLedger;
    const before = lookups;
    const hashes = ui.__testHashCalls;
    let writes = 0;
    const originals = { ...fsPromises };
    const bunTestModule = "bun:test";
    const { mock } = await import(bunTestModule);
    const spy = (fn: (...args: any[]) => any) => (...args: any[]) => { writes++; return fn(...args); };
    mock.module("node:fs/promises", () => ({ ...originals, writeFile: spy(originals.writeFile), appendFile: spy(originals.appendFile),
      rename: spy(originals.rename), rm: spy(originals.rm), mkdir: spy(originals.mkdir), open(...args: Parameters<typeof fsPromises.open>) {
        if (typeof args[1] === "number" && (args[1] & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND))) writes++;
        return originals.open(...args);
      } }));
    restoreWrites = () => { mock.module("node:fs/promises", () => originals); };
    let agentReads = 0;
    let metadataReads = 0;
    const types = ["message.part.delta", "message.part.updated", "session.next.text.delta", "session.next.reasoning.delta", "session.next.tool.input.delta"];
    for (let index = 0; index < 40; index++) {
      const type = types[index % types.length];
      handlers.get(type)!({ type, properties: { sessionID: "s", messageID: "m", partID: "p", textID: "p", reasoningID: "p", callID: "p",
        get agent() { agentReads += 1; return "delta-must-not-be-read"; },
        get info() { metadataReads += 1; return { get agent() { agentReads += 1; return "delta-must-not-be-read"; } }; },
        field: "text", delta: "x".repeat(1000),
        get part() { metadataReads += 1; return { id: "p", messageID: "m", sessionID: "s",
          get agent() { agentReads += 1; return "delta-must-not-be-read"; }, type: "text", text: "x".repeat(1000) }; } } });
    }
    for (const type of types) handlers.get(type)!({ type,
      get properties() { throw new Error("content properties were read"); }, get data() { throw new Error("content data was read"); },
      get event() { throw new Error("typed content event wrapper was read"); }, get payload() { throw new Error("typed content payload was read"); } });
    mock.module("node:fs/promises", () => originals);
    assert.equal(writes, 0, "content cannot write, recover, compact or create ledgers");
    assert.equal(ui.__testHashCalls, hashes, "content cannot enter completion/body hashing");
    assert.equal(lookups, before);
    assert.equal(store.revision(), revision);
    assert.equal(store.clockRevision(), clockRevision);
    assert.equal(store.totalsLedger, ledger);
    assert.equal(agentReads, 0, "content events must return before reading agent fields");
    assert.equal(metadataReads, 0, "content events must return before inspecting info or part metadata");
    assert.equal(store.active.size, 0);
    assert.equal(store.records.length, 0);
    assert.equal(Object.keys(store.totalsLedger.sessionAgents ?? {}).length, 0);
  } finally {
    restoreWrites();
    for (const dispose of disposers.reverse()) await dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual plugin subscription retires anonymous step compatibility before idle and retains the real two-part gap", async () => {
  const ui = (await uiPromise)!;
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(join(cacheRoot, "actual-plugin-"));
  const handlers = new Map<string, (event: unknown, metadata?: { directory: string; workspace: undefined }) => void>();
  const disposers: (() => void | Promise<void>)[] = [];
  const originalNow = Date.now;
  const originalMono = performance.now;
  let clock = 1000;
  Date.now = () => clock;
  performance.now = () => clock;
  let registered!: ReturnType<typeof ui.createTuiSlotPlugin>;
  const api = { ...host(120, 160),
    state: { path: { worktree: directory, directory }, session: { get: () => undefined }, part: () => [] },
    route: { current: { name: "session", params: { sessionID: "s" } }, register: () => {}, navigate: () => {} },
    mode: { push: () => () => {} }, keymap: { registerLayer: () => () => {} },
    ui: { toast: () => {}, dialog: { open: false } },
    slots: { register: (plugin: typeof registered) => { registered = plugin; return "actual-plugin"; } },
    event: { on: (type: string, callback: (event: unknown) => void) => { handlers.set(type, callback); return () => handlers.delete(type); } },
    lifecycle: { onDispose: (dispose: () => void | Promise<void>) => { disposers.push(dispose); return () => {}; } },
  } as unknown as TuiPluginApi;
  let rendered: Awaited<ReturnType<typeof testRender>> | undefined;
  const send = (at: number, type: string, properties: Record<string, unknown>) => {
    clock = at;
    assert.ok(handlers.has(type), `the real plugin must register ${type}`);
    // TuiEventBus.on delivers the SDK Event itself, not a direct-helper adapter.
    handlers.get(type)!({ type, properties, timestamp: at }, { directory, workspace: undefined });
  };
  try {
    await ui.default.tui(api, { historyPath: join(directory, "history.jsonl") }, {} as never);
    rendered = await testRender(() => {
      api.renderer = useRenderer();
      const panel = new BoxRenderable(api.renderer, { width: 120, flexDirection: "column" });
      panel.add(registered.slots!.sidebar_content!({ theme: api.theme }, { session_id: "s" }) as unknown as Renderable);
      return panel as unknown as JSX.Element;
    }, { width: 120, height: 160 });
    send(1100, "session.status", { sessionID: "s", status: { type: "busy" } });
    send(1100, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1100 } } });
    send(1110, "session.next.step.started", { sessionID: "s", messageID: "m", stepID: "step" });
    send(1120, "session.next.step.started", { sessionID: "s", stepID: "step" });
    send(1200, "message.part.updated", { part: { id: "space", messageID: "m", sessionID: "s", type: "text", text: "" } });
    send(1300, "message.part.delta", { sessionID: "s", messageID: "m", partID: "space", field: "text", delta: " " });
    send(1310, "message.part.updated", { part: { id: "space", messageID: "m", sessionID: "s", type: "text", text: "", time: { end: 1310 } } });
    send(11400, "message.part.updated", { part: { id: "body", messageID: "m", sessionID: "s", type: "text", text: "" } });
    send(11500, "message.part.delta", { sessionID: "s", messageID: "m", partID: "body", field: "text", delta: "你好" });
    send(11756, "message.part.delta", { sessionID: "s", messageID: "m", partID: "body", field: "text", delta: "！" });
    send(11760, "message.part.updated", { part: { id: "body", messageID: "m", sessionID: "s", type: "text", text: "你好！", time: { end: 11760 } } });
    await rendered.renderOnce();
    assert.doesNotMatch(rendered.captureCharFrame(), /tok\/s|LIVE|WARMUP|TTFT|avg/i);
    reportFrame("two-part before completion", rendered.captureCharFrame());
    send(11770, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", tokens: { input: 1, output: 10, reasoning: 0 }, time: { created: 1100, completed: 11770 } } });
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /10/, "completion must retire the anonymous pending ghost before session idle, without shortening the 10s part gap");
    assert.doesNotMatch(rendered.captureCharFrame(), /tok\/s|LIVE|WARMUP|TTFT|avg/i);
    reportFrame("two-part completed LAST", rendered.captureCharFrame());
    send(11800, "session.idle", { sessionID: "s" });
    await rendered.renderOnce();
    await rendered.renderOnce();
    const finished = rendered.captureCharFrame();
    reportFrame("two-part idle frozen", finished);
    clock += 60000;
    await new Promise((resolve) => setTimeout(resolve, 520));
    await rendered.renderOnce();
    assert.equal(rendered.captureCharFrame(), finished, "terminal task and response must remain frozen at +60s");
    const retainedCallback = handlers.get("message.part.delta")!;
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    retainedCallback({ type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "body", field: "text", delta: "late" } }, { directory, workspace: undefined });
    await rendered.renderOnce();
    assert.equal(rendered.captureCharFrame(), finished, "disposed subscriptions and timer must not mutate the frame");
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    rendered?.renderer.destroy();
    Date.now = originalNow;
    performance.now = originalMono;
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual plugin initial hydrate overlaps subscribed live start then rejects late same-ID events", async () => {
  const ui = (await uiPromise)!;
  await mkdir(cacheRoot, { recursive: true });
  const directory = await mkdtemp(join(cacheRoot, "initial-overlap-"));
  const historyPath = join(directory, "history.jsonl");
  const completedBytes = JSON.stringify({ version: 1, messageID: "m", sessionID: "s", tokens: { input: 1, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
    quality: "exact", time: { start: 1000, completed: 1150 }, samples: [] }) + "\n";
  await writeFile(historyPath, "");
  const held = await holdHistoryRead(historyPath);
  const handlers = new Map<string, (event: unknown, metadata: { directory: string; workspace: undefined }) => void>();
  const disposers: (() => void | Promise<void>)[] = [];
  const originalNow = Date.now;
  const originalMono = performance.now;
  let clock = 1000;
  Date.now = () => clock;
  performance.now = () => clock;
  let registered!: ReturnType<typeof ui.createTuiSlotPlugin>;
  const send = (at: number, type: string, properties: Record<string, unknown>) => {
    clock = at;
    handlers.get(type)!({ type, properties, timestamp: at }, { directory, workspace: undefined });
  };
  const api = { ...host(80, 30), state: { path: { worktree: directory, directory }, session: { get: () => undefined }, part: () => [] },
    route: { current: { name: "session", params: { sessionID: "s" } }, register: () => {}, navigate: () => {} },
    mode: { push: () => () => {} }, keymap: { registerLayer: () => () => {} }, ui: { toast: () => {}, dialog: { open: false } },
    slots: { register: (plugin: typeof registered) => { registered = plugin; return "overlap"; } },
    event: { on: (type: string, callback: (event: unknown, metadata: { directory: string; workspace: undefined }) => void) => {
      assert.equal(handlers.has(type), false, "no duplicate subscription or invented wrapper");
      handlers.set(type, callback);
      if (type === "workspace.deleted") {
        // All callbacks are installed, but the plugin has not awaited initial disk hydration.
        send(1000, "session.status", { sessionID: "s", status: { type: "busy" } });
        send(1000, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1000 } } });
        send(1010, "session.next.step.started", { sessionID: "s", messageID: "m", stepID: "step" });
      }
      return () => handlers.delete(type);
    } }, lifecycle: { onDispose: (dispose: () => void | Promise<void>) => { disposers.push(dispose); return () => {}; } },
  } as unknown as TuiPluginApi;
  let rendered: Awaited<ReturnType<typeof testRender>> | undefined;
  let initialization: Promise<void> | undefined;
  let released = false;
  try {
    initialization = ui.default.tui(api, { historyPath }, {} as never) as Promise<void>;
    await waitForLedger(held.entered, "safe fd read must be held before overlap assertions");
    const store = ui.__testRuntimeStores.at(-1)!;
    const owned = store.active.get("m")!;
    assert.ok(owned, "precondition: actual plugin active exists before hydrate");
    assert.equal(owned.sessionID, "s");
    assert.equal(store.sessionRuntime.get("s")!.activeMessageID, "m");
    assert.equal(owned.observedFromStart, true, "precondition: assistant creation is inside this plugin observation epoch");
    assert.equal(owned.progress!.fromCurrentStart, true);
    assert.equal(owned.legacy.samples.length + owned.v2.samples.length, 0);
    rendered = await testRender(() => {
      api.renderer = useRenderer();
      return registered.slots!.sidebar_content!({ theme: api.theme }, { session_id: "s" }) as JSX.Element;
    }, { width: 80, height: 30 });
    await rendered.renderOnce();
    assert.doesNotMatch(rendered.captureCharFrame(), /tok\/s|LIVE|WARMUP|TTFT|avg/i);
    assert.equal(store.active.get("m"), owned, "disk hydration must still be waiting");
    held.release(completedBytes);
    released = true;
    await initialization;
    await rm(historyPath);
    await writeFile(historyPath, completedBytes);
    send(1200, "message.part.delta", { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "late" });
    send(1210, "session.next.step.started", { sessionID: "s", messageID: "m", stepID: "late-step" });
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    assert.match(frame, /7 total/);
    assert.doesNotMatch(frame, /tok\/s|WAITING|WARMUP|LIVE|elapsed|TTFT|avg/i);
    assert.equal(store.active.has("m"), false);
    assert.equal(store.sessionRuntime.get("s")!.activeMessageID, undefined);
    reportFrame("initial hydrate completed unavailable", frame);
    send(1250, "session.status", { sessionID: "s", status: { type: "busy" } });
    send(1300, "session.idle", { sessionID: "s" });
    await rendered.renderOnce();
    const frozen = rendered.captureCharFrame();
    clock += 60000;
    await new Promise((resolve) => setTimeout(resolve, 520));
    await rendered.renderOnce();
    assert.equal(rendered.captureCharFrame(), frozen);
  } finally {
    if (initialization && !released) { held.release(completedBytes); await initialization; }
    held.restore();
    for (const dispose of disposers.reverse()) await dispose();
    rendered?.renderer.destroy(); Date.now = originalNow; performance.now = originalMono;
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual plugin individual SDK flush arrivals qualify short LAST and average but never short LIVE or peaks", async () => {
  const ui = (await uiPromise)!;
  for (const span of [150, 16, 0]) {
    await mkdir(cacheRoot, { recursive: true });
    const directory = await mkdtemp(join(cacheRoot, "short-arrivals-"));
    const handlers = new Map<string, (event: unknown, metadata: { directory: string; workspace: undefined }) => void>();
    const disposers: (() => void | Promise<void>)[] = [];
    const originalNow = Date.now;
    const originalMono = performance.now;
    let clock = 1000;
    Date.now = () => clock; performance.now = () => clock;
    let registered!: ReturnType<typeof ui.createTuiSlotPlugin>;
    const commands = new Map<string, () => void>();
    let dialog!: () => JSX.Element;
    const api = { ...host(80, 60), state: { path: { worktree: directory, directory }, session: { get: () => undefined }, part: () => [] },
      route: { current: { name: "session", params: { sessionID: "s" } }, register: () => {}, navigate: () => {} }, mode: { push: () => () => {} },
      keymap: { registerLayer: (layer: { commands?: { name: string; run: () => void }[] }) => { for (const command of layer.commands ?? []) commands.set(command.name, command.run); return () => {}; } },
      ui: { toast: () => {}, dialog: { open: false, replace: (render: () => JSX.Element) => { dialog = render; }, setSize: () => {} } },
      slots: { register: (plugin: typeof registered) => { registered = plugin; return "short"; } },
      event: { on: (type: string, callback: (event: unknown, metadata: { directory: string; workspace: undefined }) => void) => { handlers.set(type, callback); return () => handlers.delete(type); } },
      lifecycle: { onDispose: (dispose: () => void | Promise<void>) => { disposers.push(dispose); return () => {}; } },
    } as unknown as TuiPluginApi;
    const send = (at: number, type: string, properties: Record<string, unknown>) => {
      clock = at; handlers.get(type)!({ type, properties, timestamp: at }, { directory, workspace: undefined });
    };
    let rendered: Awaited<ReturnType<typeof testRender>> | undefined;
    let details: Awaited<ReturnType<typeof testRender>> | undefined;
    try {
      await ui.default.tui(api, { historyPath: join(directory, "history.jsonl") }, {} as never);
      rendered = await testRender(() => {
        api.renderer = useRenderer();
        const panel = new BoxRenderable(api.renderer, { width: 80, flexDirection: "column" });
        panel.add(registered.slots!.sidebar_content!({ theme: api.theme }, { session_id: "s" }) as unknown as Renderable);
        return panel as unknown as JSX.Element;
      }, { width: 80, height: 60 });
      send(1100, "session.status", { sessionID: "s", status: { type: "busy" } });
      send(1100, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1100 } } });
      send(1110, "session.next.step.started", { sessionID: "s", messageID: "m", stepID: "step" });
      send(1120, "message.part.updated", { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "" } });
      // SDK flushes deliver individual events. Same-flush arrivals share a batch,
      // and a later flush supplies a second monotonic batch; no adapter combines them.
      const arrivals = span === 0 ? [[1200, "你好"]] as const : [[1200, "你"], [1200 + span, "好"]] as const;
      for (const [at, delta] of arrivals) send(at, "message.part.delta", { sessionID: "s", messageID: "m", partID: "p", field: "text", delta });
      await rendered.renderOnce();
      assert.doesNotMatch(rendered.captureCharFrame(), /tok\/s|LIVE|WARMUP|TTFT|avg/i);
      send(1210 + span, "message.part.updated", { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "你好", time: { end: 1210 + span } } });
      send(1220 + span, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", tokens: { input: 1, output: 6, reasoning: 0 }, time: { created: 1100, completed: 1220 + span } } });
      send(1230 + span, "session.idle", { sessionID: "s" });
      await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      assert.match(frame, /7 total/);
      assert.doesNotMatch(frame, /tok\/s|LIVE|WARMUP|TTFT|avg|low confidence/i);
      reportFrame(`short ${span}ms completed`, frame);
      commands.get(ui.DETAILS_COMMAND_NAME)!();
      assert.ok(dialog, "the actual details command must open its registered dialog");
      details = await testRender(() => { api.renderer = useRenderer(); return dialog(); }, { width: 120, height: 160 });
      await details.renderOnce();
      const detailFrame = details.captureCharFrame();
      assert.match(detailFrame, /6/);
      assert.doesNotMatch(detailFrame, /tok\/s|TPS|TTFT|peak|throughput|low confidence/i);
      reportFrame(`short ${span}ms details`, detailFrame);
    } finally {
      for (const dispose of disposers.reverse()) await dispose();
      details?.renderer.destroy(); rendered?.renderer.destroy(); Date.now = originalNow; performance.now = originalMono;
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("actual narrow sidebar preserves full metric fields and task time without ellipses, independently of terminal width", async () => {
  const ui = (await uiPromise)!;
  const elapsed = (123 * 3600 + 45 * 60 + 56) * 1000;
  const counts = { input: 3_900_000, cacheRead: 6_100_000, output: 6_300_000, reasoning: 0, cacheWrite: 0 };
  const sessionID = "ses_eee872613ffeAXfSAWtXsJbYB4";
  for (const speed of [57_500, undefined]) {
    const store = ui.createRuntimeStore(1);
    store.totalsLedger.sessions[sessionID] = { tokens: counts, cost: 1, responseCount: 100,
      speed: updateSpeedTotals(emptySpeedTotals(), speed === undefined
        ? { response: { generatedTokens: 6_300_000, durationMs: 1, estimated: false } }
        : v3Generation(115_000), 1) };
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
      for (const width of [20, 24, 28, 32]) {
        panel.width = width;
        await rendered.renderOnce();
        await rendered.renderOnce(); // Settle the actual sidebar's measured width after resize.
        const frame = rendered.captureCharFrame();
        if (speed !== undefined) reportFrame(`sidebar ${width} compact`, frame);
        const visible = frame.split("\n").map((line) => line.slice(0, width).trim()).filter(Boolean);
        assert.deepEqual(visible, ["+ Token Pulse", ...ui.formatPulseMetrics(counts, width - 4, elapsed).split("\n")], `${width}: all visible cells must match whole fields`);
        assert.ok(frame.split("\n").every((line) => line.slice(width).trim() === ""), `${width}: metrics must not spill outside the sidebar`);
        assert.doesNotMatch(frame, /\.\.\.|…|tok\/s|TPS|avg/i);
        assert.ok(panel.getChildren()[0].height <= 5, `${width}: collapsed contains only toggle + at most three metric rows`);
        for (const field of ["16,300,000 total", "cache 61%", "time 123h45m56s"]) {
          assert.ok(visible.some((line) => line.includes(field)), `${width}: missing or clipped ${field}`);
        }
        ui.togglePulse(store);
        await rendered.renderOnce();
        const expanded = rendered.captureCharFrame().split("\n").map((line) => line.slice(0, width).trim()).join("\n");
        if (speed !== undefined) reportFrame(`sidebar ${width} expanded`, rendered.captureCharFrame());
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
  const frames = [20, 24, 28, 32].flatMap((width) => [sessionID, children[0].id].map((routeID) => ({ width, routeID })));
  for (const { width, routeID } of frames) {
    const store = ui.createRuntimeStore(1);
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
      reportFrame(`child agents ${width} ${routeID === sessionID ? "root" : "child"}`, frame);
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

test("native child rows show direct cumulative generation estimates or unavailable without response fallback", async () => {
  const ui = (await uiPromise)!;
  const store = ui.createRuntimeStore(1);
  const direct = (output: number, measured = true) => ({
    tokens: { input: 0, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 1, responseCount: 3,
    speed: updateSpeedTotals(emptySpeedTotals(), measured ? v3Generation(output, 0, 2000)
      : { response: { generatedTokens: output, durationMs: 1, estimated: false } }, 1),
  });
  store.totalsLedger.sessions = { child: direct(200), grand: direct(800), unavailable: direct(100, false) };
  store.sessionParents = new Map([["child", "root"], ["grand", "child"], ["unavailable", "root"]]);
  store.records = ["child", "grand", "unavailable"].map((sessionID) => ({
    version: 1, messageID: `${sessionID}-last`, sessionID, model: `${sessionID}-model`,
    tokens: store.totalsLedger.sessions[sessionID].tokens, cost: 1, time: { start: 0, completed: 1 }, samples: [],
    speed: { response: { generatedTokens: store.totalsLedger.sessions[sessionID].tokens.output, durationMs: 1, estimated: false } },
  }));
  for (const record of store.records) store.totalsLedger.settled[record.messageID] = true;
  store.pulseExpanded = true;
  const api = host(110, 100);
  const sidebar = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.sidebar_content!;
  const rendered = await testRender(() => sidebar({ theme: api.theme }, { session_id: "root" }), { width: 110, height: 100 });
  try {
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    assert.match(frame, /CHILD AGENTS/);
    assert.match(frame, /model child-model/);
    assert.match(frame, /model grand-model/);
    assert.match(frame, /model unavailable-model/);
    assert.doesNotMatch(frame, /tok\/s|TPS/i);
    assert.ok(frame.indexOf("model child-model") < frame.indexOf("model grand-model"));
    assert.ok(frame.indexOf("model grand-model") < frame.indexOf("model unavailable-model"));
  } finally { rendered.renderer.destroy(); store.disposeSignals(); }
});

test("native sidebar stays compact when collapsed and shows direct average only in expanded SESSION ONLY", async () => {
  const ui = (await uiPromise)!;
  for (const width of [80, 24, 18]) {
    const store = ui.createRuntimeStore(1);
    store.totalsLedger.sessions.root = {
      tokens: { input: 10, output: 100, reasoning: 20, cacheRead: 2, cacheWrite: 1 }, cost: 1, responseCount: 2,
      speed: updateSpeedTotals(emptySpeedTotals(), { ...v3Generation(100, 20, 2000), response: { generatedTokens: 120, durationMs: 4000, estimated: true } }, 1),
    };
    store.totalsLedger.sessions.child = {
      tokens: { input: 0, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, responseCount: 1,
      speed: updateSpeedTotals(emptySpeedTotals(), v3Generation(200, 0, 2000), 1),
    };
    store.sessionParents.set("child", "root");
    const api = host(width, 45);
    const plugin = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({}));
    const sidebar = plugin.slots!.sidebar_content!;
    const rendered = await testRender(() => sidebar({ theme: api.theme }, { session_id: "root" }), { width, height: 45 });
    try {
      await rendered.renderOnce();
      await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      assert.match(frame, /\+ Token Pulse/);
      assert.doesNotMatch(frame, /tok\/s|TPS|avg/i);
      assert.match(frame, /133 total|cache|time/);
      assert.doesNotMatch(frame, /SESSION ONLY/);
      assert.ok(rendered.renderer.root.getChildren()[0].height <= (width === 80 ? 3 : 5), `${width}: compact whole-field rows only`);
      assert.equal(store.pulseExpanded, false);
      ui.togglePulse(store);
      await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /- Token Pulse/);
      assert.match(rendered.captureCharFrame(), /SESSION ONLY/);
      assert.doesNotMatch(rendered.captureCharFrame(), /tok\/s|TPS|avg/i);
    } finally {
      rendered.renderer.destroy();
      store.disposeSignals();
    }
  }
});

test("native detail content fits the host dialog wrapper with fixed title/footer and scrolls to the bottom", async () => {
  const ui = (await uiPromise)!;
  for (const [width, height] of [[110, 40], [80, 24], [40, 16]]) {
  const store = ui.createRuntimeStore(1);
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
  for (const [width, height] of [[110, 40], [80, 24], [40, 16]]) {
    const store = ui.createRuntimeStore(1);
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
      if (width === 110) assert.match(rendered.captureCharFrame(), /113/);
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
  for (const [width, height] of [[140, 50], [140, 40], [80, 40], [80, 24], [40, 50], [40, 40]]) {
    const store = ui.createRuntimeStore(100);
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
      reportFrame(`full history ${width}x${height}`, frame);
      const page = rendered.renderer.root.getChildren()[0];
      const [header, summary, columns, records] = page.getChildren();
      const summaryRows = summary.getChildren() as TextRenderable[];
      if (process.env.TOKPULSE_UI_FRAMES === "1") console.log(`HISTORY GEOMETRY ${width}x${height}: ${JSON.stringify(summaryRows.map((row) => ({ text: row.plainText, y: row.y, height: row.height })))}`);
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
      if ((width === 140 && height === 50) || (width === 40 && height === 40)) reportFrame(`full history ${width}x${height} scrolled`, rendered.captureCharFrame());
      assert.deepEqual(summaryRows.map((row) => ({ text: row.plainText, y: row.y, height: row.height })), summaryBeforeScroll);
      assert.ok(records.scrollTop > 0);
      assert.match(rendered.captureCharFrame(), /00:00:13 root/);
      if (width >= 80) assert.match(rendered.captureCharFrame(), /fixture-model/);
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("native open details becomes an explicit empty state on late MC proof without clearing a host replacement", async () => {
  const ui = await uiPromise!;
  const store = ui.createRuntimeStore(1);
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
    reportFrame("late MC empty details", frame);
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
      get: (id: string) => ({ id, title: id === "child" ? "Review" : "Root", ...(id === "child" ? { parentID: "root" } : {}) }),
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
    for (const width of [20, 40, 80]) {
      store.pulseExpanded = false; store.bump();
      const hiddenBefore = tuiReadModel(store).counters.rowDerivations;
      const rendered = await testRender(() => sidebarContent.render({ sessionID: "root" }), { width, height: 100 });
      renders.push(rendered);
      await rendered.renderOnce(); await rendered.renderOnce();
      const collapsed = rendered.captureCharFrame();
      assert.match(collapsed, /\+ Token Pulse/); assert.match(collapsed, /66 total/);
      assert.match(collapsed, /cache 39%/); assert.match(collapsed, /time 2s/); noSpeed(collapsed);
      assert.equal(tuiReadModel(store).counters.rowDerivations, hiddenBefore, "collapsed native sidebar does not derive even the existing real child list");
      const header = rendered.renderer.root.getChildren()[0].getChildren()[0];
      await rendered.mockMouse.click(header.x + 1, header.y); await rendered.renderOnce();
      const expanded = rendered.captureCharFrame();
      assert.match(expanded, /SESSION ONLY/); assert.match(expanded, /INCLUDING\s+SUBAGENTS/);
      assert.match(expanded, /CHILD AGENTS/); assert.match(expanded, /review/); noSpeed(expanded);
      const rowsAfterExpand = tuiReadModel(store).counters.rowDerivations, dataRevision = store.revision();
      for (let i = 0; i < 20; i++) store.tick(); await rendered.renderOnce();
      assert.equal(store.revision(), dataRevision); assert.equal(tuiReadModel(store).counters.rowDerivations, rowsAfterExpand, "clock-only native frames reuse expanded child rows");
      reportFrame(`v2 sidebar content ${width}`, expanded);
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
