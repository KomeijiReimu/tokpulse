import type { Route, SlotClaim } from "@opencode/plugin/tui/context";
import * as tuiSolid from "@opentui/solid";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { normalizeActivityEvent } from "../src/activity.js";
import { formatDuration, type HistoryRecord } from "../src/core.js";
import { createTotalsStorage } from "../src/totals-storage.js";
import { parentProofPort, tuiReadModel, type ParentProofPort } from "../src/tui-read-model.js";
import { sessionSourcePaths } from "../src/tui-source.js";
import { createV2TuiBridge, type V2TuiContext } from "../src/tui-v2.js";
import { buildSessionDetailsTree, createRuntimeStore, initializeTui, reloadActivity,
  reloadHistory, taskWallTimeForSession, tuiActivityTimes, hasLiveTaskWallActivity, sourceStatusLabel } from "../src/tui.js";
const { spyOn } = require("bun:test");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 1500;
  while (!predicate() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
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

async function moveLedger(directory: string, value: number, sid: string, start: number, parentSessionID?: string) {
  const paths = await ledger(directory, value, sid);
  const record = JSON.parse(await fs.readFile(paths.history, "utf8")) as HistoryRecord;
  record.time = { start, completed: start + value, duration: value };
  if (parentSessionID) record.parentSessionID = parentSessionID;
  await fs.writeFile(paths.history, JSON.stringify(record) + "\n");
  await fs.rm(paths.totals);
  await createTotalsStorage(paths.totals).apply(record);
  const events = (await fs.readFile(paths.runs, "utf8")).trim().split("\n").map((line) => {
    const fact = JSON.parse(line);
    return { ...fact, timestamp: fact.timestamp + start - 100, observedAt: fact.observedAt + start - 100,
      ...(parentSessionID ? { parentSessionID } : {}) };
  });
  await fs.writeFile(paths.runs, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return { paths, record };
}

function host(directory: string, initial = "root") {
  let send!: (event: { details: any }) => void;
  let stopEffects = () => {};
  let sync = async (_id: string) => {};
  const sessions = new Map<string, { id: string; parentID?: string; location: { directory: string; worktree?: string } }>();
  let messages = async (_input: any): Promise<any> => ({ data: [], cursor: {} });
  let children = async (input: any): Promise<any> => ({ data: [...sessions.values()].filter((session) => session.parentID === input.parentID), cursor: {} });
  const slots: SlotClaim[] = [];
  const state = createRoot((dispose) => {
    stopEffects = dispose;
    const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: initial });
    const [revision, setRevision] = createSignal(0);
    return { route, setRoute, revision, changed: () => setRevision((value) => value + 1) };
  });
  const context = {
    options: {}, location: { directory }, theme: {}, renderer: { width: 100, height: 40 },
    client: { message: { list: (input: any) => messages(input) }, session: { list: (input: any) => children(input) } },
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
    setMessages(fn: typeof messages) { messages = fn; },
    setChildren(fn: typeof children) { children = fn; },
    send(type: string, data: Record<string, unknown>, root?: string, created = Date.now()) {
      send({ details: { type, data, id: `event-${Math.random()}`, created,
        ...(root === undefined ? {} : { location: { directory: root } }) } });
    },
    async dispose() { await bridge.dispose(); stopEffects(); },
  };
}

function selected(store: NonNullable<Awaited<ReturnType<typeof initializeTui>>>["store"], sid = "root") {
  return buildSessionDetailsTree(store, sid).nodes.find((node) => node.sessionID === sid)?.direct.tokens.input;
}

test("actual initialize/bridge binds unrelated SIDs independently of launch directory, A -> B -> A", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  await ledger(A, 11); await ledger(B, 22, "other");
  for (const launch of [A, B]) {
    const f = host(launch); f.setSession("root", A);
    try {
      const h = (await initializeTui(f.bridge.api, {}))!;
      assert.equal(f.slots[0].append, "sidebar.content", "production slot registration is exercised");
      for (const [directory, value, sid] of [[A, 11, "root"], [B, 22, "other"], [A, 11, "root"]] as const) {
        f.setSession(sid, directory); await h.selectSession(sid);
        assert.equal(h.store.sourceState.directory, directory);
        assert.equal(h.store.sourceState.status, "ready");
        assert.equal(h.store.sourceState.paths?.history, join(directory, ".tokpulse/history.jsonl"));
        assert.equal(selected(h.store, sid), value);
        assert.equal(h.store.diskRecords[0].messageID, `message-${value}`);
        assert.equal(tuiActivityTimes(h.store, sid).directMilliseconds, value);
        const before = h.store.optimistic.size;
        f.send("session.step.ended", { sessionID: sid, assistantMessageID: `foreign-${value}`,
          tokens: { input: 999, output: 999 }, cost: 0, finish: "stop" }, directory === A ? B : A);
        assert.equal(h.store.optimistic.size, before, "foreign-directory live events cannot enter this source");
        f.send("session.step.ended", { sessionID: sid, assistantMessageID: `local-${value}`,
          tokens: { input: 1, output: 1 }, cost: 0, finish: "stop" }, directory);
        assert.ok(h.store.optimistic.has(`local-${value}`), "proof directory follows selected source, not plugin ctx.location");
      }
    } finally { await f.dispose(); }
  }
});

