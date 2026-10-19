import assert from "node:assert/strict";
import test from "node:test";
import { activityProjectionDiagnostics, calculateActiveMilliseconds, createActivityProjector, normalizeActivityEvent, replayActivity,
  type ActivityEvent, type ActivityEventInput, type ActivityReplayOptions } from "../src/activity.js";

const key = { sessionID: "s", instanceID: "epoch", executionID: "e" };
const fact = (input: ActivityEventInput) => normalizeActivityEvent(input)!;
const life = (state: "busy" | "retry" | "idle" | "completed", timestamp: number, seq: number, extra = {}) => fact({ ...key, ...extra, kind: "lifecycle", state, timestamp, seq });
const work = (id: string, phase: "start" | "end", timestamp: number, seq: number, maintenance = false, stepID?: string, source: "step" | "tool" = "step") =>
  fact({ ...key, kind: "work", workID: id, source, stepID, phase, timestamp, seq,
    sourceEventID: `${id}-${phase}`, sourceSequence: timestamp,
    measurementScope: { version: 1, sourceScope: maintenance ? "magic-message" : "user", reasons: [] } });
const live = (now: number) => ({ trustedCurrentInstanceID: "epoch", liveNow: now });

test("nonempty freeze replacement preserves its explicit observed prefix after trusted instance changes", () => {
  const frozenKey = { sessionID: "root", executionID: "exec", instanceID: "local" };
  for (const receivedNow of [false, true]) {
    const events = [
      fact({ ...frozenKey, kind: "lifecycle", state: "busy", timestamp: 1000, seq: 0, eventID: "e0" }),
      ...(["start", "end"] as const).map((phase, i) => fact({ ...frozenKey, kind: "work", source: "tool", workID: "t", phase,
        timestamp: 1200 + i * 100, seq: i + 1, eventID: `e${i + 1}`, measurementScope: { version: 1, sourceScope: "user", reasons: [] } })),
    ].map((event) => fact({ ...event, observedAt: receivedNow ? Date.now() : event.timestamp }));
    const p = createActivityProjector(events);
    assert.equal(p.totals("root", { liveNow: 2000, trustedCurrentInstanceID: "local" }).directMilliseconds, 1000);
    const frozen = events.map((event) => fact({ ...event, instanceEndedAt: 1300 }));
    p.updateStreams([{ key: frozenKey, mode: "replace", events: frozen }]);
    const options = { liveNow: 3000, trustedCurrentInstanceID: "new" };
    assert.equal(replayActivity(frozen, options).timelines.get("root")!.activeMilliseconds, 300);
    assert.deepEqual(p.totals("root", options), { directMilliseconds: 300, includingMilliseconds: 300, active: false });
  }
});

test("closed work strengthening is local, cumulative, idempotent and cannot remove normal tool or child overlap", () => {
  const events = [life("busy", 0, 0), work("m1", "start", 10, 1), work("m1", "end", 30, 2), work("m2", "start", 40, 3),
    work("m2", "end", 70, 4), work("normal", "start", 80, 5), work("normal", "end", 90, 6), life("completed", 100, 7)];
  const p = createActivityProjector(events), before = activityProjectionDiagnostics(p);
  for (const proof of [work("m1", "end", 30, 8, true), work("m2", "end", 70, 9, true), work("m1", "end", 30, 10, true), work("m1", "end", 30, 11)]) {
    events.push(proof); p.ingest([proof]);
    assert.equal(p.totals("s").directMilliseconds, replayActivity(events).timelines.get("s")!.activeMilliseconds);
  }
  assert.equal(p.totals("s").directMilliseconds, 50);
  assert.equal(activityProjectionDiagnostics(p).coldFactVisits, before.coldFactVisits, "known-boundary scope strengthening must not replay the execution");
});

