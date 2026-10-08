import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityEventInput,
  calculateActiveMilliseconds,
  dedupeActivityEvents,
  mergeIntervals,
  normalizeActivityEvent,
  replayActivity,
  calculateActiveIntervals,
  filterActivityEvents,
} from "../src/activity.js";
import { createScopeRegistry, classifyMessageMetadata } from "../src/scope.js";

test("late MC child identity retracts history intervals and cannot extend root; real child still does", () => {
  const registry = createScopeRegistry();
  const events = [
    lifecycle("busy", 0, "root", 1), lifecycle("idle", 100, "root", 2),
    lifecycle("busy", 200, "mc", 1), lifecycle("completed", 10_000, "mc", 2),
    lifecycle("busy", 300, "grand", 1), lifecycle("completed", 20_000, "grand", 2),
    lifecycle("busy", 150, "real", 1), lifecycle("completed", 250, "real", 2),
    parent("mc", "root", 30_000), parent("grand", "mc", 30_001), parent("real", "root", 30_002),
  ];
  assert.equal(replayActivity(events).rootActiveMilliseconds.root, 19_950);
  registry.observeMessageMetadata("mc", { mode: "dreamer" });
  const options = { sessionScopes: registry.serialize() };
  const projected = replayActivity(events, options);
  assert.equal(projected.rootActiveMilliseconds.root, 200);
  assert.deepEqual(projected.roots[0].sessionIDs, ["real", "root"]);
  assert.equal(projected.timelines.has("grand"), false);
  assert.deepEqual(calculateActiveIntervals(events, options), [{ start: 0, end: 100 }, { start: 150, end: 250 }]);
  assert.equal(filterActivityEvents(events, options.sessionScopes).some((event) => event.sessionID === "mc"), false);
  assert.equal(events.length, 11);
});

test("current epoch trust never extends prior open epoch; explicit historic bounds survive scope projection", () => {
  const events = [
    { ...lifecycle("busy", 0, "user", 1, "prior"), lastObservedAt: 100 },
    lifecycle("busy", 500, "user", 1, "current"),
    lifecycle("busy", 10, "unbounded-old", 1, "old"),
    { ...lifecycle("busy", 10, "mc", 1, "current"), scope: classifyMessageMetadata({ mode: "dreamer" }) },
  ];
  const replay = replayActivity(events, { replayCutoff: 1_000, trustedCurrentInstanceID: "current" });
  assert.equal(replay.rootActiveMilliseconds.user, 600);
  assert.equal(replay.rootActiveMilliseconds["unbounded-old"], 0);
  assert.equal(replay.timelines.has("mc"), false);
  assert.equal(replay.timelines.get("user")?.instances.find((instance) => instance.instanceID === "prior")?.boundary, 100);
});

test("external late parent scopes exclude cyclic descendants and retain pending users", () => {
  const events = [lifecycle("busy", 0, "a", 1), lifecycle("completed", 100, "a", 2), lifecycle("busy", 0, "pending", 1), lifecycle("completed", 20, "pending", 2)];
  const result = replayActivity(events, { sessionScopes: { b: classifyMessageMetadata({ agent: "historian" }) }, parentBySessionID: { a: "b", b: "a" } });
  assert.equal(result.timelines.has("a"), false);
  assert.equal(result.rootActiveMilliseconds.pending, 20);
});

test("sequential runs count active time and exclude idle gaps", () => {
  const replay = replayActivity([
    lifecycle("busy", 0, "session", 1, "run-1"),
    lifecycle("idle", 1_000, "session", 2, "run-1"),
    lifecycle("busy", 3_000, "session", 1, "run-2"),
    lifecycle("completed", 5_000, "session", 2, "run-2"),
  ]);

  assert.deepEqual(replay.roots[0]?.activeIntervals, [
    { start: 0, end: 1_000 },
    { start: 3_000, end: 5_000 },
  ]);
  assert.equal(replay.roots[0]?.activeMilliseconds, 3_000);
});

