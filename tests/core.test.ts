import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentName, normalizeAgentNames } from "../src/agent-names.js";
import {
  HistoryRecord,
  type SpeedSample,
  type RollingRateMeasurement,
  MIN_ROLLING_OBSERVATION_MS,
  aggregateSessionTree,
  appendSpeedSample,
  bytesToTokens,
  calibrateEstimatedOutput,
  calculateRateStats,
  calculateResponseStats,
  calculateSpeedStats,
  calculateTTFTStats,
  createSpeedSample,
  formatDuration,
  formatNumber,
  formatTokens,
  measureRollingTokenRate,
  normalizeTokenCounts,
  rollingTokenRate,
  timeToFirstToken,
  utf8ByteLength,
} from "../src/core.js";

/** Frozen pre-optimization implementation: independent truth oracle in tests only. */
function referenceRollingRate(samples: readonly SpeedSample[], now?: number, windowMs = 10_000): RollingRateMeasurement {
  const empty: RollingRateMeasurement = { status: "warming", rate: 0, elapsedMs: 0, observedTokens: 0, observationCount: 0 };
  const ordered = samples.filter((sample) => Number.isFinite(sample.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const referenceNow = now ?? ordered.at(-1)?.timestamp;
  if (referenceNow === undefined || !Number.isFinite(referenceNow) || !Number.isFinite(windowMs) || windowMs < 0) return empty;
  const cutoff = referenceNow - windowMs;
  const points: { timestamp: number; tokens: number }[] = [];
  let latestObservationAt: number | undefined;
  let latestTokenAt: number | undefined;
  for (const sample of ordered) {
    if (sample.timestamp > referenceNow) break;
    latestObservationAt = sample.timestamp;
    const raw = sample.estimatedTokens ?? sample.tokens;
    const tokens = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    if (tokens > 0) latestTokenAt = sample.timestamp;
    const previous = points.at(-1);
    if (previous?.timestamp === sample.timestamp) previous.tokens += tokens;
    else {
      if (previous && sample.timestamp - previous.timestamp > windowMs) points.length = 0;
      points.push({ timestamp: sample.timestamp, tokens });
    }
  }
  const baseline = points.length > 0 ? Math.max(cutoff, points[0].timestamp) : referenceNow;
  const elapsedMs = referenceNow - baseline;
  let observedTokens = 0;
  let observationCount = points.filter((point) => point.timestamp >= cutoff).length;
  if (points.some((point) => point.timestamp < cutoff) && (points.find((point) => point.timestamp >= cutoff)?.timestamp ?? cutoff) > cutoff) observationCount += 1;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    if (point.timestamp <= baseline) continue;
    const fraction = (point.timestamp - Math.max(baseline, previous.timestamp)) / (point.timestamp - previous.timestamp);
    observedTokens += point.tokens * fraction;
  }
  const measurement = { ...empty, elapsedMs, observedTokens, observationCount };
  const lastActivityAt = latestTokenAt ?? latestObservationAt;
  if (lastActivityAt !== undefined && referenceNow - lastActivityAt >= windowMs) return { ...measurement, status: "inactive" };
  if (observationCount < 2 || elapsedMs < 1000) return measurement;
  const rate = (observedTokens / elapsedMs) * 1000;
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(rate)) return measurement;
  return { ...measurement, status: "ready", rate };
}

function referenceSpeedStats(samples: readonly SpeedSample[]) {
  const timestamps = [...new Set(samples.filter((sample) => Number.isFinite(sample.timestamp)).map((sample) => sample.timestamp))].sort((a, b) => a - b);
  const rates: number[] = [];
  for (const timestamp of timestamps) {
    const measurement = referenceRollingRate(samples, timestamp);
    if (measurement.status === "ready") rates.push(measurement.rate);
  }
  return { ...calculateRateStats(rates), available: rates.length > 0, extremaAvailable: rates.length > 0, estimated: true };
}

function assertSpeedStatsEquivalent(samples: readonly SpeedSample[]) {
  const expected = referenceSpeedStats(samples);
  const actual = calculateSpeedStats(samples);
  assert.equal(actual.available, expected.available);
  assert.equal(actual.extremaAvailable, expected.extremaAvailable);
  assert.equal(actual.estimated, expected.estimated);
  // Prefix subtraction changes only floating-point summation order, not windows.
  for (const field of ["avg", "min", "max"] as const) {
    assert.ok(Math.abs(actual[field] - expected[field]) <= 1e-10 * Math.max(1, Math.abs(expected[field])), `${field}: ${actual[field]} != ${expected[field]}`);
  }
}

