import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createRuntimeStore, reloadActivity, reloadHistory, taskWallTimeForSession, tuiActivityDiagnostics,
  buildSessionDetailsTree, childRows, handleMessageUpdated } from "../src/tui.js";
import { tuiReadModel } from "../src/tui-read-model.js";
import { normalizeActivityEvent, replayActivity, type ActivityEvent } from "../src/activity.js";

const api = { ui: { toast() {} } } as unknown as TuiPluginApi;
const run = promisify(execFile);
const original = { ...fs };
async function fixture() {
  const cache = process.env.TMPDIR || join(process.env.HOME!, ".cache", "tokpulse-test-tmp");
  assert.ok(!cache.startsWith("/tmp")); await original.mkdir(cache, { recursive: true });
  return original.mkdtemp(join(cache, "tui-g2-"));
}
function fact(seq: number, sid = "root", state: "busy" | "idle" = "busy", timestamp = seq): ActivityEvent {
  return normalizeActivityEvent({ version: 2, kind: "lifecycle", sessionID: sid, state, timestamp, observedAt: timestamp,
    instanceID: "collector", eventID: `g2-${seq}`, seq, executionID: `exec-${Math.floor((seq - 1) / 2)}` })!;
}
function parent(seq: number, sid: string, value?: string | null): ActivityEvent {
  return normalizeActivityEvent({ version: 2, kind: "parent", sessionID: sid, parentSessionID: value,
    timestamp: seq, observedAt: seq, instanceID: "collector", eventID: `g2-parent-${seq}`, seq })!;
}
const text = (facts: readonly ActivityEvent[]) => facts.map((event) => JSON.stringify(event)).join("\n") + "\n";

