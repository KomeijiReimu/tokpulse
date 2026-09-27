import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HistoryRecord, TokenCounts } from "../src/core.js";
import { createTotalsStorage, isCorruptTotalsError, resolveTotalsPath } from "../src/totals-storage.js";

test("resolveTotalsPath uses a sibling totals.json unless totalsPath is explicit", () => {
  assert.equal(
    resolveTotalsPath({ historyPath: "/tmp/oc/history.jsonl" }),
    "/tmp/oc/totals.json",
  );
  assert.equal(
    resolveTotalsPath({ historyPath: "/tmp/oc/history.jsonl", totalsPath: "/var/tmp/totals.json" }),
    "/var/tmp/totals.json",
  );
  assert.equal(
    resolveTotalsPath({ historyPath: "/tmp/oc/history.jsonl", totalsPath: "custom.json" }),
    "/tmp/oc/custom.json",
  );
  assert.equal(resolveTotalsPath({ totalsPath: "totals.json" }), "totals.json");
});

test("storage writes the sibling ledger and an explicit totalsPath wins", async (context) => {
  const directory = await makeTestDirectory(context);
  const historyPath = join(directory, "history.jsonl");
  const storage = createTotalsStorage({ historyPath });

  await storage.apply(historyRecord("1", { tokens: tokens(2), cost: 1 }));

  assert.equal(storage.path, join(directory, "totals.json"));
  assert.equal(await exists(historyPath), false);
  assert.equal(await exists(storage.path), true);
  const stored = JSON.parse(await readFile(storage.path, "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(Array.isArray(stored), false);

  const explicitPath = join(directory, "custom-totals.json");
  const explicit = createTotalsStorage({ historyPath, totalsPath: explicitPath });
  await explicit.apply(historyRecord("2", { tokens: tokens(3), cost: 1 }));
  assert.equal(await exists(explicitPath), true);
  assert.equal(JSON.parse(await readFile(storage.path, "utf8")).open["2"], undefined);
});

test("the 1001st exact record stays counted after it pushes message 1 out of the window", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage({ historyPath: join(directory, "history.jsonl") });
  const retained = new Set<string>();

  for (let index = 1; index <= 1000; index += 1) {
    const messageID = String(index);
    retained.add(messageID);
    await storage.apply(historyRecord(messageID, {
      tokens: tokens(index),
      cost: 1,
    }), { retainedMessageIDs: retained });
  }

  const full = await storage.read();
  assert.equal(Object.keys(full.open).length, 1000);
  assert.equal(full.open["1"]?.quality, "exact");
  assert.equal(full.sessions.session?.tokens.input, 500_500);
  assert.equal(full.sessions.session?.responseCount, 1000);

  const window = new Set<string>();
  for (let index = 2; index <= 1001; index += 1) window.add(String(index));
  const after = await storage.apply(historyRecord("1001", {
    tokens: tokens(1001),
    cost: 1,
  }), { retainedMessageIDs: window });

  assert.equal(after.open["1"], undefined);
  assert.equal(after.open["2"]?.tokens.input, 2);
  assert.equal(after.open["1001"]?.tokens.input, 1001);
  assert.equal(after.open["1001"]?.quality, "exact");
  assert.equal(Object.keys(after.open).length, 1000);
  assert.equal(after.sessions.session?.tokens.input, 501_501);
  assert.equal(after.sessions.session?.cost, 1001);
  assert.equal(after.sessions.session?.responseCount, 1001);
  assert.deepEqual(await storage.read(), after);

  const persisted = JSON.parse(await readFile(storage.path, "utf8"));
  assert.equal(persisted.sessions.session.tokens.input, 501_501);
  assert.equal(persisted.open["1"], undefined);
});

test("another session entering the window does not decrease totals left behind", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.apply(historyRecord("keep-provisional", {
    sessionID: "mine",
    quality: "provisional",
    tokens: tokens(9, 1, 1, 1, 1),
    cost: 4,
  }));
  await storage.apply(historyRecord("drop-exact", {
    sessionID: "mine",
    quality: "exact",
    tokens: tokens(5, 2, 2, 2, 2),
    cost: 2,
  }));
  const before = await storage.read();

  const after = await storage.apply(historyRecord("other", {
    sessionID: "other",
    quality: "exact",
    tokens: tokens(100),
    cost: 1,
  }), { retainedMessageIDs: ["other"] });

  assert.deepEqual(after.sessions.mine, before.sessions.mine);
  assert.equal(after.sessions.mine?.tokens.input, 14);
  assert.equal(after.sessions.mine?.cost, 6);
  assert.equal(after.sessions.mine?.responseCount, 2);
  assert.equal(after.open["drop-exact"], undefined);
  assert.equal(after.open["keep-provisional"]?.quality, "provisional");
  assert.equal(after.open["keep-provisional"]?.tokens.input, 9);
  assert.equal(after.sessions.other?.tokens.input, 100);
  assert.equal(after.open.other?.sessionID, "other");
});