test("liveNow keeps future closed epochs without stretching the trusted tail or filtering history", () => {
  const events = [life("busy", 100000, 0, { instanceID: "old", executionID: "old" }), life("completed", 100100, 1, { instanceID: "old", executionID: "old" }),
    life("busy", 1000, 2)];
  const p = createActivityProjector(events);
  assert.equal(p.totals("s", live(2000)).directMilliseconds, 1100);
  assert.equal(replayActivity(events, live(2000)).timelines.get("s")!.activeMilliseconds, 1100);
  const before = activityProjectionDiagnostics(p);
  for (let now = 2001; now < 2101; now++) assert.equal(p.totals("s", live(now)).directMilliseconds, 100 + now - 1000);
  const after = activityProjectionDiagnostics(p);
  assert.equal(after.coldFactVisits, before.coldFactVisits);
  assert.equal(after.factVisits, before.factVisits);
  assert.equal(after.indexStreamVisits, before.indexStreamVisits);
  const behind = [life("busy", 0, 0, { instanceID: "old", executionID: "old" }), life("completed", 100, 1, { instanceID: "old", executionID: "old" }), events[2]];
  assert.equal(createActivityProjector(behind).totals("s", live(2000)).directMilliseconds, 1100);
  assert.equal(replayActivity(behind, live(2000)).timelines.get("s")!.activeMilliseconds, 1100);
  assert.equal(createActivityProjector([events[2]]).totals("s", live(2000)).directMilliseconds, 1000);
  assert.equal(p.totals("s", { trustedCurrentInstanceID: "epoch" }).directMilliseconds, 100);
  assert.equal(p.totals("s", { liveNow: 2000, trustedCurrentInstanceID: "old" }).directMilliseconds, 100);
});

test("liveNow rejects historical aliases and invalid clocks in both public paths", () => {
  const p = createActivityProjector();
  for (const alias of ["replayCutoff", "cutoff", "until"] as const) {
    const options = { ...live(1), [alias]: 0 };
    assert.throws(() => p.totals("s", options), TypeError);
    assert.throws(() => replayActivity([], options), TypeError);
  }
  for (const now of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => p.totals("s", live(now)), RangeError);
    assert.throws(() => replayActivity([], live(now)), RangeError);
  }
  assert.doesNotThrow(() => p.totals("s", { ...live(0), until: undefined }));
  assert.doesNotThrow(() => replayActivity([], { ...live(0), until: undefined }));
});

function check(p: ReturnType<typeof createActivityProjector>, events: readonly ActivityEvent[], options: ActivityReplayOptions = {}, ids = ["s", "child"]) {
  const reference = replayActivity(events, options);
  for (const id of ids) {
    const actual = p.totals(id, { ...options });
    assert.equal(actual.directMilliseconds, reference.timelines.get(id)?.activeMilliseconds ?? 0, `${id} direct ${JSON.stringify(options)}`);
    const belongs = (sid: string) => { const seen = new Set<string>(); while (sid && !seen.has(sid)) { if (sid === id) return true; seen.add(sid); sid = reference.parentBySessionID.get(sid) ?? ""; } return false; };
    assert.equal(actual.includingMilliseconds, calculateActiveMilliseconds(reference.participants.filter((row) => belongs(row.sessionID)).flatMap((row) => row.intervals)), `${id} including`);
  }
}

test("closed step deltas inherit only related tools, obey observed busy bounds and coexist with live prefix", () => {
  const events = [life("busy", 0, 0), work("step", "start", 10, 1), work("step", "end", 80, 2),
    work("owned", "start", 20, 3, false, "step", "tool"), work("owned", "end", 40, 4, false, "step", "tool"),
    work("normal", "start", 30, 5, false, "other", "tool"), work("normal", "end", 50, 6, false, "other", "tool"),
    life("idle", 100, 7), life("busy", 120, 8), life("retry", 130, 9),
    life("busy", 25, 0, { sessionID: "child", executionID: "child", parentSessionID: "s" }), life("completed", 60, 1, { sessionID: "child", executionID: "child" })];
  const p = createActivityProjector(events);
  check(p, events, live(150));
  const before = activityProjectionDiagnostics(p);
  for (const proof of [work("step", "end", 80, 10, true), work("owned", "start", 20, 11, false, "step", "tool"), work("step", "start", 10, 12, true)]) {
    events.push(proof); p.ingest([proof]);
    check(p, events, live(150)); check(p, events);
  }
  assert.equal(activityProjectionDiagnostics(p).coldFactVisits, before.coldFactVisits);
  check(p, events, { replayCutoff: 35 });
  p.updateStreams([{ key, mode: "hidden" }]); check(p, events.filter((event) => event.sessionID === "child"), live(150));
  p.updateStreams([{ key, mode: "visible" }]); check(p, events, live(150));
  p.patchContext({ parents: new Map([["child", null]]) });
  check(p, events, { ...live(150), parentBySessionID: new Map([["child", null]]) });
  p.updateStreams([{ key, mode: "replace", events: [] }]);
  assert.equal(p.totals("s", live(150)).directMilliseconds, 0);
  p.ingest(events.filter((event) => event.sessionID === "s"));
  assert.equal(p.totals("s", live(150)).directMilliseconds, 0);

  const bounded = [life("busy", 0, 0), work("bound", "start", 10, 1), work("bound", "end", 80, 2),
    fact({ ...key, kind: "lifecycle", state: "completed", timestamp: 100, seq: 3, lastObservedAt: 50 })];
  const boundedProjector = createActivityProjector(bounded), cold = activityProjectionDiagnostics(boundedProjector).coldFactVisits;
  const proof = work("bound", "end", 80, 4, true); bounded.push(proof); boundedProjector.ingest([proof]);
  check(boundedProjector, bounded);
  assert.equal(boundedProjector.totals("s").directMilliseconds, 10);
  assert.equal(activityProjectionDiagnostics(boundedProjector).coldFactVisits, cold);
});

