import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeActivityEvent, type ActivityEvent } from "../src/activity.js";
import { readLedgerText } from "../src/persistence-files.js";
import { acquireWriterLease } from "../src/persistence.js";
import { createActivityLedger, parseActivityJsonl, readActivityDelta, readActivityFile, serializeActivityJsonl, writeActivityFile, type ActivityReadCursor } from "../src/runs-storage.js";
const { spyOn } = require("bun:test");

async function directory(context: { after(callback: () => Promise<void>): void }) {
  const root = join(homedir(), ".cache", "tokpulse-tests");
  await fs.mkdir(root, { recursive: true });
  const base = await fs.mkdtemp(join(root, "activity-tail-"));
  context.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}
function fact(id: string, seq = 0, sessionID = "normal"): ActivityEvent {
  return normalizeActivityEvent({ kind: "lifecycle", eventID: id, instanceID: "tail-test", sessionID,
    state: seq % 2 === 0 ? "busy" : "idle", timestamp: seq, seq })!;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function duringValidation(path: string, change: () => Promise<void>, read: () => Promise<void>) {
  const original = fs.open;
  const handles: { mockRestore(): void }[] = [];
  let injected = false;
  const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof original>) => {
    const file = await original(...args);
    if (String(args[0]) !== path) return file;
    const stat = file.stat.bind(file);
    let snapshots = 0;
    handles.push(spyOn(file, "stat").mockImplementation(async (...params: any[]) => {
      if (params[0]?.bigint && ++snapshots === 2) { injected = true; await change(); }
      return (stat as any)(...params);
    }));
    return file;
  });
  try { await read(); assert.equal(injected, true); }
  finally { for (const handle of handles.reverse()) handle.mockRestore(); opening.mockRestore(); }
}

for (const mode of ["cold", "reset", "append", "unchanged"] as const) {
  test(`normal append during ${mode} validation commits only captured EOF without starving`, async (context) => {
    const base = await directory(context), path = join(base, "runs");
    const ledger = createActivityLedger(path);
    await ledger.append(fact("A"));
    const previous = mode === "cold" ? undefined : (await readActivityDelta(path)).cursor;
    if (mode === "reset") await writeActivityFile(path, [fact("B", 1)]);
    if (mode === "append") await ledger.append(fact("B", 1));
    let committed: ActivityReadCursor | undefined;
    await duringValidation(path, () => ledger.append(fact("C", 2)).then(() => {}), async () => {
      const result = await readActivityDelta(path, previous);
      assert.equal(result.mode, mode === "cold" ? "reset" : mode);
      assert.deepEqual(result.events.map((event) => event.eventID), mode === "unchanged" ? [] : [mode === "cold" ? "A" : "B"]);
      committed = result.cursor;
    });
    const next = await readActivityDelta(path, committed);
    assert.equal(next.mode, "append");
    assert.deepEqual(next.events.map((event) => event.eventID), ["C"]);
    assert.equal((await readActivityDelta(path, next.cursor)).mode, "unchanged");
  });
}

test("partial UTF8 completed during validation is recovered from the captured line boundary", async (context) => {
  const base = await directory(context), path = join(base, "runs");
  const line = Buffer.from(JSON.stringify(fact("中文-race", 1)));
  const split = line.indexOf(Buffer.from("中")) + 1;
  await fs.writeFile(path, line.subarray(0, split));
  let cursor: ActivityReadCursor | undefined;
  await duringValidation(path, () => fs.appendFile(path, Buffer.concat([line.subarray(split), Buffer.from("\n")])), async () => {
    const result = await readActivityDelta(path);
    assert.deepEqual(result.events, []);
    cursor = result.cursor;
  });
  assert.deepEqual((await readActivityDelta(path, cursor)).events.map((event) => event.eventID), ["中文-race"]);
});

