import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { getSessionAverageSummary, selectSpeedMeasurement, type MeasuredHistoryRecord, mergeRecordSpeed, updateSpeedTotals } from "../src/statistics.js";
import { createHistoryStorage } from "../src/storage.js";
import { createTotalsStorage, type TotalsLedger } from "../src/totals-storage.js";
import {
  createActiveState, createRuntimeStore, handleMessageUpdated, handleSessionLifecycle,
  hasLiveTaskWallActivity, historyRecordsEquivalent, mergeHistoryLayers, projectSessionTotals,
  recordDelta, recordStepStarted, recordStepFallback, recordTuiPartMetadata, recordTuiObservationLifecycle, reloadHistory,
  makeLastCompletedSnapshot,
  hydrateHistoryState, cacheSessionParentFromEvent, childRows, buildSessionDetailsTree, taskWallTimeForSession, reloadActivity,
} from "../src/tui.js";
import { createScopeRegistry } from "../src/scope.js";

const api = { state: { session: { get: () => undefined } }, ui: { toast: () => undefined } } as unknown as TuiPluginApi;
function sessionUsageSummary(store: ReturnType<typeof createRuntimeStore>, sessionID: string) {
  const records = mergeHistoryLayers(store.records, store.optimistic, Number.MAX_SAFE_INTEGER, store.optimisticQuality, store.optimisticOrder);
  const totals = projectSessionTotals(store.totalsLedger, records, store.sessionParents, sessionID).direct;
  return getSessionAverageSummary(totals);
}
function speedSummary(record: Parameters<typeof selectSpeedMeasurement>[0]) {
  const selected = selectSpeedMeasurement(record);
  return { available: selected.available, avg: selected.rate ?? 0 };
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
function generatedText(store: ReturnType<typeof createRuntimeStore>, id: string) {
  send(store, { type: "message.updated", timestamp: 10, properties: { info: {
    id, sessionID: "s", role: "assistant", time: { created: 0 },
  } } });
  send(store, { type: "session.next.step.started", timestamp: 20, properties: { sessionID: "s", messageID: id, stepID: `${id}-step` } });
  send(store, snapshot(`${id}-p`, id, "text"));
  send(store, { type: "message.part.delta", timestamp: 100, properties: {
    sessionID: "s", messageID: id, partID: `${id}-p`, field: "text", delta: "hello",
  } });
  send(store, { type: "message.part.delta", timestamp: 1100, properties: {
    sessionID: "s", messageID: id, partID: `${id}-p`, field: "text", delta: "world",
  } });
  send(store, snapshot(`${id}-p`, id, "text", 1150, "helloworld"));
  send(store, completion(id, 10));
}

function beginObserved(store: ReturnType<typeof createRuntimeStore>, id = "m", created = 0, receivedAt = 10) {
  send(store, { type: "message.updated", timestamp: receivedAt, properties: { info: {
    id, sessionID: "s", role: "assistant", time: { created },
  } } });
  send(store, { type: "session.next.step.started", timestamp: receivedAt + 10,
    properties: { sessionID: "s", messageID: id, stepID: `${id}-step` } });
}

test("TUI optimistic completions retain validated info or active agent and preserve it on legacy corrections", () => {
  const store = createRuntimeStore(10, 0);
  try {
    send(store, { type: "message.updated", timestamp: 10, properties: { info: {
      id: "m", sessionID: "s", role: "assistant", agent: " custom-fixer ", time: { created: 0 },
    } } });
    assert.equal(store.active.get("m")!.agent, "custom-fixer");
    send(store, completion("m", 10, 0, 0, 100), 100);
    assert.equal(store.records[0].agent, "custom-fixer", "completion lacking agent retains active identity");
    send(store, completion("m", 20, 0, 0, 200), 200);
    assert.equal(store.records[0].agent, "custom-fixer", "legacy correction cannot erase previous identity");
    const next = completion("next", 10, 0, 250, 300);
    Object.assign(next.properties.info, { agent: " oracle " });
    send(store, next, 300);
    assert.equal(store.records.find((record) => record.messageID === "next")?.agent, "oracle");
    const unknown = completion("unknown", 10, 0, 350, 400);
    Object.assign(unknown.properties.info, { agent: "bad\u001bname", mode: "designer", title: "fixer" });
    send(store, unknown, 400);
    assert.equal(store.records.find((record) => record.messageID === "unknown")?.agent, undefined);
    const compaction = completion("compact", 100, 0, 450, 500);
    Object.assign(compaction.properties.info, { agent: "compaction" });
    send(store, compaction, 500);
    assert.equal(store.records.some((record) => record.messageID === "compact"), false);
  } finally { store.disposeSignals(); }
});

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

test("TUI live corrections allow explicit zero, smaller usage and shorter duration without old replay rollback", () => {
  const store = createRuntimeStore(1, 0);
  try {
    store.focusSessionID = "unrelated";
    const original = completion("m", 10, 0, 0, 100);
    send(store, original, 1);
    const first = store.records[0] as MeasuredHistoryRecord;
    send(store, completion("m", 0, 0, 0, 200), 2);
    assert.equal(store.records[0].tokens.output, 0);
    assert.equal(store.sessionRuntime.get("s")?.runTotals.output, 0);
    assert.equal(sessionUsageSummary(store, "s").response.rate, 0);
    send(store, completion("m", 8, 0, 0, 300), 3);
    send(store, completion("m", 2, 0, 250, 300), 4);
    assert.equal(store.records[0].tokens.output, 2);
    assert.equal(store.records[0].time.duration, 50);
    assert.equal(sessionUsageSummary(store, "s").response.rate, 40);
    const corrected = store.records[0];
    assert.equal(send(store, original, 5), false);
    assert.equal(store.records[0], corrected);
    assert.equal(store.sessionRuntime.get("s")?.runResponseCount, 1);
    assert.equal(store.focusSessionID, "unrelated");
    const merged = mergeHistoryLayers([first], store.optimistic, 1, store.optimisticQuality, store.optimisticOrder);
    assert.equal(merged[0].tokens.output, 2);
    assert.equal(historyRecordsEquivalent(first, corrected), false);
    const evidenceOnly = { ...corrected, update: { ...(corrected as MeasuredHistoryRecord).update!, sequence: 99 } };
    assert.equal(historyRecordsEquivalent(corrected, evidenceOnly), false);
  } finally { store.disposeSignals(); }
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

test("authoritative hydrate closes same-ID live overlap and late content cannot hide LAST; anonymous content is not LIVE", () => {
  const store = createRuntimeStore(5, 0);
  try {
    beginObserved(store);
    const record = { version: 1 as const, messageID: "m", sessionID: "s", tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
      time: { start: 0, completed: 100 }, samples: [], quality: "exact" as const };
    hydrateHistoryState(store, [record]);
    assert.equal(store.active.size, 0);
    assert.equal(store.active.has("m"), false);
    send(store, { type: "message.part.delta", timestamp: 200, properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "late" } });
    send(store, { type: "session.next.step.started", timestamp: 210, properties: { sessionID: "s", stepID: "unknown" } });
    assert.equal(store.active.has("m"), false);
  } finally { store.disposeSignals(); }
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

test("task busy and anonymous compatibility events cannot invent an owned generation timer", () => {
  const store = createRuntimeStore(1, 0);
  try {
    send(store, { type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const before = store.revision();
    send(store, { type: "session.next.step.started", timestamp: 10, properties: { sessionID: "s", stepID: "unknown" } });
    assert.notEqual(store.active.size, 0, "an anonymous step still creates compatibility state");
    assert.equal(store.revision(), before + 1);
    assert.equal(taskWallTimeForSession(store, "s", 57000), 57000, "real task activity still has its own clock");
    send(store, { type: "session.idle", timestamp: 1000, properties: { sessionID: "s" } });
    assert.equal(hasLiveTaskWallActivity(store), false);
    assert.equal(taskWallTimeForSession(store, "s", 57000), 1000);
  } finally { store.disposeSignals(); }
});

test("late maintenance session identity projects usage, descendants, history, LAST, active unions and details without altering raw ledger", () => {
  const store = createRuntimeStore(10, 0);
  try {
    generatedText(store, "user");
    const rawUser = store.records[0];
    const hidden = { ...rawUser, messageID: "hidden", sessionID: "mc", parentSessionID: "s" };
    const nested = { ...hidden, messageID: "nested", sessionID: "mc-child", parentSessionID: "mc" };
    store.records = [rawUser, hidden, nested];
    store.diskRecords = [...store.records];
    const direct = { tokens: rawUser.tokens, cost: rawUser.cost, responseCount: 1, speed: updateSpeedTotals(undefined, rawUser.speed, 1) };
    store.totalsLedger = { ...store.totalsLedger, sessions: { s: direct, mc: direct, "mc-child": direct }, settled: { user: true, hidden: true, nested: true } };
    store.sessionParents = new Map([["mc", "s"], ["mc-child", "mc"]]);
    const raw = structuredClone(store.totalsLedger);
    for (const [sid, at] of [["s", 0], ["mc", 100], ["mc-child", 200]] as const) send(store, { type: "session.status", timestamp: at, properties: { sessionID: sid, status: "busy" } });
    send(store, { type: "session.idle", timestamp: 1200, properties: { sessionID: "s" } });
    cacheSessionParentFromEvent(store, { type: "session.updated", properties: { info: { id: "mc", title: "Magic Context dreamer", parentID: "s" } } });
    assert.deepEqual(store.records.map((r) => r.messageID), ["user"]);
    assert.equal(sessionUsageSummary(store, "s").totalGeneratedTokens, 10);
    assert.equal(sessionUsageSummary(store, "s").totalResponseCount, 1);
    assert.deepEqual(childRows(store.records, "s", store), []);
    assert.deepEqual(buildSessionDetailsTree(store, "s").nodes.map((n) => n.sessionID), ["s"]);
    assert.equal(store.active.has("mc-live"), false);
    assert.equal(taskWallTimeForSession(store, "s", 60000), 1200);
    assert.equal(hasLiveTaskWallActivity(store), false);
    assert.ok([...store.taskRuns.values()].every((run) => !run.activeSessions.has("mc") && !run.activeSessions.has("mc-child")));
    assert.deepEqual(store.totalsLedger, raw);
  } finally { store.disposeSignals(); }
});

test("same-SID compaction tombstones filter history and LAST but leave the user's other usage intact", () => {
  for (const legacy of [false, true]) {
    const store = createRuntimeStore(5, 0);
    try {
      generatedText(store, "user");
      const user = store.records[0];
      const compact = { ...user, messageID: "compact", tokens: { ...user.tokens, output: 1000 }, time: { ...user.time, completed: 2000 } };
      const registry = createScopeRegistry();
      const proof = registry.observeMessageMetadata("s", { role: "assistant", agent: "compaction" });
      store.totalsLedger = { ...store.totalsLedger, settled: { user: true, compact: legacy ? true : { sessionID: "s", quality: "exact", tokens: compact.tokens, cost: compact.cost, excluded: proof } },
        ...(legacy ? { messageScopes: { compact: proof } } : {}), sessions: { s: { tokens: user.tokens, cost: user.cost, responseCount: 1, speed: updateSpeedTotals(undefined, user.speed, 1) } } };
      hydrateHistoryState(store, [user, compact]);
      assert.equal(store.lastCompletedBySession.get("s")!.record.messageID, "user");
      assert.equal(sessionUsageSummary(store, "s").totalGeneratedTokens, 10);
      assert.equal(buildSessionDetailsTree(store, "s").nodes.length, 1);
      assert.equal(projectSessionTotals(store.totalsLedger, [user, compact], new Map(), "s").direct.tokens.output, 10);
    } finally { store.disposeSignals(); }
  }
});

test("canonical current SDK idle closes only its local epoch while real child work and newer epochs continue", async () => {
  const directory = await testDirectory("tui-canonical-idle-");
  const store = createRuntimeStore(5, 0);
  const path = join(directory, "runs.jsonl");
  try {
    cacheSessionParentFromEvent(store, { type: "session.created", properties: { info: { id: "child", parentID: "s" } } });
    send(store, { type: "session.status", timestamp: 100, properties: { sessionID: "s", status: "busy" } });
    send(store, { type: "session.status", timestamp: 200, properties: { sessionID: "child", status: "busy" } });
    const facts = [{ version: 1, kind: "lifecycle", sessionID: "s", state: "busy", timestamp: 100, observedAt: 100, instanceID: "current" },
      { version: 1, kind: "lifecycle", sessionID: "s", state: "idle", timestamp: 500, observedAt: 500, instanceID: "current" }];
    await writeFile(path, facts.map((fact) => JSON.stringify(fact)).join("\n") + "\n");
    await reloadActivity(store, api, path);
    assert.equal(store.sessionRuntime.get("s")!.status, "idle");
    assert.equal(hasLiveTaskWallActivity(store), true, "the genuine child is still busy");
    assert.equal(taskWallTimeForSession(store, "s", 1000), 900);
    send(store, { type: "session.idle", timestamp: 1100, properties: { sessionID: "child" } });
    assert.equal(hasLiveTaskWallActivity(store), false);
    assert.equal(taskWallTimeForSession(store, "s", 60000), 1000);
    send(store, { type: "session.status", timestamp: 2000, properties: { sessionID: "s", status: "busy" } });
    await reloadActivity(store, api, path);
    assert.equal(store.sessionRuntime.get("s")!.status, "busy", "old SDK idle cannot freeze the new epoch");
    assert.equal(taskWallTimeForSession(store, "s", 2500), 1500);
    beginObserved(store, "tool-response", 2000, 2010);
    await writeFile(path, [{ ...facts[0], timestamp: 2000, observedAt: 2000 }, { ...facts[1], timestamp: 2200, observedAt: 2200 }].map((fact) => JSON.stringify(fact)).join("\n") + "\n");
    await reloadActivity(store, api, path);
    assert.equal(store.sessionRuntime.get("s")!.status, "idle", "canonical idle closes the root participant even while a tool is running");
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
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
    assert.equal(sessionUsageSummary(store, "s").totalResponseCount, 1);
  } finally { store.disposeSignals(); }
});

test("trimmed optimistic contributions remain direct until disk confirms; settled replay and reload preserve coverage", async () => {
  const directory = await testDirectory("tui-data-");
  const path = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  const history = createHistoryStorage(path, { maxRecords: 1 });
  const totals = createTotalsStorage(totalsPath);
  const store = createRuntimeStore(1, 0);
  const restarted = createRuntimeStore(1, 0);
  try {
    generatedText(store, "m");
    const first = store.records[0];
    send(store, completion("new", 20, 0, 300, 500));
    const second = store.records[0];
    assert.equal(store.records.length, 1);
    assert.equal(sessionUsageSummary(store, "s").totalGeneratedTokens, 30);
    assert.equal(sessionUsageSummary(store, "s").generation.coveredResponseCount, 0);
    await history.upsert(first);
    await totals.apply(first, { retainedMessageIDs: ["m"] });
    await history.upsert(second);
    store.totalsLedger = await totals.apply(second, { retainedMessageIDs: ["new"] });
    await reloadHistory(store, api, path, totalsPath, 1);
    const before = sessionUsageSummary(store, "s");
    assert.equal(before.totalGeneratedTokens, 30);
    assert.equal(before.generation.coveredGeneratedTokens, 0);
    assert.equal(send(store, completion("m", 10)), false);
    assert.deepEqual(sessionUsageSummary(store, "s"), before);
    await reloadHistory(restarted, api, path, totalsPath, 1);
    assert.equal(send(restarted, completion("m", 10)), false);
    assert.deepEqual(sessionUsageSummary(restarted, "s"), before);
    assert.equal(restarted.active.size, 0);
  } finally { store.disposeSignals(); restarted.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("hidden reasoning invalidates generation but corrected wall timing does not overwrite a qualified mono span", () => {
  const store = createRuntimeStore(2, 0);
  try {
    generatedText(store, "hidden");
    generatedText(store, "timing");
    assert.equal(sessionUsageSummary(store, "s").totalResponseCount, 2);
    assert.equal(sessionUsageSummary(store, "s").generation.coveredResponseCount, 0);
    send(store, completion("hidden", 10, 100));
    send(store, completion("timing", 10, 0, 150, 180));
    assert.equal(store.records.find((record) => record.messageID === "hidden")?.speed?.generation, undefined);
    assert.equal(store.records.find((record) => record.messageID === "timing")?.speed?.generation, undefined);
    const summary = sessionUsageSummary(store, "s");
    assert.equal(summary.generation.coveredResponseCount, 0);
    assert.equal(summary.response.coveredGeneratedTokens, 120);
    assert.equal(summary.response.coveredResponseCount, 2);
  } finally { store.disposeSignals(); }
});

test("real legacy reasoning snapshots classify field:text; equal legal delta strings are not deduplicated", () => {
  const store = createRuntimeStore(1, 0);
  try {
    beginObserved(store);
    send(store, snapshot("p", "m", "reasoning"));
    assert.equal(store.active.get("m")?.firstTokenAt, undefined);
    const before = store.revision();
    for (const timestamp of [100, 120]) send(store, { type: "message.part.delta", timestamp, properties: {
      sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "think",
    } });
    assert.equal(store.revision(), before, "content deltas do not project Pulse");
    assert.equal(store.active.get("m")?.legacy.samples.length, 0);
    send(store, snapshot("p", "m", "reasoning", 200, "thinkthink"));
    send(store, completion("m", 0, 100));
    assert.equal(store.records[0].samples.length, 0);
    assert.equal(store.records[0].speed?.generation, undefined);
  } finally { store.disposeSignals(); }
});

test("real v2 textID reasoningID and callID share metadata and exclude tool wait", () => {
  const store = createRuntimeStore(1, 0);
  try {
    send(store, { type: "session.next.text.delta", timestamp: 100, properties: { sessionID: "s", assistantMessageID: "m", textID: "text", delta: "hello" } });
    send(store, { type: "session.next.reasoning.delta", timestamp: 150, properties: { sessionID: "s", assistantMessageID: "m", reasoningID: "reason", delta: "think" } });
    send(store, { type: "session.next.tool.input.delta", timestamp: 200, properties: { sessionID: "s", assistantMessageID: "m", callID: "call", delta: "{}" } });
    send(store, snapshot("text", "m", "text", 190, "hello"));
    send(store, snapshot("reason", "m", "reasoning", 180, "think"));
    send(store, { type: "message.part.updated", timestamp: 250, properties: { part: {
      id: "tool-part", callID: "call", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 250 } },
    } } });
    send(store, { type: "message.part.updated", timestamp: 900, properties: { part: {
      id: "tool-part", callID: "call", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", time: { start: 250, end: 900 } },
    } } });
    const before = store.revision();
    send(store, { type: "session.next.text.delta", timestamp: 100, properties: { sessionID: "s", assistantMessageID: "m", textID: "text", delta: "hello" } });
    send(store, { type: "session.next.reasoning.delta", timestamp: 150, properties: { sessionID: "s", assistantMessageID: "m", reasoningID: "reason", delta: "think" } });
    send(store, { type: "session.next.tool.input.delta", timestamp: 200, properties: { sessionID: "s", assistantMessageID: "m", callID: "call", delta: "{}" } });
    assert.equal(store.revision(), before, "v2 content deltas do not project Pulse");
    send(store, completion("m", 10, 5, 0, 1000));
    assert.equal(store.records[0].samples.length, 0);
    assert.equal(store.records[0].speed?.response?.durationMs, 1000);
  } finally { store.disposeSignals(); }
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

test("ledger exact open/settled blocks partial provisional overlay but permits exact zero correction", async () => {
  const directory = await testDirectory("tui-quality-");
  const totals = createTotalsStorage(join(directory, "totals.json"));
  const store = createRuntimeStore(1, 0);
  try {
    generatedText(store, "m");
    const first = store.records[0];
    store.totalsLedger = await totals.apply(first, { retainedMessageIDs: ["m"] });
    const partial = { type: "message.updated", timestamp: 350, properties: { info: {
      id: "m", sessionID: "s", role: "assistant", tokens: { input: 1 }, time: { created: 0, completed: 350 },
    } } };
    assert.equal(send(store, partial), false);
    assert.equal(sessionUsageSummary(store, "s").totalGeneratedTokens, 10);
    send(store, completion("new", 20, 0, 300, 500));
    store.totalsLedger = await totals.apply(store.records[0], { retainedMessageIDs: ["new"] });
    const before = sessionUsageSummary(store, "s");
    assert.equal(send(store, partial), false);
    assert.deepEqual(sessionUsageSummary(store, "s"), before);
    const projected = projectSessionTotals(store.totalsLedger, [{ ...first, quality: "provisional", tokens: { ...first.tokens, output: 0 } }], new Map(), "s");
    assert.equal(projected.direct.tokens.output, 30);
    assert.equal(projected.direct.speed?.generation?.responseCount ?? 0, 0, "delta-less completion has no generation samples");
    send(store, completion("m", 0, 0, 0, 400));
    assert.equal(sessionUsageSummary(store, "s").totalGeneratedTokens, 20);
    assert.equal(sessionUsageSummary(store, "s").totalResponseCount, 2);
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("live metadata Thinking sets first response without tokens and preserves separate first content in legacy and v2", () => {
  for (const stream of ["legacy", "v2"]) {
    const store = createRuntimeStore(1, 0);
    try {
      send(store, { type: "message.updated", timestamp: 10, properties: { info: {
        id: "m", sessionID: "s", role: "assistant", time: { created: 0 },
      } } });
      const thinking = { type: "message.part.updated", timestamp: 200, properties: { part: {
        id: "p", messageID: "m", sessionID: "s", type: "reasoning", text: "[REDACTED]",
        metadata: {}, time: { start: 100 },
      } } };
      send(store, thinking);
      const state = store.active.get("m")!;
      assert.equal(state.firstResponseAt, 100);
      assert.equal(state.firstResponseSource, "thinking");
      assert.equal(state.firstResponseTimeSource, "part-start");
      assert.equal(state.firstResponseEstimated, false);
      assert.equal(state.firstTokenAt, undefined);
      assert.equal(state.firstContentAt, undefined);
      assert.equal(state.legacy.samples.length + state.v2.samples.length, 0);
      assert.deepEqual(state.fallbackTokens, {});
      assert.equal(store.active.has("m"), true);
      const revision = store.revision();
      send(store, thinking);
      assert.equal(store.revision(), revision);
      send(store, { type: stream === "legacy" ? "message.part.delta" : "session.next.reasoning.delta",
        timestamp: 500, properties: { sessionID: "s", messageID: "m", assistantMessageID: "m", partID: "p", reasoningID: "p", field: "text", delta: "think" } });
      send(store, snapshot("p", "m", "reasoning", 600, "think"));
      send(store, completion("m", 0, 10, 0, 1000));
      const record = store.records[0];
      assert.equal(record.time.firstResponse, 100);
      assert.equal(record.time.firstContent, undefined, "content deltas no longer establish first content");
      assert.equal(record.samples.length, 0);
      assert.equal(store.lastCompletedBySession.get("s")?.ttft, 100);
      assert.equal(speedSummary(record).available, makeLastCompletedSnapshot(record).available);
      send(store, completion("m", 0, 20, 0, 1100));
      assert.equal(store.records[0].time.firstResponse, 100);
      assert.equal(store.records[0].time.firstContent, undefined);
    } finally { store.disposeSignals(); }
  }
});

test("Thinking requires current live unfinished assistant; replay user completed and busy-only facts do not qualify", () => {
  const store = createRuntimeStore(10, 0);
  const part = (messageID: string, overrides: Record<string, unknown> = {}) => ({ type: "message.part.updated", timestamp: 300,
    properties: { part: { id: `${messageID}-p`, messageID, sessionID: "s", type: "reasoning", text: "", metadata: {}, time: { start: 100 }, ...overrides } } });
  try {
    send(store, { type: "session.status", timestamp: 0, properties: { sessionID: "s", status: { type: "busy" } } });
    send(store, part("busy"));
    assert.equal(store.active.size, 0);
    send(store, { type: "message.updated", timestamp: 10, source: "reconnect", properties: { info: { id: "old", sessionID: "s", role: "assistant", time: { created: 0 } } } });
    send(store, part("old"));
    send(store, { type: "message.updated", timestamp: 10, properties: { info: { id: "user", sessionID: "s", role: "user" } } });
    send(store, part("user"));
    send(store, completion("done", 10));
    send(store, part("done"));
    assert.equal(store.active.size, 0);
    send(store, { type: "message.updated", timestamp: 10, properties: { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 0 } } } });
    recordTuiPartMetadata(store, part("m").properties); // The old two-argument API remains metadata-only.
    assert.equal(store.active.get("m")?.firstResponseAt, undefined);
    for (const invalid of [
      { ...part("m"), replay: true }, { ...part("m"), source: "snapshot" },
      { ...part("m"), source: "history" }, { ...part("m"), source: "reconnect" },
      part("m", { time: { start: 100, end: 200 } }), part("m", { sessionID: "other" }),
      part("m", { text: " [REDACTED] ", metadata: undefined }), part("m", { role: "user" }),
    ]) send(store, invalid);
    assert.equal(store.active.get("m")?.firstResponseAt, undefined);
    send(store, { type: "session.next.reasoning.delta", replay: true, timestamp: 200,
      properties: { sessionID: "s", assistantMessageID: "m", reasoningID: "m-p", delta: "history" } });
    assert.equal(store.active.get("m")?.firstTokenAt, undefined);
    assert.equal(store.active.get("m")?.v2.samples.length, 0);
    send(store, { type: "message.updated", timestamp: 10, properties: { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 0 } } } });
    send(store, part("m", { time: { start: -1 } }));
    assert.equal(store.active.get("m")?.firstResponseAt, 300);
    assert.equal(store.active.get("m")?.firstResponseTimeSource, "arrival");
    assert.equal(store.active.get("m")?.firstResponseEstimated, true);
    send(store, part("m", { time: { start: 100 } }));
    assert.equal(store.active.get("m")?.firstResponseAt, 100);
    assert.equal(store.active.get("m")?.firstResponseEstimated, false);
    send(store, part("m", { time: { start: 400 } }));
    assert.equal(store.active.get("m")?.firstResponseAt, 100);
    assert.equal(store.active.get("m")?.legacy.samples.length, 0);
  } finally { store.disposeSignals(); }
});

test("earlier visible Thinking can refine response TTFT without rewriting content or adding samples", () => {
  const store = createRuntimeStore(1, 0);
  try {
    send(store, { type: "message.updated", timestamp: 10, properties: { info: {
      id: "m", sessionID: "s", role: "assistant", time: { created: 0 },
    } } });
    send(store, { type: "session.next.text.delta", timestamp: 100, properties: {
      sessionID: "s", assistantMessageID: "m", textID: "text", delta: "hello",
    } });
    assert.equal(store.active.get("m")?.firstResponseAt, undefined, "text deltas no longer establish first response");
    send(store, { type: "message.part.updated", timestamp: 200, properties: { part: {
      id: "thinking", messageID: "m", sessionID: "s", type: "reasoning", text: "[REDACTED] Visible", time: { start: 80 },
    } } });
    assert.equal(store.active.get("m")?.firstResponseAt, 80);
    assert.equal(store.active.get("m")?.firstResponseSource, "thinking");
    assert.equal(store.active.get("m")?.v2.samples.length, 0);
  } finally { store.disposeSignals(); }
});

test("TUI snapshot byte gaps cannot allocate full usage to a short generation interval", () => {
  const store = createRuntimeStore(1, 0);
  try {
    send(store, snapshot("p", "m", "reasoning"));
    send(store, { type: "message.part.delta", timestamp: 1000, properties: {
      sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "x",
    } });
    send(store, snapshot("p", "m", "reasoning", 1100, "x".repeat(1000)));
    send(store, completion("m", 0, 1000, 0, 1200));
    const record = store.records[0];
    assert.equal(record.speed?.generation, undefined);
    const history = speedSummary(record);
    const last = makeLastCompletedSnapshot(record);
    assert.equal(history.available, false);
    assert.equal(last.available, history.available);
    assert.equal(sessionUsageSummary(store, "s").generation.coveredResponseCount, 0);
  } finally { store.disposeSignals(); }
});

test("stale history and optimistic speeds cannot undo server speed-only backfill or generation invalidation", async () => {
  const directory = await testDirectory("tui-canonical-speed-");
  const path = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  const store = createRuntimeStore(2, 0);
  try {
    generatedText(store, "m");
    const stale = store.records[0];
    const response = { generatedTokens: 10, durationMs: 300, estimated: false };
    const canonical = { response };
    for (const location of ["open", "settled"] as const) {
      const contribution = { sessionID: "s", quality: "exact" as const, tokens: stale.tokens, cost: stale.cost, speed: canonical };
      const ledger = { version: 1, sessions: { s: { tokens: stale.tokens, cost: stale.cost, responseCount: 1,
        speed: updateSpeedTotals(undefined, canonical, 1) } }, parents: {}, open: {}, settled: {},
        [location]: { m: contribution } };
      await writeFile(path, JSON.stringify(stale) + "\n");
      await writeFile(totalsPath, JSON.stringify(ledger));
      store.optimistic.set("m", stale);
      store.optimisticQuality.set("m", "exact");
      await reloadHistory(store, api, path, totalsPath, 2);
      const summary = sessionUsageSummary(store, "s");
      assert.equal(summary.totalGeneratedTokens, 10);
      assert.equal(summary.totalResponseCount, 1);
      assert.equal(summary.generation.available, false);
      assert.equal(summary.response.rate, 10000 / 300);
      assert.equal(summary.response.estimated, false);
      assert.equal(store.records[0].speed?.generation, undefined);
      assert.equal(store.lastCompletedBySession.get("s")?.available, false);
      assert.equal(store.lastCompletedBySession.get("s")?.estimated, true);
      assert.equal(projectSessionTotals(store.totalsLedger, [stale], new Map(), "s").direct.speed?.generation.responseCount, 0);
      const noSpeed = { ...stale, speed: undefined };
      assert.equal(projectSessionTotals(store.totalsLedger, [noSpeed], new Map(), "s").direct.speed?.response.responseCount, 1);
      assert.equal(projectSessionTotals(store.totalsLedger, [noSpeed], new Map(), "s").direct.speed?.response.durationMs, 300);
      await writeFile(path, JSON.stringify(noSpeed) + "\n");
      store.optimistic.set("m", noSpeed);
      await reloadHistory(store, api, path, totalsPath, 2);
      assert.equal(speedSummary(store.records[0]).available, false);
      assert.equal(speedSummary(store.records[0]).avg, 0);
      assert.equal(sessionUsageSummary(store, "s").response.coveredResponseCount, 1);
      // A retained LAST remains canonical even after the detail window is empty.
      store.lastCompletedBySession.set("s", makeLastCompletedSnapshot(stale));
      store.optimistic.clear();
      await writeFile(path, "");
      await reloadHistory(store, api, path, totalsPath, 2);
      assert.equal(store.records.length, 0);
      assert.equal(store.lastCompletedBySession.get("s")?.available, false);
      assert.equal(store.lastCompletedBySession.get("s")?.estimated, true);
    }
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("open and settled server backfills protect provisional speed and usage from unversioned history overlays", async () => {
  const directory = await testDirectory("tui-backfill-projection-");
  const path = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  const store = createRuntimeStore(1, 0);
  try {
    generatedText(store, "m");
    const live = store.records[0] as MeasuredHistoryRecord;
    const response = { generatedTokens: 10, durationMs: 600, estimated: true };
    for (const location of ["open", "settled"] as const) {
      for (const quality of ["exact", "provisional"] as const) {
        const legacy: MeasuredHistoryRecord = { ...live, quality, update: undefined, speed: undefined };
        const contribution = { sessionID: "s", quality, tokens: legacy.tokens, cost: legacy.cost,
          speed: { response }, speedBackfill: { version: 1 as const, source: "server" as const } };
        const ledger = { version: 1, sessions: { s: { tokens: legacy.tokens, cost: legacy.cost, responseCount: 1,
          speed: updateSpeedTotals(undefined, contribution.speed, 1) } }, open: {}, settled: {},
          [location]: { m: contribution } };
        const staleUsage = { ...legacy, tokens: { ...legacy.tokens, output: 999 }, cost: 999 };
        for (const stale of [legacy, staleUsage]) {
          const projected = projectSessionTotals(ledger, [stale], new Map(), "s").direct;
          assert.deepEqual(projected.tokens, ledger.sessions.s.tokens);
          assert.equal(projected.cost, legacy.cost);
          assert.equal(projected.responseCount, 1);
          assert.deepEqual(projected.speed, ledger.sessions.s.speed);
        }
        await writeFile(path, JSON.stringify(legacy) + "\n");
        await writeFile(totalsPath, JSON.stringify(ledger));
        store.optimistic.clear();
        await reloadHistory(store, api, path, totalsPath, 1);
        assert.deepEqual(store.records[0].speed, contribution.speed);
        assert.equal(sessionUsageSummary(store, "s").response.durationMs, 600);

        // The existing newer-update gate also rejects unversioned overlays,
        // independent of quality and without requiring a backfill marker.
        const updated = { ...ledger, [location]: { m: { ...contribution, speedBackfill: undefined, update: live.update } } };
        assert.deepEqual(projectSessionTotals(updated, [staleUsage], new Map(), "s").direct, ledger.sessions.s);
        // Backfill without live ordering evidence does not suppress a real exact correction.
        const correction = { ...live, quality: "exact" as const, tokens: { ...live.tokens, output: 0 }, cost: 0,
          speed: { response: { generatedTokens: 0, durationMs: 1000, estimated: false } } };
        const corrected = projectSessionTotals(ledger, [correction], new Map(), "s").direct;
        assert.equal(corrected.tokens.output, 0);
        assert.equal(corrected.cost, 0);
        assert.equal(corrected.speed?.response.durationMs, 1000);
      }
    }
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("v3 TUI uses receive mono, excludes the whole first batch, and separates interval tokens from full coverage", () => {
  for (const stream of ["legacy", "v2"] as const) {
    const store = createRuntimeStore(2, 0);
    try {
      beginObserved(store);
      const delta = (kind: "text" | "reasoning", text: string, wall: number, mono: number) => send(store, {
        type: stream === "legacy" ? "message.part.delta" : `session.next.${kind}.delta`, timestamp: 999999,
        properties: { sessionID: "s", messageID: "m", partID: kind,
          ...(kind === "reasoning" ? { reasoningID: kind } : { textID: kind }), field: "text", delta: text },
      }, wall, mono);
      send(store, snapshot("text", "m", "text"));
      send(store, snapshot("reasoning", "m", "reasoning"));
      delta("text", "a", 100, 100);
      delta("reasoning", "r", 100, 100);
      delta("text", "bbb", 1100, 1100);
      delta("reasoning", "rrr", 50, 1200); // Wall clock jumps back; denominator must not.
      send(store, snapshot("text", "m", "text", 4000, "abbb"));
      send(store, snapshot("reasoning", "m", "reasoning", 4500, "rrrr"));
      for (const timestamp of [4600, 4700]) send(store, { type: "session.next.step.ended", timestamp,
        properties: { sessionID: "s", messageID: "m", stepID: "m-step", tokens: { output: 80, reasoning: 20 } } });
      send(store, completion("m", 80, 20, 0, 5000));
      const record = store.records[0];
      assert.equal(record.samples.length, 0, "receive deltas are not projected into samples");
      assert.equal(record.tokens.output, 80);
      assert.equal(record.tokens.reasoning, 20);
      assert.equal(speedSummary(record).available, false);
      assert.equal(sessionUsageSummary(store, "s").generation.coveredGeneratedTokens, 0);
    } finally { store.disposeSignals(); }
  }
});

test("retry busy, failed same ID, reconnect and unknown steps never reset TUI generation taint", () => {
  for (const disruption of ["retry", "nested-session-retry", "failed", "reconnect", "unknown-step", "multiple-steps", "tool"] as const) {
    const store = createRuntimeStore(2, 0);
    try {
      beginObserved(store);
      send(store, snapshot("p", "m", "text"));
      send(store, { type: "message.part.delta", timestamp: 100,
        properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "hello" } });
      if (disruption === "reconnect") {
        send(store, { type: "server.connected", timestamp: 200, properties: {} });
        send(store, { type: "server.connected", timestamp: 300, properties: {} });
      } else if (disruption === "unknown-step" || disruption === "multiple-steps") {
        send(store, { type: "session.next.step.started", timestamp: 200,
          properties: { sessionID: "s", messageID: "m", ...(disruption === "multiple-steps" ? { stepID: "second" } : {}) } });
      } else if (disruption === "tool") {
        send(store, { type: "message.part.updated", timestamp: 200, properties: { part: {
          id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 200 } },
        } } });
      } else {
        if (disruption === "nested-session-retry") {
          send(store, { type: "session.status", timestamp: 200,
            properties: { info: { id: "s", status: { type: "retry" } } } });
        } else {
          send(store, { type: disruption === "retry" ? "session.next.retried" : "session.next.step.failed", timestamp: 200,
            properties: { sessionID: "s", messageID: "m" } });
        }
        send(store, { type: "session.status", timestamp: 300, properties: { sessionID: "s", status: { type: "busy" } } });
        send(store, { type: "message.updated", timestamp: 400, properties: { info: {
          id: "m", sessionID: "s", role: "assistant", time: { created: 0 },
        } } });
      }
      send(store, { type: "message.part.delta", timestamp: 1100,
        properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "world" } });
      send(store, snapshot("p", "m", "text", 1150, "helloworld"));
      send(store, completion("m", 10));
      assert.equal(speedSummary(store.records[0]).available, false, disruption);
      assert.equal(sessionUsageSummary(store, "s").generation.coveredResponseCount, 0, disruption);
      assert.equal(store.records[0].speed?.generation, undefined, disruption);
      assert.equal(store.records[0].speed?.response?.generatedTokens, 10, disruption);
      assert.equal(store.active.size, 0, disruption);
    } finally { store.disposeSignals(); }
  }
});

test("unlabelled recovered assistants predating observation cannot establish a current start or Thinking TTFT", () => {
  const store = createRuntimeStore(1, 100);
  try {
    beginObserved(store, "old", 0, 110); // Deliberately no imaginary production replay flag.
    send(store, { type: "message.part.updated", timestamp: 150, properties: { part: {
      id: "p", messageID: "old", sessionID: "s", type: "reasoning", text: "", metadata: {}, time: { start: 120 },
    } } });
    assert.equal(store.active.get("old")?.firstResponseAt, undefined);
    for (const timestamp of [200, 1200]) send(store, { type: "message.part.delta", timestamp,
      properties: { sessionID: "s", messageID: "old", partID: "p", field: "text", delta: "think" } });
    send(store, snapshot("p", "old", "reasoning", 1250, "thinkthink"));
    send(store, completion("old", 0, 10, 0, 1300));
    assert.equal(speedSummary(store.records[0]).available, false);
    assert.equal(store.records[0].time.firstResponseSource, undefined);
    assert.equal(store.records[0].time.firstResponse, undefined);
    assert.equal(store.records[0].time.firstToken, undefined);
  } finally { store.disposeSignals(); }
});

test("a delayed current assistant start can qualify after 1.5s, but cannot reclaim already observed or pre-epoch content", () => {
  for (const guard of ["clean", "pre-epoch", "already-observed"] as const) {
    const store = createRuntimeStore(1, guard === "pre-epoch" ? 1000 : 0);
    try {
      if (guard === "already-observed") {
        beginObserved(store, "m", 10, 100);
        send(store, snapshot("p", "m", "text", 150, "earlier"));
      } else beginObserved(store, "m", 10, 1510);
      assert.equal(store.active.get("m")?.observedFromStart, guard === "pre-epoch" ? undefined : true);
      send(store, snapshot("text", "m", "text"));
      for (const timestamp of [1600, 2600]) send(store, { type: "message.part.delta", timestamp,
        properties: { sessionID: "s", messageID: "m", partID: "text", field: "text", delta: "hello" } });
      send(store, snapshot("text", "m", "text", 2700, "hellohello"));
      send(store, completion("m", 10, 0, 10, 2800));
      assert.equal(speedSummary(store.records[0]).available, false, guard);
      assert.equal(store.records[0].samples.length, 0);
    } finally { store.disposeSignals(); }
  }
});

test("v3 live usage corrections rescale interval bytes, not full usage, and hidden categories invalidate", () => {
  const store = createRuntimeStore(1, 0);
  try {
    generatedText(store, "m");
    send(store, completion("m", 8));
    assert.equal(speedSummary(store.records[0]).available, false);
    assert.equal(sessionUsageSummary(store, "s").generation.coveredGeneratedTokens, 0);
    assert.equal(sessionUsageSummary(store, "s").totalGeneratedTokens, 8);
    send(store, completion("m", 8, 2));
    assert.equal(store.records[0].speed?.generation, undefined);
    assert.equal(sessionUsageSummary(store, "s").generation.available, false);
  } finally { store.disposeSignals(); }
});

test("missing reasoning cannot erase accepted v3 usage or coverage; explicit reasoning zero remains authoritative", () => {
  const store = createRuntimeStore(1, 0);
  try {
    beginObserved(store);
    send(store, snapshot("text", "m", "text"));
    send(store, snapshot("reason", "m", "reasoning"));
    for (const timestamp of [100, 1100]) for (const partID of ["text", "reason"]) {
      send(store, { type: "message.part.delta", timestamp,
        properties: { sessionID: "s", messageID: "m", partID, field: "text", delta: "x" } });
    }
    send(store, snapshot("text", "m", "text", 1150, "xx"));
    send(store, snapshot("reason", "m", "reasoning", 1150, "xx"));
    send(store, completion("m", 10, 10));
    const original = store.records[0];
    const before = sessionUsageSummary(store, "s");
    const missing = completion("m", 8);
    delete (missing.properties.info.tokens as { reasoning?: number }).reasoning;
    assert.equal(send(store, missing), false);
    assert.equal(store.records[0], original);
    assert.equal(store.records[0].tokens.reasoning, 10);
    assert.equal(speedSummary(store.records[0]).available, false);
    assert.deepEqual(sessionUsageSummary(store, "s"), before);
    assert.equal(send(store, completion("m", 8, 0)), true);
    assert.equal(store.records[0].tokens.reasoning, 0);
    assert.equal(speedSummary(store.records[0]).available, false);
  } finally { store.disposeSignals(); }
});

test("legacy generation is masked before projection; old history cannot subtract v3 sums or restore server-invalidated speeds", async () => {
  const directory = await testDirectory("tui-v3-basis-");
  const path = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  const store = createRuntimeStore(1, 0);
  try {
    generatedText(store, "new");
    const fresh = store.records[0] as MeasuredHistoryRecord;
    const oldSpeed = { generation: { generatedTokens: 100, durationMs: 1000, estimated: true },
      generationEvidence: { version: 2 as const, coverage: "complete" as const, start: 0, end: 1000, outputObserved: true, reasoningObserved: false },
      response: { generatedTokens: 100, durationMs: 2000, estimated: false } };
    const old = { ...fresh, messageID: "old", tokens: { ...fresh.tokens, output: 100 }, cost: 100, speed: oldSpeed, update: undefined };
    const oldContribution = { sessionID: "s", quality: "exact" as const, tokens: old.tokens, cost: old.cost, speed: old.speed };
    const legacy = { version: 1, sessions: { s: { tokens: old.tokens, cost: 100, responseCount: 1,
      speed: { generation: { generatedTokens: 100, durationMs: 1000, responseCount: 1, estimatedResponseCount: 1 },
        response: { generatedTokens: 100, durationMs: 2000, responseCount: 1, estimatedResponseCount: 0 } } } },
      open: { old: oldContribution }, settled: { marker: true as const } };
    const original = structuredClone(legacy);
    const masked = projectSessionTotals(legacy, [old], new Map(), "s").direct;
    assert.equal(masked.speed?.generation.responseCount, 0);
    assert.equal(masked.speed?.response.generatedTokens, 100);
    assert.equal(masked.tokens.output, 100);
    assert.equal(masked.responseCount, 1);
    assert.deepEqual(legacy, original);
    await writeFile(path, JSON.stringify(old) + "\n");
    const bytes = JSON.stringify(legacy);
    await writeFile(totalsPath, bytes);
    store.optimistic.clear();
    await reloadHistory(store, api, path, totalsPath, 1);
    assert.equal(await readFile(totalsPath, "utf8"), bytes); // TUI projection must not migrate the file.
    assert.equal(store.totalsLedger.generationBasisVersion, undefined);
    assert.equal(sessionUsageSummary(store, "s").generation.available, false);

    const correction: MeasuredHistoryRecord = { ...fresh, messageID: "old", tokens: { ...fresh.tokens, output: 8 }, cost: 8,
      speed: { response: { generatedTokens: 8, durationMs: 1200, estimated: false } } };
    correction.speed = mergeRecordSpeed(correction, fresh);
    for (const location of ["open", "settled"] as const) {
      const ledger: TotalsLedger = { ...legacy, version: 1, generationBasisVersion: 3, open: {}, settled: {},
        sessions: { s: { ...legacy.sessions.s, tokens: { ...old.tokens, output: 110 }, cost: 110, responseCount: 2,
          speed: { ...legacy.sessions.s.speed, generation: updateSpeedTotals(undefined, fresh.speed, 1)!.generation } } },
        [location]: { old: oldContribution } };
      const projected = projectSessionTotals(ledger, [correction], new Map(), "s").direct;
      assert.equal(projected.speed?.generation.generatedTokens, 0, "delta-less fresh speed contributes no generation interval");
      assert.equal(projected.speed?.generation.coverageGeneratedTokens, 0);
      assert.equal(projected.speed?.generation.durationMs, 0);
      assert.equal(projected.tokens.output, 18);
      assert.equal(projected.responseCount, 2);
      const canonical: TotalsLedger = { ...ledger, [location]: { old: { ...oldContribution, tokens: correction.tokens, cost: correction.cost,
        speed: { response: correction.speed?.response } } } };
      const stale: MeasuredHistoryRecord = { ...correction, update: undefined };
      assert.equal(projectSessionTotals(canonical, [stale], new Map(), "s").direct.speed?.generation.generatedTokens, 0);
      await writeFile(totalsPath, JSON.stringify(ledger));
      await reloadHistory(store, api, path, totalsPath, 1);
      assert.equal(store.totalsLedger.generationBasisVersion, 3);
    }
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});
