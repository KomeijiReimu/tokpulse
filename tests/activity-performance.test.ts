import assert from "node:assert/strict";
import test from "node:test";
import { activityProjectionDiagnostics, createActivityProjector, normalizeActivityEvent, type ActivityEvent } from "../src/activity.js";

function life(state: "busy" | "idle", timestamp: number, seq: number): ActivityEvent {
  return normalizeActivityEvent({ kind: "lifecycle", instanceID: "epoch", sessionID: "s", executionID: "e", state, timestamp, seq })!;
}

test("4000 lifecycle rounds accumulate without replaying closed history on each query", () => {
  const rounds = 4000, projector = createActivityProjector();
  for (let i = 0; i < rounds; i++) {
    projector.ingest([life("busy", i * 10, i * 2)]);
    assert.equal(projector.totals("s", { liveNow: i * 10 + 3, trustedCurrentInstanceID: "epoch" }).directMilliseconds, i * 5 + 3);
    projector.ingest([life("idle", i * 10 + 5, i * 2 + 1)]);
    assert.equal(projector.totals("s").directMilliseconds, (i + 1) * 5);
  }
  const counts = activityProjectionDiagnostics(projector);
  assert.ok(counts.coldFactVisits <= rounds * 2, "replay work must stay linear, not scan every prior round");
  assert.ok(counts.lifecycleTransitions <= rounds * 4, "closed lifecycle transitions must not be repeatedly applied");
});

test("clock-only queries do not rescan 1000 archived work spans", () => {
  const projector = createActivityProjector([life("busy", 0, 0)]);
  for (let i = 0; i < 1000; i++) {
    const base = { kind: "work" as const, sessionID: "s", executionID: "e", instanceID: "epoch", workID: `w-${i}`, source: "step" as const,
      measurementScope: { version: 1 as const, sourceScope: "magic-message" as const, reasons: [] } };
    projector.ingest([normalizeActivityEvent({ ...base, phase: "start", timestamp: i * 2 + 1 })!,
      normalizeActivityEvent({ ...base, phase: "end", timestamp: i * 2 + 2 })!]);
  }
  projector.totals("s", { liveNow: 3000, trustedCurrentInstanceID: "epoch" });
  const before = activityProjectionDiagnostics(projector);
  for (let i = 0; i < 1000; i++) {
    assert.equal(projector.totals("s", { liveNow: 3000 + i, trustedCurrentInstanceID: "epoch" }).directMilliseconds, 2000 + i);
  }
  const after = activityProjectionDiagnostics(projector);
  assert.equal(after.workFactVisits, before.workFactVisits, "clock ticks must not reread archived work facts");
  assert.equal(after.workSpanVisits, before.workSpanVisits, "clock ticks must not walk archived spans");
  assert.ok(after.intervalMaterializations - before.intervalMaterializations <= 8000, "only live tails, not entire historical prefixes, may be materialized");
});
