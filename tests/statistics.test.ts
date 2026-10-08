import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryRecord } from "../src/core.js";
import { utf8ByteLength } from "../src/core.js";
import { GENERATION_BASIS_VERSION, MIN_COMPLETED_OBSERVATION_MS, RECEIVE_CLOCK_RESOLUTION_MS, type ReceiveClockContext } from "../src/statistics.js";
import { acceptModelDelta, addSpeedTotals, applyFirstResponseSignal, coerceSpeedContribution, coerceSpeedTotals, contentSpeedObservations, createContentProgress, deriveSafeResponseMeasurement, earliestFirstOutput, getSessionAverageSummary, isQualifiedGenerationContribution, measureRecordSpeed, mergeContentProgress, mergeRecordSpeed, noteContentArrival, notePartSnapshot, noteStepIdentity, parseModelDelta, recordContentArrival, selectResponseMeasurement, selectSpeedMeasurement, taintContentProgress, thinkingFirstResponseSignal, updateSpeedTotals } from "../src/statistics.js";

function record(output = 100, reasoning = 0): HistoryRecord {
  return { version: 1, messageID: "m", sessionID: "s", tokens: { input: 0, output, reasoning, cacheRead: 0, cacheWrite: 0 }, cost: 0,
    time: { start: 0, firstToken: 100, completed: 2000 }, samples: [], quality: "exact" };
}
test("session average is ratio of sums with separate generation/response coverage", () => {
  let speed = updateSpeedTotals(undefined, measured(record(10)), 1);
  speed = updateSpeedTotals(speed, measureRecordSpeed({ ...record(100), time: { start: 0, completed: 1000 } }, { usageExact: true, responseTimingExact: true }), 1);
  const summary = getSessionAverageSummary({ tokens: record(999).tokens, responseCount: 3, speed });
  assert.equal(summary.response.rate, 110000 / 3000);
  assert.equal(summary.generation.rate, 8);
  assert.equal(summary.generation.coveredGeneratedTokens, 10);
  assert.equal(speed?.generation.generatedTokens, 8);
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
test("tools with uncertain usage invalidate primary generation; response stays an independent diagnostic", () => {
  const progress = completeProgress();
  notePartSnapshot(progress, { part: { id: "tool", type: "tool", state: { status: "running", time: { start: 800 } } } });
  notePartSnapshot(progress, { part: { id: "tool", type: "tool", state: { status: "completed", time: { start: 800, end: 1900 } } } });
  const speed = measureRecordSpeed(record(), contentSpeedObservations(record(), progress, 100, true, true));
  assert.equal(speed.generation, undefined);
  assert.equal(speed.response?.durationMs, 2000);
  assert.equal(selectSpeedMeasurement({ ...record(), speed }).available, false);
  assert.equal(selectResponseMeasurement({ ...record(), speed }).rate, 50);
  assert.equal(contentSpeedObservations(record(10, 10), progress, 100, true, true).generation, undefined);
  assert.equal(contentSpeedObservations(record(), progress, undefined, true, true).generation, undefined);
  noteStepIdentity(progress, "second-step");
  assert.equal(contentSpeedObservations(record(), progress, 100, true, true).generation, undefined);
});

test("speed merge distinguishes no observation, incompatible coverage, invalidation and legacy uncertainty", () => {
  const original = record(10);
  const prior = { tokens: original.tokens, speed: measured(original) };
  const incoming = { ...original, speed: measureRecordSpeed(original) };
  assert.equal(mergeRecordSpeed(incoming, prior).generation?.durationMs, 1000);
  assert.equal(mergeRecordSpeed({ ...incoming, tokens: record(20).tokens }, prior).generation?.generatedTokens, 16);
  assert.equal(mergeRecordSpeed({ ...incoming, tokens: record(20).tokens }, prior).generation?.coverageGeneratedTokens, 20);
  assert.equal(mergeRecordSpeed({ ...incoming, tokens: record(10, 100).tokens }, prior).generation, undefined);
  assert.equal(mergeRecordSpeed({ ...incoming, time: { start: 200 } }, prior).generation, undefined);
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

function arrival(progress: ReturnType<typeof createContentProgress>, partID: string, delta: string, receivedAt: number, receivedMono = receivedAt, stream: "legacy" | "v2" = "legacy", clock?: ReceiveClockContext) {
  const parsed = parseModelDelta(progress, { partID, field: "text" }, { type: "message.part.delta" }, stream, delta);
  if (parsed) noteContentArrival(progress, { ...parsed, bytes: utf8ByteLength(delta), receivedAt, receivedMono, stream }, clock);
}

function completeProgress(type = "text", delta = "hello") {
  const progress = createContentProgress({ fromCurrentStart: true, selectedStream: "legacy" });
  noteStepIdentity(progress, "step-1");
  notePartSnapshot(progress, { part: { id: "p", type, text: "", time: { start: 100 } } });
  const characters = [...delta];
  arrival(progress, "p", characters.slice(0, 1).join(""), 100);
  arrival(progress, "p", characters.slice(1).join(""), 1100);
  notePartSnapshot(progress, { part: { id: "p", type, text: delta, time: { start: 100, end: 1100 } } });
  return progress;
}

function measured(current = record(), progress = completeProgress()) {
  return measureRecordSpeed(current, contentSpeedObservations(current, progress, undefined, true, true));
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
  assert.equal(selectSpeedMeasurement(measured).available, false);
  assert.equal(selectResponseMeasurement(measured).rate, 505);
  // Even a final all-usage calibration of a tiny captured sample cannot fill the gap.
  measured.samples = [{ timestamp: 1000, tokens: 1010, estimatedTokens: 1, kind: "reasoning" }];
  assert.equal(contentSpeedObservations(measured, progress, 1000, true, true).generation, undefined);
});

test("complete snapshot evidence covers UTF-8 bytes and measures receive span, not part start", () => {
  const current = record(0, 100);
  const progress = completeProgress("reasoning", "思考");
  const observations = contentSpeedObservations(current, progress, 1000, true, true);
  assert.equal(progress.parts.get("p")?.deltaBytes, 6);
  assert.equal(observations.generation?.start, 100);
  const speed = measureRecordSpeed(current, observations);
  assert.equal(speed.generationEvidence?.version, 3);
  assert.equal(speed.generationEvidence?.coverage, "complete");
  assert.equal(speed.generation?.generatedTokens, 50);
  assert.equal(speed.generation?.coverageGeneratedTokens, 100);
  assert.equal(selectSpeedMeasurement({ ...current, speed }).basis, "generation");
  assert.equal(selectSpeedMeasurement({ ...current, speed }).estimated, true);
});

test("missing snapshots/receive timing, unknown coverage and tool/multistep uncertainty reject generation", () => {
  const current = record();
  const cases = [
    (p: ReturnType<typeof createContentProgress>) => { p.parts.get("p")!.finalSnapshotBytes = undefined; },
    (p: ReturnType<typeof createContentProgress>) => { p.parts.get("p")!.receivedBytes = 0; },
    (p: ReturnType<typeof createContentProgress>) => { p.receive = undefined; },
    (p: ReturnType<typeof createContentProgress>) => { noteStepIdentity(p, "step-2"); },
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
  assert.deepEqual(contentSpeedObservations(record(), progress, 100, true, true).generationCoverage,
    { status: "unknown", reasons: ["not-observed-from-current-start"] });
  const truncated = completeProgress();
  notePartSnapshot(truncated, { part: { id: "p", type: "text", text: "hell", time: { start: 100, end: 1100 } } });
  assert.equal(contentSpeedObservations(record(), truncated, 100, true, true).generationCoverage?.status, "gap");
});

test("primary selection always estimates qualified v3 generation and never falls back to response", () => {
  const current = record(100);
  const speed = measureRecordSpeed(current, contentSpeedObservations(current, completeProgress(), 100, true, true));
  const selected = selectSpeedMeasurement({ ...current, speed });
  assert.equal(selected.available, true);
  assert.equal(selected.rate, 80);
  assert.equal(selected.basis, "generation");
  assert.equal(selected.estimated, true); // exact record quality does not make arrivals exact.
  assert.deepEqual(selected.coverage, { generation: true, response: true, generatedTokens: 100, intervalGeneratedTokens: 80, durationMs: 1000 });
  const legacy = { ...speed, generationEvidence: { start: 100, end: 1100, outputObserved: true, reasoningObserved: false } };
  assert.equal(selectSpeedMeasurement({ ...current, speed: legacy }).basis, undefined);
  assert.equal(selectSpeedMeasurement({ ...current, speed: legacy }).rate, undefined);
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

test("legacy generation is ignored for both signs so migration subtraction cannot erase v3 totals", () => {
  const legacy = { generation: { generatedTokens: 100, durationMs: 1000, estimated: false } };
  const previous = { generation: { generatedTokens: 100, durationMs: 1000, responseCount: 1, estimatedResponseCount: 0 },
    response: { generatedTokens: 0, durationMs: 0, responseCount: 0, estimatedResponseCount: 0 } };
  assert.equal(updateSpeedTotals(undefined, legacy, 1)?.generation.responseCount, 0);
  assert.equal(updateSpeedTotals(previous, legacy, -1)?.generation.responseCount, 1);
  assert.equal(updateSpeedTotals(previous, legacy, -1)?.generation.generatedTokens, 100);
});

test("v3 excludes the entire global-first batch by per-kind UTF-8 proportions, never arbitrary N-1", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  notePartSnapshot(progress, { part: { id: "r", type: "reasoning", text: "" } });
  notePartSnapshot(progress, { part: { id: "o", type: "text", text: "" } });
  arrival(progress, "r", "r", 100, 50);
  arrival(progress, "r", "rr", 101, 50);
  arrival(progress, "o", "oo", 102, 50);
  arrival(progress, "r", "rrr", 1100, 1050);
  arrival(progress, "o", "oooooo", 1101, 1050);
  notePartSnapshot(progress, { part: { id: "r", type: "reasoning", text: "rrrrrr" }, final: true });
  notePartSnapshot(progress, { part: { id: "o", type: "text", text: "oooooooo" }, final: true });
  const speed = measured(record(400, 100), progress);
  assert.equal(speed.generation?.generatedTokens, 350);
  assert.equal(speed.generation?.coverageGeneratedTokens, 500);
  assert.equal(speed.generation?.durationMs, 1000);
  assert.equal(speed.generation?.estimated, true);
  assert.deepEqual(speed.generationEvidence?.bytes, { output: { total: 8, firstBatch: 2 }, reasoning: { total: 6, firstBatch: 3 } });
  assert.equal(speed.generationEvidence?.observationCount, 2);
  assert.equal(selectSpeedMeasurement({ ...record(400, 100), speed }).rate, 350);
});

test("a category beginning after the global-first batch does not lose its own first batch", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  notePartSnapshot(progress, { part: { id: "r", type: "reasoning", text: "" } });
  notePartSnapshot(progress, { part: { id: "o", type: "text", text: "" } });
  arrival(progress, "r", "rr", 100);
  arrival(progress, "r", "rr", 1100);
  arrival(progress, "o", "output", 1100);
  notePartSnapshot(progress, { part: { id: "r", type: "reasoning", text: "rrrr" }, final: true });
  notePartSnapshot(progress, { part: { id: "o", type: "text", text: "output" }, final: true });
  const speed = measured(record(100, 100), progress);
  assert.equal(speed.generation?.generatedTokens, 150);
  assert.equal(speed.generationEvidence?.bytes?.output.firstBatch, 0);
});

test("undeclared v3 requires two receive-mono batches and one second; long part/tool-tail times cannot qualify", () => {
  for (const span of [0, 1, 999]) {
    const progress = createContentProgress({ fromCurrentStart: true });
    noteStepIdentity(progress, "step");
    arrival(progress, "p", "a", 100, 0);
    arrival(progress, "p", "b", 100 + span, span);
    notePartSnapshot(progress, { part: { id: "p", type: "text", text: "ab", time: { start: 0, end: 1_000_000 } } });
    const current = { ...record(), time: { start: 0, firstResponse: 1, completed: 1_000_000 } };
    const speed = measured(current, progress);
    assert.equal(speed.generation, undefined);
    assert.equal(selectSpeedMeasurement({ ...current, speed }).available, false);
  }
  assert.equal(measured(record(), completeProgress()).generation?.durationMs, 1000);
  const empty = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(empty, "step");
  assert.equal(parseModelDelta(empty, { partID: "p" }, { type: "message.part.delta", id: "empty" }, "legacy", ""), undefined);
  noteContentArrival(empty, { kind: "output", bytes: 0, receivedAt: 0, receivedMono: 0, stream: "legacy" });
  assert.equal(empty.receive, undefined);
  assert.equal(empty.parts.size, 0);
  assert.equal(empty.eventIDs.size, 0);
  assert.equal(measured(record(), empty).generation, undefined);
  assert.equal(measureRecordSpeed(record(), contentSpeedObservations(record(), completeProgress(), undefined, false, true)).generation, undefined);
});

const trustedClock: ReceiveClockContext = { clockSource: "performance.now", clockResolutionMs: RECEIVE_CLOCK_RESOLUTION_MS };
function timedProgress(span = 150, firstClock: ReceiveClockContext | undefined = trustedClock, lastClock = firstClock) {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  arrival(progress, "p", "h", 100, 50, "legacy", firstClock);
  arrival(progress, "p", "ello", 100 + span, 50 + span, "legacy", lastClock);
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello" }, final: true });
  return progress;
}

test("trusted 150ms completed flow is estimated short, with unchanged interval proportions and no LIVE extrema", () => {
  assert.equal(MIN_COMPLETED_OBSERVATION_MS, 100);
  assert.equal(RECEIVE_CLOCK_RESOLUTION_MS, 1);
  assert.equal(GENERATION_BASIS_VERSION, 3);
  const current = record(100);
  const speed = measured(current, timedProgress());
  assert.deepEqual(speed.generation, { generatedTokens: 80, coverageGeneratedTokens: 100, durationMs: 150, estimated: true, observationQuality: "short" });
  assert.equal(speed.generationEvidence?.clockSource, "performance.now");
  assert.equal(speed.generationEvidence?.clockResolutionMs, 1);
  assert.equal(speed.generationEvidence?.observationQuality, "short");
  const selected = selectSpeedMeasurement({ ...current, speed });
  assert.equal(selected.rate, 80_000 / 150);
  assert.equal(selected.estimated, true);
  assert.equal(selected.measurement?.observationQuality, "short");
  assert.equal(isQualifiedGenerationContribution(speed), true);
  assert.deepEqual(coerceSpeedContribution(JSON.parse(JSON.stringify(speed))), speed);
});

test("short completed flow requires declared trusted clock proof on every arrival and sufficient resolution span", () => {
  const undeclared = timedProgress();
  delete undeclared.receive!.clockSource;
  delete undeclared.receive!.clockResolutionMs;
  undeclared.receive!.clockTrusted = false;
  assert.deepEqual(measured(record(), undeclared).generationCoverage, { status: "unknown", reasons: ["unknown-receive-clock"] });
  const missingFirst = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(missingFirst, "step");
  arrival(missingFirst, "p", "h", 100, 50);
  arrival(missingFirst, "p", "ello", 250, 200, "legacy", trustedClock);
  notePartSnapshot(missingFirst, { part: { id: "p", type: "text", text: "hello" }, final: true });
  assert.equal(measured(record(), missingFirst).generationCoverage?.reasons[0], "unknown-receive-clock");
  const missingLast = timedProgress(150, trustedClock, undefined);
  // Explicit omitted clock after the two declared batches also loses all-arrival proof.
  arrival(missingLast, "p", "!", 250, 200);
  notePartSnapshot(missingLast, { part: { id: "p", type: "text", text: "hello!" }, final: true });
  assert.equal(measured(record(), missingLast).generationCoverage?.reasons[0], "unknown-receive-clock");
  for (const span of [0, 1, 99]) {
    const speed = measured(record(), timedProgress(span));
    assert.equal(speed.generation, undefined);
    assert.equal(speed.generationCoverage?.reasons[0], "insufficient-receive-span");
    assert.equal(selectSpeedMeasurement({ ...record(), speed }).available, false);
  }
  for (const clock of [{ clockSource: "Date.now", clockResolutionMs: 1 },
    { clockSource: "performance.now", clockResolutionMs: 0 }, { clockSource: "performance.now", clockResolutionMs: NaN },
    { clockSource: "performance.now", clockResolutionMs: Infinity }]) {
    assert.equal(measured(record(), timedProgress(150, clock as ReceiveClockContext)).generationCoverage?.reasons[0], "unknown-receive-clock");
  }
  const coarse = { ...trustedClock, clockResolutionMs: 20 };
  assert.equal(measured(record(), timedProgress(150, coarse)).generationCoverage?.reasons[0], "insufficient-receive-span");
  assert.equal(measured(record(), timedProgress(200, coarse)).generation?.observationQuality, "short");
  assert.equal(measured(record(), timedProgress(100)).generation?.observationQuality, "short");
  assert.equal(measured(record(), timedProgress(999)).generation?.observationQuality, "short");
  assert.equal(measured(record(), timedProgress(1000)).generation?.observationQuality, "standard");
  assert.equal(measured(record(), timedProgress(1000, { ...trustedClock, clockResolutionMs: 101 })).generation, undefined);
  const mixedResolution = timedProgress(150, trustedClock, coarse);
  assert.equal(measured(record(), mixedResolution).generation, undefined);
  assert.equal(mixedResolution.receive?.clockResolutionMs, 20);
});

test("short evidence/measurement coercion never fabricates missing resolution/source/quality", () => {
  const speed = measured(record(), timedProgress());
  for (const field of ["clockSource", "clockResolutionMs", "observationQuality"] as const) {
    const evidence = { ...speed.generationEvidence! };
    delete evidence[field];
    assert.equal(isQualifiedGenerationContribution({ ...speed, generationEvidence: evidence }), false);
  }
  for (const observationQuality of [undefined, "standard", "invented"] as const) {
    assert.equal(isQualifiedGenerationContribution({ ...speed, generation: { ...speed.generation!, observationQuality } } as any), false);
  }
  assert.equal(isQualifiedGenerationContribution({ ...speed, generationEvidence: { ...speed.generationEvidence!, observationQuality: "standard" } }), false);
  assert.equal(isQualifiedGenerationContribution({ ...speed, generationEvidence: { ...speed.generationEvidence!, clockResolutionMs: 16 } }), false);
  const old = measured();
  delete old.generation!.observationQuality;
  delete old.generationEvidence!.observationQuality;
  assert.equal(isQualifiedGenerationContribution(old), true);
  assert.equal(selectSpeedMeasurement({ ...record(), speed: old }).available, true);
  assert.equal(coerceSpeedContribution(old)?.generationEvidence?.observationQuality, undefined);
  assert.equal(updateSpeedTotals(undefined, old, 1)?.generation.shortResponseCount, 0);
});

test("short plus long AVG is ratio of interval sums; correction and revocation retain quality/counts without reset", () => {
  const current = record(100);
  const short = measured(current, timedProgress());
  const long = measured(record(200));
  let totals = updateSpeedTotals(updateSpeedTotals(undefined, long, 1), short, 1)!;
  const summary = getSessionAverageSummary({ tokens: record(300).tokens, responseCount: 2, speed: totals });
  assert.equal(summary.generation.rate, 240_000 / 1150);
  assert.equal(summary.generation.shortResponseCount, 1);
  assert.equal(summary.generation.coveredGeneratedTokens, 300);
  const corrected = mergeRecordSpeed(record(250), { tokens: current.tokens, speed: short });
  assert.equal(corrected.generation?.generatedTokens, 200);
  assert.equal(corrected.generation?.durationMs, 150);
  assert.equal(corrected.generation?.observationQuality, "short");
  assert.deepEqual(corrected.generationEvidence?.bytes, short.generationEvidence?.bytes);
  assert.equal(corrected.generationEvidence?.clockResolutionMs, 1);
  assert.equal(corrected.generationEvidence?.observationQuality, "short");
  totals = updateSpeedTotals(updateSpeedTotals(totals, short, -1), corrected, 1)!;
  assert.equal(totals.generation.generatedTokens, 360);
  assert.equal(totals.generation.durationMs, 1150);
  assert.equal(totals.generation.shortResponseCount, 1);
  const revoked = mergeRecordSpeed(record(250, 1), { tokens: record(250).tokens, speed: corrected });
  assert.equal(revoked.generation, undefined);
  assert.equal(mergeRecordSpeed(record(250), { tokens: record(250).tokens, speed: corrected }, "invalidated").generation, undefined);
  totals = updateSpeedTotals(updateSpeedTotals(totals, corrected, -1), revoked, 1)!;
  assert.equal(totals.generation.generatedTokens, 160);
  assert.equal(totals.generation.durationMs, 1000);
  assert.equal(totals.generation.responseCount, 1);
  assert.equal(totals.generation.shortResponseCount, 0);
  const merged = addSpeedTotals(updateSpeedTotals(undefined, short, 1), updateSpeedTotals(undefined, long, 1))!;
  assert.equal(merged.generation.shortResponseCount, 1);
  const old = { ...merged, generation: { ...merged.generation } };
  delete old.generation.shortResponseCount;
  assert.equal(coerceSpeedTotals(old)?.generation.generatedTokens, merged.generation.generatedTokens);
  assert.equal(coerceSpeedTotals(old)?.generation.shortResponseCount, 0);
});

test("short acceptance retains strict reasoning, hash, usage, ownership, step and sticky-taint checks", () => {
  for (const change of [
    (p: ReturnType<typeof createContentProgress>) => { taintContentProgress(p, "retry"); },
    (p: ReturnType<typeof createContentProgress>) => { p.fromCurrentStart = false; },
    (p: ReturnType<typeof createContentProgress>) => { noteStepIdentity(p, "another"); },
    (p: ReturnType<typeof createContentProgress>) => { p.parts.get("p")!.receivedBytes = 0; },
    (p: ReturnType<typeof createContentProgress>) => { notePartSnapshot(p, { part: { id: "p", type: "text", text: "world" }, final: true }); },
  ]) {
    const p = timedProgress();
    change(p);
    assert.equal(measured(record(), p).generation, undefined);
  }
  assert.equal(measured(record(100, 1), timedProgress()).generation, undefined);
  assert.equal(measureRecordSpeed(record(), contentSpeedObservations(record(), timedProgress(), undefined, false, true)).generation, undefined);
  assert.equal(measureRecordSpeed(record(), contentSpeedObservations(record(), timedProgress(), undefined, true, true, false)).generation, undefined);
});

test("short output and reasoning share the global-first batch without token subtraction or full-usage substitution", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  notePartSnapshot(progress, { part: { id: "r", type: "reasoning", text: "" } });
  arrival(progress, "r", "rr", 100, 50, "legacy", trustedClock);
  arrival(progress, "p", "o", 100, 50, "legacy", trustedClock);
  arrival(progress, "r", "rr", 250, 200, "legacy", trustedClock);
  arrival(progress, "p", "ooo", 250, 200, "legacy", trustedClock);
  notePartSnapshot(progress, { part: { id: "r", type: "reasoning", text: "rrrr" }, final: true });
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "oooo" }, final: true });
  const speed = measured(record(100, 100), progress);
  assert.equal(speed.generation?.generatedTokens, 125);
  assert.equal(speed.generation?.coverageGeneratedTokens, 200);
  assert.equal(speed.generation?.durationMs, 150);
  assert.equal(speed.generationEvidence?.observationCount, 2);
  assert.equal(speed.generation?.observationQuality, "short");
});

