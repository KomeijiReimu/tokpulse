import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityEventInput,
  calculateActiveMilliseconds,
  dedupeActivityEvents,
  mergeIntervals,
  normalizeActivityEvent,
  replayActivity,
} from "../src/activity.js";

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

test("an old instance is not extended to now and can be closed by a cutoff", () => {
  const events = [lifecycle("busy", 1_000, "session", 1, "old-instance")];
  assert.equal(replayActivity(events).roots[0]?.activeMilliseconds, 0);
  assert.equal(replayActivity(events, { replayCutoff: 4_000 }).roots[0]?.activeMilliseconds, 3_000);
  assert.equal(replayActivity(events, { instanceEndedAt: { "old-instance": 2_500 } }).roots[0]?.activeMilliseconds, 1_500);
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
