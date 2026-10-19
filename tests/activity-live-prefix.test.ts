import assert from "node:assert/strict";
import test from "node:test";
import { activityProjectionDiagnostics, calculateActiveMilliseconds, createActivityProjector, normalizeActivityEvent, replayActivity,
  type ActivityEvent, type ActivityEventInput, type ActivityProjector, type ActivityReplayOptions, type ActivityStreamKey } from "../src/activity.js";
import { classifySessionMetadata, type CompactScopeEvidence } from "../src/scope.js";

const key = { sessionID: "root", instanceID: "epoch", executionID: "e" } satisfies ActivityStreamKey;
const fact = (input: ActivityEventInput): ActivityEvent => normalizeActivityEvent(input)!;
const life = (state: "busy" | "retry" | "idle" | "completed", timestamp: number, seq: number, extra: Partial<ActivityStreamKey> = {}) =>
  fact({ ...key, ...extra, kind: "lifecycle", state, timestamp, seq });
function work(workID: string, phase: "start" | "end", timestamp: number, seq: number,
  scope: "user" | "magic-message" | "pending" = "user", stepID?: string, source: "step" | "tool" = "step") {
  return fact({ ...key, kind: "work", source, workID, phase, timestamp, seq, stepID,
    measurementScope: { version: 1, sourceScope: scope, reasons: [] } });
}
function compare(projector: ActivityProjector, facts: readonly ActivityEvent[], time: ActivityReplayOptions,
  parents?: ReadonlyMap<string, string | null | undefined>, scopes?: ReadonlyMap<string, CompactScopeEvidence>) {
  const reference = replayActivity(facts, { ...time, parentBySessionID: parents, sessionScopes: scopes && Object.fromEntries(scopes) });
  for (const id of ["root", "child", "a", "b"]) {
    const reachable = (sid: string) => {
      const seen = new Set<string>();
      let current: string | undefined = sid;
      while (current && !seen.has(current)) {
        if (current === id) return true;
        seen.add(current); current = reference.parentBySessionID.get(current);
      }
      return false;
    };
    // Context is applied only by the API under test, not silently reinstalled
    // through totals(options) before comparison.
    const actual = projector.totals(id, { ...time });
    assert.equal(actual.directMilliseconds, reference.timelines.get(id)?.activeMilliseconds ?? 0, `${id} direct ${JSON.stringify(time)}`);
    assert.equal(actual.includingMilliseconds, calculateActiveMilliseconds(reference.participants.filter((row) => reachable(row.sessionID)).flatMap((row) => row.intervals)), `${id} including ${JSON.stringify(time)}`);
  }
}

test("live-prefix cache inherits late step maintenance into tools but preserves independent tool and child overlap", () => {
  const projector = createActivityProjector(), facts: ActivityEvent[] = [];
  const parents = new Map<string, string | null | undefined>([["child", "root"]]);
  projector.patchContext({ parents });
  const events = [life("busy", 0, 0), life("busy", 3, 0, { sessionID: "child", executionID: "child" }),
    life("completed", 8, 1, { sessionID: "child", executionID: "child" }), work("owned", "start", 1, 1, "user", "step", "tool"),
    work("owned", "end", 9, 2, "user", "step", "tool"), work("step", "start", 2, 3, "pending"),
    work("step", "end", 10, 4, "magic-message"), work("normal", "start", 4, 5, "user", "other", "tool"),
    work("normal", "end", 12, 6, "user", "other", "tool"), life("retry", 13, 7), life("completed", 14, 8)];
  for (const event of events) {
    projector.ingest([event]); facts.push(event);
    for (const time of [{}, { trustedCurrentInstanceID: "epoch" }, { trustedCurrentInstanceID: "epoch", replayCutoff: 20 },
      { replayCutoff: 5 }, { replayCutoff: 30, lastObservedAt: 7 }, { trustedCurrentInstanceID: "epoch", replayCutoff: 25, instanceEndedAt: 15 }]) compare(projector, facts, time, parents);
  }
  const before = activityProjectionDiagnostics(projector);
  for (let now = 30; now < 60; now++) compare(projector, facts, { trustedCurrentInstanceID: "epoch", replayCutoff: now }, parents);
  assert.equal(activityProjectionDiagnostics(projector).workFactVisits, before.workFactVisits);
});

test("unclosed work never creates maintenance or an untrusted clock tail and terminal prefix is reversible", () => {
  const projector = createActivityProjector(), facts: ActivityEvent[] = [];
  const events = [life("busy", 0, 0), work("mc", "start", 1, 1, "magic-message"), life("retry", 4, 2),
    work("normal", "end", 6, 3), work("mc", "end", 9, 4, "magic-message"), work("normal", "start", 5, 5),
    life("completed", 12, 6), fact({ ...key, kind: "execution-scope", timestamp: 12, seq: 7, classification: "pure-maintenance", coverage: "complete" })];
  for (const event of events) {
    projector.ingest([event]); facts.push(event);
    for (const time of [{}, { trustedCurrentInstanceID: "epoch" }, { replayCutoff: 3 }, { trustedCurrentInstanceID: "epoch", replayCutoff: 30 }]) compare(projector, facts, time);
  }
});

test("pure proof retracts a materialized active prefix after terminal; duplicate and late boundary repair converge", () => {
  const events = [life("busy", 0, 1), work("mc", "end", 9.75, 3, "magic-message"),
    fact({ ...key, kind: "execution-scope", timestamp: 15.5, seq: 5, sourceSequence: 5, classification: "pure-maintenance", coverage: "complete" }),
    fact({ ...work("mc", "start", .25, 2, "magic-message"), sourceSequence: 2 }), life("completed", 15.5, 4)];
  const projector = createActivityProjector(), facts: ActivityEvent[] = [];
  for (const event of events) {
    projector.ingest([event]); facts.push(event);
    compare(projector, facts, { trustedCurrentInstanceID: "epoch", replayCutoff: 30 });
    compare(projector, facts, {});
    projector.ingest([event]);
    compare(projector, facts, { trustedCurrentInstanceID: "epoch", replayCutoff: 40 });
  }
  assert.equal(projector.totals("root").directMilliseconds, 0);
});

