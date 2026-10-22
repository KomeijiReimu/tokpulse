import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";
import * as tuiSolid from "@opentui/solid";
import type { Route, SlotClaim } from "@opencode/plugin/tui/context";
import type { HistoryRecord } from "../src/core.js";
import { normalizeActivityEvent } from "../src/activity.js";
import { initializeTui, buildSessionDetailsTree, createRuntimeStore, reloadHistory, reloadActivity, tuiActivityTimes } from "../src/tui.js";
import { createV2TuiBridge, type V2TuiContext } from "../src/tui-v2.js";
import { sessionSourcePaths } from "../src/tui-source.js";
import { tuiReadModel, parentProofPort, type ParentProofPort } from "../src/tui-read-model.js";
const { spyOn } = require("bun:test");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = process.env.TMPDIR ?? join(homedir(), ".cache", "tokpulse-tests");
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(join(root, "session-source-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

async function ledger(directory: string, value: number, sid = "root", options = {}) {
  const paths = sessionSourcePaths(directory, options);
  for (const path of Object.values(paths)) await fs.mkdir(join(path, ".."), { recursive: true });
  const record: HistoryRecord = { version: 1, messageID: `message-${value}`, sessionID: sid,
    tokens: { input: value, output: value, reasoning: 0, cacheRead: value * 9, cacheWrite: 0 }, cost: 1,
    quality: "exact", time: { start: 100, completed: 100 + value, duration: value }, samples: [] };
  const fact = (state: "busy" | "idle", timestamp: number) => normalizeActivityEvent({
    version: 2, kind: "lifecycle", eventID: `${value}-${state}`, instanceID: `instance-${value}`,
    sessionID: sid, executionID: `execution-${value}`, timestamp, observedAt: timestamp, state,
  })!;
  await fs.writeFile(paths.history, JSON.stringify(record) + "\n");
  await fs.writeFile(paths.totals, JSON.stringify({ version: 1, generationBasisVersion: 3,
    sessions: { [sid]: { tokens: record.tokens, cost: 1, responseCount: 1 } },
    open: {}, settled: { [record.messageID]: true } }));
  await fs.writeFile(paths.runs, [fact("busy", 100), fact("idle", 100 + value)].map((value) => JSON.stringify(value)).join("\n") + "\n");
  return paths;
}

function host(directory: string, initial = "root") {
  let send!: (event: { details: any }) => void;
  let stopEffects = () => {};
  let sync = async (_id: string) => {};
  const sessions = new Map<string, { id: string; parentID?: string; location: { directory: string; worktree?: string } }>();
  const slots: SlotClaim[] = [];
  const state = createRoot((dispose) => {
    stopEffects = dispose;
    const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: initial });
    const [revision, setRevision] = createSignal(0);
    return { route, setRoute, revision, changed: () => setRevision((value) => value + 1) };
  });
  const context = {
    options: {}, location: { directory }, theme: {}, renderer: { width: 100, height: 40 },
    data: { location: { default: () => ({ directory }) }, listen: (receive: typeof send) => { send = receive; return () => {}; },
      session: { get: (id: string) => { state.revision(); return sessions.get(id); }, sync: (id: string) => sync(id) } },
    keymap: { mode: { current: () => "base", push: () => () => {} }, layer: () => {} },
    ui: { router: { current: state.route, navigate: state.setRoute, register: () => () => {} },
      slot: (claim: SlotClaim) => { slots.push(claim); return () => {}; }, toast: { show: () => {} },
      dialog: { show: () => {}, clear: () => {}, set: () => {} } },
  } as unknown as V2TuiContext;
  const bridge = createV2TuiBridge(context);
  return { bridge, slots, sessions,
    setSession(id: string, root: string) { sessions.set(id, { id, location: { directory: root, worktree: "/wrong-worktree" } }); state.changed(); },
    setRoute(id: string) { state.setRoute({ type: "session", sessionID: id }); },
    setSync(fn: typeof sync) { sync = fn; },
    send(type: string, data: Record<string, unknown>, root?: string) {
      send({ details: { type, data, id: `event-${Math.random()}`, created: Date.now(),
        ...(root === undefined ? {} : { location: { directory: root } }) } });
    },
    async dispose() { await bridge.dispose(); stopEffects(); },
  };
}

