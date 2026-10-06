import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryRecord } from "../src/core.js";
import { acceptModelDelta, applyFirstResponseSignal, contentSpeedObservations, createContentProgress, deriveSafeResponseMeasurement, earliestFirstOutput, getSessionAverageSummary, measureRecordSpeed, mergeRecordSpeed, notePartSnapshot, parseModelDelta, recordContentArrival, selectSpeedMeasurement, thinkingFirstResponseSignal, updateSpeedTotals } from "../src/statistics.js";

function record(output = 100, reasoning = 0): HistoryRecord {
  return { version: 1, messageID: "m", sessionID: "s", tokens: { input: 0, output, reasoning, cacheRead: 0, cacheWrite: 0 }, cost: 0,
    time: { start: 0, firstToken: 100, completed: 2000 }, samples: [], quality: "exact" };
}
test("session average is ratio of sums with separate generation/response coverage", () => {
  let speed = updateSpeedTotals(undefined, measureRecordSpeed(record(10), { usageExact: true, responseTimingExact: true,
    generation: { start: 100, end: 1100, complete: true, estimated: true, version: 2, coverage: "complete", outputObserved: true, reasoningObserved: false } }), 1);
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
  notePartSnapshot(progress, { part: { id: "text", type: "text", text: "hello", time: { start: 100, end: 500 } } });
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
    generation: { start: 100, end: 300, complete: true, estimated: true, outputObserved: true, reasoningObserved: false, version: 2, coverage: "complete" } }) };
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

test("metadata-only visible Thinking establishes response, never content or samples", () => {
  const current = record();
  const context = { messageID: "m", sessionID: "s", role: "assistant", start: 0, now: 200, live: true };
  const signal = thinkingFirstResponseSignal({ type: "reasoning", messageID: "m", sessionID: "s", text: "", metadata: {}, time: { start: 100 } }, context);
  assert.deepEqual(signal, { timestamp: 100, source: "thinking", timeSource: "part-start", estimated: false });
  const time = applyFirstResponseSignal({ start: 0 }, signal!);
  assert.equal(time.firstResponse, 100);
  assert.equal(time.firstContent, undefined);
  assert.equal(time.firstToken, undefined);
  assert.deepEqual(current.samples, []);
  assert.equal(measureRecordSpeed({ ...current, time: { ...time, completed: 2000 } }).generation, undefined);
  const withContent = recordContentArrival(time, 500);
  assert.equal(withContent.firstContent, 500);
  assert.equal(withContent.firstToken, 500);
  assert.equal(withContent.firstResponse, 100);
  assert.equal(withContent.firstResponseSource, "thinking");
  assert.deepEqual(applyFirstResponseSignal(withContent, signal!), withContent);
});

test("Thinking visibility matches redaction/trim and truthy host metadata", () => {
  const context = { messageID: "m", role: "assistant", start: 100, now: 200, live: true };
  const part = { type: "reasoning", messageID: "m", text: " [REDACTED] [REDACTED] \n", time: { start: 150 } };
  assert.equal(thinkingFirstResponseSignal(part, context), undefined);
  for (const metadata of [null, false, 0, ""]) assert.equal(thinkingFirstResponseSignal({ ...part, metadata }, context), undefined);
  for (const metadata of [{}, [], true, "title"]) assert.equal(thinkingFirstResponseSignal({ ...part, metadata }, context)?.timestamp, 150);
  assert.equal(thinkingFirstResponseSignal({ ...part, text: "[REDACTED] actual thought " }, context)?.timestamp, 150);
  assert.equal(thinkingFirstResponseSignal({ ...part, text: "text", time: {} }, context)?.estimated, true);
  for (const start of [0, 201, NaN, Infinity]) {
    const fallback = thinkingFirstResponseSignal({ ...part, text: "text", time: { start } }, context);
    assert.equal(fallback?.timestamp, 200);
    assert.equal(fallback?.timeSource, "arrival");
  }
});

test("Thinking rejects busy/user/completed/foreign/history and reconnect signals", () => {
  const context = { messageID: "m", sessionID: "s", role: "assistant", start: 0, now: 200, live: true };
  const part = { type: "reasoning", messageID: "m", text: "", metadata: true, time: { start: 100 } };
  for (const candidate of [{ ...part, type: "busy" }, { ...part, role: "user" }, { ...part, messageID: "old" },
    { ...part, sessionID: "other" }, { ...part, time: { start: 100, end: 0 } }]) assert.equal(thinkingFirstResponseSignal(candidate, context), undefined);
  for (const candidate of [{ ...context, live: false }, { ...context, role: "user" }, { ...context, completed: 200 },
    { ...context, now: -1 }, { ...context, start: NaN }]) assert.equal(thinkingFirstResponseSignal(part, candidate), undefined);
});

