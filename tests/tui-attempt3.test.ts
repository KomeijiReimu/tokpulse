import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { normalizeActivityEvent, replayActivity, createActivityProjector, activityProjectionDiagnostics, type ActivityEvent } from "../src/activity.js";
import { TuiActivitySelection, tuiReadModel, type ParentProofPort, type ParentProofOutcome, type ParentProofWake } from "../src/tui-read-model.js";
import { createRuntimeStore, recordTuiActivityFact, reloadActivity, taskWallTimeForSession,
  tuiActivityDiagnostics, cacheSessionParentFromEvent, recordTuiObservationLifecycle,
  handleMessageUpdated, buildSessionDetailsTree } from "../src/tui.js";

const api = { ui: { toast() {} } } as unknown as TuiPluginApi;
const user = { version: 1, sourceScope: "user", reasons: [] } as const;
const magic = { version: 1, sourceScope: "magic-message", reasons: [] } as const;
const bytes = (facts: readonly ActivityEvent[]) => facts.map((fact) => JSON.stringify(fact)).join("\n") + "\n";
const normalize = (fields: object) => {
  const fact = normalizeActivityEvent({ version: 2, sessionID: "root", executionID: "exec", instanceID: "backend", ...fields });
  assert.ok(fact, "test input must normalize through the real canonical schema"); return fact;
};
function scenario(spans: Array<[string, number, number]>, end = 100, source: "step" | "tool" = "step") {
  let seq = 0;
  const fact = (fields: object) => { const next = ++seq; return normalize({ seq: next, sourceSequence: next,
    eventID: `event-${next}`, sourceEventID: `wire-${next}`, ...fields }); };
  const facts = [fact({ kind: "lifecycle", state: "busy", timestamp: 0, observedAt: 0 })];
  for (const [id, start, stop] of spans) for (const [phase, timestamp] of [["start", start], ["end", stop]] as const)
    facts.push(fact({ kind: "work", workID: id, stepID: `step:${id}`, source, phase, timestamp, observedAt: timestamp, measurementScope: user }));
  facts.push(fact({ kind: "lifecycle", state: "completed", timestamp: end, observedAt: end }));
  const proof = (id: string, sameIdentity = false) => {
    const original = facts.find((value) => value.kind === "work" && value.workID === id && value.phase === "end")!;
    return normalize({ ...original, ...(sameIdentity ? {} : { eventID: `refinement:${id}`, sourceEventID: `refinement:${id}`, sourceSequence: ++seq }), measurementScope: magic });
  };
  const reference = (ids: ReadonlySet<string>) => replayActivity(facts.map((value) => value.kind === "work" && ids.has(value.workID)
    ? normalize({ ...value, measurementScope: magic }) : value)).activeMillisecondsByRoot.get("root") ?? 0;
  return { facts, proof, reference, end };
}
async function fixture(input: ReturnType<typeof scenario>) {
  const cache = process.env.TMPDIR!; assert.ok(cache && !cache.startsWith("/tmp")); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "tui-attempt3-")), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  for (const fact of input.facts) assert.equal(recordTuiActivityFact(store, fact as unknown as Record<string, unknown>), true);
  await writeFile(path, bytes(input.facts)); await reloadActivity(store, api, path);
  assert.equal(tuiActivityDiagnostics(store).overlayFacts, 0, "fixture must really retire the initial canonical-confirmed live observation");
  return { store, path, directory, query: () => taskWallTimeForSession(store, "root", input.end + 1000),
    async reset(facts = input.facts) { const staging = join(directory, "atomic.pending"); await writeFile(staging, bytes(facts)); await rename(staging, path); await reloadActivity(store, api, path); },
    async close() { store.disposed = true; store.disposeSignals(); await rm(directory, { recursive: true, force: true }); } };
}