test("reopening a moved session keeps the newest history when the old source fills the window", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B");
  const a = await ledger(A, 1), b = await ledger(B, 7);
  const sample = JSON.parse(await fs.readFile(a.history, "utf8")) as HistoryRecord;
  const old = Array.from({ length: 1000 }, (_, index): HistoryRecord => ({ ...sample,
    messageID: `old-${index}`, time: { start: 1000 + index, completed: 1000 + index, duration: 0 } }));
  const latest: HistoryRecord = { ...sample, messageID: "latest-B", tokens: { ...sample.tokens, input: 7 },
    time: { start: 4000, completed: 4010, duration: 10 } };
  await fs.writeFile(a.history, old.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await fs.writeFile(b.history, JSON.stringify(latest) + "\n");
  for (const paths of [a, b]) await fs.writeFile(paths.totals, JSON.stringify({ version: 1,
    generationBasisVersion: 3, sessions: {}, open: {}, settled: {} }));
  const f = host(B); f.setSession("root", B);
  f.setMessages(async () => ({ data: [{ type: "location-switched", location: { directory: B },
    previous: { location: { directory: A } } }], cursor: {} }));
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    assert.equal(h.store.diskRecords.length, 1000);
    assert.equal(h.store.diskRecords[0].messageID, "old-1");
    assert.equal(h.store.diskRecords.at(-1)?.messageID, "latest-B");
    assert.ok(h.store.records.some((record) => record.messageID === "latest-B"));
    assert.equal(selected(h.store), 1006, "the retained history window includes 999 old inputs plus the latest 7");
  } finally { await f.dispose(); }
});

