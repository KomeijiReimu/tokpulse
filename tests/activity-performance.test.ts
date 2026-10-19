import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { activityProjectionDiagnostics, activityReplayDiagnostics, createActivityProjector, normalizeActivityEvent, replayActivity, type ActivityEvent } from "../src/activity.js";

function life(state: "busy" | "idle", timestamp: number, seq: number, sessionID = "s", executionID = "e"): ActivityEvent {
  return normalizeActivityEvent({ kind: "lifecycle", instanceID: "epoch", sessionID, executionID, state, timestamp, seq, eventID: `${sessionID}:${seq}` })!;
}

test("projector 1k/2k/4k lifecycle rounds increment closed prefixes, not history replays", () => {
  const results: Array<{ rounds: number; milliseconds: number; coldFactVisits: number; transitions: number }> = [];
  for (const rounds of [1000, 2000, 4000]) {
    const projector = createActivityProjector();
    const start = performance.now();
    for (let i = 0; i < rounds; i++) {
      projector.ingest([life("busy", i * 10, i * 2)]);
      assert.equal(projector.totals("s", { replayCutoff: i * 10 + 3, trustedCurrentInstanceID: "epoch" }).directMilliseconds, i * 5 + 3);
      projector.ingest([life("idle", i * 10 + 5, i * 2 + 1)]);
      assert.equal(projector.totals("s").directMilliseconds, (i + 1) * 5);
    }
    const diagnostics = activityProjectionDiagnostics(projector);
    assert.equal(diagnostics.coldFactVisits, 0);
    assert.equal(diagnostics.lifecycleTransitions, rounds * 2);
    const before = activityProjectionDiagnostics(projector);
    for (let i = 0; i < 1000; i++) projector.totals("s", { replayCutoff: rounds * 10 + i, trustedCurrentInstanceID: "epoch" });
    const after = activityProjectionDiagnostics(projector);
    assert.equal(after.coldFactVisits, before.coldFactVisits);
    assert.equal(after.lifecycleTransitions, before.lifecycleTransitions);
    assert.equal(after.snapshotBuilds, before.snapshotBuilds); // trusted/default views both remain warm
    assert.equal(after.clockStreamVisits, before.clockStreamVisits);
    results.push({ rounds, milliseconds: +(performance.now() - start).toFixed(2), coldFactVisits: diagnostics.coldFactVisits, transitions: diagnostics.lifecycleTransitions });
  }
  console.log("activity lifecycle benchmark", JSON.stringify(results));
});

test("separate execution and work facts retire active state without rescanning closed executions", () => {
  const projector = createActivityProjector();
  for (let i = 0; i < 1000; i++) {
    const executionID = `e-${i}`, start = i * 10;
    projector.ingest([life("busy", start, i * 4, "s", executionID)]);
    for (const [phase, timestamp, seq] of [["start", start + 1, i * 4 + 1], ["end", start + 4, i * 4 + 2]] as const) {
      projector.ingest([normalizeActivityEvent({ kind: "work", sessionID: "s", executionID, instanceID: "epoch", timestamp, seq,
        workID: "step", source: "step", phase, measurementScope: { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] } })!]);
    }
    projector.ingest([life("idle", start + 5, i * 4 + 3, "s", executionID)]);
    assert.equal(projector.totals("s").directMilliseconds, (i + 1) * 2);
  }
  const before = activityProjectionDiagnostics(projector);
  assert.equal(before.coldFactVisits, 0);
  for (let i = 0; i < 1000; i++) projector.totals("s", { replayCutoff: 20000 + i, trustedCurrentInstanceID: "epoch" });
  assert.equal(activityProjectionDiagnostics(projector).clockStreamVisits, before.clockStreamVisits);
});

test("clock-only work projection visits active streams, not thousands of archived work facts", () => {
  const projector = createActivityProjector([life("busy", 0, 0)]);
  for (let i = 0; i < 1000; i++) {
    projector.ingest([normalizeActivityEvent({ kind: "work", sessionID: "s", executionID: "e", instanceID: "epoch", timestamp: i * 2 + 1,
      workID: `w-${i}`, source: "step", phase: "start", measurementScope: { version: 1, sourceScope: "magic-message", reasons: [] } })!,
    normalizeActivityEvent({ kind: "work", sessionID: "s", executionID: "e", instanceID: "epoch", timestamp: i * 2 + 2,
      workID: `w-${i}`, source: "step", phase: "end", measurementScope: { version: 1, sourceScope: "magic-message", reasons: [] } })!]);
  }
  projector.totals("s", { replayCutoff: 3000, trustedCurrentInstanceID: "epoch" });
  const before = activityProjectionDiagnostics(projector);
  for (let i = 0; i < 1000; i++) assert.equal(projector.totals("s", { replayCutoff: 3000 + i, trustedCurrentInstanceID: "epoch" }).directMilliseconds, 2000 + i);
  const after = activityProjectionDiagnostics(projector);
  assert.equal(after.coldFactVisits, before.coldFactVisits);
  assert.equal(after.snapshotBuilds, before.snapshotBuilds);
  assert.equal(after.clockStreamVisits - before.clockStreamVisits, 2000); // direct + including, one active each
  assert.equal(after.workFactVisits, before.workFactVisits);
  assert.equal(after.workSpanVisits, before.workSpanVisits);
  assert.equal(after.factMaterializations, before.factMaterializations);
  assert.equal(after.intervalSortComparisons, before.intervalSortComparisons);
  assert.ok(after.intervalMaterializations - before.intervalMaterializations <= 8000, "clock-only materializes tails, never the complete cached prefix");
});

