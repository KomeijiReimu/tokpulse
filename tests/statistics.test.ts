import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryRecord } from "../src/core.js";
import { acceptModelDelta, contentSpeedObservations, createContentProgress, earliestFirstOutput, getSessionAverageSummary, measureRecordSpeed, mergeRecordSpeed, notePartSnapshot, parseModelDelta, updateSpeedTotals } from "../src/statistics.js";

function record(output = 100, reasoning = 0): HistoryRecord {
  return { version: 1, messageID: "m", sessionID: "s", tokens: { input: 0, output, reasoning, cacheRead: 0, cacheWrite: 0 }, cost: 0,
    time: { start: 0, firstToken: 100, completed: 2000 }, samples: [], quality: "exact" };
}
test("session average is ratio of sums with separate generation/response coverage", () => {
  let speed = updateSpeedTotals(undefined, measureRecordSpeed(record(10), { usageExact: true, responseTimingExact: true,
    generation: { start: 100, end: 1100, complete: true, estimated: true } }), 1);
  speed = updateSpeedTotals(speed, measureRecordSpeed({ ...record(100), time: { start: 0, completed: 1000 } }, { usageExact: true, responseTimingExact: true }), 1);
  const summary = getSessionAverageSummary({ tokens: record(999).tokens, responseCount: 3, speed });
  assert.equal(summary.response.rate, 110000 / 3000);
  assert.equal(summary.generation.rate, 10);
  assert.equal(summary.generation.coveredResponseCount, 1);
  assert.equal(summary.response.coveredResponseCount, 2);
  assert.equal(summary.totalResponseCount, 3);
  assert.equal(summary.totalGeneratedTokens, 999);
  assert.equal(summary.generation.estimated, true);
  assert.equal(summary.response.includesTTFT, true);
  assert.equal(summary.response.mayIncludeToolWait, true);
});
test("legacy records have no fabricated speed coverage; unknown usage/timing is estimated", () => {
  const summary = getSessionAverageSummary({ tokens: record().tokens, responseCount: 9 });
  assert.equal(summary.generation.available, false);
  assert.equal(summary.response.available, false);
  assert.equal(measureRecordSpeed(record()).response?.estimated, true);
  assert.equal(measureRecordSpeed(record()).generation, undefined);
  assert.equal(earliestFirstOutput(0, 200, 90, 30, Date.now()), 30);
});
test("part snapshots are metadata only; equal deltas remain legal; tools output is rejected", () => {
  const progress = createContentProgress();
  notePartSnapshot(progress, { part: { id: "tool", type: "tool", state: { status: "running", time: { start: 700 } } } });
  assert.equal(acceptModelDelta(progress, { partID: "tool", field: "output" }, { type: "message.part.delta" }, "legacy", "result"), false);
  notePartSnapshot(progress, { part: { id: "text", type: "text", text: "same", time: { end: 600 } } });
  assert.equal(progress.parts.get("text")?.deltaBytes, 0);
  for (let i = 0; i < 2; i++) assert.equal(acceptModelDelta(progress, { partID: "text", field: "text" }, { type: "message.part.delta" }, "legacy", "same"), true);
  assert.equal(progress.parts.get("text")?.deltaBytes, 8);
  assert.equal(acceptModelDelta(progress, { partID: "text", field: "text" }, { type: "message.part.delta", id: "event" }, "legacy", "same"), true);
  assert.equal(acceptModelDelta(progress, { partID: "text", field: "text" }, { type: "message.part.delta", id: "event" }, "legacy", "same"), false);
});
test("generation end excludes tool wait; tool-only and hidden reasoning fall back", () => {
  const progress = createContentProgress();
  acceptModelDelta(progress, { partID: "text", field: "text" }, { type: "message.part.delta" }, "legacy", "hello");
  notePartSnapshot(progress, { part: { id: "text", type: "text", time: { end: 500 } } });
  notePartSnapshot(progress, { part: { id: "tool", type: "tool", state: { status: "running", time: { start: 800 } } } });
  notePartSnapshot(progress, { part: { id: "tool", type: "tool", state: { status: "completed", time: { start: 800, end: 1900 } } } });
  const speed = measureRecordSpeed(record(), contentSpeedObservations(record(), progress, 100, true, true));
  assert.equal(speed.generation?.durationMs, 700);
  assert.equal(speed.generation?.estimated, true);
  assert.equal(speed.response?.durationMs, 2000);
  assert.equal(contentSpeedObservations(record(10, 10), progress, 100, true, true).generation, undefined);
  assert.equal(contentSpeedObservations(record(), progress, undefined, true, true).generation, undefined);
  progress.stepEnds = new Set([800, 1900]);
  assert.equal(contentSpeedObservations(record(), progress, 100, true, true).generation, undefined);
});

test("speed merge distinguishes no observation, incompatible coverage, invalidation and legacy uncertainty", () => {
  const original = record(10);
  const prior = { tokens: original.tokens, speed: measureRecordSpeed(original, { usageExact: true, responseTimingExact: true,
    generation: { start: 100, end: 300, complete: true, estimated: true, outputObserved: true, reasoningObserved: false } }) };
  const incoming = { ...original, speed: measureRecordSpeed(original) };
  assert.equal(mergeRecordSpeed(incoming, prior).generation?.durationMs, 200);
  assert.equal(mergeRecordSpeed({ ...incoming, tokens: record(10, 100).tokens }, prior).generation, undefined);
  assert.equal(mergeRecordSpeed({ ...incoming, time: { start: 200, completed: 250 } }, prior).generation, undefined);
  assert.equal(mergeRecordSpeed(incoming, prior, "invalidated").generation, undefined);
  assert.equal(mergeRecordSpeed(incoming, { tokens: prior.tokens, speed: { generation: prior.speed.generation } }).generation, undefined);
});
test("shared delta parser uses metadata kind and real v2 identifiers", () => {
  const progress = createContentProgress();
  notePartSnapshot(progress, { part: { id: "p", type: "reasoning" } });
  assert.equal(parseModelDelta(progress, { partID: "p", field: "text" }, { type: "message.part.delta" }, "legacy", "think")?.kind, "reasoning");
  assert.equal(parseModelDelta(progress, { reasoningID: "r" }, { type: "session.next.reasoning.delta" }, "v2", "think")?.kind, "reasoning");
  assert.equal(parseModelDelta(progress, { callID: "c" }, { type: "session.next.tool.input.delta" }, "v2", "{}")?.partID, "call:c");
});