test("first-content compatibility alias follows earliest valid model arrival", () => {
  const first = recordContentArrival({ start: 100 }, 300);
  const earlier = recordContentArrival(first, 200);
  assert.equal(earlier.firstResponse, 200);
  assert.equal(earlier.firstContent, 200);
  assert.equal(earlier.firstToken, 200);
  assert.equal(earlier.firstResponseSource, "content");
  assert.equal(earlier.firstResponseEstimated, true);
  assert.deepEqual(recordContentArrival(earlier, 99), earlier);
  assert.deepEqual(recordContentArrival({ ...earlier, completed: 400 }, 401), { ...earlier, completed: 400 });
  assert.deepEqual(recordContentArrival(earlier, NaN), earlier);
});

test("a later Thinking signal cannot displace legacy earlier content timing", () => {
  const time = { start: 0, firstToken: 100 };
  const next = applyFirstResponseSignal(time, { timestamp: 200, source: "thinking", timeSource: "part-start", estimated: false });
  assert.equal(next.firstResponse, 100);
  assert.equal(next.firstResponseSource, "content");
  assert.equal(next.firstToken, 100);
  const earlierThinking = applyFirstResponseSignal(next, { timestamp: 50, source: "thinking", timeSource: "part-start", estimated: false });
  assert.equal(earlierThinking.firstResponse, 50);
  assert.equal(earlierThinking.firstToken, 100);
});

function completeProgress(type = "text", delta = "hello") {
  const progress = createContentProgress();
  notePartSnapshot(progress, { part: { id: "p", type, text: "", time: { start: 100 } } });
  parseModelDelta(progress, { partID: "p", field: "text" }, { type: "message.part.delta" }, "legacy", delta);
  notePartSnapshot(progress, { part: { id: "p", type, text: delta, time: { start: 100, end: 1100 } } });
  return progress;
}

test("versioned generation coverage is separate from category observation and usage calibration", () => {
  const current = record(10, 1000);
  const progress = completeProgress("reasoning", "x");
  notePartSnapshot(progress, { part: { id: "p", type: "reasoning", text: "x".repeat(1000), time: { start: 100, end: 1100 } } });
  const observations = contentSpeedObservations(current, progress, 1000, true, true);
  assert.equal(progress.parts.get("p")?.deltaBytes, 1);
  assert.equal(observations.generation, undefined);
  assert.equal(observations.generationCoverage?.status, "gap");
  const measured = { ...current, speed: measureRecordSpeed(current, observations) };
  assert.equal(measured.speed.generation, undefined);
  assert.equal(selectSpeedMeasurement(measured).basis, "response");
  assert.equal(selectSpeedMeasurement(measured).rate, 505);
  // Even a final all-usage calibration of a tiny captured sample cannot fill the gap.
  measured.samples = [{ timestamp: 1000, tokens: 1010, estimatedTokens: 1, kind: "reasoning" }];
  assert.equal(contentSpeedObservations(measured, progress, 1000, true, true).generation, undefined);
});

test("complete snapshot evidence covers UTF-8 bytes and includes known earlier part start", () => {
  const current = record(0, 100);
  const progress = completeProgress("reasoning", "思考");
  const observations = contentSpeedObservations(current, progress, 1000, true, true);
  assert.equal(progress.parts.get("p")?.deltaBytes, 6);
  assert.equal(observations.generation?.start, 100);
  const speed = measureRecordSpeed(current, observations);
  assert.equal(speed.generationEvidence?.version, 2);
  assert.equal(speed.generationEvidence?.coverage, "complete");
  assert.equal(selectSpeedMeasurement({ ...current, speed }).basis, "generation");
  assert.equal(selectSpeedMeasurement({ ...current, speed }).estimated, true);
});

