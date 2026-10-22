import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeActivityEvent, replayActivity, type ActivityEvent } from "../src/activity.js";
import type { HistoryRecord } from "../src/core.js";
import type { MeasuredHistoryRecord } from "../src/statistics.js";
import { acquireWriterLease, createReliableActivityWriter, createUsageCommitter, PersistenceBackpressureError, prepareLedgerPaths, recoverHistoryFile } from "../src/persistence.js";
import { createActivityLedger, readActivityFile, writeActivityFile } from "../src/runs-storage.js";
import { createHistoryStorage, readHistoryFile, serializeHistoryJsonl, writeHistoryFile } from "../src/storage.js";
import { createTotalsStorage } from "../src/totals-storage.js";

async function directory(context: { after(callback: () => Promise<void>): void }) {
  const cache = join(homedir(), ".cache", "tokpulse-tests");
  await mkdir(cache, { recursive: true });
  const path = await mkdtemp(join(cache, "persistence-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function record(id: string, extra: Partial<HistoryRecord> = {}): HistoryRecord {
  return { version: 1, messageID: id, sessionID: id, quality: "exact", tokens: { input: 3, output: 7, reasoning: 2, cacheRead: 4, cacheWrite: 5 }, cost: 2,
    time: { start: 1, completed: 2 }, samples: [], ...extra };
}
function event(id: string, state: "busy" | "idle", timestamp: number, sid = "s"): ActivityEvent {
  return normalizeActivityEvent({ eventID: id, kind: "lifecycle", sessionID: sid, instanceID: "fixed", seq: timestamp, state, timestamp })!;
}
const eio = () => Object.assign(new Error("injected EIO"), { code: "EIO" });

test("paths reject collisions, aliases, hardlinks, symlinks, directories and FIFOs before business initialization", async (context) => {
  const base = await directory(context);
  await assert.rejects(prepareLedgerPaths(base, { historyPath: "runs.jsonl" }), /collide/);
  await assert.rejects(prepareLedgerPaths(base, { historyPath: "a/../runs.jsonl" }), /collide/);
  await assert.rejects(prepareLedgerPaths(base, { historyPath: ".tokpulse-writer-locks/business" }), /reserved/);
  assert.deepEqual(await readdir(base), []);
  await mkdir(join(base, "real"));
  await symlink(join(base, "real"), join(base, "alias"));
  await assert.rejects(prepareLedgerPaths(base, { historyPath: "real/h", totalsPath: "../alias/h" }), /collide/);
  const sentinel = join(base, "sentinel");
  await writeFile(sentinel, "untouched");
  await symlink(sentinel, join(base, "sym"));
  await assert.rejects(prepareLedgerPaths(base, { historyPath: "sym" }), /Unsafe/);
  await link(sentinel, join(base, "hard"));
  await assert.rejects(prepareLedgerPaths(base, { historyPath: "hard" }), /Unsafe/);
  await assert.rejects(prepareLedgerPaths(base, { historyPath: "real" }), /Unsafe/);
  const fifo = join(base, "fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  await assert.rejects(prepareLedgerPaths(base, { historyPath: "fifo" }), /Unsafe/);
  for (const path of [join(base, "sym"), join(base, "hard"), fifo, join(base, "real")]) {
    await assert.rejects(createActivityLedger(path).append(event("b", "busy", 1)));
    await assert.rejects(writeHistoryFile(path, [record("h")]));
    await assert.rejects(writeActivityFile(path, []));
    await assert.rejects(createTotalsStorage(path).apply(record("t")));
  }
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
});

test("writer lease guards writes after release, leaves business paths untouched and retains lock carriers", async (context) => {
  const base = await directory(context);
  const paths = await prepareLedgerPaths(base, {});
  const lease = await acquireWriterLease(paths);
  assert.deepEqual(await readdir(base), [".tokpulse-writer-locks"]);
  await assert.rejects(acquireWriterLease(paths), /ownership/);
  const history = createHistoryStorage(paths.historyPath, { lease });
  const runs = createActivityLedger(paths.runsPath, { lease });
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  await history.upsert(record("one"));
  await lease.release();
  await lease.release();
  await assert.rejects(history.upsert(record("two")), /lease/);
  await assert.rejects(history.upsertWithSnapshot!(record("two")), /lease/);
  await assert.rejects(runs.append(event("x", "busy", 0)), /lease/);
  await assert.rejects(totals.apply(record("two")), /lease/);
  await assert.rejects(totals.applyMany([record("two")]), /lease/);
  await assert.rejects(recoverHistoryFile(paths.historyPath, lease), /lease/);
  const next = await acquireWriterLease(paths);
  await next.release();
});

function child(script: string): ChildProcess {
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}
async function exitCode(process: ChildProcess): Promise<number | null> {
  const [code] = await once(process, "exit");
  return code;
}
const persistenceURL = new URL("../src/persistence.ts", import.meta.url).href;

test("overlapping ledger paths exclude independent writers and release ownership on SIGKILL", async (context) => {
  const base = await directory(context);
  const paths = await prepareLedgerPaths(base, {});
  const script = `import {acquireWriterLease} from ${JSON.stringify(persistenceURL)}; await acquireWriterLease(${JSON.stringify(paths)}); Bun.gc(true); console.log('OWNED'); setInterval(()=>{},1000);`;
  const owner = child(script);
  context.after(async () => { if (owner.exitCode === null && !owner.killed) { owner.kill("SIGKILL"); await once(owner, "exit"); } });
  let stderr = "";
  owner.stderr!.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    owner.stdout!.on("data", (chunk) => { if (String(chunk).includes("OWNED")) resolve(); });
    owner.on("exit", (code) => reject(new Error(`owner exited ${code}: ${stderr}`)));
  });
  const keys = ["historyPath", "totalsPath", "runsPath"] as const;
  for (const [owned, contender] of [
    ["historyPath", "runsPath"], ["totalsPath", "historyPath"], ["runsPath", "totalsPath"],
  ] as const) {
    const other = Object.fromEntries(keys.map((key) => [key, join(base, `${owned}-${contender}-${key}`)])) as unknown as typeof paths;
    other[contender] = paths[owned];
    const attempt = child(`import {acquireWriterLease} from ${JSON.stringify(persistenceURL)}; try { const l=await acquireWriterLease(${JSON.stringify(other)}); await l.release(); process.exit(0); } catch { process.exit(13); }`);
    assert.equal(await exitCode(attempt), 13, `${owned} versus ${contender} must conflict`);
  }
  owner.kill("SIGKILL");
  await once(owner, "exit");
  const successor = await acquireWriterLease(paths);
  await successor.release();
});

test("ordered writer retries EIO before terminal, including cross-SID traffic and close", async (context) => {
  const base = await directory(context);
  const ledger = createActivityLedger(join(base, "runs"));
  const append = ledger.append.bind(ledger);
  let failures = 1;
  ledger.append = async (value) => { if (failures-- > 0) throw eio(); return append(value); };
  const writer = createReliableActivityWriter(ledger);
  const busy = event("busy", "busy", 100);
  assert.deepEqual(await writer.enqueue([busy]), { committed: [], pendingCount: 1, degraded: true });
  busy.timestamp = 9000; // Admission has already fixed the immutable fact.
  const report = await writer.enqueue([event("other", "busy", 150, "other"), event("idle", "idle", 200)]);
  assert.deepEqual(report.committed.map((fact) => fact.eventID), ["busy", "other", "idle"]);
  const stored = await ledger.read();
  assert.equal(stored[0].timestamp, 100);
  assert.equal(replayActivity(stored).activeMillisecondsByRoot.get("s"), 100);
  failures = 1;
  await writer.enqueue([event("last", "idle", 250, "other")]);
  assert.equal((await writer.close()).pendingCount, 0);
  await assert.rejects(writer.enqueue([event("closed", "busy", 300)]), /closed/);
});

test("partial and uncertain append retries retain identity and never concatenate a later fact", async (context) => {
  const base = await directory(context);
  const path = join(base, "runs");
  const ledger = createActivityLedger(path);
  const append = ledger.append.bind(ledger);
  let mode = "partial";
  ledger.append = async (value) => {
    if (mode === "partial") {
      mode = "uncertain";
      await appendFile(path, JSON.stringify(value).slice(0, 60));
      throw eio();
    }
    const written = await append(value);
    if (mode === "uncertain") { mode = "healthy"; throw eio(); }
    return written;
  };
  const writer = createReliableActivityWriter(ledger);
  await writer.enqueue([event("b", "busy", 10)]);
  assert.equal((await writer.enqueue([event("i", "idle", 20)])).pendingCount, 2);
  assert.equal((await writer.close()).pendingCount, 0);
  assert.deepEqual((await readActivityFile(path)).map((fact) => fact.eventID), ["b", "i"]);
  const all = await readActivityFile(path, { dedupe: false });
  assert.deepEqual(all.filter((fact) => fact.eventID === "b").map((fact) => [fact.timestamp, fact.seq, fact.instanceID]), [[10, 10, "fixed"], [10, 10, "fixed"]]);
});

test("activity budgets fail explicitly without discarding prefix or admitting terminal", async (context) => {
  const base = await directory(context);
  const ledger = createActivityLedger(join(base, "runs"));
  const append = ledger.append.bind(ledger);
  ledger.append = async () => { throw eio(); };
  const writer = createReliableActivityWriter(ledger, { maxPendingEvents: 1 });
  await writer.enqueue([event("b", "busy", 1)]);
  await assert.rejects(writer.enqueue([event("i", "idle", 2)]), PersistenceBackpressureError);
  assert.equal((await writer.flush()).pendingCount, 1);
  ledger.append = append;
  const report = await writer.close();
  assert.equal(report.pendingCount, 0);
  assert.equal(report.degraded, true);
  assert.deepEqual((await ledger.read()).map((fact) => fact.eventID), ["b"]);
  const byteWriter = createReliableActivityWriter(ledger, { maxPendingBytes: 1 });
  await assert.rejects(byteWriter.enqueue([event("big", "busy", 3)]), PersistenceBackpressureError);
});

test("budget-rejected activity epochs cannot resume terminal writes after capacity becomes healthy", async (context) => {
  const base = await directory(context);
  const ledger = createActivityLedger(join(base, "runs"));
  const append = ledger.append.bind(ledger);
  ledger.append = async () => { throw eio(); };
  const writer = createReliableActivityWriter(ledger, { maxPendingEvents: 1 });
  await writer.enqueue([event("busy", "busy", 1)]);
  await assert.rejects(writer.enqueue([event("lost", "idle", 2)]), PersistenceBackpressureError);
  ledger.append = append;
  assert.equal((await writer.flush()).pendingCount, 0);
  await assert.rejects(writer.enqueue([event("later", "idle", 100)]), /continuity/);
  assert.deepEqual((await ledger.read()).map((fact) => fact.eventID), ["busy"]);
});

test("window-one A totals EIO then healthy B retries globally and restart counts both exactly once", async (context) => {
  const base = await directory(context);
  const paths = await prepareLedgerPaths(base, {});
  const lease = await acquireWriterLease(paths);
  const history = createHistoryStorage(paths.historyPath, { maxRecords: 1, lease });
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  const apply = totals.apply.bind(totals);
  let fail = true;
  totals.apply = async (...args) => { if (fail) { fail = false; throw eio(); } return apply(...args); };
  const usage = createUsageCommitter(history, totals);
  assert.deepEqual(await usage.upsert(record("A")), { committed: false, pendingCount: 1 });
  assert.equal((await history.readAll())[0].messageID, "A");
  assert.deepEqual(await usage.upsert(record("B", { cost: 3 })), { committed: true, pendingCount: 0 });
  assert.deepEqual((await history.readAll()).map((r) => r.messageID), ["B"]);
  await usage.close();
  await lease.release();
  const successor = await acquireWriterLease(paths);
  try {
    await recoverHistoryFile(paths.historyPath, successor);
    const restartHistory = createHistoryStorage(paths.historyPath, { maxRecords: 1, lease: successor });
    const restartTotals = createTotalsStorage(paths.totalsPath, { lease: successor });
    await createUsageCommitter(restartHistory, restartTotals).recover();
    const ledger = await restartTotals.read();
    assert.equal(ledger.sessions.A.responseCount, 1);
    assert.equal(ledger.sessions.B.responseCount, 1);
    assert.equal(ledger.sessions.A.cost + ledger.sessions.B.cost, 5);
    assert.equal(ledger.sessions.A.tokens.cacheWrite, 5);
  } finally { await successor.release(); }
});

test("restart reconciles all protected/orphan records before pruning and readers never recover orphans", async (context) => {
  const base = await directory(context);
  const paths = await prepareLedgerPaths(base, { historyPath: "history" });
  const history = createHistoryStorage(paths.historyPath, { maxRecords: 1 });
  const totals = createTotalsStorage(paths.totalsPath);
  const apply = totals.apply.bind(totals);
  const applyMany = totals.applyMany.bind(totals);
  totals.apply = async () => { throw eio(); };
  totals.applyMany = async () => { throw eio(); };
  const usage = createUsageCommitter(history, totals);
  await usage.upsert(record("A"));
  await usage.upsert(record("B"));
  assert.equal((await history.readAll()).length, 2);
  const orphan = join(base, `.history.2147483647.1.test.tmp`);
  await writeFile(orphan, serializeHistoryJsonl([record("C")]));
  const before = await readdir(base);
  assert.equal((await readHistoryFile(paths.historyPath)).length, 2);
  assert.deepEqual(await readdir(base), before);
  assert.equal((await lstat(orphan)).isFile(), true);
  totals.apply = apply;
  totals.applyMany = applyMany;
  const lease = await acquireWriterLease(paths);
  try {
    const all = await recoverHistoryFile(paths.historyPath, lease);
    assert.equal(all.length, 3);
    await createUsageCommitter(history, totals).recover();
    assert.equal((await history.readAll()).length, 1);
    const ledger = await totals.read();
    for (const id of ["A", "B", "C"]) assert.equal(ledger.sessions[id].responseCount, 1);
    await createUsageCommitter(history, totals).recover();
    assert.equal((await totals.read()).sessions.C.responseCount, 1);
  } finally { await lease.release(); }
});

test("usage budget preserves durable pending identities and refuses new promises", async (context) => {
  const base = await directory(context);
  const history = createHistoryStorage(join(base, "history"), { maxRecords: 1 });
  const totals = createTotalsStorage(join(base, "totals"));
  const apply = totals.apply.bind(totals);
  const applyMany = totals.applyMany.bind(totals);
  totals.apply = async () => { throw eio(); };
  totals.applyMany = async () => { throw eio(); };
  const usage = createUsageCommitter(history, totals, { maxPendingRecords: 1 });
  await usage.upsert(record("A"));
  await assert.rejects(usage.upsert(record("B")), PersistenceBackpressureError);
  assert.deepEqual((await history.readAll()).map((r) => r.messageID), ["A"]);
  assert.equal((await usage.close()).pendingCount, 1);
  totals.apply = apply;
  totals.applyMany = applyMany;
  await createUsageCommitter(history, totals).recover();
  assert.equal((await totals.read()).sessions.A.responseCount, 1);
});

test("special session/message keys round-trip without inherited entries or prototype pollution", async (context) => {
  const base = await directory(context);
  const totals = createTotalsStorage(join(base, "totals"));
  assert.deepEqual(await totals.read(), { version: 1, generationBasisVersion: 3, sessions: {}, open: {}, settled: {} });
  for (const id of ["constructor", "__proto__", "toString"]) {
    await totals.apply(record(id));
    await totals.setSessionAgent(id, "fixer");
    await totals.apply(record(id));
  }
  const ledger = await totals.read();
  for (const id of ["constructor", "__proto__", "toString"]) {
    assert.equal(ledger.sessions[id].responseCount, 1);
    assert.equal(ledger.open[id].sessionID, id);
    assert.deepEqual(ledger.sessionAgents?.[id], ["fixer"]);
  }
  await totals.setSessionScope("__proto__", { version: 1, sourceScope: "magic-session", reasons: ["session-agent"] });
  await totals.excludeMessage("__defineGetter__", { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] });
  const scoped = await totals.read();
  assert.equal(scoped.sessionScopes?.["__proto__"].sourceScope, "magic-session");
  assert.equal(scoped.settled["__defineGetter__"], true);
  assert.equal(scoped.messageScopes?.["__defineGetter__"].sourceScope, "magic-message");
  assert.equal(({} as any).responseCount, undefined);
});