test("a smaller exact snapshot subtracts only the delta and repeating it is a no-op", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.apply(historyRecord("base", {
    tokens: tokens(100, 50, 50, 100, 50),
    cost: 20,
  }));
  await storage.apply(historyRecord("m", {
    quality: "provisional",
    tokens: tokens(10, 8, 6, 4, 2),
    cost: 5,
  }));

  const exact = historyRecord("m", {
    quality: "exact",
    tokens: tokens(7, 8, 1, 0, 2),
    cost: 1,
  });
  const once = await storage.apply(exact);
  assert.deepEqual(once.sessions.session?.tokens, tokens(107, 58, 51, 100, 52));
  assert.equal(once.sessions.session?.cost, 21);
  assert.equal(once.sessions.session?.responseCount, 2);
  assert.equal(once.open.m?.quality, "exact");
  assert.deepEqual(once.open.m?.tokens, tokens(7, 8, 1, 0, 2));

  const twice = await storage.apply(exact);
  assert.deepEqual(twice.sessions, once.sessions);
  assert.deepEqual(twice.open, once.open);
});

test("seed matches sequential apply and a second seed does not reset or double-count", async (context) => {
  const directory = await makeTestDirectory(context);
  const records = [
    historyRecord("m1", {
      sessionID: "alpha",
      quality: "provisional",
      tokens: tokens(10, 8, 6, 4, 2),
      cost: 5,
    }),
    historyRecord("m2", {
      sessionID: "alpha",
      tokens: tokens(3, 1, 0, 0, 1),
      cost: -4,
    }),
    historyRecord("m1", {
      sessionID: "alpha",
      quality: "exact",
      tokens: tokens(4, 8, 1, 0, 2),
      cost: 2,
    }),
    historyRecord("m3", {
      sessionID: "beta",
      tokens: tokens(8),
      cost: Number.NaN,
    }),
  ];
  const seededStorage = createTotalsStorage({ historyPath: join(directory, "history.jsonl") });
  const seeded = await seededStorage.seed(records);
  const sequential = createTotalsStorage(join(directory, "sequential.json"));
  let applied = await sequential.read();
  for (const record of records) applied = await sequential.apply(record);

  assert.deepEqual(seeded, applied);
  assert.deepEqual(seeded.sessions.alpha?.tokens, tokens(7, 9, 1, 0, 3));
  assert.equal(seeded.sessions.alpha?.cost, 2);
  assert.equal(seeded.sessions.alpha?.responseCount, 2);
  assert.equal(seeded.sessions.beta?.cost, 0);
  assert.equal(seeded.sessions.beta?.tokens.input, 8);
  assert.equal(seeded.open.m1?.quality, "exact");
  assert.equal(seeded.open.m2?.cost, 0);
  assert.equal(await exists(join(directory, "history.jsonl")), false);

  const before = await readFile(seededStorage.path, "utf8");
  const second = await seededStorage.seed([
    historyRecord("m-new", { tokens: tokens(1000), cost: 1000 }),
  ]);
  assert.deepEqual(second, seeded);
  assert.equal(second.open["m-new"], undefined);
  assert.equal(second.sessions.alpha?.responseCount, 2);
  assert.equal(await readFile(seededStorage.path, "utf8"), before);

  const reopened = createTotalsStorage(seededStorage.path);
  assert.deepEqual(await reopened.read(), seeded);
});

