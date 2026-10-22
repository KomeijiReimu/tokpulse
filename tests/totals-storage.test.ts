import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import type { HistoryRecord, TokenCounts } from "../src/core.js";
import type { MeasuredHistoryRecord } from "../src/statistics.js";
import { filterHistoryRecords } from "../src/storage.js";
import { createTotalsStorage, getExcludedMessageIDs, isCorruptTotalsError, projectTotalsMeasurementScope, resolveTotalsPath, type SessionMetadataUpdate } from "../src/totals-storage.js";
import { classifyMessageMetadata, classifySessionMetadata, createScopeRegistry } from "../src/scope.js";

test("metadata batch merges same-SID agents and durable scopes without changing usage or downgrading exclusions", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const baseline = await storage.apply(historyRecord("normal", { sessionID: "root", tokens: tokens(1, 20, 2, 3, 4), cost: 5 }));
  const proof = classifySessionMetadata({ id: "root", parentID: "parent", agent: "dreamer" });
  const updates: readonly SessionMetadataUpdate[] = [
    { sessionID: "root", agents: [" fixer ", "oracle", "fixer"] },
    { sessionID: "root", agents: ["build", "oracle"], scope: proof },
    { sessionID: "root", scope: classifySessionMetadata({ agent: "build" }) },
    { sessionID: "other", agents: ["designer"] },
  ];
  const merged = await storage.setSessionMetadataMany(updates);
  assert.deepEqual(merged.sessions, baseline.sessions);
  assert.deepEqual(merged.open, baseline.open);
  assert.deepEqual(merged.settled, baseline.settled);
  assert.deepEqual(merged.sessionAgents?.root, ["build", "fixer", "oracle"]);
  assert.deepEqual(merged.sessionAgents?.other, ["designer"]);
  assert.equal(merged.sessionScopes?.root.sourceScope, "magic-session");
  assert.equal(merged.sessionScopes?.root.parentSessionID, "parent");
  assert.equal(projectTotalsMeasurementScope(merged).sessions.root, undefined);
  assert.deepEqual(await createTotalsStorage(storage.path).setSessionMetadataMany(updates), merged);
  merged.sessionAgents!.root.push("mutated");
  merged.sessionScopes!.root.reasons.length = 0;
  const canonical = await storage.read();
  assert.deepEqual(canonical.sessionAgents?.root, ["build", "fixer", "oracle"]);
  assert.ok(canonical.sessionScopes!.root.reasons.length > 0);
  // The new method is not a cache: an external authoritative replacement is
  // observed even by an empty/no-op batch.
  canonical.sessionAgents!.other = ["external"];
  await writeFile(storage.path, JSON.stringify(canonical));
  assert.deepEqual((await storage.setSessionMetadataMany([])).sessionAgents?.other, ["external"]);
});

test("metadata batch validates all entries before publication and safely handles special session IDs", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  await storage.seed([]);
  const before = await readFile(storage.path, "utf8");
  for (const invalid of [
    { sessionID: "", agents: ["fixer"] },
    { sessionID: 1 },
    { sessionID: "bad", agents: "fixer" },
    { sessionID: "bad", agents: ["ok", 1] },
    { sessionID: "bad", agents: ["bad\u001bname"] },
    { sessionID: "bad", scope: { version: 1, sourceScope: "invalid" } },
    { sessionID: "bad", scope: classifyMessageMetadata({ providerID: "magic-context" }) },
  ]) {
    await assert.rejects(storage.setSessionMetadataMany([{ sessionID: "good", agents: ["oracle"] }, invalid] as unknown as SessionMetadataUpdate[]), TypeError);
    assert.equal(await readFile(storage.path, "utf8"), before);
  }
  await assert.rejects(storage.setSessionMetadataMany({} as unknown as SessionMetadataUpdate[]), TypeError);
  const ids = ["constructor", "toString", "__proto__"];
  const updates = ids.flatMap((sessionID): SessionMetadataUpdate[] => [
    { sessionID, agents: ["fixer"], scope: classifySessionMetadata({ agent: "build" }) },
    { sessionID, agents: ["oracle"] },
  ]);
  const merged = await storage.setSessionMetadataMany(updates);
  for (const id of ids) {
    assert.equal(Object.hasOwn(merged.sessionAgents!, id), true);
    assert.deepEqual(merged.sessionAgents![id], ["fixer", "oracle"]);
    assert.equal(Object.hasOwn(merged.sessionScopes!, id), true);
    assert.equal(merged.sessionScopes![id].sourceScope, "user");
  }
  assert.equal(({} as any).sourceScope, undefined);
  assert.deepEqual(await storage.setSessionMetadataMany(updates), merged);
  const concurrent = await Promise.all([
    storage.setSessionMetadataMany([{ sessionID: "__proto__", agents: ["build"] }]),
    createTotalsStorage(storage.path).setSessionMetadataMany([{ sessionID: "__proto__", agents: ["designer"] }]),
  ]);
  assert.deepEqual(concurrent[1].sessionAgents!["__proto__"], ["build", "designer", "fixer", "oracle"]);
});