test("long multipart completed span retains silence; trimming a first whitespace snapshot never moves receive boundaries", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  arrival(progress, "first", "\n", 100, 50); // Deliberately old, undeclared clock API.
  notePartSnapshot(progress, { part: { id: "first", type: "text", text: "" }, final: true });
  arrival(progress, "body", "h", 10667.61, 10617.61);
  arrival(progress, "body", "ello", 10924, 10874);
  notePartSnapshot(progress, { part: { id: "body", type: "text", text: "hello" }, final: true });
  const speed = measured(record(100), progress);
  assert.equal(speed.generation?.durationMs, 10824);
  assert.equal(speed.generation?.generatedTokens, 100 * (5 / 6));
  assert.equal(speed.generation?.observationQuality, "standard");
  assert.equal(speed.generationEvidence?.firstReceiveMono, 50);
  assert.equal(selectSpeedMeasurement({ ...record(), speed }).available, true);
});

test("receive-mono span survives backwards wall clock jumps and ignores part/Thinking/step boundaries", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  arrival(progress, "p", "h", 10_000, 10);
  arrival(progress, "p", "ello", 500, 1010);
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello", time: { start: 0, end: 900_000 } } });
  progress.stepEnds = new Set([100, 200, 300]); // legacy metadata is not step identity.
  const current = { ...record(), time: { start: 10_000, firstResponse: 10_001, completed: 1000 } };
  const speed = measured(current, progress);
  assert.equal(speed.generation?.durationMs, 1000);
  assert.equal(speed.generation?.generatedTokens, 80);
  assert.equal(speed.generationEvidence?.start, 10_000);
  assert.equal(speed.generationEvidence?.end, 500);
  assert.equal(selectSpeedMeasurement({ ...current, speed }).rate, 80);
  assert.equal(coerceSpeedContribution(speed)?.generationEvidence?.version, 3);
  assert.equal(speed.response, undefined);
});