function selected(store: NonNullable<Awaited<ReturnType<typeof initializeTui>>>["store"], sid = "root") {
  return buildSessionDetailsTree(store, sid).nodes.find((node) => node.sessionID === sid)?.direct.tokens.input;
}

test("actual initialize/bridge binds all three ledgers to metadata, independent of launch directory, A -> B -> A", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  await ledger(A, 11); await ledger(B, 22);
  for (const launch of [A, B]) {
    const f = host(launch); f.setSession("root", A);
    try {
      const h = (await initializeTui(f.bridge.api, {}))!;
      assert.equal(f.slots[0].append, "sidebar.content", "production slot registration is exercised");
      for (const [directory, value] of [[A, 11], [B, 22], [A, 11]] as const) {
        f.setSession("root", directory); await h.selectSession("root");
        assert.equal(h.store.sourceState.directory, directory);
        assert.equal(h.store.sourceState.status, "ready");
        assert.equal(h.store.sourceState.paths?.history, join(directory, ".tokpulse/history.jsonl"));
        assert.equal(selected(h.store), value);
        assert.equal(h.store.diskRecords[0].messageID, `message-${value}`);
        assert.equal(tuiActivityTimes(h.store, "root").directMilliseconds, value);
        const before = h.store.optimistic.size;
        f.send("session.step.ended", { sessionID: "root", assistantMessageID: `foreign-${value}`,
          tokens: { input: 999, output: 999 }, cost: 0, finish: "stop" }, directory === A ? B : A);
        assert.equal(h.store.optimistic.size, before, "foreign-directory live events cannot enter this source");
        f.send("session.step.ended", { sessionID: "root", assistantMessageID: `local-${value}`,
          tokens: { input: 1, output: 1 }, cost: 0, finish: "stop" }, directory);
        assert.ok(h.store.optimistic.has(`local-${value}`), "proof directory follows selected source, not plugin ctx.location");
      }
    } finally { await f.dispose(); }
  }
});

test("foreign workspace/transport disruption cannot freeze selected live time or reset proof epoch", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  await ledger(A, 11); await ledger(B, 22);
  const f = host(A); f.setSession("root", B);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    const proof = (f.bridge.api as typeof f.bridge.api & { [parentProofPort]: ParentProofPort })[parentProofPort];
    f.send("session.execution.started", { sessionID: "root" }, B);
    const now = Date.now() + 10_000, before = tuiActivityTimes(h.store, "root", now), epoch = proof.epoch();
    assert.equal(before.active, true);
    for (const type of ["workspace.disposed", "workspace.status", "workspace.status.changed", "workspace.deleted",
      "server.instance.disposed", "server.disconnected", "server.error", "server.connected"]) {
      for (const shape of ["outer", "inner", "directory"] as const) {
        f.send(type, shape === "inner" ? { location: { directory: A } } : shape === "directory" ? { directory: A } : {},
          shape === "outer" ? A : undefined);
        assert.equal(proof.epoch(), epoch, `${type}/${shape}: foreign disruption has no ownership`);
        assert.deepEqual(tuiActivityTimes(h.store, "root", now), before, `${type}/${shape}: selected time remains live`);
      }
    }
    f.send("server.disconnected", {});
    assert.ok(proof.epoch() > epoch, "a genuinely global transport disruption still resets proof");
    assert.equal(tuiActivityTimes(h.store, "root", now).active, false);
  } finally { await f.dispose(); }
});