test("native paged move history keeps A -> B -> A and reopened usage/time continuous without double counting", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B"), unrelated = join(base, "unrelated");
  const a = await moveLedger(A, 11, "root", 100), b = await moveLedger(B, 22, "root", 200);
  await ledger(unrelated, 99, "other");
  // A physical source can contain a copy of an already completed response and
  // its lifecycle controls. The union must remove both duplicates, not sum them.
  await createTotalsStorage(b.paths.totals).apply(a.record);
  await fs.appendFile(b.paths.history, await fs.readFile(a.paths.history));
  await fs.appendFile(b.paths.runs, await fs.readFile(a.paths.runs));
  const moves: { type: string; location: { directory: string }; previous: { location: { directory: string } } }[] = [];
  let pages = 0;
  const history = async (input: any) => {
    assert.equal(input.sessionID, "root"); assert.equal(input.type, "location-switched");
    assert.equal(input.order, "asc"); assert.equal(input.limit, 100);
    pages++;
    const index = input.cursor === undefined ? 0 : Number(input.cursor);
    assert.ok(Number.isInteger(index));
    return { data: moves.slice(index, index + 1), cursor: index + 1 < moves.length ? { next: String(index + 1) } : {} };
  };
  const f = host(A); f.setSession("root", A); f.setMessages(history);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!, epoch = h.store.sourceEpoch;
    assert.equal(selected(h.store), 11);
    for (const [previous, directory] of [[A, B], [B, A]]) {
      moves.push({ type: "location-switched", location: { directory }, previous: { location: { directory: previous } } });
      f.setSession("root", directory);
      f.send("session.moved", { sessionID: "root" }, previous);
      assert.ok(selected(h.store)! >= 11, "same-SID moves do not flash a cleared baseline");
      await h.settled();
      assert.equal(h.store.sourceEpoch, epoch);
      assert.equal(h.store.sourceState.status, "ready"); assert.equal(h.store.sourceState.directory, directory);
      assert.equal(selected(h.store), 33);
      assert.equal(h.store.totalsLedger.sessions.root.tokens.cacheRead, 297);
      assert.equal(h.store.totalsLedger.sessions.root.tokens.output, 33);
      assert.equal(h.store.diskRecords.length, 2);
      assert.equal(tuiActivityTimes(h.store, "root").directMilliseconds, 33, "move gaps are not bridged");
    }
    const resumed: HistoryRecord = { ...a.record, messageID: "resumed-A",
      tokens: { ...a.record.tokens, input: 33, output: 33, cacheRead: 297 }, time: { start: 300, completed: 333, duration: 33 } };
    await createTotalsStorage(a.paths.totals).apply(resumed);
    await fs.appendFile(a.paths.history, JSON.stringify(resumed) + "\n");
    await fs.appendFile(a.paths.runs, (["busy", "idle"] as const).map((state) => JSON.stringify(normalizeActivityEvent({
      version: 2, kind: "lifecycle", eventID: `resumed-${state}`, instanceID: "resumed-instance-A", executionID: "resumed-execution-A",
      sessionID: "root", state, timestamp: state === "busy" ? 300 : 333, observedAt: state === "busy" ? 300 : 333,
    }))).join("\n") + "\n");
    await eventually(() => selected(h.store) === 66 && tuiActivityTimes(h.store, "root").directMilliseconds === 66,
      "after moving back, the existing source watcher appends new usage and canonical facts");
    const before = h.store.optimistic.size;
    f.send("session.step.ended", { sessionID: "root", assistantMessageID: "foreign", tokens: { input: 999, output: 999 }, finish: "stop" }, B);
    assert.equal(h.store.optimistic.size, before, "historical sources do not gain foreign live ownership");
  } finally { await f.dispose(); }
  const sameDirectoryRecord: HistoryRecord = { ...a.record, sessionID: "same-A", messageID: "same-A-response",
    tokens: { ...a.record.tokens, input: 7, output: 7, cacheRead: 63 } };
  await createTotalsStorage(a.paths.totals).apply(sameDirectoryRecord);
  await fs.appendFile(a.paths.history, JSON.stringify(sameDirectoryRecord) + "\n");
  const files = [...Object.values(a.paths), ...Object.values(b.paths)];
  const before = await Promise.all(files.map(async (path) => [await fs.readFile(path, "utf8"), (await fs.stat(path)).mtimeMs]));
  const reopened = host(B); reopened.setSession("root", A); reopened.setSession("other", unrelated); reopened.setMessages(history);
  try {
    const h = (await initializeTui(reopened.bridge.api, {}))!;
    assert.equal(selected(h.store), 66); assert.equal(tuiActivityTimes(h.store, "root").directMilliseconds, 66);
    assert.ok(pages >= 5, "the second native move page is requested with its cursor and filter intact");
    const epoch = h.store.sourceEpoch;
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      reopened.send("session.execution.started", { sessionID: "root" }, A, now);
      reopened.send("session.step.started", { sessionID: "root", assistantMessageID: "live-A", agent: "build", started: now }, A, now);
      now += 5;
      reopened.send("session.step.ended", { sessionID: "root", assistantMessageID: "live-A",
        tokens: { input: 1, output: 1, cacheRead: 9 }, cost: 0, finish: "stop" }, A, now);
      now += 5;
      assert.ok(tuiActivityTimes(h.store, "root", now).directMilliseconds >= 76);
      moves.push({ type: "location-switched", location: { directory: B }, previous: { location: { directory: A } } });
      reopened.setSession("root", B); reopened.send("session.moved", { sessionID: "root" }, A, now);
      await h.settled();
      assert.equal(h.store.sourceEpoch, epoch); assert.equal(h.store.totalsLedger.sessions.root.tokens.input, 66);
      assert.ok(tuiActivityTimes(h.store, "root", now).directMilliseconds >= 66, "moving during execution retains the historical clock");
      now += 10;
      reopened.send("session.step.started", { sessionID: "root", assistantMessageID: "continued-B-live", agent: "build", started: now }, B, now);
      const resumed = tuiActivityTimes(h.store, "root", now);
      now += 20;
      const growing = tuiActivityTimes(h.store, "root", now);
      assert.equal(growing.active, true); assert.equal(growing.directMilliseconds, resumed.directMilliseconds + 20);
      assert.ok(growing.directMilliseconds >= 86); assert.equal(h.store.sourceEpoch, epoch);
      reopened.send("session.step.ended", { sessionID: "root", assistantMessageID: "continued-B-live",
        tokens: { input: 2, output: 2, cacheRead: 18 }, cost: 0, finish: "stop" }, B, now);
      reopened.send("session.execution.succeeded", { sessionID: "root" }, B, now);
      const completed = tuiActivityTimes(h.store, "root", now);
      assert.equal(completed.active, false); assert.ok(completed.directMilliseconds >= 86);
      now += 100;
      assert.equal(tuiActivityTimes(h.store, "root", now).directMilliseconds, completed.directMilliseconds);
      moves.push({ type: "location-switched", location: { directory: A }, previous: { location: { directory: B } } });
      reopened.setSession("root", A); reopened.send("session.moved", { sessionID: "root" }, B, now);
      await h.settled();
    } finally { clock.mockRestore(); }
    reopened.setSession("same-A", A);
    reopened.setMessages(async () => ({ data: [], cursor: {} }));
    const open = fs.open, foreignReads: string[] = [];
    const missing = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      if (Object.values(b.paths).includes(String(args[0]))) {
        foreignReads.push(String(args[0])); throw Object.assign(Error("old moved source is missing"), { code: "ENOENT" });
      }
      return open(...args);
    });
    try {
      await h.selectSession("same-A");
      assert.equal(selected(h.store, "same-A"), 7); assert.equal(h.store.sourceState.status, "ready");
      assert.deepEqual(h.store.sourceState.missing, []); assert.deepEqual(h.store.sourceState.errors, {});
      assert.deepEqual(foreignReads, [], "an unrelated SID in A neither reads nor inherits failures from B");
      let fail = true, attempts = 0;
      reopened.setMessages(async () => { attempts++; if (fail) throw Error("native move lookup failed"); return { data: [], cursor: {} }; });
      reopened.send("session.moved", { sessionID: "same-A" }, A);
      await h.settled();
      assert.equal(h.store.sourceState.status, "error"); assert.match(h.store.sourceState.errors?.metadata ?? "", /native move lookup failed/);
      assert.equal(selected(h.store, "same-A"), 7);
      fail = false; await h.selectSession("same-A");
      assert.equal(attempts, 2); assert.equal(h.store.sourceState.status, "ready"); assert.equal(selected(h.store, "same-A"), 7);
      assert.deepEqual(foreignReads, []);
    } finally { missing.mockRestore(); }
    await h.selectSession("other"); assert.equal(selected(h.store, "other"), 99);
    assert.ok(h.store.activityEvents.every((fact) => fact.sessionID === "other"));
  } finally { await reopened.dispose(); }
  assert.deepEqual(await Promise.all(files.map(async (path) => [await fs.readFile(path, "utf8"), (await fs.stat(path)).mtimeMs])), before,
    "browsing and disposal only read every historical source");
});

