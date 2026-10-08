import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { recordPartMetadata, server } from "../src/server.js";
import { ActivityLedger } from "../src/runs-storage.js";
import { getSessionAverageSummary } from "../src/statistics.js";
import { createTotalsStorage, getExcludedMessageIDs, projectTotalsMeasurementScope } from "../src/totals-storage.js";
import { filterHistoryRecords } from "../src/storage.js";
import { replayActivity } from "../src/activity.js";

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("deferred server result did not arrive");
}

async function readRecords(historyPath: string): Promise<any[]> {
  const content = await readFile(historyPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readTotals(historyPath: string): Promise<any> {
  return JSON.parse(await readFile(join(dirname(historyPath), "totals.json"), "utf8"));
}

async function receive(hooks: Awaited<ReturnType<typeof server>>, event: any): Promise<void> {
  const wall = event.receiveWall ?? event.timestamp ?? Date.now();
  const dateNow = Date.now;
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  let pending: ReturnType<NonNullable<typeof hooks.event>>;
  try {
    Date.now = () => wall;
    Object.defineProperty(performance, "now", { configurable: true, value: () => event.receiveMono ?? wall });
    pending = hooks.event!({ event });
  } finally {
    Date.now = dateNow;
    if (descriptor) Object.defineProperty(performance, "now", descriptor);
    else delete (performance as any).now;
  }
  await pending!;
}

async function backendCase(run: (context: { path: string; send: (event: any) => Promise<void>; restart: () => Promise<(event: any) => Promise<void>> }) => Promise<void>, maxRecords = 1000, sessionClient?: any, directoryPrefix = "oc-tps-backend-p1-"): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix));
  const path = join(directory, "history.jsonl");
  const input = { directory, worktree: directory, ...(sessionClient ? { client: { session: sessionClient } } : {}) } as unknown as PluginInput;
  const restart = async () => {
    const startupNow = Date.now;
    let hooks: Awaited<ReturnType<typeof server>>;
    try {
      Date.now = () => 0;
      hooks = await server(input, { historyPath: path, maxRecords });
    } finally { Date.now = startupNow; }
    return (event: any) => receive(hooks, event);
  };
  try { await run({ path, send: await restart(), restart }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function completionFact(id: string, output: number, reasoning: number, start: number, end: number) {
  return { type: "message.updated", timestamp: end, properties: { info: {
    id, sessionID: "s", role: "assistant", tokens: { input: 1, output, reasoning }, cost: output,
    time: { created: start, completed: end },
  } } };
}

function officialStatusResult(directory: string, data: any = {}) {
  return { data, response: new Response(null, { status: 200 }), request: new Request(`http://localhost/session/status?directory=${encodeURIComponent(directory)}`) };
}

function officialSessionResult(directory: string) {
  return { data: { id: "s", location: { directory } }, response: new Response(null, { status: 200 }) };
}

function encodedHeaderRewrittenRequest(directory: string, path = "/session/status") {
  const original = new Request(`http://localhost${path}`, { headers: { "x-opencode-directory": encodeURIComponent(directory) } });
  const url = new URL(original.url);
  url.searchParams.set("directory", original.headers.get("x-opencode-directory")!);
  const rewritten = new Request(url, original);
  rewritten.headers.delete("x-opencode-directory");
  assert.equal(new URL(rewritten.url).searchParams.get("directory"), encodeURIComponent(directory));
  return rewritten;
}

async function officialIdleCase(
  run: (context: { path: string; directory: string; send: (event: any) => Promise<void>; counts: { status: number; freshGet: number }; signals: AbortSignal[] }) => Promise<void>,
  fixture: { sdk?: "v1" | "v2"; directoryPrefix?: string; status?: (directory: string) => any; get?: (directory: string) => any } = {},
): Promise<void> {
  let directory = "";
  const counts = { status: 0, freshGet: 0 };
  const signals: AbortSignal[] = [];
  const status = (parameters: any, options: any) => {
    counts.status++;
    const suppliedDirectory = fixture.sdk === "v2" ? parameters?.directory : parameters.query?.directory;
    if (suppliedDirectory !== undefined) assert.equal(suppliedDirectory, directory);
    assert.ok(options.signal instanceof AbortSignal);
    signals.push(options.signal);
    return fixture.status ? fixture.status(directory) : officialStatusResult(directory);
  };
  const get = (parameters: any, options: any) => {
    const sessionID = fixture.sdk === "v2" ? parameters.sessionID : parameters.path.id;
    const suppliedDirectory = fixture.sdk === "v2" ? parameters.directory : parameters.query?.directory;
    if (suppliedDirectory === undefined) return { data: { id: sessionID, agent: "build" } }; // existing metadata lookup is not fresh absence proof
    assert.equal(sessionID, "s");
    counts.freshGet++;
    assert.equal(suppliedDirectory, directory);
    assert.ok(options.signal instanceof AbortSignal);
    signals.push(options.signal);
    return fixture.get ? fixture.get(directory) : officialSessionResult(directory);
  };
  const client = fixture.sdk === "v2"
    ? { status: (parameters: any, options: any) => status(parameters, options), get: (parameters: any, options: any) => get(parameters, options) }
    : { status: (options: any) => status(options, options), get: (options: any) => get(options, options) };
  await backendCase(async ({ path, send }) => {
    directory = dirname(path);
    await run({ path, directory, send, counts, signals });
  }, 1000, client, fixture.directoryPrefix);
}

test("official SDK v1 empty active status map confirms default idle once without host idle", async () => {
  await officialIdleCase(async ({ path, send, counts }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const final = completionFact("default-idle", 9, 0, 0, 100);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    const ledger = new ActivityLedger(join(dirname(path), "runs.jsonl"));
    await eventually(async () => (await ledger.read()).some((event) => event.kind === "lifecycle" && event.state === "idle"));
    await send(final);
    assert.deepEqual((await ledger.read()).map((event: any) => event.state), ["busy", "idle"]);
    assert.deepEqual(counts, { status: 1, freshGet: 1 });
  });
});

test("official SDK v2 absent root confirms only that participant while busy child extends the union", async () => {
  await officialIdleCase(async ({ path, send, counts }) => {
    const base = Date.now();
    await send({ type: "session.status", timestamp: base - 100, properties: { sessionID: "s", status: "busy" } });
    await send({ type: "session.status", timestamp: base - 90, properties: { sessionID: "child", parentSessionID: "s", status: "busy" } });
    const final = completionFact("absent-root", 9, 0, base - 100, base - 80);
    final.properties.info = { ...final.properties.info, finish: "end_turn" } as any;
    await send(final);
    const ledger = new ActivityLedger(join(dirname(path), "runs.jsonl"));
    await eventually(async () => (await ledger.read()).some((event) => event.kind === "lifecycle" && event.sessionID === "s" && event.state === "idle"));
    const facts = await ledger.read();
    const rootIdle = facts.find((event) => event.kind === "lifecycle" && event.sessionID === "s" && event.state === "idle")!;
    assert.equal(facts.some((event) => event.kind === "lifecycle" && event.sessionID === "child" && event.state === "idle"), false);
    assert.equal(replayActivity(facts, { cutoff: rootIdle.timestamp + 50, trustedCurrentInstanceID: rootIdle.instanceID }).rootActiveMilliseconds.s, rootIdle.timestamp + 50 - (base - 100));
    await send({ type: "session.idle", timestamp: rootIdle.timestamp + 100, properties: { sessionID: "child" } });
    const closed = await ledger.read();
    assert.equal(replayActivity(closed, { cutoff: rootIdle.timestamp + 1000, trustedCurrentInstanceID: rootIdle.instanceID }).rootActiveMilliseconds.s, rootIdle.timestamp + 100 - (base - 100));
    assert.equal(replayActivity(closed, { cutoff: rootIdle.timestamp + 10_000, trustedCurrentInstanceID: rootIdle.instanceID }).rootActiveMilliseconds.s, rootIdle.timestamp + 100 - (base - 100));
    assert.deepEqual(counts, { status: 1, freshGet: 1 });
  }, { sdk: "v2", status: (directory) => officialStatusResult(directory, { child: { type: "busy" } }) });
});

const absenceSuccessFixtures = [
  { name: "null-prototype map", status: (directory: string) => officialStatusResult(directory, Object.create(null)) },
  { name: "encoded SDK directory header", status: (directory: string) => ({ ...officialStatusResult(directory), request: new Request("http://localhost/session/status", { headers: { "x-opencode-directory": encodeURIComponent(directory) } }) }) },
  { name: "explicit query fallback without captured request", status: (directory: string) => { const result = officialStatusResult(directory); return { data: result.data, response: result.response }; } },
  { name: "explicit query takes precedence over different directory header", status: (directory: string) => ({ ...officialStatusResult(directory), request: new Request(`http://localhost/session/status?directory=${encodeURIComponent(directory)}`, { headers: { "x-opencode-directory": encodeURIComponent(`${directory}-other`) } }) }) },
  { name: "v1 encoded header rewritten to query on both status and get", directoryPrefix: "oc-tps SDK 路径%20 +#-", status: (directory: string) => ({ ...officialStatusResult(directory), request: encodedHeaderRewrittenRequest(directory) }), get: (directory: string) => ({ ...officialSessionResult(directory), request: encodedHeaderRewrittenRequest(directory, "/session/s") }) },
  { name: "v2 encoded header rewritten to query on both status and get", sdk: "v2" as const, directoryPrefix: "oc-tps SDK 路径%20 +#-", status: (directory: string) => ({ ...officialStatusResult(directory), request: encodedHeaderRewrittenRequest(directory) }), get: (directory: string) => ({ ...officialSessionResult(directory), request: encodedHeaderRewrittenRequest(directory, "/session/s") }) },
  { name: "plaintext query preserves literal percent escapes in directory", directoryPrefix: "oc-tps SDK 路径%20 +#-", status: (directory: string) => officialStatusResult(directory) },
  { name: "active retry record", status: (directory: string) => officialStatusResult(directory, { child: { type: "retry", attempt: 1, message: "retrying", next: 1000 } }) },
  { name: "compatible explicit idle sibling record", status: (directory: string) => officialStatusResult(directory, { peer: { type: "idle" } }) },
];
for (const fixture of absenceSuccessFixtures) {
  test(`default idle accepts proven same-dir ${fixture.name}`, async () => {
    await officialIdleCase(async ({ path, send, counts }) => {
      await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
      const final = completionFact("same-dir", 9, 0, 0, 100);
      final.properties.info = { ...final.properties.info, finish: "stop" } as any;
      await send(final);
      const ledger = new ActivityLedger(join(dirname(path), "runs.jsonl"));
      await eventually(async () => (await ledger.read()).some((event) => event.kind === "lifecycle" && event.state === "idle"));
      assert.deepEqual(counts, { status: 1, freshGet: 1 });
    }, fixture);
  });
}

const absenceUnknownFixtures: Array<{ name: string; freshGet: number; status?: (directory: string) => any; get?: (directory: string) => any }> = [
  { name: "status HTTP 500", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), response: new Response(null, { status: 500 }) }) },
  { name: "status HTTP missing", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), response: undefined }) },
  { name: "status error null", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), error: null }) },
  { name: "status error false", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), error: false }) },
  { name: "explicit idle HTTP 500", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory, { s: { type: "idle" } }), response: new Response(null, { status: 500 }) }) },
  { name: "null map", freshGet: 0, status: (directory) => officialStatusResult(directory, null) },
  { name: "array map", freshGet: 0, status: (directory) => officialStatusResult(directory, []) },
  { name: "nonplain map", freshGet: 0, status: (directory) => officialStatusResult(directory, new Map()) },
  { name: "error-shaped data body", freshGet: 0, status: (directory) => officialStatusResult(directory, { error: { message: "oops" } }) },
  { name: "session info instead of status map", freshGet: 0, status: (directory) => officialStatusResult(directory, { id: "s", location: { directory } }) },
  { name: "null sibling status", freshGet: 0, status: (directory) => officialStatusResult(directory, { peer: null }) },
  { name: "unknown sibling status type", freshGet: 0, status: (directory) => officialStatusResult(directory, { peer: { type: "unknown" } }) },
  { name: "mixed valid and malformed status values", freshGet: 0, status: (directory) => officialStatusResult(directory, { child: { type: "busy" }, error: { message: "oops" } }) },
  { name: "undefined map", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), data: undefined }) },
  { name: "envelope without data", freshGet: 0, status: (directory) => ({ request: officialStatusResult(directory).request, response: new Response(null, { status: 200 }) }) },
  { name: "own undefined SID", freshGet: 0, status: (directory) => officialStatusResult(directory, { s: undefined }) },
  { name: "own malformed SID", freshGet: 0, status: (directory) => officialStatusResult(directory, { s: {} }) },
  { name: "present busy", freshGet: 0, status: (directory) => officialStatusResult(directory, { s: { type: "busy" } }) },
  { name: "present retry", freshGet: 0, status: (directory) => officialStatusResult(directory, { s: { type: "retry" } }) },
  { name: "conflicting busy idle", freshGet: 0, status: (directory) => officialStatusResult(directory, { s: { type: "busy", status: "idle" } }) },
  { name: "wrong query directory", freshGet: 0, status: (directory) => officialStatusResult(`${directory}-other`) },
  { name: "wrong encoded rewritten query directory", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), request: encodedHeaderRewrittenRequest(`${directory}-other`) }) },
  { name: "malformed percent encoding in query", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), request: new Request("http://localhost/session/status?directory=%25ZZ") }) },
  { name: "request without directory", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), request: new Request("http://localhost/session/status") }) },
  { name: "invalid encoded header", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), request: new Request("http://localhost/session/status", { headers: { "x-opencode-directory": "%ZZ" } }) }) },
  { name: "workspace query override", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), request: new Request(`${officialStatusResult(directory).request.url}&workspace=other`) }) },
  { name: "workspace header override", freshGet: 0, status: (directory) => ({ ...officialStatusResult(directory), request: new Request(officialStatusResult(directory).request, { headers: { "x-opencode-workspace": "other" } }) }) },
  { name: "deleted session HTTP 404", freshGet: 1, get: () => ({ data: undefined, response: new Response(null, { status: 404 }) }) },
  { name: "get HTTP 500", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), response: new Response(null, { status: 500 }) }) },
  { name: "get missing HTTP", freshGet: 1, get: (directory) => ({ data: officialSessionResult(directory).data }) },
  { name: "get rejected", freshGet: 1, get: () => Promise.reject(new Error("unavailable")) },
  { name: "get undefined result", freshGet: 1, get: () => undefined },
  { name: "get error with valid data", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), error: "unavailable" }) },
  { name: "get undefined data and error", freshGet: 1, get: () => ({ data: undefined, error: undefined, response: new Response(null, { status: 200 }) }) },
  { name: "wrong session ID", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), data: { id: "other", location: { directory } } }) },
  { name: "missing session ID", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), data: { location: { directory } } }) },
  { name: "missing location", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), data: { id: "s" } }) },
  { name: "top-level directory only", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), data: { id: "s", directory } }) },
  { name: "wrong session location", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), data: { id: "s", location: { directory: `${directory}-other` } } }) },
  { name: "get workspace override", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), request: new Request(`http://localhost/session/s?directory=${encodeURIComponent(directory)}&workspace=other`) }) },
  { name: "get wrong request directory", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), request: new Request(`http://localhost/session/s?directory=${encodeURIComponent(`${directory}-other`)}`) }) },
  { name: "get wrong encoded rewritten query directory", freshGet: 1, get: (directory) => ({ ...officialSessionResult(directory), request: encodedHeaderRewrittenRequest(`${directory}-other`, "/session/s") }) },
];
for (const fixture of absenceUnknownFixtures) {
  test(`default idle remains unknown for ${fixture.name}`, async () => {
    await officialIdleCase(async ({ path, send, counts, signals }) => {
      await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
      const final = completionFact("unknown-default-idle", 9, 0, 0, 100);
      final.properties.info = { ...final.properties.info, finish: "stop" } as any;
      await send(final);
      await eventually(async () => counts.status === 1 && signals[0].aborted);
      await send({ type: "unrelated" });
      assert.deepEqual((await new ActivityLedger(join(dirname(path), "runs.jsonl")).read()).map((event: any) => event.state), ["busy"]);
      assert.deepEqual(counts, { status: 1, freshGet: fixture.freshGet });
    }, fixture);
  });
}

