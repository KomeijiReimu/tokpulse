import assert from "node:assert/strict";
import test from "node:test";
import { activityProjectionDiagnostics, calculateActiveMilliseconds, createActivityProjector, normalizeActivityEvent, replayActivity,
  type ActivityEvent, type ActivityEventInput, type ActivityProjector, type ActivityReplayOptions, type ActivityStreamKey } from "../src/activity.js";
import { classifySessionMetadata } from "../src/scope.js";

const key = { sessionID: "root", instanceID: "epoch", executionID: "e" } satisfies ActivityStreamKey;
const fact = (input: ActivityEventInput): ActivityEvent => normalizeActivityEvent(input)!;
const life = (state: "busy" | "retry" | "completed", timestamp: number, overrides: Partial<ActivityEventInput> = {}): ActivityEvent =>
  fact({ ...key, kind: "lifecycle", state, timestamp, seq: timestamp, ...overrides } as ActivityEventInput);
function check(projector: ActivityProjector, selected: readonly ActivityEvent[], options: ActivityReplayOptions = {}, ids = ["root", "child", "a", "b"]) {
  const replay = replayActivity(selected, options);
  for (const id of ids) {
    const belongs = (child: string): boolean => {
      const seen = new Set<string>();
      let current: string | undefined = child;
      while (current && !seen.has(current)) {
        if (current === id) return true;
        seen.add(current); current = replay.parentBySessionID.get(current);
      }
      return false;
    };
    const actual = projector.totals(id, options);
    assert.equal(actual.directMilliseconds, replay.timelines.get(id)?.activeMilliseconds ?? 0, `${id} direct ${JSON.stringify(options)}`);
    assert.equal(actual.includingMilliseconds, calculateActiveMilliseconds(replay.participants.filter((item) => belongs(item.sessionID)).flatMap((item) => item.intervals)), `${id} including`);
  }
}

test("visibility toggles cached intervals and active tails; hidden streams still ingest MC/normal corrections", () => {
  const own = [life("busy", 0), life("retry", 5)], child = [life("busy", 2, { sessionID: "child", executionID: "child-e" }),
    life("completed", 12, { sessionID: "child", executionID: "child-e" }), fact({ kind: "parent", sessionID: "child", timestamp: 0, parentSessionID: "root" })];
  const projector = createActivityProjector([...own, ...child]);
  check(projector, [...own, ...child], { trustedCurrentInstanceID: "epoch", replayCutoff: 10 });
  const before = activityProjectionDiagnostics(projector);
  projector.updateStreams([{ key, mode: "hidden" }]);
  check(projector, child, { trustedCurrentInstanceID: "epoch", replayCutoff: 10 });
  const work = (phase: "start" | "end", timestamp: number, seq: number) => fact({ ...key, kind: "work", workID: "mc", source: "step", phase, timestamp, seq,
    measurementScope: { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] } });
  const late = [work("end", 4, 8), work("start", 1, 7), life("completed", 10, { seq: 9 })];
  projector.ingest(late);
  check(projector, child, { replayCutoff: 100 });
  const afterIngest = activityProjectionDiagnostics(projector);
  projector.updateStreams([{ key, mode: "visible" }]);
  const afterShow = activityProjectionDiagnostics(projector);
  assert.equal(afterShow.coldFactVisits, afterIngest.coldFactVisits);
  assert.equal(afterShow.workFactVisits, afterIngest.workFactVisits);
  assert.equal(afterShow.factVisits, afterIngest.factVisits);
  assert.equal(afterShow.identityVisits, afterIngest.identityVisits);
  for (const replayCutoff of [3, 8, 100]) check(projector, [...own, ...late, ...child], { replayCutoff });
  assert.ok(afterIngest.ingested > before.ingested);
  projector.updateStreams([{ key, mode: "hidden" }, { key, mode: "visible" }]);
  check(projector, [...own, ...late, ...child]);
});