test("late MC identity excludes descendant usage while preserving raw cumulative data", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  for (const sessionID of ["root", "real", "mc", "grand"]) {
    await storage.apply(historyRecord(sessionID, { sessionID, tokens: tokens(1, 10, 2) }));
  }
  const before = await storage.read();
  const registry = createScopeRegistry();
  registry.observeSessionMetadata("mc", { parentID: "root" });
  registry.observeSessionMetadata("grand", { parentID: "mc" });
  registry.observeSessionMetadata("mc", { id: "mc", parentID: "root", agent: "dreamer" });
  for (const [sid, proof] of Object.entries(registry.serialize())) await storage.setSessionScope(sid, proof);
  const after = await storage.read();
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.open, before.open);
  const projected = projectTotalsMeasurementScope(after);
  assert.deepEqual(Object.keys(projected.sessions).sort(), ["real", "root"]);
  assert.deepEqual(projected.sessions.root, before.sessions.root);
  assert.deepEqual(projected.sessions.real, before.sessions.real);
  assert.equal(projected.generationBasisVersion, before.generationBasisVersion);
  assert.equal(projectTotalsMeasurementScope(await createTotalsStorage(storage.path).read()).sessions.mc, undefined);
  await storage.setSessionScope("mc", classifySessionMetadata({ agent: "build" }));
  assert.equal(projectTotalsMeasurementScope(await storage.read()).sessions.mc, undefined);
  assert.equal((await storage.read()).sessions.mc.tokens.output, 10);
});

