import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createTestKeymap } from "@opentui/keymap/testing";
import { aggregateSession } from "../src/core.js";
import type { HistoryRecord, TokenCounts } from "../src/core.js";
import { replayActivity } from "../src/activity.js";
import type { ActivityEventInput } from "../src/activity.js";
import { resolveRunsPath } from "../src/runs-storage.js";
import {
  aggregateSpeed,
  applyRecordToSessionRuntime,
  cacheHitRate,
  classifyTokenFields,
  cacheSessionParentFromEvent,
  createActiveState,
  createRuntimeStore,
  createSessionRuntime,
  createTaskWallRun,
  createTuiSlotPlugin,
  displayedSessionID,
  finalSamples,
  formatCacheHitRate,
  formatCompactNumber,
  formatCompactRate,
  formatPulseMetrics,
  formatPulseSummary,
  projectSessionTotals,
  freezeSessionRun,
  handleSessionLifecycle,
  hasLiveTaskWallActivity,
  historyRecordsEquivalent,
  lockStreamSource,
  makeTokens,
  makeLastCompletedSnapshot,
  mergeHistoryLayers,
  noteTaskRunRecord,
  noteTaskRecord,
  recordSpeedSummary,
  rememberVisibleSession,
  selectedSamples,
  takeActiveState,
  taskWallTimeForSession,
  totalTokens,
  togglePulse,
  transitionTaskWallRun,
  transitionSessionRuntime,
  DETAILS_COMMAND_NAME,
  liveLabel,
  registerTokenPulseCommands,
  resolveOptions,
  sessionAverageDisplay,
  sessionUsageSummary,
  tokenPulseBindings,
} from "../src/tui.js";
import { emptySpeedTotals, updateSpeedTotals } from "../src/statistics.js";

function tokens(output: number, reasoning = 0): TokenCounts {
  return {
    input: 10,
    output,
    reasoning,
    cacheRead: 2,
    cacheWrite: 1,
  };
}

function intervalElapsedForTest(intervals: readonly { start: number; end: number }[]): number {
  return intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
}

function activityLifecycle(
  sessionID: string,
  state: "busy" | "retry" | "idle" | "completed" | "failed",
  timestamp: number,
  instanceID = "instance",
): ActivityEventInput {
  return { kind: "lifecycle", sessionID, state, timestamp, instanceID };
}

function hydrateActivity(store: ReturnType<typeof createRuntimeStore>, events: readonly ActivityEventInput[]): void {
  store.activityReplay = replayActivity(events);
  store.activityEvents = store.activityReplay.events;
}

function record(
  messageID: string,
  sessionID = "session",
  output = 10,
  reasoning = 2,
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    version: 1,
    messageID,
    sessionID,
    tokens: tokens(output, reasoning),
    cost: 0.5,
    time: {
      start: 0,
      firstToken: 100,
      completed: 1_100,
      ttft: 100,
      duration: 1_100,
    },
    samples: [],
    ...overrides,
  };
}

test("two assistant messages remain in one run until idle", () => {
  const runtime = createSessionRuntime();
  assert.equal(transitionSessionRuntime(runtime, "busy", 0), true);
  assert.equal(applyRecordToSessionRuntime(runtime, record("one", "s", 10, 2)), true);
  assert.equal(applyRecordToSessionRuntime(runtime, record("two", "s", 20, 3)), true);

  assert.deepEqual(runtime.runTotals, {
    input: 20,
    output: 30,
    reasoning: 5,
    cacheRead: 4,
    cacheWrite: 2,
  });
  assert.equal(runtime.runResponseCount, 2);
  const summary = freezeSessionRun(runtime, 2_000);
  assert.equal(summary?.responseCount, 2);
  assert.equal(summary?.tokens.output, 30);
  assert.equal(runtime.status, "idle");
});

test("duplicate completion does not add twice or consume another pending response", () => {
  const runtime = createSessionRuntime();
  transitionSessionRuntime(runtime, "busy", 0);
  const done = record("done");
  applyRecordToSessionRuntime(runtime, done);
  applyRecordToSessionRuntime(runtime, done);
  assert.equal(runtime.runResponseCount, 1);
  assert.equal(runtime.runTotals.output, 10);

  const active = new Map<string, ReturnType<typeof createActiveState>>();
  active.set("done", createActiveState("done", "s", 0));
  active.set("__pending__:s", createActiveState("__pending__:s", "s", 10));
  takeActiveState(active, "done", "s");
  active.delete("done");
  assert.equal(active.has("__pending__:s"), true);
});

test("completed snapshot remains available with stable generated rate", () => {
  const snapshot = makeLastCompletedSnapshot(record("done", "s", 20, 5), 3);
  assert.equal(snapshot.generated, 25);
  assert.equal(snapshot.elapsed, 1_000);
  assert.equal(snapshot.rate, 25);
  assert.equal(snapshot.ttft, 100);
  assert.equal(snapshot.runEpoch, 3);
  assert.equal(snapshot.estimated, false);
});

test("busy and retry continue the same epoch, while idle is idempotent", () => {
  const runtime = createSessionRuntime();
  transitionSessionRuntime(runtime, "busy", 10);
  const epoch = runtime.runEpoch;
  applyRecordToSessionRuntime(runtime, record("one"));
  transitionSessionRuntime(runtime, "retry", 20);
  applyRecordToSessionRuntime(runtime, record("two"));
  assert.equal(runtime.runEpoch, epoch);
  assert.equal(runtime.runResponseCount, 2);
  const summary = freezeSessionRun(runtime, 30);
  assert.equal(summary?.responseCount, 2);
  assert.equal(freezeSessionRun(runtime, 31), undefined);
  assert.equal(transitionSessionRuntime(runtime, "idle", 31), false);
});

test("history reload keeps a newer overlay over an in-flight disk snapshot", () => {
  const disk = record("done", "s", 10, 1, { cost: 0.5 });
  const overlay = record("done", "s", 20, 2, { cost: 0.8 });
  const merged = mergeHistoryLayers([disk], new Map([[overlay.messageID, overlay]]), 10);
  assert.equal(merged[0].tokens.output, 20);
  assert.equal(merged[0].cost, 0.8);
  assert.equal(historyRecordsEquivalent(disk, overlay), false);
  assert.equal(historyRecordsEquivalent(disk, disk), true);
});

test("a late exact completion replaces an idle provisional record without double counting", () => {
  const runtime = createSessionRuntime();
  transitionSessionRuntime(runtime, "busy", 0);
  const provisional = record("same", "s", 4, 1, {
    time: { start: 0, completed: 2_000, duration: 2_000 },
  });
  const exact = record("same", "s", 40, 5, {
    time: { start: 0, firstToken: 100, completed: 2_100, ttft: 100, duration: 2_100 },
  });
  applyRecordToSessionRuntime(runtime, provisional, "provisional");
  assert.deepEqual(runtime.runTotals, provisional.tokens);
  applyRecordToSessionRuntime(runtime, exact, "exact");
  assert.deepEqual(runtime.runTotals, exact.tokens);
  assert.equal(runtime.runResponseCount, 1);
  assert.equal(applyRecordToSessionRuntime(runtime, exact, "exact"), false);
});

test("late exact completion repairs the completed epoch instead of the next epoch", () => {
  const runtime = createSessionRuntime();
  transitionSessionRuntime(runtime, "busy", 0);
  const provisional = record("old", "s", 4, 0, {
    time: { start: 0, completed: 1_000, duration: 1_000 },
  });
  applyRecordToSessionRuntime(runtime, provisional, "provisional");
  freezeSessionRun(runtime, 1_000);
  transitionSessionRuntime(runtime, "busy", 5_000);
  const exact = record("old", "s", 40, 0, {
    time: { start: 0, firstToken: 100, completed: 1_100, ttft: 100, duration: 1_100 },
  });
  applyRecordToSessionRuntime(runtime, exact, "exact");
  assert.equal(runtime.runEpoch, 2);
  assert.equal(runtime.runTotals.output, 0);
  assert.equal(runtime.runSummaries.get(1)?.tokens.output, 40);
  assert.equal(runtime.lastRunSummary?.runEpoch, 1);
  assert.equal(runtime.lastRunSummary?.tokens.output, 40);
});