test("empty replace retires identities; ordinary late replay cannot restore, explicit replace remains hidden until visible", () => {
  const events = [life("busy", 0), life("completed", 10)], projector = createActivityProjector(events);
  assert.equal(projector.totals("root").directMilliseconds, 10);
  const before = activityProjectionDiagnostics(projector);
  projector.updateStreams([{ key, mode: "replace", events: [] }]);
  assert.equal(activityProjectionDiagnostics(projector).identityVisits - before.identityVisits, 2);
  projector.ingest(events);
  assert.equal(activityProjectionDiagnostics(projector).ingested, before.ingested);
  assert.equal(projector.totals("root", { replayCutoff: 5 }).includingMilliseconds, 0);
  assert.equal(projector.totals("root").directMilliseconds, 0);
  projector.updateStreams([{ key, mode: "replace", events }]);
  assert.equal(projector.totals("root").directMilliseconds, 0);
  projector.updateStreams([{ key, mode: "visible" }]);
  check(projector, events);
  projector.updateStreams([{ key, mode: "replace", events: [] }, { key, mode: "visible" }]);
  assert.equal(projector.totals("root").directMilliseconds, 0);
  projector.ingest(events); // Explicit visible permits future re-admission only.
  check(projector, events);
});

test("retiring a newer execution or observation epoch cannot revive the older execution's unknown gap", () => {
  const older = [life("busy", 0, { executionID: "old", seq: 1 }), life("retry", 3, { executionID: "old", seq: 2 })];
  const newer = life("busy", 100, { executionID: "new", seq: 3 }), projector = createActivityProjector([...older, newer]);
  projector.updateStreams([{ key: { ...key, executionID: "new" }, mode: "replace", events: [] }]);
  assert.deepEqual(projector.totals("root", { trustedCurrentInstanceID: "epoch", replayCutoff: 1000 }), { directMilliseconds: 3, includingMilliseconds: 3, active: false });
  projector.ingest([newer]);
  assert.equal(projector.totals("root", { trustedCurrentInstanceID: "epoch", replayCutoff: 2000 }).directMilliseconds, 3);
  for (const replayCutoff of [2, 5, 50, 100, 1000]) assert.equal(projector.totals("root", { trustedCurrentInstanceID: "epoch", replayCutoff }).directMilliseconds, Math.min(3, replayCutoff));
  projector.updateStreams([{ key: { ...key, executionID: "old" }, mode: "hidden" }, { key: { ...key, executionID: "old" }, mode: "visible" }]);
  assert.equal(projector.totals("root", { trustedCurrentInstanceID: "epoch", replayCutoff: 2000 }).directMilliseconds, 3);
});

test("whole update batch is validated before selection, identities, metadata or facts can change", () => {
  const events = [life("busy", 0), life("completed", 10)], projector = createActivityProjector(events);
  const before = projector.totals("root");
  assert.throws(() => projector.updateStreams([{ key, mode: "hidden" }, { key, mode: "replace", events: [life("busy", 0, { sessionID: "wrong" })] }]), TypeError);
  assert.deepEqual(projector.totals("root"), before);
  projector.ingest(events);
  assert.equal(activityProjectionDiagnostics(projector).ingested, 2);
  assert.throws(() => projector.patchContext({ parents: new Map([["root", "a"]]),
    sessionScopes: new Map([["root", { version: 999 } as never]]) }), TypeError);
  assert.deepEqual(projector.totals("root"), before);
  assert.equal(projector.totals("a").includingMilliseconds, 0);
});