test("native descendants discover a child's independent move even without a local root parent ledger", async (t) => {
  const base = await fixture(t), A = join(base, "A"), B = join(base, "B"), C = join(base, "C");
  await moveLedger(A, 11, "root", 100);
  await moveLedger(B, 22, "child", 200, "root");
  await moveLedger(C, 33, "child", 300, "root");
  const f = host(A); f.setSession("root", A);
  f.sessions.set("child", { id: "child", parentID: "root", location: { directory: B } });
  f.sessions.set("grandchild", { id: "grandchild", parentID: "child", location: { directory: B } });
  const queried = new Set<string>();
  let moved = false;
  f.setMessages(async (input) => {
    queried.add(input.sessionID);
    assert.equal(input.type, "location-switched");
    return { data: input.sessionID === "child" && moved ? [{ type: "location-switched", location: { directory: C },
      previous: { location: { directory: B } } }] : [], cursor: {} };
  });
  try {
    const h = (await initializeTui(f.bridge.api, {}))!, epoch = h.store.sourceEpoch;
    assert.deepEqual([...queried].sort(), ["child", "grandchild", "root"]);
    let root = buildSessionDetailsTree(h.store, "root");
    assert.equal(root.including.tokens.input, 33); assert.equal(tuiActivityTimes(h.store, "root").includingMilliseconds, 33);
    moved = true; f.sessions.set("child", { id: "child", parentID: "root", location: { directory: C } });
    f.send("session.moved", { sessionID: "child" }, C);
    await h.settled();
    root = buildSessionDetailsTree(h.store, "root");
    assert.equal(h.store.sourceEpoch, epoch); assert.equal(h.store.sourceState.directory, A);
    assert.equal(root.nodes[0].direct.tokens.input, 11); assert.equal(root.including.tokens.input, 66);
    assert.equal(root.including.tokens.cacheRead, 594); assert.equal(root.including.tokens.output, 66);
    assert.equal(tuiActivityTimes(h.store, "root").includingMilliseconds, 66);
    assert.equal(tuiActivityTimes(h.store, "child").directMilliseconds, 55);
  } finally { await f.dispose(); }
});

