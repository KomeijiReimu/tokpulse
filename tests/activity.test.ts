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
  createActivityProjector,
  type ActivityEvent,
  type WorkActivityEventInput,
  type ActivityProjector,
  type ActivityReplayOptions,
} from "../src/activity.js";
import { createScopeRegistry, classifyMessageMetadata, classifySessionMetadata } from "../src/scope.js";

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
  registry.observeSessionMetadata("mc", { agent: "dreamer" });
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
  const result = replayActivity(events, { sessionScopes: { b: classifySessionMetadata({ agent: "historian" }) }, parentBySessionID: { a: "b", b: "a" } });
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

test("ID-less identity preserves boundaries and identical busy facts have order-independent time", () => {
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
  assert.deepEqual(first.events.map((event) => event.eventID).sort(), second.events.map((event) => event.eventID).sort());
  assert.deepEqual(first.timelines.get("session")?.intervals, second.timelines.get("session")?.intervals);
  assert.equal(first.timelines.get("session")?.activeMilliseconds, second.timelines.get("session")?.activeMilliseconds);
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

test("open activity retains proven lifecycle time without extending to a fresh reader clock", () => {
  const events = [
    lifecycle("busy", 100, "session", 1, "old"),
    lifecycle("retry", 500, "session", 2, "old"),
    lifecycle("busy", 300, "child", 1, "old"),
    lifecycle("retry", 700, "child", 2, "old"),
    parent("child", "session", 900),
  ];
  for (const cutoff of [undefined, 1_000, 1_000_000]) {
    const replay = replayActivity(events, { cutoff });
    assert.equal(replay.rootActiveMilliseconds.session, 600);
    assert.equal(replay.timelines.get("session")?.open, true);
    assert.equal(replay.timelines.get("child")?.instances[0]?.boundary, 700,
      "parent metadata receipt is not evidence that the participant remained busy");
    assert.deepEqual(calculateActiveIntervals(events, { cutoff }), [{ start: 100, end: 700 }]);
  }
  assert.equal(replayActivity(events, { instanceEndedAt: 400 }).rootActiveMilliseconds.session, 300);
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
    { ...lifecycle("busy", 600, "mc", 1), scope: classifySessionMetadata({ agent: "dreamer" }) },
  ];
  for (const options of [{ replayCutoff: 300 }, { replayCutoff: 300, trustedCurrentInstanceID: "default" }]) {
    const replay = replayActivity(events, options);
    assert.equal(replay.timelines.has("child"), false);
    assert.deepEqual(calculateActiveIntervals(events, options), [{ start: 100, end: 200 }]);
    assert.deepEqual(mergeIntervals(replay.roots.flatMap((root) => root.activeIntervals)), [{ start: 100, end: 200 }]);
  }
});

test("maintenance message proof cannot hide the session or normal child, including after a cutoff", () => {
  for (const identity of [{ agent: "historian" }, { mode: "dreamer" }]) {
    const proof = classifyMessageMetadata(identity);
    assert.equal(proof.sourceScope, "magic-message");
    const events = [
      lifecycle("busy", 0, "root", 1), lifecycle("idle", 100, "root", 2),
      lifecycle("busy", 50, "child", 1), lifecycle("idle", 200, "child", 2),
      parent("child", "root", 500),
      { ...parent("root", "ancestor", 600), scope: proof },
    ];
    const options = { replayCutoff: 300, sessionScopes: { root: proof } };
    const replay = replayActivity(events, options);
    assert.equal(replay.timelines.get("root")?.activeMilliseconds, 100);
    assert.equal(replay.timelines.get("child")?.activeMilliseconds, 150);
    assert.deepEqual(calculateActiveIntervals(events, options), [{ start: 0, end: 200 }]);
    const projector = createActivityProjector(events.map(fact));
    projector.setContext({ sessionScopes: options.sessionScopes });
    assert.deepEqual(projector.totals("root", options), { directMilliseconds: 100, includingMilliseconds: 200, active: false });
    assert.equal(filterActivityEvents(events, options.sessionScopes).some((event) => event.sessionID === "child"), true);
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

const mc = { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] } as const;
const user = { version: 1, sourceScope: "user", reasons: ["normal-agent"] } as const;
function fact(input: ActivityEventInput): ActivityEvent { return normalizeActivityEvent(input)!; }
function execution(state: "busy" | "retry" | "completed" | "idle", timestamp: number, sessionID = "root", executionID = "e", seq = timestamp): ActivityEvent {
  return fact({ kind: "lifecycle", sessionID, executionID, state, timestamp, seq, instanceID: "epoch" });
}
function work(phase: "start" | "end", timestamp: number, maintenance: boolean, extra: Partial<WorkActivityEventInput> = {}): ActivityEvent {
  return fact({ kind: "work", sessionID: "root", executionID: "e", instanceID: "epoch", timestamp,
    workID: "step", source: "step", phase, measurementScope: maintenance ? { ...mc, reasons: [...mc.reasons] } : { ...user, reasons: [...user.reasons] }, ...extra });
}
function pure(timestamp = 100): ActivityEvent {
  return fact({ kind: "execution-scope", sessionID: "root", executionID: "e", instanceID: "epoch", timestamp,
    classification: "pure-maintenance", coverage: "complete" });
}

test("v2 facts roundtrip compact identities; v1 remains readable without promotion", () => {
  const event = fact({ ...lifecycle("busy", 0, "s", 1), executionID: "e", sourceEventID: "sdk", sourceSequence: 42 });
  assert.equal(event.version, 2);
  assert.equal(event.sourceSequence, 42);
  assert.equal(event.sourceEventID, "sdk");
  assert.deepEqual(normalizeActivityEvent(JSON.parse(JSON.stringify(event))), event);
  assert.equal(normalizeActivityEvent({ ...event, version: 1 })?.version, 1);
  assert.equal(normalizeActivityEvent({ ...work("start", 10, true), version: 1 }), undefined);
  assert.equal(normalizeActivityEvent({ ...work("start", 10, true), executionID: undefined }), undefined);
  assert.notEqual(event.eventID, fact({ ...event, eventID: undefined, sourceSequence: 43 }).eventID);
});

test("maintenance is subtracted per execution before union; normal child and overlapping normal tool survive", () => {
  const facts = [execution("busy", 0), work("start", 20, true),
    work("start", 40, false, { source: "tool", workID: "normal-tool" }),
    work("end", 60, false, { source: "tool", workID: "normal-tool" }),
    work("end", 80, true), execution("completed", 100),
    execution("busy", 30, "child"), execution("completed", 70, "child"), fact(parent("child", "root", 101))];
  const replay = replayActivity(facts);
  assert.equal(replay.timelines.get("root")?.activeMilliseconds, 60);
  assert.equal(replay.rootActiveMilliseconds.root, 80);
  const projector = createActivityProjector();
  for (const event of [...facts].sort((a, b) => a.timestamp - b.timestamp)) projector.ingest([event]);
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 60, includingMilliseconds: 80, active: false });
  assert.deepEqual(projector.totals("child"), { directMilliseconds: 40, includingMilliseconds: 40, active: false });
});

test("complete pure-MC clears only own execution; missing start/partial/unknown proof remains conservative", () => {
  const own = [execution("busy", 0), work("start", 20, true), work("end", 80, true), execution("completed", 100)];
  assert.equal(replayActivity(own).rootActiveMilliseconds.root, 40);
  const facts = [...own, pure(), execution("busy", 30, "child"), execution("completed", 70, "child"), fact(parent("child", "root", 101))];
  assert.equal(replayActivity(facts).rootActiveMilliseconds.root, 40);
  assert.deepEqual(createActivityProjector(facts).totals("root"), { directMilliseconds: 0, includingMilliseconds: 40, active: false });
  assert.equal(replayActivity([execution("retry", 0), ...own.slice(1), pure()]).rootActiveMilliseconds.root, 40);
  assert.equal(replayActivity([...own.slice(0, -1), pure()]).rootActiveMilliseconds.root, 0); // open base only proves busy@0
  assert.equal(replayActivity([...own.slice(0, -1), pure()], { replayCutoff: 200, trustedCurrentInstanceID: "epoch" }).rootActiveMilliseconds.root, 140);
  assert.equal(createActivityProjector([...own.slice(0, -1), pure()]).totals("root", { replayCutoff: 200, trustedCurrentInstanceID: "epoch" }).directMilliseconds, 140);
  const pending = work("start", 10, false, { workID: "unknown", measurementScope: { version: 1, sourceScope: "pending", reasons: [] } });
  assert.equal(replayActivity([...own, pending, pure()]).rootActiveMilliseconds.root, 40);
  assert.equal(replayActivity([work("start", 0, true), work("end", 100, true), pure()]).rootActiveMilliseconds.root, 0);
});

test("MC step tools cannot restore its maintenance interval; independent tool can", () => {
  const facts = [execution("busy", 0), work("start", 0, true),
    work("start", 20, false, { source: "tool", workID: "t", stepID: "step" }),
    work("end", 60, false, { source: "tool", workID: "t", stepID: "step" }),
    work("end", 100, true), execution("completed", 100)];
  assert.equal(replayActivity(facts).rootActiveMilliseconds.root, 0);
  assert.equal(createActivityProjector(facts).totals("root").directMilliseconds, 0);
});

test("late maintenance proof corrects only observed busy, never manufactures idle or a work-to-now tail", () => {
  const facts = [execution("busy", 0), work("start", 10, false), work("end", 90, false), execution("idle", 50), execution("busy", 70), execution("completed", 100)];
  const projector = createActivityProjector(facts);
  assert.equal(projector.totals("root").directMilliseconds, 80);
  const late = [work("start", 10, true), work("end", 90, true)];
  projector.ingest(late);
  assert.equal(projector.totals("root").directMilliseconds, 20);
  assert.equal(projector.totals("root").directMilliseconds, replayActivity([...facts, ...late]).rootActiveMilliseconds.root);
  projector.ingest([work("start", 200, false, { workID: "no-busy" }), work("end", 1000, false, { workID: "no-busy" })]);
  assert.equal(projector.totals("root", { replayCutoff: 10000, trustedCurrentInstanceID: "epoch" }).directMilliseconds, 20);
});

test("same-ms transitions follow SDK sequence or receive order, not fixed active priority", () => {
  for (const reversed of [false, true]) {
    const a = fact({ kind: "lifecycle", sessionID: "s", timestamp: 10, state: reversed ? "idle" : "busy", instanceID: "epoch" });
    const b = fact({ kind: "lifecycle", sessionID: "s", timestamp: 10, state: reversed ? "busy" : "idle", instanceID: "epoch" });
    const expected = reversed ? 90 : 0;
    const options = { replayCutoff: 100, trustedCurrentInstanceID: "epoch" };
    assert.equal(replayActivity([a, b], options).rootActiveMilliseconds.s, expected);
    assert.equal(createActivityProjector([a, b]).totals("s", options).directMilliseconds, expected);
    const sequenced = [{ ...a, sourceSequence: 1 }, { ...b, sourceSequence: 2 }];
    assert.equal(replayActivity([...sequenced].reverse(), options).rootActiveMilliseconds.s, expected);
    assert.equal(createActivityProjector([...sequenced].reverse()).totals("s", options).directMilliseconds, expected);
  }
});

test("clock rollback terminal cannot reopen; new execution/epoch never bridges unknown gaps", () => {
  const options = { replayCutoff: 1000, trustedCurrentInstanceID: "epoch" };
  const rollback = [execution("busy", 100, "root", "e", 1), execution("completed", 90, "root", "e", 2)];
  assert.equal(replayActivity(rollback, options).rootActiveMilliseconds.root, 0);
  assert.equal(createActivityProjector(rollback).totals("root", options).directMilliseconds, 0);
  const sealed = [execution("busy", 0, "root", "sealed", 1), execution("completed", 100, "root", "sealed", 2), execution("busy", 90, "root", "sealed", 3)];
  assert.equal(replayActivity(sealed, options).rootActiveMilliseconds.root, 100);
  assert.equal(createActivityProjector(sealed).totals("root", options).directMilliseconds, 100);
  const epochs = [execution("busy", 0, "root", "old", 1), execution("retry", 20, "root", "old", 2), execution("busy", 100, "root", "new", 3)];
  assert.equal(replayActivity(epochs, options).rootActiveMilliseconds.root, 920);
  assert.equal(createActivityProjector(epochs).totals("root", options).directMilliseconds, 920);
  const restart = epochs.map((event, i) => ({ ...event, instanceID: i === 2 ? "epoch" : "prior" }));
  assert.equal(createActivityProjector(restart).totals("root", options).directMilliseconds, 920);
});

test("projector late parent/hidden ancestor/cycles and special keys are safe", () => {
  const facts = [execution("busy", 0, "constructor"), execution("completed", 100, "constructor"),
    execution("busy", 10, "__proto__"), execution("completed", 80, "__proto__")];
  const projector = createActivityProjector(facts);
  projector.ingest([fact(parent("__proto__", "constructor", 101))]);
  assert.equal(projector.totals("constructor").includingMilliseconds, 100);
  projector.ingest([fact(parent("constructor", "__proto__", 102))]);
  assert.equal(projector.totals("__proto__").includingMilliseconds, 100);
  projector.setContext({ sessionScopes: { ["__proto__"]: { version: 1, sourceScope: "magic-session", reasons: ["session-agent"] } } });
  assert.equal(projector.totals("constructor").includingMilliseconds, 0);
  const replay = replayActivity(facts);
  assert.equal(replay.rootActiveMilliseconds.constructor, 100);
  assert.equal(replay.rootActiveMilliseconds.__proto__, 70);
  const specialWork = [execution("busy", 0, "__proto__", "constructor"),
    work("start", 20, true, { sessionID: "__proto__", executionID: "constructor", workID: "__proto__", sourceEventID: "constructor" }),
    work("end", 80, true, { sessionID: "__proto__", executionID: "constructor", workID: "__proto__", sourceEventID: "__proto__" }),
    execution("completed", 100, "__proto__", "constructor")];
  assert.equal(createActivityProjector(specialWork).totals("__proto__").directMilliseconds, 40);
});

test("permuted execution facts converge; old terminal never closes a different execution", () => {
  const facts = [execution("busy", 0, "root", "old", 1), execution("completed", 40, "root", "old", 2),
    execution("busy", 100, "root", "current", 3), work("start", 120, true, { executionID: "current" }), work("end", 150, true, { executionID: "current" })];
  const options = { replayCutoff: 200, trustedCurrentInstanceID: "epoch" };
  const expected = replayActivity(facts, options).rootActiveMilliseconds.root;
  for (const order of [[4, 2, 1, 0, 3], [2, 0, 4, 3, 1], [1, 0, 3, 4, 2]]) {
    const projector = createActivityProjector();
    for (const i of order) projector.ingest([facts[i]]);
    assert.equal(projector.totals("root", options).directMilliseconds, expected);
  }
  const otherTerminal = execution("completed", 180, "root", "never-started", 4);
  assert.equal(replayActivity([...facts, otherTerminal], options).rootActiveMilliseconds.root, expected);
  assert.equal(createActivityProjector([...facts, otherTerminal]).totals("root", options).directMilliseconds, expected);
});

test("appended hidden ancestor proof invalidates already-cached descendant direct time", () => {
  const facts = [execution("busy", 0, "child"), execution("completed", 100, "child"), fact(parent("child", "ancestor", 101))];
  const projector = createActivityProjector(facts);
  assert.equal(projector.totals("child").directMilliseconds, 100);
  assert.equal(projector.totals("ancestor").includingMilliseconds, 100);
  projector.ingest([fact({ kind: "parent", sessionID: "ancestor", timestamp: 102,
    scope: { version: 1, sourceScope: "magic-session", reasons: ["hidden-metadata"] } })]);
  assert.equal(projector.totals("child").directMilliseconds, 0);
  assert.equal(projector.totals("ancestor").includingMilliseconds, 0);
  projector.setContext({ parentBySessionID: new Map([["child", "ancestor"]]) });
  assert.equal(projector.totals("child").directMilliseconds, 0);
  assert.equal(projector.totals("child", { replayCutoff: 50 }).directMilliseconds, 0);
});

test("context parent replacement restores event ancestry, and explicit tombstones override it", () => {
  const projector = createActivityProjector([execution("busy", 0, "child"), execution("completed", 100, "child"), fact(parent("child", "original", 101))]);
  projector.setContext({ parentBySessionID: new Map([["child", "external"]]) });
  assert.equal(projector.totals("original").includingMilliseconds, 0);
  assert.equal(projector.totals("external").includingMilliseconds, 100);
  projector.setContext({});
  assert.equal(projector.totals("original").includingMilliseconds, 100);
  assert.equal(projector.totals("external").includingMilliseconds, 0);
  projector.setContext({ parentBySessionID: new Map([["child", undefined]]) });
  assert.equal(projector.totals("original").includingMilliseconds, 0);
  assert.equal(projector.totals("child", { replayCutoff: 200 }).directMilliseconds, 100);
});

test("reused raw call IDs pair only within session, epoch, execution and owning step", () => {
  const facts = [execution("busy", 0),
    work("start", 0, true, { workID: "mc-step" }), work("end", 50, true, { workID: "mc-step" }),
    work("start", 50, false, { workID: "user-step" }), work("end", 100, false, { workID: "user-step" }),
    work("start", 10, false, { source: "tool", workID: "same-call", stepID: "mc-step" }),
    work("end", 30, false, { source: "tool", workID: "same-call", stepID: "mc-step" }),
    work("start", 60, false, { source: "tool", workID: "same-call", stepID: "user-step" }),
    work("end", 90, false, { source: "tool", workID: "same-call", stepID: "user-step" }), execution("completed", 100)];
  const sorted = [...facts].sort((a, b) => a.timestamp - b.timestamp);
  assert.equal(replayActivity(sorted).rootActiveMilliseconds.root, 50);
  assert.equal(createActivityProjector(sorted).totals("root").directMilliseconds, 50);
  assert.ok(sorted.every((event) => event.kind !== "work" || event.source !== "tool" || event.workID === "same-call"));
  for (const changes of [{ sessionID: "other" }, { executionID: "other" }, { instanceID: "other" }]) {
    const independent = facts.map((event) => ({ ...event, ...changes,
      ...(event.kind === "work" ? { measurementScope: { version: 1 as const, sourceScope: "user" as const, reasons: [] } } : {}) }));
    const all = [...facts, ...independent].sort((a, b) => a.timestamp - b.timestamp);
    const expected = "sessionID" in changes ? 50 : 100;
    assert.equal(replayActivity(all).timelines.get("root")?.activeMilliseconds, expected);
    assert.equal(createActivityProjector(all).totals("root").directMilliseconds, expected);
    if ("sessionID" in changes) assert.equal(createActivityProjector(all).totals("other").directMilliseconds, 100);
  }
});

test("tool boundaries without matching step identity never manufacture a cross-step work span", () => {
  const facts = [execution("busy", 0), work("start", 0, true), work("end", 100, true),
    work("start", 20, false, { source: "tool", workID: "call", stepID: "a" }),
    work("end", 80, false, { source: "tool", workID: "call", stepID: "b" }), execution("completed", 100)];
  for (const order of [facts, [...facts].reverse()]) {
    assert.equal(replayActivity(order).rootActiveMilliseconds.root, 0);
    assert.equal(createActivityProjector(order).totals("root").directMilliseconds, 0);
  }
  for (const phase of ["start", "end"] as const) {
    const partialIdentity = facts.map((event) => event.kind === "work" && event.source === "tool" && event.phase === phase
      ? { ...event, stepID: undefined } : event);
    assert.equal(replayActivity(partialIdentity).rootActiveMilliseconds.root, 0);
    assert.equal(createActivityProjector(partialIdentity).totals("root").directMilliseconds, 0);
  }
  const unknownStep = [execution("busy", 0), work("start", 10, false, { source: "tool", workID: "legacy-call" }),
    work("end", 40, false, { source: "tool", workID: "legacy-call" }), execution("completed", 50)];
  assert.equal(createActivityProjector(unknownStep).totals("root").directMilliseconds, 50);
});

test("complete execution correction retracts only its coverage and preserves overlapping normal child/tool", () => {
  const facts = [execution("busy", 0), work("start", 20, true), work("end", 80, true), execution("completed", 100),
    execution("busy", 0, "child", "normal-child"), execution("completed", 100, "child", "normal-child"), fact(parent("child", "root", 100))];
  const projector = createActivityProjector(facts);
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 40, includingMilliseconds: 100, active: false });
  projector.ingest([pure()]);
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 0, includingMilliseconds: 100, active: false });
  const lateNormal = [work("start", 30, false, { workID: "normal", source: "tool", stepID: "independent" }),
    work("end", 70, false, { workID: "normal", source: "tool", stepID: "independent" })];
  projector.ingest(lateNormal);
  // Known normal work invalidates the pure conclusion, retaining the edges and
  // overlapping normal tool, but the child's independent coverage stays intact.
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 80, includingMilliseconds: 100, active: false });
  assert.equal(replayActivity([...facts, pure(), ...lateNormal]).timelines.get("root")?.activeMilliseconds, 80);
});

