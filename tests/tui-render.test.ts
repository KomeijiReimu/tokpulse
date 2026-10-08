import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoxRenderable, RGBA, Renderable, ScrollBoxRenderable, SelectRenderable, TextRenderable, TextareaRenderable, Yoga, LayoutEvents } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { emptySpeedTotals, updateSpeedTotals, type SpeedContribution } from "../src/statistics.js";

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
type RenderedTui = typeof import("../src/tui.js") & { __testRuntimeStores: ReturnType<typeof import("../src/tui.js").createRuntimeStore>[]; __testActivityReads: number[] };
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
  const observedSource = `export const __testRuntimeStores = []; export const __testActivityReads = [];\n${sourceText.replace(storeCreation, `${storeCreation}\n__testRuntimeStores.push(store);`).replace("const activityEvents = await readActivityFile(path);", "const activityEvents = await readActivityFile(path); __testActivityReads.push(generation);")}`;
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
  test("native OpenTUI sidebar and dialog render checks (isolated Solid host)", async () => {
    // The host preloads Solid's client runtime. Isolate it so these checks do
    // not change the Solid instance used by the pure runtime test suite.
    const output = await promisify(execFile)(process.execPath, [
      "test", "--preload", "@opentui/solid/preload", fileURLToPath(import.meta.url),
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
      ...process.env, TOKPULSE_NATIVE_RENDER: "1", TMPDIR: cacheRoot,
    } });
    assert.match(output.stderr + output.stdout, /17 pass/);
  });
}