/** Observe real FD bytes, parse invocations and close, not file-size estimates. */
async function io(paths: Set<string>, beforeOpen?: (path: string) => Promise<void>, afterRead?: (path: string) => Promise<void>) {
  const bunTestModule = "bun:test"; const { mock } = await import(bunTestModule);
  const counts = { opened: 0, closed: 0, bytes: 0, parses: 0, writes: 0 };
  let readFileError = false;
  const parse = JSON.parse;
  JSON.parse = function(value: string, reviver?: any) {
    if (typeof value === "string" && /"eventID":"g2-/.test(value)) counts.parses++;
    return parse(value, reviver);
  };
  mock.module("node:fs/promises", () => ({ ...original, async open(...args: Parameters<typeof fs.open>) {
    const path = String(args[0]); if (!paths.has(path)) return original.open(...args);
    if ((Number(args[1]) & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)) !== 0) { counts.writes++; throw Error("TUI attempted ledger write"); }
    await beforeOpen?.(path);
    const file = await original.open(...args); counts.opened++;
    return new Proxy(file, { get(target, key) {
      if (key === "close") return async () => { counts.closed++; return target.close(); };
      if (key === "read") return async (...parameters: any[]) => { const result = await (target.read as any)(...parameters); counts.bytes += result.bytesRead; await afterRead?.(path); return result; };
      if (key === "readFile") return async (...parameters: any[]) => {
        if (readFileError) { readFileError = false; throw Object.assign(Error("fixture read EIO"), { code: "EIO" }); }
        const result = await (target.readFile as any)(...parameters); counts.bytes += Buffer.byteLength(result); return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  } }));
  return { counts, failNextReadFile() { readFileError = true; }, restore() { JSON.parse = parse; mock.module("node:fs/promises", () => original); } };
}

test("G2-01 actual totals reload refuses symlink FIFO directory and check-open substitution, closes FD, accepts atomic replace", async () => {
  const directory = await fixture(); const totals = join(directory, "totals.json"), history = join(directory, "history.jsonl");
  const target = join(directory, "fixture-target.json");
  const base = createRuntimeStore(1); const snapshot = { ...base.totalsLedger,
    sessions: { root: { responseCount: 7, tokens: { input: 7, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 7 } } };
  base.disposeSignals(); await original.writeFile(target, JSON.stringify(snapshot));
  let swap = false;
  const observed = await io(new Set([totals]), async () => {
    if (!swap) return; swap = false; await original.rm(totals); await run("mkfifo", [totals]);
  });
  try {
    for (const mode of ["symlink", "fifo", "directory", "swap", "read-EIO"] as const) {
      const store = createRuntimeStore(1); const before = observed.counts.bytes;
      if (mode === "symlink") await original.symlink(target, totals);
      if (mode === "fifo") await run("mkfifo", [totals]);
      if (mode === "directory") await original.mkdir(totals);
      if (mode === "swap") { await original.writeFile(totals, "{}"); swap = true; }
      if (mode === "read-EIO") { await original.writeFile(totals, JSON.stringify(snapshot)); observed.failNextReadFile(); }
      const started = performance.now();
      await reloadHistory(store, api, history, totals, 1);
      assert.ok(performance.now() - started < 1000, `${mode} must fail without waiting for FIFO writer`);
      assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, 0);
      assert.equal(observed.counts.bytes, before, "unsafe totals body was not read");
      assert.equal(observed.counts.opened, observed.counts.closed, "all actual FDs close on failure");
      store.disposeSignals(); await original.rm(totals, { recursive: true, force: true });
    }
    const store = createRuntimeStore(1);
    await original.writeFile(totals, JSON.stringify(snapshot)); await reloadHistory(store, api, history, totals, 1);
    assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, 7);
    const replacement = join(directory, "replacement");
    await original.writeFile(replacement, JSON.stringify({ ...snapshot, sessions: { root: { ...snapshot.sessions.root, responseCount: 9 } } }));
    await original.rename(replacement, totals); await reloadHistory(store, api, history, totals, 1);
    assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, 9);
    assert.equal(observed.counts.opened, observed.counts.closed); assert.equal(observed.counts.writes, 0);
    assert.equal(await original.readFile(target, "utf8"), JSON.stringify(snapshot));
    store.disposeSignals(); console.log("G2-01 reload FD", observed.counts);
  } finally { observed.restore(); await original.rm(directory, { recursive: true, force: true }); }
});

for (const n of [1000, 4000, 16000, 40000]) test(`G2-03 TUI ${n} canonical sessions then 8 actual append/unchanged reloads`, async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"); const store = createRuntimeStore(1, 0);
  const events: ActivityEvent[] = [];
  for (let i = 0; i < n; i++) events.push(fact(i * 2 + 1, `sid-${i}`, "busy", 100), fact(i * 2 + 2, `sid-${i}`, "idle", 120));
  await original.writeFile(path, text(events)); const observed = await io(new Set([path]));
  try {
    await reloadActivity(store, api, path); assert.equal(taskWallTimeForSession(store, "sid-0", 200), 20);
    const before = { ...observed.counts }, baseline = tuiActivityDiagnostics(store), raw = store.activityEvents;
    const started = performance.now();
    for (let i = 0; i < 8; i++) {
      const added = [fact(n * 2 + i * 2 + 1, "appended", "busy", 200 + i * 100), fact(n * 2 + i * 2 + 2, "appended", "idle", 220 + i * 100)];
      await original.appendFile(path, text(added)); events.push(...added);
      await reloadActivity(store, api, path);
      assert.equal(taskWallTimeForSession(store, "appended", 2000), (i + 1) * 20);
      assert.equal(taskWallTimeForSession(store, "appended", 2000), replayActivity(added).activeMillisecondsByRoot.get("appended")! * (i + 1));
      assert.equal(store.activityEvents, raw, "append retains the canonical array, not concat history");
      const current = { ...observed.counts }, revision = store.revision(); const counters = tuiActivityDiagnostics(store);
      await reloadActivity(store, api, path);
      assert.equal(observed.counts.bytes, current.bytes); assert.equal(observed.counts.parses, current.parses);
      assert.equal(store.revision(), revision); assert.equal(tuiActivityDiagnostics(store).ingested, counters.ingested);
    }
    const after = tuiActivityDiagnostics(store);
    assert.equal(after.canonicalIngested - baseline.canonicalIngested, 16);
    assert.equal(after.ingested - baseline.ingested, 16);
    assert.equal(after.canonicalResets, baseline.canonicalResets); assert.equal(after.replayCalls, 0);
    assert.equal(observed.counts.parses - before.parses, 16);
    assert.ok(observed.counts.bytes - before.bytes < 100000);
    assert.equal(after.canonicalArrayCopies, baseline.canonicalArrayCopies);
    assert.equal(observed.counts.opened, observed.counts.closed); assert.equal(observed.counts.writes, 0);
    console.log(`G2-03 TUI n=${n} append-query-ms=${Math.round(performance.now() - started)} bytes=${observed.counts.bytes - before.bytes} parse=${observed.counts.parses - before.parses} counters=${JSON.stringify(after)}`);
  } finally { observed.restore(); store.disposed = true; store.disposeSignals(); await original.rm(directory, { recursive: true, force: true }); }
});

test("G2-02 canonical A to B to explicit root updates time/usage/MC without self-cache winning", async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  const record = { version: 1, messageID: "history", sessionID: "child", parentSessionID: "A", providerID: "p", modelID: "m", tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 1, speed: { avg: 0, peak: 0, min: 0, window: 0 }, time: { start: 100, firstToken: 100, completed: 120, ttft: 0, duration: 20 } } as any;
  store.diskRecords = [record]; store.records = [record];
  store.totalsLedger = { ...store.totalsLedger, sessions: { child: { responseCount: 1, tokens: record.tokens, cost: 1 } }, settled: { history: true },
    sessionScopes: { B: { version: 1, sourceScope: "magic-session", reasons: ["session-agent"] } } };
  const events = [parent(1, "child", "A"), fact(3, "child", "busy", 100), fact(4, "child", "idle", 120)];
  await original.writeFile(path, text(events));
  try {
    await reloadActivity(store, api, path); assert.equal(taskWallTimeForSession(store, "A", 200), 20);
    assert.equal(buildSessionDetailsTree(store, "A").including.responseCount, 1);
    await original.appendFile(path, text([parent(5, "child", "B")])); await reloadActivity(store, api, path);
    assert.equal(store.sessionParents.get("child"), "B"); assert.equal(taskWallTimeForSession(store, "A", 200), undefined);
    assert.equal(buildSessionDetailsTree(store, "A").including.responseCount, 0);
    assert.equal(buildSessionDetailsTree(store, "B").including.responseCount, 0);
    await original.appendFile(path, text([parent(6, "child")])); await reloadActivity(store, api, path);
    assert.ok(store.sessionParents.has("child")); assert.equal(store.sessionParents.get("child"), null);
    assert.equal(taskWallTimeForSession(store, "child", 200), 20);
    assert.equal(buildSessionDetailsTree(store, "child").including.responseCount, 1);
    assert.equal(buildSessionDetailsTree(store, "A").including.responseCount, 0, "history's stale parent cannot resurrect an explicitly cleared edge");
  } finally { store.disposed = true; store.disposeSignals(); await original.rm(directory, { recursive: true, force: true }); }
});