test("complete pure certificate changes remain explicit cold repairs, not scope-strengthening sweeps", () => {
  const events = [life("busy", 0, 0), work("a", "start", 10, 1), work("a", "end", 30, 2), work("b", "start", 40, 3), work("b", "end", 70, 4), life("completed", 100, 5),
    fact({ ...key, kind: "execution-scope", timestamp: 100, seq: 6, classification: "pure-maintenance", coverage: "complete" })];
  const p = createActivityProjector(events), before = activityProjectionDiagnostics(p).coldFactVisits;
  const first = work("a", "end", 30, 7, true); events.push(first); p.ingest([first]); check(p, events);
  assert.equal(activityProjectionDiagnostics(p).coldFactVisits, before);
  const last = work("b", "end", 70, 8, true); events.push(last); p.ingest([last]); check(p, events);
  assert.equal(p.totals("s").directMilliseconds, 0);
  assert.ok(activityProjectionDiagnostics(p).coldFactVisits > before);

  const reopening = [life("busy", 0, 0), work("a", "start", 10, 1, true), work("a", "end", 30, 2, true), life("idle", 100, 3),
    fact({ ...key, kind: "execution-scope", timestamp: 100, seq: 4, classification: "pure-maintenance", coverage: "complete" })];
  const reopened = createActivityProjector(reopening);
  assert.equal(reopened.totals("s").directMilliseconds, 0);
  const busy = life("busy", 200, 5); reopening.push(busy); reopened.ingest([busy]);
  check(reopened, reopening, live(225));
  assert.equal(reopened.totals("s", live(225)).directMilliseconds, 105);
});

test("seeded closed refinements preserve inherited tools, overlapping children, weak replay and semantic duplicates", () => {
  for (let seed = 1; seed <= 24; seed++) {
    let random = seed;
    const next = () => random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const events: ActivityEvent[] = [life("busy", 0, 0)], proofs: ActivityEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const start = i * 8 + 1, end = start + 5, id = `step-${i}`;
      events.push(work(id, "start", start, i * 4 + 1), work(id, "end", end, i * 4 + 2),
        work("shared-call", "start", start + 1, i * 4 + 3, false, id, "tool"), work("shared-call", "end", end + 1, i * 4 + 4, false, id, "tool"));
      // Each proof uses an existing, genuine boundary, not a guessed phase.
      const phase = next() % 2 ? "start" : "end";
      proofs.push(work(id, phase, phase === "start" ? start : end, 100 + i, true));
    }
    events.push(life("completed", 100, 50), life("busy", 35, 0, { sessionID: "child", executionID: "child", parentSessionID: "s" }),
      life("completed", 80, 1, { sessionID: "child", executionID: "child" }));
    const p = createActivityProjector(events);
    try {
      for (let remaining = proofs.length; remaining; remaining--) {
        const index = next() % remaining, proof = proofs[index];
        [proofs[index], proofs[remaining - 1]] = [proofs[remaining - 1], proofs[index]];
        const hidden = remaining % 3 === 0;
        if (hidden) p.updateStreams([{ key, mode: "hidden" }]);
        const before = activityProjectionDiagnostics(p);
        p.ingest([proof]); events.push(proof);
        if (hidden) {
          check(p, events.filter((event) => event.sessionID === "child"), live(150));
          p.updateStreams([{ key, mode: "visible" }]);
        }
        check(p, events, live(150));
        assert.equal(activityProjectionDiagnostics(p).coldFactVisits, before.coldFactVisits);
        p.ingest([proof]); check(p, events);
        const weak = fact({ ...proof, measurementScope: { version: 1, sourceScope: "user", reasons: [] }, seq: 200 + remaining } as ActivityEventInput);
        p.ingest([weak]); events.push(weak); check(p, events, live(150));
      }
    } catch (error) { throw new Error(`closed refinement seed=${seed}; facts=${JSON.stringify(events)}`, { cause: error }); }
  }
});