test("every validation can overlap another append without forcing reader quiescence or advancing beyond read bytes", async (context) => {
  const base = await directory(context), path = join(base, "runs");
  const ledger = createActivityLedger(path);
  await ledger.append(fact("n0"));
  let cursor: ActivityReadCursor | undefined;
  for (let round = 0; round < 8; round++) {
    await duringValidation(path, () => ledger.append(fact(`n${round + 1}`, round + 1)).then(() => {}), async () => {
      const delta = await readActivityDelta(path, cursor);
      assert.deepEqual(delta.events.map((event) => event.eventID), [`n${round}`]);
      cursor = delta.cursor;
    });
  }
  const last = await readActivityDelta(path, cursor);
  assert.deepEqual(last.events.map((event) => event.eventID), ["n8"]);
  assert.equal((await readActivityDelta(path, last.cursor)).mode, "unchanged");
});

test("concurrent validation still rejects replacement, truncation and guarded overwrite including growth", async (context) => {
  const base = await directory(context), path = join(base, "runs");
  for (const kind of ["replace", "truncate", "overwrite", "overwrite-grow"]) {
    await writeActivityFile(path, [fact("A")]);
    const before = (await fs.stat(path)).size;
    await duringValidation(path, async () => {
      if (kind === "replace") await writeActivityFile(path, [fact("B", 1)]);
      else if (kind === "truncate") await fs.truncate(path, 0);
      else {
        const file = await fs.open(path, "r+");
        try { await file.write(serializeActivityJsonl([fact("B")]), 0, "utf8"); }
        finally { await file.close(); }
        if (kind === "overwrite-grow") await fs.appendFile(path, serializeActivityJsonl([fact("C", 1)]));
        else assert.equal((await fs.stat(path)).size, before);
      }
    }, async () => { await assert.rejects(readActivityDelta(path), /changed|truncated/); });
  }
});

test("independent producers through one lease writer converge while the reader repeatedly overlaps live appends", async (context) => {
  const base = await directory(context), path = join(base, "runs");
  const lease = await acquireWriterLease({ historyPath: join(base, "history"), totalsPath: join(base, "totals"), runsPath: path });
  context.after(() => lease.release());
  const ledger = createActivityLedger(path, { lease });
  await ledger.append(fact("seed"));
  let writes = 0, reads = 0, overlapped = 0, done = false;
  const children: ReturnType<typeof spawn>[] = [];
  context.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const producers = Array.from({ length: 3 }, (_, producer) => (async () => {
    const script = `for(let i=0;i<60;i++){console.log(JSON.stringify({id:'p${producer}-'+i,seq:i,sid:'s${producer}'}));await Bun.sleep(1);}`;
    const child = spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, TMPDIR: join(homedir(), ".cache", "tokpulse-test-tmp"),
    } });
    children.push(child);
    const exited = once(child, "exit");
    let buffer = "", stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    for await (const chunk of child.stdout!) {
      buffer += String(chunk);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const input = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        await ledger.append(fact(input.id, input.seq, input.sid));
        writes++;
      }
    }
    assert.equal(buffer, "");
    assert.equal((await exited)[0], 0, stderr);
  })());
  const producing = Promise.all(producers).finally(() => { done = true; });
  // Attach a rejection handler immediately; await below still propagates it.
  void producing.catch(() => {});
  let cursor: ActivityReadCursor | undefined;
  const seen = new Set<string>();
  const apply = async () => {
    const before = writes;
    const delta = await readActivityDelta(path, cursor);
    reads++;
    if (writes > before) overlapped++;
    for (const event of delta.events) {
      assert.equal(seen.has(event.eventID), false, `double canonical fact ${event.eventID}`);
      seen.add(event.eventID);
    }
    cursor = delta.cursor;
  };
  const deadline = performance.now() + 10000;
  while (!done && performance.now() < deadline) { await apply(); await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.equal(done, true, "bounded producer/reader run must finish");
  await producing;
  await apply();
  assert.equal((await readActivityDelta(path, cursor)).mode, "unchanged");
  assert.equal(writes, 180);
  assert.equal(seen.size, 181);
  assert.deepEqual([...seen].sort(), (await readActivityFile(path)).map((event) => event.eventID).sort());
  assert.ok(reads > 1);
  assert.ok(overlapped > 0, "live writer must overlap actual reader calls");
});
function countReads(path: string, fail?: { once: boolean; readFile?: boolean }) {
  const counts = { bytes: 0, reads: 0, readFiles: 0, parsed: 0, opened: 0, closed: 0 };
  const open = fs.open;
  const parse = JSON.parse;
  const spies: { mockRestore(): void }[] = [];
  spies.push(spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (String(args[0]) !== path) return file;
    counts.opened++;
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    const readFile = file.readFile.bind(file);
    spies.push(spyOn(file, "read").mockImplementation(async (...params: any[]) => {
      counts.reads++;
      if (fail?.once) { fail.once = false; throw Object.assign(new Error("tail EIO"), { code: "EIO" }); }
      const result = await (read as any)(...params);
      counts.bytes += result.bytesRead;
      return result;
    }));
    spies.push(spyOn(file, "readFile").mockImplementation(async (...params: any[]) => {
      counts.readFiles++;
      if (fail?.once && fail.readFile) { fail.once = false; throw new Error("safe reader EIO"); }
      return (readFile as any)(...params);
    }));
    spies.push(spyOn(file, "close").mockImplementation(async () => { counts.closed++; return close(); }));
    return file;
  }));
  spies.push(spyOn(JSON, "parse").mockImplementation((text: string, reviver?: any) => {
    counts.parsed++;
    return parse(text, reviver);
  }));
  return { counts, restore() { for (const spy of spies.reverse()) spy.mockRestore(); } };
}

