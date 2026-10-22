import assert from "node:assert/strict";
import test from "node:test";
import { activityProjectionDiagnostics, createActivityProjector, normalizeActivityEvent, type ActivityEvent, type ActivityEventInput } from "../src/activity.js";

const key = { sessionID: "s", instanceID: "epoch", executionID: "e" };
const fact = (input: ActivityEventInput) => normalizeActivityEvent(input)!;
const life = (state: "busy" | "retry" | "idle" | "completed", timestamp: number, seq: number, extra = {}) => fact({ ...key, ...extra, kind: "lifecycle", state, timestamp, seq });
const work = (id: string, phase: "start" | "end", timestamp: number, seq: number, maintenance = false, stepID?: string, source: "step" | "tool" = "step") =>
  fact({ ...key, kind: "work", workID: id, source, stepID, phase, timestamp, seq,
    sourceEventID: `${id}-${phase}`, sourceSequence: timestamp,
    measurementScope: { version: 1, sourceScope: maintenance ? "magic-message" : "user", reasons: [] } });
const live = (now: number) => ({ trustedCurrentInstanceID: "epoch", liveNow: now });

test("freeze replacement preserves the explicit observed prefix when trust moves to a new instance", () => {
  const frozenKey = { sessionID: "root", executionID: "exec", instanceID: "local" };
  const events = [fact({ ...frozenKey, kind: "lifecycle", state: "busy", timestamp: 1000, seq: 0 }),
    ...(["start", "end"] as const).map((phase, i) => fact({ ...frozenKey, kind: "work", source: "tool", workID: "t", phase,
      timestamp: 1200 + i * 100, seq: i + 1, measurementScope: { version: 1, sourceScope: "user", reasons: [] } }))]
    .map((event) => fact({ ...event, observedAt: 9_000_000 }));
  const projector = createActivityProjector(events);
  assert.equal(projector.totals("root", { liveNow: 2000, trustedCurrentInstanceID: "local" }).directMilliseconds, 1000);
  projector.updateStreams([{ key: frozenKey, mode: "replace", events: events.map((event) => fact({ ...event, instanceEndedAt: 1300 })) }]);
  assert.deepEqual(projector.totals("root", { liveNow: 3000, trustedCurrentInstanceID: "new" }),
    { directMilliseconds: 300, includingMilliseconds: 300, active: false });
});

test("late maintenance strengthening accumulates and weak or duplicate evidence cannot undo it", () => {
  const projector = createActivityProjector([life("busy", 0, 0), work("m1", "start", 10, 1), work("m1", "end", 30, 2),
    work("m2", "start", 40, 3), work("m2", "end", 70, 4), life("completed", 100, 5)]);
  const first = work("m1", "end", 30, 6, true);
  projector.ingest([first]);
  assert.equal(projector.totals("s").directMilliseconds, 80);
  projector.ingest([work("m2", "end", 70, 7, true)]);
  assert.equal(projector.totals("s").directMilliseconds, 50);
  projector.ingest([first, work("m1", "end", 30, 8)]);
  assert.equal(projector.totals("s").directMilliseconds, 50);
});

test("live clock rollback preserves proven prefixes without importing other session or epoch clocks", () => {
  const projector = createActivityProjector([
    life("busy", 100000, 0, { instanceID: "old", executionID: "old" }), life("completed", 100100, 1, { instanceID: "old", executionID: "old" }),
    life("busy", 200000, 0, { sessionID: "other", instanceID: "foreign", executionID: "foreign" }),
    life("completed", 200200, 1, { sessionID: "other", instanceID: "foreign", executionID: "foreign" }),
    life("busy", 1000, 2), work("mc", "start", 1250, 3, true), work("mc", "end", 1750, 4, true),
    work("normal", "start", 1450, 5, false, "other", "tool"), work("normal", "end", 1550, 6, false, "other", "tool"), life("retry", 1800, 7),
  ]);
  for (const [now, expected] of [[2000, 700], [1200, 500], [2100, 800], [0, 500]] as const) {
    assert.equal(projector.totals("s", live(now)).directMilliseconds, expected);
    assert.equal(projector.totals("other", live(now)).directMilliseconds, 200);
  }
  assert.equal(projector.totals("s", { ...live(3000), lastObservedAt: { epoch: 1900 } }).directMilliseconds, 600);
});

