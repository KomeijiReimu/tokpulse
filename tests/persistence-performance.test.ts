import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistoryRecord } from "../src/core.js";
import { acquireWriterLease, createUsageCommitter, prepareLedgerPaths } from "../src/persistence.js";
import { createHistoryStorage, writeHistoryFile } from "../src/storage.js";
import { createTotalsStorage } from "../src/totals-storage.js";
import { classifySessionMetadata, classifyMessageMetadata } from "../src/scope.js";
const { spyOn } = require("bun:test");

function record(index: number): HistoryRecord {
  return { version: 1, messageID: `m${index}`, sessionID: `s${index}`, quality: "exact", tokens: {
    input: 1, output: 7, reasoning: 2, cacheRead: 3, cacheWrite: 4,
  }, cost: 2, time: { start: 0, completed: 100 }, samples: [] };
}
async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const cache = join(homedir(), ".cache", "tokpulse-tests");
  await fs.mkdir(cache, { recursive: true });
  const base = await fs.mkdtemp(join(cache, "persistence-performance-"));
  const paths = await prepareLedgerPaths(base, {});
  const lease = await acquireWriterLease(paths);
  context.after(async () => { await lease.release(); await fs.rm(base, { recursive: true, force: true }); });
  return { paths, lease };
}
function countIO(paths: { historyPath: string; totalsPath: string }, fault?: { phase: "none" | "before" | "after" }) {
  const counts = { historyReads: 0, totalsReads: 0, historyWrites: 0, totalsWrites: 0, totalsSerializations: 0 };
  const open = fs.open;
  const rename = fs.rename;
  const stringify = JSON.stringify;
  const opened = spyOn(fs, "open").mockImplementation((path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
    if (String(path) === paths.historyPath) counts.historyReads++;
    if (String(path) === paths.totalsPath) counts.totalsReads++;
    return open(path, flags, mode);
  });
  const renamed = spyOn(fs, "rename").mockImplementation(async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (String(to) === paths.historyPath) counts.historyWrites++;
    if (String(to) === paths.totalsPath) counts.totalsWrites++;
    if (String(to) === paths.totalsPath && fault?.phase === "before") throw new Error("EIO before publication");
    await rename(from, to);
    if (String(to) === paths.totalsPath && fault?.phase === "after") throw new Error("EIO after publication");
  });
  const serialized = spyOn(JSON, "stringify").mockImplementation((value: any, replacer?: any, space?: any) => {
    if (value?.sessions && value?.open && value?.settled) counts.totalsSerializations++;
    return stringify(value, replacer, space);
  });
  return { counts, restore() { opened.mockRestore(); renamed.mockRestore(); serialized.mockRestore(); } };
}

test("large metadata batch publishes once and replay does not amplify writes", async (context) => {
  const { paths, lease } = await fixture(context);
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  const size = 1000;
  const before = await totals.applyMany(Array.from({ length: size }, (_, index) => ({ ...record(index), agent: "build" })));
  const hidden = classifySessionMetadata({ agent: "dreamer" });
  const updates = Array.from({ length: size }, (_, index) => ({ sessionID: `s${index}`, agents: ["fixer"], scope: hidden }));
  const io = countIO(paths);
  try {
    const canonical = await totals.setSessionMetadataMany(updates);
    assert.deepEqual(io.counts, { historyReads: 0, totalsReads: 1, historyWrites: 0, totalsWrites: 1, totalsSerializations: 1 });
    assert.deepEqual(canonical.sessions, before.sessions);
    assert.equal(Object.keys(canonical.sessionScopes!).length, size);
    assert.deepEqual(canonical.sessionAgents!.s999, ["build", "fixer"]);
    assert.equal(canonical.sessionScopes!.s999.sourceScope, "magic-session");
    assert.deepEqual(await totals.setSessionMetadataMany(updates), canonical);
    assert.equal(io.counts.totalsWrites, 1);
    assert.equal(io.counts.totalsSerializations, 1);
  } finally { io.restore(); }
});