test("exact completion after idle corrects the stored run summary", () => {
  const runtime = createSessionRuntime();
  transitionSessionRuntime(runtime, "busy", 0);
  const provisional = record("idle-late", "s", 4, 0, {
    time: { start: 0, completed: 1_000, duration: 1_000 },
  });
  applyRecordToSessionRuntime(runtime, provisional, "provisional");
  freezeSessionRun(runtime, 1_000);
  const exact = record("idle-late", "s", 40, 0, {
    time: { start: 0, firstToken: 100, completed: 1_100, ttft: 100, duration: 1_100 },
  });
  applyRecordToSessionRuntime(runtime, exact, "exact");
  assert.equal(runtime.runSummaries.get(1)?.tokens.output, 40);
  assert.equal(runtime.lastRunSummary?.tokens.output, 40);
});

test("cache field parsing preserves explicit cache counts and raw SDK shapes", () => {
  assert.deepEqual(classifyTokenFields({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 30,
    inputTokenDetails: { cacheWrite: 6 },
    outputTokenDetails: { reasoningTokens: 5, textTokens: 25 },
  }), {
    input: 74,
    output: 25,
    reasoning: 5,
    cacheRead: 20,
    cacheWrite: 6,
  });
  assert.deepEqual(classifyTokenFields({
    input: 80,
    cacheRead: 0,
    cacheWrite: 0,
    output: 25,
    reasoning: 5,
  }), {
    input: 80,
    output: 25,
    reasoning: 5,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("final explicit cache zero supersedes fallback counts", () => {
  const state = createActiveState("m", "s", 0);
  state.fallbackTokens = { cacheRead: 12, cacheWrite: 4 };
  assert.deepEqual(makeTokens({ cacheRead: 0, cacheWrite: 0 }, state, 4), {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("a complete disk record wins over an incomplete optimistic overlay", () => {
  const disk = record("same", "s", 30, 4, { model: "model", samples: [{ timestamp: 1, tokens: 3 }] });
  const optimistic = record("same", "s", 3, 0, {
    model: undefined,
    time: { start: 0, completed: 1_100, duration: 1_100 },
  });
  const merged = mergeHistoryLayers([disk], new Map([[optimistic.messageID, optimistic]]), 10);
  assert.equal(merged[0].tokens.output, 30);
  assert.equal(merged[0].samples.length, 1);
});

test("an exact optimistic update is not replaced by a stale disk snapshot", () => {
  const disk = record("same", "s", 10, 1, { cost: 0.5 });
  const optimistic = record("same", "s", 20, 2, { cost: 0.8 });
  const store = createRuntimeStore(10);
  store.diskRecords = [disk];
  store.records = [disk];
  store.optimistic.set("same", optimistic);
  store.optimisticQuality.set("same", "exact");
  store.optimisticOrder.set("same", 1);
  store.nextOptimisticOrder = 2;
  const merged = mergeHistoryLayers(store.diskRecords, store.optimistic, 10, store.optimisticQuality, store.optimisticOrder);
  assert.equal(merged[0].tokens.output, 20);
  assert.equal(merged[0].cost, 0.8);
  store.disposeSignals();
});

test("a late disk snapshot with a newer provisional completion cannot replace exact memory", () => {
  const disk = record("same", "s", 3, 0, {
    model: undefined,
    samples: [],
    time: { start: 0, completed: 9_000, duration: 9_000 },
  });
  const exact = record("same", "s", 40, 0, {
    model: "model",
    samples: [{ timestamp: 100, tokens: 40, estimatedTokens: 40, kind: "output" }],
    time: { start: 0, firstToken: 100, completed: 1_100, ttft: 100, duration: 1_100 },
  });
  const merged = mergeHistoryLayers(
    [disk],
    new Map([[exact.messageID, exact]]),
    10,
    new Map([[exact.messageID, "exact"]]),
    new Map([[exact.messageID, 1]]),
  );
  assert.equal(merged[0].tokens.output, 40);
  assert.equal(merged[0].time.completed, 1_100);
});

test("an old disk snapshot cannot replace exact memory even when its timestamp is later", () => {
  const disk = record("same", "s", 8, 0, {
    model: undefined,
    samples: [],
    time: { start: 0, completed: 9_000, duration: 9_000 },
  });
  const exact = record("same", "s", 40, 0, {
    model: undefined,
    samples: [],
    time: { start: 0, completed: 1_100, duration: 1_100 },
  });
  const merged = mergeHistoryLayers(
    [disk],
    new Map([[exact.messageID, exact]]),
    10,
    new Map([[exact.messageID, "exact"]]),
    new Map([[exact.messageID, 4]]),
  );
  assert.equal(merged[0].tokens.output, 40);
  assert.equal(merged[0].time.completed, 1_100);
});

test("a larger exact disk record replaces a smaller exact overlay", () => {
  const disk = record("same", "s", 200, 0, {
    model: "model",
    samples: [{ timestamp: 1, tokens: 200 }],
    time: { start: 0, completed: 9_000, duration: 9_000 },
  });
  const overlay = record("same", "s", 40, 0, {
    model: "model",
    samples: [{ timestamp: 1, tokens: 40 }],
    time: { start: 0, completed: 1_100, duration: 1_100 },
  });
  const merged = mergeHistoryLayers(
    [disk],
    new Map([[overlay.messageID, overlay]]),
    10,
    new Map([[overlay.messageID, "exact"]]),
    new Map([[overlay.messageID, 4]]),
  );
  assert.equal(merged[0].tokens.output, 200);
  assert.equal(merged[0].time.completed, 9_000);
});

test("sidebar totals stay on the opened session after a child event hijacks focus", () => {
  const store = createRuntimeStore(10);
  rememberVisibleSession(store, "child");
  assert.equal(store.focusSessionID, "child");
  assert.equal(displayedSessionID(store, "root"), "root");
  store.disposeSignals();
});

test("late child parent mapping repairs existing records and folds the child into the root", () => {
  const store = createRuntimeStore(10);
  const root = record("root-message", "root", 10, 1);
  const child = record("child-message", "child", 20, 2);
  store.diskRecords = [root, child];
  store.records = [root, child];
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "session.updated",
    properties: { session: { id: "child", parentID: "root" } },
  }), true);
  assert.equal(store.records.find((entry) => entry.messageID === child.messageID)?.parentSessionID, "root");
  const aggregate = aggregateSession(store.records, "root");
  assert.equal(aggregate?.responseCount, 2);
  assert.equal(aggregate?.tokens.output, 30);
  store.disposeSignals();
});

test("stream source locks once and never double-counts legacy with v2", () => {
  const state = createActiveState("message", "s", 0);
  state.selectedSource = lockStreamSource(state.selectedSource, "legacy");
  state.legacy.hasData = true;
  state.legacy.samples.push({ timestamp: 0, tokens: 9, estimatedTokens: 9, kind: "output" });
  state.selectedSource = lockStreamSource(state.selectedSource, "v2");
  state.v2.hasData = true;
  state.v2.samples.push({ timestamp: 1, tokens: 4, estimatedTokens: 4, kind: "output" });
  assert.equal(state.selectedSource, "legacy");
  assert.deepEqual(selectedSamples(state).map((sample) => sample.tokens), [9]);
  assert.deepEqual(finalSamples(state).map((sample) => sample.tokens), [4]);
  assert.equal(lockStreamSource(undefined, "legacy"), "legacy");
});

test("compact formatter keeps small values readable and large values short", () => {
  assert.equal(formatCompactNumber(18), "18");
  assert.equal(formatCompactNumber(987), "987");
  assert.equal(formatCompactNumber(19_900), "19.9k");
  assert.equal(formatCompactNumber(57_500), "57.5k");
  assert.equal(formatCompactNumber(1_200_000), "1.2M");
  assert.equal(formatCompactNumber(120_400_000), "120.4M");
  assert.equal(formatCompactNumber(119_600_000), "119.6M");
  assert.equal(formatCompactNumber(1_000_000_000), "1.0B");
  assert.equal(formatCompactRate(57_500), "57.5k tok/s");
});

test("total token count includes cache writes and collapsed pulse shows speed", () => {
  const counts: TokenCounts = {
    input: 10,
    output: 20,
    reasoning: 5,
    cacheRead: 2,
    cacheWrite: 900,
  };
  assert.equal(totalTokens(counts), 937);
  assert.equal(cacheHitRate({ ...counts, input: 0, cacheRead: 0 }), 0);
  assert.equal(formatCacheHitRate(undefined), "--");
  assert.equal(cacheHitRate({ ...counts, input: 10, cacheRead: 0 }), 0);
  assert.equal(formatCacheHitRate(cacheHitRate({ ...counts, input: 10, cacheRead: 0 })), "0%");
  assert.equal(cacheHitRate({ ...counts, input: 0, cacheRead: 10 }), 10 / 910);
  assert.equal(formatCacheHitRate(cacheHitRate({ ...counts, input: 0, cacheRead: 10 })), "1%");
  const mixed = { ...counts, input: 10, cacheRead: 2, cacheWrite: 0 };
  assert.equal(cacheHitRate(mixed), 2 / 12);
  assert.equal(cacheHitRate({ ...mixed, cacheWrite: 900 }), 2 / 912);
  assert.equal(formatCacheHitRate(cacheHitRate(mixed)), "17%");
  assert.equal(formatPulseMetrics(counts, 293), "937 total · 293 tok/s · cache 0%");
  assert.equal(formatPulseMetrics({ ...counts, input: 0, output: 0, reasoning: 0, cacheRead: 0 }, 0), "900 total · cache 0%");
  assert.equal(formatPulseSummary(counts, 293), "+ Token Pulse  937 total · 293 tok/s · cache 0%");
  assert.equal(formatPulseSummary({ ...counts, input: 0, output: 0, reasoning: 0, cacheRead: 0 }, 0), "+ Token Pulse  900 total · cache 0%");
});

test("aggregate speed is generated-weighted instead of response-average", () => {
  const fast = record("fast", "s", 1, 0, {
    time: { start: 0, firstToken: 0, completed: 100, duration: 100 },
  });
  const slow = record("slow", "s", 100, 0, {
    time: { start: 0, firstToken: 0, completed: 1_000, duration: 1_000 },
  });
  const expected = (101 * 1000) / 1_100;
  assert.equal(aggregateSpeed([fast, slow]), expected);
  assert.equal(recordSpeedSummary(fast).avg, 10);
  assert.equal(recordSpeedSummary(slow).avg, 100);
});

test("projected direct speed replaces time-only changes without overlay/disk double counting", () => {
  const original = record("speed", "root", 100, 0, { speed: { response: { generatedTokens: 100, durationMs: 1000, estimated: true } } });
  const ledger = { sessions: { root: { tokens: original.tokens, cost: original.cost, responseCount: 1,
    speed: { generation: { generatedTokens: 0, durationMs: 0, responseCount: 0, estimatedResponseCount: 0 },
      response: { generatedTokens: 100, durationMs: 1000, responseCount: 1, estimatedResponseCount: 1 } } } },
    open: { speed: { sessionID: "root", quality: "exact" as const, tokens: original.tokens, cost: original.cost, speed: original.speed } }, settled: {} };
  const corrected = { ...original, speed: { response: { generatedTokens: 100, durationMs: 2000, estimated: false } } };
  assert.equal(historyRecordsEquivalent(original, corrected), false);
  const projected = projectSessionTotals(ledger, [corrected, corrected], new Map(), "root");
  assert.equal(projected.direct.responseCount, 1);
  assert.equal(projected.direct.speed?.response.durationMs, 2000);
  assert.equal(projected.direct.speed?.response.estimatedResponseCount, 0);
  const disk = { ...ledger, sessions: { root: projected.direct }, open: { speed: { ...ledger.open.speed, speed: corrected.speed } } };
  assert.deepEqual(projectSessionTotals(disk, [corrected], new Map(), "root").direct, projected.direct);
  const legacy = { ...ledger, open: {}, settled: { speed: true as const } };
  assert.equal(projectSessionTotals(legacy, [corrected], new Map(), "root").direct.speed?.response.durationMs, 1000);
});

test("single-response average prefers generation duration over high sample bursts", () => {
  const response = record("stable", "s", 10, 0, {
    time: { start: 0, firstToken: 0, completed: 1_000, duration: 1_000 },
    samples: [
      { timestamp: 0, tokens: 100, estimatedTokens: 100, kind: "output" },
      { timestamp: 1, tokens: 100, estimatedTokens: 100, kind: "output" },
    ],
  });
  const summary = recordSpeedSummary(response);
  assert.equal(summary.avg, 10);
  assert.ok(summary.max > summary.avg);
});

test("slot registration appends sidebar content without taking the footer or app", async () => {
  const store = createRuntimeStore(10);
  const api = {} as TuiPluginApi;
  const plugin = createTuiSlotPlugin(api, store, {
    maxRecords: 10,
    bytesPerToken: 4,
    enabled: true,
  });
  const slots = plugin.slots as Record<string, unknown>;
  assert.equal(plugin.order, 1_000_000);
  assert.equal(typeof slots.sidebar_content, "function");
  assert.equal(typeof slots.session_prompt_right, "function");
  assert.equal("app" in slots, false);
  assert.equal("sidebar_footer" in slots, false);

  const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /oc-tps\.toggle-pulse|ctrl\+shift\+p/i);
  assert.match(source, /focusable[\s\S]*onMouseDown/);
  assert.match(source, /\+ Token Pulse/);
  assert.match(source, /- Token Pulse/);
  assert.match(source, /formatPulseMetrics\(summary\.tokens, summary\.speed\)/);
  assert.match(source, /displayedSessionID\(props\.store, props\.sessionID\)/);
  assert.doesNotMatch(source, /setFocusSession\(store, (sessionID|eventSessionID)\)/);
  assert.doesNotMatch(source, /focusSessionID \?\? props\.sessionID/);
  assert.match(source, /Cache hit rate/);
  assert.match(source, /formatCacheHitRate\(cacheHitRate\(tokens\)\)/);
  assert.match(source, /backgroundColor=\{props\.api\.theme\.current\.backgroundElement\}/);
  assert.match(source, /CHILD AGENTS/);
  assert.match(source, /Total tokens \(input \+ generated \+ cache\)/);
  assert.match(source, /Cache read \(reused\)/);
  assert.match(source, /Cache write/);
  store.disposeSignals();
});

test("token pulse starts collapsed and toggles independently", () => {
  const store = createRuntimeStore(10);
  assert.equal(store.pulseExpanded, false);
  assert.equal(togglePulse(store), true);
  assert.equal(store.pulseExpanded, true);
  assert.equal(togglePulse(store), false);
  assert.equal(store.pulseExpanded, false);
  store.disposeSignals();
});

test("task wall time spans root and children without summing parallel work", () => {
  const run = createTaskWallRun("root");
  assert.equal(transitionTaskWallRun(run, "root", "busy", 1_000), undefined);
  assert.equal(transitionTaskWallRun(run, "child-a", "busy", 2_000), undefined);
  assert.equal(transitionTaskWallRun(run, "child-b", "busy", 2_500), undefined);
  assert.equal(transitionTaskWallRun(run, "root", "idle", 3_000), undefined);
  assert.equal(transitionTaskWallRun(run, "child-a", "idle", 6_000), undefined);
  const summary = transitionTaskWallRun(run, "child-b", "idle", 11_000);
  assert.equal(summary?.wallTime, 10_000);
  assert.equal(run.lastRunWallTime?.wallTime, 10_000);
  assert.equal(transitionTaskWallRun(run, "child-b", "idle", 12_000), undefined);
});

test("task wall time accumulates epochs while excluding a long idle gap", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 1_000);
  const first = transitionTaskWallRun(run, "root", "idle", 3_000);
  assert.equal(first?.wallTime, 2_000);
  transitionTaskWallRun(run, "root", "busy", 10_000_000);
  const second = transitionTaskWallRun(run, "root", "idle", 10_006_000);
  assert.equal(second?.runEpoch, 2);
  assert.equal(second?.wallTime, 8_000);

  const store = createRuntimeStore(10);
  store.taskRuns.set("root", run);
  assert.equal(taskWallTimeForSession(store, "root"), 8_000);
  store.disposeSignals();
});

test("task wall time sums active intervals and excludes all-idle gaps", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 0);
  const first = transitionTaskWallRun(run, "root", "idle", 1_000);
  transitionTaskWallRun(run, "root", "busy", 5_000);
  const second = transitionTaskWallRun(run, "root", "idle", 7_000);
  assert.equal(first?.wallTime, 1_000);
  assert.equal(second?.wallTime, 3_000);
  assert.equal(run.carriedIntervals.length, 2);
  assert.equal(intervalElapsedForTest(run.carriedIntervals), 3_000);
});