test("live clocks reject historical cutoff aliases and invalid values", () => {
  const projector = createActivityProjector();
  for (const alias of ["replayCutoff", "cutoff", "until"] as const) {
    assert.throws(() => projector.totals("s", { ...live(1), [alias]: 0 }), TypeError);
  }
  for (const now of [-1, NaN, Infinity]) assert.throws(() => projector.totals("s", live(now)), RangeError);
  assert.doesNotThrow(() => projector.totals("s", live(0)));
});

test("late work proof cannot subtract beyond the lifecycle's explicit observed boundary", () => {
  const projector = createActivityProjector([life("busy", 0, 0), work("bound", "start", 10, 1), work("bound", "end", 80, 2),
    fact({ ...key, kind: "lifecycle", state: "completed", timestamp: 100, seq: 3, lastObservedAt: 50 })]);
  projector.ingest([work("bound", "end", 80, 4, true)]);
  assert.equal(projector.totals("s").directMilliseconds, 10);
});

test("new busy activity invalidates a completed pure-maintenance certificate", () => {
  const projector = createActivityProjector([life("busy", 0, 0), work("a", "start", 10, 1, true), work("a", "end", 30, 2, true), life("idle", 100, 3),
    fact({ ...key, kind: "execution-scope", timestamp: 100, seq: 4, classification: "pure-maintenance", coverage: "complete" })]);
  assert.equal(projector.totals("s").directMilliseconds, 0);
  projector.ingest([life("busy", 200, 5)]);
  assert.equal(projector.totals("s", live(225)).directMilliseconds, 105);
});

test("late owning-step classification repairs earlier tools without bridging an idle gap", () => {
  const projector = createActivityProjector([life("busy", 0, 0), work("mc", "start", 1, 1, true), work("mc", "end", 5, 2, true),
    work("tool", "start", 2, 3, false, "late-owner", "tool"), work("tool", "end", 4, 4, false, "late-owner", "tool"),
    life("idle", 6, 5), life("busy", 10, 6)]);
  assert.equal(projector.totals("s", live(15)).directMilliseconds, 9);
  projector.ingest([work("late-owner", "start", 11, 7, true), work("late-owner", "end", 13, 8, true), life("completed", 15, 9)]);
  assert.deepEqual(projector.totals("s"), { directMilliseconds: 5, includingMilliseconds: 5, active: false });
});

test("4000 late proofs with per-proof queries update local coverage within an NlogN budget", () => {
  const size = 4000, events: ActivityEvent[] = [life("busy", 0, 0)];
  for (let i = 0; i < size; i++) events.push(work(`w${i}`, "start", i * 4 + 1, i * 2 + 1), work(`w${i}`, "end", i * 4 + 3, i * 2 + 2));
  const end = size * 4 + 4;
  events.push(life("completed", end, size * 2 + 1));
  const projector = createActivityProjector(events);
  assert.equal(projector.totals("s").directMilliseconds, end);
  for (let i = 0; i < size; i++) {
    projector.ingest([work(`w${i}`, "end", i * 4 + 3, size * 2 + 2 + i, true)]);
    assert.equal(projector.totals("s").directMilliseconds, end - (i + 1) * 2);
  }
  const counts = activityProjectionDiagnostics(projector);
  assert.ok(counts.coldFactVisits <= size * 2, "late proofs must not replay the closed execution for every work item");
  assert.ok(counts.workFactVisits <= size * 4);
  assert.ok(counts.workSpanVisits <= size * 8);
  assert.ok(counts.intervalMaterializations < size * 100);
  assert.ok(counts.indexNodeVisits < size * 200 * Math.ceil(Math.log2(size + 1)), "coverage-node work must fit the NlogN budget");
});