for (const shape of ["wide", "deep", "cycle"] as const) for (const n of [1000, 2000, 4000])
test(`G2-04/05 ${shape} ${n} actual hydrate, shared visible index, warm root query`, async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  const events: ActivityEvent[] = []; const sessions: any = Object.create(null);
  for (let i = 0; i < n; i++) {
    events.push(parent(i + 1, `s${i}`, shape === "wide" ? "root" : i + 1 < n ? `s${i + 1}` : shape === "cycle" ? "s0" : undefined));
    sessions[`s${i}`] = { responseCount: 1, cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } };
  }
  events.push(fact(n + 1, "s0", "busy", n + 100), fact(n + 2, "s0", "idle", n + 120));
  await original.writeFile(path, text(events)); store.totalsLedger = { ...store.totalsLedger, sessions };
  try {
    const started = performance.now(); await reloadActivity(store, api, path);
    assert.equal(taskWallTimeForSession(store, "s0", n + 200), 20);
    const expected = replayActivity(events).activeMillisecondsByRoot;
    const root = tuiReadModel(store).root("s0"); assert.equal(expected.get(root), 20);
    const warm = tuiActivityDiagnostics(store);
    Object.defineProperty(store.sessionParents, Symbol.iterator, { configurable: true, value() { throw Error("warm taskTime copied full parent graph"); } });
    for (let i = 0; i < 20; i++) assert.equal(taskWallTimeForSession(store, "s0", n + 200 + i * 100), 20);
    delete (store.sessionParents as any)[Symbol.iterator];
    assert.equal(tuiActivityDiagnostics(store).readModel.parentGraphCopies, warm.readModel.parentGraphCopies);
    assert.equal(tuiActivityDiagnostics(store).readModel.rootVisits, warm.readModel.rootVisits);
    assert.equal(tuiReadModel(store).counters.rowDerivations, 0);
    const tree = buildSessionDetailsTree(store, root), beforeRows = tuiReadModel(store).diagnostics();
    assert.equal(tree.including.responseCount, n); assert.equal(tree.including.tokens.output, n);
    const rows = childRows([], root, store), after = tuiReadModel(store).diagnostics();
    assert.equal(rows.length, shape === "wide" ? n : n - 1);
    assert.equal(after.visibleBuilds, beforeRows.visibleBuilds, "all child rows share the actual projection's one rollup index");
    assert.equal(after.visibleBuilds, 1); assert.equal(after.rowDerivations, 1);
    assert.ok(after.parentVisits < n * 40, `parent traversal must not be quadratic: ${after.parentVisits}`);
    assert.ok(after.rollup!.parentVisits < n * 30); assert.ok(after.rollup!.resultCopies < n * 50);
    console.log(`G2-04/05 ${shape} ${n} hydrate-query-rows-ms=${Math.round(performance.now() - started)} counters=${JSON.stringify(tuiActivityDiagnostics(store))}`);
  } finally { delete (store.sessionParents as any)[Symbol.iterator]; store.disposed = true; store.disposeSignals(); await original.rm(directory, { recursive: true, force: true }); }
});

