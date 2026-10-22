import assert from "node:assert/strict";
import test from "node:test";
import { createTotalsRollupIndex, totalsRollupIndexDiagnostics } from "../src/totals-aggregate.js";
import type { SessionDirectTotals } from "../src/totals-storage.js";
import { classifySessionMetadata } from "../src/scope.js";

test("4000-node reverse-inserted chain builds and expands without rescanning the parent graph", () => {
  const size = 4000;
  let parentIterations = 0;
  class CountedParents extends Map<string, string> {
    override *[Symbol.iterator](): MapIterator<[string, string]> {
      for (const pair of super[Symbol.iterator]()) { parentIterations++; yield pair; }
    }
  }
  const parents = new CountedParents(), sessions: Record<string, SessionDirectTotals> = Object.create(null);
  for (let i = size - 1; i >= 0; i--) {
    sessions[`s-${i}`] = { tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, cost: .25, responseCount: 1 };
    if (i) parents.set(`s-${i}`, `s-${i - 1}`);
  }
  const index = createTotalsRollupIndex(sessions, parents), built = totalsRollupIndexDiagnostics(index);
  assert.ok(parentIterations <= size * 2, "construction must not traverse ancestry once per session");
  assert.ok(built.parentVisits <= size * 6);
  assert.ok(built.nodeVisits <= size * 30);
  assert.ok(built.merges <= size * 3);
  const iterationsAfterBuild = parentIterations;
  for (let i = 0; i < size; i++) {
    const result = index.get(`s-${i}`);
    assert.equal(result.including.responseCount, size - i);
    assert.equal(result.including.cost, (size - i) * .25);
  }
  const expanded = totalsRollupIndexDiagnostics(index);
  assert.equal(parentIterations, iterationsAfterBuild, "queries must not rewalk input parents");
  assert.equal(expanded.merges, built.merges, "queries must reuse computed subtree totals");
  assert.ok(expanded.nodeVisits - built.nodeVisits <= size * 2);
  const hidden = createTotalsRollupIndex(sessions, parents, { "s-0": classifySessionMetadata({ agent: "historian" }) });
  assert.equal(hidden.get(`s-${size - 1}`).including.responseCount, 0);
  assert.ok(totalsRollupIndexDiagnostics(hidden).parentVisits <= size * 6, "deep inherited exclusions must also remain linear");
});