test("cached coverage matches replay after every shuffled proof correction with overlapping fractional intervals", () => {
  const facts: ActivityEvent[] = [];
  for (let i = 0; i < 16; i++) {
    const sessionID = i % 3 === 0 ? "child" : "root", executionID = `e-${i}`, start = i * 5 - 30.5;
    facts.push(execution("busy", start, sessionID, executionID, 1),
      work("start", start + 1.25, true, { sessionID, executionID, workID: "mc", seq: 2 }),
      work("end", start + 15.75, true, { sessionID, executionID, workID: "mc", seq: 3 }),
      execution("completed", start + 20.5, sessionID, executionID, 4),
      fact({ kind: "execution-scope", sessionID, executionID, instanceID: "epoch", timestamp: start + 20.5, seq: 5,
        classification: "pure-maintenance", coverage: "complete" }));
    if (i % 4 === 0) facts.push(work("start", start + 5.5, false, { sessionID, executionID, source: "tool", workID: "call", stepID: "normal", seq: 6 }),
      work("end", start + 11.5, false, { sessionID, executionID, source: "tool", workID: "call", stepID: "normal", seq: 7 }));
  }
  let seed = 12345;
  for (let i = facts.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [facts[i], facts[j]] = [facts[j], facts[i]];
  }
  const observed = [fact(parent("child", "root", -100))];
  const projector = createActivityProjector(observed);
  for (const event of facts) {
    observed.push(event); projector.ingest([event]);
    const replay = replayActivity(observed);
    assert.deepEqual(projector.totals("root"), { directMilliseconds: replay.timelines.get("root")?.activeMilliseconds ?? 0,
      includingMilliseconds: replay.rootActiveMilliseconds.root ?? 0, active: false });
    assert.equal(projector.totals("child").directMilliseconds, replay.timelines.get("child")?.activeMilliseconds ?? 0);
  }
});