for (const shape of ["wide", "deep", "cycle"] as const) for (const n of [1000, 4000])
test(`G2-02/05 ${shape} ${n} subtree moves into MC then to explicit root without restart`, async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  const branch = shape === "cycle" ? "s0" : "branch";
  try {
    const links = Array.from({ length: n }, (_, i) => parent(i + 1, `s${i}`, shape === "wide" ? branch : i === n - 1 ? (shape === "cycle" ? "s0" : branch) : `s${i + 1}`));
    if (shape !== "cycle") links.push(parent(n + 1, branch, "A"));
    const events = [...links, fact(n * 2 + 1, "s0", "busy", 100), fact(n * 2 + 2, "s0", "idle", 120)];
    const initialBytes = text(events); await original.writeFile(path, initialBytes);
    const sessions = Object.create(null); for (let i = 0; i < n; i++) sessions[`s${i}`] = { responseCount: 1, cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } };
    store.totalsLedger = { ...store.totalsLedger, sessions, sessionScopes: { B: { version: 1, sourceScope: "magic-session", reasons: ["session-agent"] },
      [branch]: { version: 1, sourceScope: "pending", reasons: [], parentSessionID: shape === "cycle" ? "s1" : "A" } } };
    const ledgerBytes = JSON.stringify(store.totalsLedger); await reloadActivity(store, api, path);
    const raw = store.activityEvents.slice(), initialRoot = tuiReadModel(store).root("s0");
    assert.equal(taskWallTimeForSession(store, initialRoot, 1000), 20); assert.equal(buildSessionDetailsTree(store, initialRoot).including.responseCount, n);
    const resets = tuiActivityDiagnostics(store).canonicalResets;
    await original.appendFile(path, text([parent(n + 4, branch, "B")])); await reloadActivity(store, api, path);
    assert.equal(tuiReadModel(store).eligible("s0"), false); assert.equal(buildSessionDetailsTree(store, "B").including.responseCount, 0);
    assert.equal(taskWallTimeForSession(store, "B", 1000), undefined);
    await original.appendFile(path, text([parent(n + 5, branch, null)])); await reloadActivity(store, api, path);
    assert.equal(tuiReadModel(store).root("s0"), branch); assert.equal(taskWallTimeForSession(store, branch, 1000), 20);
    assert.equal(buildSessionDetailsTree(store, branch).including.responseCount, n);
    assert.equal(tuiActivityDiagnostics(store).canonicalResets, resets);
    assert.ok(raw.every((value, i) => value === store.activityEvents[i])); assert.equal(JSON.stringify(store.totalsLedger), ledgerBytes);
    assert.ok((await original.readFile(path, "utf8")).startsWith(initialBytes));
    const reference = replayActivity(store.activityEvents, { parentBySessionID: store.sessionParents, sessionScopes: tuiReadModel(store).scopes });
    assert.equal(taskWallTimeForSession(store, branch, 1000), reference.activeMillisecondsByRoot.get(branch));
  } finally { store.disposed = true; store.disposeSignals(); await original.rm(directory, { recursive: true, force: true }); }
});

