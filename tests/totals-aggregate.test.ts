import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDirectTotals } from "../src/totals-storage.js";
import { rollupSessionTotals } from "../src/totals-aggregate.js";
import { getSessionAverageSummary, updateSpeedTotals } from "../src/statistics.js";

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
