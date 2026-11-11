import { constants, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
export const DEFAULT_HISTORY_PATH = ".tokpulse/data/history.jsonl";
const FLAT_HISTORY_PATH = ".tokpulse/history.jsonl";
const LEGACY_DIRECTORY = ".opencode/oc-tps";
const LEDGER_FILES = ["history.jsonl", "totals.json", "runs.jsonl"];
export function configuredHistoryPath(path) {
  return !path?.trim() || path === FLAT_HISTORY_PATH ? DEFAULT_HISTORY_PATH : path;
}

/** Read-only access to historical directories that have not run the new server. */
export function readOnlyHistoryPath(directory, configured) {
  const path = configuredHistoryPath(configured);
  const history = isAbsolute(path) ? path : join(directory, path);
  if (path !== DEFAULT_HISTORY_PATH || existsSync(resolve(directory, ".tokpulse/data"))) return history;
  return LEDGER_FILES.some(name => existsSync(resolve(directory, ".tokpulse", name))) ? resolve(directory, FLAT_HISTORY_PATH) : history;
}
function isDefaultBundle(baseDirectory, paths) {
  const target = resolve(baseDirectory, ".tokpulse/data");
  return resolve(paths.historyPath) === join(target, "history.jsonl") && resolve(paths.totalsPath) === join(target, "totals.json") && resolve(paths.runsPath) === join(target, "runs.jsonl");
}

/** Old root-level locks are obsolete; only clean them after default startup succeeds. */
export async function removeLegacyWriterLocks(baseDirectory, paths) {
  if (isDefaultBundle(baseDirectory, paths)) {
    await rm(resolve(baseDirectory, ".tokpulse-writer-locks"), {
      recursive: true,
      force: true
    });
  }
}
function missing(error) {
  return error?.code === "ENOENT";
}

/** Never create or follow a legacy/target directory while checking for migration. */
async function directoryState(path) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (missing(error)) return "missing";
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe ledger directory: ${path}`);
  return (await readdir(path)).length === 0 ? "empty" : "nonempty";
}

/** Server startup only: publish an opaque bundle before any ledger is initialized.
 * Custom paths are untouched. A nonempty target always wins, including another startup's bundle.
 * Flat source files are removed only after publication; ancient .opencode data is retained.
 */
export async function migrateDefaultLedgers(baseDirectory, paths) {
  if (!isDefaultBundle(baseDirectory, paths)) return false;
  const parent = resolve(baseDirectory, ".tokpulse");
  const parentState = await directoryState(parent);
  const target = join(parent, "data");
  if ((await directoryState(target)) === "nonempty") return false;
  const flatEntries = parentState === "missing" ? [] : await readdir(parent, {
    withFileTypes: true
  });
  const flatFiles = flatEntries.filter(entry => LEDGER_FILES.includes(entry.name) || entry.isFile() && /^\.history\.jsonl\.\d+\.\d+\.[^./]+\.tmp$/.test(entry.name)).map(entry => entry.name);
  const flat = flatFiles.length > 0;
  let legacy = parent;
  if (!flat) {
    if ((await directoryState(resolve(baseDirectory, ".opencode"))) === "missing") return false;
    legacy = resolve(baseDirectory, LEGACY_DIRECTORY);
    if ((await directoryState(legacy)) === "missing") return false;
  }
  let stage;
  const copied = [];
  try {
    for (const filename of flat ? flatFiles : LEDGER_FILES) {
      let source;
      try {
        // O_NOFOLLOW rejects a file symlink; NONBLOCK lets us reject FIFOs without hanging.
        source = await open(join(legacy, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      try {
        if (!(await source.stat()).isFile()) throw new Error(`Not a regular legacy ledger: ${filename}`);
        const bytes = await source.readFile();
        if (!stage) {
          await mkdir(parent, {
            recursive: true
          });
          stage = await mkdtemp(join(parent, ".migrate-"));
        }
        await writeFile(join(stage, filename), bytes, {
          flag: "wx"
        });
        copied.push(filename);
      } finally {
        await source.close();
      }
    }
    if (!stage) return false;
    try {
      await rename(stage, target);
    } catch (error) {
      const code = error?.code;
      if ((code === "EEXIST" || code === "ENOTEMPTY") && (await directoryState(target)) === "nonempty") return false;
      throw error;
    }
    stage = undefined;
    if (flat) for (const filename of copied) await rm(join(legacy, filename));
    return true;
  } finally {
    if (stage) await rm(stage, {
      recursive: true,
      force: true
    });
  }
}
