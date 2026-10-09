import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { PluginInput } from "@opencode-ai/plugin";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { DEFAULT_HISTORY_PATH, migrateDefaultLedgers } from "../src/storage-paths.js";
import { resolveHistoryPath, resolveProjectDirectory, server, type ServerOptions } from "../src/server.js";
import { createRuntimeStore, reloadHistory, resolveHistoryPath as tuiHistoryPath } from "../src/tui.js";
import { resolveTotalsPath } from "../src/totals-storage.js";
import { resolveRunsPath } from "../src/runs-storage.js";
import { classifySessionMetadata } from "../src/scope.js";

const legacyRelative = ".opencode/oc-tps/history.jsonl";
const filenames = ["history.jsonl", "totals.json", "runs.jsonl"] as const;

async function project(context: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const cache = join(homedir(), ".cache", "tokpulse-tests");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "storage-paths-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function paths(base: string, options: ServerOptions = {}) {
  const historyPath = resolveHistoryPath(base, options.historyPath);
  return {
    historyPath,
    totalsPath: resolveTotalsPath({ historyPath, totalsPath: options.totalsPath }),
    runsPath: resolveRunsPath(historyPath, options.runsPath),
  };
}

function input(base: string, worktree = base): PluginInput {
  return { directory: base, worktree } as PluginInput;
}

function tuiApi(base: string, worktree = base): TuiPluginApi {
  return { state: { path: { directory: base, worktree }, session: { get: () => undefined } },
    ui: { toast: () => undefined } } as unknown as TuiPluginApi;
}

