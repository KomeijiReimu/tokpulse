import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDirectTotals } from "../src/totals-storage.js";
import { rollupSessionTotals as legacyRollup, createTotalsRollupIndex, type TotalsRollup } from "../src/totals-aggregate.js";
import { addTokenCounts, emptyTokenCounts } from "../src/core.js";
import { addSpeedTotals, coerceSpeedTotals, getSessionAverageSummary, updateSpeedTotals } from "../src/statistics.js";
import { classifyMessageMetadata, classifySessionMetadata, type SessionScopes } from "../src/scope.js";

// Keep every pre-index legacy assertion, and exercise the same fixture through
// the snapshot API without replacing the production legacy implementation.
function rollupSessionTotals(...args: Parameters<typeof legacyRollup>): TotalsRollup {
  const expected = legacyRollup(...args);
  assert.deepEqual(createTotalsRollupIndex(args[0], args[1], args[3]).get(args[2]), expected);
  return expected;
}

test("every direct and including rollup filters MC descendants without changing exact user sums", () => {
  const root = usage(1);
  const real = usage(10);
  real.speed = updateSpeedTotals(undefined, { response: { generatedTokens: 5, durationMs: 100, estimated: false } }, 1);
  const sessions = { root, real, mc: usage(100), grand: usage(1000) };
  const parents = { real: "root", mc: "root", grand: "mc" };
  const scopes = { mc: classifySessionMetadata({ agent: "dreamer" }) };
  const actual = rollupSessionTotals(sessions, parents, "root", scopes);
  assert.deepEqual(actual, rollupSessionTotals({ root, real }, { real: "root" }, "root"));
  assert.deepEqual(rollupSessionTotals(sessions, parents, "mc", scopes), { direct: zero(), including: zero(), children: [] });
  assert.deepEqual(rollupSessionTotals(sessions, parents, "grand", scopes).direct, zero());
  assert.equal(sessions.mc.tokens.input, 100);
  assert.equal(actual.including.speed?.response.generatedTokens, 5);
});

test("scope inheritance through a cycle safely filters every rollup entry", () => {
  const result = rollupSessionTotals({ a: usage(1), b: usage(10) }, { a: "b", b: "a" }, "a", { b: classifySessionMetadata({ agent: "historian" }) });
  assert.deepEqual(result, { direct: zero(), including: zero(), children: [] });
});

test("shared speed merge preserves shortResponseCount in direct/including and scope-filtered totals", () => {
  const makeShortTotals = (count: number) => {
    const totals = usage(count);
    totals.speed = {
      generation: { generatedTokens: count * 5, coverageGeneratedTokens: count * 10, durationMs: count * 200, responseCount: count, estimatedResponseCount: count, shortResponseCount: count },
      response: { generatedTokens: count * 10, coverageGeneratedTokens: count * 10, durationMs: count * 3000, responseCount: count, estimatedResponseCount: 0 },
    };
    return totals;
  };
  const sessions = { root: makeShortTotals(1), real: makeShortTotals(2), mc: makeShortTotals(10), grand: makeShortTotals(20) };
  const parents = { real: "root", mc: "root", grand: "mc" };
  const actual = rollupSessionTotals(sessions, parents, "root", { mc: classifySessionMetadata({ agent: "dreamer" }) });
  assert.equal(actual.direct.speed?.generation.shortResponseCount, 1);
  assert.equal(actual.including.speed?.generation.shortResponseCount, 3);
  assert.equal(actual.children[0].direct.speed?.generation.shortResponseCount, 2);
  assert.equal(actual.children[0].including.speed?.generation.shortResponseCount, 2);
  assert.deepEqual(actual, rollupSessionTotals({ root: sessions.root, real: sessions.real }, { real: "root" }, "root"));
  assert.equal(sessions.mc.speed?.generation.shortResponseCount, 10);
});

test("message-only maintenance proof preserves ordinary session and child usage and speed", () => {
  const sessions = { root: usage(1), child: usage(10), grand: usage(100) };
  sessions.root.speed = updateSpeedTotals(undefined, { response: { generatedTokens: 5, durationMs: 100, estimated: false } }, 1);
  sessions.child.speed = updateSpeedTotals(undefined, { response: { generatedTokens: 10, durationMs: 200, estimated: false } }, 1);
  const parents = { child: "root", grand: "child" };
  for (const identity of [{ agent: "historian" }, { mode: "dreamer" }]) {
    const proof = classifyMessageMetadata(identity);
    assert.equal(proof.sourceScope, "magic-message");
    const scopes = { root: proof };
    for (const id of ["root", "child", "grand"]) {
      assert.deepEqual(rollupSessionTotals(sessions, parents, id, scopes), rollupSessionTotals(sessions, parents, id));
    }
    const actual = rollupSessionTotals(sessions, parents, "root", scopes);
    assert.equal(actual.including.responseCount, 3);
    assert.equal(actual.including.tokens.input, 111);
    assert.equal(actual.including.cost, 111);
    assert.equal(actual.including.speed?.response.generatedTokens, 15);
  }
});