test("step identity deduplicates repeats but same-time different steps permanently invalidate", () => {
  const progress = completeProgress();
  noteStepIdentity(progress, "step-1");
  progress.stepEnds = new Set([0, 100, 200]);
  assert.ok(measured(record(), progress).generation);
  noteStepIdentity(progress, "step-2");
  progress.stepIdentities = new Set(["step-1"]); // dropping metadata cannot erase sticky taint.
  assert.equal(measured(record(), progress).generation, undefined);
  const unknown = completeProgress();
  noteStepIdentity(unknown, undefined);
  assert.equal(measured(record(), unknown).generation, undefined);
});

test("retry/busy, failure and known recovery/disconnect taints never reset on the same response", () => {
  for (const reason of ["retry", "failed", "recovery", "disconnect"]) {
    const progress = completeProgress();
    taintContentProgress(progress, reason);
    noteStepIdentity(progress, "step-1"); // repeated busy/start metadata does not reset.
    notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello" }, final: true });
    assert.equal(measured(record(), progress).generation, undefined);
    assert.ok(progress.taints?.has(reason));
    const previous = { tokens: record().tokens, speed: measured() };
    assert.equal(mergeRecordSpeed({ ...record(), speed: measured(record(), progress) }, previous, "invalidated").generation, undefined);
  }
  const unowned = createContentProgress();
  noteStepIdentity(unowned, "step");
  arrival(unowned, "p", "h", 100);
  arrival(unowned, "p", "ello", 1100);
  unowned.fromCurrentStart = true; // cannot retroactively establish current-start ownership.
  notePartSnapshot(unowned, { part: { id: "p", type: "text", text: "hello" }, final: true });
  assert.equal(measured(record(), unowned).generation, undefined);
});

