import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScopeRegistry } from "../src/scope.js";
import { updateSpeedTotals, type MeasuredHistoryRecord } from "../src/statistics.js";
import { createHistoryStorage } from "../src/storage.js";
import { createTotalsStorage } from "../src/totals-storage.js";
import {
  buildSessionDetailsTree, childRows, createActiveState, createRuntimeStore,
  handleMessageUpdated, handleSessionLifecycle, hasLiveTaskWallActivity,
  hydrateHistoryState, mergeHistoryLayers, projectSessionTotals, recordDelta,
  recordStepFallback, recordStepStarted, recordTuiObservationLifecycle,
  recordTuiPartMetadata, reloadHistory,
} from "../src/tui.js";

const api = { state: { session: { get: () => undefined } }, ui: { toast: () => undefined } } as unknown as TuiPluginApi;
function sessionUsage(store: ReturnType<typeof createRuntimeStore>, sessionID: string) {
  const records = mergeHistoryLayers(store.records, store.optimistic, Number.MAX_SAFE_INTEGER, store.optimisticQuality, store.optimisticOrder);
  const { tokens, cost, responseCount } = projectSessionTotals(store.totalsLedger, records, store.sessionParents, sessionID).direct;
  return { tokens, cost, responseCount };
}
async function testDirectory(prefix: string): Promise<string> {
  const root = join(homedir(), ".cache", "tokpulse-tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
function completion(id: string, output: number, reasoning = 0, start = 0, completed = 1200) {
  return { type: "message.updated", timestamp: completed, properties: { info: {
    id, sessionID: "s", role: "assistant", cost: output,
    tokens: { input: 1, output, reasoning }, time: { created: start, completed },
  } } };
}
function snapshot(id: string, messageID: string, type: string, end?: number, text = "") {
  return { type: "message.part.updated", timestamp: end ?? 10, properties: { part: {
    id, messageID, sessionID: "s", type, text, time: { start: 100, ...(end === undefined ? {} : { end }) },
  } } };
}
function send(store: ReturnType<typeof createRuntimeStore>, event: any, receivedAt = event.timestamp ?? 0, receivedMono = receivedAt): boolean {
  switch (event.type) {
    case "message.part.updated": recordTuiPartMetadata(store, event.properties, event, receivedAt); return false;
    case "message.updated": return handleMessageUpdated(store, api, event.properties, event, 4, receivedAt);
    case "session.next.step.started": recordStepStarted(store, event.properties, event); return false;
    case "session.next.step.ended": recordStepFallback(store, event.properties, event); return false;
    case "server.connected":
    case "workspace.status.changed": recordTuiObservationLifecycle(store, event.type, event.properties, event, receivedAt); return false;
    case "session.next.retried":
    case "session.next.step.failed":
    case "session.error":
    case "session.idle":
    case "session.status": return handleSessionLifecycle(store, api, event.type, event.properties, event, 4);
    default: recordDelta(store, event.properties, event, event.type === "message.part.delta" ? "legacy" : "v2", undefined, 4, receivedAt, receivedMono); return false;
  }
}
function completeObservedResponse(store: ReturnType<typeof createRuntimeStore>, id: string) {
  beginObserved(store, id);
  send(store, completion(id, 10));
}

function beginObserved(store: ReturnType<typeof createRuntimeStore>, id = "m", created = 0, receivedAt = 10) {
  send(store, { type: "message.updated", timestamp: receivedAt, properties: { info: {
    id, sessionID: "s", role: "assistant", time: { created },
  } } });
  send(store, { type: "session.next.step.started", timestamp: receivedAt + 10,
    properties: { sessionID: "s", messageID: id, stepID: `${id}-step` } });
}

test("TUI totals snapshot parses normalized cumulative names, survives empty history and reads legacy maps safely", async () => {
  const directory = await testDirectory("agent-names-");
  const store = createRuntimeStore(1, 0);
  try {
    const historyPath = join(directory, "history.jsonl");
    const totalsPath = join(directory, "totals.json");
    await writeFile(historyPath, "");
    store.sessionParents.set("child", "root");
    const base = { ...store.totalsLedger, sessions: { child: { tokens: { input: 1, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 1, responseCount: 2 } } };
    for (const sessionAgents of [
      { child: [" oracle ", "fixer", "fixer", "compaction", "", "bad\nname", "x".repeat(257)], blank: [" "], malformed: "designer" },
      undefined, null, 42, ["fixer"],
    ]) {
      const bytes = JSON.stringify({ ...base, ...(sessionAgents !== undefined ? { sessionAgents } : {}) });
      await writeFile(totalsPath, bytes);
      await reloadHistory(store, api, historyPath, totalsPath, 1);
      assert.deepEqual(childRows(store.records, "root", store)[0].agents, sessionAgents && typeof sessionAgents === "object" && !Array.isArray(sessionAgents) ? ["fixer", "oracle"] : []);
      assert.equal(store.totalsLedger.sessionAgents?.malformed, undefined);
      assert.equal(store.totalsLedger.sessionAgents?.blank, undefined);
      assert.equal(await readFile(totalsPath, "utf8"), bytes, "TUI reads names without rewriting the server ledger");
    }
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("TUI legacy disk confirmation retains observed agent while accepting canonical usage and LAST", async () => {
  const directory = await testDirectory("agent-confirmation-");
  const store = createRuntimeStore(1, 0);
  try {
    const historyPath = join(directory, "history.jsonl");
    const totalsPath = join(directory, "totals.json");
    const event = completion("m", 10, 0, 0, 100);
    Object.assign(event.properties.info, { agent: "fixer" });
    send(store, event, 100);
    const local = store.records[0];
    const { agent: _agent, ...legacy } = local;
    const disk = { ...legacy, tokens: { ...local.tokens, output: 20 } };
    await writeFile(historyPath, JSON.stringify(disk) + "\n");
    for (let reload = 0; reload < 2; reload++) {
      await reloadHistory(store, api, historyPath, totalsPath, 1);
      assert.equal(store.records[0].agent, "fixer");
      assert.equal(store.records[0].tokens.output, 20, "metadata retention must not pin old usage");
      assert.equal(store.lastCompletedBySession.get("s")?.record.agent, "fixer");
    }
    await writeFile(historyPath, JSON.stringify({ ...disk, agent: "fixer" }) + "\n");
    await reloadHistory(store, api, historyPath, totalsPath, 1);
    assert.equal(store.optimistic.has("m"), false, "named disk confirmation retires the overlay normally");
    assert.equal(store.records[0].agent, "fixer");
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("rejected completion usage still retires its live direct and owned pending without closing the next response", () => {
  for (const rejection of ["missing-reasoning", "stale-revision", "settled-tombstone"] as const) {
    const store = createRuntimeStore(5, 0);
    try {
      const prior = { sessionID: "s", quality: "exact" as const, tokens: { input: 1, output: 10, reasoning: 3, cacheRead: 0, cacheWrite: 0 }, cost: 1,
        update: { source: "live" as const, instanceID: "prior", sequence: 2, receivedAt: 2, revision: 5, fingerprint: "prior", seenFingerprints: ["prior"] } };
      beginObserved(store);
      store.totalsLedger = { ...store.totalsLedger, sessions: { s: { tokens: prior.tokens, cost: 1, responseCount: 1 } },
        settled: { m: rejection === "settled-tombstone" ? true : prior } };
      const pending = createActiveState("__pending__:s", "s", 30);
      pending.ownerMessageID = "m";
      pending.responseEpoch = store.active.get("m")!.responseEpoch;
      store.active.set(pending.messageID, pending);
      const event = completion("m", 5, 0);
      if (rejection === "missing-reasoning") delete (event.properties.info.tokens as { reasoning?: number }).reasoning;
      if (rejection === "stale-revision") Object.assign(event, { revision: 4 });
      assert.equal(send(store, event), false, rejection);
      assert.equal(store.active.size, 0, rejection);
      assert.equal(store.sessionRuntime.get("s")!.activeMessageID, undefined);
      assert.equal(store.totalsLedger.sessions.s.tokens.reasoning, 3);
      send(store, { type: "message.part.delta", timestamp: 1300, properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "late" } });
      assert.equal(store.active.size, 0, "closed IDs do not resurrect");
      beginObserved(store, "next", 1300, 1310);
      send(store, event, 1400);
      assert.equal(store.sessionRuntime.get("s")!.activeMessageID, "next");
      assert.equal(store.active.has("next"), true);
    } finally { store.disposeSignals(); }
  }
});

test("invalidated usage reload still retires an observed authoritative completion, never a newer response", async () => {
  const directory = await testDirectory("tui-invalidated-completion-");
  const path = join(directory, "history.jsonl");
  const record = { version: 1, messageID: "m", sessionID: "s", quality: "exact", tokens: { input: 1, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0, time: { start: 0, completed: 100 }, samples: [] };
  await writeFile(path, JSON.stringify(record) + "\n");
  try {
    for (const newer of [false, true]) {
      const store = createRuntimeStore(5, 0);
      try {
        beginObserved(store);
        if (newer) beginObserved(store, "next", 200, 210);
        store.historyGeneration = 2;
        const ledger = store.totalsLedger;
        await reloadHistory(store, api, path, join(directory, "totals.json"), 5, 1);
        assert.equal(store.completedMessageIDs.has("m"), true, "seen completion is a lifecycle fact even when usage generation is obsolete");
        assert.equal(store.active.has("m"), false);
        assert.equal(store.active.has("next"), newer);
        assert.equal(store.sessionRuntime.get("s")!.activeMessageID, newer ? "next" : undefined);
        send(store, { type: "message.part.delta", timestamp: 300, properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "late" } });
        assert.equal(store.active.has("m"), false);
        assert.equal(store.totalsLedger, ledger, "stale generation cannot commit its usage ledger");
        assert.equal(store.records.length, 0, "latest drain still owns history/usage application");
      } finally { store.disposeSignals(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("same-SID compaction tombstones filter history and LAST but leave the user's other usage intact", () => {
  for (const legacy of [false, true]) {
    const store = createRuntimeStore(5, 0);
    try {
      completeObservedResponse(store, "user");
      const user = store.records[0];
      const compact = { ...user, messageID: "compact", tokens: { ...user.tokens, output: 1000 }, time: { ...user.time, completed: 2000 } };
      const registry = createScopeRegistry();
      const proof = registry.observeMessageMetadata("s", { role: "assistant", agent: "compaction" });
      store.totalsLedger = { ...store.totalsLedger, settled: { user: true, compact: legacy ? true : { sessionID: "s", quality: "exact", tokens: compact.tokens, cost: compact.cost, excluded: proof } },
        ...(legacy ? { messageScopes: { compact: proof } } : {}), sessions: { s: { tokens: user.tokens, cost: user.cost, responseCount: 1 } } };
      hydrateHistoryState(store, [user, compact]);
      assert.equal(store.lastCompletedBySession.get("s")!.record.messageID, "user");
      assert.equal(sessionUsage(store, "s").tokens.output, 10);
      assert.equal(buildSessionDetailsTree(store, "s").nodes.length, 1);
      assert.equal(projectSessionTotals(store.totalsLedger, [user, compact], new Map(), "s").direct.tokens.output, 10);
    } finally { store.disposeSignals(); }
  }
});

test("TUI envelope revisions reject stale updates and authorize a newer return to previously seen facts", () => {
  const store = createRuntimeStore(1, 0);
  try {
    send(store, { ...completion("m", 10, 0, 0, 100), revision: 1 }, 1);
    send(store, { ...completion("m", 0, 0, 0, 200), revision: 3 }, 2);
    assert.equal(send(store, { ...completion("m", 5), revision: 2 }, 3), false);
    assert.equal(store.records[0].tokens.output, 0);
    send(store, { ...completion("m", 10, 0, 0, 100), revision: 4 }, 4);
    assert.equal(store.records[0].tokens.output, 10);
    assert.equal(sessionUsage(store, "s").responseCount, 1);
  } finally { store.disposeSignals(); }
});

test("trimmed optimistic usage survives disk confirmation, settled replay and restart", async () => {
  const directory = await testDirectory("tui-data-");
  const path = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  const history = createHistoryStorage(path, { maxRecords: 1 });
  const totals = createTotalsStorage(totalsPath);
  const store = createRuntimeStore(1, 0);
  const restarted = createRuntimeStore(1, 0);
  try {
    completeObservedResponse(store, "m");
    const first = store.records[0];
    send(store, completion("new", 20, 0, 300, 500));
    const second = store.records[0];
    assert.equal(store.records.length, 1);
    assert.equal(sessionUsage(store, "s").tokens.output, 30);
    await history.upsert(first);
    await totals.apply(first, { retainedMessageIDs: ["m"] });
    await history.upsert(second);
    store.totalsLedger = await totals.apply(second, { retainedMessageIDs: ["new"] });
    await reloadHistory(store, api, path, totalsPath, 1);
    const before = sessionUsage(store, "s");
    assert.equal(before.tokens.output, 30);
    assert.equal(send(store, completion("m", 10)), false);
    assert.deepEqual(sessionUsage(store, "s"), before);
    await reloadHistory(restarted, api, path, totalsPath, 1);
    assert.equal(send(restarted, completion("m", 10)), false);
    assert.deepEqual(sessionUsage(restarted, "s"), before);
    assert.equal(restarted.active.size, 0);
  } finally { store.disposeSignals(); restarted.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("completed historical tool/user snapshots never restart active, run status or ticker and leave pending/focus alone", () => {
  const store = createRuntimeStore(1, 0);
  try {
    send(store, snapshot("historical-p", "old", "text", 20));
    assert.equal(store.active.size, 0);
    assert.equal(store.sessionRuntime.size, 0);
    assert.equal(hasLiveTaskWallActivity(store), false);
    send(store, completion("m", 10));
    send(store, { type: "session.idle", timestamp: 400, properties: { sessionID: "s" } });
    const revision = store.revision();
    send(store, snapshot("p", "m", "text", 200));
    send(store, { type: "message.part.updated", properties: { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", time: { end: 1000 } } } } });
    send(store, { type: "message.updated", properties: { info: { id: "user", sessionID: "s", role: "user" } } });
    send(store, snapshot("user-p", "user", "text"));
    send(store, { type: "message.part.delta", timestamp: 500, properties: { sessionID: "s", messageID: "user", partID: "user-p", field: "text", delta: "user text" } });
    assert.equal(store.active.size, 0);
    assert.equal(store.sessionRuntime.get("s")?.status, "idle");
    assert.equal(hasLiveTaskWallActivity(store), false);
    assert.equal(store.revision(), revision);
    const pending = createActiveState("__pending__:s", "s", 500);
    store.active.set("__pending__:s", pending);
    store.focusSessionID = "elsewhere";
    send(store, completion("m", 10));
    send(store, { type: "session.next.step.started", timestamp: 600, properties: { sessionID: "s", assistantMessageID: "m" } });
    assert.equal(store.active.size, 1);
    assert.equal(store.active.get("__pending__:s"), pending);
    assert.equal(store.focusSessionID, "elsewhere");
  } finally { store.disposeSignals(); }
});

test("canonical backfill rejects unversioned stale usage but accepts a later explicit correction", async () => {
  const directory = await testDirectory("tui-backfill-projection-");
  const path = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  const store = createRuntimeStore(1, 0);
  try {
    completeObservedResponse(store, "m");
    const live = store.records[0] as MeasuredHistoryRecord;
    const response = { generatedTokens: 10, durationMs: 600, estimated: true };
    const contribution = { sessionID: "s", quality: "provisional", tokens: live.tokens, cost: live.cost,
      speed: { response }, speedBackfill: { version: 1, source: "server" } };
    const ledger = { version: 1, sessions: { s: { tokens: live.tokens, cost: live.cost, responseCount: 1,
      speed: updateSpeedTotals(undefined, { response }, 1) } }, open: {}, settled: { m: contribution } };
    const staleUsage = { ...live, quality: "provisional", update: undefined, speed: undefined,
      tokens: { ...live.tokens, output: 999 }, cost: 999 };
    await writeFile(path, JSON.stringify(staleUsage) + "\n");
    await writeFile(totalsPath, JSON.stringify(ledger));
    store.optimistic.clear();
    await reloadHistory(store, api, path, totalsPath, 1);
    const projected = projectSessionTotals(store.totalsLedger, store.records, store.sessionParents, "s").direct;
    assert.equal(projected.tokens.output, 10); assert.equal(projected.cost, live.cost);
    assert.equal(projected.responseCount, 1); assert.equal(projected.speed?.response.durationMs, 600);
    assert.equal(send(store, { ...completion("m", 0), revision: 1 }), true);
    const corrected = projectSessionTotals(store.totalsLedger,
      mergeHistoryLayers(store.records, store.optimistic, 1, store.optimisticQuality, store.optimisticOrder), store.sessionParents, "s").direct;
    assert.equal(corrected.tokens.output, 0); assert.equal(corrected.cost, 0); assert.equal(corrected.responseCount, 1);
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});