test("direct average excludes child speed while rollup keeps independent sums", () => {
  const root = usage(1);
  root.speed = updateSpeedTotals(undefined, { response: { generatedTokens: 10, durationMs: 1000, estimated: false } }, 1);
  const child = usage(2);
  child.speed = updateSpeedTotals(undefined, { response: { generatedTokens: 100, durationMs: 100, estimated: true } }, 1);
  const result = rollupSessionTotals({ root, child }, { child: "root" }, "root");
  assert.equal(getSessionAverageSummary(result.direct).response.rate, 10);
  assert.equal(getSessionAverageSummary(result.direct).response.estimated, false);
  assert.equal(getSessionAverageSummary(result.including).response.rate, 110000 / 1100);
  assert.equal(getSessionAverageSummary(result.including).response.estimated, true);
  assert.equal(result.children[0]?.direct.speed?.response.generatedTokens, 100);
});

test("generation rollup sums estimated interval tokens and full coverage independently", () => {
  const root = usage(1);
  root.tokens.output = 20;
  root.tokens.reasoning = 4;
  root.speed = { generation: { generatedTokens: 17, coverageGeneratedTokens: 24, durationMs: 2000, responseCount: 1, estimatedResponseCount: 1 },
    response: { generatedTokens: 24, coverageGeneratedTokens: 24, durationMs: 3000, responseCount: 1, estimatedResponseCount: 0 } };
  const child = usage(2);
  child.tokens.output = 10;
  child.tokens.reasoning = 2;
  child.speed = { generation: { generatedTokens: 8.5, coverageGeneratedTokens: 12, durationMs: 1000, responseCount: 1, estimatedResponseCount: 1 },
    response: { generatedTokens: 12, coverageGeneratedTokens: 12, durationMs: 1500, responseCount: 1, estimatedResponseCount: 0 } };
  const result = rollupSessionTotals({ root, child }, { child: "root" }, "root");
  assert.equal(result.direct.speed?.generation.generatedTokens, 17);
  assert.equal(result.direct.speed?.generation.coverageGeneratedTokens, 24);
  assert.equal(result.including.speed?.generation.generatedTokens, 25.5);
  assert.equal(result.including.speed?.generation.coverageGeneratedTokens, 36);
  assert.equal(result.including.speed?.generation.durationMs, 3000);
  assert.equal(getSessionAverageSummary(result.direct).generation.coveredGeneratedTokens, 24);
  assert.equal(getSessionAverageSummary(result.including).generation.coveredGeneratedTokens, 36);
  assert.equal(getSessionAverageSummary(result.including).generation.rate, 8.5);
  result.children[0]!.direct.speed!.generation.coverageGeneratedTokens = 999;
  assert.equal(child.speed.generation.coverageGeneratedTokens, 12);
});

test("persisted accumulators missing new coverage never infer it from interval tokens", () => {
  const root = usage(1);
  root.speed = { generation: { generatedTokens: 17, durationMs: 2000, responseCount: 1, estimatedResponseCount: 1 },
    response: { generatedTokens: 24, durationMs: 3000, responseCount: 1, estimatedResponseCount: 0 } };
  const result = rollupSessionTotals({ root }, {}, "root");
  assert.equal(result.direct.speed?.generation.coverageGeneratedTokens, 0);
  assert.equal(result.including.speed?.generation.coverageGeneratedTokens, 0);
  assert.equal(getSessionAverageSummary(result.including).generation.coveredGeneratedTokens, 0);
});