test("root and child overlap is unioned, including child-first late parent mapping", () => {
  const replay = replayActivity([
    lifecycle("busy", 1_000, "child", 1),
    lifecycle("completed", 4_000, "child", 3),
    lifecycle("busy", 0, "root", 1),
    lifecycle("idle", 5_000, "root", 2),
    parent("child", "root", 6_000),
  ]);

  const root = replay.roots.find((entry) => entry.rootSessionID === "root");
  assert.ok(root);
  assert.deepEqual(root.sessionIDs, ["child", "root"]);
  assert.deepEqual(root.activeIntervals, [{ start: 0, end: 5_000 }]);
  assert.equal(root.activeMilliseconds, 5_000);
});

test("busy and retry are active while idle and terminal states are inactive", () => {
  const replay = replayActivity([
    lifecycle("busy", 0, "session", 1),
    lifecycle("retry", 100, "session", 2),
    lifecycle("idle", 200, "session", 3),
    lifecycle("busy", 300, "session", 4),
    lifecycle("failed", 500, "session", 5),
  ]);

  assert.equal(replay.rootActiveMilliseconds.session, 400);
  assert.deepEqual(replay.timelines.get("session")?.activeIntervals, [
    { start: 0, end: 200 },
    { start: 300, end: 500 },
  ]);
});

test("duplicate and out-of-order events replay by timestamp and sequence", () => {
  const busy = lifecycle("busy", 100, "session", 1, "default", "busy");
  const idle = lifecycle("idle", 500, "session", 2, "default", "idle");
  const replay = replayActivity([idle, busy, busy, idle]);

  assert.equal(dedupeActivityEvents([idle, busy, busy, idle]).length, 2);
  assert.deepEqual(replay.roots[0]?.activeIntervals, [{ start: 100, end: 500 }]);
  assert.equal(normalizeActivityEvent({
    sessionID: "without-id",
    kind: "lifecycle",
    state: "busy",
    timestamp: 1,
  })?.eventID, normalizeActivityEvent({
    sessionID: "without-id",
    kind: "lifecycle",
    state: "busy",
    timestamp: 1,
  })?.eventID);
});

test("ID-less identity preserves boundaries and replay is input-order stable", () => {
  const withoutBoundary: ActivityEventInput = {
    kind: "lifecycle",
    state: "busy",
    timestamp: 0,
    sessionID: "session",
    instanceID: "instance",
  };
  const withBoundary: ActivityEventInput = {
    ...withoutBoundary,
    instanceEndedAt: 500,
    lastObservedAt: 450,
  };
  const first = replayActivity([withoutBoundary, withBoundary]);
  const second = replayActivity([withBoundary, withoutBoundary]);

  assert.notEqual(
    normalizeActivityEvent(withoutBoundary)?.eventID,
    normalizeActivityEvent(withBoundary)?.eventID,
  );
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.timelines.get("session"), second.timelines.get("session"));
  assert.equal(first.timelines.get("session")?.instances[0]?.boundary, 450);
  assert.equal(first.timelines.get("session")?.instances[0]?.events.length, 2);
});

test("ID-less fingerprints include observed and boundary metadata", () => {
  const base: ActivityEventInput = {
    kind: "lifecycle",
    state: "busy",
    timestamp: 10,
    sessionID: "session",
    instanceID: "instance",
  };
  const variants = [
    { ...base, observedAt: 11 },
    { ...base, instanceEndedAt: 20 },
    { ...base, lastObservedAt: 30 },
  ];
  const eventIDs = [base, ...variants].map((event) => normalizeActivityEvent(event)?.eventID);

  assert.equal(new Set(eventIDs).size, 4);
  assert.equal(dedupeActivityEvents([base, ...variants]).length, 4);
});

test("conflicting payloads with one explicit eventID are retained", () => {
  const busy = lifecycle("busy", 100, "session", 1, "default", "shared-id");
  const completed = lifecycle("completed", 200, "session", 2, "default", "shared-id");
  const deduped = dedupeActivityEvents([busy, busy, completed, completed]);

  assert.equal(deduped.length, 2);
  assert.deepEqual(
    deduped.map((event) => event.kind === "lifecycle" ? event.state : undefined),
    ["busy", "completed"],
  );
  assert.equal(replayActivity([completed, busy]).events.length, 2);
  assert.deepEqual(
    replayActivity([completed, busy]).events,
    replayActivity([busy, completed]).events,
  );
});