test("same-byte-length replacement snapshots are rejected and digest mismatch is sticky", () => {
  const progress = completeProgress();
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "world" }, final: true });
  assert.equal(progress.parts.get("p")?.deltaBytes, 5);
  assert.equal(progress.parts.get("p")?.finalSnapshotBytes, 5);
  assert.equal(measured(record(), progress).generation, undefined);
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello" }, final: true });
  assert.equal(measured(record(), progress).generation, undefined);
  const intermediate = completeProgress();
  notePartSnapshot(intermediate, { part: { id: "p", type: "text", text: "world" } });
  notePartSnapshot(intermediate, { part: { id: "p", type: "text", text: "hello" }, final: true });
  assert.ok(measured(record(), intermediate).generation); // pending replacement is not a final content fact.
});

test("selected-stream mixing, anonymous data, missing timing and duplicate arrivals cannot qualify", () => {
  const mixed = completeProgress();
  arrival(mixed, "p", "!", 2100, 2100, "v2");
  assert.equal(measured(record(), mixed).generation, undefined);
  const duplicate = completeProgress();
  noteContentArrival(duplicate, { kind: "output", partID: "p", bytes: 1, receivedAt: 1200, receivedMono: 1200, stream: "legacy" });
  assert.equal(measured(record(), duplicate).generation, undefined);
  const backwards = completeProgress();
  parseModelDelta(backwards, { partID: "p" }, { type: "message.part.delta" }, "legacy", "!");
  noteContentArrival(backwards, { kind: "output", partID: "p", bytes: 1, receivedAt: 1200, receivedMono: 0, stream: "legacy" });
  assert.equal(measured(record(), backwards).generation, undefined);
  const anonymous = completeProgress();
  parseModelDelta(anonymous, {}, { type: "message.part.delta" }, "legacy", "!");
  assert.equal(measured(record(), anonymous).generation, undefined);
  const merged = mergeContentProgress(completeProgress(), completeProgress())!;
  assert.equal(measured(record(), merged).generation, undefined);
});