test("canonical confirmation honors quality, revisions and exclusions instead of messageID presence", async (context) => {
  const base = await directory(context);
  const history = createHistoryStorage(join(base, "history"), { maxRecords: 1 });
  const totals = createTotalsStorage(join(base, "totals"));
  const revision = (sequence: number, cost: number): MeasuredHistoryRecord => ({ ...record("A", { cost }), update: {
    source: "live", instanceID: "writer", sequence, receivedAt: sequence,
    fingerprint: String(sequence), seenFingerprints: Array.from({ length: sequence }, (_, index) => String(index + 1)),
  } });
  await totals.apply(revision(1, 1));
  await history.upsert(revision(2, 4));
  const usage = createUsageCommitter(history, totals);
  await usage.recover();
  assert.equal((await totals.read()).sessions.A.cost, 4);
  await usage.upsert({ ...revision(1, 1), quality: "provisional" });
  assert.equal((await totals.read()).sessions.A.cost, 4);
  await usage.upsert({ ...revision(3, 5), scope: { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] } });
  assert.equal((await totals.read()).sessions.A.responseCount, 0);
  await usage.upsert(revision(4, 6));
  assert.equal((await totals.read()).sessions.A.responseCount, 0);
});

test("history EIO keeps an undurable exact snapshot for cross-session retry", async (context) => {
  const base = await directory(context);
  const history = createHistoryStorage(join(base, "history"), { maxRecords: 1 });
  const totals = createTotalsStorage(join(base, "totals"));
  const upsert = history.upsertWithSnapshot!.bind(history);
  let fail = true;
  history.upsertWithSnapshot = async (...args) => { if (fail) { fail = false; throw eio(); } return upsert(...args); };
  const usage = createUsageCommitter(history, totals);
  assert.equal((await usage.upsert(record("A"))).committed, false);
  assert.equal((await usage.upsert(record("B"))).pendingCount, 0);
  assert.equal((await totals.read()).sessions.A.responseCount, 1);
  assert.equal((await totals.read()).sessions.B.responseCount, 1);
});

