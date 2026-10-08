import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { HistoryRecord, TokenCounts } from "../src/core.js";
import type { MeasuredHistoryRecord } from "../src/statistics.js";
import { filterHistoryRecords, parseHistoryJsonl } from "../src/storage.js";
import { createTotalsStorage, getExcludedMessageIDs, isCorruptTotalsError, projectTotalsGenerationBasis, projectTotalsMeasurementScope, resolveTotalsPath } from "../src/totals-storage.js";
import { getSessionAverageSummary, measureRecordSpeed, mergeRecordSpeed } from "../src/statistics.js";
import { classifyMessageMetadata, classifySessionMetadata, createScopeRegistry } from "../src/scope.js";

test("late MC identity projects all usage/speed and descendants while preserving raw cumulative data and epoch", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  for (const sessionID of ["root", "real", "mc", "grand"]) {
    await storage.apply(historyRecord(sessionID, { sessionID, tokens: tokens(1, 10, 2), speed: measuredV3Speed(tokens(1, 10, 2)) }));
  }
  const before = await storage.read();
  const registry = createScopeRegistry();
  registry.observeSessionMetadata("mc", { parentID: "root" });
  registry.observeSessionMetadata("grand", { parentID: "mc" });
  registry.observeMessageMetadata("mc", { mode: "dreamer" });
  for (const [sid, proof] of Object.entries(registry.serialize())) await storage.setSessionScope(sid, proof);
  const after = await storage.read();
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.open, before.open);
  const projected = projectTotalsMeasurementScope(after);
  assert.deepEqual(Object.keys(projected.sessions).sort(), ["real", "root"]);
  assert.deepEqual(projected.sessions.root, before.sessions.root);
  assert.deepEqual(projected.sessions.real, before.sessions.real);
  assert.equal(projected.generationBasisVersion, before.generationBasisVersion);
  assert.equal(getSessionAverageSummary(projected.sessions.real).generation.coveredResponseCount, 1);
  assert.equal(projectTotalsMeasurementScope(after), projected);
  assert.equal(projectTotalsMeasurementScope(await createTotalsStorage(storage.path).read()).sessions.mc, undefined);
  await storage.setSessionScope("mc", classifySessionMetadata({ agent: "build" }));
  assert.equal(projectTotalsMeasurementScope(await storage.read()).sessions.mc, undefined);
  assert.equal((await storage.read()).sessions.mc.tokens.output, 10);
});

test("message-only exclusion reverses exact open and settled contributions once and prevents corrected replay", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const normal = historyRecord("normal", { tokens: tokens(2, 20, 4), speed: measuredV3Speed(tokens(2, 20, 4)) });
  const baseline = await storage.apply(normal);
  const compact = historyRecord("compact", { tokens: tokens(10, 100, 20), cost: 9, speed: measuredV3Speed(tokens(10, 100, 20)) });
  await storage.apply(compact, { retainedMessageIDs: ["normal"] });
  const proof = classifyMessageMetadata({ summary: true, mode: "compaction" });
  const excluded = await storage.excludeMessage("compact", proof);
  assert.deepEqual(excluded.sessions, baseline.sessions);
  assert.deepEqual((excluded.settled.compact as any).excluded, proof);
  assert.equal((excluded.settled.compact as any).tokens.output, 100);
  assert.equal(excluded.open.compact, undefined);
  assert.deepEqual(await storage.excludeMessage("compact", proof), excluded);
  assert.deepEqual(filterHistoryRecords([normal, compact], excluded.sessionScopes, undefined, getExcludedMessageIDs(excluded)), [normal]);
  assert.equal(getExcludedMessageIDs(excluded), getExcludedMessageIDs(excluded));
  assert.deepEqual(await createTotalsStorage(storage.path).apply({ ...compact, tokens: tokens(20, 200, 40) }), excluded);
  await storage.apply(historyRecord("open-compaction", { tokens: tokens(5, 50), speed: measuredV3Speed(tokens(5, 50)) }));
  assert.deepEqual((await storage.excludeMessage("open-compaction", proof)).sessions, baseline.sessions);
  assert.equal((await storage.read()).sessionScopes, undefined);
});