test("late lifecycle correction replaces the carried epoch before the next epoch", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "root", "idle", 1_000);
  assert.deepEqual(run.carriedIntervals, [{ start: 0, end: 1_000 }]);

  transitionTaskWallRun(run, "root", "idle", 500);
  transitionTaskWallRun(run, "root", "busy", 200);
  assert.deepEqual(run.carriedIntervals, [{ start: 0, end: 500 }]);

  transitionTaskWallRun(run, "root", "busy", 2_000);
  transitionTaskWallRun(run, "root", "idle", 2_100);
  assert.equal(run.lastRunWallTime?.wallTime, 600);
  assert.deepEqual(run.carriedIntervals, [
    { start: 0, end: 500 },
    { start: 2_000, end: 2_100 },
  ]);
});

test("late correction of an earlier completed epoch rebuilds the full cumulative history", () => {
  const run = createTaskWallRun("root");
  const store = createRuntimeStore(10);
  store.taskRuns.set("root", run);
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "root", "idle", 100);
  transitionTaskWallRun(run, "root", "busy", 200);
  transitionTaskWallRun(run, "root", "idle", 300);

  transitionTaskWallRun(run, "root", "idle", 50);
  assert.equal(taskWallTimeForSession(store, "root", 400), 150);
  assert.deepEqual(run.carriedIntervals, [
    { start: 0, end: 50 },
    { start: 200, end: 300 },
  ]);

  transitionTaskWallRun(run, "root", "busy", 400);
  transitionTaskWallRun(run, "root", "idle", 500);
  assert.equal(taskWallTimeForSession(store, "root", 600), 250);
  store.disposeSignals();
});