test("missing snapshots/boundaries, unknown coverage and tool/multistep uncertainty reject generation", () => {
  const current = record();
  const cases = [
    (p: ReturnType<typeof createContentProgress>) => { p.parts.get("p")!.finalSnapshotBytes = undefined; },
    (p: ReturnType<typeof createContentProgress>) => { p.parts.get("p")!.start = undefined; },
    (p: ReturnType<typeof createContentProgress>) => { p.parts.get("p")!.end = undefined; },
    (p: ReturnType<typeof createContentProgress>) => { p.stepEnds = new Set([500, 1100]); },
    (p: ReturnType<typeof createContentProgress>) => { parseModelDelta(p, {}, { type: "message.part.delta" }, "legacy", "anonymous"); },
    (p: ReturnType<typeof createContentProgress>) => { notePartSnapshot(p, { part: { id: "tool", type: "tool", state: { status: "running", time: { start: 800 } } } }); },
    (p: ReturnType<typeof createContentProgress>) => { parseModelDelta(p, { callID: "c" }, { type: "session.next.tool.input.delta" }, "v2", "{}"); },
  ];
  for (const change of cases) {
    const progress = completeProgress();
    change(progress);
    const observations = contentSpeedObservations(current, progress, 100, true, true);
    assert.equal(observations.generation, undefined);
    assert.notEqual(observations.generationCoverage?.status, "complete");
  }
  assert.equal(contentSpeedObservations(record(100, 10), completeProgress(), 100, true, true).generation, undefined);
  assert.equal(contentSpeedObservations(current, completeProgress(), 100, true, true, false).generation, undefined);
});

test("snapshot-first replay and final unequal byte counts cannot claim complete interval coverage", () => {
  const progress = createContentProgress();
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello", time: { start: 100 } } });
  parseModelDelta(progress, { partID: "p" }, { type: "message.part.delta" }, "legacy", "hello");
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello", time: { start: 100, end: 1100 } } });
  assert.equal(contentSpeedObservations(record(), progress, 100, true, true).generationCoverage?.status, "gap");
  const truncated = completeProgress();
  notePartSnapshot(truncated, { part: { id: "p", type: "text", text: "hell", time: { start: 100, end: 1100 } } });
  assert.equal(contentSpeedObservations(record(), truncated, 100, true, true).generationCoverage?.status, "gap");
});

test("measurement selection preserves actual estimates and downgrades legacy boolean evidence", () => {
  const current = record(100);
  const speed = measureRecordSpeed(current, contentSpeedObservations(current, completeProgress(), 100, true, true));
  const selected = selectSpeedMeasurement({ ...current, speed });
  assert.equal(selected.available, true);
  assert.equal(selected.rate, 100);
  assert.equal(selected.basis, "generation");
  assert.equal(selected.estimated, true); // exact record quality does not make arrivals exact.
  assert.deepEqual(selected.coverage, { generation: true, response: true, generatedTokens: 100, durationMs: 1000 });
  const legacy = { ...speed, generationEvidence: { start: 100, end: 1100, outputObserved: true, reasoningObserved: false } };
  assert.equal(selectSpeedMeasurement({ ...current, speed: legacy }).basis, "response");
  assert.equal(selectSpeedMeasurement({ ...current, speed: legacy }).rate, 50);
  assert.equal(mergeRecordSpeed({ ...current, speed: { response: speed.response } }, { tokens: current.tokens, speed: legacy }).generation, undefined);
  assert.equal(updateSpeedTotals(undefined, legacy, 1)?.generation.responseCount, 0);
  const unavailable = selectSpeedMeasurement({ ...current, speed: { generation: speed.generation } });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.rate, undefined);
  assert.equal(unavailable.basis, undefined);
  assert.equal(selectSpeedMeasurement(current).available, false); // valid-looking normalized timing alone is not provenance.
});

test("safe response derivation explicitly requires raw timing provenance", () => {
  const current = record(100, 20);
  assert.equal(deriveSafeResponseMeasurement(current, { rawTimingKnown: false }), undefined);
  assert.deepEqual(deriveSafeResponseMeasurement(current, { rawTimingKnown: true }), { generatedTokens: 120, durationMs: 2000, estimated: true });
  assert.equal(deriveSafeResponseMeasurement(current, { rawTimingKnown: true, usageExact: true, responseTimingExact: true })?.estimated, false);
  for (const time of [{ start: NaN, completed: 2000 }, { start: 0, completed: Infinity }, { start: 2000, completed: 2000 }, { start: -1, completed: 2000 }]) {
    assert.equal(deriveSafeResponseMeasurement({ ...current, time }, { rawTimingKnown: true }), undefined);
  }
});

test("reversible legacy generation is subtractable but cannot be newly added as complete coverage", () => {
  const legacy = { generation: { generatedTokens: 100, durationMs: 1000, estimated: false } };
  const previous = { generation: { generatedTokens: 100, durationMs: 1000, responseCount: 1, estimatedResponseCount: 0 },
    response: { generatedTokens: 0, durationMs: 0, responseCount: 0, estimatedResponseCount: 0 } };
  assert.equal(updateSpeedTotals(undefined, legacy, 1)?.generation.responseCount, 0);
  assert.equal(updateSpeedTotals(previous, legacy, -1)?.generation.responseCount, 0);
  assert.equal(updateSpeedTotals(previous, legacy, -1)?.generation.generatedTokens, 0);
});