for (const n of [100, 200, 400, 1000, 2000, 4000]) test(`G2-06 ${n} canonical exact then late MC through handlers and visible shared rollup`, () => {
  const store = createRuntimeStore(1, 0); const settled: any = Object.create(null);
  const tokens = { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 };
  for (let i = 0; i < n; i++) settled[`mid-${i}`] = { sessionID: "root", fingerprint: `exact-${i}`, quality: "exact", tokens: { ...tokens }, cost: 1 };
  store.totalsLedger = { ...store.totalsLedger, settled, sessions: { root: { responseCount: n, cost: n,
    tokens: { input: n, output: n * 2, reasoning: n * 3, cacheRead: n * 4, cacheWrite: n * 5 } } } };
  const canonical = store.totalsLedger, bytes = JSON.stringify(canonical), started = performance.now();
  const proof = (i: number) => handleMessageUpdated(store, api, { info: { id: `mid-${i}`, sessionID: "root", role: "assistant", agent: "historian", time: { created: 0, completed: 1 } } }, { type: "message.updated", timestamp: 1 }, 4, 1);
  try {
    assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, n);
    for (let i = 0; i < n; i++) {
      proof(i);
      const tree = buildSessionDetailsTree(store, "root");
      assert.equal(tree.including.responseCount, n - i - 1); assert.equal(tree.including.tokens.cacheRead, (n - i - 1) * 4);
    }
    const before = tuiReadModel(store).diagnostics();
    for (let i = 0; i < n; i++) { proof(i); assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, 0); }
    const after = tuiReadModel(store).diagnostics();
    assert.equal(after.ledgerBuilds, 1); assert.equal(after.canonicalContributionVisits, n);
    assert.equal(after.deductionUpdates, n); assert.equal(after.dictionaryEntriesCopied, n + 1);
    assert.equal(after.visibleBuilds, before.visibleBuilds, "duplicate proof cannot rebuild the visible index");
    assert.equal(store.totalsLedger, canonical); assert.equal(JSON.stringify(canonical), bytes);
    console.log(`G2-06 late-proof ${n} handler-plus-visible-query-ms=${Math.round(performance.now() - started)} counters=${JSON.stringify(after)}`);
  } finally { store.disposed = true; store.disposeSignals(); }
});

for (const n of [1000, 4000]) test(`G2-06 ${n} dirty SIDs batch into one visible projection without per-proof ledger materialization`, () => {
  const store = createRuntimeStore(1, 0), started = performance.now();
  const sessions = Object.create(null), settled = Object.create(null), scopes = Object.create(null);
  for (let i = 0; i < n; i++) {
    const id = `s${i}`, tokens = { input: 1, output: 1, reasoning: 0, cacheRead: 1, cacheWrite: 0 };
    sessions[id] = { tokens, cost: 1, responseCount: 1 }; settled[`m${i}`] = { sessionID: id, quality: "exact", tokens, cost: 1 };
    scopes[id] = { version: 1, sourceScope: "pending", reasons: [], parentSessionID: "root" };
  }
  store.totalsLedger = { ...store.totalsLedger, sessions, settled, sessionScopes: scopes };
  try {
    assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, n);
    const model = tuiReadModel(store), before = model.diagnostics(), originalLedger = store.totalsLedger, bytes = JSON.stringify(originalLedger);
    for (let i = 0; i < n; i++) handleMessageUpdated(store, api, { info: { id: `m${i}`, sessionID: `s${i}`, role: "assistant", agent: "historian" } }, { type: "message.updated" }, 4, 0);
    const dirty = model.diagnostics();
    assert.equal(dirty.visibleBuilds, before.visibleBuilds); assert.equal(dirty.dictionaryEntriesCopied, before.dictionaryEntriesCopied);
    assert.equal(dirty.canonicalContributionVisits, n); assert.equal(dirty.ledgerBuilds, 1);
    assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, 0);
    const after = model.diagnostics(); assert.equal(after.visibleBuilds - before.visibleBuilds, 1);
    assert.equal(after.visibleSessionCopies - before.visibleSessionCopies, n); assert.equal(after.deductionUpdates, n);
    assert.equal(after.rollup?.builds, 2); assert.equal(after.rollup?.sessionEntries, n * 2);
    assert.equal(store.totalsLedger, originalLedger); assert.equal(JSON.stringify(originalLedger), bytes);
    console.log(`G2-06 batch SIDs=${n} handlers-and-two-visible-trees-ms=${Math.round(performance.now() - started)} counters=${JSON.stringify(after)}`);
  } finally { store.disposed = true; store.disposeSignals(); }
});