for (const source of ["step", "tool"] as const) test(`A2-01 retired canonical accumulates two late ${source} refinements`, async () => {
  const input = scenario([["m1", 10, 30], ["m2", 40, 70], ["normal", 80, 90]], 100, source), f = await fixture(input);
  try {
    const actual = [f.query()], expected = [input.reference(new Set())];
    for (const id of ["m1", "m2"]) {
      assert.equal(recordTuiActivityFact(f.store, input.proof(id) as unknown as Record<string, unknown>), true);
      actual.push(f.query()); expected.push(input.reference(new Set(id === "m1" ? ["m1"] : ["m1", "m2"])));
    }
    const before = f.query(); recordTuiActivityFact(f.store, input.proof("m1") as unknown as Record<string, unknown>);
    actual.push(f.query()); expected.push(50);
    console.log(`A2-01 ${source} cumulative ${JSON.stringify({ actual, expected, before, counters: tuiActivityDiagnostics(f.store) })}`);
    assert.deepEqual(actual, expected);
  } finally { await f.close(); }
});

test("A2-01 late work refinement survives identical-byte atomic reset, deletion and weak restore", async () => {
  const input = scenario([["m1", 10, 30], ["m2", 40, 70], ["normal", 80, 90]]), f = await fixture(input);
  try {
    recordTuiActivityFact(f.store, input.proof("m1") as unknown as Record<string, unknown>);
    const actual: Record<string, unknown> = { first: f.query() }, expected = input.reference(new Set(["m1"]));
    await f.reset(); actual.sameBytesReset = f.query();
    await writeFile(f.path, ""); await reloadActivity(f.store, api, f.path); await f.reset(); actual.weakRestore = f.query();
    const strong = input.facts.map((value) => value.kind === "work" && value.workID === "m1" ? normalize({ ...value, measurementScope: magic }) : value);
    await appendFile(f.path, bytes([...strong.filter((value) => value.kind === "work" && value.workID === "m1"), input.proof("m1")]));
    await reloadActivity(f.store, api, f.path); actual.strongCanonical = f.query(); actual.overlayAfterConfirmation = tuiActivityDiagnostics(f.store).overlayFacts;
    console.log(`A2-01 reset ${JSON.stringify(actual)}`);
    assert.deepEqual(actual, { first: expected, sameBytesReset: expected, weakRestore: expected, strongCanonical: expected, overlayAfterConfirmation: 0 });
  } finally { await f.close(); }
});

test("A2-01 confirmed pure receipt survives weak reset without transplanting certificate or hiding unknown normal work", async () => {
  const input = scenario([["m1", 20, 80]]), f = await fixture(input);
  const pure = normalize({ ...input.facts[0], kind: "execution-scope", timestamp: 100, seq: 1000, sourceSequence: 1000,
    eventID: "pure-certificate", sourceEventID: "pure-certificate", classification: "pure-maintenance", coverage: "complete" });
  try {
    recordTuiActivityFact(f.store, input.proof("m1") as unknown as Record<string, unknown>);
    recordTuiActivityFact(f.store, pure as unknown as Record<string, unknown>); assert.equal(f.query(), 0);
    const receiptCopies = tuiActivityDiagnostics(f.store).pureReceiptCopies;
    await f.reset(); assert.equal(f.query(), 0, "unconfirmed complete receipt must survive a weak reset too");
    assert.equal(tuiActivityDiagnostics(f.store).pureReceiptCopies, receiptCopies, "reset reuses the compact complete receipt, not a partial live rebuild");
    const strong = input.facts.filter((fact) => fact.kind === "work").map((fact) => normalize({ ...fact, measurementScope: magic }));
    await appendFile(f.path, bytes([...strong, pure])); await reloadActivity(f.store, api, f.path);
    assert.equal(f.query(), 0); assert.equal(tuiActivityDiagnostics(f.store).overlayFacts, 0);
    await f.reset(); const unchanged = JSON.stringify(f.store.activityEvents); assert.equal(f.query(), 0);
    assert.equal(recordTuiActivityFact(f.store, pure as unknown as Record<string, unknown>), false, "canonical reset cannot forget stable semantic dedupe");
    assert.equal(JSON.stringify(f.store.activityEvents), unchanged);
    await writeFile(f.path, ""); await reloadActivity(f.store, api, f.path); assert.ok(!f.query(), "deletion must not manufacture busy time");
    await f.reset(); assert.equal(f.query(), 0);
    const normal = [90, 95].map((timestamp, i) => normalize({ ...input.facts.find((fact) => fact.kind === "work")!, source: "tool", stepID: undefined,
      workID: "new-normal", phase: i ? "end" : "start", timestamp, seq: 2000 + i, sourceSequence: 2000 + i,
      eventID: `normal-${i}`, sourceEventID: `normal-${i}`, measurementScope: user }));
    await appendFile(f.path, bytes(normal)); await reloadActivity(f.store, api, f.path);
    const reference = replayActivity([...input.facts.map((fact) => fact.kind === "work" ? normalize({ ...fact, measurementScope: magic }) : fact), ...normal]);
    assert.equal(f.query(), reference.activeMillisecondsByRoot.get("root")); assert.equal(f.query(), 40);
  } finally { await f.close(); }
});

