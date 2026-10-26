import assert from "node:assert/strict";
import test from "node:test";
import type { OpenContribution, SessionDirectTotals, TotalsLedger } from "../src/totals-storage.js";
import { createTotalsRollupIndex, type TotalsRollup } from "../src/totals-aggregate.js";
import { classifyMessageMetadata, classifySessionMetadata, type SessionScopes } from "../src/scope.js";
import { mergeTotalsSources } from "../src/source-ledgers.js";
import { addSpeedTotals, emptySpeedTotals, GENERATION_BASIS_VERSION, updateSpeedTotals } from "../src/statistics.js";

function rollupSessionTotals(...args: Parameters<typeof import("../src/totals-aggregate.js").rollupSessionTotals>): TotalsRollup {
  return createTotalsRollupIndex(args[0], args[1], args[3]).get(args[2]);
}

test("every direct and including rollup filters MC descendants without changing exact user sums", () => {
  const root = usage(1);
  const real = usage(10);
  const sessions = { root, real, mc: usage(100), grand: usage(1000) };
  const parents = { real: "root", mc: "root", grand: "mc" };
  const scopes = { mc: classifySessionMetadata({ agent: "dreamer" }) };
  const actual = rollupSessionTotals(sessions, parents, "root", scopes);
  assert.equal(actual.including.tokens.input, 11);
  assert.equal(actual.including.cost, 11);
  assert.equal(actual.including.responseCount, 2);
  assert.deepEqual(rollupSessionTotals(sessions, parents, "mc", scopes), { direct: zero(), including: zero(), children: [] });
  assert.deepEqual(rollupSessionTotals(sessions, parents, "grand", scopes).direct, zero());
  assert.equal(sessions.mc.tokens.input, 100);
});

test("scope inheritance through a cycle safely filters every rollup entry", () => {
  const result = rollupSessionTotals({ a: usage(1), b: usage(10) }, { a: "b", b: "a" }, "a", { b: classifySessionMetadata({ agent: "historian" }) });
  assert.deepEqual(result, { direct: zero(), including: zero(), children: [] });
});

test("message-only maintenance proof preserves ordinary session and child usage", () => {
  const sessions = { root: usage(1), child: usage(10), grand: usage(100) };
  const parents = { child: "root", grand: "child" };
  const actual = rollupSessionTotals(sessions, parents, "root", { root: classifyMessageMetadata({ agent: "historian" }) });
  assert.equal(actual.direct.tokens.input, 1);
  assert.equal(actual.including.responseCount, 3);
  assert.equal(actual.including.tokens.input, 111);
  assert.equal(actual.including.cost, 111);
});

test("includes descendants when the parent session itself is absent", () => {
  const grand = usage(5);
  const result = rollupSessionTotals(
    { grand },
    { child: "root", grand: "child" },
    "root",
  );

  assert.deepEqual(result.direct, zero());
  assert.deepEqual(result.including, grand);
  assert.deepEqual(result.children.map((entry) => entry.sessionID), ["child"]);
  assert.deepEqual(result.children[0]?.direct, zero());
  assert.deepEqual(result.children[0]?.including, grand);
});

test("counts a grandchild once and does not list it as a root child", () => {
  const result = rollupSessionTotals(
    { root: usage(1), child: usage(10), grand: usage(100) },
    { child: "root", grand: "child" },
    "root",
  );

  assert.deepEqual(result.direct, usage(1));
  assert.deepEqual(result.children.map((entry) => entry.sessionID), ["child"]);
  assert.deepEqual(result.children[0]?.direct, usage(10));
  assert.deepEqual(result.children[0]?.including, {
    tokens: { input: 110, output: 112, reasoning: 114, cacheRead: 116, cacheWrite: 118 },
    cost: 110,
    responseCount: 2,
  });
  assert.deepEqual(result.including, {
    tokens: { input: 111, output: 114, reasoning: 117, cacheRead: 120, cacheWrite: 123 },
    cost: 111,
    responseCount: 3,
  });
});

