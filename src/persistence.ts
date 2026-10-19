import type { ActivityEvent } from "./activity.js";
import type { HistoryRecord } from "./core.js";

export interface LedgerPaths {
  historyPath: string;
  totalsPath: string;
  runsPath: string;
}
export interface WriterLease {
  readonly paths: LedgerPaths;
  assertOwned(path: string): void;
  release(): Promise<void>;
}
export { prepareLedgerPaths, acquireWriterLease } from "./persistence-lease.js";
export { recoverHistoryFile } from "./storage.js";

export interface ActivityFlushReport {
  committed: readonly ActivityEvent[];
  pendingCount: number;
  degraded: boolean;
}
export interface ReliableActivityWriter {
  enqueue(events: readonly ActivityEvent[]): Promise<ActivityFlushReport>;
  flush(): Promise<ActivityFlushReport>;
  close(): Promise<ActivityFlushReport>;
}
export interface ReliableActivityWriterOptions {
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  lease?: WriterLease;
}
export interface UsageCommitReport { committed: boolean; pendingCount: number; }
export interface UsageCommitter {
  recover(): Promise<void>;
  upsert(record: HistoryRecord): Promise<UsageCommitReport>;
  retryPending(): Promise<{ pendingCount: number }>;
  close(): Promise<{ pendingCount: number }>;
}
export interface UsageCommitterOptions {
  maxPendingRecords?: number;
  retryBatchSize?: number;
}
export { createReliableActivityWriter, createUsageCommitter, PersistenceBackpressureError } from "./persistence-writers.js";