test("selected root observes only its native cross-directory child's live clock and follows its move", async (t) => {
  // The real sidebar uses Solid's reactive browser export, not the inert node memo.
  if (process.env.TOKPULSE_BROWSER_CHILD_LIVE_TEST !== "1") {
    const child = spawnSync(process.execPath, ["--conditions=browser", "test", import.meta.filename,
      "--test-name-pattern", "selected root observes only"], {
      env: { ...process.env, TOKPULSE_BROWSER_CHILD_LIVE_TEST: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr); return;
  }
  const base = await fixture(t), B = join(base, "B"), C = join(base, "C"), D = join(base, "D");
  await moveLedger(B, 11, "root", 100);
  const child = await moveLedger(C, 22, "child", 200, "root");
  await moveLedger(D, 0, "child", 300, "root");
  const originalRuns = await fs.readFile(child.paths.runs, "utf8");
  const f = host(B); f.setSession("root", B);
  f.sessions.set("child", { id: "child", parentID: "root", location: { directory: C } });
  f.setSession("unrelated", C);
  const lifecycle: any[] = [];
  for (const type of ["session.status", "session.completed"] as const) {
    f.bridge.api.event.on(type as any, (event: unknown) => { lifecycle.push(event); });
  }
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    const start = Date.now(); let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let stopClockView = () => {};
    try {
      const before = tuiActivityTimes(h.store, "root", now).includingMilliseconds;
      f.send("session.execution.started", { sessionID: "child" }, undefined, now);
      f.send("session.step.started", { sessionID: "child", assistantMessageID: "child-live",
        agent: "build", started: now }, C, now);
      await eventually(() => hasLiveTaskWallActivity(h.store), "native child in C must wake root B's live clock");
      assert.equal(lifecycle[0].sourceDirectory, C, "child events retain their actual source, never root B's label");
      const taskTimeLabel = createRoot((dispose) => {
        stopClockView = dispose;
        // Isolate the sidebar's clock dependency: ledger revisions cannot fake
        // a ticker refresh. Use the production formatter and default live now.
        return createMemo(() => { h.store.clockRevision();
          return formatDuration(taskWallTimeForSession(h.store, "root")!); });
      });
      assert.equal(taskTimeLabel(), formatDuration(before));
      now += 10_000;
      await eventually(() => taskTimeLabel() === formatDuration(before + 10_000),
        "the real 500ms ticker must refresh the displayed child-inclusive task time");
      assert.equal(tuiActivityTimes(h.store, "root", now).includingMilliseconds, before + 10_000);
      assert.equal(tuiActivityTimes(h.store, "child", now).directMilliseconds, 22 + 10_000);
      f.send("session.execution.started", { sessionID: "unrelated" }, undefined, now);
      f.send("session.execution.started", { sessionID: "unrelated" }, C, now);
      assert.equal(tuiActivityTimes(h.store, "unrelated", now).active, false);
      f.sessions.set("child", { id: "child", parentID: "root", location: { directory: D } });
      f.send("session.moved", { sessionID: "child" }, D, now);
      await h.settled();
      f.send("session.execution.succeeded", { sessionID: "child" }, C, now);
      assert.equal(hasLiveTaskWallActivity(h.store), true, "late terminal from previous directory has no ownership");
      f.send("session.step.started", { sessionID: "child", assistantMessageID: "child-moved",
        agent: "build", started: now }, D, now);
      f.send("session.execution.succeeded", { sessionID: "child" }, D, now);
      assert.equal(hasLiveTaskWallActivity(h.store), false);
      const ended = tuiActivityTimes(h.store, "root", now);
      assert.equal(ended.includingMilliseconds, before + 10_000);
      const closed = ["busy", "idle"].map((state, index) => normalizeActivityEvent({
        version: 2, kind: "lifecycle", eventID: `child-canonical-${state}`, instanceID: "child-server",
        sessionID: "child", parentSessionID: "root", executionID: lifecycle[0].executionID,
        sourceEventID: lifecycle[index].sourceEventID, state, timestamp: start + index * 10_000,
        observedAt: start + index * 10_000,
      })!);
      const movedPaths = sessionSourcePaths(D, {});
      await fs.appendFile(movedPaths.runs, closed.map((fact) => JSON.stringify(fact)).join("\n") + "\n");
      await eventually(() => h.store.activityEvents.some((fact) => fact.eventID === "child-canonical-idle"),
        "native watcher must load the closed child ledger");
      now += 10_000;
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.equal(taskTimeLabel(), formatDuration(ended.includingMilliseconds), "closed display must not accrue another ticker interval");
      assert.equal(taskWallTimeForSession(h.store, "root"), ended.includingMilliseconds);
      assert.deepEqual(tuiActivityTimes(h.store, "root", now), ended, "terminal clock stays closed");
      assert.equal(tuiActivityTimes(h.store, "unrelated", now).active, false, "unlocated unrelated events cannot acquire family ownership later");
      assert.equal(await fs.readFile(child.paths.runs, "utf8"), originalRuns, "live observation never rewrites C's ledger");
    } finally { stopClockView(); clock.mockRestore(); }
  } finally { await f.dispose(); }
});

test("missing historical native child preserves known usage without aborting other family discovery", async (t) => {
  const base = await fixture(t), B = join(base, "B"), C = join(base, "C");
  const root = await moveLedger(B, 11, "root", 100);
  const old = await moveLedger(join(base, "old"), 22, "old", 200, "root");
  await fs.appendFile(root.paths.history, await fs.readFile(old.paths.history));
  await createTotalsStorage(root.paths.totals).apply(old.record);
  await fs.appendFile(root.paths.runs, await fs.readFile(old.paths.runs));
  await moveLedger(C, 33, "child", 300, "root");
  const f = host(B); f.setSession("root", B);
  f.sessions.set("child", { id: "child", parentID: "root", location: { directory: C } });
  const missing = (id: string) => Object.assign(new Error(`Session ${id} not found`), {
    name: "SessionNotFoundError", _tag: "SessionNotFoundError", sessionID: id,
  });
  const queries: string[] = [];
  let failure: { id: string; error: Error } | undefined;
  f.setMessages(async (input) => {
    queries.push(input.sessionID);
    if (input.sessionID === "old") throw missing("old");
    if (failure && failure.id === input.sessionID) throw failure.error;
    return { data: [], cursor: {} };
  });
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    assert.equal(h.store.sourceState.status, "partial");
    assert.deepEqual(h.store.sourceState.loaded, { history: true, totals: true, runs: true });
    assert.deepEqual(h.store.sourceState.unavailableSessions, ["old"]);
    assert.deepEqual(h.store.sourceState.errors, {});
    assert.equal(sourceStatusLabel(h.store), "Historical session metadata unavailable (1) · showing known ledger data");
    assert.ok(queries.includes("child"), "the missing historical SID must not abort the remaining native child query");
    assert.equal(buildSessionDetailsTree(h.store, "root").including.tokens.input, 66);
    assert.equal(selected(h.store, "old"), 22);
    assert.equal(tuiActivityTimes(h.store, "root").includingMilliseconds, 66);
    f.send("session.moved", { sessionID: "child" }, C); await h.settled();
    assert.equal(queries.filter((id) => id === "old").length, 1, "known absent history is not retried each discovery round");
    failure = { id: "child", error: Object.assign(new Error("Forbidden HTTP404"), { _tag: "ForbiddenError", sessionID: "child" }) };
    f.send("session.moved", { sessionID: "child" }, C); await h.settled();
    assert.equal(h.store.sourceState.status, "error");
    assert.equal(h.store.sourceState.errors?.metadata, "Forbidden HTTP404", "neither other tags nor message substrings mean a missing session");
    failure = { id: "child", error: missing("unrelated") };
    f.send("session.moved", { sessionID: "child" }, C); await h.settled();
    assert.equal(h.store.sourceState.status, "error", "the declared missing SID must match the queried family member");
    assert.deepEqual(h.store.sourceState.unavailableSessions, ["old"]);
    failure = undefined;
    f.send("session.moved", { sessionID: "child" }, C); await h.settled();
    assert.equal(h.store.sourceState.status, "partial");
    assert.equal(h.store.sourceState.errors?.metadata, undefined);
    failure = { id: "root", error: missing("root") };
    f.send("session.moved", { sessionID: "root" }, B); await h.settled();
    assert.equal(h.store.sourceState.status, "error", "selected-root absence remains fatal to discovery");
    assert.equal(h.store.sourceState.errors?.metadata, "Session root not found");
    assert.equal(sourceStatusLabel(h.store), "Unable to read: session metadata");
    assert.equal(buildSessionDetailsTree(h.store, "root").including.tokens.input, 66);
  } finally { await f.dispose(); }
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
    await ledger(A, 33, "third");
    f.setSession("third", A); f.setRoute("third"); await Promise.resolve(); await h.settled();
    assert.equal(h.store.sourceState.directory, A); assert.equal(selected(h.store, "third"), 33);
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

test("read-only totals reject a symlink without losing known usage, then accept an atomic replacement", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 11), outside = join(base, "outside.json");
  const f = host(base); f.setSession("root", base);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const h = (await initializeTui(f.bridge.api, {}))!, known = h.store.totalsLedger;
    const bytes = JSON.stringify({ ...known, sessions: { root: { ...known.sessions.root,
      tokens: { ...known.sessions.root.tokens, input: 999 } } } });
    await fs.writeFile(outside, bytes); await fs.rm(paths.totals); await fs.symlink(outside, paths.totals);
    await reloadHistory(h.store, f.bridge.api, paths.history, paths.totals, 100);
    assert.equal(h.store.sourceState.status, "error"); assert.ok(h.store.sourceState.errors?.totals);
    assert.equal(h.store.totalsLedger, known); assert.equal(selected(h.store), 11);
    assert.equal(await fs.readFile(outside, "utf8"), bytes); assert.equal((await fs.lstat(paths.totals)).isSymbolicLink(), true);
    await fs.rm(paths.totals);
    const replacement = join(base, "replacement");
    await fs.writeFile(replacement, JSON.stringify({ ...known, sessions: { root: { ...known.sessions.root,
      tokens: { ...known.sessions.root.tokens, input: 22 } } } }));
    await fs.rename(replacement, paths.totals);
    await reloadHistory(h.store, f.bridge.api, paths.history, paths.totals, 100);
    await eventually(() => selected(h.store) === 22 && h.store.sourceState.status === "ready",
      "actual atomic replacement must survive watcher generation invalidation");
    assert.equal(selected(h.store), 22); assert.equal(h.store.sourceState.status, "ready");
    assert.equal(await fs.readFile(outside, "utf8"), bytes);
  } finally { await f.dispose(); warning.mockRestore(); }
});