test("legacy settled true exclusion never guesses an amount and blocks resurrection; unknown tombstones share settled scheme", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const baseline = await storage.apply(historyRecord("legacy", { tokens: tokens(10, 20) }));
  baseline.settled.legacy = true;
  delete baseline.open.legacy;
  assert.equal(getExcludedMessageIDs(baseline).has("legacy"), false);
  await writeFile(storage.path, JSON.stringify(baseline));
  const proof = classifyMessageMetadata({ modelID: "magic-context" });
  const excluded = await storage.excludeMessage("legacy", proof);
  assert.deepEqual(excluded.sessions, baseline.sessions);
  assert.equal(getExcludedMessageIDs(excluded).has("legacy"), true);
  assert.deepEqual(filterHistoryRecords([historyRecord("legacy"), historyRecord("normal")], {}, undefined, getExcludedMessageIDs(excluded)).map((record) => record.messageID), ["normal"]);
  assert.deepEqual((await storage.apply(historyRecord("legacy", { tokens: tokens(100, 200) }))).sessions, baseline.sessions);
  await storage.excludeMessage("not-seen", proof);
  const later = await storage.apply(historyRecord("not-seen", { tokens: tokens(50, 50) }));
  assert.deepEqual(later.sessions, baseline.sessions);
  assert.equal(later.settled["not-seen"], true);
  assert.equal(getExcludedMessageIDs(await createTotalsStorage(storage.path).read()).has("not-seen"), true);
});

test("provisional exclusion and compact record proof cannot remove same-SID user contributions", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const baseline = await storage.apply(historyRecord("normal", { tokens: tokens(7, 3) }));
  await storage.apply(historyRecord("provisional", { quality: "provisional", tokens: tokens(50, 20) }));
  const proof = classifyMessageMetadata({ agent: "compaction" });
  const corrected = await storage.excludeMessage("provisional", proof);
  assert.deepEqual(corrected.sessions, baseline.sessions);
  const excludedRecord = { ...historyRecord("proof", { tokens: tokens(100, 100) }), scope: proof };
  assert.deepEqual((await storage.apply(excludedRecord)).sessions, baseline.sessions);
  assert.deepEqual((await storage.apply(historyRecord("proof"))).sessions, baseline.sessions);
});

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

test("an exact result promotes an authoritative provisional snapshot without losing precedence", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const provisional: MeasuredHistoryRecord = { ...historyRecord("m", { quality: "provisional", tokens: tokens(1, 100) }),
    update: { source: "live", instanceID: "writer", sequence: 1, receivedAt: 1, fingerprint: "partial", seenFingerprints: ["partial"] } };
  await storage.apply(provisional);
  const exact = historyRecord("m", { quality: "exact", tokens: tokens(1, 10, 2), time: { start: 0, completed: 3000 }, speed: measuredV3Speed(tokens(1, 10, 2)) });
  const promoted = await storage.apply(exact);
  assert.equal(promoted.open.m.quality, "exact");
  assert.equal(promoted.sessions.session.tokens.output, 10);
  assert.equal(promoted.sessions.session.responseCount, 1);
  assert.equal(promoted.sessions.session.speed?.generation.coverageGeneratedTokens, 12);
  assert.deepEqual(await storage.apply(provisional), promoted);
});