test("applying the same record twice does not change sessions or open", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const record = historyRecord("same", {
    tokens: tokens(4, 5, 6, 7, 8),
    cost: 3,
  });

  const first = await storage.apply(record);
  const second = await storage.apply(record);

  assert.deepEqual(second.sessions, first.sessions);
  assert.deepEqual(second.open, first.open);
  assert.equal(second.sessions.session?.responseCount, 1);
  assert.deepEqual(second.sessions.session?.tokens, tokens(4, 5, 6, 7, 8));
  assert.equal(second.open.same?.quality, "exact");
  assert.equal(second.sessions.session?.cost, 3);
});

test("moving a message to another session subtracts the old contribution and adds the new one", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.apply(historyRecord("moved", {
    sessionID: "old",
    tokens: tokens(10, 4, 3, 2, 1),
    cost: 3,
  }));
  await storage.apply(historyRecord("stays", {
    sessionID: "old",
    tokens: tokens(4, 1, 0, 0, 0),
    cost: 1,
  }));

  const moved = await storage.apply(historyRecord("moved", {
    sessionID: "new",
    quality: "exact",
    tokens: tokens(6, 1, 1, 0, 1),
    cost: 2,
  }));

  assert.deepEqual(moved.sessions.old?.tokens, tokens(4, 1, 0, 0, 0));
  assert.equal(moved.sessions.old?.cost, 1);
  assert.equal(moved.sessions.old?.responseCount, 1);
  assert.deepEqual(moved.sessions.new?.tokens, tokens(6, 1, 1, 0, 1));
  assert.equal(moved.sessions.new?.cost, 2);
  assert.equal(moved.sessions.new?.responseCount, 1);
  assert.equal(moved.open.moved?.sessionID, "new");
  assert.equal(moved.open.stays?.sessionID, "old");
});

test("read of a missing ledger is empty and does not create a file", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));

  assert.deepEqual(await storage.read(), { version: 1, sessions: {}, open: {}, settled: {} });
  assert.equal(await exists(storage.path), false);
});

test("corrupt totals JSON throws instead of being treated as an empty ledger", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "totals.json");
  const storage = createTotalsStorage(path);
  await writeFile(path, "{not-json", "utf8");

  await assert.rejects(storage.read(), SyntaxError);
  assert.equal(await readFile(path, "utf8"), "{not-json");

  await writeFile(path, "[]", "utf8");
  await assert.rejects(storage.read(), TypeError);
  assert.equal(await readFile(path, "utf8"), "[]");
});

test("concurrent applies on one ledger do not drop each other", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));

  await Promise.all([
    storage.apply(historyRecord("a", { tokens: tokens(1), cost: 1 })),
    storage.apply(historyRecord("b", { tokens: tokens(2), cost: 2 })),
    storage.apply(historyRecord("c", { tokens: tokens(3), cost: 3 })),
  ]);

  const ledger = await storage.read();
  assert.equal(ledger.sessions.session?.tokens.input, 6);
  assert.equal(ledger.sessions.session?.cost, 6);
  assert.equal(ledger.sessions.session?.responseCount, 3);
  assert.deepEqual(Object.keys(ledger.open).sort(), ["a", "b", "c"]);
});

test("a settled exact record is not counted again when the same record is applied", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const exact = historyRecord("frozen", {
    tokens: tokens(10, 4, 3, 2, 1),
    cost: 3,
  });
  await storage.apply(exact, { retainedMessageIDs: ["frozen"] });
  await storage.apply(historyRecord("keeper", {
    tokens: tokens(1),
    cost: 1,
  }), { retainedMessageIDs: ["keeper"] });

  const before = await storage.read();
  const frozen = {
    sessionID: "session",
    quality: "exact" as const,
    tokens: tokens(10, 4, 3, 2, 1),
    cost: 3,
  };
  assert.equal(before.open.frozen, undefined);
  assert.deepEqual(before.settled.frozen, frozen);
  assert.equal(before.sessions.session?.tokens.input, 11);
  assert.equal(before.sessions.session?.responseCount, 2);
  assert.notEqual(before.settled.frozen.tokens, before.sessions.session?.tokens);

  const after = await storage.apply(exact, { retainedMessageIDs: ["frozen", "keeper"] });
  assert.equal(after.sessions.session?.tokens.input, before.sessions.session?.tokens.input);
  assert.equal(after.sessions.session?.responseCount, before.sessions.session?.responseCount);
  assert.deepEqual(after.sessions.session?.tokens, before.sessions.session?.tokens);
  assert.equal(after.open.frozen, undefined);
  assert.deepEqual(after.settled.frozen, frozen);
  assert.equal(after.open.keeper?.tokens.input, 1);
  after.settled.frozen.tokens.input = 999;
  assert.equal((await storage.read()).sessions.session?.tokens.input, 11);
  assert.deepEqual((await storage.read()).settled.frozen, frozen);
});

