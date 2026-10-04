import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoryRecord,
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
  utf8ByteLength,
} from "../src/core.js";

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
  assert.equal(samples.length, 2);
  // The first retained batch is the baseline, not arrivals during this interval.
  assert.equal(rollingTokenRate(samples, 2_000, 1_500), 40);
  assert.deepEqual(calculateRateStats([10, 20, 30]), { avg: 20, max: 30, min: 10 });
  assert.deepEqual(calculateSpeedStats([second, third]), { avg: 40, max: 40, min: 40 });
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

test("left window boundary excludes its baseline batch and matches count to duration", () => {
  const samples = [
    { timestamp: 0, tokens: 1_000 },
    { timestamp: 1_000, tokens: 100 },
    { timestamp: 1_500, tokens: 5 },
    { timestamp: 2_500, tokens: 10 },
  ];
  assert.deepEqual(measureRollingTokenRate(samples, 2_500, 1_500), {
    status: "ready", rate: 10, elapsedMs: 1_500, observedTokens: 15, observationCount: 3,
  });
  // Moving past that batch also moves the denominator's start to the next point.
  assert.deepEqual(measureRollingTokenRate(samples, 2_501, 1_500), {
    status: "ready", rate: (10 / 1_001) * 1000, elapsedMs: 1_001, observedTokens: 10, observationCount: 2,
  });
  assert.equal(measureRollingTokenRate(samples, 2_500, 999).status, "warming");
});

test("recent silence lowers the arrival estimate and a full-window pause becomes inactive", () => {
  const samples = [{ timestamp: 0, tokens: 10 }, { timestamp: 1_000, tokens: 10 }];
  assert.equal(rollingTokenRate(samples, 2_000), 5);
  assert.equal(measureRollingTokenRate(samples, 10_999).status, "warming");
  assert.equal(measureRollingTokenRate(samples, 11_000).status, "inactive");
  assert.equal(rollingTokenRate(samples, 11_000), 0);
  assert.equal(measureRollingTokenRate(samples, 20_000).status, "inactive");
  const zeroUpdate = [...samples, { timestamp: 11_000, tokens: 0 }];
  assert.equal(measureRollingTokenRate(zeroUpdate, 11_000).status, "inactive");
  const resumed = [...samples, { timestamp: 12_000, tokens: 100 }];
  assert.equal(measureRollingTokenRate(resumed).status, "warming");
  assert.equal(rollingTokenRate([...resumed, { timestamp: 13_000, tokens: 10 }]), 10);
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