test("rapid unknown-SID source discovery keeps one physical RPC and only the latest queued SID", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B"), latest = "unknown-99";
  await ledger(A, 11); await ledger(B, 22, latest);
  const f = host(A); f.setSession("root", A);
  const first = deferred(), firstEntered = deferred(), last = deferred(), lastEntered = deferred();
  let active = 0, maximum = 0;
  const calls: string[] = [], requests: Promise<void>[] = [];
  f.setSync(async (id) => {
    calls.push(id); maximum = Math.max(maximum, ++active);
    try {
      if (id === "unknown-0") { firstEntered.resolve(); await first.promise; throw Error("stale metadata failure"); }
      assert.equal(id, latest); lastEntered.resolve(); await last.promise; f.setSession(id, B);
    } finally { active--; }
  });
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    requests.push(h.selectSession("unknown-0")); await firstEntered.promise;
    for (let i = 1; i < 100; i++) requests.push(h.selectSession(`unknown-${i}`));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(calls, ["unknown-0"]); assert.equal(maximum, 1);
    assert.equal(h.store.sourceState.sessionID, latest); assert.equal(h.store.sourceState.status, "waiting-metadata");
    first.resolve(); await lastEntered.promise;
    assert.deepEqual(calls, ["unknown-0", latest]); assert.equal(maximum, 1);
    last.resolve(); await Promise.all(requests); await h.settled();
    assert.equal(h.store.sourceState.sessionID, latest); assert.equal(h.store.sourceState.directory, B);
    assert.equal(h.store.sourceState.status, "ready"); assert.equal(selected(h.store, latest), 22);
    assert.equal(h.store.sourceState.errors?.metadata, undefined, "stale failure cannot overwrite the latest selection");
  } finally { first.resolve(); last.resolve(); await f.dispose(); await Promise.allSettled(requests); }
});

test("disposing source discovery settles queued callers and never dispatches their physical RPC", async (t) => {
  const base = await fixture(t); await ledger(base, 11);
  const f = host(base); f.setSession("root", base);
  const entered = deferred(), gate = deferred(), exited = deferred(), calls: string[] = [], requests: Promise<void>[] = [];
  f.setSync(async (id) => {
    calls.push(id); entered.resolve();
    try { await gate.promise; } finally { exited.resolve(); }
  });
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    requests.push(h.selectSession("unknown-0")); await entered.promise;
    for (let i = 1; i < 100; i++) requests.push(h.selectSession(`unknown-${i}`));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await f.dispose(); await Promise.all(requests);
    assert.deepEqual(calls, ["unknown-0"], "dispose does not dispatch the latest queued SID");
    gate.resolve(); await exited.promise;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(calls, ["unknown-0"], "the uncancellable old RPC finally cannot dispatch after dispose");
    assert.equal(h.store.disposed, true); assert.deepEqual(h.store.diskRecords, []);
  } finally { gate.resolve(); await f.dispose(); await Promise.allSettled(requests); }
});

test("same-root SID navigation reuses loaded ledgers, read model and activity projector", async (t) => {
  const base = await fixture(t); const paths = await ledger(base, 7);
  const f = host(base); f.setSession("root", base); f.setSession("child", base);
  const open = fs.open, reads: string[] = [];
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    reads.push(String(args[0])); return open(...args);
  });
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    const epoch = h.store.sourceEpoch, model = tuiReadModel(h.store), records = h.store.diskRecords, events = h.store.activityEvents;
    const before = reads.length;
    for (const id of ["child", "root", "child", "root"]) { f.setRoute(id); await h.selectSession(id); }
    assert.equal(h.store.sourceEpoch, epoch);
    assert.equal(tuiReadModel(h.store), model);
    assert.equal(h.store.diskRecords, records); assert.equal(h.store.activityEvents, events);
    assert.equal(reads.length, before, "route-only changes do no ledger I/O");
    for (const path of Object.values(paths)) assert.equal(reads.filter((entry) => entry === path).length, 1);
  } finally { spy.mockRestore(); await f.dispose(); }
});

