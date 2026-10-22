import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentName, normalizeAgentNames } from "../src/agent-names.js";
import { rollupSessionTotals } from "../src/totals-aggregate.js";
import {
  HistoryRecord,
  aggregateSessionTree,
  bytesToTokens,
  formatDuration,
  formatNumber,
  formatTokens,
  normalizeTokenCounts,
  utf8ByteLength,
} from "../src/core.js";

test("core and totals aggregation preserve special session/message keys without prototype lookup", () => {
  const records: HistoryRecord[] = ["__proto__", "constructor", "toString"].map((sessionID, i) => ({
    version: 1, messageID: sessionID, sessionID, ...(i ? { parentSessionID: "__proto__" } : {}),
    tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 1,
    time: { start: 0, completed: 10 }, samples: [],
  }));
  const tree = aggregateSessionTree(records);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].sessionID, "__proto__");
  assert.equal(tree[0].responseCount, 3);
  const sessions = Object.fromEntries(records.map((record) => [record.sessionID, { tokens: record.tokens, cost: record.cost, responseCount: 1 }]));
  const totals = rollupSessionTotals(sessions, new Map([["constructor", "__proto__"], ["toString", "__proto__"]]), "__proto__");
  assert.equal(totals.including.responseCount, 3);
  assert.equal(rollupSessionTotals({}, {}, "constructor").including.responseCount, 0);
  assert.deepEqual(normalizeAgentNames(["constructor", "__proto__", "toString"]), ["__proto__", "constructor", "toString"]);
});

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

test("display formatters round tokens and preserve task duration", () => {
  assert.equal(formatNumber(1234.5), "1,234.5");
  assert.equal(formatTokens(1234.5), "1,235");
  assert.equal(formatDuration(65_000), "1m 05s");
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