test("applyMany keeps both records in the final ledger file", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.applyMany([
    historyRecord("a", { tokens: tokens(2, 1), cost: 1 }),
    historyRecord("b", { tokens: tokens(3, 4), cost: 2 }),
  ]);

  const persisted = JSON.parse(await readFile(storage.path, "utf8"));
  assert.equal(persisted.sessions.session.tokens.input, 5);
  assert.equal(persisted.sessions.session.tokens.output, 5);
  assert.equal(persisted.sessions.session.cost, 3);
  assert.equal(persisted.sessions.session.responseCount, 2);
  assert.equal(persisted.open.a.tokens.input, 2);
  assert.equal(persisted.open.b.tokens.input, 3);
});

test("read returns a totals file rewritten on disk after apply", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.apply(historyRecord("a", { tokens: tokens(1), cost: 1 }));

  const raw = JSON.parse(await readFile(storage.path, "utf8"));
  raw.sessions.session.tokens.input = 42;
  await writeFile(storage.path, JSON.stringify(raw), "utf8");

  const ledger = await storage.read();
  assert.equal(ledger.sessions.session?.tokens.input, 42);
});

test("a settled correction inside the window adds only the delta and reopens the record", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.apply(historyRecord("m", {
    tokens: tokens(10),
    cost: 1,
  }), { retainedMessageIDs: [] });

  const after = await storage.apply(historyRecord("m", {
    tokens: tokens(15),
    cost: 1,
  }), { retainedMessageIDs: ["m"] });

  assert.equal(after.sessions.session?.tokens.input, 15);
  assert.equal(after.sessions.session?.cost, 1);
  assert.equal(after.sessions.session?.responseCount, 1);
  assert.equal(after.settled.m, undefined);
  assert.deepEqual(after.open.m, {
    sessionID: "session",
    quality: "exact",
    tokens: tokens(15),
    cost: 1,
  });
});

test("a settled correction outside the window updates the snapshot instead of adding twice", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.apply(historyRecord("m", {
    tokens: tokens(10),
    cost: 1,
  }), { retainedMessageIDs: [] });
  const corrected = historyRecord("m", {
    tokens: tokens(15),
    cost: 1,
  });

  const after = await storage.apply(corrected, { retainedMessageIDs: [] });
  const snapshot = {
    sessionID: "session",
    quality: "exact" as const,
    tokens: tokens(15),
    cost: 1,
  };
  assert.equal(after.sessions.session?.tokens.input, 15);
  assert.equal(after.sessions.session?.cost, 1);
  assert.equal(after.sessions.session?.responseCount, 1);
  assert.equal(after.open.m, undefined);
  assert.deepEqual(after.settled.m, snapshot);

  const again = await storage.apply(corrected, { retainedMessageIDs: [] });
  assert.equal(again.sessions.session?.tokens.input, 15);
  assert.equal(again.sessions.session?.responseCount, 1);
  assert.deepEqual(again.sessions.session?.tokens, after.sessions.session?.tokens);
  assert.equal(again.open.m, undefined);
  assert.deepEqual(again.settled.m, snapshot);
});

test("legacy settled true is not adjusted when a larger record is applied", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "totals.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    sessions: {
      session: {
        tokens: tokens(10),
        cost: 1,
        responseCount: 1,
      },
    },
    open: {},
    settled: { frozen: true },
  }), "utf8");
  const storage = createTotalsStorage(path);

  const after = await storage.apply(historyRecord("frozen", {
    tokens: tokens(15),
    cost: 4,
  }), { retainedMessageIDs: ["frozen"] });

  assert.equal(after.sessions.session?.tokens.input, 10);
  assert.equal(after.sessions.session?.cost, 1);
  assert.equal(after.sessions.session?.responseCount, 1);
  assert.equal(after.settled.frozen, true);
  assert.equal(after.open.frozen, undefined);
});

