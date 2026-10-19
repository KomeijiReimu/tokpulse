import { normalizeActivityEvent, type ActivityEvent } from "./activity.js";
import type { HistoryRecord } from "./core.js";
import type { ActivityLedgerAPI } from "./runs-storage.js";
import { mergeHistoryRecords, normalizeHistoryRecord, type HistoryStorage, type HistoryMutationSnapshot } from "./storage.js";
import { isCorruptTotalsError, type TotalsStorage } from "./totals-storage.js";
import type { ActivityFlushReport, ReliableActivityWriter, ReliableActivityWriterOptions, UsageCommitter, UsageCommitterOptions } from "./persistence.js";

export class PersistenceBackpressureError extends Error {
  readonly degraded = true;
  constructor(message: string) { super(message); this.name = "PersistenceBackpressureError"; }
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Persistence budget must be a positive safe integer");
  return value;
}

function serializer() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
}

export function createReliableActivityWriter(ledger: ActivityLedgerAPI, options: ReliableActivityWriterOptions = {}): ReliableActivityWriter {
  const maxEvents = positive(options.maxPendingEvents, 1024);
  const maxBytes = positive(options.maxPendingBytes, 4 * 1024 * 1024);
  const pending: { event: ActivityEvent; bytes: number }[] = [];
  const serialize = serializer();
  let reservedEvents = 0;
  let reservedBytes = 0;
  let closed = false;
  let rejected = false;
  const flush = async (): Promise<ActivityFlushReport> => {
    const committed: ActivityEvent[] = [];
    while (pending.length) {
      const head = pending[0]!;
      try {
        options.lease?.assertOwned(ledger.path);
        await ledger.append(head.event);
      } catch { break; }
      pending.shift();
      reservedEvents--;
      reservedBytes -= head.bytes;
      committed.push(head.event);
    }
    // A rejected observation is not secretly accepted when capacity recovers.
    // The caller must invalidate that observation epoch before collecting anew.
    return { committed, pendingCount: reservedEvents, degraded: rejected || reservedEvents > 0 };
  };
  return {
    enqueue(events) {
      if (closed) return Promise.reject(new Error("Activity writer is closed"));
      if (rejected && events.length) return Promise.reject(new PersistenceBackpressureError(
        "Activity observation continuity was lost; close this writer and establish a new observation epoch before resuming"));
      let entries: typeof pending;
      try {
        entries = events.map((input) => {
          const normalized = normalizeActivityEvent(input);
          if (!normalized) throw new TypeError("Invalid activity event");
          const text = JSON.stringify(normalized);
          return { event: JSON.parse(text) as ActivityEvent, bytes: Buffer.byteLength(text) };
        });
      } catch (error) { return Promise.reject(error); }
      const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      if (reservedEvents + entries.length > maxEvents || reservedBytes + bytes > maxBytes) {
        rejected = true;
        return Promise.reject(new PersistenceBackpressureError("Activity pending budget exhausted; observation continuity must be reset"));
      }
      reservedEvents += entries.length;
      reservedBytes += bytes;
      return serialize(async () => { pending.push(...entries); return flush(); });
    },
    flush: () => serialize(flush),
    close() { closed = true; return serialize(flush); },
  };
}

/** History is the existing crash-recovery source, not an extra usage journal.
 * Only unresolved identities (and bounded, not-yet-durable snapshots) are kept.
 * A fulfilled totals.apply is the confirmation: it applies the canonical
 * history contribution or preserves a dominating revision/exclusion, rather
 * than guessing confirmation from the presence of a message ID.
 */
