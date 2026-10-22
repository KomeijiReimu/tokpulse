import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { KeymapCommand,ToastOptions } from "@opencode/plugin/tui/context";
import { registerCommaBindings,registerEnabledFields } from "@opentui/keymap/addons";
import { createTestKeymap } from "@opentui/keymap/testing";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createComponent,createComputed,createContext,createRoot,createSignal,getOwner,onCleanup,runWithOwner,untrack,useContext } from "solid-js";
import { createV2TuiBridge,type V2TuiContext } from "../src/tui-v2.js";
import { createRuntimeStore,registerTokenPulseCommands,resolveOptions,tokenPulseBindings } from "../src/tui.js";

type Binding = NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["bindings"]>[number];
type HostBindings = Record<string, { key: string; cmd: string }[]>;

function strictPartial<Type extends object>(value: Partial<Type>): Type {
  return new Proxy(value as Type, { get(target, key, receiver) {
    assert.ok(Reflect.has(target, key), `Unexpected host access: ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } });
}

/** Reproduces the documented V2 layer contract with real Solid owners/computations
 * and the actual OpenTUI parser/dispatcher, not a layer-array-only mock. */
function host(configured: HostBindings = {}) {
  const native = createTestKeymap({ defaultKeys: true });
  native.host.focus(native.root);
  registerEnabledFields(native.keymap); registerCommaBindings(native.keymap);
  const [mode, setMode] = createSignal("base");
  const commands = new Map<string, KeymapCommand>();
  const live = new Set<() => void>();
  const notices: ToastOptions[] = [];
  let shown = 0;
  let dialogClosed: (() => void) | undefined;
  const HostContext = createContext<boolean>();
  let owner: ReturnType<typeof getOwner> = null;
  let disposeHost!: () => void;
  createRoot((dispose) => {
    disposeHost = dispose;
    createComponent(HostContext.Provider, { value: true, get children() { owner = getOwner(); return null; } });
  });
  assert.ok(owner);
  const activation = () => {
  const owned = new Set<() => void>();
  const context = strictPartial<V2TuiContext>({
    renderer: strictPartial<V2TuiContext["renderer"]>({ width: 100, height: 40 }),
    keymap: strictPartial<V2TuiContext["keymap"]>({
      mode: { current: mode, push(next) { const previous = mode(); setMode(next); return () => setMode(previous); } },
      layer(factory) {
        untrack(factory); // Initial host validation is untracked, per 2.0.27.
        // Exact 2.0.27 ownership protocol from packages/tui/src/plugin/api.tsx:
        // a caller owner wins; ownerless async setup falls back to host.owner.
        const caller = getOwner();
        createRoot((dispose) => {
        owned.add(dispose); onCleanup(() => owned.delete(dispose));
        if (caller) runWithOwner(caller, () => onCleanup(dispose));
        assert.equal(useContext(HostContext), true, "Keymap context is missing: caller owner masked host.owner fallback");
        createComputed(() => {
          const layer = factory();
          const definitions = layer.commands ?? [];
          for (const command of definitions) if (command.id) commands.set(command.id, command);
          const enabled = typeof layer.enabled === "function" ? layer.enabled() : layer.enabled !== false;
          const activeMode = layer.mode === "global" || (layer.mode ?? "base") === mode();
          const stop = native.keymap.registerLayer({
            enabled: enabled && activeMode,
            commands: definitions.map((command) => ({ name: command.id!, run: () => command.run(), title: command.title,
              ...(command.palette ? { namespace: "palette" } : {}) })),
            // Exact host default-binding semantics (context/keymap.tsx): each
            // command.bind is automatic; bindings IDs consult config only.
            bindings: definitions.flatMap((command) => command.bind === false ? [] : configured[command.id!] ??
              (typeof command.bind === "string" ? [{ key: command.bind, cmd: command.id! }] : [])),
          });
          live.add(stop);
          onCleanup(() => {
            stop(); live.delete(stop);
            for (const command of definitions) if (command.id && commands.get(command.id) === command) commands.delete(command.id);
          });
        });
        }, caller ?? owner);
      },
    }),
    ui: strictPartial<V2TuiContext["ui"]>({ toast: { show(input) { notices.push(input); } },
      router: strictPartial<V2TuiContext["ui"]["router"]>({ current: () => ({ type: "session", sessionID: "root" }) }),
      dialog: strictPartial<V2TuiContext["ui"]["dialog"]>({
        show(_render, closed) { shown++; dialogClosed = closed; setMode("modal"); }, set() {},
        clear() { dialogClosed?.(); dialogClosed = undefined; setMode("base"); },
      }),
    }),
  });
  return { context, deactivate() { for (const dispose of [...owned]) dispose(); owned.clear(); } };
  };
  return { activation, native, live, notices, setMode, commands, owner, disposeHost, shown: () => shown };
}

function install(f: ReturnType<typeof host>, keybind: unknown, run: () => void) {
  const options = resolveOptions({ keybinds: { "oc-tps.history": keybind, "oc-tps.details": false } });
  const generation = f.activation();
  const bridge = createV2TuiBridge(generation.context, tokenPulseBindings(options));
  const store = createRuntimeStore(10);
  registerTokenPulseCommands(bridge.api, store, options, run);
  let disposed = false;
  return { bridge, store, async dispose() { if (disposed) return; disposed = true; await bridge.dispose(); generation.deactivate(); store.disposeSignals(); } };
}

if (process.env.TOKPULSE_V2_KEYMAP_NATIVE !== "1") {
  test("V2 object bindings and Solid-owned native layer lifecycle (isolated client runtime)", async () => {
    const cache = join(process.env.HOME!, ".cache", "tokpulse-tests");
    await mkdir(cache, { recursive: true });
    const result = await promisify(execFile)(process.execPath, ["test", "--preload", "@opentui/solid/preload", fileURLToPath(import.meta.url)], {
      env: { ...process.env, TOKPULSE_V2_KEYMAP_NATIVE: "1", TMPDIR: cache },
    });
    assert.match(result.stdout + result.stderr, /5 pass/);
  });
} else {
  test("explicitly disabled shortcuts do not dispatch a native key but retain command discovery", async () => {
    const f = host(); let calls = 0;
    const installed = install(f, "none", () => { calls++; });
    try {
      f.native.host.press("t", { ctrl: true, shift: true });
      assert.equal(calls, 0);
      assert.equal(f.commands.get("oc-tps.history")?.bind, false);
      assert.equal(f.native.keymap.runCommand("oc-tps.history").ok, true);
      assert.equal(calls, 1);
      assert.deepEqual(f.native.diagnostics.errors, []);
    } finally { await installed.dispose(); f.disposeHost(); f.native.cleanup(); }
  });

  test("V2 palette/slash discovery survives base bindings; native details default and host overrides stay base-only", async () => {
    const configurations: HostBindings[] = [{}, { "oc-tps.details": [{ key: "ctrl+g", cmd: "oc-tps.details" }] }];
    for (const configured of configurations) {
      const f = host(configured); const generation = f.activation();
      const options = resolveOptions({}); const bridge = createV2TuiBridge(generation.context, tokenPulseBindings(options));
      const store = createRuntimeStore(1); let histories = 0;
      try {
        registerTokenPulseCommands(bridge.api, store, options, () => { histories++; });
        for (const mode of ["base", "modal", "autocomplete"]) {
          f.setMode(mode);
          const reachable = f.native.keymap.getCommands({ visibility: "reachable" });
          for (const [id, slash] of [["oc-tps.history", "tps"], ["oc-tps.details", "tps-details"]]) {
            assert.equal(reachable.find((command) => command.name === id)?.namespace, "palette");
            assert.equal(f.commands.get(id)?.palette, true);
            assert.equal(f.commands.get(id)?.slash?.name, slash);
          }
          if (mode !== "base") {
            f.native.host.press("y", { ctrl: true, shift: true });
            f.native.host.press("g", { ctrl: true }); assert.equal(f.shown(), 0);
            assert.equal(f.native.keymap.runCommand("oc-tps.history").ok, true);
          }
        }
        assert.equal(histories, 2, "palette/slash dispatch works in dialog and autocomplete modes");
        f.setMode("base");
        const overridden = "oc-tps.details" in configured;
        f.native.host.press("y", { ctrl: true, shift: true });
        assert.equal(f.shown(), overridden ? 0 : 1);
        if (overridden) { f.native.host.press("g", { ctrl: true }); assert.equal(f.shown(), 1); }
        assert.equal(f.native.keymap.runCommand("oc-tps.details").ok, true);
        assert.equal(f.shown(), 1, "details does not replace another active dialog");
      } finally { await bridge.dispose(); generation.deactivate(); store.disposeSignals(); f.disposeHost(); f.native.cleanup(); }
      assert.equal(f.live.size, 0);
    }
  });

  test("V2 native object-key modifiers retain meta, Alt/Option aliases and supported Binding semantics", async () => {
    const binding = { key: { name: "t", ctrl: true, meta: true }, event: "press", preventDefault: true, fallthrough: false } satisfies Binding;
    for (const value of [binding, { name: "t", ctrl: true, alt: true }, { key: { name: "t", ctrl: true, option: true } }]) {
      const f = host(); let calls = 0;
      const installed = install(f, value, () => { calls++; });
      try {
        assert.equal(f.commands.get("oc-tps.history")?.bind, "ctrl+meta+t");
        const event = f.native.host.press("t", { ctrl: true, meta: true });
        assert.equal(calls, 1); assert.equal(event.defaultPrevented, true);
        f.native.host.press("t", { ctrl: true }); assert.equal(calls, 1, "Alt must not silently disappear");
        assert.equal(f.notices.length, 0);
        assert.deepEqual(f.native.diagnostics.errors, []);
      } finally { await installed.dispose(); f.disposeHost(); f.native.cleanup(); }
    }
    const original = tokenPulseBindings(resolveOptions({ keybinds: { "oc-tps.history": binding } })).find((item) => item.cmd === "oc-tps.history")!;
    assert.equal(original.event, "press"); assert.equal(original.preventDefault, true); assert.equal(original.fallthrough, false);
  });

  test("V2 refuses unrepresentable release/default/fallthrough semantics instead of changing the shortcut", async () => {
    for (const flags of [{ event: "release" as const }, { preventDefault: false }, { fallthrough: true }]) {
      const binding = { key: { name: "t", ctrl: true, meta: true }, ...flags } satisfies Binding;
      const f = host(); let calls = 0;
      const installed = install(f, binding, () => { calls++; });
      try {
        assert.equal(f.commands.get("oc-tps.history")?.bind, false);
        assert.equal(f.notices.length, 1); assert.match(f.notices[0].message, /not supported by OpenCode V2/);
        assert.equal(f.native.host.press("t", { ctrl: true, meta: true }).defaultPrevented, false);
        f.native.host.release("t", { ctrl: true, meta: true }); assert.equal(calls, 0);
        assert.equal(f.native.keymap.runCommand("oc-tps.history").ok, true);
        assert.equal(calls, 1, "command discovery remains usable without a shortcut");
        const original = tokenPulseBindings(resolveOptions({ keybinds: { "oc-tps.history": binding } })).find((item) => item.cmd === "oc-tps.history")!;
        for (const [name, value] of Object.entries(flags)) assert.equal(original[name], value, "V1 Binding metadata is preserved");
      } finally { await installed.dispose(); f.disposeHost(); f.native.cleanup(); }
    }
  });

  test("V2 native modes, layer unregister, component-owner disposal and plugin reload leave no ghost bindings", async () => {
    const f = host(); let oldCalls = 0; let newCalls = 0;
    const old = install(f, { key: { name: "t", ctrl: true, meta: true } }, () => { oldCalls++; });
    let next: ReturnType<typeof install> | undefined;
    try {
      assert.equal(f.live.size, 2);
      f.native.host.press("t", { ctrl: true, meta: true }); assert.equal(oldCalls, 1);
      f.setMode("dialog"); f.native.host.press("t", { ctrl: true, meta: true }); assert.equal(oldCalls, 1);
      assert.equal(f.native.keymap.runCommand("oc-tps.history").ok, true); assert.equal(oldCalls, 2);
      for (const mode of ["autocomplete", "oc-tps.history"]) {
        f.setMode(mode); f.native.host.press("t", { ctrl: true, meta: true }); assert.equal(oldCalls, 2);
      }
      let backs = 0;
      const stopHistory = old.bridge.api.keymap.registerLayer({ mode: "oc-tps.history", commands: [{ name: "history.back", run: () => { backs++; } }],
        bindings: [{ key: { name: "escape" }, cmd: "history.back" }] });
      f.native.host.press("escape"); assert.equal(backs, 1);
      f.setMode("base");
      f.native.host.press("escape"); assert.equal(backs, 1);
      stopHistory(); assert.equal(f.live.size, 3);
      // Ownerless setup falls back to a host-owned root. layer() has no
      // unregister return value: until deactivation, the bridge empties and
      // disables it. Verify registered commands/bindings, not the host roots.
      assert.equal(f.native.keymap.getCommands({ visibility: "registered" }).some((command) => command.name === "history.back"), false);
      f.setMode("oc-tps.history"); f.native.host.press("escape"); assert.equal(backs, 1);
      f.setMode("base");
      let stopComponent!: () => void;
      let stopLayer!: () => void;
      createRoot((dispose) => {
        stopComponent = dispose;
        stopLayer = old.bridge.api.keymap.registerLayer({ mode: "base", commands: [{ name: "component.back", run: () => {} }], bindings: [{ key: "escape", cmd: "component.back" }] });
      }, f.owner);
      assert.ok(f.commands.has("component.back")); stopLayer();
      assert.equal(f.commands.has("component.back"), false); stopComponent();
      createRoot((dispose) => {
        stopComponent = dispose;
        old.bridge.api.keymap.registerLayer({ commands: [{ name: "component.owned", run: () => {} }] });
      }, f.owner);
      assert.ok(f.commands.has("component.owned")); stopComponent();
      assert.equal(f.commands.has("component.owned"), false);
      const captured = f.commands.get("oc-tps.history")!;
      await old.dispose(); assert.equal(f.live.size, 0);
      assert.equal(f.native.keymap.getCommands({ visibility: "registered" }).length, 0);
      f.native.host.press("t", { ctrl: true, meta: true }); await captured.run(); assert.equal(oldCalls, 2);
      next = install(f, { key: { name: "t", ctrl: true, meta: true } }, () => { newCalls++; });
      f.native.host.press("t", { ctrl: true, meta: true }); assert.equal(newCalls, 1); assert.equal(oldCalls, 2);
      await next.dispose(); assert.equal(f.live.size, 0);
      assert.deepEqual(f.native.diagnostics.errors, []);
    } finally { await old.dispose(); await next?.dispose(); f.disposeHost(); f.native.cleanup(); }
  });
}