test("replay groups 10k/20k/40k independent sessions with one membership assignment each", () => {
  const results: Array<{ sessions: number; milliseconds: number; assignments: number; parentVisits: number }> = [];
  for (const sessions of [10000, 20000, 40000]) {
    const events: ActivityEvent[] = [];
    for (let i = 0; i < sessions; i++) events.push(life("busy", 0, 1, `s-${i}`), life("idle", 10, 2, `s-${i}`));
    const start = performance.now();
    const replay = replayActivity(events);
    const milliseconds = performance.now() - start;
    const counts = activityReplayDiagnostics(replay);
    assert.equal(replay.roots.length, sessions);
    assert.equal(counts.sessionAssignments, sessions);
    assert.equal(counts.parentVisits, sessions);
    results.push({ sessions, milliseconds: +milliseconds.toFixed(2), assignments: counts.sessionAssignments, parentVisits: counts.parentVisits });
  }
  console.log("activity replay benchmark", JSON.stringify(results));
});

test("deep parent chains use compressed roots; late proof rebuilds only the affected execution", () => {
  const events: ActivityEvent[] = [];
  for (let i = 0; i < 1000; i++) events.push(life("busy", 0, 1, `s-${i}`), life("idle", 10, 2, `s-${i}`), normalizeActivityEvent({ kind: "parent", sessionID: `s-${i}`, parentSessionID: i ? `s-${i - 1}` : undefined, timestamp: 20 })!);
  const result = replayActivity(events);
  assert.equal(result.roots.length, 1);
  assert.ok(activityReplayDiagnostics(result).parentVisits <= 1000);
  const projector = createActivityProjector(events.filter((event) => event.kind !== "parent"));
  const before = activityProjectionDiagnostics(projector);
  projector.ingest([normalizeActivityEvent({ kind: "work", sessionID: "s-500", executionID: "e", instanceID: "epoch", workID: "late", source: "step", phase: "start", timestamp: 2, measurementScope: { version: 1, sourceScope: "magic-message", reasons: [] } })!,
    normalizeActivityEvent({ kind: "work", sessionID: "s-500", executionID: "e", instanceID: "epoch", workID: "late", source: "step", phase: "end", timestamp: 8, measurementScope: { version: 1, sourceScope: "magic-message", reasons: [] } })!]);
  assert.equal(projector.totals("s-500").directMilliseconds, 4);
  assert.ok(activityProjectionDiagnostics(projector).coldFactVisits - before.coldFactVisits <= 7);
  assert.equal(projector.totals("s-499").directMilliseconds, 10);
});

test("complete pure-MC proof on every normal execution does not rebuild historical session indexes", () => {
  const results: Array<Record<string, number>> = [];
  for (const rounds of [1000, 2000, 4000]) {
    const projector = createActivityProjector();
    const start = performance.now();
    for (let i = 0; i < rounds; i++) {
      const executionID = `pure-${i}`, at = i * 10;
      const base = { sessionID: "s", instanceID: "epoch", executionID };
      const work = { ...base, kind: "work", workID: "mc", source: "step", measurementScope: { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] } };
      // Edges outside the explicit maintenance span are retracted only by the
      // complete proof, exercising real removal from already-cached indexes.
      const events = [life("busy", at, i * 5, "s", executionID),
        normalizeActivityEvent({ ...work, phase: "start", timestamp: at + 1, seq: i * 5 + 1 })!,
        normalizeActivityEvent({ ...work, phase: "end", timestamp: at + 4, seq: i * 5 + 2 })!,
        life("idle", at + 5, i * 5 + 3, "s", executionID)];
      projector.ingest(events);
      assert.equal(projector.totals("s").directMilliseconds, 2);
      projector.ingest([normalizeActivityEvent({ ...base, kind: "execution-scope", timestamp: at + 5, seq: i * 5 + 4,
        classification: "pure-maintenance", coverage: "complete" })!]);
      assert.deepEqual(projector.totals("s"), { directMilliseconds: 0, includingMilliseconds: 0, active: false });
    }
    const counts = activityProjectionDiagnostics(projector);
    results.push({ rounds, milliseconds: +(performance.now() - start).toFixed(2), indexStreamVisits: counts.indexStreamVisits,
      indexBuilds: counts.indexBuilds, indexNodeVisits: counts.indexNodeVisits, coldFactVisits: counts.coldFactVisits });
    for (let i = 0; i < 1000; i++) projector.totals("s", { replayCutoff: rounds * 10 + i });
    const afterClock = activityProjectionDiagnostics(projector);
    assert.equal(afterClock.indexStreamVisits, counts.indexStreamVisits);
    assert.equal(afterClock.indexBuilds, counts.indexBuilds);
    assert.equal(afterClock.coldFactVisits, counts.coldFactVisits);
    assert.ok(afterClock.indexNodeVisits - counts.indexNodeVisits <= 4000);
  }
  console.log("activity complete proof benchmark", JSON.stringify(results));
  for (const result of results) {
    assert.equal(result.indexStreamVisits, 0, `history stream scans: ${JSON.stringify(result)}`);
    assert.equal(result.indexBuilds, 2, `index rebuilds: ${JSON.stringify(result)}`);
    assert.ok(result.indexNodeVisits < result.rounds * 2500, `coverage operations: ${JSON.stringify(result)}`);
  }
  for (let i = 1; i < results.length; i++) assert.ok(results[i].indexNodeVisits < results[i - 1].indexNodeVisits * 3,
    `doubling executions must not quadruple actual index work: ${JSON.stringify(results)}`);
});