for (const phase of ["status", "get"] as const) {
  for (const work of ["busy", "response"] as const) {
    test(`default-idle ${phase} result is stale after target new ${work}`, async () => {
      let resolve!: (value: any) => void;
      const pending = new Promise((done) => { resolve = done; });
      await officialIdleCase(async ({ path, directory, send, counts, signals }) => {
        await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
        const final = completionFact("stale-default", 9, 0, 0, 100);
        final.properties.info = { ...final.properties.info, finish: "stop" } as any;
        await send(final);
        await eventually(async () => counts.status === 1 && (phase === "status" || counts.freshGet === 1));
        await send(work === "busy"
          ? { type: "session.status", timestamp: 200, properties: { sessionID: "s", status: "busy" } }
          : { type: "message.updated", timestamp: 200, properties: { info: { id: "new-response", sessionID: "s", role: "assistant", time: { created: 200 } } } });
        resolve(phase === "status" ? officialStatusResult(directory) : officialSessionResult(directory));
        await eventually(async () => signals[0].aborted);
        await send({ type: "unrelated" });
        assert.equal((await new ActivityLedger(join(dirname(path), "runs.jsonl")).read()).some((event) => event.kind === "lifecycle" && event.state === "idle"), false);
        assert.deepEqual(counts, { status: 1, freshGet: phase === "status" ? 0 : 1 });
      }, phase === "status" ? { status: () => pending } : { get: () => pending });
    });
  }
}

