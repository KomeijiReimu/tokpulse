import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDirectTotals } from "../src/totals-storage.js";
import { createTotalsRollupIndex, type TotalsRollup } from "../src/totals-aggregate.js";
import { classifyMessageMetadata, classifySessionMetadata, type SessionScopes } from "../src/scope.js";

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