for (const settled of [false, true]) {
  test(`maintenance message in ordinary session excludes only its ${settled ? "settled" : "open"} contribution, not session or child`, async (context) => {
    const directory = await makeTestDirectory(context);
    const storage = createTotalsStorage(join(directory, "totals.json"));
    const normal = historyRecord("normal", { sessionID: "root", quality: "exact", tokens: tokens(2, 20, 4, 5, 6), cost: 3 });
    const child = historyRecord("child-work", { sessionID: "child", parentSessionID: "root", quality: "exact", tokens: tokens(7, 30, 8, 9, 10), cost: 4 });
    await storage.apply(normal);
    const baseline = await storage.apply(child);
    const maintenance = historyRecord("maintenance", { sessionID: "root", quality: "exact", tokens: tokens(100, 200, 30, 40, 50), cost: 9 });
    const retainedMessageIDs = settled ? [normal.messageID, child.messageID] : [normal.messageID, child.messageID, maintenance.messageID];
    const included = await storage.apply(maintenance, { retainedMessageIDs });
    assert.equal(included.sessions.root.responseCount, 2);
    assert.equal(included.sessions.root.cost, 12);
    assert.deepEqual(included.sessions.root.tokens, tokens(102, 220, 34, 45, 56));
    assert.equal(settled ? included.settled.maintenance !== undefined : included.open.maintenance !== undefined, true);

    const registry = createScopeRegistry();
    registry.observeSessionMetadata("root", { id: "root", agent: "build" });
    registry.observeSessionMetadata("child", { id: "child", parentID: "root", agent: "fixer" });
    const proof = registry.observeMessageMetadata("root", { agent: "historian-editor" });
    assert.equal(proof.sourceScope, "magic-message");
    assert.equal(registry.isExcluded("root"), false);
    assert.equal(registry.isExcluded("child"), false);
    for (const [id, evidence] of Object.entries(registry.serialize())) await storage.setSessionScope(id, evidence);
    const excluded = await storage.excludeMessage(maintenance.messageID, proof);
    assert.deepEqual(excluded.sessions, baseline.sessions);
    const projected = projectTotalsMeasurementScope(excluded);
    assert.deepEqual(Object.keys(projected.sessions).sort(), ["child", "root"]);
    assert.deepEqual(projected.sessions.root.tokens, normal.tokens);
    assert.equal(projected.sessions.root.cost, 3);
    assert.equal(projected.sessions.root.responseCount, 1);
    assert.deepEqual(projected.sessions.child.tokens, child.tokens);
    assert.equal(projected.sessions.child.cost, 4);
    assert.equal(projected.sessions.child.responseCount, 1);
    assert.equal(excluded.sessionScopes?.root?.sourceScope === "magic-session", false);
    const tombstone = excluded.settled.maintenance;
    assert.notEqual(tombstone, true);
    if (tombstone === true) throw new Error("Expected reversible exclusion snapshot");
    assert.deepEqual(tombstone.excluded, proof);
    assert.deepEqual(tombstone.tokens, maintenance.tokens);
    assert.equal(tombstone.cost, 9);
    assert.equal(excluded.open.maintenance, undefined);
    assert.deepEqual([...getExcludedMessageIDs(excluded)], [maintenance.messageID]);
    assert.deepEqual(filterHistoryRecords([normal, maintenance, child], excluded.sessionScopes, undefined, getExcludedMessageIDs(excluded)), [normal, child]);

    const reopened = createTotalsStorage(storage.path);
    assert.deepEqual(await reopened.excludeMessage(maintenance.messageID, proof), excluded);
    assert.deepEqual(await reopened.apply(maintenance, { retainedMessageIDs }), excluded);
    const correction: MeasuredHistoryRecord = { ...maintenance, cost: 99, tokens: tokens(1000, 2000), update: {
      source: "live", instanceID: "new-writer", sequence: 2, receivedAt: 100,
      fingerprint: "correction", seenFingerprints: ["correction"],
    } };
    assert.deepEqual(await reopened.apply(correction, { retainedMessageIDs }), excluded);
    assert.deepEqual(await reopened.apply(child, { retainedMessageIDs }), excluded);
    assert.deepEqual(await reopened.apply(normal, { retainedMessageIDs }), excluded);
    assert.deepEqual(projectTotalsMeasurementScope(await reopened.read()).sessions, baseline.sessions);
  });
}

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
  const exact = historyRecord("m", { quality: "exact", tokens: tokens(1, 10, 2) });
  const promoted = await storage.apply(exact);
  assert.equal(promoted.open.m.quality, "exact");
  assert.equal(promoted.sessions.session.tokens.output, 10);
  assert.equal(promoted.sessions.session.responseCount, 1);
  assert.deepEqual(await storage.apply(provisional), promoted);
});