test("late excluded target cannot acquire idle activity from default-idle proof", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise((done) => { resolve = done; });
  await officialIdleCase(async ({ path, directory, send, counts, signals }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const final = completionFact("excluded-default", 9, 0, 0, 100);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    await eventually(async () => counts.freshGet === 1);
    assert.equal(signals[0], signals[1], "both RPCs must share cancellation");
    await send({ type: "session.updated", properties: { info: { id: "s", agent: "historian" } } });
    resolve(officialSessionResult(directory));
    await eventually(async () => signals[0].aborted);
    await send({ type: "unrelated" });
    assert.equal((await new ActivityLedger(join(dirname(path), "runs.jsonl")).read()).some((event) => event.kind === "lifecycle" && event.state === "idle"), false);
    assert.equal(projectTotalsMeasurementScope(await readTotals(path)).sessions.s, undefined);
    assert.deepEqual(counts, { status: 1, freshGet: 1 });
  }, { get: () => pending });
});

test("status timeout prevents even a late successful empty map from starting a fresh get", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise((done) => { resolve = done; });
  await officialIdleCase(async ({ path, directory, send, counts, signals }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const final = completionFact("status-deadline", 9, 0, 0, 100);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    await eventually(async () => counts.status === 1 && signals[0].aborted);
    resolve(officialStatusResult(directory));
    await new Promise((done) => setTimeout(done, 10));
    await send(final);
    assert.deepEqual(counts, { status: 1, freshGet: 0 });
    assert.deepEqual((await new ActivityLedger(join(dirname(path), "runs.jsonl")).read()).map((event: any) => event.state), ["busy"]);
  }, { status: () => pending });
});

test("default idle uses status receipt boundary, not time spent awaiting fresh get proof", async () => {
  let resolveStatus!: (value: any) => void;
  let resolveGet!: (value: any) => void;
  const status = new Promise((done) => { resolveStatus = done; });
  const get = new Promise((done) => { resolveGet = done; });
  await officialIdleCase(async ({ path, directory, send, counts, signals }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const final = completionFact("status-boundary", 9, 0, 0, 100);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    await eventually(async () => counts.status === 1);
    const originalNow = Date.now;
    try {
      Date.now = () => 200;
      resolveStatus(officialStatusResult(directory));
      await eventually(async () => counts.freshGet === 1);
      Date.now = () => 500;
      resolveGet(officialSessionResult(directory));
      await eventually(async () => signals[0].aborted);
    } finally { Date.now = originalNow; }
    const facts = await new ActivityLedger(join(dirname(path), "runs.jsonl")).read();
    const idle = facts.find((event) => event.kind === "lifecycle" && event.state === "idle")!;
    assert.equal(idle.timestamp, 200);
    assert.equal(idle.observedAt, 200);
    assert.equal(replayActivity(facts).rootActiveMilliseconds.s, 200);
    assert.deepEqual(counts, { status: 1, freshGet: 1 });
  }, { status: () => status, get: () => get });
});

test("status and fresh get share one 200ms deadline; timeout never blocks delta ingress or retries", async () => {
  let resolveGet!: (value: any) => void;
  const pending = new Promise((done) => { resolveGet = done; });
  let started = 0;
  let abortedAt = 0;
  await officialIdleCase(async ({ path, directory, send, counts, signals }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const final = completionFact("deadline-default", 9, 0, 0, 100);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    await eventually(async () => counts.freshGet === 1);
    signals[0].addEventListener("abort", () => { abortedAt = performance.now(); }, { once: true });
    const deltaStart = performance.now();
    await send({ type: "message.part.delta", properties: { sessionID: "peer", messageID: "peer-message", field: "text", delta: "responsive" } });
    assert.ok(performance.now() - deltaStart < 100, "SDK proof wait must stay outside serial ingress");
    await eventually(async () => signals[0].aborted);
    assert.ok(abortedAt - started >= 175);
    assert.ok(abortedAt - started < 300, `shared deadline took ${abortedAt - started}ms`);
    resolveGet(officialSessionResult(directory));
    await new Promise((done) => setTimeout(done, 10));
    await send(final);
    await send({ type: "unrelated" });
    assert.equal((await new ActivityLedger(join(dirname(path), "runs.jsonl")).read()).some((event) => event.kind === "lifecycle" && event.sessionID === "s" && event.state === "idle"), false);
    assert.deepEqual(counts, { status: 1, freshGet: 1 });
  }, {
    status: (directory) => {
      started = performance.now();
      return new Promise((done) => setTimeout(() => done(officialStatusResult(directory)), 120));
    },
    get: () => pending,
  });
});
function snapshotFact(id: string, messageID: string, type: string, end?: number, text = "", start?: number) {
  return { type: "message.part.updated", timestamp: end ?? 10, properties: { part: {
    id, messageID, sessionID: "s", type, text,
    ...(start !== undefined || end !== undefined ? { time: { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) } } : {}),
  } } };
}
async function textGeneration(send: (event: any) => Promise<void>, messageID: string, beforeCompletion?: () => Promise<void>) {
  await send({ type: "message.updated", timestamp: 0, properties: { info: { id: messageID, sessionID: "s", role: "assistant", time: { created: 0 } } } });
  await send({ type: "session.next.step.started", timestamp: 0, properties: { sessionID: "s", messageID, stepID: `${messageID}-step` } });
  await send(snapshotFact(`${messageID}-p`, messageID, "text", undefined, "", 100));
  await send({ type: "message.part.delta", timestamp: 100, properties: { sessionID: "s", messageID, partID: `${messageID}-p`, field: "text", delta: "hello" } });
  await send({ type: "message.part.delta", timestamp: 1200, properties: { sessionID: "s", messageID, partID: `${messageID}-p`, field: "text", delta: "world" } });
  await send(snapshotFact(`${messageID}-p`, messageID, "text", 1300, "helloworld", 100));
  await beforeCompletion?.();
  await send(completionFact(messageID, 10, 0, 0, 1500));
}

test("v1 historian mode excludes renamed sessions and inherited children before new bookkeeping", async () => {
  await backendCase(async ({ path, send, restart }) => {
    await send({ type: "session.updated", properties: { info: { id: "s", title: "Renamed user-looking session" } } });
    const hidden = completionFact("hidden", 20, 0, 0, 100);
    hidden.properties.info = { ...hidden.properties.info, mode: "historian" } as any;
    await send(hidden);
    await send({ type: "session.created", properties: { info: { id: "child", parentID: "s", agent: "editor" } } });
    await send({ ...completionFact("child-m", 9, 0, 0, 200), properties: { info: { ...completionFact("child-m", 9, 0, 0, 200).properties.info, sessionID: "child" } } });
    const ledger = await readTotals(path);
    assert.equal(ledger.sessionScopes.s.sourceScope, "magic-session");
    assert.equal(ledger.sessionScopes.child.parentSessionID, "s");
    assert.deepEqual(ledger.sessions, {});
    const afterRestart = await restart();
    await afterRestart(completionFact("later-hidden", 5, 0, 0, 300));
    assert.deepEqual((await readTotals(path)).sessions, {});
  });
});

