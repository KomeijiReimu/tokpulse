import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { isAbsolute, join } from "node:path";
import { DEFAULT_HISTORY_PATH } from "./storage-paths.js";
import { resolveRunsPath } from "./runs-storage.js";
import { resolveTotalsPath } from "./totals-storage.js";

/** Display-only binding. It never opens a writer or creates ledger files. */
export const sessionSourcePort = Symbol("token-pulse.session-source");
export type SessionSourceMetadata = { id: string; parentID: string; directory: string };
export interface SessionSourcePort {
  sync(id: string): Promise<void>;
  directories(id: string): Promise<readonly string[]>;
  children(id: string): Promise<readonly SessionSourceMetadata[]>;
  onChanged(receive: (id: string) => void): () => void;
  bind(directory: string | undefined): void;
}
export type SourceApi = TuiPluginApi & { [sessionSourcePort]?: SessionSourcePort };
export type TuiSourcePaths = { history: string; runs: string; totals: string };
export type TuiSourceState = {
  status: "waiting-metadata" | "loading" | "ready" | "missing" | "error";
  epoch: number;
  sessionID?: string;
  directory?: string;
  paths?: TuiSourcePaths;
  /** A successful read, including a valid empty ledger. Retained on same-source
   * missing/error results; a new source starts with no known measurements. */
  loaded?: Partial<Record<keyof TuiSourcePaths, boolean>>;
  missing?: string[];
  errors?: Partial<Record<keyof TuiSourcePaths | "metadata", string>>;
  live: boolean;
};

export function sessionSourceDirectory(api: TuiPluginApi, id: string): string | undefined {
  const entity = api.state.session.get(id) as unknown as { id?: string; directory?: string; location?: { directory?: string } } | undefined;
  if (entity?.id !== id) return undefined;
  const directory = entity.location?.directory ?? entity.directory;
  return typeof directory === "string" && isAbsolute(directory) ? directory : undefined;
}

export function sessionSourcePaths(directory: string, options: { historyPath?: string; runsPath?: string; totalsPath?: string }): TuiSourcePaths {
  const configured = options.historyPath?.trim() ? options.historyPath : DEFAULT_HISTORY_PATH;
  const history = isAbsolute(configured) ? configured : join(directory, configured);
  // Match server V2: session.location.directory, not its worktree/project root.
  return { history, runs: resolveRunsPath(history, options.runsPath),
    totals: resolveTotalsPath({ historyPath: history, totalsPath: options.totalsPath }) };
}