test("counts each session once when parent links cycle", () => {
  const parents = new Map<string, string | null | undefined>([
    ["b", "a"],
    ["c", "b"],
    ["a", "c"],
  ]);
  const result = rollupSessionTotals(
    { a: usage(1), b: usage(10), c: usage(100) },
    parents,
    "a",
  );

  const once = {
    tokens: { input: 111, output: 114, reasoning: 117, cacheRead: 120, cacheWrite: 123 },
    cost: 111,
    responseCount: 3,
  };
  assert.deepEqual(result.direct, usage(1));
  assert.deepEqual(result.including, once);
  assert.deepEqual(result.children.map((entry) => entry.sessionID), ["b"]);
  assert.deepEqual(result.children[0]?.direct, usage(10));
  assert.deepEqual(result.children[0]?.including, once);
});

test("does not add unrelated siblings or sessions without a parent", () => {
  const result = rollupSessionTotals(
    {
      root: usage(1),
      child: usage(10),
      sibling: usage(100),
      loose: usage(1_000),
      unnamed: usage(10_000),
      loop: usage(100_000),
    },
    {
      child: "root",
      sibling: "other",
      loose: null,
      unnamed: "",
      loop: "loop",
      root: "root",
    },
    "root",
  );

  assert.deepEqual(result.direct, usage(1));
  assert.deepEqual(result.children.map((entry) => entry.sessionID), ["child"]);
  assert.equal(result.including.tokens.input, 11);
  assert.equal(result.including.tokens.output, 13);
  assert.equal(result.including.cost, 11);
  assert.equal(result.including.responseCount, 2);
});

test("lists direct children in localeCompare order and keeps mapped children with no usage", () => {
  const result = rollupSessionTotals(
    { root: usage(1), b: usage(10) },
    { m: "root", a: "root", b: "root", grand: "b" },
    "root",
  );

  assert.deepEqual(result.children.map((entry) => entry.sessionID), ["a", "b", "m"]);
  assert.deepEqual(result.children[0]?.direct, zero());
  assert.deepEqual(result.children[0]?.including, zero());
  assert.deepEqual(result.children[2]?.direct, zero());
  assert.equal(result.including.tokens.input, 11);
  assert.equal(result.children.some((entry) => entry.sessionID === "grand"), false);
});

function usage(seed: number): SessionDirectTotals {
  return {
    tokens: {
      input: seed,
      output: seed + 1,
      reasoning: seed + 2,
      cacheRead: seed + 3,
      cacheWrite: seed + 4,
    },
    cost: seed,
    responseCount: 1,
  };
}

function zero(): SessionDirectTotals {
  return {
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    responseCount: 0,
  };
}

test("snapshot isolates legacy speed fields and returns independently mutable token totals and child lists", () => {
  const sessions = { root: usage(1), child: usage(2) };
  sessions.child.speed = {
    generation: { generatedTokens: 0, durationMs: 0, responseCount: 0, estimatedResponseCount: 0 },
    response: { generatedTokens: 8, durationMs: 200, responseCount: 1, estimatedResponseCount: 0 },
  };
  const parents = new Map<string, string | null | undefined>([["child", "root"]]);
  const scopes: Record<string, SessionScopes[string]> = {};
  const index = createTotalsRollupIndex(sessions, parents, scopes), expected = structuredClone(index.get("root"));
  assert.equal(expected.including.tokens.input, 3, "legacy speed fields must not change token totals");
  assert.equal(expected.including.cost, 3);
  assert.equal(expected.including.responseCount, 2);
  const changed = index.get("root");
  changed.direct.tokens.input = 999; changed.including.cost = 999;
  changed.children[0].including.speed!.response.generatedTokens = 999;
  changed.children[0].direct.tokens.output = 999; changed.children.length = 0;
  assert.deepEqual(index.get("root"), expected);
  assert.equal(sessions.root.tokens.input, 1); assert.equal(sessions.child.speed!.response.generatedTokens, 8);
  parents.set("child", "elsewhere"); sessions.child.cost = 999; sessions.child.speed!.response.generatedTokens = 999;
  scopes.root = classifySessionMetadata({ agent: "historian" });
  assert.deepEqual(index.get("root"), expected, "same mutable input identity must not mutate an existing snapshot");
  assert.deepEqual(createTotalsRollupIndex(sessions, parents, scopes).get("root"), { direct: zero(), including: zero(), children: [] });
});

