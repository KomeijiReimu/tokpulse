import assert from "node:assert/strict";
import test from "node:test";
import { createActivityProjector, normalizeActivityEvent, type ActivityEvent, type ActivityEventInput, type ActivityStreamKey } from "../src/activity.js";
import { classifySessionMetadata } from "../src/scope.js";

const key = { sessionID: "root", instanceID: "epoch", executionID: "e" } satisfies ActivityStreamKey;
const fact = (input: ActivityEventInput): ActivityEvent => normalizeActivityEvent(input)!;
const life = (state: "busy" | "retry" | "completed", timestamp: number, overrides: Partial<ActivityEventInput> = {}): ActivityEvent =>
  fact({ ...key, kind: "lifecycle", state, timestamp, seq: timestamp, ...overrides } as ActivityEventInput);

test("hidden streams accept late maintenance corrections without hiding normal child time", () => {
  const projector = createActivityProjector([life("busy", 0), life("retry", 5),
    life("busy", 2, { sessionID: "child", executionID: "child-e" }), life("completed", 12, { sessionID: "child", executionID: "child-e" }),
    fact({ kind: "parent", sessionID: "child", timestamp: 0, parentSessionID: "root" })]);
  assert.deepEqual(projector.totals("root", { liveNow: 10, trustedCurrentInstanceID: "epoch" }),
    { directMilliseconds: 10, includingMilliseconds: 12, active: true });
  projector.updateStreams([{ key, mode: "hidden" }]);
  const work = (phase: "start" | "end", timestamp: number, seq: number) => fact({ ...key, kind: "work", workID: "mc", source: "step", phase, timestamp, seq,
    measurementScope: { version: 1, sourceScope: "magic-message", reasons: [] } });
  projector.ingest([work("end", 4, 8), work("start", 1, 7), life("completed", 10, { seq: 9 })]);
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 0, includingMilliseconds: 10, active: false });
  projector.updateStreams([{ key, mode: "visible" }]);
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 7, includingMilliseconds: 11, active: false });
});

test("retired streams reject stale ingestion until explicitly restored and made visible", () => {
  const events = [life("busy", 0), life("completed", 10)], projector = createActivityProjector(events);
  assert.equal(projector.totals("root").directMilliseconds, 10);
  projector.updateStreams([{ key, mode: "replace", events: [] }]);
  projector.ingest(events);
  assert.equal(projector.totals("root").directMilliseconds, 0);
  projector.updateStreams([{ key, mode: "replace", events }]);
  assert.equal(projector.totals("root").directMilliseconds, 0);
  projector.updateStreams([{ key, mode: "visible" }]);
  assert.equal(projector.totals("root").directMilliseconds, 10);
});

test("retiring a newer execution cannot revive the older execution's unknown gap", () => {
  const older = [life("busy", 0, { executionID: "old", seq: 1 }), life("retry", 3, { executionID: "old", seq: 2 })];
  const newer = life("busy", 100, { executionID: "new", seq: 3 }), projector = createActivityProjector([...older, newer]);
  projector.updateStreams([{ key: { ...key, executionID: "new" }, mode: "replace", events: [] }]);
  projector.ingest([newer]);
  assert.deepEqual(projector.totals("root", { liveNow: 2000, trustedCurrentInstanceID: "epoch" }),
    { directMilliseconds: 3, includingMilliseconds: 3, active: false });
});

test("invalid stream or context update batches leave earlier selections and metadata unchanged", () => {
  const events = [life("busy", 0), life("completed", 10)], projector = createActivityProjector(events);
  const expected = { directMilliseconds: 10, includingMilliseconds: 10, active: false };
  assert.throws(() => projector.updateStreams([{ key, mode: "hidden" }, { key, mode: "replace", events: [life("busy", 0, { sessionID: "wrong" })] }]), TypeError);
  assert.deepEqual(projector.totals("root"), expected);
  assert.throws(() => projector.patchContext({ parents: new Map([["root", "a"]]),
    sessionScopes: new Map([["root", { version: 999 } as never]]) }), TypeError);
  assert.deepEqual(projector.totals("root"), expected);
  assert.equal(projector.totals("a").includingMilliseconds, 0);
});

test("selection keys distinguish delimiter collisions and different executions of special IDs", () => {
  const keys: ActivityStreamKey[] = [{ sessionID: "a:b", instanceID: "c", executionID: "e" }, { sessionID: "a", instanceID: "b:c", executionID: "e" },
    { sessionID: "__proto__", instanceID: "constructor", executionID: "a:b" }, { sessionID: "__proto__", instanceID: "constructor", executionID: "a" }];
  const projector = createActivityProjector();
  for (const selected of keys) projector.ingest([life("busy", 0, selected), life("completed", 10, selected)]);
  projector.updateStreams([{ key: keys[0], mode: "hidden" }, { key: keys[2], mode: "replace", events: [] }]);
  assert.equal(projector.totals("a:b").directMilliseconds, 0);
  assert.equal(projector.totals("a").directMilliseconds, 10);
  assert.equal(projector.totals("__proto__").directMilliseconds, 10);
  assert.throws(() => projector.updateStreams([{ key, mode: "replace", events: [life("busy", 0, { executionID: "wrong" })] }]), TypeError);
});

test("parent patches detach and restore event ancestry without erasing inherited maintenance proof", () => {
  const projector = createActivityProjector([life("busy", 0, { sessionID: "child" }), life("completed", 10, { sessionID: "child" }),
    fact({ kind: "parent", sessionID: "child", parentSessionID: "a", timestamp: 20 })]);
  assert.equal(projector.totals("a").includingMilliseconds, 10);
  projector.patchContext({ parents: new Map([["child", "b"]]) });
  assert.equal(projector.totals("a").includingMilliseconds, 0);
  assert.equal(projector.totals("b").includingMilliseconds, 10);
  const scope = classifySessionMetadata({ agent: "historian" });
  projector.patchContext({ sessionScopes: new Map([["b", scope]]) });
  assert.equal(projector.totals("child").directMilliseconds, 0);
  projector.patchContext({ parents: new Map([["child", null]]) });
  assert.equal(projector.totals("child").directMilliseconds, 10);
  projector.patchContext({ parents: new Map([["child", undefined]]) });
  assert.equal(projector.totals("a").includingMilliseconds, 10);
  projector.ingest([life("completed", 30, { sessionID: "a", scope })]);
  projector.patchContext({ sessionScopes: new Map([["a", undefined]]) });
  assert.equal(projector.totals("child").directMilliseconds, 0);
});
