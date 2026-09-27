import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { server } from "../src/server.js";
import { ActivityLedger } from "../src/runs-storage.js";

async function readRecords(historyPath: string): Promise<any[]> {
  const content = await readFile(historyPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readTotals(historyPath: string): Promise<any> {
  return JSON.parse(await readFile(join(dirname(historyPath), "totals.json"), "utf8"));
}

function assistantCompleted(
  messageID: string,
  tokens: { input?: number; output?: number; reasoning?: number },
  timestamp: number,
  cost = 1,
  sessionID = "session",
) {
  return {
    type: "message.updated",
    timestamp,
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        cost,
        time: { created: Math.max(0, timestamp - 50), completed: timestamp },
        tokens,
      },
    },
  };
}

async function readRunEvents(runsPath: string): Promise<any[]> {
  return new ActivityLedger(runsPath).read({ dedupe: false });
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

test("session status lifecycle events persist and replay active duration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: { type: "session.status", timestamp: 100, properties: { sessionID: "session", status: "busy" } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 200, properties: { sessionID: "session", status: { type: "retry" } } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 300, properties: { sessionID: "session", status: "idle" } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 400, properties: { sessionID: "session", status: "busy" } } as never });
    await hooks.event({ event: { type: "session.status", timestamp: 500, properties: { sessionID: "session", status: "failed" } } as never });

    const events = await readRunEvents(runsPath);
    assert.deepEqual(events.map((event) => event.state), ["busy", "retry", "idle", "busy", "failed"]);
    assert.equal((await new ActivityLedger(runsPath).replay()).rootActiveMilliseconds.session, 300);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parent facts are persisted and root replay unions child overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 0,
      properties: { sessionID: "root", status: "busy" },
    } as never });
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 50,
      properties: { sessionID: "child", parentSessionID: "root", status: "busy" },
    } as never });
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 150,
      properties: { sessionID: "child", status: "idle" },
    } as never });
    await hooks.event({ event: {
      type: "session.status",
      timestamp: 200,
      properties: { sessionID: "root", status: "idle" },
    } as never });

    const replay = await new ActivityLedger(runsPath).replay();
    const root = replay.roots.find((entry) => entry.rootSessionID === "root");
    assert.ok(root);
    assert.equal(root.activeMilliseconds, 200);
    assert.equal(replay.parentBySessionID.get("child"), "root");
    assert.equal((await readRunEvents(runsPath)).filter((event) => event.kind === "parent").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate lifecycle delivery is stable while conflicting facts remain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const busy = {
      type: "session.status",
      eventId: "source-event",
      timestamp: 100,
      properties: { sessionID: "session", status: "busy" },
    };
    await hooks.event({ event: busy as never });
    await hooks.event({ event: { ...busy } as never });
    await hooks.event({ event: {
      ...busy,
      timestamp: 200,
      properties: { sessionID: "session", status: "idle" },
    } as never });

    const events = await readRunEvents(runsPath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventID, events[1]?.eventID);
    assert.equal(events[0]?.seq, 1);
    assert.equal(events[1]?.seq, 2);
    assert.deepEqual(events.map((event) => event.state), ["busy", "idle"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initializing a new instance recovers old open activity at its last event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const first = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(first.event);
    await first.event({ event: {
      type: "session.status",
      timestamp: 1234,
      properties: { sessionID: "session", status: "busy" },
    } as never });
    await first.event({ event: {
      type: "session.status",
      timestamp: 1500,
      properties: { sessionID: "session", status: "retry" },
    } as never });

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    const afterRecovery = await readRunEvents(runsPath);
    assert.equal(afterRecovery.length, 3);
    assert.equal(afterRecovery[2]?.state, "stopped");
    assert.equal(afterRecovery[2]?.timestamp, 1500);
    assert.equal(afterRecovery[2]?.instanceEndedAt, 1500);
    assert.equal((await new ActivityLedger(runsPath).replay()).rootActiveMilliseconds.session, 266);

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.equal((await readRunEvents(runsPath)).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical v2 retry and step failure lifecycle events are recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "message", delta: "hello" },
    } as never });
    await hooks.event({ event: {
      type: "session.next.retried",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });
    await hooks.event({ event: {
      type: "session.next.step.failed",
      timestamp: 300,
      properties: { sessionID: "session" },
    } as never });

    const events = await readRunEvents(runsPath);
    assert.deepEqual(events.map((event) => event.state), ["retry", "failed"]);
    assert.equal((await new ActivityLedger(runsPath).replay()).rootActiveMilliseconds.session, 100);
    assert.equal((await readRecords(historyPath))[0]?.quality, "provisional");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never-resolving parent lookup times out without blocking later events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    let lookupCalls = 0;
    const never = new Promise<never>(() => undefined);
    const hooks = await server({
      directory,
      worktree: directory,
      client: { session: { get: () => {
        lookupCalls += 1;
        return never;
      } } },
    } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const completed = hooks.event({ event: {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "message",
          sessionID: "child",
          role: "assistant",
          time: { created: 100, completed: 200 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });
    const completedWithinBound = await Promise.race([
      completed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(completedWithinBound, true);

    const later = hooks.event({ event: {
      type: "session.status",
      timestamp: 300,
      properties: { sessionID: "later", status: "busy" },
    } as never });
    const laterWithinBound = await Promise.race([
      later.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(laterWithinBound, true);
    assert.equal((await readRecords(historyPath)).length, 1);
    assert.deepEqual((await readRunEvents(runsPath)).map((event) => event.state), ["busy"]);
    assert.equal(lookupCalls, 1);
    assert.equal(warnings.some((args) => String(args[0]).includes("parent lookup")), false);

    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 400,
      properties: {
        info: {
          id: "message-2",
          sessionID: "child",
          role: "assistant",
          time: { created: 300, completed: 400 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });
    assert.equal(lookupCalls, 1);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runsPath may be explicit and otherwise follows historyPath", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "nested", "history.jsonl");
  const explicitRunsPath = join(directory, "custom", "activity.jsonl");
  try {
    const explicit = await server({ directory, worktree: directory } as unknown as PluginInput, {
      historyPath,
      runsPath: explicitRunsPath,
    });
    assert.ok(explicit.event);
    await explicit.event({ event: { type: "session.idle", timestamp: 1, properties: { sessionID: "explicit" } } as never });
    assert.equal((await readRunEvents(explicitRunsPath)).length, 1);

    const defaultHistoryPath = join(directory, "default", "history.jsonl");
    const defaults = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath: defaultHistoryPath });
    assert.ok(defaults.event);
    await defaults.event({ event: { type: "session.idle", timestamp: 2, properties: { sessionID: "default" } } as never });
    assert.equal((await readRunEvents(join(directory, "default", "runs.jsonl"))).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed response parent lookup is supplemental and persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const runsPath = join(directory, "runs.jsonl");
  try {
    let lookupCalls = 0;
    const sessionClient = {
      get: async (request: unknown) => {
        lookupCalls += 1;
        assert.deepEqual(request, { path: { id: "child" } });
        return { data: { parentID: "root" } };
      },
    };
    const hooks = await server({
      directory,
      worktree: directory,
      client: { session: sessionClient },
    } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 200,
      properties: {
        info: {
          id: "message",
          sessionID: "child",
          parentID: "message-parent-only",
          role: "assistant",
          time: { created: 100, completed: 200 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });

    const parentEvents = (await readRunEvents(runsPath)).filter((event) => event.kind === "parent");
    assert.equal(parentEvents.length, 1);
    assert.equal(parentEvents[0]?.parentSessionID, "root");
    assert.equal((await readRecords(historyPath))[0]?.parentSessionID, "root");
    assert.equal(lookupCalls, 1);

    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 400,
      properties: {
        info: {
          id: "message-2",
          sessionID: "child",
          role: "assistant",
          time: { created: 300, completed: 400 },
          tokens: { input: 1, output: 2, reasoning: 0 },
        },
      },
    } as never });
    assert.equal(lookupCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed message writes direct usage into the sibling totals ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("message", {
      input: 4,
      output: 5,
      reasoning: 1,
    }, 200, 3) as never });

    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.equal(totals.sessions.session.cost, 3);
    assert.deepEqual(totals.sessions.session.tokens, {
      input: 4,
      output: 5,
      reasoning: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual((await readRecords(historyPath))[0]?.tokens, totals.sessions.session.tokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second completion accumulates and a repeated message.updated does not double count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    const second = assistantCompleted("second", { input: 3, output: 1 }, 300, 2);
    await hooks.event({ event: assistantCompleted("first", { input: 4, output: 5 }, 200, 3) as never });
    await hooks.event({ event: second as never });

    const accumulated = await readTotals(historyPath);
    assert.equal(accumulated.sessions.session.responseCount, 2);
    assert.equal(accumulated.sessions.session.cost, 5);
    assert.deepEqual(accumulated.sessions.session.tokens, {
      input: 7,
      output: 6,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });

    await hooks.event({ event: second as never });
    const repeated = await readTotals(historyPath);
    assert.equal(repeated.sessions.session.responseCount, 2);
    assert.deepEqual(repeated.sessions.session.tokens, accumulated.sessions.session.tokens);
    assert.equal(repeated.sessions.session.cost, accumulated.sessions.session.cost);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("history window eviction keeps settled usage in the cumulative ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, {
      historyPath,
      maxRecords: 2,
    });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("m1", { input: 10 }, 100, 1) as never });
    await hooks.event({ event: assistantCompleted("m2", { input: 20 }, 200, 1) as never });
    await hooks.event({ event: assistantCompleted("m3", { input: 40 }, 300, 1) as never });

    const records = await readRecords(historyPath);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.messageID), ["m2", "m3"]);
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 3);
    assert.equal(totals.sessions.session.tokens.input, 70);
    assert.equal(totals.sessions.session.cost, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening another server on the same directory does not change totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("message", { input: 4, output: 5 }, 200, 3) as never });
    const before = await readTotals(historyPath);

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    const after = await readTotals(historyPath);
    assert.deepEqual(after.sessions, before.sessions);
    assert.deepEqual(after.open, before.open);
    assert.deepEqual(after.settled, before.settled);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an idle provisional replaced by a smaller exact is not added twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "idle-fallback", delta: "x".repeat(55) },
    } as never });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });

    const provisionalHistory = await readRecords(historyPath);
    assert.equal(provisionalHistory[0]?.quality, "provisional");
    const provisional = await readTotals(historyPath);
    assert.equal(provisional.sessions.session.responseCount, 1);
    assert.ok(provisional.sessions.session.tokens.output > 3);

    await hooks.event({ event: {
      type: "message.updated",
      timestamp: 300,
      properties: {
        info: {
          id: "idle-fallback",
          sessionID: "session",
          role: "assistant",
          cost: 1,
          time: { created: 100, completed: 300 },
          tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
        },
      },
    } as never });

    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.equal(totals.sessions.session.cost, 1);
    assert.deepEqual(totals.sessions.session.tokens, {
      input: 2,
      output: 3,
      reasoning: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const history = await readRecords(historyPath);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.quality, "exact");
    assert.deepEqual(history[0]?.tokens, totals.sessions.session.tokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt totals file is quarantined and rebuilt from the history window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await hooks.event({ event: assistantCompleted("message", { input: 4, output: 5 }, 200, 3) as never });
    await writeFile(join(directory, "totals.json"), "{not-json", "utf8");

    await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });

    const quarantined = (await readdir(directory)).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0] ?? "", /^totals\.json\.corrupt-\d+/);
    assert.equal(await readFile(join(directory, quarantined[0] ?? ""), "utf8"), "{not-json");
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.tokens.input, 4);
    assert.equal(totals.sessions.session.tokens.output, 5);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.equal(totals.sessions.session.cost, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an idle totals write failure keeps the active state for a later retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-server-"));
  const historyPath = join(directory, "history.jsonl");
  const totalsPath = join(directory, "totals.json");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    assert.ok(hooks.event);
    await rm(totalsPath);
    await mkdir(totalsPath);

    await hooks.event({ event: {
      type: "message.part.delta",
      timestamp: 100,
      properties: { sessionID: "session", messageID: "idle-retry", delta: "x".repeat(55) },
    } as never });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 200,
      properties: { sessionID: "session" },
    } as never });

    const provisional = await readRecords(historyPath);
    assert.equal(provisional.length, 1);
    assert.equal(provisional[0]?.quality, "provisional");

    await rm(totalsPath, { recursive: true, force: true });
    await hooks.event({ event: {
      type: "session.idle",
      timestamp: 300,
      properties: { sessionID: "session" },
    } as never });

    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.responseCount, 1);
    assert.ok(totals.sessions.session.tokens.output > 0);
    assert.equal((await readRecords(historyPath)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