test("warm live prefix survives scope parent patches, hiding, cold replacement and explicit retirement recovery", () => {
  const root = [life("busy", 0, 0), work("mc", "start", 2, 1, "magic-message"), work("mc", "end", 8, 2, "magic-message")];
  const child = [life("busy", 3, 0, { sessionID: "child", executionID: "child" }), life("completed", 10, 1, { sessionID: "child", executionID: "child" })];
  const projector = createActivityProjector([...root, ...child]);
  const parents = new Map<string, string | null | undefined>([["child", "root"]]), scopes = new Map<string, CompactScopeEvidence>();
  projector.patchContext({ parents });
  const time = { trustedCurrentInstanceID: "epoch", replayCutoff: 20 };
  compare(projector, [...root, ...child], time, parents, scopes);
  const before = activityProjectionDiagnostics(projector);
  for (const parent of ["a", null, "b", undefined]) {
    projector.patchContext({ parents: new Map([["root", parent]]) });
    if (parent === undefined) parents.delete("root"); else parents.set("root", parent);
    compare(projector, [...root, ...child], time, parents, scopes);
  }
  const hidden = classifySessionMetadata({ agent: "historian" })!;
  for (const scope of [hidden, undefined]) {
    projector.patchContext({ sessionScopes: new Map([["root", scope]]) });
    if (scope === undefined) scopes.delete("root"); else scopes.set("root", scope);
    compare(projector, [...root, ...child], time, parents, scopes);
  }
  projector.updateStreams([{ key, mode: "hidden" }]); compare(projector, child, time, parents, scopes);
  projector.updateStreams([{ key, mode: "visible" }]); compare(projector, [...root, ...child], time, parents, scopes);
  const after = activityProjectionDiagnostics(projector);
  assert.equal(after.workFactVisits, before.workFactVisits);
  assert.equal(after.factVisits, before.factVisits);
  const replacement = [...root, life("completed", 12, 3)];
  projector.updateStreams([{ key, mode: "replace", events: replacement }]); compare(projector, [...replacement, ...child], time, parents, scopes);
  projector.updateStreams([{ key, mode: "replace", events: [] }]); compare(projector, child, time, parents, scopes);
  projector.ingest(root); compare(projector, child, time, parents, scopes);
  projector.updateStreams([{ key, mode: "replace", events: root }]); compare(projector, child, time, parents, scopes);
  projector.updateStreams([{ key, mode: "visible" }]); compare(projector, [...root, ...child], time, parents, scopes);
});

test("ordered live work cache matches independent replay under 48 fixed seeds and changing clock objects", () => {
  for (let seed = 1; seed <= 48; seed++) {
    let random = seed, seq = 0;
    const next = () => random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const projector = createActivityProjector(), facts: ActivityEvent[] = [];
    const append = (event: ActivityEvent) => { projector.ingest([event]); facts.push(event); };
    append(life("busy", 0, seq++));
    try {
      for (let step = 0; step < 24; step++) {
        const start = step * 3 + .25, end = start + 2, id = `step-${step}`;
        const maintenance = next() % 2 === 0;
        const owning = `step-${Math.max(0, step - 1)}`;
        append(work(id, "start", start, seq++, maintenance ? "magic-message" : "user"));
        compare(projector, facts, { trustedCurrentInstanceID: "epoch", replayCutoff: end + 5 });
        append(work(`tool-${step}`, "start", start + .5, seq++, "user", owning, "tool"));
        append(work(id, "end", end, seq++, maintenance ? "magic-message" : "user"));
        if (next() % 3) append(work(`tool-${step}`, "end", end + .5, seq++, "user", owning, "tool"));
        if (step % 4 === 0) append(life("retry", end + 1, seq++));
        for (const time of [{}, { trustedCurrentInstanceID: "epoch" }, { trustedCurrentInstanceID: "epoch", replayCutoff: end + 5 }, { trustedCurrentInstanceID: "epoch", replayCutoff: end + 11 }, { replayCutoff: step + 1 }]) compare(projector, facts, time);
      }
      append(life("completed", 80, seq++));
      compare(projector, facts, {});
    } catch (error) {
      throw new Error(`live-prefix seed=${seed}; facts=${JSON.stringify(facts)}`, { cause: error });
    }
  }
});

test("a newly classified step repairs inherited tools in an earlier closed busy segment without bridging the idle gap", () => {
  const projector = createActivityProjector(), facts: ActivityEvent[] = [];
  const events = [life("busy", 0, 0), work("mc", "start", 1, 1, "magic-message"), work("mc", "end", 5, 2, "magic-message"),
    work("tool", "start", 2, 3, "user", "late-owner", "tool"), work("tool", "end", 4, 4, "user", "late-owner", "tool"),
    life("idle", 6, 5), life("busy", 10, 6), work("late-owner", "start", 11, 7, "magic-message"),
    work("late-owner", "end", 13, 8, "magic-message"), life("completed", 15, 9)];
  for (const event of events) {
    projector.ingest([event]); facts.push(event);
    for (const time of [{}, { trustedCurrentInstanceID: "epoch", replayCutoff: 30 }, { replayCutoff: 3 }, { replayCutoff: 8 }]) compare(projector, facts, time);
  }
});