test("cycle with special IDs, branches and a ledger-only intermediary counts each eligible source once", () => {
  const sessions = { ["__proto__"]: usage(1), constructor: usage(2), grand: usage(4), other: usage(8), excluded: usage(16) };
  const parents = new Map([["__proto__", "constructor"], ["constructor", "__proto__"], ["missing", "__proto__"], ["grand", "missing"], ["other", "constructor"], ["excluded", "other"]]);
  const scopes = { excluded: classifySessionMetadata({ agent: "historian" }) };
  const index = createTotalsRollupIndex(sessions, parents, scopes);
  assert.equal(index.get("__proto__").including.cost, 15);
  assert.equal(index.get("constructor").including.cost, 15);
  assert.equal(index.get("__proto__").including.responseCount, 4);
  assert.equal(index.get("missing").including.cost, 4);
  assert.deepEqual(index.get("excluded"), { direct: zero(), including: zero(), children: [] });
});

test("moved session unions durable totals, corrects copied messages once and refuses only overlapping legacy markers", () => {
  const sessionID = "__proto__";
  const proof = classifyMessageMetadata({ agent: "historian" });
  const copied: OpenContribution = {
    sessionID, quality: "exact", tokens: usage(10).tokens, cost: 10,
    speed: { response: { generatedTokens: 23, durationMs: 200, estimated: false } },
    update: { source: "live", instanceID: "server", sequence: 1, receivedAt: 100, revision: 1, fingerprint: "old", seenFingerprints: [] },
  };
  const corrected: OpenContribution = {
    ...copied, tokens: zero().tokens, cost: 0,
    speed: { response: { generatedTokens: 0, durationMs: 100, estimated: false } },
    update: { ...copied.update!, sequence: 2, receivedAt: 200, revision: 2, fingerprint: "zero", seenFingerprints: ["old"] },
  };
  const removed: OpenContribution = { ...copied, tokens: usage(20).tokens, cost: 20 };
  const exact: OpenContribution = { ...copied, tokens: usage(30).tokens, cost: 30, speedBackfill: { version: 1, source: "server" } };
  const provisional: OpenContribution = {
    ...copied, quality: "provisional", tokens: usage(90).tokens, cost: 90,
    update: { ...corrected.update!, sequence: 3, revision: 3, fingerprint: "provisional" },
  };
  const oldTotals = usage(100);
  oldTotals.responseCount = 10; // Cropped historical prefix has no message snapshots.
  oldTotals.speed = emptySpeedTotals();
  oldTotals.speed.response = { generatedTokens: 500, durationMs: 5_000, responseCount: 10, estimatedResponseCount: 0 };
  oldTotals.speed.generation = { generatedTokens: 999, durationMs: 999, responseCount: 1, estimatedResponseCount: 0 };
  for (const contribution of [copied, removed, exact]) {
    for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) oldTotals.tokens[field] += contribution.tokens[field];
    oldTotals.cost += contribution.cost;
    oldTotals.responseCount++;
    oldTotals.speed = updateSpeedTotals(oldTotals.speed, contribution.speed, 1);
  }
  const newTotals = usage(7);
  for (const contribution of [corrected, provisional]) {
    for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) newTotals.tokens[field] += contribution.tokens[field];
    newTotals.cost += contribution.cost;
    newTotals.responseCount++;
    newTotals.speed = updateSpeedTotals(newTotals.speed, contribution.speed, 1);
  }
  const before: TotalsLedger = {
    version: 1, sessions: { [sessionID]: oldTotals },
    open: { constructor: copied, removed, exact }, settled: { "prefix-legacy": true },
    sessionScopes: { [sessionID]: classifySessionMetadata({ agent: "normal" }) },
    sessionAgents: { [sessionID]: [" worker ", "old"] },
  };
  const after: TotalsLedger = {
    version: 1, generationBasisVersion: GENERATION_BASIS_VERSION, sessions: { [sessionID]: newTotals },
    open: { exact: provisional }, settled: { constructor: corrected, removed: { ...removed, excluded: proof } },
    sessionScopes: { [sessionID]: classifySessionMetadata({ agent: "normal", parentID: "parent" }) },
    sessionAgents: { [sessionID]: ["worker", "new", "compaction"] },
    messageScopes: { "local-legacy": proof },
  };
  after.settled["local-legacy"] = true;
  const originals = structuredClone([before, after]);
  const merged = mergeTotalsSources([before, after]);
  const expected = usage(100);
  expected.cost += 7 + 30;
  expected.responseCount = 10 + 1 + 1 + 1;
  for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) expected.tokens[field] += usage(7).tokens[field] + exact.tokens[field];
  expected.speed = emptySpeedTotals();
  expected.speed.response = { generatedTokens: 500, durationMs: 5_000, responseCount: 10, estimatedResponseCount: 0 };
  expected.speed = updateSpeedTotals(updateSpeedTotals(expected.speed, corrected.speed, 1), exact.speed, 1);
  // Normalize optional legacy coverage counters using the same accumulator API.
  expected.speed = addSpeedTotals(undefined, expected.speed);
  assert.deepEqual(merged.sessions[sessionID], expected);
  assert.deepEqual(merged.settled["constructor"], corrected, "explicit zero correction replaces the older larger copy");
  assert.equal(merged.open.exact.quality, "exact", "a newer provisional copy cannot replace exact usage");
  assert.deepEqual(merged.settled.removed, { ...removed, excluded: proof });
  assert.equal(merged.settled["prefix-legacy"], true);
  assert.equal(merged.settled["local-legacy"], true);
  assert.deepEqual(merged.sessionAgents?.[sessionID], ["new", "old", "worker"]);
  assert.equal(merged.sessionScopes?.[sessionID].parentSessionID, "parent");
  assert.deepEqual(merged.messageScopes?.["local-legacy"], proof);
  assert.equal(Object.getPrototypeOf(merged.sessions), null);
  assert.equal(Object.getPrototypeOf(merged.settled), null);
  assert.deepEqual([before, after], originals, "read-only projection must not mutate either physical source");
  assert.deepEqual(mergeTotalsSources([after, before]).open.exact, exact, "exact usage also wins when the sources are reversed");
  assert.deepEqual(mergeTotalsSources([after, before]).sessions, merged.sessions, "baseline, correction and exclusion totals are independent of source order");
  assert.deepEqual(mergeTotalsSources([after, before]).settled.removed, merged.settled.removed);
  const staleCopies: TotalsLedger = {
    ...after,
    open: { exact: { ...provisional, quality: "exact", update: undefined } },
    settled: { ...after.settled, constructor: { ...corrected, update: undefined } },
  };
  const protectedMerge = mergeTotalsSources([before, staleCopies]);
  assert.deepEqual(protectedMerge.open.exact, exact, "history without a live update cannot replace server speed backfill");
  assert.deepEqual(protectedMerge.open["constructor"], copied, "history without an update cannot overwrite an existing same-quality live update");
  assert.deepEqual(mergeTotalsSources([staleCopies, before]).open, protectedMerge.open);
  const exclusions = [removed, corrected].map((contribution): TotalsLedger => ({
    version: 1, sessions: {}, open: {},
    settled: { removed: { ...contribution, update: undefined, excluded: proof } },
  }));
  const excludedMerge = mergeTotalsSources(exclusions);
  assert.deepEqual(mergeTotalsSources([...exclusions].reverse()), excludedMerge);
  assert.deepEqual(Object.keys(excludedMerge.sessions), [], "excluded copies contribute zero regardless of their old amounts");
  assert.strictEqual(mergeTotalsSources([before]), before, "unchanged single-source sessions stay zero-copy");
  assert.deepEqual(Object.keys(mergeTotalsSources([]).sessions), []);
  const legacyOverlap: TotalsLedger = { version: 1, sessions: {}, open: {}, settled: { ["constructor"]: true as const } };
  assert.strictEqual(mergeTotalsSources([legacyOverlap]), legacyOverlap);
  assert.throws(() => mergeTotalsSources([before, legacyOverlap]), /overlapping legacy settled contribution: constructor/);
});