test("delta reader is pure, cursors are path-bound and reset on replace, truncate and detectable same-inode overwrite", async (context) => {
  const base = await directory(context);
  const missing = join(base, "absent", "runs");
  assert.deepEqual(await readActivityDelta(missing), { mode: "reset", events: [], cursor: undefined });
  await assert.rejects(fs.lstat(join(base, "absent")), { code: "ENOENT" });
  const path = join(base, "runs");
  const ledger = createActivityLedger(path);
  await ledger.appendMany([fact("A"), fact("B", 1)]);
  const baseline = await readActivityDelta(path);
  assert.equal(baseline.mode, "reset");
  assert.deepEqual(baseline.events, await readActivityFile(path));
  assert.equal(Object.isFrozen(baseline.cursor), true);
  const bytes = await fs.readFile(path);
  for (let index = 0; index < 5; index++) {
    const repeated = await readActivityDelta(path, baseline.cursor);
    assert.equal(repeated.mode, "unchanged");
    assert.equal(repeated.cursor, baseline.cursor);
    assert.deepEqual(repeated.events, []);
  }
  assert.deepEqual(await fs.readFile(path), bytes);
  await writeActivityFile(path, [fact("C", 2)]);
  const replaced = await readActivityDelta(path, baseline.cursor);
  assert.equal(replaced.mode, "reset");
  assert.deepEqual(replaced.events.map((event) => event.eventID), ["C"]);
  await fs.truncate(path, 0);
  const truncated = await readActivityDelta(path, replaced.cursor);
  assert.equal(truncated.mode, "reset");
  assert.deepEqual(truncated.events, []);
  await fs.writeFile(path, serializeActivityJsonl([fact("D", 3)]));
  const grown = await readActivityDelta(path, truncated.cursor);
  assert.equal(grown.mode, "append");
  const identity = await fs.stat(path);
  // Equal size overwrite on the same FD, including restored mtime: ctime
  // metadata changes must force reset, not a false unchanged result.
  const file = await fs.open(path, "r+");
  try { await file.write(serializeActivityJsonl([fact("E", 3)]), 0, "utf8"); }
  finally { await file.close(); }
  await fs.utimes(path, identity.atime, identity.mtime);
  const overwritten = await readActivityDelta(path, grown.cursor);
  assert.equal(overwritten.mode, "reset");
  assert.deepEqual(overwritten.events.map((event) => event.eventID), ["E"]);
  const other = join(base, "other");
  await fs.writeFile(other, await fs.readFile(path));
  assert.equal((await readActivityDelta(other, overwritten.cursor)).mode, "reset");
  // Growth cannot alone establish append-only history: overwrite the guarded
  // prefix while growing this same inode, then expect a full reset.
  const writer = await fs.open(path, "r+");
  try { await writer.write(serializeActivityJsonl([fact("F", 3)]), 0, "utf8"); }
  finally { await writer.close(); }
  await ledger.append(fact("G", 4));
  const rewrittenAndGrown = await readActivityDelta(path, overwritten.cursor);
  assert.equal(rewrittenAndGrown.mode, "reset");
  assert.deepEqual(rewrittenAndGrown.events.map((event) => event.eventID), ["F", "G"]);
});