function projectionDifference(projector: ActivityProjector, observed: readonly ActivityEvent[], options: ActivityReplayOptions = {}) {
  const replay = replayActivity(observed, options);
  const belongs = (id: string): boolean => {
    const seen = new Set<string>();
    for (let current: string | undefined = id; current && !seen.has(current); current = replay.parentBySessionID.get(current)) {
      if (current === "root") return true;
      seen.add(current);
    }
    return false;
  };
  const expected = { directMilliseconds: replay.timelines.get("root")?.activeMilliseconds ?? 0,
    includingMilliseconds: calculateActiveMilliseconds(replay.participants.filter((item) => belongs(item.sessionID)).flatMap((item) => item.intervals)) };
  const { directMilliseconds, includingMilliseconds } = projector.totals("root", options);
  const actual = { directMilliseconds, includingMilliseconds };
  return directMilliseconds === expected.directMilliseconds && includingMilliseconds === expected.includingMilliseconds
    ? undefined : { options, actual, expected };
}

function pureWatermarkFacts(): ActivityEvent[] {
  return [execution("busy", 0, "root", "e", 1), work("end", 9.75, true, { seq: 3 }),
    fact({ kind: "execution-scope", sessionID: "root", executionID: "e", instanceID: "epoch", timestamp: 15.5, seq: 5,
      classification: "pure-maintenance", coverage: "complete" }),
    work("start", .25, true, { seq: 2 }), execution("completed", 15.5, "root", "e", 4)];
}