for (const entrance of ["overlay", "selection"] as const) test(`A2-02 ${entrance} accepts stronger identical business identity without downgrade`, async () => {
  const input = scenario([["m1", 10, 80]]), store = createRuntimeStore(1, 0), selection = new TuiActivitySelection(store);
  const add = (fact: ActivityEvent) => entrance === "overlay" ? recordTuiActivityFact(store, fact as unknown as Record<string, unknown>) : selection.addLive(normalize({ ...fact, instanceID: "local" }));
  const query = () => entrance === "overlay" ? taskWallTimeForSession(store, "root", 1000) : selection.projector.totals("root", { replayCutoff: 1000 }).includingMilliseconds;
  try {
    const tokens = { input: 2, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    store.totalsLedger = { ...store.totalsLedger, settled: { m1: { sessionID: "root", quality: "exact", tokens, cost: 2 },
      normal: { sessionID: "root", quality: "exact", tokens, cost: 3 } }, sessions: { root: { responseCount: 2, cost: 5,
      tokens: { input: 4, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } } };
    const original = JSON.stringify(store.totalsLedger); for (const fact of input.facts) assert.equal(add(fact), true);
    const actual: Record<string, unknown> = { initial: query(), callsBefore: buildSessionDetailsTree(store, "root").including.responseCount };
    handleMessageUpdated(store, api, { info: { id: "m1", sessionID: "root", role: "assistant", agent: "historian", time: { created: 0, completed: 80 } } }, { type: "message.updated", timestamp: 80 }, 4, 80);
    const strong = input.proof("m1", true), weak = input.facts.find((value) => value.kind === "work" && value.workID === "m1" && value.phase === "end")!;
    actual.admitted = add(strong); actual.strong = query(); actual.duplicate = add(strong); actual.afterDuplicate = query();
    actual.weak = add(weak); actual.afterWeak = query(); actual.callsAfter = buildSessionDetailsTree(store, "root").including.responseCount;
    actual.costAfter = buildSessionDetailsTree(store, "root").including.cost;
    if (entrance === "selection") { selection.freeze("local", 100); selection.reset(input.facts); actual.weakReset = query(); selection.addCanonical([strong]); actual.handoff = query(); actual.overlayAfter = selection.diagnostics().overlayFacts; }
    else {
      const cache = process.env.TMPDIR!, directory = await mkdtemp(join(cache, "tui-a2-identity-")), path = join(directory, "runs.jsonl");
      try { await writeFile(path, bytes(input.facts)); await reloadActivity(store, api, path); actual.weakReset = query();
        await appendFile(path, bytes([strong])); await reloadActivity(store, api, path); actual.handoff = query(); actual.overlayAfter = tuiActivityDiagnostics(store).overlayFacts;
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    assert.equal(JSON.stringify(store.totalsLedger), original);
    console.log(`A2-02 ${entrance} ${JSON.stringify(actual)}`);
    assert.deepEqual(actual, { initial: 100, callsBefore: 2, admitted: true, strong: 30, duplicate: false, afterDuplicate: 30,
      weak: false, afterWeak: 30, callsAfter: 1, costAfter: 3, weakReset: 30, handoff: 30, overlayAfter: 0 });
  } finally { store.disposed = true; store.disposeSignals(); }
});

const liveParent = (store: ReturnType<typeof createRuntimeStore>, parent: string | null, seq: number, epoch = "live-epoch") =>
  cacheSessionParentFromEvent(store, { type: "session.updated", sourceEventID: `${epoch}:${seq}`, sourceEpoch: epoch, sourceSequence: seq,
    properties: { sessionID: "child", parentSessionID: parent } });
test("A2-03 real live parent entry ignores older comparable sequence and retains newer root", () => {
  const store = createRuntimeStore(1, 0);
  try {
    const parents: unknown[] = []; liveParent(store, "B", 20); parents.push(store.sessionParents.get("child"));
    liveParent(store, "A", 10); parents.push(store.sessionParents.get("child"));
    liveParent(store, "C", 30); parents.push(store.sessionParents.get("child"));
    liveParent(store, null, 40); parents.push(store.sessionParents.get("child"));
    liveParent(store, "old-C", 35); parents.push(store.sessionParents.get("child"));
    console.log(`A2-03 comparable ${JSON.stringify(parents)}`); assert.deepEqual(parents, ["B", "B", "C", null, null]);
  } finally { store.disposed = true; store.disposeSignals(); }
});

function port() {
  const requests: Array<{ id: string; version: number; receive: (outcome: ParentProofOutcome, version: number) => void }> = [];
  const active = new Set<(event: ParentProofWake) => void>(), all: Array<(event: ParentProofWake) => void> = [];
  const value: ParentProofPort = { epoch: () => 0, request(id, version, receive) { requests.push({ id, version, receive }); return true; },
    available(receive) { active.add(receive); all.push(receive); return () => { active.delete(receive); }; } };
  return { value, requests, active, lateAvailability: () => { for (const receive of all) receive({ kind: "capacity" }); } };
}
function conflict(store: ReturnType<typeof createRuntimeStore>) {
  const model = tuiReadModel(store);
  model.canonicalParents([normalize({ kind: "parent", sessionID: "child", parentSessionID: "A", eventID: "disk-parent", executionID: undefined,
    timestamp: 1, observedAt: 1, sourceSequence: 5000 })], false);
  liveParent(store, "B", 1, "incomparable-live"); return model;
}
test("A2-03 incomparable canonical/live epochs remain provisional until actual fresh proof", () => {
  const store = createRuntimeStore(1, 0), proof = port();
  try { const model = tuiReadModel(store); model.bindProof(proof.value); conflict(store);
    assert.equal(store.sessionParents.get("child"), "A"); assert.equal(model.diagnostics().parentConflicts, 1);
    assert.equal(proof.requests.length, 1); const job = proof.requests[0]!; job.receive({ status: "success", parent: "B" }, job.version);
    assert.equal(store.sessionParents.get("child"), "B"); assert.equal(model.diagnostics().parentConflicts, 0);
  } finally { store.disposed = true; store.disposeSignals(); }
});

for (const oldCompletion of ["success", "failure-availability", "finally-availability"] as const)
test(`A2-05 replaced same-epoch port fences old ${oldCompletion} and schedules new proof`, () => {
  const store = createRuntimeStore(1, 0), old = port(), fresh = port();
  try {
    const model = tuiReadModel(store); model.bindProof(old.value); conflict(store); assert.equal(old.requests.length, 1);
    model.bindProof(fresh.value); const before = fresh.requests.length;
    if (oldCompletion === "success") old.requests[0]!.receive({ status: "success", parent: "stale-parent-from-old-port" }, old.requests[0]!.version);
    else { if (oldCompletion === "failure-availability") old.requests[0]!.receive({ status: "error" }, old.requests[0]!.version); old.lateAvailability(); }
    const afterOld = store.sessionParents.get("child"); const job = fresh.requests[0]; job?.receive({ status: "success", parent: "B" }, job.version);
    const actual = { old: old.requests.length, newBeforeOldCallback: before, newAfterOldCallback: fresh.requests.length, afterOld, final: store.sessionParents.get("child") };
    console.log(`A2-05 ${oldCompletion} ${JSON.stringify(actual)}`);
    assert.deepEqual(actual, { old: 1, newBeforeOldCallback: 1, newAfterOldCallback: 1, afterOld: "A", final: "B" });
  } finally { store.disposed = true; store.disposeSignals(); }
});
test("A2-05 disposed model ignores an already-admitted proof callback", () => {
  const store = createRuntimeStore(1, 0), proof = port();
  try { const model = tuiReadModel(store); model.bindProof(proof.value); conflict(store);
    const job = proof.requests[0]!, revision = store.revision(); store.disposed = true; job.receive({ status: "success", parent: "late-after-dispose" }, job.version);
    assert.deepEqual({ parent: store.sessionParents.get("child"), revision: store.revision() }, { parent: "A", revision });
  } finally { store.disposed = true; store.disposeSignals(); }
});

test("A2-04 rejected admission waits for capacity and installs token before synchronous success", () => {
  const store = createRuntimeStore(1, 0), model = tuiReadModel(store);
  let admit = false, requests = 0, doneCalls = 0, wake: ((event: ParentProofWake) => void) | undefined;
  const proof: ParentProofPort = { epoch: () => 0, available(receive) { wake = receive; return () => { wake = undefined; }; },
    request(_id, version, done) { requests++; if (!admit) return false; doneCalls++; done({ status: "success", parent: "B" }, version); return true; } };
  try {
    model.bindProof(proof); conflict(store); const entry = model.conflicts.get("child")!, version = entry.version;
    for (let i = 0; i < 20; i++) { model.root("child"); model.eligible("child"); model.bindProof(); }
    assert.equal(requests, 1); assert.equal(doneCalls, 0); assert.equal(entry.version, version);
    admit = true; wake!({ kind: "capacity" });
    assert.equal(requests, 2); assert.equal(doneCalls, 1); assert.equal(store.sessionParents.get("child"), "B");
    assert.equal(model.conflicts.size, 0); assert.equal(entry.version, version);
  } finally { store.disposed = true; model.dispose(); store.disposeSignals(); }
});

test("A2-04 untouched tail stays ahead of a healthy-rearmed parked target", () => {
  const store = createRuntimeStore(1, 0), model = tuiReadModel(store), admitted: string[] = [];
  let wake: ((event: ParentProofWake) => void) | undefined;
  let held: { id: string; version: number; done: (outcome: ParentProofOutcome, version: number) => void; notBefore: number } | undefined;
  const proof: ParentProofPort = { epoch: () => 0, available(receive) { wake = receive; return () => { wake = undefined; }; },
    request(id, version, done, options) { if (held) return false; admitted.push(id); held = { id, version, done, notBefore: options?.notBefore ?? 0 }; return true; } };
  const complete = (outcome: ParentProofOutcome, event: ParentProofWake) => { const job = held!; assert.ok(job); held = undefined; job.done(outcome, job.version); wake!(event); };
  try {
    model.bindProof(proof);
    for (const id of ["a", "b", "c", "d"]) {
      model.canonicalParents([normalize({ kind: "parent", version: 2, instanceID: "disk", sessionID: id, timestamp: 0, observedAt: 0, seq: 0, eventID: id, parentSessionID: "A" })], false);
      model.observeParent(id, { origin: "live", parent: "B", sourceEpoch: "live", sourceSequence: 1 });
    }
    model.root("a"); const failedAt = performance.now();
    complete({ status: "error" }, { kind: "capacity" });
    complete({ status: "success", parent: "B" }, { kind: "healthy", serial: 1 });
    complete({ status: "success", parent: "B" }, { kind: "healthy", serial: 2 });
    assert.deepEqual(admitted, ["a", "b", "c", "d"], "rearming a cannot displace untouched d behind a future notBefore slot");
    complete({ status: "success", parent: "B" }, { kind: "healthy", serial: 3 });
    assert.deepEqual(admitted, ["a", "b", "c", "d", "a"]); assert.ok(held!.notBefore >= failedAt + 1000);
  } finally { store.disposed = true; model.dispose(); store.disposeSignals(); }
});

for (const oldStart of [100000, 100]) test(`A2-06 unrelated old epoch ${oldStart} cannot set current live clock`, async () => {
  const store = createRuntimeStore(1, 0), directory = await mkdtemp(join(process.env.TMPDIR!, "tui-a2-clock-")), path = join(directory, "runs.jsonl");
  try {
    const history = [normalize({ kind: "lifecycle", sessionID: "unrelated", executionID: "old", instanceID: "old-backend", state: "busy", timestamp: oldStart, observedAt: oldStart, eventID: "old-busy" }),
      normalize({ kind: "lifecycle", sessionID: "unrelated", executionID: "old", instanceID: "old-backend", state: "completed", timestamp: oldStart + 100, observedAt: oldStart + 100, eventID: "old-done" })];
    await writeFile(path, bytes(history)); await reloadActivity(store, api, path);
    recordTuiActivityFact(store, { kind: "lifecycle", sessionID: "root", executionID: "fresh", state: "busy", timestamp: 1000, sourceEventID: "fresh-busy", sourceSequence: 1 });
    const actual: Record<string, unknown> = { current: taskWallTimeForSession(store, "root", 2000), historical: taskWallTimeForSession(store, "unrelated", 2000) };
    const staging = join(directory, "clock-reset.pending"); await writeFile(staging, bytes(history)); await rename(staging, path); await reloadActivity(store, api, path);
    actual.afterReset = taskWallTimeForSession(store, "root", 2000);
    recordTuiObservationLifecycle(store, "server.instance.disposed", {}, { timestamp: 1100 }, 1100);
    recordTuiActivityFact(store, { kind: "lifecycle", sessionID: "root", executionID: "new-after-gap", state: "busy", timestamp: 1200, sourceEventID: "new-busy", sourceSequence: 1 });
    actual.reconnected = taskWallTimeForSession(store, "root", 2000);
    recordTuiActivityFact(store, { kind: "lifecycle", sessionID: "root", executionID: "new-after-gap", state: "completed", timestamp: 1500, sourceEventID: "new-done", sourceSequence: 2 });
    actual.closedNew = taskWallTimeForSession(store, "root", 4000); actual.closedOld = taskWallTimeForSession(store, "unrelated", 4000);
    console.log(`A2-06 ${oldStart} ${JSON.stringify(actual)}`);
    assert.deepEqual(actual, { current: 1000, historical: 100, afterReset: 1000, reconnected: 800, closedNew: 300, closedOld: 100 });
  } finally { store.disposed = true; store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("A2-06 same SID keeps 100 historical milliseconds plus only the new 1000 live milliseconds", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR!, "tui-a2-same-sid-clock-")), path = join(directory, "runs.jsonl"), store = createRuntimeStore(1, 0);
  try {
    const old = [100000, 100100].map((timestamp, i) => normalize({ version: 2, instanceID: "old-backend", sessionID: "root", executionID: "old",
      kind: "lifecycle", state: i ? "completed" : "busy", timestamp, observedAt: timestamp, seq: i, eventID: `old-${i}` }));
    await writeFile(path, bytes(old)); await reloadActivity(store, api, path);
    recordTuiActivityFact(store, { sessionID: "root", executionID: "new", kind: "lifecycle", state: "busy", timestamp: 1000, eventID: "new-busy" });
    assert.equal(taskWallTimeForSession(store, "root", 2000), 1100);
  } finally { store.disposeSignals(); await rm(directory, { recursive: true, force: true }); }
});

test("A2-06 disruption freezes each current stream at its own prefix, never another SID clock", () => {
  const store = createRuntimeStore(1, 0);
  try {
    const send = (sessionID: string, executionID: string, state: string, timestamp: number) => assert.equal(recordTuiActivityFact(store, { sessionID, executionID, kind: "lifecycle", state, timestamp, eventID: `${sessionID}-${state}` }), true);
    send("root", "current", "busy", 1000);
    for (const [phase, timestamp] of [["start", 1200], ["end", 1300]] as const) assert.equal(recordTuiActivityFact(store, { sessionID: "root", executionID: "current", kind: "work",
      source: "tool", workID: "tool", phase, timestamp, measurementScope: user, eventID: `root-tool-${phase}` }), true);
    send("other", "other-exec", "busy", 200000); send("other", "other-exec", "completed", 200100);
    assert.equal(taskWallTimeForSession(store, "root", 2000), 1000);
    recordTuiObservationLifecycle(store, "server.instance.disposed", {}, {}, 2000);
    assert.equal(taskWallTimeForSession(store, "root", 3000), 300); assert.equal(taskWallTimeForSession(store, "other", 3000), 100);
  } finally { store.disposeSignals(); }
});

for (const n of [100, 200, 400, 1000, 2000, 4000]) test(`A2-PROBE one retired execution ${n} late refinements stays cumulative and linear`, async () => {
  const spans: Array<[string, number, number]> = Array.from({ length: n }, (_, i) => [`m${i}`, i * 10 + 1, i * 10 + 4]);
  spans.push(["normal", n * 10 + 5, n * 10 + 6]); const input = scenario(spans, n * 10 + 10), f = await fixture(input);
  try {
    const before = tuiActivityDiagnostics(f.store), refined = new Set<string>(), samples: Array<{ at: number; actual: unknown; reference: number }> = [];
    const startupStarted = performance.now(), initial = f.query(), startupCandidateMs = performance.now() - startupStarted;
    const startupReferenceStarted = performance.now(), initialReference = input.reference(refined), startupReferenceMs = performance.now() - startupReferenceStarted;
    assert.equal(initial, initialReference);
    const warmed = tuiActivityDiagnostics(f.store);
    const checkpoints = new Set([1, 2, 4, 10, Math.floor(n / 2), n]); let candidateMs = 0, referenceMs = 0;
    for (let i = 0; i < n; i++) {
      const started = performance.now(); recordTuiActivityFact(f.store, input.proof(`m${i}`) as unknown as Record<string, unknown>); const actual = f.query(); candidateMs += performance.now() - started;
      refined.add(`m${i}`);
      if (checkpoints.has(i + 1)) { const referenceStarted = performance.now(), reference = input.reference(refined); referenceMs += performance.now() - referenceStarted; samples.push({ at: i + 1, actual, reference }); }
    }
    const after = tuiActivityDiagnostics(f.store), delta = Object.fromEntries(["coldRepairFacts", "coldStreamRepairs", "coldFactVisits", "workFactVisits", "workSpanVisits", "factVisits", "factMaterializations", "intervalVisits", "intervalMaterializations", "factSortComparisons", "intervalSortComparisons", "indexNodeVisits", "contextNodeVisits", "indexBuilds", "snapshotBuilds", "selectorChanges", "canonicalArrayCopies", "pureReceiptCopies", "pureReceiptEntries"].map((key) => [key, Number((after as any)[key]) - Number((before as any)[key])]));
    const warmIndexBuilds = after.indexBuilds - warmed.indexBuilds;
    console.log(`A2-PROBE ${JSON.stringify({ n, startup: { candidateMs: startupCandidateMs, referenceMs: startupReferenceMs, indexBuilds: warmed.indexBuilds - before.indexBuilds }, candidateMs, referenceMs, samples, delta, warmIndexBuilds })}`);
    assert.deepEqual({ correct: samples.every((sample) => sample.actual === sample.reference), linearRepair: delta.coldRepairFacts <= n * 32 + 128,
      linearMaterialization: delta.factMaterializations <= n * 80 + 256 }, { correct: true, linearRepair: true, linearMaterialization: true });
    assert.deepEqual([delta.coldStreamRepairs, delta.coldFactVisits, delta.factSortComparisons, warmIndexBuilds, delta.selectorChanges,
      delta.canonicalArrayCopies, delta.pureReceiptCopies, delta.pureReceiptEntries], Array(8).fill(0), "ordinary refinement cannot hide full source reset/copy/sort or whole-certificate repair");
    assert.ok(delta.workFactVisits <= n * 4 + 128); assert.ok(delta.workSpanVisits <= n * 8 + 128); assert.ok(delta.intervalMaterializations <= n * 32 + 128);
  } finally { await f.close(); }
});

test("A2-API-PROBE existing shared ingest positive metadata capability (not a TUI repair)", () => {
  const input = scenario([["m1", 10, 30], ["m2", 40, 70], ["normal", 80, 90]]), projector = createActivityProjector(input.facts);
  const refined = new Set<string>(), samples = [{ actual: projector.totals("root", { replayCutoff: 1000 }).includingMilliseconds, reference: input.reference(refined) }];
  const before = activityProjectionDiagnostics(projector);
  for (const id of ["m1", "m2"]) {
    projector.ingest([input.proof(id, true)]); refined.add(id);
    samples.push({ actual: projector.totals("root", { replayCutoff: 1000 }).includingMilliseconds, reference: input.reference(refined) });
  }
  const after = activityProjectionDiagnostics(projector), delta = Object.fromEntries(Object.keys(before).map((key) => [key, Number((after as any)[key]) - Number((before as any)[key])]));
  console.log(`A2-API-PROBE ${JSON.stringify({ samples, delta })}`); assert.ok(samples.every((sample) => sample.actual === sample.reference));
});