test("late historical child busy and retry do not reopen the current epoch", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "child", "busy", 10);
  transitionTaskWallRun(run, "root", "idle", 20);
  transitionTaskWallRun(run, "child", "idle", 100);
  assert.equal(run.phase, "idle");

  transitionTaskWallRun(run, "root", "busy", 200);
  transitionTaskWallRun(run, "child", "busy", 50);
  transitionTaskWallRun(run, "child", "retry", 60);
  assert.deepEqual([...run.activeSessions], ["root"]);
  assert.equal(run.lifecycleEvents.has("child"), false);
  assert.equal(run.pendingLifecycleEvents.has("child"), false);
  assert.equal(run.sessionStates.has("child"), false);
  assert.equal(run.lastActivityAt.has("child"), false);

  const summary = transitionTaskWallRun(run, "root", "idle", 300);
  assert.equal(summary?.wallTime, 200);
  assert.equal(run.phase, "idle");
  assert.equal(run.activeSessions.size, 0);
});

test("late parent migration uses corrected full history instead of stale carried intervals", () => {
  const store = createRuntimeStore(10);
  const childRun = createTaskWallRun("child");
  const rootRun = createTaskWallRun("root");
  store.taskRuns.set("child", childRun);
  store.taskRuns.set("root", rootRun);

  transitionTaskWallRun(childRun, "child", "busy", 0);
  transitionTaskWallRun(childRun, "child", "idle", 100);
  transitionTaskWallRun(childRun, "child", "busy", 200);
  transitionTaskWallRun(childRun, "child", "idle", 300);
  transitionTaskWallRun(childRun, "child", "idle", 50);

  transitionTaskWallRun(rootRun, "root", "busy", 1_000);
  transitionTaskWallRun(rootRun, "root", "idle", 1_100);
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "session.updated",
    properties: { sessionID: "child", parentID: "root" },
  }), true);

  assert.equal(taskWallTimeForSession(store, "root", 2_000), 250);
  assert.deepEqual(store.taskRuns.get("root")?.carriedIntervals, [
    { start: 0, end: 50 },
    { start: 200, end: 300 },
    { start: 1_000, end: 1_100 },
  ]);
  store.disposeSignals();
});

test("completed source migration does not inject historical lifecycle state into an active root", () => {
  const store = createRuntimeStore(10);
  const childRun = createTaskWallRun("child");
  const rootRun = createTaskWallRun("root");
  store.taskRuns.set("child", childRun);
  store.taskRuns.set("root", rootRun);

  transitionTaskWallRun(childRun, "child", "busy", 0);
  transitionTaskWallRun(childRun, "helper", "busy", 10);
  transitionTaskWallRun(childRun, "child", "idle", 50);
  transitionTaskWallRun(childRun, "helper", "idle", 100);
  transitionTaskWallRun(childRun, "child", "busy", 75);
  transitionTaskWallRun(childRun, "child", "retry", 80);

  transitionTaskWallRun(rootRun, "root", "busy", 200);
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "session.updated",
    properties: { sessionID: "child", parentID: "root" },
  }), true);
  const merged = store.taskRuns.get("root")!;
  assert.equal(merged.lifecycleEvents.has("child"), false);
  assert.equal(merged.lifecycleEvents.has("helper"), false);
  assert.equal(merged.pendingLifecycleEvents.has("child"), false);
  assert.equal(merged.activeSessions.has("child"), false);

  const summary = transitionTaskWallRun(merged, "root", "idle", 300);
  assert.equal(summary?.wallTime, 200);
  assert.equal(merged.phase, "idle");
  assert.equal(taskWallTimeForSession(store, "root", 500), 200);
  store.disposeSignals();
});

test("lifecycle-only active task runs keep the wall-time ticker live", () => {
  const store = createRuntimeStore(10);
  assert.equal(hasLiveTaskWallActivity(store), false);
  store.taskRuns.set("root", createTaskWallRun("root"));
  assert.equal(hasLiveTaskWallActivity(store), false);
  transitionTaskWallRun(store.taskRuns.get("root")!, "root", "retry", 1_000);
  assert.equal(hasLiveTaskWallActivity(store), true);
  store.disposeSignals();
});

test("parallel root and child activity contributes one interval union", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "child", "busy", 500);
  transitionTaskWallRun(run, "root", "idle", 1_000);
  const summary = transitionTaskWallRun(run, "child", "idle", 2_000);
  assert.equal(summary?.wallTime, 2_000);
});