test("A2-01 five facts retain the sorted watermark after late MC boundary repair", () => {
  const projector = createActivityProjector(), observed: ActivityEvent[] = [];
  for (const event of pureWatermarkFacts()) {
    observed.push(event); projector.ingest([event]);
    for (const options of [{}, { replayCutoff: 9.75 }, { replayCutoff: 15.5 }, { replayCutoff: 100 }]) {
      assert.equal(projectionDifference(projector, observed, options), undefined, JSON.stringify({ event, options }));
    }
  }
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 0, includingMilliseconds: 0, active: false });
});

test("A2-01 every five-fact permutation, duplicates and SDK order differing from append order match replay", () => {
  function* permutations(items: ActivityEvent[]): Generator<ActivityEvent[]> {
    if (!items.length) { yield []; return; }
    for (let i = 0; i < items.length; i++) for (const rest of permutations(items.filter((_, j) => j !== i))) yield [items[i], ...rest];
  }
  for (const order of permutations(pureWatermarkFacts())) for (const sdkOrder of [false, true]) {
    const projector = createActivityProjector(), observed: ActivityEvent[] = [];
    for (let i = 0; i < order.length; i++) {
      const event = sdkOrder ? { ...order[i], sourceSequence: order[i].seq, seq: 1000 + i } : order[i];
      observed.push(event); projector.ingest([event]);
      for (const options of [{}, { replayCutoff: 5.5 }, { replayCutoff: 15.5 }, { replayCutoff: 100 }])
        assert.equal(projectionDifference(projector, observed, options), undefined, JSON.stringify({ sdkOrder, order, i, options }));
      projector.ingest([event]); // Exact duplicate cannot rewind the watermark.
      assert.equal(projectionDifference(projector, observed), undefined);
    }
    assert.equal(projector.totals("root").directMilliseconds, 0);
  }
});