test("late parent metadata retracts immutable public projections but preserves raw user history", async () => {
  await backendCase(async ({ path, send, restart }) => {
    await send(completionFact("real", 4, 0, 0, 100));
    const child = completionFact("child", 9, 0, 0, 120);
    child.properties.info.sessionID = "child";
    await send(child);
    const before = await readTotals(path);
    const beforeProjection = projectTotalsMeasurementScope(before);
    await send({ type: "session.updated", properties: { info: { id: "child", parentID: "hidden-parent", agent: "editor" } } });
    await send({ type: "session.updated", properties: { info: { id: "hidden-parent", metadata: { magic_context: "hidden-run", role: "historian" } } } });
    const after = await readTotals(path);
    assert.equal(beforeProjection.sessions.child.tokens.output, 9);
    assert.equal(after.sessions.child.tokens.output, 9);
    assert.equal(projectTotalsMeasurementScope(after).sessions.child, undefined);
    assert.equal(projectTotalsMeasurementScope(after).sessions.s.tokens.output, 4);
    assert.equal((await readRecords(path)).length, 2);
    assert.deepEqual(filterHistoryRecords(await readRecords(path), after.sessionScopes, undefined, getExcludedMessageIDs(after)).map((r) => r.messageID), ["real"]);
    await restart();
    const restored = await readTotals(path);
    assert.equal(projectTotalsMeasurementScope(restored).sessions.s.tokens.output, 4);
    assert.equal(projectTotalsMeasurementScope(restored).sessions.child, undefined);
  });
});

test("normal editor agents and Magic text titles remain users; compaction removes only its response", async () => {
  await backendCase(async ({ path, send, restart }) => {
    await send({ type: "session.updated", properties: { info: { id: "s", title: "My Magic Context notes", agent: "editor" } } });
    await send(completionFact("real", 4, 0, 0, 100));
    await send(completionFact("summary", 9, 0, 0, 120));
    const compaction = completionFact("summary", 9, 0, 0, 120);
    compaction.properties.info = { ...compaction.properties.info, mode: "compaction", summary: true } as any;
    await send(compaction);
    await send(compaction);
    const totals = await readTotals(path);
    assert.equal(totals.sessions.s.tokens.output, 4);
    assert.equal(totals.sessions.s.responseCount, 1);
    assert.equal(totals.sessionScopes?.s?.sourceScope, undefined);
    assert.equal((await readRecords(path)).length, 2);
    assert.deepEqual(filterHistoryRecords(await readRecords(path), totals.sessionScopes, undefined, getExcludedMessageIDs(totals)).map((r) => r.messageID), ["real"]);
    const restarted = await restart();
    await restarted(completionFact("summary", 30, 0, 0, 300));
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 4);
    await restarted(completionFact("normal", 3, 0, 0, 400));
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 7);
  });
});

test("SDK v2 raw metadata resolves deferred hidden identity without blocking completion persistence", async () => {
  let resolve!: (value: any) => void;
  let calls = 0;
  const response = new Promise((done) => { resolve = done; });
  await backendCase(async ({ path, send }) => {
    await send(completionFact("tentative", 9, 0, 0, 120));
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 9);
    resolve({ data: { id: "s", agent: "historian", title: "Renamed" } });
    await eventually(async () => (await readTotals(path)).sessionScopes?.s?.sourceScope === "magic-session");
    const ledger = await readTotals(path);
    assert.equal(ledger.sessions.s.tokens.output, 9);
    assert.equal(projectTotalsMeasurementScope(ledger).sessions.s, undefined);
    assert.equal(calls, 1);
  }, 1000, { get: (parameters: any, options: any) => {
    calls++;
    assert.equal(parameters.sessionID, "s");
    assert.ok(options.signal instanceof AbortSignal);
    return response;
  } });
});

test("stale metadata queries cannot overwrite newer observed ancestry or positive identity", async () => {
  let resolve!: (value: any) => void;
  const response = new Promise((done) => { resolve = done; });
  await backendCase(async ({ path, send }) => {
    await send(completionFact("m", 9, 0, 0, 120));
    await send({ type: "session.updated", properties: { info: { id: "s", parentID: "new-parent", agent: "historian" } } });
    resolve({ data: { id: "s", parentID: "old-parent", agent: "editor" } });
    await new Promise((done) => setTimeout(done, 10));
    await send({ type: "unrelated" });
    const scope = (await readTotals(path)).sessionScopes.s;
    assert.equal(scope.sourceScope, "magic-session");
    assert.equal(scope.parentSessionID, "new-parent");
  }, 1000, { get: () => response });
});

test("main idle excludes late-classified MC child busy, while real children keep their active time", async () => {
  await backendCase(async ({ path, send }) => {
    const status = (sid: string, state: string, timestamp: number, parentSessionID?: string) => send({ type: "session.status", timestamp, properties: { sessionID: sid, status: state, parentSessionID } });
    await status("s", "busy", 0);
    await status("hidden", "busy", 10, "s");
    await status("real-child", "busy", 50, "s");
    await status("s", "idle", 100);
    await send({ type: "session.updated", properties: { info: { id: "hidden", agent: "historian" } } });
    await status("real-child", "idle", 150);
    const facts = await new ActivityLedger(join(dirname(path), "runs.jsonl")).read();
    const scopes = (await readTotals(path)).sessionScopes;
    const replay = replayActivity(facts, { cutoff: 1000, trustedCurrentInstanceID: facts[0].instanceID, sessionScopes: scopes });
    assert.equal(replay.rootActiveMilliseconds.s, 150);
    assert.equal(replay.timelines.has("hidden"), false);
  });
});

test("confirmed SDK idle closes activity once, never treats response completion itself as task completion", async () => {
  let resolve!: (value: any) => void;
  let queries = 0;
  const response = new Promise((done) => { resolve = done; });
  await backendCase(async ({ path, send }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const fact = completionFact("m", 9, 0, 0, 100);
    fact.properties.info = { ...fact.properties.info, finish: "stop" } as any;
    await send(fact);
    const activity = new ActivityLedger(join(dirname(path), "runs.jsonl"));
    assert.deepEqual((await activity.read()).map((e: any) => e.state), ["busy"]);
    resolve({ data: { s: { type: "idle" } } });
    await eventually(async () => (await activity.read()).some((e: any) => e.state === "idle"));
    await send(fact);
    const facts = await activity.read();
    assert.deepEqual(facts.map((e: any) => e.state), ["busy", "idle"]);
    assert.equal(facts[1].observedAt, facts[1].timestamp);
    assert.equal(queries, 1);
    // The real host may legitimately start another loop after completion.
    await send({ type: "session.status", timestamp: Date.now() + 1, properties: { sessionID: "s", status: "busy" } });
    await send({ type: "session.idle", timestamp: Date.now() + 2, properties: { sessionID: "s" } });
    assert.deepEqual((await activity.read()).map((e: any) => e.state), ["busy", "idle", "busy", "idle"]);
  }, 1000, { status: () => { queries++; return response; } });
});

for (const intervening of ["busy", "message"] as const) {
  test(`SDK idle result is discarded after intervening ${intervening} ingress`, async () => {
    let resolve!: (value: any) => void;
    let queries = 0;
    const response = new Promise((done) => { resolve = done; });
    await backendCase(async ({ path, send }) => {
      await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
      const fact = completionFact("m", 9, 0, 0, 100);
      fact.properties.info = { ...fact.properties.info, finish: "stop" } as any;
      await send(fact);
      await eventually(async () => queries === 1);
      if (intervening === "message") await send({ type: "message.updated", timestamp: 200, properties: { info: { id: "new", sessionID: "s", role: "assistant", time: { created: 200 } } } });
      else await send({ type: "session.status", timestamp: 200, properties: { sessionID: "s", status: "busy" } });
      resolve({ data: { s: { type: "idle" } } });
      await new Promise((done) => setTimeout(done, 15));
      await send({ type: "unrelated" });
      const facts = await new ActivityLedger(join(dirname(path), "runs.jsonl")).read();
      assert.equal(facts.some((e: any) => e.state === "idle"), false);
    }, 1000, { status: () => { queries++; return response; } });
  });
}

