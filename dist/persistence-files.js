import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
export function isMissing(error) {
  return error?.code === "ENOENT";
}

/** Resolve real existing parents without creating directories or ledger files. */
export async function canonicalLedgerPath(path) {
  const absolute = resolve(path);
  const tail = [basename(absolute)];
  let parent = dirname(absolute);
  for (;;) {
    try {
      return join(await realpath(parent), ...tail);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      tail.unshift(basename(parent));
      parent = next;
    }
  }
}
class LedgerIdentityChangedError extends Error {
  constructor(path) {
    super(`Ledger identity changed: ${path}`);
  }
}
function assertSafeLedgerStat(path, stat) {
  if (stat.isFile() && !stat.isSymbolicLink()) {
    if (stat.nlink === 1) return;
    // An atomic replacement can unlink the inode while lstat or fstat samples it.
    if (stat.nlink === 0) throw new LedgerIdentityChangedError(path);
  }
  throw new Error(`Unsafe ledger file identity (regular, single-link file required): ${path}`);
}
export async function inspectLedgerFile(path) {
  try {
    const stat = await lstat(path);
    assertSafeLedgerStat(path, stat);
    return stat;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
function sameIdentity(a, b) {
  return a === undefined ? b === undefined : b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/** All ledger opens are nonblocking/nofollow, and validated on the actual fd. */
export async function openLedgerFile(path, flags, mode = 0o600) {
  const before = await inspectLedgerFile(path);
  const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  try {
    const stat = await file.stat();
    assertSafeLedgerStat(path, stat);
    if (before && !sameIdentity(before, stat)) throw new LedgerIdentityChangedError(path);
    const after = await inspectLedgerFile(path);
    if (!sameIdentity(stat, after)) throw new LedgerIdentityChangedError(path);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
export async function readLedgerText(path) {
  const maxAttempts = 3;
  for (let attempt = 1;; attempt++) {
    let file;
    try {
      file = await openLedgerFile(path, constants.O_RDONLY);
    } catch (error) {
      if (!(error instanceof LedgerIdentityChangedError) || attempt === maxAttempts) throw error;
      continue;
    }
    try {
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }
}

/** Process-crash atomic replacement, not a claim of power-loss durability. */
export async function replaceLedgerText(path, content) {
  const canonical = await canonicalLedgerPath(path);
  const before = await inspectLedgerFile(path);
  await mkdir(dirname(canonical), {
    recursive: true
  });
  const temporary = join(dirname(canonical), `.${basename(canonical)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  let file;
  try {
    file = await openLedgerFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await file.writeFile(content, "utf8");
    await file.close();
    file = undefined;
    if ((await canonicalLedgerPath(path)) !== canonical || !sameIdentity(before, await inspectLedgerFile(path))) {
      throw new Error(`Ledger identity changed before replacement: ${path}`);
    }
    await rename(temporary, canonical);
  } finally {
    if (file) await file.close();
    await rm(temporary, {
      force: true
    });
  }
}
export async function appendLedgerText(path, content) {
  const canonical = await canonicalLedgerPath(path);
  await inspectLedgerFile(path);
  await mkdir(dirname(canonical), {
    recursive: true
  });
  if ((await canonicalLedgerPath(path)) !== canonical) throw new Error(`Ledger parent changed: ${path}`);
  const file = await openLedgerFile(canonical, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}
