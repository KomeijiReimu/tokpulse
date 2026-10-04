import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoxRenderable, RGBA, Renderable, ScrollBoxRenderable, SelectRenderable, TextRenderable } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { emptySpeedTotals, updateSpeedTotals } from "../src/statistics.js";

const cacheRoot = process.env.TMPDIR || join(homedir(), ".cache", "tokpulse-tests");

// Compile only this isolated UI module as the real build does, without writing
// dist or changing how the non-rendering runtime tests import the source.
async function loadRenderedTui(): Promise<typeof import("../src/tui.js")> {
  const bunModule = "bun";
  const runtime = await import(bunModule);
  const babelModule = "@babel/core";
  const solidModule = "babel-preset-solid";
  const typescriptModule = "@babel/preset-typescript";
  const [{ transformAsync }, solid, typescript] = await Promise.all([
    import(babelModule), import(solidModule), import(typescriptModule),
  ]);
  const source = fileURLToPath(new URL("../src/tui.tsx", import.meta.url));
  const transformed = await transformAsync(await readFile(source, "utf8"), {
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
    assert.match(output.stderr + output.stdout, /4 pass/);
  });
}

if (nativeChild) {
test("native sidebar stays compact when collapsed and shows direct average only in expanded SESSION ONLY", async () => {
  const ui = (await uiPromise)!;
  for (const width of [80, 24, 18]) {
    const store = ui.createRuntimeStore(1);
    store.totalsLedger.sessions.root = {
      tokens: { input: 10, output: 100, reasoning: 20, cacheRead: 2, cacheWrite: 1 }, cost: 1, responseCount: 2,
      speed: updateSpeedTotals(emptySpeedTotals(), { response: { generatedTokens: 120, durationMs: 2000, estimated: true } }, 1),
    };
    const api = host(width, 45);
    const plugin = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({}));
    const sidebar = plugin.slots!.sidebar_content!;
    const rendered = await testRender(() => sidebar({ theme: api.theme }, { session_id: "root" }), { width, height: 45 });
    try {
      await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      assert.match(frame, /\+ Token Pulse/);
      assert.doesNotMatch(frame, /(?:Main|Session) avg TPS|Measured|~60 tok\/s/);
      assert.doesNotMatch(frame, /SESSION ONLY/);
      assert.ok(rendered.renderer.root.getChildren()[0].height <= 3, `${width}: collapsed sidebar must stay three rows`);
      assert.equal(store.pulseExpanded, false);
      ui.togglePulse(store);
      await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /- Token Pulse/);
      assert.match(rendered.captureCharFrame(), /SESSION ONLY/);
      assert.match(rendered.captureCharFrame(), /Main avg TPS/);
      assert.match(rendered.captureCharFrame(), /~60 tok\/s/);
      assert.match(rendered.captureCharFrame(), /Measured 1\/2/);
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
      generation: { generatedTokens: 120, durationMs: 2000, estimated: true },
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
      assert.match(frame, /Generation avg TPS\s+~60 tok\/s/);
      assert.match(frame, /Response avg TPS\s+30 tok\/s/);
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
    assert.match(bottom, /model usage\./);
    assert.match(bottom, /Token Pulse details/);
    assert.ok(scroll.scrollTop > 0);
    assert.equal(children[0].y, titleY);
    assert.equal(children.at(-1)!.y, closeHintY);
    if (width === 110) {
      assert.match(bottom.replace(/[█▀▄]/g, ""), /not an average of call\s+speeds/);
      assert.match(bottom, /~ means estimated/);
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
      assert.match(rendered.captureCharFrame(), /model usage\./);
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
        generation: { generatedTokens: generated, durationMs: generationMs, estimated: false },
        response: { generatedTokens: generated, durationMs: responseMs, estimated: false },
      }, 1),
    });
    store.totalsLedger.sessions = { [scope]: makeDirect(100, 1000, 2000), child: makeDirect(600, 2000, 3000),
      grand: makeDirect(30, 3000, 6000), unrelated: makeDirect(9000, 1, 1) };
    store.sessionParents = new Map([["child", scope], ["grand", "child"]]);
    for (let i = 0; i < 35; i++) store.sessionParents.set(`zz-${String(i).padStart(2, "0")}`, scope);
    store.lastCompletedBySession.set("child", ui.makeLastCompletedSnapshot({
      version: 1, messageID: "child-last", sessionID: "child", model: "known-child-model",
      tokens: store.totalsLedger.sessions.child.tokens, cost: 1,
      time: { start: 0, firstToken: 222, completed: 3000 }, samples: [],
      speed: { generation: { generatedTokens: 600, durationMs: 2000, estimated: false } },
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
      if (width === 110) assert.match(rendered.captureCharFrame(), /Generation avg TPS\s+100 tok\/s/);
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
      assert.match(selectedFrames, /Generation avg TPS\s+300 tok\/s/);
      assert.match(selectedFrames, /Response avg TPS\s+200 tok\/s/);
      assert.match(selectedFrames, /known-child-model/);
      assert.match(selectedFrames, /222ms/);
      assert.match(selectedFrames, /300 tok\/s \(generation\)/);
      assert.match(selectedFrames, /INCLUDING SUBAGENTS/);
      assert.match(selectedFrames, /730/);
      assert.match(selectedFrames.replace(/[█▀▄]/g, ""), /not\s+wall-\s*clock/);
      scroll.scrollTo(scroll.scrollHeight); await rendered.renderOnce();
      assert.match(rendered.captureCharFrame(), /model usage\./);
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
  const store = ui.createRuntimeStore(10);
  const now = Date.now();
  const active = ui.createActiveState("m", "root", now - 1000);
  active.selectedSource = "legacy";
  active.legacy.hasData = true;
  active.legacy.samples = [{ timestamp: now - 1000, tokens: 10 }];
  store.active.set("m", active);
  const api = host(80, 8);
  const partState = api.state as unknown as { part: () => unknown[] };
  partState.part = () => [];
  const prompt = ui.createTuiSlotPlugin(api, store, ui.resolveOptions({})).slots!.session_prompt_right!;
  const rendered = await testRender(() => prompt({ theme: api.theme }, { session_id: "root" }), { width: 80, height: 8 });
  try {
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /WARMUP --/);
    assert.doesNotMatch(rendered.captureCharFrame(), /LIVE ~0/);
    active.legacy.samples.push({ timestamp: now, tokens: 20 });
    store.bump();
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /LIVE ~\d+ tok\/s/);
    partState.part = () => [{ type: "tool", state: { status: "running", time: { start: now } } }];
    store.bump();
    await rendered.renderOnce();
    assert.match(rendered.captureCharFrame(), /WAIT --/);
  } finally {
    rendered.renderer.destroy();
    store.disposeSignals();
  }
});
}