test("usage correction preserves v3 proportions/mono duration and separately recalculates full coverage", () => {
  const original = record(100);
  const prior = { tokens: original.tokens, speed: measured(original) };
  const correctedRecord = { ...record(250), speed: measureRecordSpeed(record(250)) };
  const corrected = mergeRecordSpeed(correctedRecord, prior);
  assert.equal(corrected.generation?.generatedTokens, 200);
  assert.equal(corrected.generation?.coverageGeneratedTokens, 250);
  assert.equal(corrected.generation?.durationMs, 1000);
  assert.deepEqual(corrected.generationEvidence?.bytes, prior.speed.generationEvidence?.bytes);
  assert.equal(corrected.generationEvidence?.usage?.output, 250);
  assert.equal(isQualifiedGenerationContribution(corrected), true);
  assert.equal(mergeRecordSpeed({ ...correctedRecord, tokens: record(250, 1).tokens }, prior).generation, undefined);
  assert.equal(selectSpeedMeasurement({ ...record(250), speed: prior.speed }).available, false); // uncorrected stale numerator.
  const totals = updateSpeedTotals(updateSpeedTotals(undefined, prior.speed, 1), prior.speed, -1);
  const updated = updateSpeedTotals(totals, corrected, 1)!;
  assert.equal(updated.generation.generatedTokens, 200);
  assert.equal(updated.generation.coverageGeneratedTokens, 250);
  assert.equal(updated.generation.responseCount, 1);
});