test("G2-03 failed/stale reads never consume cursor; partial/EOF/duplicate/truncate/replace retain exact time", async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  let held: (() => void) | undefined, entered!: () => void, block = false, changeDuringRead = false, replaceDuringRead = false, failRead = false;
  const warnings: string[] = [];
  const raceApi = { ui: { toast(value: { message: string }) { warnings.push(value.message); } } } as unknown as TuiPluginApi;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const observed = await io(new Set([path]), async () => {
    if (failRead) { failRead = false; throw Object.assign(Error("fixture activity EIO"), { code: "EIO" }); }
    if (!block) return; block = false; entered(); await new Promise<void>((resolve) => { held = resolve; });
  }, async () => {
    if (replaceDuringRead) {
      replaceDuringRead = false;
      const replacement = join(directory, "racing-replacement");
      await original.copyFile(path, replacement); await original.rename(replacement, path);
    }
    if (!changeDuringRead) return; changeDuringRead = false;
    await original.appendFile(path, text([fact(7, "root", "busy", 600), fact(8, "root", "idle", 620)]));
  });
  try {
    await original.writeFile(path, text([fact(1, "root", "busy", 100), fact(2, "root", "idle", 120)])); await reloadActivity(store, api, path);
    await original.appendFile(path, text([fact(3, "root", "busy", 200), fact(4, "root", "idle", 220)]));
    store.activityGeneration = 1; block = true; const old = reloadActivity(store, api, path, 1); await enteredPromise;
    store.activityGeneration = 2; await reloadActivity(store, api, path, 2); held!(); await old;
    assert.equal(taskWallTimeForSession(store, "root", 1000), 40); assert.equal(tuiActivityDiagnostics(store).staleReads, 1);
    let before = observed.counts.bytes; await reloadActivity(store, api, path, 2); assert.equal(observed.counts.bytes, before);
    await original.appendFile(path, text([fact(5, "root", "busy", 400), fact(6, "root", "idle", 420)]));
    changeDuringRead = true; const beforeAppend = tuiActivityDiagnostics(store).canonicalIngested;
    assert.equal(await reloadActivity(store, raceApi, path, 2), true);
    assert.equal(tuiActivityDiagnostics(store).canonicalIngested, beforeAppend + 2);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 60);
    assert.equal(await reloadActivity(store, raceApi, path, 2), true); assert.equal(taskWallTimeForSession(store, "root", 1000), 80);
    const half = text([fact(9, "root", "busy", 800), fact(10, "root", "idle", 820)]);
    await original.appendFile(path, half.slice(0, 30)); await reloadActivity(store, api, path, 2);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 80);
    await original.appendFile(path, half.slice(30).trimEnd()); await reloadActivity(store, api, path, 2);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 100);
    await original.appendFile(path, "\n"); replaceDuringRead = true;
    const beforeFailure = tuiActivityDiagnostics(store).canonicalIngested;
    assert.equal(await reloadActivity(store, raceApi, path, 2), false);
    assert.equal(tuiActivityDiagnostics(store).canonicalIngested, beforeFailure);
    assert.deepEqual(warnings, [], "recoverable replacement races must not toast");
    await reloadActivity(store, raceApi, path, 2);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 100);
    assert.equal(tuiActivityDiagnostics(store).canonicalIngested, beforeFailure + 10, "replacement rebuild counts its ten canonical facts");
    assert.equal(store.activityEvents.length, 10, "reset must not duplicate canonical facts");
    await original.writeFile(path, text([fact(11, "root", "busy", 900), fact(12, "root", "idle", 930)])); await reloadActivity(store, api, path, 2);
    assert.equal(taskWallTimeForSession(store, "root", 1000), 30);
    const replacement = join(directory, "replacement"); await original.writeFile(replacement, text([fact(13, "root", "busy", 1000), fact(14, "root", "idle", 1040)]));
    await original.rename(replacement, path); await reloadActivity(store, api, path, 2);
    assert.equal(taskWallTimeForSession(store, "root", 3600000), 40); assert.equal(tuiActivityDiagnostics(store).canonicalResets, 4);
    failRead = true; assert.equal(await reloadActivity(store, raceApi, path, 2), false);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /activity read failed.*fixture activity EIO/);
    assert.equal(observed.counts.opened, observed.counts.closed); assert.ok(tuiActivityDiagnostics(store).readRetries >= 1);
  } finally { held?.(); observed.restore(); store.disposed = true; store.disposeSignals(); await original.rm(directory, { recursive: true, force: true }); }
});

