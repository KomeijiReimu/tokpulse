import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import {
  ActivityLedger,
  parseActivityJsonl,
  serializeActivityJsonl,
} from "../src/runs-storage.js";
import { classifyMessageMetadata, classifySessionMetadata, createScopeRegistry } from "../src/scope.js";

test("scoped ledger read/replay retracts late identity but preserves original runs and boundaries", async (context) => {
  const directory = await testDirectory("oc-tps-runs-scope-");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new ActivityLedger(join(directory, "runs.jsonl"));
  await ledger.appendMany([
    lifecycle("user-start", 0, "root", 1), lifecycle("user-stop", 100, "root", 2),
    { ...lifecycle("mc-start", 0, "mc", 1), instanceID: "old", lastObservedAt: 1000 },
    { kind: "parent", sessionID: "mc", parentSessionID: "root", timestamp: 2000 },
    { kind: "parent", sessionID: "grand", parentSessionID: "mc", timestamp: 2001 },
    lifecycle("grand-start", 0, "grand", 1), lifecycle("grand-stop", 2000, "grand", 2),
  ]);
  const raw = await readFile(ledger.path, "utf8");
  assert.equal((await ledger.replay()).rootActiveMilliseconds.root, 2000);
  const sessionScopes = { mc: classifySessionMetadata({ id: "mc", parentID: "root", agent: "dreamer" }) };
  assert.equal((await ledger.replay({ sessionScopes, replayCutoff: 100_000 })).rootActiveMilliseconds.root, 100);
  assert.deepEqual((await ledger.read({ sessionScopes })).map((event) => event.sessionID), ["root", "root"]);
  assert.equal((await ledger.read()).length, 7);
  assert.equal(await readFile(ledger.path, "utf8"), raw);
  assert.equal((await new ActivityLedger(ledger.path).read()).find((event) => event.sessionID === "mc")?.lastObservedAt, 1000);
});

test("maintenance message proof does not hide ordinary session lifecycle or its child", async (context) => {
  const directory = await testDirectory("oc-tps-runs-message-scope-");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new ActivityLedger(join(directory, "runs.jsonl"));
  await ledger.appendMany([
    lifecycle("root-start", 0, "root", 1), lifecycle("root-stop", 100, "root", 2),
    { kind: "parent", sessionID: "child", parentSessionID: "root", timestamp: 0 },
    lifecycle("child-start", 0, "child", 1), lifecycle("child-stop", 2000, "child", 2),
  ]);
  const raw = await readFile(ledger.path, "utf8");
  const registry = createScopeRegistry();
  registry.observeSessionMetadata("root", { id: "root", agent: "build" });
  registry.observeSessionMetadata("child", { id: "child", parentID: "root", agent: "fixer" });
  const messageProof = registry.observeMessageMetadata("root", { agent: "historian-editor" });
  assert.equal(messageProof.sourceScope, "magic-message");
  assert.equal(classifyMessageMetadata({ mode: "dreamer" }).sourceScope, "magic-message");
  assert.equal(registry.isExcluded("root"), false);
  assert.equal(registry.isExcluded("child"), false);
  const all = await ledger.read();
  const originalReplay = await ledger.replay();
  for (const sessionScopes of [registry.serialize(), { ...registry.serialize(), root: messageProof }]) {
    assert.deepEqual(await ledger.read({ sessionScopes }), all);
    const replay = await ledger.replay({ sessionScopes, replayCutoff: 100_000 });
    assert.equal(replay.rootActiveMilliseconds.root, 2000);
    assert.deepEqual(replay.events, originalReplay.events);
    assert.equal((await new ActivityLedger(ledger.path).replay({ sessionScopes, replayCutoff: 3_600_000 })).rootActiveMilliseconds.root, 2000);
  }
  // Message classification is not a session-wide or lifecycle-wide boundary.
  // No work spans are supplied here: their local subtraction is tested by the
  // activity schema owner, not inferred by hiding these session facts.
  assert.equal(await readFile(ledger.path, "utf8"), raw);
});

test("activity JSONL round-trips and tolerates bad or truncated lines", () => {
  const first = lifecycle("first", 0, "root", 1);
  const second = lifecycle("second", 10, "child", 1);
  const content = `${serializeActivityJsonl([first, second])}not-json\n${JSON.stringify({ kind: "lifecycle", sessionID: "cut", state: "busy"})}`;
  const parsed = parseActivityJsonl(content);

  assert.deepEqual(parsed.map((event) => event.sessionID), ["root", "child"]);
  assert.equal(parsed[0]?.eventID, first.eventID);
});

test("append order is serialized and runs are independent of history maxRecords", async (context) => {
  const directory = await testDirectory("oc-tps-runs-");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runsPath = join(directory, "runs.jsonl");
  const ledger = new ActivityLedger(runsPath);

  const appended = await Promise.all([
    ledger.appendLifecycle(lifecycle("one", 1, "root", 1)),
    ledger.appendLifecycle(lifecycle("two", 2, "root", 2)),
    ledger.appendParent({ sessionID: "child", parentSessionID: "root", timestamp: 3 }),
  ]);
  const read = await ledger.read();
  assert.deepEqual(read.map((event) => event.eventID), appended.map((event) => event.eventID));
  assert.equal((await readFile(runsPath, "utf8")).split("\n").filter(Boolean).length, 3);
});

test("append separates an existing file without reading its full contents", async (context) => {
  const directory = await testDirectory("oc-tps-runs-separator-");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runsPath = join(directory, "runs.jsonl");
  await writeFile(runsPath, "", "utf8");
  const ledger = new ActivityLedger(runsPath);
  const first = lifecycle("first", 1, "root", 1);
  const second = lifecycle("second", 2, "root", 2);

  await ledger.append(first);
  await writeFile(runsPath, JSON.stringify(first), "utf8");
  await ledger.append(second);

  assert.deepEqual((await ledger.read()).map((event) => event.eventID), [first.eventID, second.eventID]);
});

test("read does not rewrite a corrupt runs file", async (context) => {
  const directory = await testDirectory("oc-tps-runs-read-");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runsPath = join(directory, "runs.jsonl");
  const content = `${JSON.stringify(lifecycle("valid", 1, "session", 1))}\n{truncated`;
  await writeFile(runsPath, content, "utf8");

  const ledger = new ActivityLedger(runsPath);
  assert.equal((await ledger.read()).length, 1);
  assert.equal(await readFile(runsPath, "utf8"), content);
});

async function testDirectory(prefix: string): Promise<string> {
  const cache = join(homedir(), ".cache", "tokpulse-tests");
  await mkdir(cache, { recursive: true });
  return mkdtemp(join(cache, prefix));
}

function lifecycle(
  eventID: string,
  timestamp: number,
  sessionID: string,
  seq: number,
): {
  kind: "lifecycle";
  eventID: string;
  state: "busy" | "completed";
  timestamp: number;
  sessionID: string;
  seq: number;
} {
  return {
    kind: "lifecycle",
    eventID,
    state: timestamp === 0 ? "busy" : "completed",
    timestamp,
    sessionID,
    seq,
  };
}