test("delta reader preserves partial UTF8/lines, invalid neighbors, CRLF and legacy valid EOF without newline", async (context) => {
  const base = await directory(context);
  const path = join(base, "runs");
  await fs.writeFile(path, `\uFEFF${JSON.stringify(fact("start"))}\r\nnot-json\n{broken\n`);
  let result = await readActivityDelta(path);
  assert.deepEqual(result.events.map((event) => event.eventID), ["start"]);
  const unicode = Buffer.from(JSON.stringify(fact("中文-é-🙂", 1)));
  const split = unicode.indexOf(Buffer.from("中")) + 1;
  await fs.appendFile(path, unicode.subarray(0, split));
  result = await readActivityDelta(path, result.cursor);
  assert.equal(result.mode, "append");
  assert.deepEqual(result.events, []);
  assert.equal((await readActivityDelta(path, result.cursor)).mode, "unchanged");
  await fs.appendFile(path, Buffer.concat([unicode.subarray(split), Buffer.from("\r\ninvalid\n") ]));
  result = await readActivityDelta(path, result.cursor);
  assert.deepEqual(result.events.map((event) => event.eventID), ["中文-é-🙂"]);
  await fs.appendFile(path, JSON.stringify(fact("legacy-eof", 2)));
  result = await readActivityDelta(path, result.cursor);
  assert.deepEqual(result.events.map((event) => event.eventID), ["legacy-eof"]);
  const eofCursor = result.cursor;
  await fs.appendFile(path, `\n${JSON.stringify(fact("following", 3))}\n`);
  result = await readActivityDelta(path, eofCursor);
  // Cross-batch duplicate of a stable eventID is intentional; the caller
  // confirms/deduplicates canonical facts rather than retaining all IDs here.
  assert.deepEqual(result.events.map((event) => event.eventID), ["legacy-eof", "following"]);
  assert.deepEqual((await readActivityFile(path)).map((event) => event.eventID), ["start", "中文-é-🙂", "legacy-eof", "following"]);
  assert.deepEqual(parseActivityJsonl(await readLedgerText(path)), await readActivityFile(path));
});

test("failed reads and discarded concurrent cursors never advance another caller's checkpoint", async (context) => {
  const base = await directory(context);
  const path = join(base, "runs");
  const ledger = createActivityLedger(path);
  await ledger.append(fact("A"));
  const original = await readActivityDelta(path);
  await ledger.append(fact("B", 1));
  const failure = countReads(path, { once: true });
  try {
    await assert.rejects(readActivityDelta(path, original.cursor), /tail EIO/);
    assert.equal(failure.counts.opened, failure.counts.closed);
  } finally { failure.restore(); }
  const finished = deferred(), deliver = deferred();
  const stale = readActivityDelta(path, original.cursor).then(async (result) => {
    finished.resolve(); await deliver.promise; return result;
  });
  await finished.promise;
  await ledger.append(fact("C", 2));
  const current = await readActivityDelta(path, original.cursor);
  assert.deepEqual(current.events.map((event) => event.eventID), ["B", "C"]);
  deliver.resolve();
  const discarded = await stale;
  assert.deepEqual(discarded.events.map((event) => event.eventID), ["B"]);
  // Generation owner keeps current.cursor, deliberately discarding stale.
  await ledger.append(fact("D", 3));
  assert.deepEqual((await readActivityDelta(path, current.cursor)).events.map((event) => event.eventID), ["D"]);
  assert.deepEqual((await readActivityDelta(path, original.cursor)).events.map((event) => event.eventID), ["B", "C", "D"]);
});

