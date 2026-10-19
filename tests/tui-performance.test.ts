import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createRuntimeStore, reloadActivity, taskWallTimeForSession, tuiActivityDiagnostics, hasLiveTaskWallActivity } from "../src/tui.js";

// Fresh readers use actual safe fd I/O and the public TUI hydration path, not
// a clock-only projector benchmark. Temporary fixtures never use /tmp.
for (const sessions of [10000, 20000, 40000]) test(`fresh TUI ${sessions} independent sessions replay stays linear and idle remains frozen`, async () => {
  const cache = process.env.TMPDIR || join(process.env.HOME!, ".cache", "tokpulse-test-tmp");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "tui-replay-"));
  const path = join(directory, "runs.jsonl");
  const store = createRuntimeStore(1);
  const api = { ui: { toast: () => {} } } as unknown as TuiPluginApi;
  try {
    const rows: string[] = [];
    for (let i = 0; i < sessions; i++) for (const [state, timestamp, seq] of [["busy", 1000, i * 2 + 1], ["idle", 1250, i * 2 + 2]]) {
      rows.push(JSON.stringify({ version: 2, kind: "lifecycle", sessionID: `sid-${i}`, state, timestamp, observedAt: timestamp,
        instanceID: "collector", eventID: `fact-${seq}`, seq, executionID: `exec-${i}` }));
    }
    const bytes = rows.join("\n") + "\n";
    await writeFile(path, bytes);
    await writeFile(join(directory, "runs.jsonl.orphan.tmp"), "uncommitted orphan: reader must not recover or delete");
    const before = await readdir(directory);
    const started = performance.now();
    await reloadActivity(store, api, path);
    assert.equal(taskWallTimeForSession(store, "sid-0", 2000), 250);
    assert.equal(taskWallTimeForSession(store, `sid-${sessions - 1}`, 3600000), 250);
    const elapsed = performance.now() - started;
    const diagnostics = tuiActivityDiagnostics(store);
    const structural = diagnostics.readModel;
    assert.equal(store.activityEvents.length, sessions * 2);
    assert.equal(diagnostics.canonicalSessionAssignments, sessions);
    assert.equal(diagnostics.replayCalls, 0);
    assert.ok(structural.parentVisits <= sessions * 2);
    assert.equal(diagnostics.ingested, sessions * 2);
    const clock = store.clockRevision();
    const indexVisits = diagnostics.indexStreamVisits;
    for (let hour = 0; hour <= 60; hour++) {
      assert.equal(taskWallTimeForSession(store, "sid-0", 2000 + hour * 60000), 250);
      assert.equal(hasLiveTaskWallActivity(store), false);
    }
    assert.equal(store.clockRevision(), clock);
    assert.equal(tuiActivityDiagnostics(store).indexStreamVisits, indexVisits);
    assert.equal(tuiActivityDiagnostics(store).activeCandidates, 0);
    assert.deepEqual(await readdir(directory), before);
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(await readFile(join(directory, "runs.jsonl.orphan.tmp"), "utf8"), "uncommitted orphan: reader must not recover or delete");
    console.log(`TUI fresh ${sessions} sessions ${Math.round(elapsed)}ms heap=${process.memoryUsage().heapUsed} replay=${JSON.stringify(structural)} projector=${JSON.stringify(diagnostics)}`);
  } finally { store.disposed = true; store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});