test("target pending tools prevent final-answer SDK reconciliation", async () => {
    let queries = 0;
    await backendCase(async ({ send }) => {
      await send({ type: "message.updated", timestamp: 0, properties: { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 0 } } } });
      await send({ type: "message.part.updated", timestamp: 50, properties: { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running" } } } });
      const fact = completionFact("m", 9, 0, 0, 100);
      fact.properties.info = { ...fact.properties.info, finish: "stop" } as any;
      await send(fact);
      await new Promise((done) => setTimeout(done, 5));
      assert.equal(queries, 0);
    }, 1000, { status: () => { queries++; return { data: { s: { type: "idle" } } }; } });
});

test("SDK root participant idle survives child busy; root union freezes only after child idle", async () => {
  let resolve!: (value: any) => void;
  let queries = 0;
  const response = new Promise((done) => { resolve = done; });
  await backendCase(async ({ path, send }) => {
    const base = Date.now();
    await send({ type: "session.status", timestamp: base - 100, properties: { sessionID: "s", status: "busy" } });
    await send({ type: "session.status", timestamp: base - 90, properties: { sessionID: "child", parentSessionID: "s", status: "busy" } });
    const final = completionFact("root-final", 9, 0, base - 100, base - 80);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    await eventually(async () => queries === 1);
    // Child work that arrives while the root query is in flight is independent.
    await send({ type: "session.status", timestamp: base - 70, properties: { sessionID: "child", status: "busy" } });
    resolve({ data: { s: { type: "idle" }, child: { type: "busy" } } });
    const ledger = new ActivityLedger(join(dirname(path), "runs.jsonl"));
    await eventually(async () => (await ledger.read()).some((e) => e.kind === "lifecycle" && e.sessionID === "s" && e.state === "idle"));
    const facts = await ledger.read();
    const rootIdle = facts.find((e) => e.kind === "lifecycle" && e.sessionID === "s" && e.state === "idle")!;
    assert.equal(facts.some((e) => e.kind === "lifecycle" && e.sessionID === "child" && e.state === "idle"), false);
    const active = replayActivity(facts, { cutoff: rootIdle.timestamp + 50, trustedCurrentInstanceID: rootIdle.instanceID });
    assert.equal(active.rootActiveMilliseconds.s, rootIdle.timestamp + 50 - (base - 100));
    await send({ type: "session.idle", timestamp: rootIdle.timestamp + 100, properties: { sessionID: "child" } });
    const closedFacts = await ledger.read();
    const closed = replayActivity(closedFacts, { cutoff: rootIdle.timestamp + 1000, trustedCurrentInstanceID: rootIdle.instanceID });
    assert.equal(closed.rootActiveMilliseconds.s, rootIdle.timestamp + 100 - (base - 100));
    assert.equal(replayActivity(closedFacts, { cutoff: rootIdle.timestamp + 10_000, trustedCurrentInstanceID: rootIdle.instanceID }).rootActiveMilliseconds.s, closed.rootActiveMilliseconds.s);
    assert.equal(queries, 1);
  }, 1000, { status: () => { queries++; return response; } });
});

test("unrelated SID work and SDK metadata scope revisions cannot consume the root idle opportunity", async () => {
  let resolveStatus!: (value: any) => void;
  let resolveMetadata!: (value: any) => void;
  let queries = 0;
  const statusResponse = new Promise((done) => { resolveStatus = done; });
  const metadataResponse = new Promise((done) => { resolveMetadata = done; });
  await backendCase(async ({ path, send }) => {
    await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
    const final = completionFact("m", 9, 0, 0, 100);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    await eventually(async () => queries === 1);
    await send({ type: "session.status", timestamp: 200, properties: { sessionID: "peer", status: "busy" } });
    resolveMetadata({ data: { id: "peer", agent: "historian", parentID: "unrelated-parent" } });
    await eventually(async () => (await readTotals(path)).sessionScopes?.peer?.sourceScope === "magic-session");
    await send({ type: "session.updated", properties: { info: { id: "s", agent: "editor", title: "Ordinary updated title" } } });
    resolveStatus({ data: { s: { type: "idle" } } });
    const activity = new ActivityLedger(join(dirname(path), "runs.jsonl"));
    await eventually(async () => (await activity.read()).some((e) => e.kind === "lifecycle" && e.sessionID === "s" && e.state === "idle"));
    assert.equal(queries, 1);
  }, 1000, {
    get: (options: any) => options.path.id === "peer" ? metadataResponse : { data: { id: options.path.id, agent: "editor" } },
    status: () => { queries++; return statusResponse; },
  });
});

test("a genuinely new target final response gets its own single reconciliation opportunity", async () => {
  let resolveOld!: (value: any) => void;
  let queries = 0;
  const old = new Promise((done) => { resolveOld = done; });
  await backendCase(async ({ path, send }) => {
    const final = completionFact("old", 9, 0, 0, 100);
    final.properties.info = { ...final.properties.info, finish: "stop" } as any;
    await send(final);
    await eventually(async () => queries === 1);
    await send({ type: "message.updated", timestamp: 200, properties: { info: { id: "new", sessionID: "s", role: "assistant", time: { created: 200 } } } });
    const next = completionFact("new", 3, 0, 200, 300);
    next.properties.info = { ...next.properties.info, finish: "stop" } as any;
    await send(next);
    const activity = new ActivityLedger(join(dirname(path), "runs.jsonl"));
    await eventually(async () => (await activity.read()).some((e) => e.kind === "lifecycle" && e.state === "idle"));
    resolveOld({ data: { s: { type: "idle" } } });
    await new Promise((done) => setTimeout(done, 10));
    assert.equal(queries, 2);
    assert.equal((await activity.read()).filter((e) => e.kind === "lifecycle" && e.state === "idle").length, 1);
  }, 1000, { status: () => ++queries === 1 ? old : { data: { s: { type: "idle" } } } });
});

for (const sdk of ["v1", "v2"] as const) {
  for (const id of [undefined, "wrong-SID"] as const) {
    test(`${sdk} metadata with ${id ?? "missing ID"} is unknown, never scope or ancestry proof`, async () => {
      let calls = 0;
      const invalid = { data: { ...(id ? { id } : {}), agent: "historian", parentID: "hidden-parent", title: "Magic Context" } };
      const client = sdk === "v1" ? { get: (options: any) => {
        calls++; assert.equal(options.path.id, "s"); return invalid;
      } } : { get: (parameters: any, options: any) => {
        calls++; assert.equal(parameters.sessionID, "s"); assert.ok(options.signal instanceof AbortSignal); return invalid;
      } };
      await backendCase(async ({ path, send }) => {
        await send(completionFact("ordinary", 9, 0, 0, 100));
        await eventually(async () => calls === 1);
        await new Promise((done) => setTimeout(done, 10));
        await send({ type: "unrelated" });
        const ledger = await readTotals(path);
        assert.equal(ledger.sessionScopes?.s, undefined);
        assert.equal(projectTotalsMeasurementScope(ledger).sessions.s.tokens.output, 9);
        assert.equal((await new ActivityLedger(join(dirname(path), "runs.jsonl")).read()).some((e) => e.kind === "parent"), false);
        assert.equal(calls, 1);
      }, 1000, client);
    });
  }
}

for (const failure of ["history", "totals"] as const) {
  test(`${failure} completion write failure retries non-LIVE exact v3 evidence once on idle`, async () => {
    await backendCase(async ({ path, send }) => {
      const blocked = failure === "history" ? path : join(dirname(path), "totals.json");
      await textGeneration(send, "write-failed", async () => {
        await rm(blocked, { force: true });
        await mkdir(blocked);
      });
      const written = failure === "totals" ? (await readRecords(path))[0] : undefined;
      await send({ type: "message.part.delta", timestamp: 1600, properties: { sessionID: "s", messageID: "write-failed", field: "text", delta: "late must not revive" } });
      await send({ type: "message.part.delta", timestamp: 1700, properties: { sessionID: "s", field: "text", delta: "late unowned" } });
      await rm(blocked, { recursive: true, force: true });
      if (failure === "history") await writeFile(path, "");
      await send({ type: "session.idle", timestamp: 5000, properties: { sessionID: "s" } });
      const [record] = await readRecords(path);
      assert.equal(record.quality, "exact");
      assert.equal(record.time.completed, 1500);
      assert.equal(record.cost, 10);
      assert.equal(record.tokens.output, 10);
      assert.equal(record.samples.length, 2);
      assert.equal(record.speed.generation.durationMs, 1100);
      assert.equal(record.speed.generation.generatedTokens, 5);
      assert.equal(record.speed.generationEvidence.clockSource, "performance.now");
      assert.equal(record.speed.generationEvidence.clockResolutionMs, 1);
      assert.equal(record.speed.generationEvidence.firstReceiveMono, 100);
      assert.equal(record.speed.generationEvidence.lastReceiveMono, 1200);
      if (written) assert.deepEqual(record, written);
      const before = await readTotals(path);
      assert.equal(before.sessions.s.responseCount, 1);
      assert.equal(before.sessions.s.cost, 10);
      assert.equal(before.sessions.s.tokens.output, 10);
      assert.equal(before.sessions.s.speed.generation.responseCount, 1);
      await send({ type: "session.idle", timestamp: 6000, properties: { sessionID: "s" } });
      assert.deepEqual(await readTotals(path), before);
      assert.equal((await readRecords(path)).length, 1);
    });
  });
}

test("late positive session scope discards failed persistence instead of upserting the hidden candidate", async () => {
  await backendCase(async ({ path, send }) => {
    await textGeneration(send, "hidden-failed", async () => { await rm(path, { force: true }); await mkdir(path); });
    await rm(path, { recursive: true, force: true });
    await writeFile(path, "");
    await send({ type: "session.updated", properties: { info: { id: "s", agent: "historian" } } });
    await send({ type: "session.idle", timestamp: 5000, properties: { sessionID: "s" } });
    assert.deepEqual(await readRecords(path), []);
    assert.equal((await readTotals(path)).sessions.s, undefined);
  });
});

test("permanent history failure parks exact evidence after three bounded lifecycle retries", async () => {
  const messages: string[] = [];
  const oldWarn = console.warn;
  console.warn = (message) => { messages.push(String(message)); };
  try {
    await backendCase(async ({ path, send }) => {
      await textGeneration(send, "parked", async () => { await rm(path, { force: true }); await mkdir(path); });
      for (let i = 0; i < 7; i++) await send({ type: "session.idle", timestamp: 2000 + i, properties: { sessionID: "s" } });
      assert.equal(messages.filter((message) => message.includes("history write failed")).length, 4);
      assert.equal(messages.filter((message) => message.includes("retry budget exhausted")).length, 1);
      await rm(path, { recursive: true, force: true });
      await writeFile(path, "");
      await send({ type: "session.idle", timestamp: 4000, properties: { sessionID: "s" } });
      assert.deepEqual(await readRecords(path), []); // no automatic polling/retry loop
      await send(completionFact("parked", 10, 0, 0, 1500)); // explicit repair opportunity
      const [record] = await readRecords(path);
      assert.equal(record.quality, "exact");
      assert.equal(record.speed.generation.durationMs, 1100);
      assert.equal((await readTotals(path)).sessions.s.responseCount, 1);
    });
  } finally { console.warn = oldWarn; }
});

test("unknown SDK status does not close user activity", async () => {
  for (const result of [{ data: {} }, { data: { s: { type: "busy" } } }, { error: "unavailable" }]) {
    await backendCase(async ({ path, send }) => {
      await send({ type: "session.status", timestamp: 0, properties: { sessionID: "s", status: "busy" } });
      const fact = completionFact("m", 9, 0, 0, 100);
      fact.properties.info = { ...fact.properties.info, finish: "stop" } as any;
      await send(fact);
      await new Promise((done) => setTimeout(done, 5));
      const facts = await new ActivityLedger(join(dirname(path), "runs.jsonl")).read();
      assert.deepEqual(facts.map((e: any) => e.state), ["busy"]);
    }, 1000, { status: () => result });
  }
});

test("rejected incomplete completion retires live ownership and late unowned deltas cannot resurrect it", async () => {
  await backendCase(async ({ path, send }) => {
    await send(completionFact("m", 4, 3, 0, 100));
    const before = await readTotals(path);
    await send({ type: "message.updated", timestamp: 200, properties: { info: { id: "m", sessionID: "s", role: "assistant", tokens: { input: 1, output: 40 }, time: { created: 0, completed: 200 } } } });
    await send({ type: "message.part.delta", timestamp: 220, properties: { sessionID: "s", messageID: "m", field: "text", delta: "late" } });
    await send({ type: "message.part.delta", timestamp: 230, properties: { sessionID: "s", field: "text", delta: "late-unowned" } });
    await send(completionFact("m", 4, 3, 0, 100));
    await send({ type: "session.idle", timestamp: 300, properties: { sessionID: "s" } });
    assert.deepEqual(await readTotals(path), before);
    assert.equal((await readRecords(path))[0].samples.length, 0);
    // A genuinely new assistant owns its own deltas, not an old SID fallback.
    await send({ type: "message.updated", timestamp: 400, properties: { info: { id: "new", sessionID: "s", role: "assistant", time: { created: 400 } } } });
    await send({ type: "message.part.delta", timestamp: 420, properties: { sessionID: "s", messageID: "new", field: "text", delta: "new" } });
    await send(completionFact("new", 2, 0, 400, 500));
    assert.equal((await readRecords(path)).find((r) => r.messageID === "new").samples.length, 1);
  });
});

test("a rejected completion against externally persisted exact usage retires a genuinely LIVE response", async () => {
  let queries = 0;
  await backendCase(async ({ path, send }) => {
    await send({ type: "message.updated", timestamp: 0, properties: { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 0 } } } });
    await send({ type: "message.part.delta", timestamp: 50, properties: { sessionID: "s", messageID: "m", field: "text", delta: "live" } });
    // Another writer's authoritative snapshot arrives while this server still
    // owns LIVE m. Its incomplete completion must retire ownership, not usage.
    const authoritative = { version: 1, messageID: "m", sessionID: "s", quality: "exact" as const,
      tokens: { input: 1, output: 4, reasoning: 3, cacheRead: 0, cacheWrite: 0 }, cost: 0,
      time: { start: 0, completed: 100, duration: 100 }, samples: [] };
    await writeFile(path, JSON.stringify(authoritative) + "\n");
    await createTotalsStorage({ historyPath: path }).apply(authoritative);
    const before = await readTotals(path);
    await send({ type: "message.updated", timestamp: 200, properties: { info: { id: "m", sessionID: "s", role: "assistant", finish: "stop", tokens: { input: 1, output: 40 }, time: { created: 0, completed: 200 } } } });
    await eventually(async () => queries === 1); // no eligible LIVE state remains
    await send({ type: "message.part.delta", timestamp: 220, properties: { sessionID: "s", messageID: "m", field: "text", delta: "late" } });
    await send({ type: "message.part.delta", timestamp: 230, properties: { sessionID: "s", field: "text", delta: "late-unowned" } });
    await send({ type: "session.idle", timestamp: 300, properties: { sessionID: "s" } });
    assert.deepEqual(await readTotals(path), before);
    assert.deepEqual((await readRecords(path))[0], authoritative);
  }, 1000, { status: () => { queries++; return { data: { s: { type: "busy" } } }; } });
});