test("copied totals require comparable authority for conflicts, not source order or update metadata alone", () => {
  const original: OpenContribution = {
    sessionID: "moved", quality: "exact", tokens: usage(10).tokens, cost: 10,
    speed: { response: { generatedTokens: 23, durationMs: 200, estimated: false } },
  };
  const source = (contribution: OpenContribution): TotalsLedger => ({
    version: 1, generationBasisVersion: GENERATION_BASIS_VERSION,
    sessions: { [contribution.sessionID]: {
      tokens: { ...contribution.tokens }, cost: contribution.cost, responseCount: 1,
      speed: updateSpeedTotals(undefined, contribution.speed, 1),
    } },
    open: { "copied-mid": contribution }, settled: {},
  });
  const first = source(original);
  const same = source({ ...original });
  assert.deepEqual(mergeTotalsSources([first, same]), mergeTotalsSources([same, first]));
  assert.equal(mergeTotalsSources([first, same]).sessions.moved.cost, 10);

  for (const change of [
    { cost: 9 }, { tokens: usage(9).tokens }, { sessionID: "other" },
    { speed: { response: { generatedTokens: 23, durationMs: 100, estimated: false } } },
  ]) {
    const conflict = source({ ...original, ...change });
    assert.throws(() => mergeTotalsSources([first, conflict]), /conflicting totals contribution.*copied-mid/);
    assert.throws(() => mergeTotalsSources([conflict, first]), /conflicting totals contribution.*copied-mid/);
  }

  const live: OpenContribution = { ...original, update: {
    source: "live", instanceID: "server", sequence: 1, receivedAt: 100, revision: 1,
    fingerprint: "original", seenFingerprints: [],
  } };
  const duplicate = source({ ...live, update: { ...live.update!, instanceID: "restart", fingerprint: "same-value" } });
  const current = source(live);
  assert.deepEqual(mergeTotalsSources([current, duplicate]), mergeTotalsSources([duplicate, current]));
  assert.equal(mergeTotalsSources([current, duplicate]).sessions.moved.cost, 10, "equal effective values deduplicate despite incomparable metadata");
  const refreshed = source({ ...live, update: { ...live.update!, sequence: 2, revision: 2 } });
  assert.deepEqual(mergeTotalsSources([refreshed, current]).open["copied-mid"], refreshed.open["copied-mid"], "same-value copies retain the newer comparable authority");
  assert.deepEqual(mergeTotalsSources([current, refreshed]), mergeTotalsSources([refreshed, current]));
  const tiedConflict = source({ ...original, cost: 9, update: duplicate.open["copied-mid"].update });
  assert.throws(() => mergeTotalsSources([current, tiedConflict]), /conflicting totals contribution.*copied-mid/);
  assert.throws(() => mergeTotalsSources([tiedConflict, current]), /conflicting totals contribution.*copied-mid/);

  const corrected: OpenContribution = { ...original, tokens: zero().tokens, cost: 0,
    update: { ...live.update!, sequence: 2, receivedAt: 200, revision: 2, fingerprint: "zero" },
  };
  const newest = source(corrected);
  const forward = mergeTotalsSources([current, tiedConflict, newest]);
  assert.deepEqual(forward, mergeTotalsSources([newest, tiedConflict, current]));
  assert.deepEqual(forward.open["copied-mid"], corrected, "a comparable newer update resolves both older conflicts, including a zero correction");
  assert.equal(forward.sessions.moved.cost, 0);
});