test("v2 coercion is retained but v3 numerator forgery/short-span/full-usage substitution is never accumulated", () => {
  const valid = measured();
  const legacy = { generation: { generatedTokens: 100, durationMs: 1000, estimated: false },
    generationEvidence: { start: 100, end: 1100, outputObserved: true, reasoningObserved: false, version: 2 as const, coverage: "complete" as const } };
  assert.equal(coerceSpeedContribution(legacy)?.generationEvidence?.version, 2);
  assert.equal(isQualifiedGenerationContribution(legacy), false);
  const baseline = updateSpeedTotals(undefined, valid, 1)!;
  assert.deepEqual(updateSpeedTotals(baseline, legacy, -1), baseline);
  const forged = [
    { ...valid, generation: { ...valid.generation!, generatedTokens: 100 } },
    { ...valid, generation: { ...valid.generation!, estimated: false } },
    { ...valid, generation: { ...valid.generation!, coverageGeneratedTokens: 80 } },
    { ...valid, generationEvidence: { ...valid.generationEvidence!, lastReceiveMono: 101 } },
  ];
  for (const speed of forged) {
    assert.equal(isQualifiedGenerationContribution(speed), false);
    assert.equal(selectSpeedMeasurement({ ...record(), speed }).available, false);
    assert.equal(updateSpeedTotals(undefined, speed, 1)?.generation.responseCount, 0);
    assert.equal(updateSpeedTotals(baseline, speed, -1)?.generation.responseCount, 1);
  }
});