test("fresh parent ownership follows canonical corrections; replay cannot restore a cleared edge", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 11, "child");
  const parent = (parentSessionID: string | null, instanceID: string, seq: number, eventID: string) => normalizeActivityEvent({
    version: 2, kind: "parent", sessionID: "child", parentSessionID, instanceID, seq, eventID,
    timestamp: seq, observedAt: seq,
  })!;
  const a = parent("A", "old-collector", 1000, "old-parent"), b = parent("B", "new-collector", 1, "new-parent");
  const runs = await fs.readFile(paths.runs, "utf8");
  await fs.writeFile(paths.runs, JSON.stringify(a) + "\n" + runs);
  const f = host(base); f.setSession("root", base);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    assert.equal(buildSessionDetailsTree(h.store, "A").including.tokens.input, 11);
    assert.equal(taskWallTimeForSession(h.store, "A", 10000), 11);
    // Unlike the old standalone projector probe, the real bridge requires
    // fresh ownership when canonical evidence crosses observation domains.
    f.sessions.set("child", { id: "child", parentID: "B", location: { directory: base } });
    await fs.appendFile(paths.runs, JSON.stringify(b) + "\n"); await reloadActivity(h.store, f.bridge.api, paths.runs);
    await eventually(() => buildSessionDetailsTree(h.store, "B").including.tokens.input === 11,
      "actual watcher/proof hydration must confirm B ownership");
    assert.equal(h.store.sessionParents.get("child"), "B", "fresh ownership confirms the new collector despite its lower sequence/timestamp");
    assert.equal(buildSessionDetailsTree(h.store, "A").including.responseCount, 0);
    assert.equal(buildSessionDetailsTree(h.store, "B").including.tokens.input, 11);
    assert.equal(taskWallTimeForSession(h.store, "B", 10000), 11);
    const root = { ...b, parentSessionID: null };
    f.sessions.set("child", { id: "child", location: { directory: base } });
    await fs.appendFile(paths.runs, [root, b, a].map((fact) => JSON.stringify(fact)).join("\n") + "\n");
    await reloadActivity(h.store, f.bridge.api, paths.runs);
    await eventually(() => h.store.sessionParents.get("child") === null, "actual ownership must confirm the explicit root");
    assert.equal(h.store.sessionParents.get("child"), null);
    assert.equal(buildSessionDetailsTree(h.store, "B").including.responseCount, 0);
    assert.equal(selected(h.store, "child"), 11); assert.equal(taskWallTimeForSession(h.store, "child", 10000), 11);
    const restarted = host(base); restarted.setSession("root", base);
    try {
      const fresh = (await initializeTui(restarted.bridge.api, {}))!;
      assert.equal(fresh.store.sessionParents.get("child"), null);
      assert.equal(selected(fresh.store, "child"), 11); assert.equal(taskWallTimeForSession(fresh.store, "child", 10000), 11);
    } finally { await restarted.dispose(); }
  } finally { await f.dispose(); }
});