test("mid-read truncation rejects a snapshot, closes its FD and leaves the caller cursor reusable", async (context) => {
  const base = await directory(context);
  const path = join(base, "runs");
  await writeActivityFile(path, [fact("A")]);
  const initial = await readActivityDelta(path);
  await createActivityLedger(path).append(fact("B", 1));
  const open = fs.open;
  let changed = false, opened = 0, closed = 0;
  const handles: { mockRestore(): void }[] = [];
  const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (String(args[0]) !== path) return file;
    opened++;
    const read = file.read.bind(file), close = file.close.bind(file);
    handles.push(spyOn(file, "close").mockImplementation(async () => { closed++; return close(); }));
    handles.push(spyOn(file, "read").mockImplementation(async (...params: any[]) => {
      const result = await (read as any)(...params);
      if (!changed) { changed = true; await fs.truncate(path, 0); }
      return result;
    }));
    return file;
  });
  try {
    await assert.rejects(readActivityDelta(path, initial.cursor), /truncated|changed/);
    assert.equal(changed, true);
    assert.equal(opened, closed);
  } finally { for (const handle of handles.reverse()) handle.mockRestore(); opening.mockRestore(); }
  await writeActivityFile(path, [fact("A"), fact("B", 1)]);
  const recovered = await readActivityDelta(path, initial.cursor);
  assert.equal(recovered.mode, "reset");
  assert.deepEqual(recovered.events.map((event) => event.eventID), ["A", "B"]);
  const safeFailure = countReads(path, { once: true, readFile: true });
  try {
    await assert.rejects(readLedgerText(path), /safe reader EIO/);
    assert.equal(safeFailure.counts.opened, 1);
    assert.equal(safeFailure.counts.closed, 1);
  } finally { safeFailure.restore(); }
});

for (const size of [1000, 4000, 16000, 40000]) {
  test(`tail ${size} sessions: cumulative actual bytes/JSON parses stay incremental across repeated appends and watch reads`, async (context) => {
    const base = await directory(context);
    const path = join(base, "runs");
    const events = Array.from({ length: size }, (_, index) => [fact(`b${index}`, index * 2, `s${index}`), fact(`e${index}`, index * 2 + 1, `s${index}`)]).flat();
    await writeActivityFile(path, events);
    const sizeBytes = (await fs.stat(path)).size;
    const io = countReads(path);
    const begin = performance.now();
    try {
      let result = await readActivityDelta(path);
      let cursor: ActivityReadCursor | undefined = result.cursor;
      assert.equal(result.events.length, size * 2);
      assert.equal(io.counts.bytes, sizeBytes);
      assert.equal(io.counts.parsed, size * 2);
      const coldMs = performance.now() - begin;
      const warmBegin = performance.now();
      let addedBytes = 0;
      for (let round = 0; round < 8; round++) {
        // Alternate an established SID with a new SID; the cursor is byte-
        // based and cannot quietly retire either stream's history.
        const sid = round % 2 === 0 ? "s0" : `new${round}`;
        const addition = `\n${serializeActivityJsonl([fact(`new-b${round}`, round * 2, sid), fact(`new-e${round}`, round * 2 + 1, sid)])}`;
        addedBytes += Buffer.byteLength(addition);
        await fs.appendFile(path, addition);
        result = await readActivityDelta(path, cursor);
        assert.equal(result.mode, "append");
        assert.equal(result.events.length, 2);
        cursor = result.cursor;
        const before = { ...io.counts };
        result = await readActivityDelta(path, cursor);
        assert.equal(result.mode, "unchanged");
        assert.equal(io.counts.bytes, before.bytes);
        assert.equal(io.counts.parsed, before.parsed);
      }
      assert.equal(io.counts.bytes - sizeBytes, addedBytes + 8 * 8192);
      assert.equal(io.counts.parsed - size * 2, 16);
      assert.equal(io.counts.readFiles, 0);
      assert.equal(io.counts.opened, io.counts.closed);
      console.log(`[activity-tail ${size}] coldMs=${coldMs.toFixed(2)} warmMs=${(performance.now() - warmBegin).toFixed(2)} baselineBytes=${sizeBytes} tailBytes=${io.counts.bytes - sizeBytes} newBytes=${addedBytes} baselineParses=${size * 2} tailParses=${io.counts.parsed - size * 2} ${JSON.stringify(io.counts)}`);
    } finally { io.restore(); }
  });
}