if (nativeChild) {
type PromptPhase = "WAITING" | "WARMUP" | "LIVE" | "LAST" | "SHORT" | "UNAVAILABLE";
const promptPhases: PromptPhase[] = ["WAITING", "WARMUP", "LIVE", "LAST", "SHORT", "UNAVAILABLE"];
const promptSID = "ses_input11_retained_session_complete_identifier_0000000000000000";
async function promptFixture(budget: number, long = false, sidebar = false, options: { absent?: boolean; extras?: number; plugins?: number; custom?: boolean; terminal?: boolean; auto?: boolean } = {}) {
  const ui = (await uiPromise)!;
  const store = ui.createRuntimeStore(1, 0);
  const api = host(320, 96);
  api.state = { session: { get: () => ({ id: promptSID, agent: "build" }) }, part: () => [] } as unknown as TuiPluginApi["state"];
  let serial = 0;
  const phase = (value: PromptPhase) => {
    store.active.clear(); store.sessionRuntime.delete(promptSID); store.lastCompletedBySession.delete(promptSID);
    if (["LAST", "SHORT", "UNAVAILABLE"].includes(value)) {
      const short = value === "SHORT", output = short ? 6 : 2000;
      const speed = v3Generation(output, 0, short ? 150 : 2000, 27000);
      if (short && speed.generation && speed.generationEvidence?.version === 3) {
        speed.generation.observationQuality = "short";
        speed.generationEvidence.observationQuality = "short";
        speed.generationEvidence.clockSource = "performance.now"; speed.generationEvidence.clockResolutionMs = 1;
      }
      store.lastCompletedBySession.set(promptSID, ui.makeLastCompletedSnapshot({ version: 1, messageID: `last-${++serial}`, sessionID: promptSID,
        tokens: { input: 1, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
        time: { start: 0, firstToken: 26700, completed: 30000 }, samples: [], ...(value === "UNAVAILABLE" ? {} : { speed }) }));
    } else {
      const id = `live-${++serial}`;
      ui.handleMessageUpdated(store, api, { info: { id, sessionID: promptSID, role: "assistant", time: { created: 0 } } }, { type: "message.updated", timestamp: 0 }, 4, 0);
      const state = store.active.get(id)!;
      state.selectedSource = "legacy"; state.firstTokenAt = 1000;
      if (value !== "WAITING") {
        state.legacy.hasData = true;
        state.legacy.samples = value === "WARMUP" ? [{ timestamp: 57100, tokens: 5000 }]
          : [{ timestamp: 56300, tokens: 1250 }, { timestamp: 57300, tokens: 3750 }];
      }
    }
    store.bump();
  };
  phase("LIVE");
  let allocation!: BoxRenderable, body!: BoxRenderable, textarea!: Renderable, row!: BoxRenderable, left!: BoxRenderable, model!: TextRenderable, right!: BoxRenderable;
  const plugins: Renderable[] = [], extras: TextRenderable[] = [];
  let originals: unknown;
  const style = () => ({ wrap: row.getLayoutNode().getFlexWrap(), grow: right.getLayoutNode().getFlexGrow(),
    basis: right.getLayoutNode().getFlexBasis(), min: right.getLayoutNode().getMinWidth(), leftMax: left.getLayoutNode().getMaxWidth() });
  const rendered = await testRender(() => {
    api.renderer = useRenderer();
    const color = RGBA.fromHex("#eeeeee");
    const box = (id: string, props: ConstructorParameters<typeof BoxRenderable>[1] = {}) => new BoxRenderable(api.renderer, { id, ...props });
    const text = (id: string, content: string, props: ConstructorParameters<typeof TextRenderable>[1] = {}) => new TextRenderable(api.renderer, { id, content, fg: color, ...props });
    allocation = box("session-layout", { width: options.terminal ? budget : budget + 9 + (sidebar ? 42 : 0), height: 96, flexDirection: "row", minHeight: 0 });
    const main = box("main", { flexGrow: 1, minHeight: 0, paddingBottom: 1, paddingLeft: 2, paddingRight: 2, gap: 1 }); allocation.add(main);
    main.add(box("messages", { flexGrow: 1, minHeight: 0 }));
    const anchor = box("prompt", { width: "100%" }); main.add(anchor);
    const border = box("prompt-border", { width: "100%", border: ["left"], borderColor: color }); anchor.add(border);
    body = box("prompt-body", { paddingLeft: 2, paddingRight: 2, paddingTop: 1, flexShrink: 0, flexGrow: 1, width: "100%" }); border.add(body);
    textarea = options.custom ? text("not-a-textarea", "Custom input", { width: "100%" })
      : new TextareaRenderable(api.renderer, { id: "prompt-textarea", width: "100%", minHeight: 1, maxHeight: 16, initialValue: "Input area - no request", textColor: color });
    body.add(textarea);
    row = box("prompt-metadata", { flexDirection: "row", flexShrink: 0, paddingTop: 1, gap: 1, justifyContent: "space-between" }); body.add(row);
    left = box("agent-model", { flexDirection: "row", gap: 1 }); row.add(left);
    left.add(text("agent", long ? "Build assistant" : "Build"));
    if (options.auto) left.add(text("permission-mode", "auto"));
    const models = box("models", { flexDirection: "row", gap: 1 }); left.add(models);
    models.add(text("separator", "·"));
    model = text("model", long ? "torchai-gpt/gpt-6.1-sol-extended-reasoning-model" : "gpt-5.4", { flexShrink: 0 }); models.add(model);
    models.add(text("provider", "OpenAI")); models.add(text("variant-separator", "·")); models.add(text("variant", "thinking"));
    right = box("prompt-right", { flexDirection: "row", gap: 1, alignItems: "center" });
    if (!options.absent || options.extras) row.add(right);
    for (let i = 0; i < (options.extras ?? 0); i++) { const extra = text(`extra-${i}`, "quota ready", { width: 12, flexShrink: 0 }); right.add(extra); extras.push(extra); }
    originals = style();
    if (!options.absent) for (let i = 0; i < (options.plugins ?? 1); i++) {
      const plugin = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots.session_prompt_right!({ theme: api.theme }, { session_id: promptSID }) as unknown as Renderable;
      plugins.push(plugin); right.add(plugin);
    }
    anchor.add(box("lower-border", { height: 1, border: ["left"], borderColor: color }));
    const footer = box("prompt-controls", { width: "100%", flexDirection: "row", justifyContent: "space-between" }); anchor.add(footer);
    footer.add(text("escape", "esc interrupt")); footer.add(text("commands", "tab agents  ctrl+p commands"));
    if (sidebar) {
      const overlay = options.terminal && budget <= 120;
      const side = box("sidebar", { width: 42, height: "100%", paddingLeft: 2, paddingRight: 2, ...(overlay ? { position: "absolute", right: 0, top: 0 } : {}) });
      allocation.add(side); side.add(text("sidebar-title", "Sidebar fixture"));
    }
    return allocation as unknown as JSX.Element;
  }, { width: options.terminal ? budget : 320, height: 96 });
  const settle = async () => { for (let i = 0; i < 8; i++) await rendered.renderOnce(); };
  const frame = (node: Renderable) => rendered.captureCharFrame().split("\n").slice(node.y, node.y + node.height).map(line => line.slice(node.x, node.x + node.width).trimEnd());
  const assertFields = () => {
    for (const plugin of plugins.filter(node => !node.isDestroyed)) {
      const fields = (plugin.getChildren()[0] as TextRenderable).plainText.split(/\n| · /);
      const lines = frame(plugin);
      for (const field of fields) {
        if (field.length <= plugin.width) assert.ok(lines.some(line => line.includes(field)), `${field}: ${JSON.stringify(lines)}`);
        else assert.ok(lines.join("").replace(/\s/g, "").includes(field.replace(/\s/g, "")), `physical wrap dropped ${field}: ${JSON.stringify(lines)}`);
      }
      assert.ok(!lines.some(line => /\.\.\.|…/.test(line)));
      assert.ok(plugin.x >= row.x && plugin.x + plugin.width <= row.x + row.width);
    }
  };
  await settle();
  return { store, rendered, allocation, textarea, body, row, left, model, right, plugins, extras, originals, style, phase, settle, frame, assertFields,
    dispose() { rendered.renderer.destroy(); store.disposeSignals(); } };
}

test("native prompt parent budget preserves textarea and model across six widths and states", { timeout: 20000 }, async () => {
  const now = Date.now; Date.now = () => 57300;
  try {
    for (const sidebar of [false, true]) for (const long of [true, false]) for (const budget of [160, 120, 100, 80, 60, 40]) {
      const absent = await promptFixture(budget, long, sidebar, { absent: true });
      const present = await promptFixture(budget, long, sidebar);
      try { for (const phase of promptPhases) {
        present.phase(phase); await present.settle();
        assert.equal(present.textarea.x, absent.textarea.x); assert.equal(present.textarea.width, budget);
        assert.equal(present.textarea.width, absent.textarea.width); assert.equal(present.row.width, budget);
        assert.equal(present.model.width, absent.model.width, `${budget}/${phase}: model stolen`);
        assert.equal(present.left.width, absent.left.width, `${budget}/${phase}: left stolen`);
        assert.equal(present.textarea.width, present.body.width - 4);
        const plugin = present.plugins[0]; assert.equal(plugin.width, present.right.width);
        assert.equal(present.right.x + present.right.width, present.row.x + present.row.width);
        present.assertFields();
        if (long && sidebar && budget === 40) reportFrame(`INPUT11-40-${phase}`, present.frame(present.row).join("\n"));
      } } finally { present.dispose(); absent.dispose(); }
    }
    // Real viewport budgets too: narrow official sidebar is an overlay, not a
    // fictional 42-column deduction from a 40-column terminal.
    for (const sidebar of [false, true]) for (const width of [160, 120, 100, 80, 60, 40]) {
      const absent = await promptFixture(width, true, sidebar, { absent: true, terminal: true });
      const present = await promptFixture(width, true, sidebar, { terminal: true });
      try {
        assert.equal(present.textarea.x, absent.textarea.x); assert.equal(present.textarea.width, absent.textarea.width);
        assert.equal(present.model.width, absent.model.width); present.assertFields();
      } finally { present.dispose(); absent.dispose(); }
    }
  } finally { Date.now = now; }
});

test("native prompt remaining budget preserves another right sibling and resizes both ways", async () => {
  const now = Date.now; Date.now = () => 57300;
  const fixture = await promptFixture(160, true, false, { extras: 1 });
  try {
    for (const budget of [160, 120, 80, 40, 20, 40, 80, 120, 160]) {
      fixture.allocation.width = budget + 9;
      for (const phase of promptPhases) {
        fixture.phase(phase); await fixture.settle();
        const absent = await promptFixture(budget, true, false, { absent: true, extras: 1 });
        try {
          assert.equal(fixture.textarea.width, absent.textarea.width); assert.equal(fixture.textarea.x, absent.textarea.x);
          assert.equal(fixture.model.width, absent.model.width, `${budget}/${phase}: model ${fixture.model.width}/${absent.model.width}, left ${fixture.left.width}/${absent.left.width}, max ${JSON.stringify(fixture.left.getLayoutNode().getMaxWidth())}`); assert.equal(fixture.extras[0].width, 12);
          assert.ok(fixture.frame(fixture.extras[0]).join("").includes("quota ready"));
          assert.equal(fixture.plugins[0].width + 13, fixture.right.width); fixture.assertFields();
        } finally { absent.dispose(); }
      }
    }
    const layoutChanges = fixture.row.listenerCount(LayoutEvents.RESIZED);
    const comparison = await promptFixture(160, true, false, { absent: true, extras: 1 });
    try {
      for (const model of ["gpt-5.4", "torchai-gpt/gpt-6.1-sol-extended-reasoning-model"]) {
        fixture.model.content = model; comparison.model.content = model; fixture.store.tick(); await fixture.settle(); await comparison.settle();
        assert.equal(fixture.model.width, comparison.model.width); assert.equal(fixture.left.width, comparison.left.width);
      }
    } finally { comparison.dispose(); }
    const node = fixture.row.getLayoutNode(), calculate = node.calculateLayout.bind(node);
    let measurements = 0;
    node.calculateLayout = (...args: Parameters<typeof calculate>) => { measurements++; return calculate(...args); };
    const minimum = fixture.right.getLayoutNode().getMinWidth();
    for (let i = 0; i < 16; i++) { fixture.store.bump(); fixture.store.tick(); await fixture.rendered.renderOnce(); }
    assert.deepEqual(fixture.right.getLayoutNode().getMinWidth(), minimum);
    assert.equal(fixture.row.listenerCount(LayoutEvents.RESIZED), layoutChanges);
    assert.equal(measurements, 0, "unchanged data/frames must not re-measure the baseline");
    reportFrame("INPUT11-extra-sibling", fixture.frame(fixture.row).join("\n"));
  } finally { fixture.dispose(); Date.now = now; }
});

test("native prompt leases clean up, share ownership, respect foreign styles and reject custom hosts", async () => {
  const now = Date.now; Date.now = () => 57300;
  try {
    const shared = await promptFixture(120, false, false, { plugins: 2, extras: 1 });
    try {
      shared.assertFields(); assert.equal(shared.extras[0].width, 12);
      shared.plugins[0].destroyRecursively(); await shared.settle();
      assert.equal(shared.row.getLayoutNode().getFlexWrap(), Yoga.Wrap.Wrap); shared.assertFields();
      shared.plugins[1].destroyRecursively(); await shared.settle();
      assert.deepEqual(shared.style(), shared.originals);
      assert.equal(shared.row.listenerCount(LayoutEvents.RESIZED), 0); assert.equal(shared.right.listenerCount(LayoutEvents.LAYOUT_CHANGED), 0);
    } finally { shared.dispose(); }
    const foreign = await promptFixture(120);
    try {
      foreign.row.flexWrap = "wrap-reverse"; foreign.right.flexGrow = 3; foreign.right.flexBasis = 9; foreign.right.minWidth = 17; foreign.left.maxWidth = 23;
      const changed = foreign.style(); foreign.phase("SHORT"); await foreign.settle();
      assert.deepEqual(foreign.style(), changed);
      foreign.plugins[0].destroyRecursively(); await foreign.settle();
      assert.deepEqual(foreign.style(), changed);
    } finally { foreign.dispose(); }
    const custom = await promptFixture(120, true, false, { custom: true });
    try {
      assert.deepEqual(custom.style(), custom.originals);
      custom.phase("SHORT"); await custom.settle(); assert.deepEqual(custom.style(), custom.originals);
      assert.equal(custom.row.listenerCount(LayoutEvents.RESIZED), 0);
    } finally { custom.dispose(); }
    const auto = await promptFixture(80, true, false, { auto: true });
    const absentAuto = await promptFixture(80, true, false, { auto: true, absent: true });
    try {
      assert.equal(auto.model.width, absentAuto.model.width); assert.equal(auto.left.width, absentAuto.left.width);
      auto.assertFields();
    } finally { auto.dispose(); absentAuto.dispose(); }
  } finally { Date.now = now; }
});

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
  const api = { ...host(80, 40), state: { path: { worktree: directory, directory }, session: { get: () => undefined }, part: () => [] },
    route: { current: { name: "session", params: { sessionID: "s" } }, register: () => {}, navigate: () => {} },
    mode: { push: () => () => {} }, keymap: { registerLayer: () => () => {} }, ui: { toast: () => {}, dialog: { open: false } },
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
    const originals = { ...fsPromises };
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const bunTestModule = "bun:test";
    const { mock } = await import(bunTestModule);
    mock.module("node:fs/promises", () => ({ ...originals, readFile(...args: unknown[]) {
      if (String(args[0]) === historyPath && !entered) { entered = true; return gate; }
      return Reflect.apply(originals.readFile, originals, args);
    } }));
    restoreFilesystem = () => { mock.module("node:fs/promises", () => originals); };
  }
  let initialization: Promise<void> | undefined;
  const dispose = async () => { for (const fn of disposers.splice(0).reverse()) await fn(); };
  try {
    initialization = ui.default.tui(api, { historyPath }, {} as never) as Promise<void>;
    if (!gateInitialHistory) await initialization;
    const store = ui.__testRuntimeStores.at(-1)!;
    rendered = await testRender(() => {
      api.renderer = useRenderer();
      const panel = new BoxRenderable(api.renderer, { width: 80, flexDirection: "column" });
      panel.add(registered.slots!.session_prompt_right!({ theme: api.theme }, { session_id: "s" }) as unknown as Renderable);
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
    return { ui, store, rendered, directory, ledgerDirectory, historyPath, runsPath, startedAt, send, fact, commitRuns, complete, start, awaitEventRead, dispose, initialization,
      initialReadEntered: () => entered,
      releaseHistory: (bytes: string) => { released = true; release(bytes); },
      advance: (offset: number) => { clock = startedAt + offset; },
      close: async () => { await dispose(); if (!released) release(""); await initialization; restoreFilesystem(); rendered?.renderer.destroy(); Date.now = originalNow; await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await dispose(); if (!released) release(""); await initialization; restoreFilesystem(); rendered?.renderer.destroy(); Date.now = originalNow; await rm(directory, { recursive: true, force: true }); throw error; }
}

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
    assert.match(f.rendered.captureCharFrame(), /^WAITING --/);
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
    assert.match(immediate, /^LAST --/);
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
    assert.equal(f.ui.buildSessionDetailsTree(f.store, "s").average.totalGeneratedTokens, 106, "unknown identity retains usage until positive proof arrives");
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
    assert.equal(f.ui.buildSessionDetailsTree(f.store, "s").average.totalGeneratedTokens, 6, "raw usage overlays cannot restore excluded maintenance totals");
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
      panel.add(registered.slots!.session_prompt_right!({ theme: api.theme }, { session_id: "s" }) as unknown as Renderable);
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
    assert.match(rendered.captureCharFrame(), /WARMUP --/);
    reportFrame("two-part WARMUP", rendered.captureCharFrame());
    send(11770, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", tokens: { input: 1, output: 10, reasoning: 0 }, time: { created: 1100, completed: 11770 } } });
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /LAST ~1 tok\/s generation/, "completion must retire the anonymous pending ghost before session idle, without shortening the 10s part gap");
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
  // A real FIFO gates readHistoryFile, so the pre-hydrate assertions cannot
  // accidentally run after the initial reload has already completed.
  await promisify(execFile)("mkfifo", [historyPath]);
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
      return registered.slots!.session_prompt_right!({ theme: api.theme }, { session_id: "s" }) as JSX.Element;
    }, { width: 80, height: 30 });
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /WAITING --|WARMUP --/);
    assert.equal(store.active.get("m"), owned, "disk hydration must still be waiting");
    await writeFile(historyPath, completedBytes);
    released = true;
    await initialization;
    await rm(historyPath);
    await writeFile(historyPath, completedBytes);
    send(1200, "message.part.delta", { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "late" });
    send(1210, "session.next.step.started", { sessionID: "s", messageID: "m", stepID: "late-step" });
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    assert.match(frame, /LAST --/);
    assert.doesNotMatch(frame, /WAITING|WARMUP|LIVE|elapsed/);
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
    if (initialization && !released) { await writeFile(historyPath, completedBytes); await initialization; }
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
        panel.add(registered.slots!.session_prompt_right!({ theme: api.theme }, { session_id: "s" }) as unknown as Renderable);
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
      assert.match(rendered.captureCharFrame(), /WARMUP --/);
      assert.doesNotMatch(rendered.captureCharFrame(), /LIVE ~/);
      send(1210 + span, "message.part.updated", { part: { id: "p", messageID: "m", sessionID: "s", type: "text", text: "你好", time: { end: 1210 + span } } });
      send(1220 + span, "message.updated", { info: { id: "m", sessionID: "s", role: "assistant", tokens: { input: 1, output: 6, reasoning: 0 }, time: { created: 1100, completed: 1220 + span } } });
      send(1230 + span, "session.idle", { sessionID: "s" });
      await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      if (span === 150) assert.match(frame, /LAST ~20 tok\/s generation · short, low confidence/);
      else assert.match(frame, /LAST --/);
      reportFrame(`short ${span}ms completed`, frame);
      commands.get(ui.DETAILS_COMMAND_NAME)!();
      assert.ok(dialog, "the actual details command must open its registered dialog");
      details = await testRender(() => { api.renderer = useRenderer(); return dialog(); }, { width: 120, height: 160 });
      await details.renderOnce();
      const detailFrame = details.captureCharFrame();
      if (span === 150) {
        assert.match(detailFrame, /Generation avg TPS  ~20 tok\/s/);
        assert.match(detailFrame, /1 short \(low confidence\)/);
        assert.match(detailFrame, /short, low confidence/);
      } else assert.match(detailFrame, /Generation avg TPS  --/);
      assert.match(detailFrame, /Arrival peaks: -- \(insufficient window observations\)/);
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
        assert.deepEqual(visible, ["+ Token Pulse", ...ui.formatPulseMetrics(counts, speed, width - 4, elapsed).split("\n")], `${width}: all visible cells must match whole fields`);
        assert.ok(frame.split("\n").every((line) => line.slice(width).trim() === ""), `${width}: metrics must not spill outside the sidebar`);
        assert.doesNotMatch(frame, /\.\.\.|…|incl TPS|Main avg TPS|Observed/);
        assert.ok(panel.getChildren()[0].height <= 6, `${width}: collapsed contains only toggle + at most four metric rows`);
        for (const field of ["16.3M total", speed === undefined ? "-- tok/s" : "~57.5k tok/s", "cache 61%", "time 123h45m56s"]) {
          assert.ok(visible.some((line) => line.includes(field)), `${width}: missing or clipped ${field}`);
        }
        ui.togglePulse(store);
        await rendered.renderOnce();
        const expanded = rendered.captureCharFrame().split("\n").map((line) => line.slice(0, width).trim()).join("\n");
        if (speed !== undefined) reportFrame(`sidebar ${width} expanded`, rendered.captureCharFrame());
        const visibleGlyphs = expanded.replace(/\s+/g, "");
        assert.ok(visibleGlyphs.includes(`session${sessionID}`), `${width}: wrapping must preserve every full session ID character`);
        assert.doesNotMatch(expanded, /\.\.\.|…/);
        if (speed === undefined) {
          assert.match(expanded, /Main avg TPS\s+--/);
          assert.match(expanded, /Observed 0\/100\s+calls/);
          assert.match(expanded, /No\s+qualified\s+generation\s+timing\./);
          assert.match(expanded.replace(/\s+/g, " "), /Compact usage and TPS include subagents\./);
          assert.doesNotMatch(expanded, /hidden reasoning|tool waits caused|reconnect caused/);
        } else {
          assert.match(expanded, /Main avg TPS\s+~57\.5k tok\/s/);
        }
        ui.togglePulse(store);
        await rendered.renderOnce();
      }
    } finally { rendered.renderer.destroy(); store.disposeSignals(); }
  }
});

