import type { Plugin } from "@opencode/plugin/tui";
import type { KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createRoot, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { createV2EventAdapter } from "./v2-server.js";

export type V2TuiContext = Plugin.Context;
type LegacyLayer = Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0];
type LegacyBinding = NonNullable<LegacyLayer["bindings"]>[number];

function keyString(key: LegacyBinding["key"]): string {
  if (typeof key === "string") return key;
  // OpenTUI's KeyStrokeInput calls the terminal Alt/Option modifier `meta`.
  // Accept the same aliases users already write in native key strings.
  const input = key as typeof key & { alt?: boolean; option?: boolean };
  const modifiers = { ctrl: input.ctrl, shift: input.shift,
    meta: input.meta || input.alt || input.option, super: input.super, hyper: input.hyper };
  return [...Object.entries(modifiers).filter(([, enabled]) => enabled).map(([flag]) => flag), key.name].join("+");
}

/** Only the V1 surface consumed by our existing read-only components. No SDK
 * message mutation, synthetic message cache, or server lifecycle API is used. */
export function createV2TuiBridge(context: V2TuiContext, defaults: readonly LegacyBinding[] = []) {
  let disposed = false;
  let dialogOwned = false;
  const controller = new AbortController();
  const disposers = new Set<() => void | Promise<void>>();
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const adapter = createV2EventAdapter();
  const warnedBindings = new Set<string>();
  const commandDefinitions = new Map<string, KeymapCommand>();
  let stopEvents: (() => void) | undefined;
  const own = (dispose: () => void | Promise<void>) => { disposers.add(dispose); return dispose; };
  const binds = (bindings: readonly LegacyBinding[], id: string): false | string => {
    const keys = bindings.filter((binding) => binding.cmd === id).flatMap((binding) => {
      const unsupported = [
        binding.event !== undefined && binding.event !== "press" ? `event:${String(binding.event)}` : undefined,
        binding.preventDefault !== undefined && binding.preventDefault !== true ? "preventDefault:false" : undefined,
        binding.fallthrough !== undefined && binding.fallthrough !== false ? "fallthrough:true" : undefined,
      ].filter(Boolean);
      if (unsupported.length) {
        const warning = `${id}: ${unsupported.join(", ")}`;
        if (!warnedBindings.has(warning)) {
          warnedBindings.add(warning);
          context.ui.toast.show({ title: "Token Pulse", variant: "warning",
            message: `Shortcut ${warning} is not supported by OpenCode V2. Use the command palette or slash command instead.` });
        }
        return [];
      }
      return [keyString(binding.key)];
    });
    return keys.length ? keys.join(",") : false;
  };
  const location = () => context.location ?? context.data.location.default();

  // Read tokens lazily: theme changes keep their Solid dependency tracking.
  const current = {
    get primary() { return context.theme.hue.interactive[500]; },
    get secondary() { return context.theme.text.action.secondary.base; },
    get accent() { return context.theme.hue.accent[500]; },
    get text() { return context.theme.text.base; },
    get textMuted() { return context.theme.text.muted; },
    get info() { return context.theme.text.feedback.info.base; },
    get background() { return context.theme.background.base; },
    get backgroundPanel() { return context.theme.background.raised.base; },
    get backgroundElement() { return context.theme.background.raised.high; },
    get borderSubtle() { return context.theme.border.base; },
  };

  const api = {
    renderer: context.renderer,
    theme: { current },
    state: {
      path: { get directory() { return location().directory; }, get worktree() { return location().directory; } },
      session: { get: (id: string) => context.data.session.get(id) },
    },
    mode: context.keymap.mode,
    route: {
      get current() {
        const route = context.ui.router.current();
        return route.type === "session" ? { name: "session", params: { sessionID: route.sessionID } }
          : route.type === "plugin" ? { name: route.name, params: route.data } : { name: "home" };
      },
      register: (pages: Parameters<TuiPluginApi["route"]["register"]>[0]) => {
        const stops = pages.map((page) => own(context.ui.router.register({ name: page.name,
          render: ({ data }) => page.render({ params: data }) })));
        return () => stops.forEach((stop) => { void stop(); });
      },
      navigate: (name: string, data?: Record<string, unknown>) => {
        if (name === "home") context.ui.router.navigate({ type: "home" });
        else if (name === "session" && typeof data?.sessionID === "string") context.ui.router.navigate({ type: "session", sessionID: data.sessionID });
        else context.ui.router.navigate({ type: "plugin", name, data });
      },
    },
    ui: {
      toast: (input: Parameters<TuiPluginApi["ui"]["toast"]>[0]) => context.ui.toast.show(input),
      dialog: {
        // V2 exposes no dialog stack getter. Its input mode is the public
        // ownership signal; never replace another modal/selection surface.
        get open() { return dialogOwned || context.keymap.mode.current() !== "base"; },
        replace: (render: Parameters<TuiPluginApi["ui"]["dialog"]["replace"]>[0], closed?: () => void) => {
          if (disposed) return;
          dialogOwned = true;
          try { context.ui.dialog.show(render, () => { dialogOwned = false; closed?.(); }); }
          catch (error) { dialogOwned = false; throw error; }
        },
        setSize: (size: "medium" | "large" | "xlarge") => context.ui.dialog.set({ size }),
      },
    },
    keymap: {
      registerLayer: (layer: LegacyLayer) => {
        const parent = getOwner();
        const register = (disposeRoot: () => void) => {
          const [active, setActive] = createSignal(true);
          let stopped = false;
          const declared: KeymapCommand[] = [];
          const stop = () => {
            if (stopped) return;
            stopped = true; setActive(false); disposeRoot(); disposers.delete(stop);
            for (const command of declared) if (command.id && commandDefinitions.get(command.id) === command) commandDefinitions.delete(command.id);
          };
          own(stop);
          if (parent) runWithOwner(parent, () => onCleanup(stop));
          const commands: KeymapCommand[] = (layer.commands ?? []).map((command) => ({
            id: command.name,
            title: typeof command.title === "string" ? command.title : undefined,
            description: typeof command.desc === "string" ? command.desc : undefined,
            group: typeof command.category === "string" ? command.category : undefined,
            ...(command.namespace === "palette" ? { palette: true as const } : {}),
            ...(typeof command.slashName === "string" ? { slash: { name: command.slashName } } : {}),
            // V2 activates command.bind automatically, even with bindings: [].
            // Discovery-only definitions must not install global shortcuts.
            bind: layer.bindings === undefined ? false : binds(layer.bindings, command.name),
            run: () => { if (active() && !disposed) (command.run as unknown as () => void)(); },
          }));
          for (const command of commands) if (command.id) {
            declared.push(command); commandDefinitions.set(command.id, command);
          }
          const ids = [...new Set((layer.bindings ?? []).map((binding) => binding.cmd).filter((id): id is string => typeof id === "string"))];
          for (const id of ids) {
            if (commands.some((command) => command.id === id)) continue;
            const original = commandDefinitions.get(id);
            if (!original) continue;
            // A base-only named definition lets the real host apply its config
            // override or our default bind. bindings IDs alone read host config
            // only; they never activate another layer's default command.bind.
            // A reachable base definition shadows the global definition in
            // OpenTUI. Preserve discovery metadata as well as its callback.
            commands.push({ ...original,
              bind: binds(layer.bindings ?? defaults, id), run: (...args) => { if (active() && !disposed) return original.run(...args); } });
          }
          const definition: KeymapLayer = {
            mode: typeof layer.mode === "string" ? layer.mode : "global",
            priority: typeof layer.priority === "number" ? layer.priority : undefined,
            enabled: () => active() && !disposed,
            commands,
            bindings: ids.filter((id) => !commands.some((command) => command.id === id)),
          };
          try {
            context.keymap.layer(() => active() ? definition : { ...definition, enabled: false, commands: [], bindings: [] });
          } catch (error) { stop(); throw error; }
          return stop;
        };
        // Async plugin setup normally has no Solid owner. Do NOT invent an
        // owner with an empty context: 2.0.27 then skips its host.owner fallback
        // and Keymap.use() throws. The host already owns setup registrations.
        return parent ? createRoot(register, parent) : register(() => {});
      },
    },
    slots: {
      register: (plugin: Parameters<TuiPluginApi["slots"]["register"]>[0]) => {
        const render = plugin.slots?.sidebar_content;
        // 2.0.27 Sidebar mounts sidebar.content inside its scrollbox and
        // sidebar.footer outside it. Pulse belongs at the list's scrollable end.
        if (typeof render === "function") own(context.ui.slot({ append: "sidebar.content",
          render: (input) => render({ theme: api.theme as unknown as TuiPluginApi["theme"] },
            // Getter preserves reactive host session changes without remounts.
            { get session_id() { return input.sessionID; } }) }));
        return "oc-tps";
      },
    },
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        const set = handlers.get(type) ?? new Set();
        set.add(handler); handlers.set(type, set);
        if (!stopEvents) stopEvents = context.data.listen(({ details }) => {
          if (disposed) return;
          // Discard every content/tool boundary before normalization, cache
          // lookup or hashing; streamed/usage totals are not request completion.
          if (details.type.startsWith("session.text.") || details.type.startsWith("session.reasoning.")
            || details.type.startsWith("session.tool.") || details.type === "session.step.streamed"
            || details.type === "session.usage.updated") return;
          if (details.location && details.location.directory !== location().directory) return;
          for (const event of adapter.events(details)) {
            for (const callback of handlers.get(event.type) ?? []) callback(event);
          }
        });
        return () => { set.delete(handler); if (!set.size) handlers.delete(type); };
      },
    },
    lifecycle: { signal: controller.signal, onDispose: (dispose: () => void | Promise<void>) => {
      own(dispose); return () => { disposers.delete(dispose); };
    } },
  };

  return {
    api: api as unknown as TuiPluginApi,
    async dispose() {
      if (disposed) return;
      disposed = true; controller.abort(); stopEvents?.(); handlers.clear(); adapter.clear();
      // 2.0.27 scopes layers/routes/slots, but its dialog API is shared and has
      // no activation cleanup. Close only our still-active dialog; onClose
      // relinquishes ownership when another plugin or the host replaces it.
      const cleanups = [...disposers].reverse(); disposers.clear();
      if (dialogOwned) {
        dialogOwned = false;
        cleanups.unshift(() => context.ui.dialog.clear());
      }
      await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(cleanup)));
    },
  };
}