test("partial activity appends do not invent time and an atomic replacement leaves one frozen clock", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 11);
  const f = host(base), store = createRuntimeStore(100); f.setSession("root", base);
  const fact = (state: "busy" | "idle", timestamp: number, seq: number) => normalizeActivityEvent({
    version: 2, kind: "lifecycle", sessionID: "root", state, timestamp, observedAt: timestamp,
    instanceID: "collector", seq, eventID: `fact-${seq}`, executionID: `epoch-${Math.floor((seq - 1) / 2)}`,
  })!;
  try {
    await reloadActivity(store, f.bridge.api, paths.runs);
    const next = [fact("busy", 200, 1), fact("idle", 220, 2)].map((value) => JSON.stringify(value)).join("\n") + "\n";
    await fs.appendFile(paths.runs, next.slice(0, 30)); await reloadActivity(store, f.bridge.api, paths.runs);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 11);
    await fs.appendFile(paths.runs, next.slice(30)); await reloadActivity(store, f.bridge.api, paths.runs);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 31);
    await fs.appendFile(paths.runs, next); await reloadActivity(store, f.bridge.api, paths.runs);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 31, "replayed committed bytes are not a second task interval");
    const replacement = join(base, "replacement");
    await fs.writeFile(replacement, [fact("busy", 1000, 3), fact("idle", 1040, 4)].map((value) => JSON.stringify(value)).join("\n") + "\n");
    await fs.rename(replacement, paths.runs); await reloadActivity(store, f.bridge.api, paths.runs);
    assert.equal(taskWallTimeForSession(store, "root", 2000), 40);
    assert.equal(taskWallTimeForSession(store, "root", 3600000), 40);
    assert.equal(await reloadActivity(store, f.bridge.api, paths.runs), true);
    assert.equal(taskWallTimeForSession(store, "root", 3600000), 40);
  } finally { store.disposed = true; tuiReadModel(store).dispose(); store.disposeSignals(); await f.dispose(); }
});