test("corrupt totals recovery fails explicitly so the server can quarantine rather than silently prune", async (context) => {
  const base = await directory(context);
  const history = createHistoryStorage(join(base, "history"), { maxRecords: 1 });
  await writeHistoryFile(join(base, "history"), [record("A"), record("B")]);
  await writeFile(join(base, "totals"), "{bad");
  await assert.rejects(createUsageCommitter(history, createTotalsStorage(join(base, "totals"))).recover(), SyntaxError);
  assert.equal((await history.readAll()).length, 2);
});

test("abnormal writer death preserves durable usage and activity for takeover, but not undurable promises", async (context) => {
  const base = await directory(context);
  const paths = await prepareLedgerPaths(base, {});
  const modules = (file: string) => JSON.stringify(new URL(`../src/${file}.ts`, import.meta.url).href);
  const owner = child(`
    import {acquireWriterLease,createUsageCommitter,createReliableActivityWriter} from ${JSON.stringify(persistenceURL)};
    import {createHistoryStorage} from ${modules("storage")};
    import {createTotalsStorage} from ${modules("totals-storage")};
    import {createActivityLedger} from ${modules("runs-storage")};
    const paths=${JSON.stringify(paths)}; const lease=await acquireWriterLease(paths);
    const history=createHistoryStorage(paths.historyPath,{maxRecords:1,lease});
    const totals=createTotalsStorage(paths.totalsPath,{lease}); totals.apply=async()=>{throw new Error('EIO')};
    const usage=createUsageCommitter(history,totals); await usage.upsert(${JSON.stringify(record("A"))});
    const runs=createActivityLedger(paths.runsPath,{lease}); const writer=createReliableActivityWriter(runs,{lease});
    await writer.enqueue(${JSON.stringify([event("busy", "busy", 10), event("idle", "idle", 20)])});
    console.log('DURABLE'); setInterval(()=>lease.assertOwned(paths.historyPath),1000);
  `);
  context.after(async () => { if (owner.exitCode === null && !owner.killed) { owner.kill("SIGKILL"); await once(owner, "exit"); } });
  let stderr = "";
  owner.stderr!.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    owner.stdout!.on("data", (chunk) => { if (String(chunk).includes("DURABLE")) resolve(); });
    owner.on("exit", (code) => reject(new Error(`writer died early ${code}: ${stderr}`)));
  });
  owner.kill("SIGKILL"); await once(owner, "exit");
  const lease = await acquireWriterLease(paths);
  try {
    await recoverHistoryFile(paths.historyPath, lease);
    const totals = createTotalsStorage(paths.totalsPath, { lease });
    const usage = createUsageCommitter(createHistoryStorage(paths.historyPath, { maxRecords: 1, lease }), totals);
    await usage.recover(); await usage.recover();
    assert.equal((await totals.read()).sessions.A.responseCount, 1);
    assert.equal(replayActivity(await readActivityFile(paths.runsPath)).activeMillisecondsByRoot.get("s"), 10);
  } finally { await lease.release(); }
});

test("Node built-in SQLite can load the module, contend with Bun and acquire after release", async (context) => {
  if (spawnSync("node", ["--version"]).status !== 0) { context.skip("Node executable unavailable"); return; }
  const base = await directory(context);
  const paths = await prepareLedgerPaths(base, {});
  const lease = await acquireWriterLease(paths);
  const script = `import {acquireWriterLease} from ${JSON.stringify(persistenceURL)}; try {const l=await acquireWriterLease(${JSON.stringify(paths)});await l.release();process.exit(0);}catch(e){console.error(e);process.exit(13);}`;
  const node = () => spawn("node", ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, HOME: base, TMPDIR: base, XDG_CACHE_HOME: join(base, "cache"), TSX_DISABLE_CACHE: "1",
    },
  });
  assert.equal(await exitCode(node()), 13);
  await lease.release();
  const successor = node();
  let stderr = ""; successor.stderr!.on("data", (data) => { stderr += data; });
  assert.equal(await exitCode(successor), 0, stderr);
});