test("A2-01 parent and context replacement never resurrect repaired pure execution coverage", () => {
  const observed = pureWatermarkFacts(), projector = createActivityProjector();
  for (const event of observed) { projector.ingest([event]); projector.totals("root"); }
  observed.push(execution("busy", 2, "child", "child-e", 10), execution("completed", 8, "child", "child-e", 11), fact(parent("child", "root", 16)));
  projector.ingest(observed.slice(5));
  const contexts = [{ parentBySessionID: new Map([["root", "outer"]]) },
    { sessionScopes: { root: classifySessionMetadata({ agent: "historian" }) } },
    { parentBySessionID: new Map([["child", undefined]]) }, {}];
  for (const context of contexts) {
    projector.setContext(context);
    for (const replayCutoff of [5.5, 15.5, 100]) assert.equal(projectionDifference(projector, observed, { ...context, replayCutoff }), undefined);
    assert.equal(projector.totals("root").directMilliseconds, 0);
  }
  assert.deepEqual(projector.totals("root"), { directMilliseconds: 0, includingMilliseconds: 6, active: false });
});

test("A2-01 bounded seeded boundary/proof differential reports a reduced failing arrival sequence", () => {
  const cutoffs = [{}, { replayCutoff: 5.5 }, { replayCutoff: 15.5 }, { replayCutoff: 100 }];
  const mismatch = (arrivals: ActivityEvent[]) => {
    const projector = createActivityProjector(), observed: ActivityEvent[] = [];
    for (let i = 0; i < arrivals.length; i++) {
      observed.push(arrivals[i]); projector.ingest([arrivals[i]]);
      for (const options of cutoffs) {
        const difference = projectionDifference(projector, observed, options);
        if (difference) return { prefix: i + 1, ...difference };
      }
    }
    return undefined;
  };
  for (let seed = 1; seed <= 48; seed++) {
    let random = seed;
    const next = () => random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const arrivals = [...pureWatermarkFacts(), work("end", 11.5, true, { workID: "second", seq: 7 }),
      work("start", 3.5, true, { workID: "second", seq: 6 }),
      execution("busy", 2, "child", "child-e", 1), execution("completed", 8, "child", "child-e", 2), fact(parent("child", "root", 16))];
    if (seed % 2 === 0) arrivals.push(work("end", 10, false, { source: "tool", workID: "normal", stepID: "other", seq: 9 }),
      work("start", 4, false, { source: "tool", workID: "normal", stepID: "other", seq: 8 }));
    for (let i = arrivals.length - 1; i > 0; i--) { const j = next() % (i + 1); [arrivals[i], arrivals[j]] = [arrivals[j], arrivals[i]]; }
    if (seed % 3 === 0) for (let i = 0; i < arrivals.length; i++) arrivals[i] = { ...arrivals[i], sourceSequence: arrivals[i].seq, seq: 1000 + i };
    arrivals.splice(next() % arrivals.length, 0, arrivals[next() % arrivals.length]);
    const failure = mismatch(arrivals);
    if (!failure) continue;
    let reduced = arrivals.slice(0, failure.prefix), changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < reduced.length; i++) {
        const candidate = reduced.filter((_, j) => i !== j);
        if (mismatch(candidate)) { reduced = candidate; changed = true; break; }
      }
    }
    assert.fail(JSON.stringify({ seed, originalFailure: failure, reducedFailure: mismatch(reduced), reducedArrivals: reduced }));
  }
});
