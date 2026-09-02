import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { server } from "../src/server.js";

async function readRecords(historyPath: string): Promise<any[]> {
  const content = await readFile(historyPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("completion keeps fallback cache counts, preserves output zero, and deduplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, {
      historyPath,
    });
    assert.ok(hooks.event);

    const stepEnded = {
      type: "session.next.step.ended",
      timestamp: 100,
      properties: {
        sessionID: "session",
        assistantMessageID: "message",
        cost: 1,
        tokens: {
          input: 12,
          output: 8,
          reasoning: 3,
          cache: { read: 7, write: 11 },
        },
      },
    };
    const partialStepEnded = {
      type: "session.next.step.ended",
      timestamp: 110,
      properties: {
        sessionID: "session",
        assistantMessageID: "message",
        tokens: { cache: { read: 9 } },
      },
    };
    const completed = {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "message",
          sessionID: "session",
          role: "assistant",
          cost: 1,
          time: { created: 0, completed: 200 },
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    };

    await Promise.all([
      hooks.event({ event: stepEnded as never }),
      hooks.event({ event: partialStepEnded as never }),
      hooks.event({ event: completed as never }),
      hooks.event({ event: completed as never }),
    ]);

    const records = await readRecords(historyPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tokens, {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 9,
      cacheWrite: 11,
    });
    assert.equal(records[0].quality, "exact");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late fallback after exact completion is ignored before idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const exact = {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "exact-first",
          sessionID: "session",
          role: "assistant",
          cost: 2,
          time: { created: 0, completed: 200 },
          tokens: { input: 5, output: 6, reasoning: 1, cache: { read: 7, write: 8 } },
        },
      },
    };
    const lateFallback = {
      type: "session.next.step.ended",
      timestamp: 210,
      properties: {
        sessionID: "session",
        assistantMessageID: "exact-first",
        tokens: { input: 50, output: 60, reasoning: 10, cache: { read: 70, write: 80 } },
      },
    };
    const idle = {
      type: "session.idle",
      timestamp: 300,
      properties: { sessionID: "session" },
    };
    await hooks.event({ event: exact as never });
    await hooks.event({ event: lateFallback as never });
    await hooks.event({ event: idle as never });
    const records = await readRecords(historyPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tokens, {
      input: 5,
      output: 6,
      reasoning: 1,
      cacheRead: 7,
      cacheWrite: 8,
    });
    assert.equal(records[0].quality, "exact");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fallback then exact completion remains one exact record through duplicate events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const fallback = {
      type: "session.next.step.ended",
      timestamp: 100,
      properties: {
        sessionID: "session",
        assistantMessageID: "fallback-first",
        tokens: { input: 50, output: 60, reasoning: 10, cache: { read: 70, write: 80 } },
      },
    };
    const exact = {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "fallback-first",
          sessionID: "session",
          role: "assistant",
          cost: 2,
          time: { created: 0, completed: 200 },
          tokens: { input: 5, output: 6, reasoning: 1, cache: { read: 7, write: 8 } },
        },
      },
    };
    await hooks.event({ event: fallback as never });
    await hooks.event({ event: exact as never });
    await hooks.event({ event: fallback as never });
    await hooks.event({ event: exact as never });
    await hooks.event({ event: { type: "session.idle", timestamp: 300, properties: { sessionID: "session" } } as never });
    const records = await readRecords(historyPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tokens, {
      input: 5,
      output: 6,
      reasoning: 1,
      cacheRead: 7,
      cacheWrite: 8,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle flush persists a provisional quality marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "idle-fallback", delta: "hello" },
    } as never });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });
    const records = await readRecords(historyPath);
    assert.equal(records[0]?.quality, "provisional");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
