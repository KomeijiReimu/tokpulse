import { isAbsolute } from "node:path";
import { readOnlyHistoryPath } from "./storage-paths.js";
import { resolveRunsPath } from "./runs-storage.js";
import { resolveTotalsPath } from "./totals-storage.js";

/** Display-only binding. It never opens a writer or creates ledger files. */
export const sessionSourcePort = Symbol("token-pulse.session-source");
export function sessionSourceDirectory(api, id) {
  const entity = api.state.session.get(id);
  if (entity?.id !== id) return undefined;
  const directory = entity.location?.directory ?? entity.directory;
  return typeof directory === "string" && isAbsolute(directory) ? directory : undefined;
}
export function sessionSourcePaths(directory, options) {
  const history = readOnlyHistoryPath(directory, options.historyPath);
  // Match server V2: session.location.directory, not its worktree/project root.
  return {
    history,
    runs: resolveRunsPath(history, options.runsPath),
    totals: resolveTotalsPath({
      historyPath: history,
      totalsPath: options.totalsPath
    })
  };
}
