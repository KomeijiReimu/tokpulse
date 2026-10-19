import { randomUUID } from "node:crypto";
import { createRoot, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { createV2EventAdapter, isContentOnlyEvent, isV2ControlEvent } from "./v2-server.js";
import { parentProofPort } from "./tui-read-model.js";
/** Unknown ownership may await metadata, never retain tool input/body objects. */
function queuedControl(raw) {
  const input = raw.data;
  const data = {};
  for (const key of ["sessionID", "assistantMessageID", "agent", "title", "parentID", "parentSessionID", "started", "cost", "finish", "id"]) {
    const value = input[key];
    if (value === null || typeof value === "string" || typeof value === "number") data[key] = value;
  }
  for (const key of ["status", "state"]) if (input[key] !== undefined) {
    data[key] = typeof input[key] === "string" ? input[key] : {
      type: input[key]?.type
    };
  }
  if (input.model) data.model = {
    providerID: input.model.providerID,
    id: input.model.id,
    modelID: input.model.modelID
  };
  if (input.metadata) data.metadata = {
    magic_context: input.metadata.magic_context,
    role: input.metadata.role
  };
  if (input.tokens && typeof input.tokens === "object") {
    const source = input.tokens;
    const tokens = {};
    for (const key of ["input", "output", "reasoning"]) if (typeof source[key] === "number") tokens[key] = source[key];
    if (source.cache) {
      tokens.cache = {};
      for (const key of ["read", "write"]) if (typeof source.cache[key] === "number") tokens.cache[key] = source.cache[key];
    }
    data.tokens = tokens;
  }
  return {
    type: raw.type,
    id: raw.id,
    created: raw.created,
    ...(raw.durable ? {
      durable: {
        seq: raw.durable.seq
      }
    } : {}),
    data
  };
}
function keyString(key) {
  if (typeof key === "string") return key;
  // OpenTUI's KeyStrokeInput calls the terminal Alt/Option modifier `meta`.
  // Accept the same aliases users already write in native key strings.
  const input = key;
  const modifiers = {
    ctrl: input.ctrl,
    shift: input.shift,
    meta: input.meta || input.alt || input.option,
    super: input.super,
    hyper: input.hyper
  };
  return [...Object.entries(modifiers).filter(([, enabled]) => enabled).map(([flag]) => flag), key.name].join("+");
}

/** Only the V1 surface consumed by our existing read-only components. No SDK
 * message mutation, synthetic message cache, or server lifecycle API is used. */
export function createV2TuiBridge(context, defaults = []) {
  let disposed = false;
  let dialogOwned = false;
  let dialogGeneration = 0;
  const controller = new AbortController();
  const disposers = new Set();
  const handlers = new Map();
  const adapter = createV2EventAdapter();
  const proven = new Set();
  const pending = new Map();
  const lookupQueue = new Set();
  const attempted = new Set();
  const lookupActive = new Map();
  const parentRequests = new Map();
  const proofAvailable = new Set();
  let proofQueueVisits = 0;
  const pendingSize = (count = true) => {
    let size = pending.size;
    for (const id of parentRequests.keys()) {
      if (count) proofQueueVisits++;
      if (!pending.has(id)) size++;
    }
    return size;
  };
  const location = () => context.location ?? context.data.location.default();
  let proofDirectory;
  let proofEpoch = 0;
  let allowCachedProof = true;
  let inFlight = 0;
  let lookupCount = 0;
  let connected = false;
  const bridgeID = randomUUID();
  let healthSerial = 0;
  let retryTimer;
  let retryDue = Infinity;
  const wake = event => {
    if (!disposed) for (const receive of proofAvailable) receive(event);
  };
  const emit = event => {
    const sourced = {
      ...event,
      sourceEpoch: `tui-bridge:${bridgeID}:${proofEpoch}`
    };
    for (const callback of handlers.get(event.type) ?? []) callback(sourced);
  };
  const finishParent = (job, outcome) => {
    if (job.done) return;
    job.done = true;
    const receive = job.receive;
    job.receive = undefined;
    if (parentRequests.get(job.id) === job) parentRequests.delete(job.id);
    if (!disposed) receive?.(outcome, job.version);
  };
  const resetProofEpoch = () => {
    proofEpoch++;
    allowCachedProof = false;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDue = Infinity;
    for (const job of [...parentRequests.values()]) finishParent(job, {
      status: "stale"
    });
    adapter.invalidate();
    proven.clear();
    pending.clear();
    lookupQueue.clear();
    attempted.clear();
    parentRequests.clear();
    // Uncancellable host RPCs still own their physical slots until finally.
    // Do not clear lookupActive/inFlight or let an old finally delete new work.
  };
  const ensureProofDirectory = () => {
    const directory = location().directory;
    if (proofDirectory === undefined) {
      proofDirectory = directory;
      return;
    }
    if (directory === proofDirectory) return;
    proofDirectory = directory;
    resetProofEpoch();
    emit({
      type: "server.instance.disposed",
      properties: {}
    });
  };
  const deliver = raw => {
    if (!disposed) for (const event of adapter.events(raw)) emit(event);
  };
  const flush = id => {
    const events = pending.get(id);
    const freed = pending.delete(id);
    attempted.delete(id);
    for (const event of events ?? []) deliver(event);
    if (freed && !parentRequests.has(id)) wake({
      kind: "capacity"
    });
  };
  const cachedProof = id => {
    try {
      const session = context.data.session.get(id);
      return session?.id === id && session.location?.directory === proofDirectory;
    } catch {
      return false;
    }
  };
  const pump = () => {
    if (disposed) return;
    ensureProofDirectory();
    while (!disposed && inFlight < 4 && lookupQueue.size) {
      let id;
      const now = performance.now();
      for (const candidate of lookupQueue) if (!lookupActive.has(candidate) && (parentRequests.get(candidate)?.due ?? 0) <= now) {
        id = candidate;
        break;
      }
      if (id === undefined) break; // Keep fresh same-SID work queued behind its old RPC.
      lookupQueue.delete(id);
      if (proven.has(id) && !parentRequests.has(id)) continue;
      const sid = id;
      const token = Symbol();
      const epoch = proofEpoch;
      const directory = proofDirectory;
      const parentRequest = parentRequests.get(sid);
      if (parentRequest) parentRequest.attempts++;
      lookupActive.set(sid, token);
      inFlight++;
      void Promise.resolve().then(() => {
        if (disposed || epoch !== proofEpoch || directory !== location().directory) return;
        if (parentRequest && (parentRequest.done || parentRequests.get(sid) !== parentRequest)) return;
        lookupCount++;
        return context.data.session.sync(sid);
      }).then(() => {
        if (parentRequest && (parentRequest.done || parentRequests.get(sid) !== parentRequest)) return;
        if (!disposed && epoch === proofEpoch && directory === location().directory && cachedProof(sid)) {
          proven.add(sid);
          flush(sid);
          if (parentRequest && parentRequests.get(sid) === parentRequest) {
            const entity = context.data.session.get(sid);
            if (entity?.id === sid && entity.location?.directory === directory) {
              finishParent(parentRequest, {
                status: "success",
                parent: entity.parentID || null
              });
            }
          }
          wake({
            kind: "healthy",
            serial: ++healthSerial
          });
        } else if (!disposed && epoch === proofEpoch) throw Error("session ownership not proved by fresh metadata");
      }).catch(() => {
        if (!disposed && epoch === proofEpoch && parentRequest && parentRequests.get(sid) === parentRequest && !parentRequest.done) {
          if (parentRequest.attempts < 3) {
            parentRequest.due = performance.now() + (parentRequest.attempts === 1 ? 250 : 1000);
            lookupQueue.add(sid);
          } else finishParent(parentRequest, {
            status: "error"
          });
        }
      }).finally(() => {
        inFlight--;
        if (lookupActive.get(sid) === token) lookupActive.delete(sid);
        if (epoch === proofEpoch && !pending.has(sid)) attempted.delete(sid);
        if (!disposed) {
          wake({
            kind: "capacity"
          });
          pump();
        }
      });
    }
    let due = Infinity;
    for (const id of lookupQueue) {
      const job = parentRequests.get(id);
      if (job && job.due > performance.now()) due = Math.min(due, job.due);
    }
    if (due !== retryDue) {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      retryDue = due;
      if (Number.isFinite(due)) retryTimer = setTimeout(() => {
        retryTimer = undefined;
        retryDue = Infinity;
        pump();
      }, Math.max(0, due - performance.now()));
    }
  };
  const warnedBindings = new Set();
  const commandDefinitions = new Map();
  let stopEvents;
  const own = dispose => {
    disposers.add(dispose);
    return dispose;
  };
  const binds = (bindings, id) => {
    const keys = bindings.filter(binding => binding.cmd === id).flatMap(binding => {
      const unsupported = [binding.event !== undefined && binding.event !== "press" ? `event:${String(binding.event)}` : undefined, binding.preventDefault !== undefined && binding.preventDefault !== true ? "preventDefault:false" : undefined, binding.fallthrough !== undefined && binding.fallthrough !== false ? "fallthrough:true" : undefined].filter(Boolean);
      if (unsupported.length) {
        const warning = `${id}: ${unsupported.join(", ")}`;
        if (!warnedBindings.has(warning)) {
          warnedBindings.add(warning);
          context.ui.toast.show({
            title: "Token Pulse",
            variant: "warning",
            message: `Shortcut ${warning} is not supported by OpenCode V2. Use the command palette or slash command instead.`
          });
        }
        return [];
      }
      return [keyString(binding.key)];
    });
    return keys.length ? keys.join(",") : false;
  };

  // Read tokens lazily: theme changes keep their Solid dependency tracking.
  const current = {
    get primary() {
      return context.theme.hue.interactive[500];
    },
    get secondary() {
      return context.theme.text.action.secondary.base;
    },
    get accent() {
      return context.theme.hue.accent[500];
    },
    get text() {
      return context.theme.text.base;
    },
    get textMuted() {
      return context.theme.text.muted;
    },
    get info() {
      return context.theme.text.feedback.info.base;
    },
    get background() {
      return context.theme.background.base;
    },
    get backgroundPanel() {
      return context.theme.background.raised.base;
    },
    get backgroundElement() {
      return context.theme.background.raised.high;
    },
    get borderSubtle() {
      return context.theme.border.base;
    }
  };
  const api = {
    [parentProofPort]: {
      epoch: () => proofEpoch,
      request: (id, version, receive, options) => {
        if (disposed) return false;
        const previous = parentRequests.get(id);
        if (previous?.version === version && previous.receive === receive) return true;
        if (!previous && !pending.has(id) && pendingSize() >= 256) return false;
        if (previous) finishParent(previous, {
          status: "stale"
        });
        parentRequests.set(id, {
          id,
          version,
          receive,
          epoch: proofEpoch,
          attempts: 0,
          due: options?.notBefore ?? 0,
          done: false
        });
        lookupQueue.add(id);
        pump();
        return true;
      },
      available: receive => {
        proofAvailable.add(receive);
        return () => {
          proofAvailable.delete(receive);
        };
      }
    },
    renderer: context.renderer,
    theme: {
      current
    },
    state: {
      path: {
        get directory() {
          return location().directory;
        },
        get worktree() {
          return location().directory;
        }
      },
      session: {
        get: id => context.data.session.get(id)
      }
    },
    mode: context.keymap.mode,
    route: {
      get current() {
        const route = context.ui.router.current();
        return route.type === "session" ? {
          name: "session",
          params: {
            sessionID: route.sessionID
          }
        } : route.type === "plugin" ? {
          name: route.name,
          params: route.data
        } : {
          name: "home"
        };
      },
      register: pages => {
        const stops = pages.map(page => own(context.ui.router.register({
          name: page.name,
          render: ({
            data
          }) => page.render({
            params: data
          })
        })));
        return () => stops.forEach(stop => {
          void stop();
        });
      },
      navigate: (name, data) => {
        if (name === "home") context.ui.router.navigate({
          type: "home"
        });else if (name === "session" && typeof data?.sessionID === "string") context.ui.router.navigate({
          type: "session",
          sessionID: data.sessionID
        });else context.ui.router.navigate({
          type: "plugin",
          name,
          data
        });
      }
    },
    ui: {
      toast: input => context.ui.toast.show(input),
      dialog: {
        // V2 exposes no dialog stack getter. Its input mode is the public
        // ownership signal; never replace another modal/selection surface.
        get open() {
          return dialogOwned || context.keymap.mode.current() !== "base";
        },
        replace: (render, closed) => {
          if (disposed) return;
          dialogOwned = true;
          const generation = ++dialogGeneration;
          try {
            context.ui.dialog.show(render, () => {
              if (generation === dialogGeneration) dialogOwned = false;
              closed?.();
            });
          } catch (error) {
            dialogOwned = false;
            throw error;
          }
        },
        setSize: size => context.ui.dialog.set({
          size
        })
      }
    },
    keymap: {
      registerLayer: layer => {
        const parent = getOwner();
        const register = disposeRoot => {
          const [active, setActive] = createSignal(true);
          let stopped = false;
          const declared = [];
          const stop = () => {
            if (stopped) return;
            stopped = true;
            setActive(false);
            disposeRoot();
            disposers.delete(stop);
            for (const command of declared) if (command.id && commandDefinitions.get(command.id) === command) commandDefinitions.delete(command.id);
          };
          own(stop);
          if (parent) runWithOwner(parent, () => onCleanup(stop));
          const commands = (layer.commands ?? []).map(command => ({
            id: command.name,
            title: typeof command.title === "string" ? command.title : undefined,
            description: typeof command.desc === "string" ? command.desc : undefined,
            group: typeof command.category === "string" ? command.category : undefined,
            ...(command.namespace === "palette" ? {
              palette: true
            } : {}),
            ...(typeof command.slashName === "string" ? {
              slash: {
                name: command.slashName
              }
            } : {}),
            // V2 activates command.bind automatically, even with bindings: [].
            // Discovery-only definitions must not install global shortcuts.
            bind: layer.bindings === undefined ? false : binds(layer.bindings, command.name),
            run: () => {
              if (active() && !disposed) command.run();
            }
          }));
          for (const command of commands) if (command.id) {
            declared.push(command);
            commandDefinitions.set(command.id, command);
          }
          const ids = [...new Set((layer.bindings ?? []).map(binding => binding.cmd).filter(id => typeof id === "string"))];
          for (const id of ids) {
            if (commands.some(command => command.id === id)) continue;
            const original = commandDefinitions.get(id);
            if (!original) continue;
            // A base-only named definition lets the real host apply its config
            // override or our default bind. bindings IDs alone read host config
            // only; they never activate another layer's default command.bind.
            // A reachable base definition shadows the global definition in
            // OpenTUI. Preserve discovery metadata as well as its callback.
            commands.push({
              ...original,
              bind: binds(layer.bindings ?? defaults, id),
              run: (...args) => {
                if (active() && !disposed) return original.run(...args);
              }
            });
          }
          const definition = {
            mode: typeof layer.mode === "string" ? layer.mode : "global",
            priority: typeof layer.priority === "number" ? layer.priority : undefined,
            enabled: () => active() && !disposed,
            commands,
            bindings: ids.filter(id => !commands.some(command => command.id === id))
          };
          try {
            context.keymap.layer(() => active() ? definition : {
              ...definition,
              enabled: false,
              commands: [],
              bindings: []
            });
          } catch (error) {
            stop();
            throw error;
          }
          return stop;
        };
        // Async plugin setup normally has no Solid owner. Do NOT invent an
        // owner with an empty context: 2.0.27 then skips its host.owner fallback
        // and Keymap.use() throws. The host already owns setup registrations.
        return parent ? createRoot(register, parent) : register(() => {});
      }
    },
    slots: {
      register: plugin => {
        const render = plugin.slots?.sidebar_content;
        // 2.0.27 Sidebar mounts sidebar.content inside its scrollbox and
        // sidebar.footer outside it. Pulse belongs at the list's scrollable end.
        if (typeof render === "function") own(context.ui.slot({
          append: "sidebar.content",
          render: input => render({
            theme: api.theme
          },
          // Getter preserves reactive host session changes without remounts.
          {
            get session_id() {
              return input.sessionID;
            }
          })
        }));
        return "oc-tps";
      }
    },
    event: {
      on: (type, handler) => {
        const set = handlers.get(type) ?? new Set();
        set.add(handler);
        handlers.set(type, set);
        if (!stopEvents) stopEvents = context.data.listen(({
          details
        }) => {
          if (disposed) return;
          // Gate by type before *any* payload/location/cache/query work.
          const type = details.type;
          if (isContentOnlyEvent(type)) return;
          const disruption = type === "server.instance.disposed" || /^(?:workspace\..*(?:status|disposed|deleted)|server\.(?:disconnected|error))$/.test(type);
          if (!disruption && !isV2ControlEvent(type)) return;
          ensureProofDirectory();
          if (disruption) {
            resetProofEpoch();
            emit({
              type: "server.instance.disposed",
              properties: {}
            });
            return;
          }
          if (!isV2ControlEvent(details.type)) return;
          if (details.type === "server.connected") {
            if (connected) resetProofEpoch();
            connected = true;
            emit({
              type: "server.connected",
              properties: {}
            });
            return;
          }
          const raw = details;
          const data = raw.data;
          if (!data || typeof data.sessionID !== "string") return;
          const id = data.sessionID;
          const outer = raw.location?.directory;
          const inner = data.location?.directory;
          const directory = proofDirectory;
          if (typeof directory !== "string" || !directory) return;
          if (outer !== undefined && outer !== directory || inner !== undefined && inner !== directory) return;
          if (outer === directory || inner === directory || proven.has(id) || allowCachedProof && cachedProof(id)) {
            proven.add(id);
            flush(id);
            deliver(details);
            return;
          }
          let queue = pending.get(id);
          while (!queue && !parentRequests.has(id) && pendingSize() >= 256) {
            const oldest = pending.keys().next().value;
            if (oldest === undefined) {
              adapter.invalidate(id);
              return;
            }
            pending.delete(oldest);
            if (!parentRequests.has(oldest)) lookupQueue.delete(oldest);
            attempted.delete(oldest);
            adapter.invalidate(oldest);
          }
          queue ??= [];
          if (queue.length >= 64) {
            queue.length = 0;
            adapter.invalidate(id);
          }
          queue.push(queuedControl(raw));
          pending.set(id, queue);
          if (!attempted.has(id)) {
            attempted.add(id);
            lookupQueue.add(id);
            pump();
          }
        });
        return () => {
          set.delete(handler);
          if (!set.size) handlers.delete(type);
        };
      }
    },
    lifecycle: {
      signal: controller.signal,
      onDispose: dispose => {
        own(dispose);
        return () => {
          disposers.delete(dispose);
        };
      }
    }
  };
  return {
    api: api,
    retainedState: () => ({
      ...adapter.retainedState(),
      provenSessions: proven.size,
      pendingSessions: pendingSize(false),
      parentPendingSessions: parentRequests.size,
      proofQueueVisits,
      pendingEvents: [...pending.values()].reduce((sum, events) => sum + events.length, 0),
      lookupCount,
      inFlight,
      retryTimers: Number(retryTimer !== undefined)
    }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      stopEvents?.();
      handlers.clear();
      adapter.clear();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      retryDue = Infinity;
      for (const job of parentRequests.values()) {
        job.done = true;
        job.receive = undefined;
      }
      proven.clear();
      pending.clear();
      lookupQueue.clear();
      attempted.clear();
      parentRequests.clear();
      proofAvailable.clear();
      // 2.0.27 scopes layers/routes/slots, but its dialog API is shared and has
      // no activation cleanup. Close only our still-active dialog; onClose
      // relinquishes ownership when another plugin or the host replaces it.
      const cleanups = [...disposers].reverse();
      disposers.clear();
      if (dialogOwned) {
        dialogOwned = false;
        cleanups.unshift(() => context.ui.dialog.clear());
      }
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve().then(cleanup)));
    }
  };
}