test("registered route and metadata effects follow host navigation without helper calls", async (t) => {
  // Bun's default `node` Solid export intentionally makes createEffect a no-op.
  // Exercise the same browser/reactive export used by the real TUI host.
  if (process.env.TOKPULSE_BROWSER_SOURCE_TEST !== "1") {
    const child = spawnSync(process.execPath, ["--conditions=browser", "test", import.meta.filename,
      "--test-name-pattern", "registered route and metadata effects"], {
      env: { ...process.env, TOKPULSE_BROWSER_SOURCE_TEST: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr); return;
  }
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  await ledger(A, 11); await ledger(B, 22, "other");
  const f = host(A); f.setSession("root", A); f.setSession("other", B);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    f.setRoute("other"); await Promise.resolve(); await h.settled();
    assert.equal(h.store.sourceState.sessionID, "other"); assert.equal(selected(h.store, "other"), 22);
    await ledger(A, 33, "other");
    f.setSession("other", A); await Promise.resolve(); await h.settled();
    assert.equal(h.store.sourceState.directory, A); assert.equal(selected(h.store, "other"), 33);
    // Stop at the component boundary: source registration/effects stay real,
    // while presentation and OpenTUI mounting belong to separate render tests.
    const component = spyOn(tuiSolid, "createComponent").mockImplementation(() => null);
    const [sidebar, setSidebar] = createSignal("root");
    let stopSidebar = () => {};
    try {
      createRoot((dispose) => {
        stopSidebar = dispose;
        const render = f.slots[0].render as unknown as (input: { sessionID: string }) => unknown;
        render({ get sessionID() { return sidebar(); } });
      });
      await h.settled(); assert.equal(h.store.sourceState.sessionID, "root");
      f.setSession("other", B); await Promise.resolve(); await h.settled();
      assert.equal(h.store.sourceState.sessionID, "root", "route metadata cannot steal the visible sidebar source");
      setSidebar("other"); await Promise.resolve(); await h.settled();
      assert.equal(h.store.sourceState.directory, B); assert.equal(selected(h.store, "other"), 22);
    } finally { stopSidebar(); component.mockRestore(); }
  } finally { await f.dispose(); }
});

test("unknown metadata clears the previous source without a false ready/zero, and stale sync cannot steal navigation", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  await ledger(A, 10); await ledger(B, 20, "other");
  const f = host(A); f.setSession("root", A); f.setSession("other", B);
  const gate = deferred(); f.setSync(async () => gate.promise);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    const old = h.selectSession("unknown");
    assert.equal(h.store.sourceState.status, "waiting-metadata");
    assert.equal(h.store.sourceState.paths, undefined); assert.equal(h.store.sourceState.live, false);
    assert.deepEqual(h.store.diskRecords, []); assert.equal(h.store.optimistic.size, 0);
    await h.selectSession("other");
    f.setSession("unknown", A); gate.resolve(); await old;
    assert.equal(h.store.sourceState.directory, B); assert.equal(h.store.sourceState.sessionID, "other");
    assert.equal(selected(h.store, "other"), 20);
    f.setSync(async () => {}); await h.selectSession("still-unknown");
    assert.equal(h.store.sourceState.status, "waiting-metadata", "successful sync without ownership metadata is not an empty ledger");
  } finally { gate.resolve(); await f.dispose(); }
});

test("initial missing metadata registers immediately and binds only after trusted sync", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  await ledger(A, 11); await ledger(B, 22);
  const f = host(A), gate = deferred(); f.setSync(async () => gate.promise);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    assert.equal(f.slots.length, 1); assert.equal(h.store.sourceState.status, "waiting-metadata");
    assert.equal(h.store.sourceState.paths, undefined); assert.deepEqual(h.store.diskRecords, []);
    f.setSession("root", B); gate.resolve(); await h.settled();
    assert.equal(h.store.sourceState.status, "ready"); assert.equal(h.store.sourceState.directory, B);
    assert.equal(selected(h.store), 22, "launch A data was never used as a metadata fallback");
  } finally { gate.resolve(); await f.dispose(); }
});

