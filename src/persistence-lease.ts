import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalLedgerPath, inspectLedgerFile, isMissing } from "./persistence-files.js";
import type { LedgerPaths, WriterLease } from "./persistence.js";

export async function prepareLedgerPaths(directory: string, options: {
  historyPath?: string; totalsPath?: string; runsPath?: string;
} = {}): Promise<LedgerPaths> {
  const history = resolve(directory, options.historyPath?.trim() || ".tokpulse/history.jsonl");
  // The migration target is an opaque directory bundle, never a directory
  // symlink. Do this before canonicalization would hide that original alias.
  if (history === resolve(directory, ".tokpulse/history.jsonl")) {
    try {
      const entry = await lstat(dirname(history));
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe ledger directory: ${dirname(history)}`);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  const sibling = (configured: string | undefined, fallback: string) => configured
    ? isAbsolute(configured) ? configured : join(dirname(history), configured)
    : join(dirname(history), fallback);
  const paths = await Promise.all([history, sibling(options.totalsPath, "totals.json"), sibling(options.runsPath, "runs.jsonl")]
    .map(async (path) => { await inspectLedgerFile(path); return canonicalLedgerPath(path); }));
  if (new Set(paths).size !== paths.length) throw new Error("Ledger paths collide");
  if (paths.some((path) => path.split(sep).includes(".tokpulse-writer-locks"))) {
    throw new Error("Ledger path uses the reserved writer-lock namespace");
  }
  const identities = new Set<string>();
  for (const path of paths) {
    const stat = await inspectLedgerFile(path);
    if (!stat) continue;
    const key = `${stat.dev}:${stat.ino}`;
    if (identities.has(key)) throw new Error("Ledger files alias the same inode");
    identities.add(key);
  }
  return { historyPath: paths[0]!, totalsPath: paths[1]!, runsPath: paths[2]! };
}

type LockDatabase = { exec(sql: string): unknown; close(): unknown };
type DatabaseConstructor = new (path: string) => LockDatabase;
// Retain native connections until explicit release, even if the caller drops
// the JS lease object. GC must never silently surrender writer ownership.
const ownedPaths = new Map<string, LockDatabase>();

async function databaseConstructor(): Promise<DatabaseConstructor> {
  // Keep Bun-only imports out of module initialization: the plugin also loads in Node.
  const moduleName = typeof (globalThis as any).Bun !== "undefined" ? "bun:sqlite" : "node:sqlite";
  try {
    const sqlite = await import(moduleName);
    const Database = sqlite.Database ?? sqlite.DatabaseSync;
    if (!Database) throw new Error("No SQLite constructor");
    return Database;
  } catch (cause) {
    throw new Error("Writer ownership requires built-in SQLite (Bun or a Node version with node:sqlite); refusing unsafe fallback", { cause });
  }
}

export async function acquireWriterLease(input: LedgerPaths): Promise<WriterLease> {
  const paths = await prepareLedgerPaths("/", input);
  const ordered = Object.values(paths).sort();
  const Database = await databaseConstructor();
  const locks: LockDatabase[] = [];
  const acquired: string[] = [];
  try {
    for (const path of ordered) {
      if (ownedPaths.has(path)) throw new Error(`Ledger already owned by a writer: ${path}`);
      // Lock carriers live outside the business directory, so ownership can be
      // acquired before legacy-bundle migration creates the target directory.
      // Their location depends only on the canonical ledger path, NEVER HOME
      // or another per-process environment variable. A shared path must lock
      // the same carrier even when independent hosts have different homes.
      const lockDirectory = join(dirname(dirname(path)), ".tokpulse-writer-locks");
      await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
      const lockDirectoryStat = await lstat(lockDirectory);
      if (!lockDirectoryStat.isDirectory() || lockDirectoryStat.isSymbolicLink()) throw new Error(`Unsafe writer lock directory: ${lockDirectory}`);
      const lockPath = join(lockDirectory, `${createHash("sha256").update(path).digest("hex")}.sqlite`);
      await inspectLedgerFile(lockPath);
      const db = new Database(lockPath);
      locks.push(db);
      db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
      await inspectLedgerFile(lockPath);
      ownedPaths.set(path, db);
      acquired.push(path);
    }
  } catch (cause) {
    for (const db of locks.reverse()) { try { db.close(); } catch {} }
    for (const path of acquired) ownedPaths.delete(path);
    throw new Error("Cannot acquire exclusive ledger writer ownership", { cause });
  }
  let released = false;
  return {
    paths: Object.freeze(paths),
    assertOwned(path) {
      if (released || !acquired.includes(resolve(path))) throw new Error(`Writer lease does not own: ${path}`);
    },
    async release() {
      if (released) return;
      released = true;
      let failure: unknown;
      for (const db of locks.reverse()) { try { db.close(); } catch (error) { failure ??= error; } }
      for (const path of acquired) ownedPaths.delete(path);
      if (failure) throw failure;
    },
  };
}