for (const settled of [false, true]) {
  test(`direct apply preserves ${settled ? "settled" : "open"} exact tokens and speed coverage against provisional replacement after reload`, async (context) => {
    const directory = await makeTestDirectory(context);
    const path = join(directory, "totals.json");
    const storage = createTotalsStorage(path);
    const options = { retainedMessageIDs: settled ? [] : ["m"] };
    const exact = historyRecord("m", {
      quality: "exact", tokens: tokens(1, 10, 2), cost: 3,
      time: { start: 0, completed: 3000 },
      speed: measuredV3Speed(tokens(1, 10, 2)),
    });
    const before = await storage.apply(exact, options);
    const summaryBefore = getSessionAverageSummary(before.sessions.session!);
    assert.equal(summaryBefore.generation.coveredGeneratedTokens, 12);
    assert.equal(before.sessions.session?.speed?.generation.generatedTokens, 8.5);
    assert.equal(summaryBefore.generation.coveredResponseCount, 1);
    assert.equal(summaryBefore.response.coveredResponseCount, 1);
    assert.equal(summaryBefore.generation.estimatedResponseCount, 1);
    const provisional = historyRecord("m", {
      quality: "provisional", tokens: tokens(1), cost: 0,
      speed: { response: { generatedTokens: 0, durationMs: 900, estimated: true } },
    });
    assert.deepEqual(await storage.apply(provisional, options), before);
    const reloaded = createTotalsStorage(path);
    const after = await reloaded.apply(provisional, options);
    assert.deepEqual(after, before);
    assert.deepEqual(after.sessions.session?.tokens, tokens(1, 10, 2));
    assert.deepEqual(after.sessions.session?.speed, before.sessions.session?.speed);
    assert.equal(after.sessions.session?.responseCount, 1);
    assert.deepEqual(getSessionAverageSummary(after.sessions.session!), summaryBefore);

    const corrected = await reloaded.apply(historyRecord("m", {
      quality: "exact", tokens: tokens(1), cost: 0,
      time: { start: 0, completed: 3000 },
      speed: measuredV3Speed(tokens(1)),
    }), options);
    assert.deepEqual(corrected.sessions.session?.tokens, tokens(1));
    assert.equal(corrected.sessions.session?.cost, 0);
    assert.equal(corrected.sessions.session?.responseCount, 1);
    assert.deepEqual(corrected.sessions.session?.speed, {
      generation: { generatedTokens: 0, coverageGeneratedTokens: 0, durationMs: 2000, responseCount: 1, estimatedResponseCount: 1, shortResponseCount: 0 },
      response: { generatedTokens: 0, coverageGeneratedTokens: 0, durationMs: 3000, responseCount: 1, estimatedResponseCount: 0 },
    });
    assert.equal(getSessionAverageSummary(corrected.sessions.session!).generation.rate, 0);
    assert.equal(getSessionAverageSummary(corrected.sessions.session!).response.rate, 0);
    assert.deepEqual(await reloaded.read(), corrected);
  });
}

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

   assert.deepEqual(await storage.read(), { version: 1, generationBasisVersion: 3, sessions: {}, open: {}, settled: {} });
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

test("migration atomically resets the generation epoch once, preserving all other ledger facts", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const update = { source: "live", instanceID: "old-writer", sequence: 1, receivedAt: 1000, fingerprint: "old", seenFingerprints: ["old"] };
  const response = { generatedTokens: 15, durationMs: 2000, estimated: false };
  const contribution = { sessionID: "session", quality: "exact", tokens: tokens(2, 10, 5), cost: 3, update,
    speed: { response, generation: { generatedTokens: 15, durationMs: 100, estimated: true },
      generationEvidence: { start: 100, end: 200, outputObserved: true, reasoningObserved: true, version: 2, coverage: "complete" } } };
  const before = { version: 1, sessions: { session: { tokens: tokens(6, 30, 15), cost: 9, responseCount: 3,
    speed: { generation: { generatedTokens: 45, durationMs: 300, responseCount: 3, estimatedResponseCount: 3 },
      response: { generatedTokens: 45, durationMs: 6000, responseCount: 3, estimatedResponseCount: 0 } } } },
    open: { open: contribution }, settled: { settled: contribution, frozen: true } };
  await writeFile(storage.path, JSON.stringify(before));
  const migrated = await storage.read();
  assert.equal(migrated.generationBasisVersion, 3);
  assert.equal(migrated.sessions.session.speed?.generation.responseCount, 0);
  assert.equal(migrated.sessions.session.speed?.generation.generatedTokens, 0);
  assert.equal(migrated.sessions.session.speed?.generation.durationMs, 0);
  for (const field of ["generatedTokens", "durationMs", "responseCount", "estimatedResponseCount"] as const) {
    assert.equal(migrated.sessions.session.speed?.response[field], before.sessions.session.speed.response[field]);
  }
  assert.deepEqual(migrated.sessions.session.tokens, before.sessions.session.tokens);
  assert.equal(migrated.sessions.session.cost, 9);
  assert.equal(migrated.sessions.session.responseCount, 3);
  assert.equal(migrated.settled.frozen, true);
  for (const snapshot of [migrated.open.open, migrated.settled.settled]) {
    assert.notEqual(snapshot, true);
    assert.deepEqual((snapshot as any).tokens, contribution.tokens);
    assert.equal((snapshot as any).cost, 3);
    assert.equal((snapshot as any).quality, "exact");
    assert.deepEqual((snapshot as any).update, update);
    assert.equal((snapshot as any).speed.generation, undefined);
    assert.equal((snapshot as any).speed.generationEvidence, undefined);
    assert.deepEqual((snapshot as any).speed.response, response);
  }
  const persisted = await readFile(storage.path, "utf8");
  assert.deepEqual(JSON.parse(persisted), migrated);
  assert.deepEqual((await readdir(directory)).sort(), ["totals.json"]);
  assert.deepEqual(await createTotalsStorage(storage.path).backfillSpeed([historyRecord("ignored")]), migrated);
  assert.equal(await readFile(storage.path, "utf8"), persisted);
});