export function createUsageCommitter(history: HistoryStorage, totals: TotalsStorage, options: UsageCommitterOptions = {}): UsageCommitter {
  const budget = positive(options.maxPendingRecords, 128);
  const batchSize = positive(options.retryBatchSize, 32);
  const serialize = serializer();
  const pending = new Set<string>();
  const notDurable = new Map<string, HistoryRecord>();
  let closed = false;
  let queuedSnapshots = 0;
  let pruneDirty = false;

  const snapshot = async (input?: HistoryRecord[]): Promise<HistoryMutationSnapshot> => {
    const records = input ?? await history.readAll();
    return { records, retainedMessageIDs: new Set((history.maxRecords === undefined ? await history.read() : records.slice(-history.maxRecords))
      .map((record) => record.messageID)) };
  };
  const persist = async (id: string): Promise<HistoryMutationSnapshot | undefined> => {
    const observation = notDurable.get(id);
    if (!observation) return undefined;
    const state = history.upsertWithSnapshot
      ? await history.upsertWithSnapshot(observation, { protectedMessageIDs: pending })
      : await history.upsert(observation, { protectedMessageIDs: pending }).then(() => snapshot());
    notDurable.delete(id);
    return state;
  };
  const prune = async () => {
    if (!pruneDirty) return;
    await history.prune({ protectedMessageIDs: pending });
    pruneDirty = false;
  };
  const confirm = (records: readonly HistoryRecord[], state: HistoryMutationSnapshot) => {
    for (const record of records) {
      pending.delete(record.messageID);
      if (!state.retainedMessageIDs.has(record.messageID)) pruneDirty = true;
    }
  };
  const batch = async (ids: readonly string[], initial?: HistoryMutationSnapshot): Promise<void> => {
    if (!ids.length) return;
    let state = initial;
    for (const id of ids) {
      try { state = await persist(id) ?? state; }
      catch (error) { if (isCorruptTotalsError(error)) throw error; }
    }
    state ??= await snapshot();
    const byID = new Map(state.records.map((record) => [record.messageID, record]));
    const records = ids.filter((id) => !notDurable.has(id)).map((id) => byID.get(id)).filter((record): record is HistoryRecord => !!record);
    if (!records.length) return;
    try {
      // One atomic totals publication confirms the entire canonical batch.
      // On uncertain failure NONE of these protections are removed; replay
      // uses the same quality/revision/exclusion semantics as direct apply.
      await totals.applyMany(records, { retainedMessageIDs: state.retainedMessageIDs });
      confirm(records, state);
    } catch (error) {
      if (isCorruptTotalsError(error)) throw error;
      for (const id of ids) if (pending.delete(id)) pending.add(id);
    }
  };
  const retry = async (skip?: string, state?: HistoryMutationSnapshot) => {
    const candidates: string[] = [];
    for (const id of pending) if (id !== skip) {
      candidates.push(id); if (candidates.length >= batchSize) break;
    }
    if (candidates.length) await batch(candidates, state);
    await prune();
    return { pendingCount: pending.size };
  };

  return {
    recover: () => serialize(async () => {
      if (closed) throw new Error("Usage committer is closed");
      const records = await history.readAll();
      for (const record of records) pending.add(record.messageID);
      // Complete recovery is one reconciliation transaction, not N ledger
      // loads/serializations. Empty startup still initializes/migrates totals.
      if (records.length) await batch(records.map((record) => record.messageID), await snapshot(records));
      else await totals.seed([]);
      await prune();
    }),
    upsert(input) {
      if (closed) return Promise.reject(new Error("Usage committer is closed"));
      if (queuedSnapshots >= budget) return Promise.reject(new PersistenceBackpressureError("Usage admission queue exhausted"));
      const normalized = normalizeHistoryRecord(input);
      if (!normalized) return Promise.reject(new TypeError("Invalid history record"));
      const snapshot = JSON.parse(JSON.stringify(normalized)) as HistoryRecord;
      queuedSnapshots++;
      return serialize(async () => {
        if (!pending.has(snapshot.messageID) && pending.size >= budget) {
          throw new PersistenceBackpressureError("Usage pending budget exhausted; durable pending facts remain protected");
        }
        pending.add(snapshot.messageID);
        const prior = notDurable.get(snapshot.messageID);
        notDurable.set(snapshot.messageID, prior ? mergeHistoryRecords([prior], [snapshot])[0]! : snapshot);
        let committed = false;
        let state: HistoryMutationSnapshot | undefined;
        try {
          state = await persist(snapshot.messageID);
          const canonical = state?.records.find((record) => record.messageID === snapshot.messageID);
          if (canonical && state) {
            await totals.apply(canonical, { retainedMessageIDs: state.retainedMessageIDs });
            confirm([canonical], state);
            committed = true;
          }
        } catch (error) { if (isCorruptTotalsError(error)) throw error; }
        // Other sessions' healthy control traffic drives bounded global retry.
        // Do not immediately retry this call's own just-failed operation.
        try { await retry(snapshot.messageID, state); } catch { /* pending remains protected */ }
        return { committed, pendingCount: pending.size };
      }).finally(() => { queuedSnapshots--; });
    },
    retryPending: () => serialize(() => retry()),
    close() { closed = true; return serialize(async () => {
      // A single shutdown flush considers all existing pending identities;
      // it does not loop indefinitely on an unwritable disk.
      if (pending.size) await batch([...pending]);
      try { await prune(); } catch {}
      return { pendingCount: pending.size };
    }); },
  };
}
