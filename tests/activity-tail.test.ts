import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeActivityEvent, type ActivityEvent } from "../src/activity.js";
import { readLedgerText } from "../src/persistence-files.js";
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