test("legacy history and samples cannot rebuild generation or guessed response measurements", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const [missing] = parseHistoryJsonl(JSON.stringify({ ...historyRecord("missing"), time: { completed: 1000 } }));
  await storage.apply(missing);
  const old = historyRecord("old", { tokens: tokens(1, 10), time: { start: 0, firstToken: 100, completed: 2000 },
    samples: [{ timestamp: 100, tokens: 1 }, { timestamp: 1100, tokens: 10 }],
    speed: { generation: { generatedTokens: 10, durationMs: 1000, estimated: true },
      generationEvidence: { start: 100, end: 1100, outputObserved: true, reasoningObserved: false } } });
  const before = await storage.apply(old, { retainedMessageIDs: [] });
  assert.equal(before.sessions.session.speed?.generation.responseCount ?? 0, 0);
  assert.equal(before.sessions.session.speed?.response.responseCount ?? 0, 0);
  assert.deepEqual(await storage.backfillSpeed([old, missing]), before);
  assert.deepEqual(await createTotalsStorage(storage.path).backfillSpeed([old]), before);
});

test("backfill and stale history cannot overwrite a newer authoritative exact correction", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const stale = historyRecord("m", { tokens: tokens(1, 100), time: { start: 0, completed: 1000 } });
  await storage.apply(stale);
  await storage.backfillSpeed([stale]);
  const exact: MeasuredHistoryRecord = { ...stale, tokens: tokens(1, 2), time: { start: 500, completed: 600 },
    speed: { response: { generatedTokens: 2, durationMs: 100, estimated: false } },
    update: { source: "live", instanceID: "writer", sequence: 2, receivedAt: 2000, fingerprint: "new", seenFingerprints: ["new"] } };
  const corrected = await storage.apply(exact, { retainedMessageIDs: [] });
  assert.equal((corrected.settled.m as any).speedBackfill, undefined);
  assert.equal(corrected.sessions.session.speed?.response.durationMs, 100);
  assert.deepEqual(await storage.backfillSpeed([stale]), corrected);
  assert.deepEqual(await createTotalsStorage(storage.path).apply(stale), corrected);
  const replay: MeasuredHistoryRecord = { ...stale, update: { ...exact.update!, sequence: 1, fingerprint: "old", seenFingerprints: ["old"] } };
  assert.deepEqual(await storage.apply(replay), corrected);
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

function measuredV3Speed(counts: TokenCounts) {
  const record = historyRecord("measurement", { quality: "exact", tokens: counts, time: { start: 0, completed: 3000 } });
  return measureRecordSpeed(record, { usageExact: true, responseTimingExact: true, generation: {
    version: 3, coverage: "complete", complete: true, estimated: true,
    start: 100, end: 2100, firstReceiveMono: 10, lastReceiveMono: 2010, observationCount: 2,
    timeSource: "receive-monotonic", fromCurrentStart: true, selectedStream: "v2", stepID: "step-1",
    outputObserved: true, reasoningObserved: true,
    bytes: { output: { total: 100, firstBatch: 25 }, reasoning: { total: 100, firstBatch: 50 } },
    usage: { output: counts.output, reasoning: counts.reasoning },
  } });
}

function shortV3Speed(counts: TokenCounts) {
  const original = measuredV3Speed(counts).generationEvidence!;
  const record = historyRecord("short-measurement", { tokens: counts, time: { start: 0, completed: 3000 } });
  return measureRecordSpeed(record, { usageExact: true, responseTimingExact: true, generation: {
    ...original, start: 100, end: 300, firstReceiveMono: 10, lastReceiveMono: 210,
    clockSource: "performance.now", clockResolutionMs: 1, observationQuality: "short", complete: true, estimated: true,
  } });
}

test("short generation quality survives usage corrections, +/- message exclusion, rollup projection and restart", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const normal = historyRecord("normal-short", { tokens: tokens(1, 10, 2), speed: shortV3Speed(tokens(1, 10, 2)) });
  const baseline = await storage.apply(normal);
  assert.equal(baseline.sessions.session.speed?.generation.shortResponseCount, 1);
  const compact = historyRecord("compact-short", { tokens: tokens(2, 20, 4), speed: shortV3Speed(tokens(2, 20, 4)) });
  const combined = await storage.apply(compact);
  assert.equal(combined.sessions.session.speed?.generation.shortResponseCount, 2);
  const corrected = await storage.apply({ ...compact, tokens: tokens(1, 5, 1), speed: shortV3Speed(tokens(1, 5, 1)) }, { retainedMessageIDs: ["normal-short"] });
  assert.equal(corrected.sessions.session.speed?.generation.shortResponseCount, 2);
  const excluded = await storage.excludeMessage("compact-short", classifyMessageMetadata({ providerID: "magic-context" }));
  assert.deepEqual(excluded.sessions, baseline.sessions);
  assert.equal(excluded.sessions.session.speed?.generation.shortResponseCount, 1);
  assert.deepEqual((await createTotalsStorage(storage.path).read()).sessions, baseline.sessions);
  await storage.apply(historyRecord("mc-short", { sessionID: "mc", tokens: tokens(2, 20, 4), speed: shortV3Speed(tokens(2, 20, 4)) }));
  await storage.setSessionScope("mc", classifyMessageMetadata({ mode: "dreamer" }));
  const projected = projectTotalsMeasurementScope(await storage.read());
  assert.deepEqual(projected.sessions, baseline.sessions);
  assert.equal(projected.sessions.session.speed?.generation.shortResponseCount, 1);
});