test("absolute configuration stays fixed and relative sidecars follow the configured history directory", async (t) => {
  const base = await fixture(t), launch = join(base, "launch"), selectedRoot = join(base, "session"), fixed = join(base, "fixed");
  await fs.mkdir(launch); await fs.mkdir(selectedRoot);
  const options = { historyPath: join(fixed, "history.jsonl"), runsPath: join(fixed, "runs.jsonl"), totalsPath: join(fixed, "totals.json") };
  await ledger(selectedRoot, 42, "root", options);
  const f = host(launch); f.setSession("root", selectedRoot);
  try {
    const h = (await initializeTui(f.bridge.api, options))!;
    assert.deepEqual(h.store.sourceState.paths, { history: options.historyPath, runs: options.runsPath, totals: options.totalsPath });
    assert.equal(selected(h.store), 42); assert.equal(h.store.sourceState.directory, selectedRoot);
    const relative = { historyPath: "data/history.jsonl", runsPath: "activity/runs.jsonl", totalsPath: "usage/totals.json" };
    const paths = await ledger(selectedRoot, 51, "root", relative);
    const other = host(launch); other.setSession("root", selectedRoot);
    try {
      const r = (await initializeTui(other.bridge.api, relative))!;
      assert.deepEqual(r.store.sourceState.paths, paths); assert.equal(selected(r.store), 51);
    } finally { await other.dispose(); }
  } finally { await f.dispose(); }
});

test("late history/activity fd reads cannot publish or finalize across rapid route epochs", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B"), C = join(base, "C");
  await ledger(A, 11, "a"); const bPaths = await ledger(B, 22, "b"); await ledger(C, 33, "c");
  const f = host(A, "a"); f.setSession("a", A); f.setSession("b", B); f.setSession("c", C);
  const h = (await initializeTui(f.bridge.api, {}))!;
  const gate = deferred(), entered = deferred(); let held = 0;
  const handles: { mockRestore(): void }[] = [], open = fs.open;
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const file = await open(...args), path = String(args[0]);
    const hold = async () => { if (++held === 2) entered.resolve(); await gate.promise; };
    if (path === bPaths.history) {
      const readFile = file.readFile.bind(file);
      handles.push(spyOn(file, "readFile").mockImplementation(async (...args: any[]) => {
        const result = await (readFile as any)(...args); await hold(); return result;
      }));
    }
    if (path === bPaths.runs) {
      const read = file.read.bind(file); let paused = false;
      handles.push(spyOn(file, "read").mockImplementation(async (...args: any[]) => {
        const result = await (read as any)(...args);
        if (!paused) { paused = true; await hold(); } return result;
      }));
    }
    return file;
  });
  try {
    const stale = h.selectSession("b"); await entered.promise;
    const back = h.selectSession("a"), current = h.selectSession("c");
    assert.equal(h.store.sourceState.status, "loading"); assert.equal(h.store.sourceState.directory, C);
    assert.equal(h.store.completedMessageIDs.has("message-22"), false);
    gate.resolve(); await Promise.all([stale, back, current]);
    assert.equal(h.store.sourceState.directory, C); assert.equal(selected(h.store, "c"), 33);
    assert.equal(h.store.completedMessageIDs.has("message-22"), false, "old authoritative completion cannot revive/finalize a new source");
    assert.equal(h.store.sessionParents.has("b"), false);
    assert.ok(h.store.activityEvents.every((event) => event.sessionID === "c"));
    assert.equal(tuiActivityTimes(h.store, "c").directMilliseconds, 33);
  } finally { gate.resolve(); for (const handle of handles.reverse()) handle.mockRestore(); spy.mockRestore(); await f.dispose(); }
});

