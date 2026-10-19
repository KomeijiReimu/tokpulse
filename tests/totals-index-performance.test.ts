import assert from "node:assert/strict";
import test from "node:test";
import { createTotalsRollupIndex, totalsRollupIndexDiagnostics } from "../src/totals-aggregate.js";
import type { SessionDirectTotals } from "../src/totals-storage.js";
import { classifySessionMetadata } from "../src/scope.js";

test("G2-04 snapshot build plus every-node expansion is bounded for wide, deep and cyclic graphs", () => {
  const results: Array<Record<string, string | number>> = [];
  for (const shape of ["wide", "deep", "deep-reverse", "cycle"] as const) for (const size of [500, 1000, 2000, 4000]) {
    let actualParentIterations = 0;
    class CountedParents extends Map<string, string> {
      override *[Symbol.iterator](): MapIterator<[string, string]> {
        for (const pair of super[Symbol.iterator]()) { actualParentIterations++; yield pair; }
      }
    }
    const parents = new CountedParents(), sessions: Record<string, SessionDirectTotals> = Object.create(null);
    for (let position = 0; position < size; position++) {
      const i = shape === "deep-reverse" ? size - 1 - position : position;
      const id = `s-${i}`;
      sessions[id] = { tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, cost: .25, responseCount: 1 };
      if (shape === "cycle") parents.set(id, `s-${(i + 1) % size}`);
      else if (i) parents.set(id, shape === "wide" ? "s-0" : `s-${i - 1}`);
    }
    const start = performance.now(), index = createTotalsRollupIndex(sessions, parents);
    const built = totalsRollupIndexDiagnostics(index);
    assert.equal(actualParentIterations, parents.size);
    assert.equal(built.parentEntries, parents.size);
    assert.equal(built.sessionEntries, size);
    assert.ok(built.parentVisits <= size * 6, JSON.stringify(built));
    assert.ok(built.nodeVisits <= size * 30, JSON.stringify(built));
    assert.ok(built.merges <= size * 3, JSON.stringify(built));
    assert.ok(built.sortComparisons <= size * Math.ceil(Math.log2(size)) * 2, JSON.stringify(built));
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < size; i++) {
      const result = index.get(`s-${i}`);
      const expected = shape === "cycle" || i === 0 ? size : shape === "wide" ? 1 : size - i;
      assert.equal(result.including.responseCount, expected);
      assert.equal(result.including.cost, expected * .25);
    }
    const expanded = totalsRollupIndexDiagnostics(index);
    assert.equal(expanded.builds, 1); assert.equal(expanded.parentEntries, built.parentEntries);
    assert.equal(expanded.parentVisits, built.parentVisits);
    assert.equal(expanded.merges, built.merges); assert.equal(expanded.sortComparisons, built.sortComparisons);
    assert.equal(actualParentIterations, parents.size, "get never iterates the input parent graph");
    assert.ok(expanded.nodeVisits - built.nodeVisits <= size * 4);
    assert.ok(expanded.childVisits - built.childVisits <= size * 2);
    assert.ok(expanded.resultCopies <= size * 8, JSON.stringify(expanded));
    // A hidden ancestor exercises eligibility's complete deep/cycle paths too.
    const hidden = createTotalsRollupIndex(sessions, parents, { "s-0": classifySessionMetadata({ agent: "historian" }) });
    for (let i = 0; i < size; i++) assert.equal(hidden.get(`s-${i}`).including.responseCount, 0);
    const hiddenCounts = totalsRollupIndexDiagnostics(hidden);
    assert.ok(hiddenCounts.nodeVisits <= size * 34); assert.ok(hiddenCounts.parentVisits <= size * 6);
    results.push({ shape, size, ms: +(performance.now() - start).toFixed(2), parentEntries: built.parentEntries,
      buildParentVisits: built.parentVisits, buildNodeVisits: built.nodeVisits, expandedNodeVisits: expanded.nodeVisits,
      expandedChildVisits: expanded.childVisits, merges: expanded.merges, sortComparisons: expanded.sortComparisons,
      hiddenParentVisits: hiddenCounts.parentVisits, hiddenNodeVisits: hiddenCounts.nodeVisits });
  }
  console.log("totals snapshot index benchmark", JSON.stringify(results));
});
