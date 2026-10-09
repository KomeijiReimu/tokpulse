import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEFAULT_HISTORY_PATH = ".tokpulse/history.jsonl";
const LEGACY_DIRECTORY = ".opencode/oc-tps";
const LEDGER_FILES = ["history.jsonl", "totals.json", "runs.jsonl"] as const;

interface LedgerPaths {
  historyPath: string;
  totalsPath: string;
  runsPath: string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Never create or follow a legacy/target directory while checking for migration. */
async function directoryState(path: string): Promise<"missing" | "empty" | "nonempty"> {
  let entry;
  try { entry = await lstat(path); }
  catch (error) { if (missing(error)) return "missing"; throw error; }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe ledger directory: ${path}`);
  return (await readdir(path)).length === 0 ? "empty" : "nonempty";
}

/** Server startup only: publish an opaque bundle before any ledger is initialized.
 * Custom paths are untouched. A nonempty target always wins, including another startup's bundle.
 * Only our private staging directory is removed, never legacy data or an existing target.
 */
export async function migrateDefaultLedgers(baseDirectory: string, paths: LedgerPaths): Promise<boolean> {
  const target = resolve(baseDirectory, ".tokpulse");
  if (resolve(paths.historyPath) !== join(target, "history.jsonl")
    || resolve(paths.totalsPath) !== join(target, "totals.json")
    || resolve(paths.runsPath) !== join(target, "runs.jsonl")) return false;
  if (await directoryState(target) === "nonempty") return false;
  if (await directoryState(resolve(baseDirectory, ".opencode")) === "missing") return false;
  const legacy = resolve(baseDirectory, LEGACY_DIRECTORY);
  if (await directoryState(legacy) === "missing") return false;

  let stage: string | undefined;
  try {
    for (const filename of LEDGER_FILES) {
      let source;
      try {
        // O_NOFOLLOW rejects a file symlink; NONBLOCK lets us reject FIFOs without hanging.
        source = await open(join(legacy, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) { if (missing(error)) continue; throw error; }
      try {
        if (!(await source.stat()).isFile()) throw new Error(`Not a regular legacy ledger: ${filename}`);
        const bytes = await source.readFile();
        stage ??= await mkdtemp(join(resolve(baseDirectory), ".tokpulse-migrate-"));
        await writeFile(join(stage, filename), bytes, { flag: "wx" });
      } finally { await source.close(); }
    }
    if (!stage) return false;
    try { await rename(stage, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code === "EEXIST" || code === "ENOTEMPTY") && await directoryState(target) === "nonempty") return false;
      throw error;
    }
    stage = undefined;
    return true;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