for (const settled of [false, true]) {
  test(`direct apply preserves ${settled ? "settled" : "open"} exact usage against provisional replacement after reload`, async (context) => {
    const directory = await makeTestDirectory(context);
    const path = join(directory, "totals.json");
    const storage = createTotalsStorage(path);
    const options = { retainedMessageIDs: settled ? [] : ["m"] };
    const exact = historyRecord("m", {
      quality: "exact", tokens: tokens(1, 10, 2), cost: 3,
      time: { start: 0, completed: 3000 },
    });
    const before = await storage.apply(exact, options);
    const provisional = historyRecord("m", {
      quality: "provisional", tokens: tokens(1), cost: 0,
    });
    assert.deepEqual(await storage.apply(provisional, options), before);
    const reloaded = createTotalsStorage(path);
    const after = await reloaded.apply(provisional, options);
    assert.deepEqual(after, before);
    assert.deepEqual(after.sessions.session?.tokens, tokens(1, 10, 2));
    assert.equal(after.sessions.session?.responseCount, 1);

    const corrected = await reloaded.apply(historyRecord("m", {
      quality: "exact", tokens: tokens(1), cost: 0,
      time: { start: 0, completed: 3000 },
    }), options);
    assert.deepEqual(corrected.sessions.session?.tokens, tokens(1));
    assert.equal(corrected.sessions.session?.cost, 0);
    assert.equal(corrected.sessions.session?.responseCount, 1);
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
  const contribution = { sessionID: "session", quality: "exact", tokens: tokens(2, 10, 5, 7, 11), cost: 3, update,
    speed: { response, generation: { generatedTokens: 15, durationMs: 100, estimated: true },
      generationEvidence: { start: 100, end: 200, outputObserved: true, reasoningObserved: true, version: 2, coverage: "complete" } } };
  const before = { version: 1, sessions: { session: { tokens: tokens(6, 30, 15, 21, 33), cost: 9, responseCount: 3,
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
  const cache = join(homedir(), ".cache", "tokpulse-tests");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "oc-tps-totals-"));
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

test("session agent names accumulate without recounting and survive clipping, seed, scope, and legacy ledgers", async (context) => {
  const directory = await makeTestDirectory(context);
  const storage = createTotalsStorage(join(directory, "totals.json"));
  const fixer = historyRecord("fixer", { sessionID: "s", agent: " fixer ", tokens: tokens(1, 4), cost: 2 });
  const first = await storage.apply(fixer);
  assert.deepEqual(first.sessionAgents?.s, ["fixer"]);
  assert.equal(first.sessions.s.tokens.output, 4);
  assert.equal(first.sessions.s.cost, 2);
  assert.equal(first.sessions.s.responseCount, 1);
  const repeated = await storage.apply({ ...fixer, agent: "fixer" });
  assert.equal(repeated.sessions.s.responseCount, 1);
  assert.equal(repeated.sessions.s.tokens.output, 4);
  assert.equal(repeated.sessions.s.cost, 2);
  const both = await storage.apply(historyRecord("oracle", { sessionID: "s", agent: "oracle", tokens: tokens(1, 6), cost: 3 }), { retainedMessageIDs: ["oracle"] });
  assert.deepEqual(both.sessionAgents?.s, ["fixer", "oracle"]);
  assert.equal(both.sessions.s.tokens.output, 10);
  assert.equal(both.sessions.s.cost, 5);
  assert.equal(both.sessions.s.responseCount, 2);
  assert.equal(both.open.fixer, undefined);
  assert.equal((both.settled.fixer as { tokens: TokenCounts }).tokens.output, 4);
  const clipped = await storage.applyMany([], { retainedMessageIDs: [] });
  assert.deepEqual(clipped.sessionAgents?.s, ["fixer", "oracle"]);
  assert.equal(clipped.sessions.s.responseCount, 2);
  assert.equal(clipped.sessions.s.tokens.output, 10);
  const seeded = await storage.seed([historyRecord("oracle", { sessionID: "s", agent: " custom-worker ", tokens: tokens(9, 90), cost: 9 })]);
  assert.deepEqual(seeded.sessionAgents?.s, ["custom-worker", "fixer", "oracle"]);
  assert.equal(seeded.sessions.s.tokens.output, 10);
  assert.equal(seeded.sessions.s.cost, 5);
  assert.equal(seeded.sessions.s.responseCount, 2);
  const written = await stat(storage.path, { bigint: true });
  const same = await storage.setSessionAgent("s", "fixer");
  assert.equal((await stat(storage.path, { bigint: true })).mtimeNs, written.mtimeNs);
  assert.deepEqual(same.sessionAgents?.s, seeded.sessionAgents?.s);
  await storage.setSessionAgent("s", "bad\u001bname");
  await storage.setSessionAgent("other", "compaction");
  await storage.setSessionAgent("other", "x".repeat(257));
  assert.equal((await stat(storage.path, { bigint: true })).mtimeNs, written.mtimeNs);
  assert.equal((await storage.read()).sessionAgents?.other, undefined);
  await storage.setSessionScope("s", classifySessionMetadata({ agent: "build" }));
  await storage.excludeMessage("oracle", classifyMessageMetadata({ providerID: "magic-context" }));
  const kept = await storage.read();
  assert.deepEqual(kept.sessionAgents?.s, ["custom-worker", "fixer", "oracle"]);
  assert.equal(kept.sessions.s.tokens.output, 4);
  assert.equal(kept.sessions.s.responseCount, 1);
  const legacyPath = join(directory, "legacy.json");
  const legacy = createTotalsStorage(legacyPath);
  await writeFile(legacyPath, JSON.stringify({ version: 1, sessions: { s: { tokens: tokens(1, 4), cost: 2, responseCount: 1 } }, open: {}, settled: {} }));
  const old = await legacy.read();
  assert.equal(old.sessionAgents, undefined);
  assert.equal(old.sessions.s.tokens.output, 4);
  assert.equal(old.sessions.s.responseCount, 1);
  await writeFile(legacyPath, JSON.stringify({ ...old, sessionAgents: { s: [" oracle ", "fixer", "compaction", "bad\nname", "x".repeat(257)], blank: [" "], "": ["fixer"], bad: "designer" } }));
  assert.deepEqual((await legacy.read()).sessionAgents, { s: ["fixer", "oracle"] });
  assert.equal((await legacy.read()).sessions.s.cost, 2);
});
