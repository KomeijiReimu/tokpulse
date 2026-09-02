import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ActivityLedger,
  deriveRunsPath,
  parseActivityJsonl,
  serializeActivityJsonl,
} from "../src/runs-storage.js";

test("history path derives a sibling runs.jsonl and explicit absolute path wins", () => {
  assert.equal(deriveRunsPath("/tmp/oc/history.jsonl"), "/tmp/oc/runs.jsonl");
  assert.equal(new ActivityLedger({ historyPath: "/tmp/oc/history.jsonl" }).path, "/tmp/oc/runs.jsonl");
  assert.equal(new ActivityLedger({ historyPath: "/tmp/oc/history.jsonl", runsPath: "/var/tmp/runs.jsonl" }).path, "/var/tmp/runs.jsonl");
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
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-runs-"));
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
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-runs-separator-"));
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
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-runs-read-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runsPath = join(directory, "runs.jsonl");
  const content = `${JSON.stringify(lifecycle("valid", 1, "session", 1))}\n{truncated`;
  await writeFile(runsPath, content, "utf8");

  const ledger = new ActivityLedger(runsPath);
  assert.equal((await ledger.read()).length, 1);
  assert.equal(await readFile(runsPath, "utf8"), content);
});

test("multiple roots are replayed independently", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-runs-replay-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new ActivityLedger({ historyPath: join(directory, "history.jsonl") });
  await ledger.appendMany([
    lifecycle("a-busy", 0, "root-a", 1),
    lifecycle("a-completed", 10, "root-a", 2),
    lifecycle("b-busy", 0, "root-b", 1),
    lifecycle("b-completed", 20, "root-b", 2),
  ]);

  const replay = await ledger.replay();
  assert.deepEqual(replay.roots.map((root) => [root.rootSessionID, root.activeMilliseconds]), [
    ["root-a", 10],
    ["root-b", 20],
  ]);
});

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