test("a thousand restored sessions hydrate through four background workers, not the serial event queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-bootstrap-"));
  const historyPath = join(directory, "history.jsonl");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  try {
    const old = Array.from({ length: 1000 }, (_, index) => ({
      version: 1, messageID: `old-${index}`, sessionID: `old-session-${index}`,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0, quality: "exact", time: { start: 0, completed: 100, duration: 100 }, samples: [],
    }));
    await writeFile(historyPath, old.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const hooks = await server({ directory, worktree: directory, client: { session: {
      get: async () => {
        calls++; inFlight++; peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return { error: "metadata unavailable" }; // not negative user proof
      },
    } } } as unknown as PluginInput, { historyPath });
    await eventually(async () => calls === 4);
    assert.equal(peak, 4);
    const completion = hooks.event!({ event: completionFact("new", 2, 0, 0, 200) as never });
    assert.equal(await Promise.race([completion.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]), true);
    assert.equal((await readTotals(historyPath)).sessions.s.tokens.output, 2);
    release();
    await eventually(async () => calls === 1001 && inFlight === 0);
    await hooks.event!({ event: { type: "unrelated" } as never });
    assert.equal((await readTotals(historyPath)).sessionScopes, undefined);
    assert.ok(peak <= 4);
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative corrections accept zero, smaller usage and shorter duration; known replay cannot revert", async () => {
  await backendCase(async ({ path, send, restart }) => {
    const original = completionFact("m", 10, 0, 0, 100);
    await send(original);
    await send(completionFact("m", 0, 0, 0, 200));
    assert.equal((await readRecords(path))[0].tokens.output, 0);
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 0);
    await send(completionFact("m", 8, 0, 0, 300));
    await send(completionFact("m", 2, 0, 250, 300));
    assert.equal((await readRecords(path))[0].time.duration, 50);
    await send(original);
    await (await restart())(original);
    const [record] = await readRecords(path);
    const totals = await readTotals(path);
    assert.equal(record.tokens.output, 2);
    assert.equal(totals.sessions.s.tokens.output, 2);
    assert.equal(totals.sessions.s.speed.response.durationMs, 50);
    assert.equal(totals.sessions.s.responseCount, 1);
  });
});
test("trimmed completion replay and restart preserve settled generation evidence", async () => {
  await backendCase(async ({ path, send, restart }) => {
    await textGeneration(send, "m");
    await send(completionFact("new", 0, 0, 300, 400));
    const before = await readTotals(path);
    assert.equal(before.settled.m.speed.generation.durationMs, 1100);
    assert.equal(before.settled.m.speed.generation.generatedTokens, 5);
    assert.equal(before.settled.m.speed.generationEvidence.start, 100);
    await send(completionFact("m", 10, 0, 0, 1500));
    await (await restart())(completionFact("m", 10, 0, 0, 1500));
    assert.deepEqual(await readTotals(path), before);
    assert.equal((await readRecords(path))[0].messageID, "new");
  }, 1);
});