test("invalid batch performs no ledger I/O and legacy migration shares one publication", async (context) => {
  const { paths, lease } = await fixture(context);
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  const invalidIO = countIO(paths);
  try {
    await assert.rejects(totals.setSessionMetadataMany([
      { sessionID: "normal", agents: ["build"] },
      { sessionID: "bad", scope: classifyMessageMetadata({ providerID: "magic-context" }) },
    ]), /scope/);
    assert.deepEqual(invalidIO.counts, { historyReads: 0, totalsReads: 0, historyWrites: 0, totalsWrites: 0, totalsSerializations: 0 });
  } finally { invalidIO.restore(); }
  await totals.seed([]);
  const legacy = await totals.read();
  delete legacy.generationBasisVersion;
  await fs.writeFile(paths.totalsPath, JSON.stringify(legacy));
  const migrationIO = countIO(paths);
  try {
    const canonical = await totals.setSessionMetadataMany([{ sessionID: "normal", agents: ["build"] }]);
    assert.equal(canonical.generationBasisVersion, 3);
    assert.deepEqual(migrationIO.counts, { historyReads: 0, totalsReads: 1, historyWrites: 0, totalsWrites: 1, totalsSerializations: 1 });
  } finally { migrationIO.restore(); }
  await lease.release();
  const releasedIO = countIO(paths);
  try {
    await assert.rejects(totals.setSessionMetadataMany([{ sessionID: "normal", agents: ["fixer"] }]), /lease/);
    assert.equal(releasedIO.counts.totalsReads, 0);
    assert.equal(releasedIO.counts.totalsWrites, 0);
  } finally { releasedIO.restore(); }
});

test("cross-session metadata batch failure and uncertain success never cache a false confirmation", async (context) => {
  const { paths, lease } = await fixture(context);
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  await totals.applyMany([record(1), record(2)]);
  const before = await fs.readFile(paths.totalsPath, "utf8");
  const updates = [
    { sessionID: "s1", agents: ["fixer"], scope: classifySessionMetadata({ agent: "dreamer" }) },
    { sessionID: "s2", agents: ["oracle", "build"] },
    { sessionID: "s2", agents: ["designer"] },
  ];
  const fault = { phase: "before" as "before" | "after" | "none" };
  let io = countIO(paths, fault);
  try {
    await assert.rejects(totals.setSessionMetadataMany(updates), /before publication/);
    assert.equal(io.counts.totalsReads, 1);
    assert.equal(io.counts.totalsSerializations, 1);
  } finally { io.restore(); }
  assert.equal(await fs.readFile(paths.totalsPath, "utf8"), before);
  fault.phase = "after";
  io = countIO(paths, fault);
  try { await assert.rejects(totals.setSessionMetadataMany(updates), /after publication/); }
  finally { io.restore(); }
  fault.phase = "none";
  io = countIO(paths, fault);
  try {
    const canonical = await createTotalsStorage(paths.totalsPath, { lease }).setSessionMetadataMany(updates);
    assert.deepEqual(io.counts, { historyReads: 0, totalsReads: 1, historyWrites: 0, totalsWrites: 0, totalsSerializations: 0 });
    assert.deepEqual(canonical.sessionAgents!.s1, ["fixer"]);
    assert.deepEqual(canonical.sessionAgents!.s2, ["build", "designer", "oracle"]);
    assert.equal(canonical.sessionScopes!.s1.sourceScope, "magic-session");
    assert.equal(canonical.sessions.s1.responseCount, 1);
    assert.equal(canonical.sessions.s2.cost, 2);
  } finally { io.restore(); }
});

test("large recovery preserves all usage with constant ledger I/O", async (context) => {
  const size = 4000;
  const { paths, lease } = await fixture(context);
  await writeHistoryFile(paths.historyPath, Array.from({ length: size }, (_, index) => record(index)));
  const history = createHistoryStorage(paths.historyPath, { maxRecords: 1, lease });
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  const usage = createUsageCommitter(history, totals);
  const io = countIO(paths);
  try {
    await usage.recover();
    assert.deepEqual(io.counts, { historyReads: 2, totalsReads: 1, historyWrites: 1, totalsWrites: 1, totalsSerializations: 1 });
  } finally { io.restore(); }
  const ledger = await totals.read();
  assert.equal(Object.keys(ledger.sessions).length, size);
  assert.equal(Object.values(ledger.sessions).reduce((sum, session) => sum + session.cost, 0), size * 2);
  assert.equal((await history.readAll()).length, 1);
  await usage.recover();
  assert.equal((await totals.read()).sessions.s0.responseCount, 1);
});