test("moving a settled record to another session transfers usage instead of double counting", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.apply(historyRecord("stays", {
    sessionID: "old",
    tokens: tokens(4),
    cost: 1,
  }), { retainedMessageIDs: ["stays"] });
  await storage.apply(historyRecord("moved", {
    sessionID: "old",
    tokens: tokens(10),
    cost: 3,
  }), { retainedMessageIDs: ["stays"] });

  const after = await storage.apply(historyRecord("moved", {
    sessionID: "new",
    tokens: tokens(15),
    cost: 4,
  }), { retainedMessageIDs: ["stays"] });

  assert.deepEqual(after.sessions.old?.tokens, tokens(4));
  assert.equal(after.sessions.old?.cost, 1);
  assert.equal(after.sessions.old?.responseCount, 1);
  assert.deepEqual(after.sessions.new?.tokens, tokens(15));
  assert.equal(after.sessions.new?.cost, 4);
  assert.equal(after.sessions.new?.responseCount, 1);
  assert.equal(after.open.moved, undefined);
  assert.equal(after.open.stays?.sessionID, "old");
  assert.deepEqual(after.settled.moved, {
    sessionID: "new",
    quality: "exact",
    tokens: tokens(15),
    cost: 4,
  });
  const responseCount = Object.values(after.sessions).reduce((sum, session) => sum + session.responseCount, 0);
  assert.equal(responseCount, 2);
});

test("quarantine renames a ledger aside and ignores a missing file", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "totals.json");
  const storage = createTotalsStorage(path);

  await storage.quarantine();
  assert.equal(await exists(path), false);
  assert.deepEqual(await readdir(directory), []);

  const payload = "{not-json";
  await writeFile(path, payload, "utf8");
  await storage.quarantine();

  assert.equal(await exists(path), false);
  const quarantined = (await readdir(directory)).filter((name) => name.includes(".corrupt-"));
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0] ?? "", /^totals\.json\.corrupt-\d+/);
  assert.equal(await readFile(join(directory, quarantined[0] ?? ""), "utf8"), payload);
});

test("illegal settled values throw and leave the file unchanged", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "totals.json");
  const payload = JSON.stringify({
    version: 1,
    sessions: {},
    open: {},
    settled: { bad: false },
  });
  await writeFile(path, payload, "utf8");
  const storage = createTotalsStorage(path);

  await assert.rejects(storage.read(), { name: "TypeError", message: "Invalid totals ledger" });
  assert.equal(await readFile(path, "utf8"), payload);
});

test("isCorruptTotalsError matches corrupt ledger errors only", () => {
  assert.equal(isCorruptTotalsError(new SyntaxError("Unexpected token")), true);
  assert.equal(isCorruptTotalsError(new TypeError("Invalid totals ledger")), true);
  assert.equal(isCorruptTotalsError(new TypeError("Invalid totals record")), false);
  assert.equal(isCorruptTotalsError(Object.assign(new Error("disk"), { code: "EACCES" })), false);
});

test("a ledger JSON without settled reads with an empty settled set", async (context) => {
  const directory = await makeTestDirectory(context);
  const path = join(directory, "totals.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    sessions: {
      session: {
        tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
        cost: 6,
        responseCount: 1,
      },
    },
    open: {},
  }), "utf8");
  const storage = createTotalsStorage(path);

  const ledger = await storage.read();
  assert.deepEqual(ledger.settled, {});
  assert.equal(ledger.sessions.session?.tokens.input, 1);
  assert.equal(ledger.sessions.session?.responseCount, 1);
  assert.equal(ledger.sessions.session?.cost, 6);
});

async function makeTestDirectory(context: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-totals-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tokens(
  input: number,
  output = 0,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
): TokenCounts {
  return { input, output, reasoning, cacheRead, cacheWrite };
}

function historyRecord(
  messageID: string,
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    version: 1,
    messageID,
    sessionID: "session",
    model: "model",
    tokens: tokens(1),
    cost: 1,
    time: { start: 1, firstToken: 2, completed: 3, ttft: 1, duration: 2 },
    samples: [],
    ...overrides,
  };
}