test("shared safe reader rejects unsafe files without reading targets and accepts normal atomic replacement", async (context) => {
  const base = await directory(context);
  const path = join(base, "ledger");
  const target = join(base, "sentinel");
  await fs.writeFile(target, "sensitive-isolated-sentinel");
  for (const kind of ["symlink", "fifo", "directory", "hardlink"]) {
    if (kind === "symlink") await fs.symlink(target, path);
    if (kind === "fifo") assert.equal(spawnSync("mkfifo", [path]).status, 0);
    if (kind === "directory") await fs.mkdir(path);
    if (kind === "hardlink") await fs.link(target, path);
    for (let attempt = 0; attempt < 8; attempt++) {
      await assert.rejects(readLedgerText(path), /Unsafe/);
      await assert.rejects(readActivityDelta(path), /Unsafe/);
    }
    await fs.rm(path, { recursive: true, force: true });
  }
  assert.equal(await fs.readFile(target, "utf8"), "sensitive-isolated-sentinel");
  await fs.writeFile(path, "first");
  assert.equal(await readLedgerText(path), "first");
  const next = join(base, "replacement");
  await fs.writeFile(next, "second");
  await fs.rename(next, path);
  assert.equal(await readLedgerText(path), "second");
});

test("safe FD rejects deterministic check/open replacements in isolated processes and closes every opened handle", async (context) => {
  const base = await directory(context);
  const moduleURL = new URL("../src/persistence-files.ts", import.meta.url).href;
  const readerURL = new URL("../src/runs-storage.ts", import.meta.url).href;
  for (const reader of ["readLedgerText", "readActivityDelta"]) for (const kind of ["fifo", "directory", "symlink", "hardlink", "regular"]) {
    const path = join(base, `${reader}-${kind}`);
    const sentinel = join(base, "sentinel");
    await fs.writeFile(path, "initial");
    await fs.writeFile(sentinel, "target-not-read");
    const script = `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import {constants} from 'node:fs';
      import {spawnSync} from 'node:child_process';
      import {spyOn} from 'bun:test';
      import {readLedgerText} from ${JSON.stringify(moduleURL)};
      import {readActivityDelta} from ${JSON.stringify(readerURL)};
      const path=${JSON.stringify(path)}, target=${JSON.stringify(sentinel)}, kind=${JSON.stringify(kind)};
      let injected=false, opened=0, closed=0, read=0;
      const original=fs.open;
      spyOn(fs,'open').mockImplementation(async (...args)=>{
        if(String(args[0])===path&&!injected){
          injected=true;
          assert.ok(args[1]&constants.O_NOFOLLOW); assert.ok(args[1]&constants.O_NONBLOCK);
          await fs.rename(path,path+'.old');
          if(kind==='fifo') assert.equal(spawnSync('mkfifo',[path]).status,0);
          else if(kind==='directory') await fs.mkdir(path);
          else if(kind==='symlink') await fs.symlink(target,path);
          else if(kind==='hardlink') await fs.link(target,path);
          else await fs.writeFile(path,'replacement');
        }
        const file=await original(...args); opened++;
        const close=file.close.bind(file);
        spyOn(file,'close').mockImplementation(async()=>{closed++;return close();});
        spyOn(file,'readFile').mockImplementation(async()=>{read++;throw Error('UNSAFE READ');});
        spyOn(file,'read').mockImplementation(async()=>{read++;throw Error('UNSAFE READ');});
        return file;
      });
      await assert.rejects(${reader}(path), /identity|ELOOP|symbolic/i);
      assert.ok(injected); assert.equal(opened,closed); assert.equal(read,0);
      assert.equal(await fs.readFile(target,'utf8'),'target-not-read');
    `;
    const result = spawnSync(process.execPath, ["--eval", script], { timeout: 2000, encoding: "utf8", env: {
      ...process.env, TMPDIR: join(homedir(), ".cache", "tokpulse-test-tmp"),
    } });
    assert.equal(result.status, 0, `${reader}/${kind}: ${result.stderr} ${String(result.error ?? "")}`);
  }
});
