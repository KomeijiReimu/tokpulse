import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoryRecord,
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
  assert.equal(rollingTokenRate(samples, 2_000, 1_500), 60);
  assert.deepEqual(calculateRateStats([10, 20, 30]), { avg: 20, max: 30, min: 10 });
  assert.deepEqual(calculateSpeedStats([second, third]), { avg: 40, max: 40, min: 40 });
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