test("duplicate lifecycle events do not extend active intervals", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "root", "idle", 1_000);
  transitionTaskWallRun(run, "root", "idle", 1_000);
  assert.equal(run.lastRunWallTime?.wallTime, 1_000);
});

test("out-of-order child idle then busy lifecycle keeps the valid interval", () => {
  const run = createTaskWallRun("root");
  assert.equal(transitionTaskWallRun(run, "child", "idle", 100), undefined);
  transitionTaskWallRun(run, "child", "busy", 200);
  const summary = transitionTaskWallRun(run, "child", "idle", 500);
  assert.equal(summary?.startedAt, 200);
  assert.equal(summary?.wallTime, 300);
  assert.equal(run.activeSessions.size, 0);
});

test("child-only and child-first activity starts the task run at the earliest child", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "child", "busy", 2_000);
  transitionTaskWallRun(run, "root", "busy", 3_000);
  transitionTaskWallRun(run, "root", "idle", 4_000);
  const summary = transitionTaskWallRun(run, "child", "idle", 7_000);
  assert.equal(summary?.startedAt, 2_000);
  assert.equal(summary?.wallTime, 5_000);
});

test("out-of-order lifecycle events do not lose the participant state", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "child", "busy", 2_000);
  transitionTaskWallRun(run, "child", "idle", 1_000);
  assert.equal(run.activeSessions.has("child"), true);
  const summary = transitionTaskWallRun(run, "child", "idle", 3_000);
  assert.equal(summary?.wallTime, 1_000);
});

test("late busy lifecycle patches a completed run without reopening it", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "root", "idle", 1_000);
  transitionTaskWallRun(run, "root", "idle", 500);
  transitionTaskWallRun(run, "root", "busy", 200);
  assert.equal(run.phase, "idle");
  assert.equal(run.lastRunWallTime?.wallTime, 500);
});

test("out-of-order idle before a child run is retained until its later busy event", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "child", "idle", 100);
  transitionTaskWallRun(run, "child", "busy", 200);
  transitionTaskWallRun(run, "child", "idle", 500);
  assert.equal(run.lastRunWallTime?.wallTime, 300);
  assert.equal(run.activeSessions.has("child"), false);
});

test("session lifecycle keeps an unknown child's idle event before busy", () => {
  const store = createRuntimeStore(10);
  const api = {} as TuiPluginApi;
  handleSessionLifecycle(store, api, "session.idle", { sessionID: "child" }, {
    type: "session.idle",
    timestamp: 100,
    properties: { sessionID: "child" },
  }, 4);
  handleSessionLifecycle(store, api, "session.status", { sessionID: "child", status: "busy" }, {
    type: "session.status",
    timestamp: 200,
    properties: { sessionID: "child", status: "busy" },
  }, 4);
  handleSessionLifecycle(store, api, "session.idle", { sessionID: "child" }, {
    type: "session.idle",
    timestamp: 500,
    properties: { sessionID: "child" },
  }, 4);
  assert.equal(store.taskRuns.get("child")?.lastRunWallTime?.wallTime, 300);
  store.disposeSignals();
});

test("child-first run can migrate while still active without losing its start", () => {
  const store = createRuntimeStore(10);
  const childRun = createTaskWallRun("child");
  store.taskRuns.set("child", childRun);
  transitionTaskWallRun(childRun, "child", "busy", 2_000);
  transitionTaskWallRun(childRun, "helper", "busy", 2_500);
  transitionTaskWallRun(childRun, "child", "idle", 3_000);
  assert.equal(childRun.activeElapsed, 1_000);
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "session.created",
    properties: { session: { id: "child", parentID: "root" } },
  }), true);
  const rootRun = store.taskRuns.get("root");
  assert.equal(rootRun?.phase, "active");
  assert.equal(rootRun?.runStartedAt, 2_000);
  assert.equal(rootRun?.activeElapsed, 1_000);
  assert.equal(rootRun?.activeSessions.has("helper"), true);
  const summary = transitionTaskWallRun(rootRun!, "helper", "idle", 6_000);
  assert.equal(summary?.wallTime, 4_000);
  store.disposeSignals();
});

test("completed child run migrates its historical interval into an active root run", () => {
  const store = createRuntimeStore(10);
  const childRun = createTaskWallRun("child");
  const rootRun = createTaskWallRun("root");
  store.taskRuns.set("child", childRun);
  store.taskRuns.set("root", rootRun);
  transitionTaskWallRun(childRun, "child", "busy", 0);
  transitionTaskWallRun(childRun, "child", "idle", 1_000);
  transitionTaskWallRun(rootRun, "root", "busy", 500);
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "session.updated",
    properties: { sessionID: "child", parentID: "root" },
  }), true);
  const merged = store.taskRuns.get("root");
  assert.equal(merged?.phase, "active");
  transitionTaskWallRun(merged!, "root", "idle", 2_000);
  assert.equal(merged?.lastRunWallTime?.wallTime, 2_000);
  store.disposeSignals();
});

test("completed child history and a later root interval remain a disjoint union", () => {
  const store = createRuntimeStore(10);
  const childRun = createTaskWallRun("child");
  const rootRun = createTaskWallRun("root");
  store.taskRuns.set("child", childRun);
  store.taskRuns.set("root", rootRun);
  transitionTaskWallRun(childRun, "child", "busy", 0);
  transitionTaskWallRun(childRun, "child", "idle", 1_000);
  transitionTaskWallRun(rootRun, "root", "busy", 1_500);
  cacheSessionParentFromEvent(store, {
    type: "session.updated",
    properties: { sessionID: "child", parentID: "root" },
  });
  const merged = store.taskRuns.get("root")!;
  const summary = transitionTaskWallRun(merged, "root", "idle", 2_000);
  assert.equal(summary?.wallTime, 1_500);
  store.disposeSignals();
});

test("mapping merges child and root runs without losing active union state", () => {
  const store = createRuntimeStore(10);
  const childRun = createTaskWallRun("child");
  const rootRun = createTaskWallRun("root");
  store.taskRuns.set("child", childRun);
  store.taskRuns.set("root", rootRun);
  transitionTaskWallRun(childRun, "child", "busy", 1_000);
  transitionTaskWallRun(rootRun, "root", "busy", 1_500);
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "session.updated",
    properties: { sessionID: "child", parentID: "root" },
  }), true);
  const merged = store.taskRuns.get("root");
  assert.equal(merged?.runStartedAt, 1_000);
  assert.equal(merged?.activeSessions.has("root"), true);
  transitionTaskWallRun(merged!, "root", "idle", 5_000);
  const summary = transitionTaskWallRun(merged!, "child", "idle", 5_000);
  assert.equal(summary?.wallTime, 4_000);
  store.disposeSignals();
});

test("message completion does not end a busy task participant", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 1_000);
  assert.equal(noteTaskRunRecord(run, "root", 1_000, 2_000), undefined);
  assert.equal(run.phase, "active");
  const summary = transitionTaskWallRun(run, "root", "idle", 4_000);
  assert.equal(summary?.wallTime, 3_000);
});

test("root idle waits for child, and parallel participants are counted once", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 0);
  transitionTaskWallRun(run, "child-a", "busy", 1_000);
  transitionTaskWallRun(run, "child-b", "busy", 1_000);
  transitionTaskWallRun(run, "root", "idle", 2_000);
  assert.equal(run.phase, "active");
  transitionTaskWallRun(run, "child-a", "idle", 3_000);
  const summary = transitionTaskWallRun(run, "child-b", "idle", 4_000);
  assert.equal(summary?.wallTime, 4_000);
});

test("a completed record does not invent a task wall run without lifecycle start", () => {
  const store = createRuntimeStore(10);
  noteTaskRecord(store, {} as TuiPluginApi, record("completed", "root"));
  assert.equal(store.taskRuns.size, 0);
  assert.equal(taskWallTimeForSession(store, "root"), undefined);
  store.disposeSignals();
});