test("missing and unreadable sources expose state; browsing/disposal never writes or creates ledgers", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  const paths = await ledger(A, 11); await fs.mkdir(B);
  const before = await Promise.all(Object.values(paths).map(async (path) => [await fs.readFile(path, "utf8"), (await fs.stat(path)).mtimeMs]));
  const f = host(A); f.setSession("root", A); f.setSession("missing", B);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    await h.selectSession("missing");
    assert.equal(h.store.sourceState.status, "missing"); assert.equal(h.store.sourceState.missing?.length, 3);
    assert.deepEqual(await fs.readdir(B), []);
    await h.selectSession("root"); await f.dispose();
    await h.selectSession("missing"); await h.settled();
    assert.equal(h.store.disposed, true); assert.deepEqual(h.store.diskRecords, []);
    const after = await Promise.all(Object.values(paths).map(async (path) => [await fs.readFile(path, "utf8"), (await fs.stat(path)).mtimeMs]));
    assert.deepEqual(after, before); assert.deepEqual(await fs.readdir(B), []);
  } finally { await f.dispose(); }
  await fs.writeFile(paths.totals, "not-json");
  const broken = host(A); broken.setSession("root", A);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const h = (await initializeTui(broken.bridge.api, {}))!;
    assert.equal(h.store.sourceState.status, "error"); assert.ok(h.store.sourceState.errors?.totals);
  } finally { warning.mockRestore(); await broken.dispose(); }
});

test("disposal fences a pending source fd read and a pending metadata sync", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  const paths = await ledger(A, 11); const bPaths = await ledger(B, 22, "other");
  const f = host(A); f.setSession("root", A); f.setSession("other", B);
  const h = (await initializeTui(f.bridge.api, {}))!;
  const gate = deferred(), entered = deferred(), metadata = deferred();
  f.setSync(async () => metadata.promise);
  const handles: { mockRestore(): void }[] = [], open = fs.open;
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (String(args[0]) === bPaths.history) {
      const readFile = file.readFile.bind(file);
      handles.push(spyOn(file, "readFile").mockImplementation(async (...args: any[]) => {
        const value = await (readFile as any)(...args); entered.resolve(); await gate.promise; return value;
      }));
    }
    return file;
  });
  try {
    const pendingRead = h.selectSession("other"); await entered.promise;
    const pendingMetadata = h.selectSession("unknown");
    await f.dispose();
    f.setSession("unknown", A); metadata.resolve(); gate.resolve();
    await Promise.all([pendingRead, pendingMetadata]); await h.settled();
    assert.equal(h.store.disposed, true); assert.deepEqual(h.store.diskRecords, []);
    assert.equal(h.store.optimistic.size, 0); assert.equal(h.store.completedMessageIDs.size, 0);
    assert.deepEqual((await fs.readdir(join(A, ".tokpulse"))).sort(), ["history.jsonl", "runs.jsonl", "totals.json"]);
    assert.equal(JSON.parse(await fs.readFile(paths.totals, "utf8")).sessions.root.tokens.input, 11);
  } finally {
    gate.resolve(); metadata.resolve(); for (const handle of handles.reverse()) handle.mockRestore(); spy.mockRestore(); await f.dispose();
  }
});

test("initial missing ledgers remain unknown, valid empty files are loaded, and changing source resets knowledge", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B"), C = join(base, "C");
  await fs.mkdir(A); await fs.mkdir(C);
  const empty = await ledger(B, 11);
  await fs.writeFile(empty.history, ""); await fs.writeFile(empty.runs, "");
  await fs.writeFile(empty.totals, JSON.stringify({ version: 1, sessions: {}, open: {}, settled: {} }));
  const f = host(A); f.setSession("root", A); f.setSession("empty", B); f.setSession("missing", C);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    assert.equal(h.store.sourceState.status, "missing");
    assert.deepEqual(h.store.sourceState.loaded, { history: false, totals: false, runs: false });
    assert.equal(h.store.sourceState.missing?.length, 3);
    await h.selectSession("empty");
    assert.equal(h.store.sourceState.status, "ready");
    assert.deepEqual(h.store.sourceState.loaded, { history: true, totals: true, runs: true });
    assert.deepEqual(h.store.sourceState.missing, []); assert.deepEqual(h.store.sourceState.errors, {});
    assert.deepEqual(h.store.diskRecords, []); assert.deepEqual(h.store.activityEvents, []);
    assert.deepEqual(Object.keys(h.store.totalsLedger.sessions), []);
    await h.selectSession("missing");
    assert.equal(h.store.sourceState.status, "missing");
    assert.deepEqual(h.store.sourceState.loaded, { history: false, totals: false, runs: false });
    assert.deepEqual(h.store.diskRecords, []); assert.deepEqual(h.store.activityEvents, []);
  } finally { await f.dispose(); }
});