test("idle retries and clean close perform zero ledger I/O", async (context) => {
  const { paths, lease } = await fixture(context);
  const history = createHistoryStorage(paths.historyPath, { lease });
  const usage = createUsageCommitter(history, createTotalsStorage(paths.totalsPath, { lease }));
  await usage.recover();
  const io = countIO(paths);
  try {
    for (let index = 0; index < 10; index++) assert.equal((await usage.retryPending()).pendingCount, 0);
    await usage.close();
    assert.deepEqual(io.counts, { historyReads: 0, totalsReads: 0, historyWrites: 0, totalsWrites: 0, totalsSerializations: 0 });
  } finally { io.restore(); }
});

test("healthy upsert writes each ledger once and public reads observe external replacement", async (context) => {
  const { paths, lease } = await fixture(context);
  const history = createHistoryStorage(paths.historyPath, { maxRecords: 1, lease });
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  const usage = createUsageCommitter(history, totals);
  await usage.recover();
  const io = countIO(paths);
  try {
    for (let index = 0; index < 20; index++) assert.equal((await usage.upsert(record(index))).committed, true);
    assert.deepEqual(io.counts, { historyReads: 20, totalsReads: 20, historyWrites: 20, totalsWrites: 20, totalsSerializations: 20 });
  } finally { io.restore(); }
  // Snapshot reuse is confined to the mutation: public reads always observe
  // external replacement rather than serving a fake persistent cache.
  await writeHistoryFile(paths.historyPath, [record(100)]);
  assert.equal((await history.read())[0].messageID, "m100");
  assert.equal((await history.readAll())[0].messageID, "m100");
});

test("failed or uncertain recovery batch protects every canonical contribution until retry confirms the whole batch", async (context) => {
  const { paths, lease } = await fixture(context);
  await writeHistoryFile(paths.historyPath, [record(1), record(2), record(3)]);
  const history = createHistoryStorage(paths.historyPath, { maxRecords: 1, lease });
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  const applyMany = totals.applyMany.bind(totals);
  let mode = "failed";
  totals.applyMany = async (...args) => {
    if (mode === "failed") throw new Error("EIO");
    const result = await applyMany(...args);
    if (mode === "uncertain") throw new Error("EIO after rename");
    return result;
  };
  const usage = createUsageCommitter(history, totals);
  await usage.recover();
  assert.equal((await history.readAll()).length, 3);
  mode = "uncertain";
  assert.equal((await usage.retryPending()).pendingCount, 3);
  assert.equal((await history.readAll()).length, 3);
  mode = "healthy";
  assert.equal((await usage.retryPending()).pendingCount, 0);
  assert.equal((await history.readAll()).length, 1);
  const ledger = await totals.read();
  for (const index of [1, 2, 3]) { assert.equal(ledger.sessions[`s${index}`].responseCount, 1); assert.equal(ledger.sessions[`s${index}`].cost, 2); }
});

test("batched recovery retains exact/revision authority and exclusions rather than trusting existing IDs", async (context) => {
  const { paths, lease } = await fixture(context);
  const totals = createTotalsStorage(paths.totalsPath, { lease });
  const history = createHistoryStorage(paths.historyPath, { maxRecords: 1, lease });
  const update = (sequence: number) => ({ source: "live" as const, instanceID: "writer", sequence, receivedAt: sequence,
    fingerprint: String(sequence), seenFingerprints: Array.from({ length: sequence }, (_, index) => String(index + 1)) });
  await totals.apply({ ...record(1), update: update(1) } as HistoryRecord);
  await totals.apply({ ...record(2), cost: 6, update: update(2) } as HistoryRecord);
  await totals.apply(record(3));
  await totals.excludeMessage("m3", { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] });
  await writeHistoryFile(paths.historyPath, [
    { ...record(1), cost: 4, update: update(2) } as HistoryRecord,
    { ...record(2), quality: "provisional", cost: 100, update: update(3) } as HistoryRecord,
    { ...record(3), cost: 100, update: update(3) } as HistoryRecord,
    { ...record(4), scope: { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] } },
  ]);
  await createUsageCommitter(history, totals).recover();
  const ledger = await totals.read();
  assert.equal(ledger.sessions.s1.cost, 4);
  assert.equal(ledger.sessions.s1.responseCount, 1);
  assert.equal(ledger.sessions.s2.cost, 6);
  assert.equal(ledger.sessions.s2.responseCount, 1);
  assert.equal(ledger.sessions.s3.responseCount, 0);
  assert.equal(ledger.sessions.s4, undefined);
  assert.equal(ledger.settled.m4, true);
  assert.equal((await history.readAll()).length, 1);
});