test("liveNow rollback preserves only proven active prefixes and never imports other SID or epoch clocks", () => {
  const events = [life("busy", 100000, 0, { instanceID: "old", executionID: "old" }), life("completed", 100100, 1, { instanceID: "old", executionID: "old" }),
    life("busy", 200000, 0, { sessionID: "other", instanceID: "foreign", executionID: "foreign" }), life("completed", 200200, 1, { sessionID: "other", instanceID: "foreign", executionID: "foreign" }),
    life("busy", 1000, 2), work("mc", "start", 1250, 3, true), work("mc", "end", 1750, 4, true),
    work("normal", "start", 1450, 5, false, "other", "tool"), work("normal", "end", 1550, 6, false, "other", "tool"), life("retry", 1800, 7)];
  const p = createActivityProjector(events);
  for (const now of [2000, 1200, 2100, 0, 2500, 1500]) check(p, events, live(now), ["s", "other"]);
  assert.equal(p.totals("s", live(1200)).directMilliseconds, 500); // old100 + proven800 - MC500 + normal100
  check(p, events, { ...live(3000), lastObservedAt: { epoch: 1900 } }, ["s", "other"]);
  const next = life("busy", 1900, 8, { executionID: "next" }); events.push(next); p.ingest([next]);
  check(p, events, live(2000), ["s", "other"]);
  for (const alias of ["replayCutoff", "cutoff", "until"] as const) check(p, events, { trustedCurrentInstanceID: "epoch", [alias]: 1600 });

  const rollback = [life("busy", 100000, 1), life("idle", 100100, 2), life("busy", 1000, 3)]
    .map((event, i) => fact({ ...event, sourceSequence: i + 1 } as ActivityEventInput));
  const rolled = createActivityProjector(rollback);
  check(rolled, rollback, live(2000));
  assert.equal(rolled.totals("s", live(2000)).directMilliseconds, 1100);
});

for (const size of [100, 200, 400, 1000, 2000, 4000]) test(`closed same-execution late proofs stay local at ${size} works, with per-proof queries`, () => {
  const events: ActivityEvent[] = [life("busy", 0, 0)];
  for (let i = 0; i < size; i++) events.push(work(`w${i}`, "start", i * 4 + 1, i * 2 + 1), work(`w${i}`, "end", i * 4 + 3, i * 2 + 2));
  const end = size * 4 + 4; events.push(life("completed", end, size * 2 + 1));
  let candidateMS = performance.now();
  const p = createActivityProjector(events); assert.equal(p.totals("s").directMilliseconds, end);
  candidateMS = performance.now() - candidateMS;
  let referenceMS = 0, referenceQueries = 0;
  const before = activityProjectionDiagnostics(p);
  for (let i = 0; i < size - 1; i++) {
    const proof = work(`w${i}`, "end", i * 4 + 3, size * 2 + 2 + i, true); events.push(proof);
    const start = performance.now(); p.ingest([proof]); const result = p.totals("s"); candidateMS += performance.now() - start;
    assert.equal(result.directMilliseconds, end - (i + 1) * 2);
    assert.equal(result.includingMilliseconds, result.directMilliseconds);
    if (size <= 400 || i === 0 || i === Math.floor(size / 2) || i === size - 2) {
      const referenceStart = performance.now(); const reference = replayActivity(events); referenceMS += performance.now() - referenceStart; referenceQueries++;
      assert.equal(result.directMilliseconds, reference.timelines.get("s")!.activeMilliseconds);
    }
  }
  const counts = activityProjectionDiagnostics(p);
  assert.equal(counts.coldFactVisits, 0);
  assert.equal(counts.workFactVisits, size * 3 - 1);
  assert.ok(counts.workSpanVisits <= size * 8);
  assert.ok(counts.factVisits <= size * 4 + 10);
  assert.equal(counts.factSortComparisons, 0);
  assert.equal(counts.indexStreamVisits, 0);
  assert.ok(counts.intervalMaterializations < size * 100);
  assert.ok(counts.intervalSortComparisons < size * 10);
  assert.ok(counts.indexNodeVisits < size * 200 * Math.ceil(Math.log2(size + 1)), "real coverage-node work must fit the NlogN budget");
  console.log("closed work refinement benchmark", JSON.stringify({ size, proofs: size - 1, candidateMS, referenceMS, referenceQueries,
    proofColdFacts: counts.coldFactVisits - before.coldFactVisits, ...counts }));
});