test("same-source EIO and missing results retain every known snapshot, and recovery clears current errors", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 11);
  const f = host(base); f.setSession("root", base);
  const h = (await initializeTui(f.bridge.api, {}))!;
  const disk = h.store.diskRecords, totals = h.store.totalsLedger, activity = h.store.activityEvents;
  const clock = tuiActivityTimes(h.store, "root"), open = fs.open;
  let failure: "EIO" | "ENOENT" | undefined;
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    if (failure && Object.values(paths).includes(String(args[0]))) {
      throw Object.assign(Error(`${failure}: injected safe-FD failure`), { code: failure });
    }
    return open(...args);
  });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const refresh = async () => {
    await Promise.all([reloadHistory(h.store, f.bridge.api, paths.history, paths.totals, 100),
      reloadActivity(h.store, f.bridge.api, paths.runs)]);
  };
  try {
    for (const code of ["EIO", "ENOENT"] as const) {
      failure = code; await refresh();
      assert.equal(h.store.diskRecords, disk); assert.equal(h.store.totalsLedger, totals);
      assert.equal(h.store.activityEvents, activity); assert.deepEqual(tuiActivityTimes(h.store, "root"), clock);
      assert.equal(selected(h.store), 11); assert.equal(h.store.totalsLedger.sessions.root.tokens.cacheRead, 99);
      assert.deepEqual(h.store.sourceState.loaded, { history: true, totals: true, runs: true });
      assert.equal(h.store.sourceState.status, code === "EIO" ? "error" : "missing");
      assert.equal(h.store.sourceState.missing?.length, code === "EIO" ? 0 : 3);
      assert.equal(Object.keys(h.store.sourceState.errors ?? {}).length, code === "EIO" ? 3 : 0,
        "new missing outcomes replace previous I/O errors without losing prior loaded knowledge");
    }
    failure = undefined; await refresh();
    assert.equal(h.store.sourceState.status, "ready");
    assert.deepEqual(h.store.sourceState.errors, {}); assert.deepEqual(h.store.sourceState.missing, []);
    assert.deepEqual(h.store.sourceState.loaded, { history: true, totals: true, runs: true });
    assert.equal(selected(h.store), 11); assert.equal(tuiActivityTimes(h.store, "root").directMilliseconds, 11);
  } finally { await f.dispose(); spy.mockRestore(); warning.mockRestore(); }
});

test("runs-only missing preserves available usage, and later loss retains a previously loaded clock", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 11);
  const f = host(base); f.setSession("root", base);
  const open = fs.open; let missing = true;
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    if (missing && String(args[0]) === paths.runs) throw Object.assign(Error("missing runs"), { code: "ENOENT" });
    return open(...args);
  });
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    assert.equal(h.store.sourceState.status, "missing");
    assert.deepEqual(h.store.sourceState.loaded, { history: true, totals: true, runs: false });
    assert.deepEqual(h.store.sourceState.missing, [paths.runs]);
    assert.equal(selected(h.store), 11); assert.equal(h.store.totalsLedger.sessions.root.tokens.cacheRead, 99);
    missing = false; assert.equal(await reloadActivity(h.store, f.bridge.api, paths.runs), true);
    assert.equal(h.store.sourceState.status, "ready"); assert.equal(h.store.sourceState.loaded?.runs, true);
    const clock = tuiActivityTimes(h.store, "root"), events = h.store.activityEvents;
    missing = true; assert.equal(await reloadActivity(h.store, f.bridge.api, paths.runs), false);
    assert.equal(h.store.sourceState.status, "missing"); assert.equal(h.store.sourceState.loaded?.runs, true);
    assert.equal(h.store.activityEvents, events); assert.deepEqual(tuiActivityTimes(h.store, "root"), clock);
    assert.equal(selected(h.store), 11);
  } finally { await f.dispose(); spy.mockRestore(); }
});