test("retry-only root starts and completes one task wall run", () => {
  const run = createTaskWallRun("root");
  assert.equal(transitionTaskWallRun(run, "root", "retry", 1_000), undefined);
  assert.equal(run.phase, "active");
  assert.equal(run.runStartedAt, 1_000);
  const summary = transitionTaskWallRun(run, "root", "idle", 4_000);
  assert.equal(summary?.runEpoch, 1);
  assert.equal(summary?.wallTime, 3_000);
});

test("late parent mapping migrates a child-key run to the root", () => {
  const store = createRuntimeStore(10);
  const childRun = createTaskWallRun("child");
  store.taskRuns.set("child", childRun);
  transitionTaskWallRun(childRun, "child", "busy", 1_000);
  const summary = transitionTaskWallRun(childRun, "child", "idle", 5_000);
  assert.equal(summary?.wallTime, 4_000);

  assert.equal(cacheSessionParentFromEvent(store, {
    type: "session.updated",
    properties: { info: { id: "child", parentID: "root" } },
  }), true);
  assert.equal(store.sessionParents.get("child"), "root");
  assert.equal(store.taskRuns.has("child"), false);
  assert.equal(store.taskRuns.has("root"), true);
  assert.equal(taskWallTimeForSession(store, "root"), 4_000);

  assert.equal(cacheSessionParentFromEvent(store, {
    payload: {
      type: "session.created",
      properties: {
        session: { sessionID: "another-child", parentSessionID: "root" },
      },
    },
  }), true);
  assert.equal(store.sessionParents.get("another-child"), "root");
  store.disposeSignals();
});

test("v1.18.18 session.status payload drives retry and idle lifecycle", () => {
  const store = createRuntimeStore(10);
  const api = {} as TuiPluginApi;
  const retry = {
    type: "session.status",
    timestamp: 1_000,
    properties: {
      sessionID: "root",
      status: { type: "retry", attempt: 1, message: "retrying", next: 2_000 },
    },
  };
  handleSessionLifecycle(store, api, retry.type, retry.properties, retry, 5.5);
  assert.equal(store.taskRuns.get("root")?.phase, "active");

  const idle = {
    type: "session.status",
    timestamp: 3_500,
    properties: {
      sessionID: "root",
      status: { type: "idle" },
    },
  };
  assert.equal(handleSessionLifecycle(store, api, idle.type, idle.properties, idle, 5.5), true);
  assert.equal(taskWallTimeForSession(store, "root"), 2_500);
  store.disposeSignals();
});

test("persisted activity contributes across completed intervals without taskRuns", () => {
  const store = createRuntimeStore(10);
  hydrateActivity(store, [
    activityLifecycle("root", "busy", 0),
    activityLifecycle("root", "idle", 2_000),
    activityLifecycle("root", "busy", 10_000),
    activityLifecycle("root", "completed", 16_000),
  ]);
  assert.equal(taskWallTimeForSession(store, "root", 20_000), 8_000);
  assert.equal(store.taskRuns.size, 0);
  store.disposeSignals();
});

test("persisted root and child activity uses one interval union", () => {
  const store = createRuntimeStore(10);
  hydrateActivity(store, [
    { kind: "parent", sessionID: "child", parentSessionID: "root", timestamp: 0 },
    activityLifecycle("root", "busy", 0),
    activityLifecycle("child", "busy", 500),
    activityLifecycle("root", "idle", 1_000),
    activityLifecycle("child", "idle", 2_000),
  ]);
  assert.equal(taskWallTimeForSession(store, "child", 3_000), 2_000);
  store.disposeSignals();
});

test("persisted intervals and live task overlay are merged without double counting", () => {
  const store = createRuntimeStore(10);
  hydrateActivity(store, [
    activityLifecycle("root", "busy", 0),
    activityLifecycle("root", "idle", 1_000),
  ]);
  const run = createTaskWallRun("root");
  store.taskRuns.set("root", run);
  transitionTaskWallRun(run, "root", "busy", 500);
  transitionTaskWallRun(run, "root", "idle", 1_500);
  assert.equal(taskWallTimeForSession(store, "root", 2_000), 1_500);
  store.disposeSignals();
});

test("canonical v2 retry and failed lifecycle transitions the live task run", () => {
  const store = createRuntimeStore(10);
  const api = {} as TuiPluginApi;
  const retried = {
    type: "session.next.retried",
    timestamp: 1_000,
    properties: { sessionID: "root" },
  };
  assert.equal(handleSessionLifecycle(store, api, retried.type, retried.properties, retried, 4), false);
  assert.equal(store.taskRuns.get("root")?.phase, "active");
  const failed = {
    type: "session.next.step.failed",
    timestamp: 2_000,
    properties: { sessionID: "root" },
  };
  assert.equal(handleSessionLifecycle(store, api, failed.type, failed.properties, failed, 4), true);
  assert.equal(store.taskRuns.get("root")?.lastRunWallTime?.wallTime, 1_000);
  store.disposeSignals();
});

test("historical idle and failed events do not freeze the current session runtime", () => {
  const store = createRuntimeStore(10);
  const api = {} as TuiPluginApi;
  const lifecycle = (type: string, timestamp: number) => ({
    type,
    timestamp,
    properties: { sessionID: "root" },
  });

  handleSessionLifecycle(store, api, "session.status", { sessionID: "root", status: "busy" }, lifecycle("session.status", 0), 4);
  handleSessionLifecycle(store, api, "session.idle", { sessionID: "root" }, lifecycle("session.idle", 100), 4);
  handleSessionLifecycle(store, api, "session.status", { sessionID: "root", status: "busy" }, lifecycle("session.status", 200), 4);
  const runtime = store.sessionRuntime.get("root")!;
  const liveRecord = record("message", "root", 7, 1, {
    time: { start: 200, firstToken: 220, completed: 250, ttft: 20, duration: 50 },
  });
  applyRecordToSessionRuntime(runtime, liveRecord);
  runtime.activeMessageID = "message";
  const runEpoch = runtime.runEpoch;
  const runStartedAt = runtime.runStartedAt;
  const runTotals = { ...runtime.runTotals };
  const contributionCount = runtime.contributions.size;
  store.active.set("message", createActiveState("message", "root", 210));

  const revisionBeforeHistory = store.revision();
  handleSessionLifecycle(store, api, "session.idle", { sessionID: "root" }, lifecycle("session.idle", 50), 4);
  assert.equal(store.revision() > revisionBeforeHistory, true);
  handleSessionLifecycle(
    store,
    api,
    "session.next.step.failed",
    { sessionID: "root" },
    lifecycle("session.next.step.failed", 60),
    4,
  );
  assert.equal(runtime.status, "busy");
  assert.equal(runtime.runEpoch, runEpoch);
  assert.equal(runtime.runStartedAt, runStartedAt);
  assert.deepEqual(runtime.runTotals, runTotals);
  assert.equal(runtime.activeMessageID, "message");
  assert.equal(runtime.contributions.size, contributionCount);
  assert.equal(runtime.lastRunSummary?.completedAt, 100);
  assert.equal(store.active.has("message"), true);
  assert.equal(store.taskRuns.get("root")?.phase, "active");

  handleSessionLifecycle(store, api, "session.idle", { sessionID: "root" }, lifecycle("session.idle", 300), 4);
  assert.equal(runtime.status, "idle");
  assert.equal(runtime.lastRunSummary?.completedAt, 300);
  assert.equal(store.taskRuns.get("root")?.phase, "idle");
  store.disposeSignals();
});

test("message parentID is not treated as a session parent", () => {
  const store = createRuntimeStore(10);
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "message.updated",
    properties: { info: { id: "message", sessionID: "child", parentID: "parent-message" } },
  }), false);
  assert.equal(store.sessionParents.has("child"), false);
  store.disposeSignals();
});