for (const kind of ["parent", "lifecycle"] as const)
test(`G2-02/03 repeated old ${kind} parent evidence cannot roll warm B back to A`, async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0), fresh = createRuntimeStore(1, 0);
  const normalize = (fields: object) => normalizeActivityEvent({ version: 2, instanceID: "collector", sessionID: "child", ...fields })!;
  const a = normalize({ kind, parentSessionID: "A", eventID: "parent-A", seq: 1, timestamp: 1, observedAt: 1,
    ...(kind === "lifecycle" ? { state: "idle", executionID: "old-metadata" } : {}) });
  const busy = normalize({ kind: "lifecycle", state: "busy", eventID: "busy", seq: 2, timestamp: 10, observedAt: 10, executionID: "exec" });
  const done = normalize({ kind: "lifecycle", state: "completed", eventID: "done", seq: 3, timestamp: 30, observedAt: 30, executionID: "exec" });
  const b = normalize({ kind: "parent", parentSessionID: "B", eventID: "parent-B", seq: 4, timestamp: 40, observedAt: 40 });
  try {
    await original.writeFile(path, text([a, busy, done])); await reloadActivity(store, api, path);
    assert.equal(taskWallTimeForSession(store, "A", 100), 20);
    await original.appendFile(path, text([b])); await reloadActivity(store, api, path);
    assert.equal(taskWallTimeForSession(store, "B", 100), 20);
    const before = tuiReadModel(store).diagnostics(), activityBefore = tuiActivityDiagnostics(store), revision = store.revision();
    await original.appendFile(path, text([a])); await reloadActivity(store, api, path);
    assert.equal(taskWallTimeForSession(store, "B", 100), 20, "known old evidence must not become the latest parent again");
    assert.equal(tuiReadModel(store).root("child"), "B"); assert.equal(store.revision(), revision);
    const after = tuiReadModel(store).diagnostics();
    for (const key of ["parentVisits", "parentVersion", "parentPublications", "parentGraphCopies", "parentPatchEntries"] as const) assert.equal(after[key], before[key], key);
    assert.equal(tuiActivityDiagnostics(store).canonicalIngested, activityBefore.canonicalIngested);
    assert.equal(tuiActivityDiagnostics(store).indexBuilds, activityBefore.indexBuilds);
    await reloadActivity(fresh, api, path); assert.equal(taskWallTimeForSession(fresh, "B", 100), 20, "fresh and warm must agree exactly");
  } finally { for (const value of [store, fresh]) { value.disposed = true; value.disposeSignals(); } await original.rm(directory, { recursive: true, force: true }); }
});

test("G2-02/03 parent semantic correction, explicit root and reset preserve complete-fact dedupe", async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  const normalize = (fields: object) => normalizeActivityEvent({ version: 2, instanceID: "collector", sessionID: "child", ...fields })!;
  const a = normalize({ kind: "parent", parentSessionID: "A", eventID: "same-parent-id", seq: 1, timestamp: 1, observedAt: 1 });
  const b = normalize({ ...a, parentSessionID: "B" }), c = normalize({ ...a, parentSessionID: "C" }), root = normalize({ ...a, parentSessionID: null });
  const busy = normalize({ kind: "lifecycle", state: "busy", eventID: "busy", seq: 2, timestamp: 10, observedAt: 10, executionID: "exec" });
  const done = normalize({ kind: "lifecycle", state: "completed", eventID: "done", seq: 3, timestamp: 30, observedAt: 30, executionID: "exec" });
  const expectRoot = async (id: string) => {
    assert.equal(tuiReadModel(store).root("child"), id); assert.equal(taskWallTimeForSession(store, id, 100), 20);
    const fresh = createRuntimeStore(1, 0);
    try { await reloadActivity(fresh, api, path); assert.equal(tuiReadModel(fresh).root("child"), id); assert.equal(taskWallTimeForSession(fresh, id, 100), 20); }
    finally { fresh.disposed = true; fresh.disposeSignals(); }
  };
  try {
    await original.writeFile(path, text([a, busy, done])); await reloadActivity(store, api, path); await expectRoot("A");
    await original.appendFile(path, text([b])); await reloadActivity(store, api, path); await expectRoot("B");
    await original.appendFile(path, text([a])); await reloadActivity(store, api, path); await expectRoot("B");
    await original.appendFile(path, text([c])); await reloadActivity(store, api, path); await expectRoot("C");
    await original.appendFile(path, text([root])); await reloadActivity(store, api, path); await expectRoot("child");
    assert.equal(store.sessionParents.get("child"), null);
    const before = tuiReadModel(store).diagnostics();
    await original.appendFile(path, text([root, c])); await reloadActivity(store, api, path); await expectRoot("child");
    assert.equal(tuiReadModel(store).diagnostics().parentVersion, before.parentVersion);
    const newA = normalize({ ...a, eventID: "genuinely-new-A", seq: 4, timestamp: 40, observedAt: 40 });
    await original.appendFile(path, text([newA])); await reloadActivity(store, api, path); await expectRoot("A");
    await original.appendFile(path, text([c])); await reloadActivity(store, api, path); await expectRoot("A");
    const newC = normalize({ ...c, eventID: "genuinely-new-C", seq: 5, timestamp: 50, observedAt: 50 });
    await original.appendFile(path, text([newC])); await reloadActivity(store, api, path); await expectRoot("C");
    const resets = tuiActivityDiagnostics(store).canonicalResets;
    const replacement = join(directory, "replacement"); await original.writeFile(replacement, text([a, busy, done])); await original.rename(replacement, path);
    await reloadActivity(store, api, path); await expectRoot("A"); assert.equal(tuiActivityDiagnostics(store).canonicalResets, resets + 1);
    await original.appendFile(path, text([b])); await reloadActivity(store, api, path); await expectRoot("B");
    await original.writeFile(path, ""); await reloadActivity(store, api, path); assert.equal(store.activityEvents.length, 0);
    await original.appendFile(path, text([c, busy, done])); await reloadActivity(store, api, path); await expectRoot("C");
  } finally { store.disposed = true; store.disposeSignals(); await original.rm(directory, { recursive: true, force: true }); }
});