test("legacy TUI projection hides generation without mutating usage, response, marker, or disk", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const record = historyRecord("m", { quality: "exact", tokens: tokens(1, 10, 2), time: { start: 0, completed: 3000 }, speed: measuredV3Speed(tokens(1, 10, 2)) });
  const legacy = await storage.apply(record, { retainedMessageIDs: [] });
  delete legacy.generationBasisVersion;
  const before = JSON.stringify(legacy);
  const projected = projectTotalsGenerationBasis(legacy);
  assert.equal(projected.generationBasisVersion, undefined);
  assert.equal(projected.version, 1);
  assert.equal(projected.sessions.session.speed?.generation.generatedTokens, 0);
  assert.equal(projected.sessions.session.speed?.generation.coverageGeneratedTokens, 0);
  assert.deepEqual(projected.sessions.session.speed?.response, legacy.sessions.session.speed?.response);
  assert.deepEqual(projected.sessions.session.tokens, legacy.sessions.session.tokens);
  assert.equal((projected.settled.m as any).speed.generationEvidence, undefined);
  assert.equal(JSON.stringify(legacy), before);
  const canonical = await storage.read();
  assert.equal(canonical.generationBasisVersion, 3);
  assert.deepEqual(projectTotalsGenerationBasis(canonical), canonical);
  assert.equal(canonical.sessions.session.speed?.generation.generatedTokens, 8.5);
});