test("history and totals accept independent successes without masking the failed ledger", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 22);
  const f = host(base); f.setSession("root", base);
  const record = JSON.parse(await fs.readFile(paths.history, "utf8")) as HistoryRecord;
  record.messageID = "fresh-history"; record.tokens = { ...record.tokens, input: 99 };
  const open = fs.open, handles: { mockRestore(): void }[] = [];
  let failed: "history" | "totals" | undefined = "history", freshHistory = false;
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const path = String(args[0]);
    if ((failed === "history" && path === paths.history) || (failed === "totals" && path === paths.totals)) {
      throw Object.assign(Error(`EIO: ${failed}`), { code: "EIO" });
    }
    const file = await open(...args);
    if (freshHistory && path === paths.history) {
      handles.push(spyOn(file, "readFile").mockImplementation(async () => JSON.stringify(record) + "\n"));
    }
    return file;
  });
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    assert.deepEqual(h.store.sourceState.loaded, { history: false, totals: true, runs: true });
    assert.equal(h.store.sourceState.status, "error"); assert.ok(h.store.sourceState.errors?.history);
    assert.equal(selected(h.store), 22, "history EIO must not block readable cumulative totals");
    assert.equal(h.store.diskRecords.length, 0);
    failed = undefined; await reloadHistory(h.store, f.bridge.api, paths.history, paths.totals, 100);
    assert.equal(h.store.sourceState.status, "ready"); assert.deepEqual(h.store.sourceState.errors, {});
    const totals = h.store.totalsLedger;
    failed = "totals"; freshHistory = true;
    await reloadHistory(h.store, f.bridge.api, paths.history, paths.totals, 100);
    assert.equal(h.store.diskRecords[0].messageID, "fresh-history"); assert.equal(h.store.diskRecords[0].tokens.input, 99);
    assert.equal(h.store.totalsLedger, totals, "totals EIO retains its last known same-source snapshot");
    assert.deepEqual(h.store.sourceState.loaded, { history: true, totals: true, runs: true });
    assert.equal(h.store.sourceState.errors?.history, undefined); assert.ok(h.store.sourceState.errors?.totals);
    assert.equal(h.store.sourceState.status, "error");
    failed = undefined; freshHistory = false;
    await reloadHistory(h.store, f.bridge.api, paths.history, paths.totals, 100);
    assert.equal(h.store.sourceState.status, "ready"); assert.deepEqual(h.store.sourceState.errors, {});
  } finally { await f.dispose(); for (const handle of handles.reverse()) handle.mockRestore(); spy.mockRestore(); warning.mockRestore(); }
});

test("actual missing runs is not an empty reset, while a successfully opened empty file resets the known projection", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 11);
  const f = host(base), store = createRuntimeStore(100); f.setSession("root", base);
  store.sourceState = { ...store.sourceState, status: "loading", paths, directory: base };
  try {
    assert.equal(await reloadActivity(store, f.bridge.api, paths.runs), true);
    const events = store.activityEvents;
    assert.equal(tuiActivityTimes(store, "root").directMilliseconds, 11); assert.equal(store.sourceState.loaded?.runs, true);
    await fs.rm(paths.runs);
    assert.equal(await reloadActivity(store, f.bridge.api, paths.runs), false);
    assert.equal(store.activityEvents, events); assert.equal(store.sourceState.loaded?.runs, true);
    assert.equal(tuiActivityTimes(store, "root").directMilliseconds, 11); assert.equal(store.sourceState.status, "missing");
    await fs.writeFile(paths.runs, "");
    assert.equal(await reloadActivity(store, f.bridge.api, paths.runs), true);
    assert.deepEqual(store.activityEvents, []); assert.equal(store.sourceState.loaded?.runs, true);
    assert.equal(tuiActivityTimes(store, "root").directMilliseconds, 0);
    assert.deepEqual(store.sourceState.missing, []); assert.deepEqual(store.sourceState.errors, {});
  } finally { store.disposed = true; tuiReadModel(store).dispose(); store.disposeSignals(); await f.dispose(); }
});