test("G2-05 parent publication follows committed file position, never timestamp or cross-instance sequence", async () => {
  const directory = await fixture(), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  try {
    const first = parent(1000, "child", "A");
    const second = normalizeActivityEvent({ ...parent(1, "child", "B"), instanceID: "other-collector", timestamp: 0, observedAt: 0 })!;
    await original.writeFile(path, text([first, second, fact(3, "child", "busy", 100), fact(4, "child", "idle", 120)]));
    await reloadActivity(store, api, path); assert.equal(store.sessionParents.get("child"), "B");
    assert.equal(taskWallTimeForSession(store, "B", 1000), 20); assert.equal(taskWallTimeForSession(store, "A", 1000), undefined);
    assert.equal(store.activityEvents.length, 4);
  } finally { store.disposed = true; store.disposeSignals(); await original.rm(directory, { recursive: true, force: true }); }
});

test("G2-06 duplicate/correction/open-settled/canonical exclusion/legacy-true/ledger replacement compose exactly once", () => {
  const store = createRuntimeStore(1, 0);
  const tokens = (n: number) => ({ input: n, output: n, reasoning: 0, cacheRead: n, cacheWrite: 0 });
  const contribution = (n: number, excluded = false) => ({ sessionID: "root", quality: "exact" as const, tokens: tokens(n), cost: n,
    ...(excluded ? { excluded: { version: 1 as const, sourceScope: "magic-message" as const, reasons: ["message-agent" as const] } } : {}) });
  const proof = (id: string) => handleMessageUpdated(store, api, { info: { id, sessionID: "root", role: "assistant", agent: "historian" } }, { type: "message.updated" }, 4, 0);
  const install = (n: number, settled: boolean, excluded = false) => {
    store.totalsLedger = { ...store.totalsLedger, open: settled ? {} : { a: contribution(n, excluded) },
      settled: { ...(settled ? { a: contribution(n, excluded) } : {}), b: contribution(20), legacy: true },
      sessions: { root: { responseCount: excluded ? 2 : 3, tokens: tokens(excluded ? 25 : n + 25), cost: excluded ? 25 : n + 25 } } };
    const snapshot = store.totalsLedger, bytes = JSON.stringify(snapshot);
    assert.equal(buildSessionDetailsTree(store, "root").including.cost, store.messageScopes.has("a") ? 25 : n + 25);
    assert.equal(JSON.stringify(snapshot), bytes); return { snapshot, bytes };
  };
  try {
    install(10, false); proof("a"); assert.equal(buildSessionDetailsTree(store, "root").including.cost, 25);
    proof("a"); assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, 2);
    install(5, true); install(0, false); const before = install(0, true, true);
    proof("a"); proof("legacy"); assert.equal(buildSessionDetailsTree(store, "root").including.responseCount, 2, "legacy true has no reversible amount/SID; never guess a subtraction");
    assert.equal(buildSessionDetailsTree(store, "root").including.tokens.cacheRead, 25);
    assert.equal(store.totalsLedger, before.snapshot); assert.equal(JSON.stringify(before.snapshot), before.bytes);
    install(9, true, true); assert.equal(buildSessionDetailsTree(store, "root").including.cost, 25);
  } finally { store.disposed = true; store.disposeSignals(); }
});