for (const settled of [false, true]) {
  test(`missing ${settled ? "settled" : "open"} correction measurement reuses only qualified v3 proportions`, async (context) => {
    const directory = await makeTestDirectory(context);
    const path = join(directory, "totals.json");
    const storage = createTotalsStorage(path);
    const options = { retainedMessageIDs: settled ? [] : ["m"] };
    const original = historyRecord("m", { quality: "exact", tokens: tokens(1, 10, 2), time: { start: 0, completed: 3000 }, speed: measuredV3Speed(tokens(1, 10, 2)) });
    await storage.apply(original, options);
    const correction = { ...original, tokens: tokens(1, 20, 4) };
    delete correction.speed;
    const corrected = await createTotalsStorage(path).apply(correction, options);
    assert.equal(corrected.sessions.session.speed?.generation.generatedTokens, 17);
    assert.equal(corrected.sessions.session.speed?.generation.coverageGeneratedTokens, 24);
    assert.equal(corrected.sessions.session.speed?.generation.durationMs, 2000);
    assert.equal(corrected.sessions.session.speed?.generation.responseCount, 1);
  });

  test(`same-v3 ${settled ? "settled" : "open"} correction after reload recalibrates interval tokens, not full coverage`, async (context) => {
    const directory = await makeTestDirectory(context);
    const path = join(directory, "totals.json");
    const storage = createTotalsStorage(path);
    const options = { retainedMessageIDs: settled ? [] : ["m"] };
    const update = (sequence: number) => ({ source: "live" as const, instanceID: "writer", sequence, receivedAt: sequence,
      fingerprint: String(sequence), seenFingerprints: Array.from({ length: sequence }, (_, i) => String(i + 1)) });
    const original: MeasuredHistoryRecord = { ...historyRecord("m", { quality: "exact", tokens: tokens(1, 10, 2),
      time: { start: 0, completed: 3000 }, speed: measuredV3Speed(tokens(1, 10, 2)) }), update: update(1) };
    await storage.apply(original, options);
    const correction: MeasuredHistoryRecord = { ...original, tokens: tokens(1, 20, 4),
      speed: { response: { generatedTokens: 24, durationMs: 3000, estimated: false } }, update: update(2) };
    correction.speed = mergeRecordSpeed(correction, original);
    const reloaded = createTotalsStorage(path);
    const corrected = await reloaded.apply(correction, options);
    assert.equal(corrected.sessions.session.speed?.generation.generatedTokens, 17);
    assert.equal(corrected.sessions.session.speed?.generation.coverageGeneratedTokens, 24);
    assert.equal(corrected.sessions.session.speed?.generation.durationMs, 2000);
    assert.equal(corrected.sessions.session.speed?.generation.responseCount, 1);
    assert.equal(corrected.sessions.session.speed?.generation.estimatedResponseCount, 1);
    assert.equal(getSessionAverageSummary(corrected.sessions.session).generation.rate, 8.5);
    const contribution = settled ? corrected.settled.m : corrected.open.m;
    assert.equal((contribution as any).speed.generationEvidence.usage.output, 20);
    assert.deepEqual(await reloaded.apply(correction, options), corrected);
    assert.deepEqual(await reloaded.apply(original, options), corrected);
    assert.deepEqual(await reloaded.backfillSpeed([original]), corrected);
    assert.deepEqual(await reloaded.seed([original]), corrected);
    const provisional: MeasuredHistoryRecord = { ...correction, quality: "provisional", tokens: tokens(100), update: update(3) };
    assert.deepEqual(await reloaded.apply(provisional, options), corrected);
    const revoked: MeasuredHistoryRecord = { ...correction, speed: { response: correction.speed.response }, update: update(3) };
    const removed = await reloaded.apply(revoked, options);
    assert.equal(removed.sessions.session.speed?.generation.responseCount, 0);
    assert.equal(removed.sessions.session.speed?.generation.generatedTokens, 0);
    assert.equal(removed.sessions.session.speed?.generation.coverageGeneratedTokens, 0);
    assert.equal(removed.sessions.session.speed?.response.responseCount, 1);
    assert.equal(((settled ? removed.settled.m : removed.open.m) as any).speed?.generation, undefined);
    assert.deepEqual(await reloaded.apply(original, options), removed);
  });

  test(`old ${settled ? "settled" : "open"} snapshots never subtract generation from the v3 accumulated epoch`, async (context) => {
    const directory = await makeTestDirectory(context);
    const path = join(directory, "totals.json");
    const storage = createTotalsStorage(path);
    const old = historyRecord("old", { quality: "exact", tokens: tokens(1, 10), time: { start: 0, completed: 3000 } });
    await storage.apply(old, { retainedMessageIDs: settled ? [] : ["old"] });
    const fresh = historyRecord("fresh", { quality: "exact", tokens: tokens(1, 20, 4), time: { start: 0, completed: 3000 }, speed: measuredV3Speed(tokens(1, 20, 4)) });
    const before = await storage.apply(fresh, { retainedMessageIDs: settled ? ["fresh"] : ["old", "fresh"] });
    const snapshot = settled ? before.settled.old : before.open.old;
    (snapshot as any).speed = { generation: { generatedTokens: 500, durationMs: 1000, estimated: true },
      generationEvidence: { version: 2, coverage: "complete", start: 100, end: 1100, outputObserved: true, reasoningObserved: false } };
    await writeFile(path, JSON.stringify(before));
    const generation = { ...before.sessions.session.speed!.generation };
    const corrected = await createTotalsStorage(path).apply({ ...old, tokens: tokens(1, 5) });
    assert.deepEqual(corrected.sessions.session.speed?.generation, generation);
    // Session reassignment exercises the separate subtractContribution path.
    (corrected.open.old as any).speed = (snapshot as any).speed;
    await writeFile(path, JSON.stringify(corrected));
    const moved = await storage.apply({ ...old, sessionID: "other", tokens: tokens(1, 5) });
    assert.deepEqual(moved.sessions.session.speed?.generation, generation);
    assert.equal(moved.sessions.other.speed?.generation.responseCount ?? 0, 0);
    assert.equal(moved.sessions.session.responseCount, 1);
    assert.equal(moved.sessions.other.responseCount, 1);
    assert.equal(moved.generationBasisVersion, 3);
  });
}