test("coverageGeneratedTokens safely defaults to zero and sums independently of interval tokens", () => {
  const old = { generation: { generatedTokens: 8, durationMs: 1000, responseCount: 1, estimatedResponseCount: 1 },
    response: { generatedTokens: 10, durationMs: 2000, responseCount: 1, estimatedResponseCount: 0 } };
  assert.equal(coerceSpeedTotals(old)?.generation.coverageGeneratedTokens, 0);
  assert.equal(getSessionAverageSummary({ tokens: record().tokens, responseCount: 1, speed: old }).generation.coveredGeneratedTokens, 0);
  const first = updateSpeedTotals(undefined, measured(record(10)), 1);
  const second = updateSpeedTotals(undefined, measured(record(20)), 1);
  const combined = addSpeedTotals(first, second)!;
  assert.equal(combined.generation.generatedTokens, 24);
  assert.equal(combined.generation.coverageGeneratedTokens, 30);
  const summary = getSessionAverageSummary({ tokens: record(30).tokens, responseCount: 2, speed: combined });
  assert.equal(summary.generation.rate, 12);
  assert.equal(summary.generation.coveredGeneratedTokens, 30);
  assert.equal(summary.generation.estimated, true);
});

test("current-start snapshot-first and ahead-of-delta notifications remain pending until matching completion", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello" } });
  assert.equal(progress.taints?.size, 0);
  arrival(progress, "p", "h", 100);
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello" } });
  assert.equal(progress.taints?.size, 0);
  // Even part-final notifications are facts to compare at message completion,
  // not proof that all deltas must already have been delivered at notification.
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello", time: { end: 1100 } } });
  assert.equal(contentSpeedObservations({ ...record(), time: { start: 0 } }, progress, undefined, true, true).generationCoverage?.reasons[0], "unfinished-response");
  arrival(progress, "p", "ello", 1100);
  const speed = measured(record(), progress);
  assert.equal(speed.generation?.generatedTokens, 80);
  assert.equal(speed.generationCoverage, undefined);
  assert.equal(progress.taints?.size, 0);
  const finalDigest = progress.parts.get("p")?.finalSnapshotDigest;
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello", time: { end: 1100 } } });
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "earlier pending" } });
  assert.equal(progress.parts.get("p")?.finalSnapshotDigest, finalDigest);
  assert.equal(measured(record(), progress).generation?.generatedTokens, 80);
});

test("pending snapshot evidence does not establish or resurrect cache/recovery ownership", () => {
  const recovered = createContentProgress();
  noteStepIdentity(recovered, "step");
  notePartSnapshot(recovered, { part: { id: "p", type: "text", text: "hello" } });
  assert.equal(recovered.fromCurrentStart, false);
  assert.equal(recovered.taints?.size, 0); // phase-unknown snapshot is pending, not a recovery guess.
  arrival(recovered, "p", "h", 100);
  arrival(recovered, "p", "ello", 1100);
  notePartSnapshot(recovered, { part: { id: "p", type: "text", text: "hello" }, final: true });
  assert.equal(measured(record(), recovered).generation, undefined);
  const fresh = createContentProgress({ fromCurrentStart: true });
  assert.equal(measured(record(), mergeContentProgress(fresh, recovered)!).generation, undefined);
});

test("a genuine missing delta rejects at completion and persists a compact gap diagnostic", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello" } });
  arrival(progress, "p", "h", 100);
  arrival(progress, "p", "ell", 1100);
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello" }, final: true });
  assert.equal(progress.taints?.size, 0);
  const speed = measured(record(), progress);
  assert.equal(speed.generation, undefined);
  assert.deepEqual(speed.generationCoverage, { status: "gap", reasons: ["snapshot-delta-gap"] });
  assert.deepEqual(coerceSpeedContribution(JSON.parse(JSON.stringify(speed)))?.generationCoverage, speed.generationCoverage);
  assert.equal(selectSpeedMeasurement({ ...record(), speed }).available, false);
  assert.ok(progress.taints?.has("snapshot-delta-gap"));
});

test("host trailing-whitespace removal accepts the same calibrated RAW byte proportions", () => {
  const raw = "hello \n";
  const progress = completeProgress("text", raw);
  const strict = measured(record(100, 0), progress);
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: raw.trimEnd() }, final: true });
  const trimmed = measured(record(100, 0), progress);
  assert.deepEqual(trimmed.generation, strict.generation);
  assert.deepEqual(trimmed.generationEvidence, strict.generationEvidence);
  assert.equal(trimmed.generation?.generatedTokens, 100 * (6 / 7));
  assert.equal(trimmed.generation?.coverageGeneratedTokens, 100);
  assert.deepEqual(trimmed.generationEvidence?.bytes?.output, { total: 7, firstBatch: 1 });
  assert.equal(trimmed.generationEvidence?.version, 3);
  assert.equal(trimmed.generation?.estimated, true);
  assert.equal(trimmed.generationCoverage, undefined);
  assert.equal(isQualifiedGenerationContribution(trimmed), true);
  const corrected = mergeRecordSpeed({ ...record(200, 0), speed: measureRecordSpeed(record(200, 0)) }, { tokens: record().tokens, speed: trimmed });
  assert.equal(corrected.generation?.generatedTokens, 200 * (6 / 7));
  // Official zero reasoning and an empty completed metadata-only reasoning part
  // do not create samples or invalidate a completely observed output stream.
  notePartSnapshot(progress, { part: { id: "r", type: "reasoning", text: "", metadata: true }, final: true });
  assert.equal(measured(record(100, 0), progress).generation?.generatedTokens, strict.generation?.generatedTokens);
  assert.equal(measured(record(100, 1), progress).generation, undefined);
});