test("narrow child rows preserve full IDs, models, counts and TPS across wrapped visible cells", async () => {
  const ui = (await uiPromise)!;
  const sessionID = "ses_eee872613ffeAXfSAWtXsJbYB4";
  const children = [
    { id: "ses_eee872613ffeAXfSAWtXsJbYB5", parent: sessionID, model: "openai/gpt-5.4-thinking-extended", output: 4_200_000, calls: 1200, speed: v3Generation(200, 0, 2000), expectedRate: "~50 tok/s" },
    { id: "ses_eee872613ffeAXfSAWtXsJbYB6", parent: "ses_eee872613ffeAXfSAWtXsJbYB5", model: "openrouter/x-ai/grok-4.1-fast-reasoning", output: 3_200_000, calls: 9000, speed: v3Generation(800, 0, 2000), expectedRate: "~200 tok/s" },
    { id: "ses_fff872613ffeAXfSAWtXsJbYB7", parent: sessionID, model: "openrouter/x-ai/grok-4-without-generation-timing", output: 1_100_000, calls: 100_000, speed: undefined, expectedRate: "--" },
  ];
  for (const width of [20, 24, 28, 32]) {
    const store = ui.createRuntimeStore(1);
    const tokens = (output: number) => ({ input: 0, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    store.totalsLedger.sessions[sessionID] = { tokens: tokens(115_000), cost: 1, responseCount: 1,
      speed: updateSpeedTotals(emptySpeedTotals(), v3Generation(115_000), 1) };
    for (const child of children) {
      store.totalsLedger.sessions[child.id] = { tokens: tokens(child.output), cost: 1, responseCount: child.calls,
        speed: updateSpeedTotals(emptySpeedTotals(), child.speed, 1) };
      store.sessionParents.set(child.id, child.parent);
      store.totalsLedger.settled[`${child.id}-last`] = true;
    }
    store.records = children.map((child) => ({ version: 1, messageID: `${child.id}-last`, sessionID: child.id,
      model: child.model, tokens: tokens(child.output), cost: 1, time: { start: 0, completed: 1 }, samples: [],
      speed: { response: { generatedTokens: child.output, durationMs: 1, estimated: false } } }));
    store.pulseExpanded = true;
    const api = host(120, 180);
    const sidebar = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.sidebar_content!;
    const rendered = await testRender(() => {
      const renderer = useRenderer();
      api.renderer = renderer;
      const panel = new BoxRenderable(renderer, { width, flexDirection: "column", flexShrink: 0 });
      panel.add(sidebar({ theme: api.theme }, { session_id: sessionID }) as unknown as Renderable);
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
      assert.ok(glyphs.includes(`session${sessionID}`));
      assert.ok(glyphs.includes("MainavgTPS~57.5ktok/s"));
      for (const child of children) {
        assert.ok(glyphs.includes(`${child.id}${ui.formatCompactNumber(child.calls)}responses${ui.formatCompactNumber(child.output)}generated`), `${width}: full child ID, counts and units must survive wrapping`);
        assert.ok(glyphs.includes(`model${child.model}${child.expectedRate.replace(/\s+/g, "")}`), `${width}: full model and direct TPS must survive wrapping`);
      }
      assert.ok(glyphs.indexOf(children[0].id) < glyphs.indexOf(children[1].id));
      assert.ok(glyphs.indexOf(children[1].id) < glyphs.indexOf(children[2].id));
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
    assert.match(frame, /model child-model\s+~50 tok\/s/);
    assert.match(frame, /model grand-model\s+~200 tok\/s/);
    assert.match(frame, /model unavailable-model\s+--/);
    assert.doesNotMatch(frame, /200k tok\/s|800k tok\/s|100k tok\/s/);
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
      assert.doesNotMatch(frame, /(?:Main|Session) avg TPS|Observed \d|~30 tok\/s/);
      assert.match(frame, /~40 tok\/s/); // Empty history; cumulative including differs from direct ~30.
      assert.doesNotMatch(frame, /SESSION ONLY/);
      assert.ok(rendered.renderer.root.getChildren()[0].height <= (width === 80 ? 3 : 6), `${width}: compact whole-field rows only`);
      assert.equal(store.pulseExpanded, false);
      ui.togglePulse(store);
      await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /- Token Pulse/);
      assert.match(rendered.captureCharFrame(), /SESSION ONLY/);
      assert.match(rendered.captureCharFrame(), /Main avg TPS/);
      assert.match(rendered.captureCharFrame(), /~30 tok\/s/);
      assert.match(rendered.captureCharFrame(), /Observed 1\/2/);
      assert.ok(rendered.captureCharFrame().indexOf("SESSION ONLY") < rendered.captureCharFrame().indexOf("Main avg TPS"));
      const includingPosition = rendered.captureCharFrame().indexOf("INCLUDING SUBAGENTS");
      if (includingPosition !== -1) assert.ok(rendered.captureCharFrame().indexOf("Main avg TPS") < includingPosition);
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
      assert.match(frame, /Generation avg TPS\s+~30 tok\/s/);
      assert.match(frame, /Response throughput\s+30 tok\/s/);
      assert.match(frame, /120\/120 generated tokens · 1\/2 calls/);
      assert.match(frame, /may include tool waits/);
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
    assert.match(bottom, /model\./);
    assert.match(bottom, /Token Pulse details/);
    assert.ok(scroll.scrollTop > 0);
    assert.equal(children[0].y, titleY);
    assert.equal(children.at(-1)!.y, closeHintY);
    if (width === 110) {
      assert.match(bottom.replace(/[█▀▄]/g, ""), /not an average of call\s+speeds/);
      assert.match(bottom, /~ means a host-observed estimate, not provider-internal speed/);
      assert.match(bottom, /byte-based windowed event arrivals, not token generation inside the model\./);
    }
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
      assert.match(rendered.captureCharFrame(), /model\./);
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
      if (width === 110) assert.match(rendered.captureCharFrame(), /Generation avg TPS\s+~50 tok\/s/);
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
      assert.match(selectedFrames, /Generation avg TPS\s+~150 tok\/s/);
      assert.match(selectedFrames, /Response throughput\s+200 tok\/s/);
      assert.match(selectedFrames, /known-child-model/);
      assert.match(selectedFrames, /222ms/);
      assert.match(selectedFrames, /~150 tok\/s \(generation\)/);
      assert.match(selectedFrames, /INCLUDING SUBAGENTS/);
      assert.match(selectedFrames, /730/);
      assert.match(selectedFrames.replace(/[█▀▄]/g, ""), /not\s+wall-\s*clock/);
      scroll.scrollTo(scroll.scrollHeight); await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /model\./);
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

test("native prompt renders WARMUP, LIVE and a host-observed tool WAIT", async () => {
  const ui = (await uiPromise)!;
  const now = Date.now();
  const store = ui.createRuntimeStore(10, now - 1000);
  const api = host(80, 8);
  ui.handleMessageUpdated(store, api, { info: { id: "m", sessionID: "root", role: "assistant", time: { created: now - 1000 } } }, { type: "message.updated", timestamp: now - 1000 }, 4, now - 1000);
  const active = store.active.get("m")!;
  active.selectedSource = "legacy";
  store.active.set("m", active);
  const partState = api.state as unknown as { part: () => unknown[] };
  partState.part = () => [];
  const prompt = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.session_prompt_right!;
  let panel!: BoxRenderable;
  const rendered = await testRender(() => {
    api.renderer = useRenderer();
    panel = new BoxRenderable(api.renderer, { width: 20, flexDirection: "column", flexShrink: 0 });
    panel.add(prompt({ theme: api.theme }, { session_id: "root" }) as unknown as Renderable);
    return panel as unknown as JSX.Element;
  }, { width: 80, height: 20 });
  try {
    await rendered.renderOnce();
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /WAITING --/);
    assert.match(rendered.captureCharFrame(), /gen --/);
    assert.doesNotMatch(rendered.captureCharFrame(), /gen ~0/);
    reportFrame("prompt waiting content 20", rendered.captureCharFrame());
    active.legacy.hasData = true;
    active.legacy.samples = [{ timestamp: now - 1000, tokens: 10 }];
    store.bump(); await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /WARMUP --/);
    assert.doesNotMatch(rendered.captureCharFrame(), /LIVE ~0/);
    active.legacy.samples.push({ timestamp: now, tokens: 20 });
    store.bump();
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /LIVE ~\d+ tok\/s/);
    for (const width of [20, 24, 28, 32]) {
      panel.width = width;
      await rendered.renderOnce(); await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      const visible = frame.split("\n").map((line) => line.slice(0, width).trim()).join("\n");
      assert.doesNotMatch(visible, /\.\.\.|…/);
      for (const field of [/LIVE ~\d+ tok\/s/, /gen ~30/, /ttft --/, /elapsed 1s/, /total 0/]) assert.match(visible, field);
      assert.ok(frame.split("\n").every((line) => line.slice(width).trim() === ""), "LIVE cannot spill outside its slot");
      reportFrame(`prompt LIVE ${width}`, frame);
    }
    partState.part = () => [{ type: "tool", state: { status: "running", time: { start: now } } }];
    store.bump();
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /WAIT TOOL --/);
    reportFrame("prompt tool waiting 32", rendered.captureCharFrame());
  } finally {
    rendered.renderer.destroy();
    store.disposeSignals();
  }
});
}