test("projectSessionTotals keeps ledger usage that is outside the history window", () => {
  const counted = {
    tokens: { input: 0, output: 1000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    responseCount: 1,
  };
  const base = {
    version: 1 as const,
    sessions: { root: counted },
    open: {},
    settled: {},
  };
  assert.equal(
    projectSessionTotals(base, [], new Map(), "root").including.tokens.output,
    1000,
  );

  const extra = record("extra", "root", 40, 0, {
    tokens: { input: 0, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  const added = projectSessionTotals(base, [extra], new Map(), "root");
  assert.equal(added.including.tokens.output, 1040);
  assert.equal(added.including.responseCount, 2);

  const same = record("same", "root", 10, 0, {
    tokens: { input: 0, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 1,
  });
  const opened = projectSessionTotals({
    sessions: {
      root: { tokens: same.tokens, cost: same.cost, responseCount: 1 },
    },
    open: {
      same: {
        sessionID: "root",
        quality: "exact" as const,
        tokens: same.tokens,
        cost: same.cost,
      },
    },
  }, [same], new Map(), "root");
  assert.equal(opened.including.tokens.output, 10);
  assert.equal(opened.including.responseCount, 1);

  const settledMessage = record("settled", "root", 25, 0, {
    tokens: { input: 0, output: 25, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  const settled = projectSessionTotals({
    sessions: { root: counted },
    open: {},
    settled: { settled: true },
  }, [settledMessage], new Map(), "root");
  assert.equal(settled.including.tokens.output, 1000);
  assert.equal(settled.including.responseCount, 1);

  const corrected = record("corrected", "root", 0, 0, {
    tokens: { input: 15, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });
  const correctedTotals = projectSessionTotals({
    sessions: {
      root: {
        tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        responseCount: 1,
      },
    },
    open: {},
    settled: {
      corrected: {
        sessionID: "root",
        quality: "exact",
        tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
      },
    },
  }, [corrected], new Map(), "root");
  assert.equal(correctedTotals.including.tokens.input, 15);
  assert.equal(correctedTotals.including.responseCount, 1);

  const parents = new Map<string, string>([["child", "root"]]);
  const parentRollup = projectSessionTotals({
    sessions: {
      root: {
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        responseCount: 0,
      },
      child: counted,
    },
    open: {},
  }, [], parents, "root");
  assert.equal(parentRollup.direct.tokens.output, 0);
  assert.equal(parentRollup.direct.responseCount, 0);
  assert.equal(parentRollup.including.tokens.output, 1000);
  assert.equal(parentRollup.including.responseCount, 1);
});

test("activity reload uses the sidecar path and only reads it", async () => {
  assert.equal(resolveRunsPath("/tmp/project/history.jsonl"), "/tmp/project/runs.jsonl");
  assert.equal(
    resolveRunsPath("/tmp/project/history.jsonl", "activity/runs.jsonl"),
    "/tmp/project/activity/runs.jsonl",
  );
  const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8");
  assert.match(source, /readActivityFile/);
  assert.match(source, /resolveRunsPath\(historyPath, options\.runsPath\)/);
  assert.doesNotMatch(source, /activity\.(append|rewrite|compact)\(/);
});

test("main average uses cumulative direct speed, excluding children and the detail window", () => {
  const store = createRuntimeStore(1);
  const speed = updateSpeedTotals(emptySpeedTotals(), {
    generation: { generatedTokens: 120, durationMs: 2000, estimated: false },
    response: { generatedTokens: 120, durationMs: 4000, estimated: false },
  }, 1)!;
  const childSpeed = updateSpeedTotals(emptySpeedTotals(), {
    generation: { generatedTokens: 9000, durationMs: 1000, estimated: false },
    response: { generatedTokens: 9000, durationMs: 2000, estimated: false },
  }, 1)!;
  store.totalsLedger.sessions = {
    root: { tokens: tokens(100, 20), cost: 1, responseCount: 1, speed },
    child: { tokens: tokens(9000, 0), cost: 2, responseCount: 1, speed: childSpeed },
  };
  store.sessionParents.set("child", "root");
  rememberVisibleSession(store, "child");
  const summary = sessionUsageSummary(store, displayedSessionID(store, "root"));
  assert.equal(summary.generation.rate, 60);
  assert.equal(summary.response.rate, 30);
  assert.equal(summary.totalGeneratedTokens, 120);
  assert.deepEqual(sessionAverageDisplay(summary), { label: "Main avg TPS", value: "60 tok/s" });
  assert.equal(sessionAverageDisplay(sessionUsageSummary(store, "child"), true).label, "Session avg TPS");
  // Reload with the same ledger and no detail records: average stays cumulative.
  const reloaded = createRuntimeStore(1);
  reloaded.totalsLedger = structuredClone(store.totalsLedger);
  reloaded.sessionParents = new Map(store.sessionParents);
  assert.equal(sessionUsageSummary(reloaded, "root").generation.rate, 60);
  store.disposeSignals();
  reloaded.disposeSignals();
});

test("main average uses ratio of cumulative sums and identifies partial estimated timing", () => {
  const store = createRuntimeStore(1);
  let speed = updateSpeedTotals(emptySpeedTotals(), { generation: { generatedTokens: 1, durationMs: 100, estimated: false } }, 1);
  speed = updateSpeedTotals(speed, { generation: { generatedTokens: 100, durationMs: 1000, estimated: true } }, 1);
  store.totalsLedger.sessions.root = { tokens: tokens(150, 0), cost: 0, responseCount: 3, speed };
  const summary = sessionUsageSummary(store, "root");
  assert.equal(summary.generation.rate, 101000 / 1100);
  assert.notEqual(summary.generation.rate, (10 + 100) / 2);
  assert.deepEqual(sessionAverageDisplay(summary), { label: "Main avg TPS", value: "~92 tok/s", coverage: "Measured 2/3 calls" });
  const response = updateSpeedTotals(emptySpeedTotals(), { response: { generatedTokens: 150, durationMs: 3000, estimated: true } }, 1);
  store.totalsLedger.sessions.root = { tokens: tokens(150, 0), cost: 0, responseCount: 1, speed: response };
  assert.equal(sessionAverageDisplay(sessionUsageSummary(store, "root")).value, "~50 tok/s (response)");
  assert.equal(sessionAverageDisplay(sessionUsageSummary(store, "missing")).value, "--");
  store.disposeSignals();
});

test("prompt warms up without fake LIVE zero, becomes ready, and respects known tool waits", () => {
  const store = createRuntimeStore(10);
  const active = createActiveState("m", "root", 0);
  active.selectedSource = "legacy";
  active.legacy.hasData = true;
  active.legacy.samples = [{ timestamp: 0, tokens: 10 }];
  store.active.set("m", active);
  assert.equal(liveLabel(store, "root", 5.5, 20, 500), "WARMUP --");
  active.legacy.samples.push({ timestamp: 1000, tokens: 20 });
  assert.equal(liveLabel(store, "root", 5.5, 20, 1000), "LIVE ~20 tok/s");
  assert.equal(liveLabel(store, "root", 5.5, 20, 1000, true), "WAIT --");
  assert.equal(liveLabel(store, "root", 5.5, 20, 11000), "WAIT --");
  assert.equal(liveLabel(store, "other", 5.5, 20, 1000), "IDLE");
  store.active.clear();
  store.lastCompletedBySession.set("root", makeLastCompletedSnapshot(record("done", "root", 10, 0)));
  active.sessionID = "child";
  store.active.set("child", active);
  assert.match(liveLabel(store, "root", 5.5, 20, 1000), /^LAST /);
  store.disposeSignals();
});

test("plugin options preserve native key strings and explicit disabled shortcuts", () => {
  const bindings = (value?: unknown) => tokenPulseBindings(resolveOptions(value === undefined ? {} : { keybinds: { [DETAILS_COMMAND_NAME]: value } }));
  assert.equal(bindings().find((item) => item.cmd === DETAILS_COMMAND_NAME)?.key, "ctrl+shift+y");
  for (const value of [false, "none", []]) assert.equal(bindings(value).some((item) => item.cmd === DETAILS_COMMAND_NAME), false);
  for (const value of ["ctrl+alt+y", "ctrl+x,ctrl+y", "<leader>y"]) {
    assert.equal(bindings(value).find((item) => item.cmd === DETAILS_COMMAND_NAME)?.key, value);
  }
  assert.equal(bindings(["ctrl+alt+y", "<leader>y"]).filter((item) => item.cmd === DETAILS_COMMAND_NAME).length, 2);
  for (const value of [true, 42, null, { key: 3 }, [false]]) {
    assert.equal(bindings(value).find((item) => item.cmd === DETAILS_COMMAND_NAME)?.key, "ctrl+shift+y");
  }
  const historyDisabled = tokenPulseBindings(resolveOptions({ keybinds: { "oc-tps.history": false } }));
  assert.equal(historyDisabled.some((item) => item.cmd === "oc-tps.history"), false);
});

test("native details command snapshots the route session, protects other dialogs, and closes without recursive clear", () => {
  const store = createRuntimeStore(10);
  let route: TuiPluginApi["route"]["current"] = { name: "session", params: { sessionID: "root" } };
  let dialogOpen = false;
  let replaces = 0;
  let clears = 0;
  let onClose: (() => void) | undefined;
  type RegisteredLayer = Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0];
  const registered: RegisteredLayer[] = [];
  const order: string[] = [];
  const notices: string[] = [];
  const disposeCallbacks: (() => void)[] = [];
  let unregisters = 0;
  let historyRuns = 0;
  const api = {
    route: { get current() { return route; } },
    ui: {
      toast: (input: { message: string }) => notices.push(input.message),
      Dialog: () => { throw new Error("Do not nest a second host overlay"); },
      dialog: {
        get open() { return dialogOpen; },
        replace: (_render: () => unknown, close: () => void) => { replaces++; dialogOpen = true; onClose = close; order.push("replace"); },
        setSize: (size: string) => { order.push(size); },
        clear: () => { clears++; },
      },
    },
    keymap: { registerLayer: (layer: RegisteredLayer) => { registered.push(layer); return () => { unregisters++; }; } },
    lifecycle: { onDispose: (dispose: () => void) => disposeCallbacks.push(dispose) },
  } as unknown as TuiPluginApi;
  const details = registerTokenPulseCommands(api, store, resolveOptions({}), () => { historyRuns++; });
  assert.equal(registered.length, 2);
  assert.equal(registered[0].mode, undefined);
  assert.equal(registered[0].bindings, undefined);
  assert.equal(registered[1].mode, "base");
  assert.equal(registered[1].commands, undefined);
  const commands = registered[0].commands as { name: string; title: string; desc: string; namespace: string; slashName: string; run: () => void }[];
  const command = commands.find((item) => item.name === DETAILS_COMMAND_NAME)!;
  assert.equal(command.title, "Token Pulse details");
  assert.equal(command.slashName, "tps-details");
  assert.equal(command.namespace, "palette");
  assert.equal(typeof command.desc, "string");
  assert.equal("description" in command, false);
  command.run();
  assert.equal(details.owned, true);
  assert.equal(details.sessionID, "root");
  assert.deepEqual(order, ["replace", "large"]);
  route = { name: "session", params: { sessionID: "child" } };
  command.run();
  assert.equal(replaces, 1);
  assert.equal(details.sessionID, "root");
  onClose!();
  dialogOpen = false;
  assert.equal(details.owned, false);
  assert.equal(details.sessionID, undefined);
  assert.equal(clears, 0);
  command.run();
  assert.equal(details.sessionID, "child");
  onClose!();
  dialogOpen = true; // An unrelated host modal owns the stack now.
  command.run();
  assert.equal(replaces, 2);
  assert.equal(details.owned, false);
  dialogOpen = false;
  route = { name: "home" };
  command.run();
  assert.equal(replaces, 2);
  assert.match(notices[0], /Open a session/);
  const history = commands.find((item) => item.name === "oc-tps.history")!;
  assert.equal(history.slashName, "tps");
  history.run();
  assert.equal(historyRuns, 1);
  assert.equal(registered[1].bindings?.find((item) => item.cmd === "oc-tps.history")?.key, "ctrl+shift+t");
  assert.equal(registered[1].bindings?.some((item) => item.key === "escape" || item.key === "ctrl+c"), false);
  disposeCallbacks.forEach((dispose) => dispose());
  assert.equal(unregisters, 2);
  store.disposed = true;
  route = { name: "session", params: { sessionID: "root" } };
  command.run();
  assert.equal(replaces, 2);
  store.disposeSignals();
});

test("real keymap keeps palette and slash commands reachable in modal/autocomplete but shortcuts only in base", () => {
  for (const configured of [undefined, "ctrl+alt+y", false, "none", []]) {
    const harness = createTestKeymap({ defaultKeys: true });
    const store = createRuntimeStore(10);
    const modeStack = ["base"];
    // The host's mode field uses the current mode as an activation predicate.
    // Exercise real reachability, matching and dispatch with that predicate.
    harness.keymap.registerLayerFields({ mode(value, ctx) { ctx.activeWhen(() => value === modeStack.at(-1)); } });
    const disposers: (() => void)[] = [];
    let opens = 0;
    let dialogOpen = false;
    const api = {
      route: { current: { name: "session", params: { sessionID: "root" } } },
      keymap: harness.keymap,
      lifecycle: { onDispose: (fn: () => void) => { disposers.push(fn); } },
      ui: { dialog: { get open() { return dialogOpen; }, replace: () => { opens++; dialogOpen = true; }, setSize: () => {} } },
    } as unknown as TuiPluginApi;
    try {
      registerTokenPulseCommands(api, store, resolveOptions(configured === undefined ? {} : { keybinds: { [DETAILS_COMMAND_NAME]: configured } }), () => {});
      assert.equal(disposers.length, 2);
      const enabled = configured === undefined || typeof configured === "string" && configured !== "none";
      const custom = configured === "ctrl+alt+y";
      for (const mode of ["base", "modal", "autocomplete", "oc-tps.history"]) {
        if (mode !== "base") modeStack.push(mode);
        const entries = harness.keymap.getCommandEntries({ visibility: "reachable", namespace: "palette" });
        assert.deepEqual(entries.map((entry) => entry.command.name).sort(), ["oc-tps.details", "oc-tps.history"]);
        assert.equal(entries.find((entry) => entry.command.name === DETAILS_COMMAND_NAME)?.command.slashName, "tps-details");
        const before = opens;
        dialogOpen = false; // Do not let the dialog guard hide an active global shortcut.
        harness.host.press("y", custom ? { ctrl: true, meta: true } : { ctrl: true, shift: true });
        assert.equal(opens - before, mode === "base" && enabled ? 1 : 0, `${mode}: shortcut must stay base-only`);
        dialogOpen = false;
        harness.keymap.dispatchCommand(DETAILS_COMMAND_NAME);
        assert.equal(opens, before + (mode === "base" && enabled ? 1 : 0) + 1, `${mode}: command must remain reachable`);
        if (mode !== "base") modeStack.pop();
      }
      disposers.forEach((dispose) => dispose());
      assert.equal(harness.keymap.getCommandEntries({ visibility: "registered", namespace: "palette" }).length, 0);
      dialogOpen = false;
      const before = opens;
      harness.host.press("y", { ctrl: true, shift: true });
      assert.equal(opens, before);
      assert.deepEqual(harness.diagnostics.errors, []);
    } finally {
      harness.cleanup();
      store.disposeSignals();
    }
  }
});