for (const trimmed of [false, true]) {
  test(`${trimmed ? "settled" : "retained"} exact completion rejects partial live usage before and after restart, but accepts exact zero`, async () => {
    await backendCase(async ({ path, send, restart }) => {
      await textGeneration(send, "m");
      if (trimmed) await send(completionFact("new", 20, 0, 300, 400));
      const before = await readTotals(path);
      const historyBefore = await readRecords(path);
      const coverageBefore = getSessionAverageSummary(before.sessions.s);
      const expectedCount = trimmed ? 2 : 1;
      assert.equal(before.sessions.s.tokens.output, trimmed ? 30 : 10);
      assert.equal(before.sessions.s.responseCount, expectedCount);
      assert.equal(coverageBefore.generation.coveredResponseCount, 1);
      assert.equal(coverageBefore.response.coveredResponseCount, expectedCount);
      assert.equal((trimmed ? before.settled.m : before.open.m).quality, "exact");

      await send(assistantCompleted("m", { input: 1 }, 1600, 0, "s"));
      assert.deepEqual(await readRecords(path), historyBefore);
      assert.deepEqual(await readTotals(path), before);
      const restarted = await restart();
      await restarted(assistantCompleted("m", { input: 1 }, 1700, 0, "s"));
      const after = await readTotals(path);
      assert.deepEqual(await readRecords(path), historyBefore);
      assert.deepEqual(after, before);
      assert.deepEqual(after.sessions.s.tokens, before.sessions.s.tokens);
      assert.deepEqual(after.sessions.s.speed, before.sessions.s.speed);
      assert.equal(after.sessions.s.responseCount, expectedCount);
      assert.deepEqual(getSessionAverageSummary(after.sessions.s), coverageBefore);

      // Explicit complete zero usage is an authoritative correction, not partial data.
      await restarted(completionFact("m", 0, 0, 0, 2000));
      const corrected = await readTotals(path);
      assert.equal(corrected.sessions.s.tokens.output, trimmed ? 20 : 0);
      assert.equal(corrected.sessions.s.tokens.reasoning, 0);
      assert.equal(corrected.sessions.s.responseCount, expectedCount);
      assert.equal(corrected.sessions.s.speed.generation.generatedTokens, 0);
      assert.equal(corrected.sessions.s.speed.generation.durationMs, 1100);
      assert.equal(corrected.sessions.s.speed.generation.responseCount, 1);
      assert.equal(corrected.sessions.s.speed.response.generatedTokens, trimmed ? 20 : 0);
      assert.equal(corrected.sessions.s.speed.response.durationMs, trimmed ? 2100 : 2000);
      assert.equal(corrected.sessions.s.speed.response.responseCount, expectedCount);
      const records = await readRecords(path);
      assert.equal(records.length, 1);
      assert.equal(records[0].messageID, "m");
      assert.equal(records[0].quality, "exact");
      assert.equal(records[0].tokens.output, 0);
    }, 1);
  });
}

test("hidden reasoning invalidates generation, while provider-time corrections preserve receive-monotonic evidence", async () => {
  await backendCase(async ({ path, send }) => {
    await textGeneration(send, "hidden");
    await textGeneration(send, "timing");
    assert.equal((await readTotals(path)).sessions.s.speed.generation.responseCount, 2);
    await send(completionFact("hidden", 10, 100, 0, 300));
    await send(completionFact("timing", 10, 0, 150, 180));
    const records = await readRecords(path);
    assert.equal(records.find((r) => r.messageID === "hidden").speed.generation, undefined);
    assert.equal(records.find((r) => r.messageID === "timing").speed.generation.durationMs, 1100);
    const totals = await readTotals(path);
    assert.equal(totals.sessions.s.speed.generation.responseCount, 1);
    assert.equal(totals.sessions.s.speed.generation.generatedTokens, 5);
    assert.equal(totals.sessions.s.speed.response.generatedTokens, 120);
    assert.equal(totals.sessions.s.responseCount, 2);
  });
});
test("real legacy reasoning metadata classifies field:text without kind and calibrates final usage", async () => {
  await backendCase(async ({ path, send }) => {
    await send({ type: "message.updated", timestamp: 0, properties: { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 0 } } } });
    await send({ type: "session.next.step.started", timestamp: 0, properties: { sessionID: "s", messageID: "m", stepID: "one" } });
    await send(snapshotFact("p", "m", "reasoning", undefined, "", 100));
    await send({ type: "message.part.delta", timestamp: 100, properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "think" } });
    await send({ type: "message.part.delta", timestamp: 1200, properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "again" } });
    await send(snapshotFact("p", "m", "reasoning", 1300, "thinkagain", 100));
    await send(completionFact("m", 0, 100, 0, 1500));
    const [record] = await readRecords(path);
    assert.equal(record.samples[0].kind, "reasoning");
    assert.equal(record.samples.reduce((sum: number, sample: any) => sum + sample.tokens, 0), 100);
    assert.equal(record.time.firstToken, 100);
    assert.equal(record.speed.generation.durationMs, 1100);
    assert.equal(record.speed.generation.generatedTokens, 50);
    assert.equal(record.speed.generation.coverageGeneratedTokens, 100);
  });
});
test("snapshot-only entry point never rebuilds active and known user deltas cannot generate", async () => {
  const active = new Map();
  recordPartMetadata(active, snapshotFact("p", "completed", "text", 200).properties);
  recordPartMetadata(active, { part: { id: "tool", messageID: "completed", sessionID: "s", type: "tool", state: { status: "completed", time: { end: 1000 } } } });
  recordPartMetadata(active, snapshotFact("user-p", "user", "text").properties);
  assert.equal(active.size, 0);
  await backendCase(async ({ path, send }) => {
    await send(completionFact("completed", 10, 0, 0, 300));
    const before = await readTotals(path);
    await send(snapshotFact("p", "completed", "text", 200));
    await send({ type: "message.part.updated", properties: { part: { id: "tool", messageID: "completed", sessionID: "s", type: "tool", state: { status: "completed", time: { end: 1000 } } } } });
    await send({ type: "message.updated", properties: { info: { id: "user", sessionID: "s", role: "user" } } });
    await send(snapshotFact("user-p", "user", "text"));
    await send({ type: "message.part.delta", timestamp: 400, properties: { sessionID: "s", messageID: "user", partID: "user-p", field: "text", delta: "user text" } });
    await send({ type: "session.idle", timestamp: 1000, properties: { sessionID: "s" } });
    assert.deepEqual(await readTotals(path), before);
    assert.equal((await readRecords(path)).length, 1);
  });
});
test("real v2 IDs associate complete content metadata, but tool-input coverage still downgrades generation", async () => {
  await backendCase(async ({ path, send }) => {
    await send({ type: "session.next.text.delta", timestamp: 100, properties: { sessionID: "s", assistantMessageID: "m", textID: "text", delta: "hello" } });
    await send({ type: "session.next.reasoning.delta", timestamp: 150, properties: { sessionID: "s", assistantMessageID: "m", reasoningID: "reason", delta: "think" } });
    await send({ type: "session.next.tool.input.delta", timestamp: 200, properties: { sessionID: "s", assistantMessageID: "m", callID: "call", delta: "{}" } });
    await send(snapshotFact("text", "m", "text", 190, "hello", 100));
    await send(snapshotFact("reason", "m", "reasoning", 180, "think", 150));
    await send({ type: "message.part.updated", timestamp: 250, properties: { part: { id: "tool-part", callID: "call", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 250 } } } } });
    await send(completionFact("m", 10, 5, 0, 1000));
    const [record] = await readRecords(path);
    assert.equal(record.samples.length, 3);
    assert.equal(record.samples.filter((s: any) => s.kind === "reasoning").reduce((sum: number, s: any) => sum + s.tokens, 0), 5);
    assert.equal(record.speed.generation, undefined);
    assert.equal(record.speed.generationEvidence, undefined);
    assert.equal(record.speed.response.durationMs, 1000);
    assert.equal((await readTotals(path)).sessions.s.speed.generation.responseCount, 0);
  });
});
test("explicit envelope revisions reject stale updates and permit a genuinely newer return to old facts", async () => {
  await backendCase(async ({ path, send }) => {
    await send({ ...completionFact("m", 10, 0, 0, 100), revision: 1 });
    await send({ ...completionFact("m", 0, 0, 0, 200), revision: 3 });
    await send({ ...completionFact("m", 5, 0, 0, 300), revision: 2 });
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 0);
    await send({ ...completionFact("m", 10, 0, 0, 100), revision: 4 });
    assert.equal((await readRecords(path))[0].tokens.output, 10);
    assert.equal((await readTotals(path)).sessions.s.tokens.output, 10);
    assert.equal((await readTotals(path)).sessions.s.responseCount, 1);
  });
});
test("server restart replay cannot backfill or double-add a legacy settled true marker", async () => {
  await backendCase(async ({ path, send, restart }) => {
    await textGeneration(send, "m");
    await send(completionFact("new", 0, 0, 300, 400));
    const ledger = await readTotals(path);
    ledger.settled.m = true;
    await writeFile(join(dirname(path), "totals.json"), JSON.stringify(ledger));
    const restarted = await restart();
    await restarted(completionFact("m", 100, 0, 0, 300));
    await restarted(completionFact("m", 100, 0, 0, 300));
    assert.deepEqual(await readTotals(path), ledger);
  }, 1);
});

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