test("historical clock domains and canonical replacement cannot shorten the current live or closed task", async (t) => {
  const base = await fixture(t), paths = await ledger(base, 11), now = Date.now();
  const fact = (sessionID: string, timestamp: number, state: "busy" | "idle", seq: number) => normalizeActivityEvent({
    version: 2, kind: "lifecycle", sessionID, state, timestamp, observedAt: timestamp, seq,
    instanceID: "old-backend", executionID: `old-${sessionID}`, eventID: `old-${seq}`,
  })!;
  const bytes = [fact("root", now + 100000, "busy", 1), fact("root", now + 100100, "idle", 2),
    fact("unrelated", now + 200000, "busy", 3), fact("unrelated", now + 200100, "idle", 4)]
    .map((value) => JSON.stringify(value)).join("\n") + "\n";
  await fs.writeFile(paths.runs, bytes);
  const f = host(base); f.setSession("root", base);
  try {
    const h = (await initializeTui(f.bridge.api, {}))!;
    const liveStart = Date.now();
    f.send("session.execution.started", { sessionID: "root" }, base, liveStart);
    assert.equal(taskWallTimeForSession(h.store, "root", liveStart + 1000), 1100);
    const replacement = join(base, "replacement"); await fs.writeFile(replacement, bytes); await fs.rename(replacement, paths.runs);
    let accepted = false;
    for (let retry = 0; retry < 5 && !accepted; retry++) accepted = await reloadActivity(h.store, f.bridge.api, paths.runs);
    assert.equal(accepted, true, "the actual replacement must be applied, not bypassed by a stale generation");
    assert.equal(taskWallTimeForSession(h.store, "root", liveStart + 1000), 1100);
    assert.equal(taskWallTimeForSession(h.store, "unrelated", liveStart + 1000), 100);
    f.send("session.execution.succeeded", { sessionID: "root" }, base, liveStart + 1500);
    assert.equal(taskWallTimeForSession(h.store, "root", liveStart + 2000), 1600);
    assert.equal(taskWallTimeForSession(h.store, "root", liveStart + 3600000), 1600);
  } finally { await f.dispose(); }
});