test("includes child usage when the parent direct total is zero", () => {
  const child = usage(7);
  const result = rollupSessionTotals(
    { parent: zero(), child },
    { child: "parent" },
    "parent",
  );

  assert.deepEqual(result.direct, zero());
  assert.deepEqual(result.including, child);
  assert.deepEqual(result.children.map((entry) => entry.sessionID), ["child"]);
  assert.deepEqual(result.children[0]?.direct, child);
  assert.deepEqual(result.children[0]?.including, child);
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

test("returns zeros when the session is missing and has no children", () => {
  const result = rollupSessionTotals(
    { other: usage(4) },
    { other: "elsewhere" },
    "missing",
  );

  assert.deepEqual(result.direct, zero());
  assert.deepEqual(result.including, zero());
  assert.deepEqual(result.children, []);
});

test("returned totals are copies of the input", () => {
  const root = usage(1);
  const child = usage(10);
  const sessions = { root, child };
  const result = rollupSessionTotals(sessions, { child: "root" }, "root");

  result.direct.tokens.input = 0;
  result.direct.cost = 0;
  result.direct.responseCount = 0;
  result.including.tokens.output = 0;
  result.including.cost = 0;
  result.children[0]!.direct.tokens.reasoning = 0;
  result.children[0]!.including.tokens.cacheWrite = 0;
  result.children[0]!.including.responseCount = 0;

  assert.equal(root.tokens.input, 1);
  assert.equal(root.tokens.output, 2);
  assert.equal(root.cost, 1);
  assert.equal(root.responseCount, 1);
  assert.equal(child.tokens.reasoning, 12);
  assert.equal(child.tokens.cacheWrite, 14);
  assert.equal(child.responseCount, 1);
  assert.notEqual(result.direct.tokens, root.tokens);
  assert.notEqual(result.including.tokens, root.tokens);
  assert.notEqual(result.including.tokens, result.direct.tokens);
  assert.notEqual(result.children[0]?.direct.tokens, child.tokens);
  assert.notEqual(result.children[0]?.including.tokens, child.tokens);
  assert.notEqual(result.children[0]?.direct.tokens, result.children[0]?.including.tokens);
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

/** Deliberately independent per-query visited-set oracle, not index/SCC code. */
function referenceRollup(sessions: Readonly<Record<string, SessionDirectTotals>>, parents: ReadonlyMap<string, string | null | undefined>, id: string, scopes: SessionScopes): TotalsRollup {
  const children = new Map<string, string[]>();
  for (const [child, parent] of parents) if (typeof parent === "string" && parent && child !== parent) {
    const list = children.get(parent) ?? []; list.push(child); children.set(parent, list);
  }
  const eligible = (start: string): boolean => {
    const seen = new Set<string>();
    let current: string | null | undefined = start;
    while (current && !seen.has(current)) {
      seen.add(current);
      const proof: SessionScopes[string] | undefined = Object.hasOwn(scopes, current) ? scopes[current] : undefined;
      if (proof?.sourceScope === "magic-session") return false;
      current = parents.has(current) ? parents.get(current) : proof?.parentSessionID;
    }
    return true;
  };
  const lookup = (key: string) => Object.hasOwn(sessions, key) ? sessions[key] : undefined;
  const copy = (key: string): SessionDirectTotals => {
    const value = eligible(key) ? lookup(key) : undefined;
    return value ? { tokens: addTokenCounts(emptyTokenCounts(), value.tokens), cost: value.cost, responseCount: value.responseCount,
      ...(value.speed ? { speed: coerceSpeedTotals(value.speed) } : {}) } : zero();
  };
  const sum = (key: string): SessionDirectTotals => {
    const result = zero(), visited = new Set<string>(), stack = [key];
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (!eligible(current)) continue;
      const value = lookup(current);
      if (value) {
        result.tokens = addTokenCounts(result.tokens, value.tokens); result.cost += value.cost; result.responseCount += value.responseCount;
        const speed = addSpeedTotals(result.speed, value.speed); if (speed) result.speed = speed;
      }
      for (const child of children.get(current) ?? []) stack.push(child);
    }
    return result;
  };
  return { direct: copy(id), including: sum(id), children: (children.get(id) ?? []).slice().sort((a, b) => a.localeCompare(b)).filter(eligible)
    .map((child) => ({ sessionID: child, direct: copy(child), including: sum(child) })) };
}

test("snapshot index matches independent visited-set reference on small functional parent graphs", () => {
  const ids = ["root", "a", "b", "c", "d", "constructor", "__proto__", "toString", "", "ledger-only"];
  for (let seed = 1; seed <= 128; seed++) {
    let state = seed;
    const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const sessions: Record<string, SessionDirectTotals> = Object.create(null), scopes: Record<string, SessionScopes[string]> = Object.create(null);
    const parents = new Map<string, string | null | undefined>();
    for (const id of ids) {
      if (next() % 3) {
        const total = usage(next() % 100); total.cost /= 4;
        total.speed = { generation: { generatedTokens: next() % 50 / 2, durationMs: next() % 100, responseCount: 1, estimatedResponseCount: 1,
          ...(next() % 2 ? { coverageGeneratedTokens: next() % 20, shortResponseCount: 1 } : {}) },
        response: { generatedTokens: next() % 40, durationMs: next() % 100, responseCount: 1, estimatedResponseCount: 0 } };
        sessions[id] = total;
      }
      const parentKind = next() % 5;
      if (parentKind !== 0) parents.set(id, parentKind === 1 ? undefined : parentKind === 2 ? null : ids[next() % ids.length]);
      if (next() % 3 === 0) scopes[id] = { ...(next() % 2 ? classifySessionMetadata({ agent: "historian" }) : classifyMessageMetadata({ agent: "historian" })),
        parentSessionID: ids[next() % ids.length] };
    }
    const inputBefore = JSON.stringify({ sessions, parents: [...parents], scopes });
    for (const parentInput of [parents, Object.fromEntries(parents)]) {
      const index = createTotalsRollupIndex(sessions, parentInput, scopes);
      for (const id of [...ids, "absent"]) assert.deepEqual(index.get(id), referenceRollup(sessions, parents, id, scopes), JSON.stringify({ seed, id, sessions, parents: [...parents], scopes }));
    }
    assert.equal(JSON.stringify({ sessions, parents: [...parents], scopes }), inputBefore);
  }
});

test("snapshot owns inputs and returns independently mutable totals, speed and child lists", () => {
  const sessions = { root: usage(1), child: usage(2) };
  sessions.child.speed = updateSpeedTotals(undefined, { response: { generatedTokens: 8, durationMs: 200, estimated: false } }, 1);
  const parents = new Map<string, string | null | undefined>([["child", "root"]]);
  const scopes: Record<string, SessionScopes[string]> = {};
  const index = createTotalsRollupIndex(sessions, parents, scopes), expected = structuredClone(index.get("root"));
  const changed = index.get("root");
  changed.direct.tokens.input = 999; changed.including.cost = 999;
  changed.children[0].including.speed!.response.generatedTokens = 999;
  changed.children[0].direct.tokens.output = 999; changed.children.length = 0;
  assert.deepEqual(index.get("root"), expected);
  assert.equal(sessions.root.tokens.input, 1); assert.equal(sessions.child.speed!.response.generatedTokens, 8);
  parents.set("child", "elsewhere"); sessions.child.cost = 999; sessions.child.speed!.response.generatedTokens = 999;
  scopes.root = classifySessionMetadata({ agent: "historian" });
  assert.deepEqual(index.get("root"), expected, "same mutable input identity must not mutate an existing snapshot");
  assert.deepEqual(createTotalsRollupIndex(sessions, parents, scopes).get("root"), legacyRollup(sessions, parents, "root", scopes));
});

test("empty ID eligibility does not allow its contribution through an excluded parent", () => {
  const sessions = { "": usage(2), hidden: usage(3) }, parents = new Map([["", "hidden"]]);
  const scopes = { hidden: classifySessionMetadata({ agent: "historian" }) };
  const index = createTotalsRollupIndex(sessions, parents, scopes);
  assert.deepEqual(index.get("hidden"), referenceRollup(sessions, parents, "hidden", scopes));
  assert.deepEqual(index.get("").including, usage(2));
  assert.equal(index.get("hidden").including.responseCount, 0);
  assert.equal(index.get("hidden").children[0].including.responseCount, 1);
});

test("cycle with multiple branches and ledger-only intermediary counts every eligible source once", () => {
  const sessions = { a: usage(1), b: usage(2), grand: usage(4), other: usage(8), excluded: usage(16) };
  const parents = new Map([["a", "b"], ["b", "a"], ["missing", "a"], ["grand", "missing"], ["other", "b"], ["excluded", "other"]]);
  const scopes = { excluded: classifySessionMetadata({ agent: "historian" }) };
  const index = createTotalsRollupIndex(sessions, parents, scopes);
  for (const id of [...Object.keys(sessions), "missing"]) assert.deepEqual(index.get(id), referenceRollup(sessions, parents, id, scopes));
  assert.equal(index.get("a").including.cost, 15);
  assert.equal(index.get("b").including.cost, 15);
});

test("decimal cost regression records the non-associative IEEE rounding boundary without changing legacy DFS", () => {
  const sessions = { root: usage(0), child: usage(0), grand: usage(0) };
  sessions.root.cost = .1; sessions.child.cost = .2; sessions.grand.cost = .3;
  const parents = { child: "root", grand: "child" };
  const legacy = legacyRollup(sessions, parents, "root"), indexed = createTotalsRollupIndex(sessions, parents).get("root");
  assert.equal(legacy.including.cost, .6000000000000001);
  assert.equal(indexed.including.cost, .6);
  assert.ok(Math.abs(indexed.including.cost - legacy.including.cost) <= Number.EPSILON);
  assert.deepEqual(indexed.including.tokens, legacy.including.tokens);
  assert.equal(indexed.including.responseCount, legacy.including.responseCount);
});
