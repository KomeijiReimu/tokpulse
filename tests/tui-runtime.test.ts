import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { HistoryRecord, TokenCounts } from "../src/core.js";
import {
  aggregateSpeed,
  applyRecordToSessionRuntime,
  cacheHitRate,
  cacheSessionParentFromEvent,
  createActiveState,
  createRuntimeStore,
  createSessionRuntime,
  createTaskWallRun,
  createTuiSlotPlugin,
  finalSamples,
  formatCacheHitRate,
  formatCompactNumber,
  formatCompactRate,
  formatPulseMetrics,
  formatPulseSummary,
  freezeSessionRun,
  handleSessionLifecycle,
  historyRecordsEquivalent,
  lockStreamSource,
  makeLastCompletedSnapshot,
  mergeHistoryLayers,
  noteTaskRecord,
  recordSpeedSummary,
  selectedSamples,
  takeActiveState,
  taskWallTimeForSession,
  totalTokens,
  togglePulse,
  transitionTaskWallRun,
  transitionSessionRuntime,
} from "../src/tui.js";

function tokens(output: number, reasoning = 0): TokenCounts {
  return {
    input: 10,
    output,
    reasoning,
    cacheRead: 2,
    cacheWrite: 1,
  };
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
  assert.equal(formatCompactNumber(1_000_000_000), "1.0B");
  assert.equal(formatCompactRate(57_500), "57.5k tok/s");
});

test("total token count excludes cache writes and collapsed pulse shows speed", () => {
  const counts: TokenCounts = {
    input: 10,
    output: 20,
    reasoning: 5,
    cacheRead: 2,
    cacheWrite: 900,
  };
  assert.equal(totalTokens(counts), 37);
  assert.equal(cacheHitRate({ ...counts, input: 0, cacheRead: 0 }), undefined);
  assert.equal(formatCacheHitRate(undefined), "--");
  assert.equal(cacheHitRate({ ...counts, input: 10, cacheRead: 0 }), 0);
  assert.equal(formatCacheHitRate(cacheHitRate({ ...counts, input: 10, cacheRead: 0 })), "0%");
  assert.equal(cacheHitRate({ ...counts, input: 0, cacheRead: 10 }), 1);
  assert.equal(formatCacheHitRate(cacheHitRate({ ...counts, input: 0, cacheRead: 10 })), "100%");
  const mixed = { ...counts, input: 10, cacheRead: 2, cacheWrite: 0 };
  assert.equal(cacheHitRate(mixed), 2 / 12);
  assert.equal(cacheHitRate({ ...mixed, cacheWrite: 900 }), 2 / 12);
  assert.equal(formatCacheHitRate(cacheHitRate(mixed)), "17%");
  assert.equal(formatPulseMetrics(counts, 293), "37 total · 293 tok/s · cache 17%");
  assert.equal(formatPulseMetrics({ ...counts, input: 0, output: 0, reasoning: 0, cacheRead: 0 }, 0), "0 total · cache --");
  assert.equal(formatPulseSummary(counts, 293), "+ Token Pulse  37 total · 293 tok/s · cache 17%");
  assert.equal(formatPulseSummary({ ...counts, input: 0, output: 0, reasoning: 0, cacheRead: 0 }, 0), "+ Token Pulse  0 total · cache --");
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
  assert.match(source, /Cache hit rate/);
  assert.match(source, /formatCacheHitRate\(cacheHitRate\(tokens\)\)/);
  assert.match(source, /backgroundColor=\{props\.api\.theme\.current\.backgroundElement\}/);
  assert.match(source, /CHILD AGENTS/);
  assert.match(source, /Total tokens \(input \+ generated\)/);
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

test("task wall time starts a new epoch after a long idle gap", () => {
  const run = createTaskWallRun("root");
  transitionTaskWallRun(run, "root", "busy", 1_000);
  const first = transitionTaskWallRun(run, "root", "idle", 3_000);
  assert.equal(first?.wallTime, 2_000);
  transitionTaskWallRun(run, "root", "busy", 10_000_000);
  const second = transitionTaskWallRun(run, "root", "idle", 10_006_000);
  assert.equal(second?.runEpoch, 2);
  assert.equal(second?.wallTime, 6_000);

  const store = createRuntimeStore(10);
  store.taskRuns.set("root", run);
  assert.equal(taskWallTimeForSession(store, "root"), 6_000);
  store.disposeSignals();
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