function record(id = "legacy", output = 4) {
  return { version: 1, messageID: id, sessionID: "s", agent: "fixer",
    tokens: { input: 1, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 2,
    time: { start: 0, completed: 100, duration: 100 }, samples: [], quality: "exact" };
}

async function complete(hooks: Awaited<ReturnType<typeof server>>, id: string, output: number): Promise<void> {
  assert.ok(hooks.event);
  await hooks.event({ event: { type: "message.updated", timestamp: 100,
    properties: { info: { id, sessionID: "s", role: "assistant", agent: "oracle",
      tokens: { input: 1, output, reasoning: 0 }, cost: 3, time: { created: 0, completed: 100 } } } } as never });
}

async function absent(path: string): Promise<void> {
  await assert.rejects(lstat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

async function legacyFiles(base: string, files: Partial<Record<typeof filenames[number], string | Buffer>>) {
  const legacy = join(base, ".opencode", "oc-tps");
  await mkdir(legacy, { recursive: true });
  for (const [filename, bytes] of Object.entries(files)) await writeFile(join(legacy, filename), bytes);
  return legacy;
}

test("server and read-only TUI share the new default but retain their project base and custom path semantics", async (context) => {
  const base = await project(context);
  const worktree = join(base, "worktree");
  assert.equal(DEFAULT_HISTORY_PATH, ".tokpulse/history.jsonl");
  for (const tree of [worktree, "/", ""]) {
    const api = tuiApi(base, tree);
    const projectBase = resolveProjectDirectory(input(base, tree));
    for (const configured of [undefined, " ", DEFAULT_HISTORY_PATH, "custom/history.jsonl", join(base, "absolute.jsonl")]) {
      assert.equal(tuiHistoryPath(api, configured), resolveHistoryPath(projectBase, configured));
    }
  }
  const store = createRuntimeStore(10, 0);
  try {
    const resolved = paths(base);
    await reloadHistory(store, tuiApi(base), tuiHistoryPath(tuiApi(base), undefined), resolved.totalsPath, 10);
    assert.deepEqual(store.records, []);
    await absent(join(base, ".tokpulse"));
    await absent(join(base, ".opencode"));
  } finally { store.disposeSignals(); }
});

test("new default plugin writes all ledgers in .tokpulse and TUI reads the same history without creating .opencode", async (context) => {
  const base = await project(context);
  const hooks = await server(input(base));
  await complete(hooks, "new", 7);
  await hooks.event!({ event: { type: "session.idle", timestamp: 200, properties: { sessionID: "s" } } as never });
  const resolved = paths(base);
  for (const file of filenames) assert.ok((await lstat(join(base, ".tokpulse", file))).isFile());
  await absent(join(base, ".opencode"));
  const store = createRuntimeStore(10, 0);
  try {
    const api = tuiApi(base);
    await reloadHistory(store, api, tuiHistoryPath(api, undefined), resolved.totalsPath, 10);
    assert.equal(store.records[0].messageID, "new");
    assert.equal(store.records[0].tokens.output, 7);
    assert.deepEqual(store.totalsLedger.sessionAgents?.s, ["oracle"]);
    assert.equal(store.totalsLedger.sessions.s.responseCount, 1);
  } finally { store.disposeSignals(); }
});

test("controllable old-path baseline migrates before plugin initialization and keeps original data and OpenCode files", async (context) => {
  const base = await project(context);
  const old = await server(input(base), { historyPath: legacyRelative });
  await complete(old, "old", 4);
  await old.event!({ event: { type: "session.idle", timestamp: 200, properties: { sessionID: "s" } } as never });
  const legacy = dirname(join(base, legacyRelative));
  const before = await Promise.all(filenames.map((name) => readFile(join(legacy, name))));
  await writeFile(join(base, ".opencode", "opencode.json"), "config sentinel");
  await mkdir(join(base, ".opencode", "node_modules"));
  await writeFile(join(base, ".opencode", "node_modules", "dependency"), "dependency sentinel");
  const current = await server(input(base));
  await complete(current, "new", 6);
  const ledger = JSON.parse(await readFile(paths(base).totalsPath, "utf8"));
  assert.equal(ledger.sessions.s.tokens.output, 10);
  assert.equal(ledger.sessions.s.responseCount, 2);
  assert.equal(ledger.sessions.s.cost, 6);
  for (const [index, filename] of filenames.entries()) assert.deepEqual(await readFile(join(legacy, filename)), before[index]);
  assert.equal(await readFile(join(base, ".opencode", "opencode.json"), "utf8"), "config sentinel");
  assert.equal(await readFile(join(base, ".opencode", "node_modules", "dependency"), "utf8"), "dependency sentinel");
  await server(input(base));
  const restarted = JSON.parse(await readFile(paths(base).totalsPath, "utf8"));
  assert.equal(restarted.sessions.s.tokens.output, 10);
  assert.equal(restarted.sessions.s.responseCount, 2);
  assert.equal(restarted.sessions.s.cost, 6);
});

test("migration publishes only three opaque byte-identical files, preserves legacy, and never reimports after publication", async (context) => {
  const base = await project(context);
  const bytes = {
    "history.jsonl": Buffer.from('{"scope":{"sourceScope":"magic-message"},"agent":"fixer","speed":{"legacy":123}}\n\0'),
    "totals.json": Buffer.from('{ "sessionAgents":{"s":["fixer","oracle"]},"sessions":{"s":{"cost":123,"responseCount":99}},"unknown":true }\n'),
    "runs.jsonl": Buffer.from([0xff, 0, 10, 20]),
  };
  const legacy = await legacyFiles(base, bytes);
  await writeFile(join(legacy, "not-a-ledger"), "must not copy");
  await mkdir(join(legacy, "nested"));
  assert.equal(await migrateDefaultLedgers(base, paths(base)), true);
  assert.deepEqual((await readdir(join(base, ".tokpulse"))).sort(), [...filenames].sort());
  for (const filename of filenames) {
    assert.deepEqual(await readFile(join(base, ".tokpulse", filename)), bytes[filename]);
    assert.deepEqual(await readFile(join(legacy, filename)), bytes[filename]);
  }
  await writeFile(paths(base).historyPath, "authoritative winner bytes");
  assert.equal(await migrateDefaultLedgers(base, paths(base)), false);
  assert.equal(await readFile(paths(base).historyPath, "utf8"), "authoritative winner bytes");
  assert.equal((await readdir(base)).some((name) => name.startsWith(".tokpulse-migrate-")), false);
});

test("missing legacy directories or absent ledger files cause no migration and never create .opencode", async (context) => {
  const base = await project(context);
  assert.equal(await migrateDefaultLedgers(base, paths(base)), false);
  await absent(join(base, ".opencode"));
  await absent(join(base, ".tokpulse"));
  const legacy = await legacyFiles(base, {});
  await writeFile(join(legacy, "unrelated"), "ignored");
  assert.equal(await migrateDefaultLedgers(base, paths(base)), false);
  await absent(join(base, ".tokpulse"));
  assert.equal((await readdir(base)).some((name) => name.startsWith(".tokpulse-migrate-")), false);
});

for (const present of [["history.jsonl"], ["totals.json"], ["runs.jsonl"], ["history.jsonl", "totals.json"]] as const) {
  test(`migration handles missing bundle members: ${present.join(", ")}`, async (context) => {
    const base = await project(context);
    await legacyFiles(base, Object.fromEntries(present.map((name) => [name, `opaque ${name}`])));
    await mkdir(join(base, ".tokpulse"));
    assert.equal(await migrateDefaultLedgers(base, paths(base)), true);
    assert.deepEqual((await readdir(join(base, ".tokpulse"))).sort(), [...present].sort());
    for (const filename of present) assert.equal(await readFile(join(base, ".tokpulse", filename), "utf8"), `opaque ${filename}`);
  });
}

test("nonempty targets are authoritative even when incomplete or containing unrelated files", async (context) => {
  const base = await project(context);
  await legacyFiles(base, { "history.jsonl": "legacy poison", "totals.json": "legacy poison" });
  await mkdir(join(base, ".tokpulse"));
  await writeFile(join(base, ".tokpulse", "unrelated"), "authoritative");
  assert.equal(await migrateDefaultLedgers(base, paths(base)), false);
  assert.deepEqual(await readdir(join(base, ".tokpulse")), ["unrelated"]);
  await writeFile(paths(base).historyPath, "new ledger");
  assert.equal(await migrateDefaultLedgers(base, paths(base)), false);
  assert.equal(await readFile(paths(base).historyPath, "utf8"), "new ledger");
  await absent(paths(base).totalsPath);
});

test("startup preserves cumulative totals, names, and scope beyond the short migrated history window", async (context) => {
  const base = await project(context);
  const proof = classifySessionMetadata({ agent: "build" });
  const ledger = { version: 1, generationBasisVersion: 3,
    sessions: { s: { tokens: { input: 42, output: 400, reasoning: 5, cacheRead: 20, cacheWrite: 2 }, cost: 123, responseCount: 99 } },
    open: {}, settled: { legacy: true }, sessionAgents: { s: ["fixer", "oracle"] }, sessionScopes: { s: proof } };
  const legacy = await legacyFiles(base, {
    "history.jsonl": `${JSON.stringify(record())}\n`, "totals.json": JSON.stringify(ledger), "runs.jsonl": "",
  });
  const originalTotals = await readFile(join(legacy, "totals.json"));
  await server(input(base));
  const migrated = JSON.parse(await readFile(paths(base).totalsPath, "utf8"));
  assert.deepEqual(migrated.sessions, ledger.sessions);
  assert.deepEqual(migrated.sessionAgents, ledger.sessionAgents);
  assert.deepEqual(migrated.sessionScopes, ledger.sessionScopes);
  await server(input(base));
  assert.deepEqual(JSON.parse(await readFile(paths(base).totalsPath, "utf8")).sessions, ledger.sessions);
  assert.deepEqual(await readFile(join(legacy, "totals.json")), originalTotals);
});

test("existing new ledger initialization never imports legacy history or cumulative usage", async (context) => {
  const base = await project(context);
  const hooks = await server(input(base));
  await complete(hooks, "authoritative", 7);
  await legacyFiles(base, { "history.jsonl": `${JSON.stringify(record("poison", 999))}\n`, "totals.json": "invalid poison" });
  await server(input(base));
  const current = JSON.parse(await readFile(paths(base).totalsPath, "utf8"));
  assert.equal(current.sessions.s.tokens.output, 7);
  assert.equal(current.sessions.s.cost, 3);
  assert.equal(current.sessions.s.responseCount, 1);
  assert.deepEqual(current.sessionAgents.s, ["oracle"]);
  assert.equal(JSON.parse((await readFile(paths(base).historyPath, "utf8")).trim()).messageID, "authoritative");
});

test("explicit relative or absolute default paths are eligible for migration", async (context) => {
  for (const absolute of [false, true]) {
    const base = await project(context);
    await legacyFiles(base, { "history.jsonl": "old default" });
    const historyPath = absolute ? join(base, DEFAULT_HISTORY_PATH) : DEFAULT_HISTORY_PATH;
    const configured = paths(base, { historyPath,
      totalsPath: absolute ? join(base, ".tokpulse", "totals.json") : "totals.json",
      runsPath: absolute ? join(base, ".tokpulse", "runs.jsonl") : "runs.jsonl" });
    assert.equal(await migrateDefaultLedgers(base, configured), true);
    assert.equal(await readFile(configured.historyPath, "utf8"), "old default");
  }
});

for (const option of ["relative-history", "absolute-history", "relative-totals", "absolute-totals", "relative-runs", "absolute-runs"] as const) {
  test(`custom ${option} does not import legacy usage or force default paths`, async (context) => {
    const base = await project(context);
    const legacy = await legacyFiles(base, { "history.jsonl": `${JSON.stringify(record("legacy", 99))}\n` });
    const options: ServerOptions = option === "relative-history" ? { historyPath: "custom/history.jsonl" }
      : option === "absolute-history" ? { historyPath: join(base, "absolute", "history.jsonl") }
      : option === "relative-totals" ? { totalsPath: "custom-totals.json" }
      : option === "absolute-totals" ? { totalsPath: join(base, "absolute-totals.json") }
      : option === "relative-runs" ? { runsPath: "custom-runs.jsonl" }
      : { runsPath: join(base, "absolute-runs.jsonl") };
    const resolved = paths(base, options);
    assert.equal(await migrateDefaultLedgers(base, resolved), false);
    await absent(join(base, ".tokpulse"));
    const hooks = await server(input(base), { ...options });
    await complete(hooks, "custom", 7);
    await hooks.event!({ event: { type: "session.idle", timestamp: 200, properties: { sessionID: "s" } } as never });
    const ledger = JSON.parse(await readFile(resolved.totalsPath, "utf8"));
    assert.equal(ledger.sessions.s.tokens.output, 7);
    assert.equal(ledger.sessions.s.responseCount, 1);
    assert.equal(JSON.parse((await readFile(resolved.historyPath, "utf8")).trim()).messageID, "custom");
    assert.ok((await lstat(resolved.runsPath)).isFile());
    assert.equal(await readFile(join(legacy, "history.jsonl"), "utf8"), `${JSON.stringify(record("legacy", 99))}\n`);
  });
}

test("copy failure removes only the private stage and blocks server seed rather than losing cumulative data", async (context) => {
  const base = await project(context);
  const legacy = await legacyFiles(base, { "history.jsonl": `${JSON.stringify(record())}\n` });
  await mkdir(join(legacy, "totals.json"));
  await assert.rejects(server(input(base)), /Not a regular legacy ledger/);
  await absent(join(base, ".tokpulse"));
  assert.equal((await readdir(base)).some((name) => name.startsWith(".tokpulse-migrate-")), false);
  assert.equal(await readFile(join(legacy, "history.jsonl"), "utf8"), `${JSON.stringify(record())}\n`);
  await rm(join(legacy, "totals.json"), { recursive: true });
  await server(input(base));
  assert.equal(JSON.parse(await readFile(paths(base).totalsPath, "utf8")).sessions.s.tokens.output, 4);
});

for (const unsafe of ["legacy-parent", "legacy-directory", "legacy-file", "target"] as const) {
  test(`migration refuses unsafe ${unsafe} symlinks without following or initializing them`, async (context) => {
    const base = await project(context);
    const outside = await project(context);
    await writeFile(join(outside, "sentinel"), "unchanged");
    if (unsafe === "legacy-parent") await symlink(outside, join(base, ".opencode"));
    else if (unsafe === "legacy-directory") {
      await mkdir(join(base, ".opencode"));
      await symlink(outside, join(base, ".opencode", "oc-tps"));
    } else if (unsafe === "legacy-file") {
      const legacy = await legacyFiles(base, {});
      await symlink(join(outside, "sentinel"), join(legacy, "history.jsonl"));
    } else {
      await legacyFiles(base, { "history.jsonl": "do not follow" });
      await symlink(outside, join(base, ".tokpulse"));
    }
    await assert.rejects(server(input(base)));
    assert.deepEqual(await readdir(outside), ["sentinel"]);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged");
    assert.equal((await readdir(base)).some((name) => name.startsWith(".tokpulse-migrate-")), false);
    if (unsafe !== "target") await absent(join(base, ".tokpulse"));
  });
}

test("concurrent startup copies publish one complete winner, never overwrite it, and leave no stages", async (context) => {
  const base = await project(context);
  await legacyFiles(base, { "history.jsonl": "history", "totals.json": "totals", "runs.jsonl": "runs" });
  const result = await Promise.all(Array.from({ length: 8 }, () => migrateDefaultLedgers(base, paths(base))));
  assert.equal(result.filter(Boolean).length, 1);
  for (const filename of filenames) assert.equal(await readFile(join(base, ".tokpulse", filename), "utf8"), filename.split(".")[0]);
  await writeFile(paths(base).totalsPath, "winner updated totals");
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => migrateDefaultLedgers(base, paths(base)))), [false, false, false, false]);
  assert.equal(await readFile(paths(base).totalsPath, "utf8"), "winner updated totals");
  assert.equal((await readdir(base)).some((name) => name.startsWith(".tokpulse-migrate-")), false);
});

test("migration checks do not run again on plugin events or delta", async (context) => {
  const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.equal(source.match(/await migrateDefaultLedgers\(/g)?.length, 1);
  assert.ok(source.indexOf("await migrateDefaultLedgers(") < source.indexOf("let eventQueue:"));
  const base = await project(context);
  const hooks = await server(input(base));
  const legacy = await legacyFiles(base, { "history.jsonl": "unsafe if checked again" });
  await mkdir(join(legacy, "totals.json"));
  await hooks.event!({ event: { type: "message.part.delta", timestamp: 20, properties: {
    sessionID: "s", messageID: "new", partID: "p", field: "text", delta: "x",
  } } as never });
  await complete(hooks, "new", 7);
  assert.equal(JSON.parse(await readFile(paths(base).totalsPath, "utf8")).sessions.s.tokens.output, 7);
});