test("stream selection uses complete collision-safe keys, including execution and special raw IDs", () => {
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

test("parent/context patches move cached coverage, explicit root detaches, undefined restores facts, fact scope survives", () => {
  const events = [life("busy", 0, { sessionID: "child" }), life("completed", 10, { sessionID: "child" }),
    fact({ kind: "parent", sessionID: "child", parentSessionID: "a", timestamp: 20 })];
  const projector = createActivityProjector(events);
  check(projector, events);
  const before = activityProjectionDiagnostics(projector);
  const parents = new Map<string, string | null | undefined>();
  for (const value of ["b", null, undefined, "a"] as const) {
    projector.patchContext({ parents: new Map([["child", value]]) });
    if (value === undefined) parents.delete("child"); else parents.set("child", value);
    check(projector, events, { parentBySessionID: parents });
  }
  const scope = classifySessionMetadata({ agent: "historian" });
  projector.patchContext({ sessionScopes: new Map([["b", scope]]), parents: new Map([["child", "b"]]) });
  assert.equal(projector.totals("child").directMilliseconds, 0);
  projector.patchContext({ parents: new Map([["child", null]]) });
  assert.equal(projector.totals("child").directMilliseconds, 10);
  projector.patchContext({ parents: new Map([["child", undefined]]), sessionScopes: new Map([["b", undefined]]) });
  check(projector, events);
  const factProof = life("completed", 30, { sessionID: "a", scope });
  projector.ingest([factProof]);
  projector.patchContext({ sessionScopes: new Map([["a", undefined]]) });
  assert.equal(projector.totals("child").directMilliseconds, 0);
  assert.equal(activityProjectionDiagnostics(projector).coldFactVisits, before.coldFactVisits);
});

test("ordinary parent and whole-session proof facts repair only necessary cached views, including cycles", () => {
  const events = [life("busy", 0, { sessionID: "child" }), life("completed", 10, { sessionID: "child" })];
  const projector = createActivityProjector(events);
  for (const parentSessionID of ["a", "b", "child", undefined, "a"]) {
    const event = fact({ kind: "parent", sessionID: "child", parentSessionID, timestamp: events.length + 30 });
    events.push(event); projector.ingest([event]); check(projector, events);
  }
  const scope = classifySessionMetadata({ agent: "historian" });
  const proof = life("completed", 100, { sessionID: "a", scope }); events.push(proof); projector.ingest([proof]);
  check(projector, events);
});

test("stream selection performance: 1k/2k/4k same-SID executions reuse closed coverage without fact replay", () => {
  const rows: Array<Record<string, string | number>> = [];
  for (const mode of ["normal", "mixed", "pure"] as const) for (const size of [1000, 2000, 4000]) {
    const projector = createActivityProjector(), start = performance.now();
    for (let i = 0; i < size; i++) {
      const at = i * 4, selected = { ...key, executionID: `e-${i}` };
      const events = [life("busy", at, { ...selected, seq: 0 })];
      if (mode !== "normal") for (const [phase, timestamp, seq] of [["start", at + .25, 1], ["end", at + 1.75, 2]] as const)
        events.push(fact({ ...selected, kind: "work", source: "step", workID: "mc", phase, timestamp, seq,
          measurementScope: { version: 1, sourceScope: "magic-message", reasons: ["magic-model"] } }));
      events.push(life("completed", at + 2, { ...selected, seq: 3 }));
      if (mode === "pure") events.push(fact({ ...selected, kind: "execution-scope", timestamp: at + 2, seq: 4, classification: "pure-maintenance", coverage: "complete" }));
      projector.ingest(events);
      const expected = (i + 1) * (mode === "normal" ? 2 : mode === "mixed" ? .5 : 0);
      assert.equal(projector.totals("root").directMilliseconds, expected);
      const before = activityProjectionDiagnostics(projector);
      projector.updateStreams([{ key: selected, mode: "hidden" }, { key: selected, mode: "visible" }]);
      const after = activityProjectionDiagnostics(projector);
      assert.equal(after.factVisits, before.factVisits); assert.equal(after.coldFactVisits, before.coldFactVisits);
      assert.equal(after.workFactVisits, before.workFactVisits); assert.equal(after.identityVisits, before.identityVisits);
      assert.equal(projector.totals("root").directMilliseconds, expected);
    }
    const counts = activityProjectionDiagnostics(projector);
    assert.equal(counts.indexStreamVisits, 0); assert.ok(counts.factVisits < size * 30);
    assert.ok(counts.nodeVisits < size * 100, JSON.stringify({ mode, size, ...counts })); assert.ok(counts.indexNodeVisits < size * 10000, JSON.stringify({ mode, size, ...counts }));
    rows.push({ mode, size, ms: +(performance.now() - start).toFixed(2), ...counts });
  }
  console.log("projector selected execution benchmark", JSON.stringify(rows));
});

test("context patch performance: wide/deep/cycle 1k/2k/4k edits do not reparse or replay stream facts", () => {
  const rows: Array<Record<string, string | number>> = [];
  for (const shape of ["wide", "deep", "cycle"] as const) for (const size of [1000, 2000, 4000]) {
    const projector = createActivityProjector(), parents = new Map<string, string | null | undefined>();
    // Only the deepest leaf has time. The matrix measures real topology cost,
    // including the full-chain/cycle context traversal, without N live tails.
    for (let i = 1; i < size; i++) parents.set(`s-${i}`, shape === "wide" ? "s-0" : `s-${i - 1}`);
    if (shape === "cycle") parents.set("s-0", `s-${size - 1}`);
    const start = performance.now();
    projector.patchContext({ parents });
    const events = [life("busy", 0, { sessionID: `s-${size - 1}` }), life("completed", 10, { sessionID: `s-${size - 1}` })];
    projector.ingest(events);
    assert.equal(projector.totals("s-0").includingMilliseconds, 10);
    const before = activityProjectionDiagnostics(projector);
    const scope = classifySessionMetadata({ agent: "historian" });
    projector.patchContext({ sessionScopes: new Map([["s-0", scope]]) });
    assert.equal(projector.totals("s-0").includingMilliseconds, 0);
    projector.patchContext({ sessionScopes: new Map([["s-0", undefined]]) });
    assert.equal(projector.totals("s-0").includingMilliseconds, 10);
    projector.patchContext({ parents: new Map([[`s-${size - 1}`, null]]) });
    assert.equal(projector.totals("s-0").includingMilliseconds, 0);
    projector.patchContext({ parents: new Map([[`s-${size - 1}`, shape === "wide" ? "s-0" : `s-${size - 2}`]]) });
    assert.equal(projector.totals("s-0").includingMilliseconds, 10);
    const after = activityProjectionDiagnostics(projector);
    assert.equal(after.factVisits, before.factVisits); assert.equal(after.coldFactVisits, before.coldFactVisits);
    assert.equal(after.identityVisits, before.identityVisits); assert.equal(after.workFactVisits, before.workFactVisits);
    assert.equal(after.indexStreamVisits, 0);
    assert.ok(after.nodeVisits <= size * 60 + 100);
    assert.ok(after.ancestorVisits <= size * 25 + 100);
    assert.ok(after.contextNodeVisits <= size * 30 + 100);
    rows.push({ shape, size, ms: +(performance.now() - start).toFixed(2), ...after });
  }
  console.log("projector local context benchmark", JSON.stringify(rows));
});

test("long-execution 1k/2k/4k normal mixed pure steps increment spans and live coverage without prefix replay", () => {
  const rows: Array<Record<string, string | number>> = [];
  for (const mode of ["normal", "mixed", "pure"] as const) for (const size of [1000, 2000, 4000]) {
    const projector = createActivityProjector([life("busy", 0, { seq: 0 })]), start = performance.now();
    for (let i = 0; i < size; i++) {
      const maintenance = mode === "pure" || (mode === "mixed" && i % 2 === 0);
      const base = { ...key, kind: "work" as const, source: "step" as const, workID: `step-${i}`,
        measurementScope: { version: 1 as const, sourceScope: maintenance ? "magic-message" as const : "user" as const, reasons: [] } };
      projector.ingest([fact({ ...base, phase: "start" as const, timestamp: i * 2, seq: i * 2 + 1 }), fact({ ...base, phase: "end" as const, timestamp: i * 2 + 1, seq: i * 2 + 2 })]);
      projector.totals("root", { trustedCurrentInstanceID: "epoch", replayCutoff: i * 2 + 1 });
    }
    const scans = activityProjectionDiagnostics(projector).workFactVisits;
    assert.equal(scans, size * 2, "each ordered work fact enters the span cache once");
    assert.ok(activityProjectionDiagnostics(projector).workSpanVisits <= size * 4, "changed span only, not every previous work span");
    projector.ingest([life("completed", size * 2, { seq: size * 2 + 1 })]);
    if (mode === "pure") projector.ingest([fact({ ...key, kind: "execution-scope", timestamp: size * 2, seq: size * 2 + 2, classification: "pure-maintenance", coverage: "complete" })]);
    assert.equal(projector.totals("root").directMilliseconds, mode === "pure" ? 0 : size * 2 - (mode === "mixed" ? Math.ceil(size / 2) : 0));
    const counts = activityProjectionDiagnostics(projector);
    assert.ok(counts.workFactVisits <= size * 7 + 20);
    assert.ok(counts.workSpanVisits <= size * 12 + 20);
    assert.ok(counts.intervalMaterializations <= size * 100 + 100);
    assert.ok(counts.intervalSortComparisons <= size * 100 + 100);
    assert.ok(counts.indexNodeVisits <= size * 4000 + 100);
    rows.push({ mode, size, ms: +(performance.now() - start).toFixed(2), workFactVisitsBeforeTerminal: scans, ...activityProjectionDiagnostics(projector) });
  }
  for (const mode of ["normal", "mixed", "pure"]) {
    const group = rows.filter((row) => row.mode === mode);
    for (let i = 1; i < group.length; i++) assert.ok(Number(group[i].indexNodeVisits) < Number(group[i - 1].indexNodeVisits) * 3,
      `doubling a long execution must not quadruple real coverage work: ${JSON.stringify(group)}`);
  }
  console.log("incremental single execution benchmark", JSON.stringify(rows));
});

test("seeded local stream/context updates match independent selected-facts replay after every operation", () => {
  for (let seed = 1; seed <= 32; seed++) {
    let random = seed;
    const next = () => random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const ids = ["root", "child", "a", "b"], projector = createActivityProjector();
    const states = new Map<string, { key: ActivityStreamKey; facts: ActivityEvent[]; hidden: boolean; retired: boolean }>();
    for (let i = 0; i < 8; i++) {
      const selected = { ...key, sessionID: ids[i % ids.length], executionID: `e-${i}` };
      const facts = [life("busy", i * 2, { ...selected, seq: 1 }), life("completed", i * 2 + 5, { ...selected, seq: 4 })];
      if (i % 2) facts.splice(1, 0, ...(["start", "end"] as const).map((phase, j) => fact({ ...selected, kind: "work", source: "step", workID: "mc",
        phase, timestamp: i * 2 + j + 1, seq: j + 2, measurementScope: { version: 1, sourceScope: "magic-message", reasons: [] } })));
      projector.ingest(facts); states.set(selected.executionID, { key: selected, facts, hidden: false, retired: false });
    }
    const parents = new Map<string, string | null | undefined>();
    const scopes: Record<string, ReturnType<typeof classifySessionMetadata>> = Object.create(null);
    for (let step = 0; step < 40; step++) {
      const state = states.get(`e-${next() % 8}`)!, mode = next() % 5;
      if (mode <= 1) {
        state.hidden = mode === 0;
        if (!state.hidden) state.retired = false;
        projector.updateStreams([{ key: state.key, mode: state.hidden ? "hidden" : "visible" }]);
      } else if (mode === 2) {
        const id = ids[next() % ids.length], value = next() % 3 === 0 ? null : ids[next() % ids.length];
        parents.set(id, value); projector.patchContext({ parents: new Map([[id, value]]) });
      } else if (mode === 3) {
        const id = ids[next() % ids.length], proof = next() % 2 ? classifySessionMetadata({ agent: "historian" }) : undefined;
        if (proof) scopes[id] = proof; else delete scopes[id];
        projector.patchContext({ sessionScopes: new Map([[id, proof]]) });
      } else {
        if (!state.retired) {
          state.facts = []; state.hidden = true; state.retired = true;
          projector.updateStreams([{ key: state.key, mode: "replace", events: [] }]);
        } else {
          state.retired = false;
          state.facts = [life("busy", step * 2, { ...state.key, seq: 1 }), life("completed", step * 2 + 3, { ...state.key, seq: 2 })];
          projector.updateStreams([{ key: state.key, mode: "replace", events: state.facts }]);
        }
      }
      const selected = [...states.values()].filter((state) => !state.hidden && !state.retired).flatMap((state) => state.facts);
      try { check(projector, selected, { parentBySessionID: parents, sessionScopes: scopes }, ids); }
      catch (error) { assert.fail(`seed=${seed} step=${step} mode=${mode} state=${JSON.stringify([...states])} parents=${JSON.stringify([...parents])} scopes=${JSON.stringify(scopes)} error=${error}`); }
    }
  }
});