function record(
  messageID: string,
  sessionID: string,
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    version: 1,
    messageID,
    sessionID,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 2,
      cacheRead: 3,
      cacheWrite: 4,
    },
    cost: 1.5,
    time: {
      start: 0,
      firstToken: 100,
      completed: 1_100,
      ttft: 100,
      duration: 1_100,
    },
    samples: [],
    ...overrides,
  };
}

test("bytes-to-token estimation handles defaults and invalid input", () => {
  assert.equal(bytesToTokens(0), 0);
  assert.equal(bytesToTokens(-10), 0);
  assert.equal(bytesToTokens(11), 2);
  assert.equal(bytesToTokens(22, 11), 2);
  assert.equal(bytesToTokens(10, 0), 0);
  assert.equal(utf8ByteLength("hello"), 5);
});

test("normalizes OpenCode and raw AI SDK token shapes into canonical counts", () => {
  assert.deepEqual(normalizeTokenCounts({
    input: 10,
    output: 20,
    reasoning: 3,
    cache: { read: 4, write: 5 },
  }), {
    input: 10,
    output: 20,
    reasoning: 3,
    cacheRead: 4,
    cacheWrite: 5,
  });
  assert.deepEqual(normalizeTokenCounts({
    input: 1,
    output: 2,
    reasoning: 3,
    cacheRead: 4,
    cacheWrite: 5,
  }), {
    input: 1,
    output: 2,
    reasoning: 3,
    cacheRead: 4,
    cacheWrite: 5,
  });

  assert.deepEqual(normalizeTokenCounts({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 40,
    inputTokenDetails: { cacheWriteTokens: 10 },
    outputTokenDetails: { reasoningTokens: 15 },
  }), {
    input: 70,
    output: 25,
    reasoning: 15,
    cacheRead: 20,
    cacheWrite: 10,
  });

  assert.deepEqual(normalizeTokenCounts({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 40,
    reasoningTokens: 15,
  }), {
    input: 80,
    output: 25,
    reasoning: 15,
    cacheRead: 20,
    cacheWrite: 0,
  });

  assert.deepEqual(normalizeTokenCounts({ inputTokens: 12, outputTokens: 8 }), {
    input: 12,
    output: 8,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("rolling samples and rate stats respect the time window", () => {
  const first = createSpeedSample(55, 0);
  const second = createSpeedSample(110, 1_000);
  const third = createSpeedSample(220, 2_000);
  const samples = appendSpeedSample(appendSpeedSample([first], second, 1_500), third, 1_500);
  assert.equal(samples.length, 3);
  // Retained predecessor permits a fractional left-edge batch contribution.
  assert.equal(rollingTokenRate(samples, 2_000, 1_500), 50_000 / 1_500);
  assert.deepEqual(calculateRateStats([10, 20, 30]), { avg: 20, max: 30, min: 10 });
  assert.deepEqual(calculateSpeedStats([second, third]), { avg: 40, max: 40, min: 40,
    available: true, extremaAvailable: true, estimated: true });
});

test("rolling rate warms up instead of dividing the first chunk by 20ms", () => {
  const samples = [{ timestamp: 100, tokens: 10 }];
  assert.equal(MIN_ROLLING_OBSERVATION_MS, 1_000);
  assert.deepEqual(measureRollingTokenRate(samples, 120), {
    status: "warming", rate: 0, elapsedMs: 20, observedTokens: 0, observationCount: 1,
  });
  assert.equal(rollingTokenRate(samples, 120), 0);
  assert.equal(measureRollingTokenRate(samples, 1_100).status, "warming");
  const second = [...samples, { timestamp: 120, tokens: 10 }];
  assert.equal(measureRollingTokenRate(second, 120).status, "warming");
  assert.equal(rollingTokenRate(second, 120), 0);
  assert.equal(measureRollingTokenRate(second, 1_099).status, "warming");
  assert.equal(measureRollingTokenRate(second, 1_100).rate, 10);
});

test("same-millisecond chunks form one observation and one entire baseline", () => {
  const baseline = [{ timestamp: 0, tokens: 3 }, { timestamp: 0, tokens: 7 }];
  assert.equal(measureRollingTokenRate(baseline, 1_000).status, "warming");
  const split = [...baseline, { timestamp: 1_000, tokens: 4 }, { timestamp: 1_000, tokens: 6 }];
  const merged = [{ timestamp: 0, tokens: 10 }, { timestamp: 1_000, tokens: 10 }];
  assert.deepEqual(measureRollingTokenRate(split), measureRollingTokenRate(merged));
  assert.deepEqual(measureRollingTokenRate(split), {
    status: "ready", rate: 10, elapsedMs: 1_000, observedTokens: 10, observationCount: 2,
  });
  assert.deepEqual(measureRollingTokenRate([...split].reverse()), measureRollingTokenRate(split));
  assert.equal(split.length, 4);
});

test("uniform arrivals give their observable rate without a speed cap", () => {
  const uniform = Array.from({ length: 21 }, (_, index) => ({ timestamp: index * 100, tokens: 2 }));
  assert.equal(rollingTokenRate(uniform), 20);
  assert.equal(rollingTokenRate([{ timestamp: 0, tokens: 50_000 }, { timestamp: 1_000, tokens: 50_000 }]), 50_000);
});

test("left window boundary interpolates cumulative counts without dropping the next batch", () => {
  const samples = [
    { timestamp: 0, tokens: 1_000 },
    { timestamp: 1_000, tokens: 100 },
    { timestamp: 1_500, tokens: 5 },
    { timestamp: 2_500, tokens: 10 },
  ];
  assert.deepEqual(measureRollingTokenRate(samples, 2_500, 1_500), {
    status: "ready", rate: 10, elapsedMs: 1_500, observedTokens: 15, observationCount: 3,
  });
  // Moving one millisecond past the edge removes 1/500 of the next five tokens.
  assert.deepEqual(measureRollingTokenRate(samples, 2_501, 1_500), {
    status: "ready", rate: (14.99 / 1_500) * 1000, elapsedMs: 1_500, observedTokens: 14.99, observationCount: 3,
  });
  assert.equal(measureRollingTokenRate(samples, 2_500, 999).status, "warming");
});

test("recent silence lowers the arrival estimate and a full-window pause becomes inactive", () => {
  const samples = [{ timestamp: 0, tokens: 10 }, { timestamp: 1_000, tokens: 10 }];
  assert.equal(rollingTokenRate(samples, 2_000), 5);
  assert.equal(measureRollingTokenRate(samples, 10_999).status, "ready");
  assert.equal(measureRollingTokenRate(samples, 11_000).status, "inactive");
  assert.equal(rollingTokenRate(samples, 11_000), 0);
  assert.equal(measureRollingTokenRate(samples, 20_000).status, "inactive");
  const zeroUpdate = [...samples, { timestamp: 11_000, tokens: 0 }];
  assert.equal(measureRollingTokenRate(zeroUpdate, 11_000).status, "inactive");
  const resumed = [...samples, { timestamp: 12_000, tokens: 100 }];
  assert.equal(measureRollingTokenRate(resumed).status, "warming");
  assert.equal(rollingTokenRate([...resumed, { timestamp: 13_000, tokens: 10 }]), 10);
});

test("audit left-edge trajectory stays continuous and retains the predecessor batch", () => {
  const samples = [{ timestamp: 1_000, tokens: 1 }, { timestamp: 10_000, tokens: 100 }, { timestamp: 11_000, tokens: 1 }];
  const before = measureRollingTokenRate(samples, 11_000);
  const after = measureRollingTokenRate(samples, 11_001);
  assert.equal(before.rate, 10.1);
  assert.ok(Math.abs(after.rate - before.rate) < 0.002);
  assert.equal(after.elapsedMs, 10_000);
  assert.equal(after.observationCount, 3);
  const kept = appendSpeedSample(samples.slice(0, 2), samples[2]);
  assert.deepEqual(measureRollingTokenRate(kept, 11_001), after);
  const splitPredecessor = [{ timestamp: 1_000, tokens: 0.5 }, { timestamp: 1_000, tokens: 0.5 }, ...samples.slice(1)];
  assert.equal(appendSpeedSample(splitPredecessor.slice(0, 3), splitPredecessor[3], 9_999).length, 4);
  assert.deepEqual(measureRollingTokenRate(splitPredecessor, 11_001), after);
});

test("historical extrema require the same supported window as LIVE, not millisecond ratios or average fallback", () => {
  const insufficient = calculateSpeedStats([{ timestamp: 100, tokens: 1 }, { timestamp: 101, tokens: 100 }]);
  assert.equal(insufficient.available, false);
  assert.equal(insufficient.extremaAvailable, false);
  assert.equal(insufficient.max, 0);
  const samples = [{ timestamp: 100, tokens: 1 }, { timestamp: 101, tokens: 100 }, { timestamp: 1_100, tokens: 1 }];
  const stats = calculateSpeedStats(samples);
  assert.equal(stats.max, 101);
  assert.equal(stats.min, measureRollingTokenRate(samples, 1_100).rate);
  assert.equal(stats.extremaAvailable, true);
  assert.equal(stats.estimated, true);
  assert.equal(calculateSpeedStats([{ timestamp: 0, tokens: 5 }, { timestamp: 0, tokens: 5 }]).available, false);
});

test("completed-sized observations cannot lower the one-second LIVE or extrema threshold", () => {
  const short = [{ timestamp: 100, tokens: 20 }, { timestamp: 250, tokens: 80 }];
  assert.equal(measureRollingTokenRate(short).status, "warming");
  assert.deepEqual(calculateSpeedStats(short), { avg: 0, max: 0, min: 0, available: false, extremaAvailable: false, estimated: true });
  assert.equal(measureRollingTokenRate([...short, { timestamp: 1100, tokens: 0 }]).status, "ready");
});

test("optimized historical windows match the frozen oracle at irregular boundaries, gaps and inactive zero observations", () => {
  const cases: SpeedSample[][] = [
    [], [{ timestamp: NaN, tokens: 1 }], [{ timestamp: 0, tokens: 1 }],
    [{ timestamp: 100, tokens: 1 }, { timestamp: 101, tokens: 100 }],
    [{ timestamp: 0, tokens: 50 }, { timestamp: 999, tokens: 100 }, { timestamp: 1000, tokens: 0 }],
    [{ timestamp: 1000, tokens: 1 }, { timestamp: 10000, tokens: 100 }, { timestamp: 11000, tokens: 1 }, { timestamp: 11001, tokens: 2 }],
    [{ timestamp: 0, tokens: 5 }, { timestamp: 1000, tokens: 10 }, { timestamp: 11000, tokens: 0 }, { timestamp: 11001, tokens: 0 }, { timestamp: 22000, tokens: 100 }, { timestamp: 23000, tokens: 0 }],
    [{ timestamp: 0, tokens: 0 }, { timestamp: 1000, tokens: 0 }, { timestamp: 11000, tokens: 0 }, { timestamp: 11001, tokens: 0 }],
    [{ timestamp: 0, tokens: 1 }, { timestamp: 10001, tokens: 0 }, { timestamp: 11001, tokens: 0 }],
    [{ timestamp: 0, tokens: 10 }, { timestamp: 10000, tokens: 20 }, { timestamp: 20000, tokens: 30 }],
    [{ timestamp: 0, tokens: 1 }, { timestamp: 1000, tokens: 1e20 }, { timestamp: 11000, tokens: 1 }, { timestamp: 11001, tokens: 1 }],
    [{ timestamp: 0, tokens: 1 }, { timestamp: 1000, tokens: 1e14 }, { timestamp: 11000, tokens: 0.01 }, { timestamp: 11001, tokens: 0.01 }],
    [{ timestamp: 0, tokens: 1 }, { timestamp: 1000, tokens: Number.MAX_VALUE }, { timestamp: 2000, tokens: Number.MAX_VALUE }, { timestamp: 12000, tokens: 1 }, { timestamp: 12001, tokens: 1 }],
    [{ timestamp: 0, tokens: 10 }, { timestamp: 1000, tokens: 20, estimatedTokens: NaN }, { timestamp: 2000, tokens: 30, estimatedTokens: 0 }],
    [{ timestamp: 1000, tokens: 100, estimatedTokens: 4 }, { timestamp: NaN, tokens: 100 }, { timestamp: 0, tokens: 3 }, { timestamp: 1000, tokens: 100, estimatedTokens: 6 }, { timestamp: Infinity, tokens: 100 }, { timestamp: 2000, tokens: -10 }, { timestamp: 2000, tokens: 30 }],
  ];
  for (const samples of cases) {
    assertSpeedStatsEquivalent(samples);
    assertSpeedStatsEquivalent([...samples].reverse());
    for (const now of [undefined, -1, 0, 1000, 11000, 11001, 50000, NaN, Infinity]) {
      for (const window of [0, 1, 999, 1000, 1500, 10000, NaN, -1]) {
        assert.deepEqual(measureRollingTokenRate(samples, now, window), referenceRollingRate(samples, now, window));
      }
    }
  }
});

test("fixed-seed randomized extrema and LIVE measurements match independent old implementation without input mutation", () => {
  let seed = 0x5eed1234;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let run = 0; run < 100; run++) {
    let timestamp = -1000;
    const samples: SpeedSample[] = [];
    for (let index = 0; index < 80; index++) {
      timestamp += [0, 1, 99, 150, 999, 1000, 1501, 10000, 10001][Math.floor(random() * 9)];
      const tokens = [0, -1, NaN, Infinity, 1, random() * 100][Math.floor(random() * 6)];
      samples.push({ timestamp: random() < 0.03 ? NaN : timestamp, tokens,
        ...(random() < 0.4 ? { estimatedTokens: [undefined, 0, NaN, random() * 10][Math.floor(random() * 4)] } : {}) });
    }
    for (let index = samples.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [samples[index], samples[other]] = [samples[other], samples[index]];
    }
    const snapshot = samples.map((sample) => ({ ...sample }));
    assertSpeedStatsEquivalent(samples);
    for (const window of [1000, 1500, 10000]) {
      for (const now of [undefined, timestamp - random() * 20000, timestamp + random() * 20000]) {
        assert.deepEqual(measureRollingTokenRate(samples, now, window), referenceRollingRate(samples, now, window));
      }
    }
    assert.deepEqual(samples, snapshot);
    assertSpeedStatsEquivalent(samples);
  }
});

test("final usage calibration leaves byte-arrival speed and extrema estimated", () => {
  const raw = [createSpeedSample(55, 0), createSpeedSample(55, 1_000)];
  const calibrated = calibrateEstimatedOutput(raw, 2_000);
  assert.equal(calibrated[1].tokens, 1_000);
  assert.equal(rollingTokenRate(calibrated), rollingTokenRate(raw));
  assert.deepEqual(calculateSpeedStats(calibrated), calculateSpeedStats(raw));
});

test("UI TTFT prefers a valid first response, independently of the first-content alias", () => {
  const time = { start: 100, firstResponse: 200, firstContent: 500, firstToken: 500, completed: 900, ttft: 400 };
  assert.equal(timeToFirstToken({ time }), 100);
  assert.equal(timeToFirstToken({ time: { ...time, firstResponse: 99 } }), 400);
  assert.equal(timeToFirstToken({ time: { ...time, firstResponse: 1_000 } }), 400);
  assert.equal(timeToFirstToken({ time: { start: 0, firstToken: 100 } }), 100);
});

test("reasoning arrivals participate in the same rate and baseline as output", () => {
  const samples = [
    createSpeedSample(55, 0, "reasoning"),
    createSpeedSample(55, 1_000, "reasoning"),
    createSpeedSample(55, 1_000, "output"),
    createSpeedSample(110, 2_000, "output"),
  ];
  assert.deepEqual(measureRollingTokenRate(samples), {
    status: "ready", rate: 20, elapsedMs: 2_000, observedTokens: 40, observationCount: 3,
  });
});

test("rolling arrival measurement safely handles invalid inputs and future observations", () => {
  const samples = [
    { timestamp: NaN, tokens: 1_000 },
    { timestamp: Infinity, tokens: 1_000 },
    { timestamp: -Infinity, tokens: 1_000 },
    { timestamp: 0, tokens: 10 },
    { timestamp: 500, tokens: -10 },
    { timestamp: 500, tokens: NaN },
    { timestamp: 500, tokens: Infinity },
    { timestamp: 1_000, tokens: 10 },
  ];
  assert.equal(rollingTokenRate(samples), 10);
  assert.equal(rollingTokenRate([...samples, { timestamp: 2_000, tokens: 1_000 }], 1_000), 10);
  assert.equal(measureRollingTokenRate([{ timestamp: 2_000, tokens: 10 }], 1_000).status, "warming");
  assert.equal(measureRollingTokenRate([]).status, "warming");
  assert.equal(rollingTokenRate([{ timestamp: NaN, tokens: 10 }]), 0);
  for (const now of [NaN, Infinity, -Infinity]) assert.equal(rollingTokenRate(samples, now), 0);
  for (const windowMs of [NaN, Infinity, -Infinity, -1, 0]) {
    assert.equal(rollingTokenRate(samples, 1_000, windowMs), 0);
  }
});

test("estimated output samples calibrate to the exact final output count", () => {
  const samples = [
    { timestamp: 0, tokens: 1, estimatedTokens: 1, kind: "output" as const },
    { timestamp: 100, tokens: 2, estimatedTokens: 2, kind: "output" as const },
    { timestamp: 200, tokens: 1, estimatedTokens: 1, kind: "output" as const },
    { timestamp: 300, tokens: 9, estimatedTokens: 9, kind: "reasoning" as const },
  ];
  const calibrated = calibrateEstimatedOutput(samples, 8);
  assert.deepEqual(calibrated.map((sample) => sample.tokens), [2, 4, 2, 9]);
  assert.equal(calibrated.filter((sample) => sample.kind === "output").reduce((sum, sample) => sum + sample.tokens, 0), 8);
});

test("session tree deduplicates message IDs and aggregates child sessions", () => {
  const records = [
    record("root-1", "root", { cost: 2 }),
    record("root-1", "root", { cost: 9, tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 } }),
    record("child-1", "child", { parentSessionID: "root", cost: 3 }),
    record("grandchild-1", "grandchild", { parentSessionID: "child", cost: 4 }),
  ];
  const [root] = aggregateSessionTree(records);
  assert.equal(root.responseCount, 3);
  assert.equal(root.cost, 16);
  assert.deepEqual(root.tokens, {
    input: 21,
    output: 42,
    reasoning: 7,
    cacheRead: 10,
    cacheWrite: 13,
  });
  assert.equal(root.children[0].responseCount, 2);
  assert.equal(root.children[0].children[0].sessionID, "grandchild");
});

test("response stats include speed and TTFT boundaries", () => {
  const one = record("one", "s", {
    tokens: { input: 0, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    time: { start: 0, firstToken: 100, completed: 1_100, ttft: 100, duration: 1_100 },
  });
  const two = record("two", "s", {
    tokens: { input: 0, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    time: { start: 0, firstToken: 300, completed: 1_300, ttft: 300, duration: 1_300 },
  });
  assert.deepEqual(calculateTTFTStats([one, two]), { avg: 200, max: 300, min: 100 });
  assert.equal(calculateResponseStats([one, two]).responses, 2);
  assert.deepEqual(calculateResponseStats([one, two]).duration, { avg: 1_200, max: 1_300, min: 1_100 });
  assert.equal(formatNumber(1234.5), "1,234.5");
  assert.equal(formatTokens(1234.5), "1,235");
  assert.equal(formatDuration(65_000), "1m 05s");
});

test("agent names trim, reject controls and compaction, and sort without a whitelist", () => {
  const max = "a".repeat(256);
  assert.equal(normalizeAgentName(`  custom-worker  `), "custom-worker");
  assert.equal(normalizeAgentName(max), max);
  assert.equal(normalizeAgentName(` ${max} `), max);
  assert.equal(normalizeAgentName(`${max}b`), undefined);
  assert.equal(normalizeAgentName(" compaction "), undefined);
  assert.equal(normalizeAgentName("Compaction"), "Compaction");
  assert.equal(normalizeAgentName("bad\u001bname"), undefined);
  assert.equal(normalizeAgentName("bad\nname"), undefined);
  assert.equal(normalizeAgentName("  "), undefined);
  assert.equal(normalizeAgentName(1), undefined);
  assert.equal(normalizeAgentName({ agent: "fixer" }), undefined);
  assert.deepEqual(normalizeAgentNames([" oracle ", "fixer", "fixer", "compaction", "", "bad\nname", "x".repeat(257), "bad\u001bname"]), ["fixer", "oracle"]);
  assert.deepEqual(normalizeAgentNames("fixer"), []);
  assert.deepEqual(normalizeAgentNames(null), []);
});