test("known snapshot gap and uncertain tool input downgrade generation without sampling snapshots or tool output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-content-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    const send = (type: string, timestamp: number, properties: any) => receive(hooks, { type, timestamp, properties });
    await send("message.part.updated", 10, { part: { id: "text", messageID: "m", sessionID: "s", type: "text", text: "old snapshot", time: { start: 300 } } });
    await send("session.next.text.delta", 300, { sessionID: "s", assistantMessageID: "m", partID: "text", delta: "hi" });
    await send("message.part.delta", 100, { sessionID: "s", messageID: "m", partID: "reason", kind: "reasoning", field: "text", delta: "think" });
    await send("session.next.tool.input.delta", 400, { sessionID: "s", assistantMessageID: "m", partID: "tool", delta: "{}" });
    await send("message.part.updated", 500, { part: { id: "reason", messageID: "m", sessionID: "s", type: "reasoning", text: "think", time: { start: 100, end: 200 } } });
    await send("message.part.updated", 510, { part: { id: "text", messageID: "m", sessionID: "s", type: "text", text: "hi", time: { start: 300, end: 350 } } });
    await send("message.part.updated", 520, { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", time: { start: 450 } } } });
    await send("message.part.delta", 600, { sessionID: "s", messageID: "m", partID: "tool", field: "output", delta: "tool result must not count" });
    await send("message.part.updated", 950, { part: { id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", time: { start: 450, end: 900 } } } });
    const info = { id: "m", sessionID: "s", role: "assistant", tokens: { input: 10, output: 20, reasoning: 5 }, time: { created: 0, firstToken: 300, completed: 1000 } };
    await send("message.updated", 1000, { info });
    let records = await readRecords(historyPath);
    assert.equal(records[0].time.firstToken, 100);
    assert.equal(records[0].time.ttft, 100);
    assert.equal(records[0].samples.length, 2); // v2 final priority, no snapshot/result duplication
    assert.equal(records[0].speed.generation, undefined);
    assert.equal(records[0].speed.generationEvidence, undefined);
    assert.equal(records[0].speed.response.durationMs, 1000);
    await send("message.updated", 1200, { info: { ...info, time: { created: 0, firstToken: 300, completed: 1200 } } });
    records = await readRecords(historyPath);
    assert.equal(records[0].time.firstToken, 100);
    assert.equal(records[0].speed.response.durationMs, 1200);
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.s.responseCount, 1);
    assert.equal(totals.sessions.s.speed.response.durationMs, 1200);
    assert.equal(totals.sessions.s.speed.generation.responseCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unknown multistep usage is not summed and missing final usage is provisional", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-steps-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    for (const output of [10, 20]) await hooks.event!({ event: { type: "session.next.step.ended", timestamp: output,
      properties: { sessionID: "s", assistantMessageID: "m", tokens: { input: 5, output, reasoning: 0 } } } as never });
    await hooks.event!({ event: { type: "message.updated", timestamp: 100, properties: { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 0, completed: 100 } } } } as never });
    const [record] = await readRecords(historyPath);
    assert.equal(record.tokens.output, 20);
    assert.equal(record.quality, "provisional");
    assert.equal(record.speed.response.estimated, true);
    assert.equal(record.speed.generation, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cumulative direct speed outlives the retained history window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-speed-window-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath, maxRecords: 1 });
    await hooks.event!({ event: assistantCompleted("old", { input: 1, output: 10, reasoning: 0 }, 100) as never });
    await hooks.event!({ event: assistantCompleted("new", { input: 1, output: 30, reasoning: 0 }, 200) as never });
    assert.equal((await readRecords(historyPath)).length, 1);
    const totals = await readTotals(historyPath);
    assert.equal(totals.sessions.session.speed.response.generatedTokens, 40);
    assert.equal(totals.sessions.session.speed.response.durationMs, 100);
    assert.equal(totals.sessions.session.speed.response.responseCount, 2);
    assert.equal(totals.settled.old.speed.response.generatedTokens, 10);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("tool-only snapshots have no invented first output or generation interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-tps-tool-only-"));
  const historyPath = join(directory, "history.jsonl");
  try {
    const hooks = await server({ directory, worktree: directory } as unknown as PluginInput, { historyPath });
    await hooks.event!({ event: { type: "message.part.updated", timestamp: 100, properties: { part: {
      id: "tool", messageID: "m", sessionID: "s", type: "tool", state: { status: "running", input: { command: "echo hi" }, time: { start: 100 } },
    } } } as never });
    await hooks.event!({ event: { type: "session.next.tool.result", timestamp: 800, properties: { sessionID: "s", assistantMessageID: "m", delta: "result" } } as never });
    await hooks.event!({ event: assistantCompleted("m", { input: 1, output: 10, reasoning: 0 }, 1000, 0, "s") as never });
    const [record] = await readRecords(historyPath);
    assert.equal(record.time.firstToken, undefined);
    assert.equal(record.samples.length, 0);
    assert.equal(record.speed.generation, undefined);
    assert.equal(record.speed.response.durationMs, 50);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function readRunEvents(runsPath: string): Promise<any[]> {
  return new ActivityLedger(runsPath).read({ dedupe: false });
}

test("final usage supersedes fallback cache counts, preserves output zero, and deduplicates", async () => {
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
      cacheRead: 0,
      cacheWrite: 0,
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
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(completedWithinBound, true);

    const later = hooks.event({ event: {
      type: "session.status",
      timestamp: 300,
      properties: { sessionID: "later", status: "busy" },
    } as never });
    const laterWithinBound = await Promise.race([
      later.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(laterWithinBound, true);
    assert.equal((await readRecords(historyPath)).length, 1);
    assert.deepEqual((await readRunEvents(runsPath)).map((event) => event.state), ["busy"]);
    assert.equal(lookupCalls, 2); // child and unrelated later SID resolve independently
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
    assert.equal(lookupCalls, 2); // same child remains deduplicated while outstanding
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
        const options = request as any;
        assert.ok(options.signal instanceof AbortSignal, JSON.stringify(options));
        if (options.path.id === "root") return { data: { id: "root", agent: "editor" } };
        assert.deepEqual(options.path, { id: "child" });
        return { data: { id: "child", parentID: "root" } };
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

    await eventually(async () => (await readTotals(historyPath)).sessionScopes?.child?.parentSessionID === "root");
    const parentEvents = (await readRunEvents(runsPath)).filter((event) => event.kind === "parent");
    assert.equal(parentEvents.length, 1);
    assert.equal(parentEvents[0]?.parentSessionID, "root");
    assert.equal((await readRecords(historyPath))[0]?.parentSessionID, undefined); // old completion is immutable
    assert.equal(lookupCalls, 2); // parent metadata is resolved too

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
    assert.equal(lookupCalls, 2);
    assert.equal((await readRecords(historyPath)).find((record) => record.messageID === "message-2")?.parentSessionID, "root");
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