test("bounded canonical checkpoints retain internal whitespace across chunks and arbitrarily long whitespace tails", () => {
  const progress = createContentProgress({ fromCurrentStart: true });
  noteStepIdentity(progress, "step");
  arrival(progress, "p", "h", 100);
  arrival(progress, "p", "ello", 200);
  arrival(progress, "p", " \n", 300);
  arrival(progress, "p", "world", 1100);
  for (let index = 0; index < 16; index++) arrival(progress, "p", " \t\n".repeat(1024), 1100);
  notePartSnapshot(progress, { part: { id: "p", type: "text", text: "hello \nworld" }, final: true });
  const part = progress.parts.get("p")!;
  assert.equal(part.trimEndBytes, utf8ByteLength("hello \nworld"));
  assert.equal(part.trimEndHasher?.copy().digest("hex").length, 64);
  assert.equal(part.deltaHasher?.copy().digest("hex").length, 64);
  assert.equal(part.deltaBytes, 12 + 16 * 3072);
  assert.equal(measured(record(), progress).generation?.generatedTokens, 100 * ((part.deltaBytes - 1) / part.deltaBytes));
  assert.equal(Object.values(part).some((value) => typeof value === "string" && value.length > 64), false);
});

test("canonical matching never trims both sides, removes internal text, accepts extra snapshot whitespace or redacts reasoning", () => {
  for (const [raw, final] of [[" hello \n", "hello"], ["hello \n", "hello "], ["hello", "hello\n"],
    ["hello \nworld \t", "helloworld"], ["hello\n", "world"], ["hello\u200b", "hello"]]) {
    const progress = completeProgress("text", raw);
    notePartSnapshot(progress, { part: { id: "p", type: "text", text: final }, final: true });
    const speed = measured(record(), progress);
    assert.equal(speed.generation, undefined, `${JSON.stringify(raw)} -> ${JSON.stringify(final)}`);
    assert.equal(speed.generationCoverage?.status, "gap");
  }
  const reasoning = completeProgress("reasoning", "thinking\n");
  notePartSnapshot(reasoning, { part: { id: "p", type: "reasoning", text: "[REDACTED]" }, final: true });
  assert.equal(measured(record(0, 100), reasoning).generation, undefined);
});

test("tool uncertainty stays sticky for its message, without crossing into a fresh response", () => {
  const old = completeProgress();
  notePartSnapshot(old, { part: { id: "tool", type: "tool", state: { status: "completed" } } });
  assert.deepEqual(measured(record(), old).generationCoverage, { status: "unknown", reasons: ["tool-usage-uncertain"] });
  const fresh = completeProgress();
  assert.equal(measured({ ...record(), messageID: "new-message" }, fresh).generation?.generatedTokens, 80);
  assert.equal(fresh.taints?.size, 0);
});

test("persisted rejection diagnostics are allowlisted, deduplicated and bounded without raw event text", () => {
  const reasons = ["snapshot-delta-gap", "snapshot-delta-gap", "secret provider/reasoning text", "retry", "failed", "recovery",
    "disconnect", "hidden-reasoning", "tool-usage-uncertain", "mixed-streams", "insufficient-receive-span"];
  const diagnostic = coerceSpeedContribution({ generationCoverage: { status: "gap", reasons } });
  assert.equal(diagnostic?.generationCoverage?.reasons.length, 8);
  assert.deepEqual(diagnostic?.generationCoverage?.reasons, ["snapshot-delta-gap", "retry", "failed", "recovery", "disconnect", "hidden-reasoning", "tool-usage-uncertain", "mixed-streams"]);
  assert.deepEqual(coerceSpeedContribution({ generationCoverage: { status: "unknown", reasons: ["x".repeat(1024)] } }),
    { generationCoverage: { status: "unknown", reasons: ["unknown-coverage"] } });
  assert.equal(coerceSpeedContribution({ generationCoverage: { status: "bogus", reasons: ["retry"] } }), undefined);
  assert.equal(coerceSpeedContribution({ generationCoverage: { status: "gap", reasons: "retry" } }), undefined);
});

test("qualified new/corrected generation clears old diagnostics, explicit invalidation keeps current meaningful reason", () => {
  const bad = { status: "gap" as const, reasons: ["snapshot-delta-gap"] };
  const observations = contentSpeedObservations(record(), completeProgress(), undefined, true, true);
  const speed = measureRecordSpeed(record(), { ...observations, generationCoverage: bad });
  assert.ok(speed.generation);
  assert.equal(speed.generationCoverage, undefined);
  const prior = { tokens: record().tokens, speed };
  const incoming = { ...record(200), speed: { ...measureRecordSpeed(record(200)), generationCoverage: bad } };
  const corrected = mergeRecordSpeed(incoming, prior);
  assert.equal(corrected.generation?.generatedTokens, 160);
  assert.equal(corrected.generationCoverage, undefined);
  const invalidated = mergeRecordSpeed(incoming, prior, "invalidated");
  assert.equal(invalidated.generation, undefined);
  assert.deepEqual(invalidated.generationCoverage, bad);
  const previousRejection = { tokens: record().tokens, speed: { generationCoverage: bad } };
  assert.deepEqual(mergeRecordSpeed({ ...record(), speed: measureRecordSpeed(record()) }, previousRejection, "invalidated").generationCoverage, bad);
  assert.deepEqual(mergeRecordSpeed(record(), prior, "invalidated").generationCoverage,
    { status: "unknown", reasons: ["generation-invalidated"] });
  assert.equal(mergeRecordSpeed({ ...record(), speed }, previousRejection).generationCoverage, undefined);
});