test("speed survives trimming and reload, time-only settled corrections and migration are reversible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-speed-"));
  const path = join(directory, "totals.json");
  try {
    const storage = createTotalsStorage(path);
    const first = historyRecord("speed", { tokens: tokens(1, 100), speed: { response: { generatedTokens: 100, durationMs: 1000, estimated: true } } });
    await storage.apply(first, { retainedMessageIDs: [] });
    const corrected = { ...first, speed: { response: { generatedTokens: 100, durationMs: 2000, estimated: false } } };
    await createTotalsStorage(path).apply(corrected, { retainedMessageIDs: [] });
    await createTotalsStorage(path).apply(corrected, { retainedMessageIDs: [] });
    let ledger = await storage.read();
    assert.equal(ledger.sessions.session?.responseCount, 1);
    assert.equal(ledger.sessions.session?.speed?.response.durationMs, 2000);
    assert.equal(ledger.sessions.session?.speed?.response.estimatedResponseCount, 0);
    assert.notEqual(ledger.settled.speed, true);
    await storage.apply({ ...corrected, sessionID: "migrated" });
    ledger = await storage.read();
    assert.equal(ledger.sessions.session?.speed?.response.responseCount, 0);
    assert.equal(ledger.sessions.migrated?.speed?.response.generatedTokens, 100);
    assert.equal(ledger.sessions.migrated?.responseCount, 1);
    // Legacy true carries no subtractable snapshot and cannot be backfilled.
    const old = { ...ledger, open: {}, settled: { speed: true } };
    await writeFile(path, JSON.stringify(old));
    await storage.apply({ ...corrected, sessionID: "other" });
    assert.equal((await storage.read()).sessions.other, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