test("an old instance is not extended by current cutoff without explicit trust", () => {
  const events = [lifecycle("busy", 1_000, "session", 1, "old-instance")];
  assert.equal(replayActivity(events).roots[0]?.activeMilliseconds, 0);
  assert.equal(replayActivity(events, { replayCutoff: 4_000 }).roots[0]?.activeMilliseconds, 0);
  assert.equal(replayActivity(events, { replayCutoff: 4_000, trustedCurrentInstanceID: "old-instance" }).roots[0]?.activeMilliseconds, 3_000);
  assert.equal(replayActivity(events, { instanceEndedAt: { "old-instance": 2_500 } }).roots[0]?.activeMilliseconds, 1_500);
});

test("interval calculation and replay both bound lifecycle events without guessing historical open ends", () => {
  const events = [
    lifecycle("busy", 100, "session", 1, "historical"),
    lifecycle("idle", 500, "session", 2, "historical"),
  ];
  assert.deepEqual(calculateActiveIntervals(events), [{ start: 100, end: 500 }]);
  for (const cutoff of [{ replayCutoff: 300 }, { cutoff: 300 }, { until: 300 }, 300]) {
    assert.deepEqual(calculateActiveIntervals(events, cutoff), []);
    assert.deepEqual(replayActivity(events, cutoff).timelines.get("session")?.intervals, []);
    const trusted = { ...(typeof cutoff === "number" ? { replayCutoff: cutoff } : cutoff), trustedCurrentInstanceID: "historical" };
    assert.deepEqual(calculateActiveIntervals(events, trusted), [{ start: 100, end: 300 }]);
    assert.deepEqual(replayActivity(events, trusted).timelines.get("session")?.intervals, [{ start: 100, end: 300 }]);
  }
});

test("cutoff filtering keeps late scope evidence and parent ancestry available to both interval APIs", () => {
  const events = [
    lifecycle("busy", 100, "user", 1), lifecycle("idle", 200, "user", 2),
    lifecycle("busy", 50, "child", 1), lifecycle("idle", 250, "child", 2),
    parent("child", "mc", 500),
    { ...lifecycle("busy", 600, "mc", 1), scope: classifyMessageMetadata({ mode: "dreamer" }) },
  ];
  for (const options of [{ replayCutoff: 300 }, { replayCutoff: 300, trustedCurrentInstanceID: "default" }]) {
    const replay = replayActivity(events, options);
    assert.equal(replay.timelines.has("child"), false);
    assert.deepEqual(calculateActiveIntervals(events, options), [{ start: 100, end: 200 }]);
    assert.deepEqual(mergeIntervals(replay.roots.flatMap((root) => root.activeIntervals)), [{ start: 100, end: 200 }]);
  }
});

test("unknown participants remain visible and interval helpers use half-open unions", () => {
  const replay = replayActivity([
    lifecycle("busy", 10, "unknown-agent", 1),
    lifecycle("completed", 20, "unknown-agent", 2),
  ]);
  assert.equal(replay.timelines.has("unknown-agent"), true);
  assert.equal(calculateActiveMilliseconds([
    { start: 0, end: 10 },
    { start: 5, end: 20 },
    { start: 20, end: 25 },
  ]), 25);
  assert.deepEqual(mergeIntervals([{ start: 3, end: 3 }, { start: 1, end: 2 }]), [{ start: 1, end: 2 }]);
});

function lifecycle(
  state: "busy" | "retry" | "idle" | "completed" | "failed" | "aborted" | "cancelled" | "stopped",
  timestamp: number,
  sessionID: string,
  seq: number,
  instanceID = "default",
  eventID?: string,
): ActivityEventInput {
  return {
    kind: "lifecycle",
    state,
    timestamp,
    sessionID,
    seq,
    instanceID,
    ...(eventID ? { eventID } : {}),
  };
}

function parent(sessionID: string, parentSessionID: string, timestamp: number): ActivityEventInput {
  return { kind: "parent", sessionID, parentSessionID, timestamp };
}
