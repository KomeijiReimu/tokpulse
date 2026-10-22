/** Private display-only state. No runtime import back into tui; no interval math. */
import type { RuntimeStore } from "./tui.js";
import { createActivityProjector, activityProjectionDiagnostics, compareActivityEvents, type ActivityEvent, type ActivityProjector, type ActivityStreamKey, type ActivityStreamUpdate } from "./activity.js";
import type { ActivityReadCursor } from "./runs-storage.js";
import type { HistoryRecord, TokenCounts } from "./core.js";
import type { SpeedContribution } from "./statistics.js";
import { coerceSpeedTotals, updateSpeedTotals } from "./statistics.js";
import { mergeScopeEvidence, type CompactScopeEvidence } from "./scope.js";
import { projectTotalsGenerationBasis, type TotalsLedger, type OpenContribution, type SessionDirectTotals } from "./totals-storage.js";
import { createTotalsRollupIndex, totalsRollupIndexDiagnostics, type TotalsRollupIndex } from "./totals-aggregate.js";

export const parentProofPort = Symbol("token-pulse.parent-proof");
export type ParentProofOutcome = { status: "success"; parent: string | null } | { status: "error" } | { status: "stale" };
export type ParentProofWake = { kind: "capacity" } | { kind: "healthy"; serial: number };
export interface ParentProofPort {
  epoch(): number;
  request(id: string, version: number, receive: (outcome: ParentProofOutcome, version: number) => void, options?: { notBefore?: number }): boolean;
  available(receive: (event: ParentProofWake) => void): () => void;
}
type Parent = string | null;
export type DisplayContribution = { sessionID: string; tokens: TokenCounts; cost: number; speed?: SpeedContribution };
export type DisplayTerm = { contribution: DisplayContribution; sign: 1 | -1 };
export class RevisionMap<Key, Value> extends Map<Key, Value> {
  readonly changes = new Set<Key>();
  override set(key: Key, value: Value): this { if (!this.has(key) || this.get(key) !== value) this.changes.add(key); return super.set(key, value); }
  override delete(key: Key): boolean { const deleted = super.delete(key); if (deleted) this.changes.add(key); return deleted; }
  override clear(): void { for (const key of this.keys()) this.changes.add(key); super.clear(); }
  discard(): void { super.clear(); this.changes.clear(); }
}
type Witness = { parent: Parent; origin: "canonical" | "live" | "cache"; identity?: string;
  sourceEpoch?: string; sourceSequence?: number; entityRevision?: number; proofEpoch?: number; proofBinding?: number; targetVersion?: number };
type ParentEntry = { canonical?: Witness; live?: Witness; cache?: Witness; fresh?: Witness; version: number; conflict: boolean;
  liveConflict?: Witness; revalidate?: boolean; job?: symbol; requestedEpoch?: number; requestedVersion?: number;
  parkedVersion?: number; failedAt?: number; parkedSerial?: number; notBefore?: number; rejectedVersion?: number; rejectedSerial?: number };
const own = <T>(value: Readonly<Record<string, T>> | undefined, id: string): T | undefined =>
  value && Object.prototype.hasOwnProperty.call(value, id) ? value[id] : undefined;

/** Versioned mutable map, not an immutable-reference heuristic. All mutation paths
 * (including mechanical fixtures) invalidate only descendants of changed keys. */
class ParentMap extends Map<string, string | null> {
  constructor(private changed: (id: string, old: string | null | undefined, next: string | null | undefined) => void) { super(); }
  override set(id: string, value: string | null): this {
    const had = this.has(id), previous = this.get(id);
    super.set(id, value); if (!had || previous !== value) this.changed(id, previous, value); return this;
  }
  override delete(id: string): boolean { const previous = this.get(id); const removed = super.delete(id); if (removed) this.changed(id, previous, undefined); return removed; }
  override clear(): void { for (const id of [...this.keys()]) this.delete(id); }
  discard(): void { super.clear(); }
}

export class TuiReadModel {
  readonly counters = { parentVisits: 0, parentPublications: 0, parentGraphCopies: 0, parentPatchEntries: 0, rootVisits: 0, proofCandidateVisits: 0,
    canonicalContributionVisits: 0, deductionUpdates: 0, dictionaryEntriesCopied: 0, ledgerBuilds: 0,
    visibleBuilds: 0, visibleSessionCopies: 0, visibleRecordVisits: 0, rowDerivations: 0, rowRecordVisits: 0 };
  readonly parents: ParentMap;
  readonly scopes: Record<string, CompactScopeEvidence> = Object.create(null);
  readonly parentChanges = new Map<string, string | null | undefined>();
  readonly scopeChanges = new Map<string, CompactScopeEvidence | undefined>();
  readonly conflicts = new Map<string, ParentEntry>();
  readonly ancestryChecked = new Set<string>();
  parentVersion = 0; scopeVersion = 0; totalsVersion = 0;
  private witnesses = new Map<string, ParentEntry>();
  private children = new Map<string, Set<string>>();
  private roots = new Map<string, string>();
  private eligibility = new Map<string, boolean>();
  private canonicalScopes?: TotalsLedger["sessionScopes"];
  private registry?: RuntimeStore["sourceScopes"];
  private registryRevision = -1;
  private ledger?: TotalsLedger;
  private basis?: TotalsLedger;
  private contributions = new Map<string, OpenContribution | true>();
  private canonicalExcluded = new Set<string>();
  private deductions = new Map<string, OpenContribution>();
  private deducted = new Map<string, SessionDirectTotals>();
  private overlayTerms = new Map<string, DisplayTerm[]>();
  private overlaySources = new Map<string, { record: HistoryRecord; excluded: boolean }>();
  private overlayTotals = new Map<string, SessionDirectTotals>();
  private dirtyResponses = new Set<string>();
  private window = new Map<string, HistoryRecord>();
  private optimistic?: RuntimeStore["optimistic"];
  private dirty = true;
  private index?: TotalsRollupIndex;
  private rollupPrevious: Record<string, number> = {};
  private indexParent = -1; private indexScope = -1;
  private indexRecords?: readonly HistoryRecord[];
  private port?: ParentProofPort;
  private portEpoch = -1;
  private binding = 0;
  private disposed = false;
  private healthSerial = 0;
  private capacitySerial = 0;
  private blockedSerial = -1;
  private parked = new Map<string, ParentEntry>();
  private stopPort?: () => void;
  private proofIterator?: MapIterator<[string, ParentEntry]>;
  private blockedProof?: [string, ParentEntry];
  private proofScanNeeded = false;
  private fillingProofs = false;
  private batchDepth = 0;
  private invalidRoots = new Set<string>();
  private invalidScopes = new Set<string>();
  constructor(readonly store: RuntimeStore) {
    this.parents = new ParentMap((id, previous, next) => {
      if (previous) this.children.get(previous)?.delete(id);
      if (next) { let children = this.children.get(next); if (!children) this.children.set(next, children = new Set()); children.add(id); }
      this.parentChanges.set(id, next); this.dirty = true;
      if (this.batchDepth) this.invalidRoots.add(id);
      else { this.parentVersion++; this.invalidate(id); }
    });
    this.adoptParents();
  }
  adoptParents(): void {
    if (this.store.sessionParents === this.parents) return;
    const input = this.store.sessionParents;
    this.batchDepth++;
    for (const [id, parent] of input) { this.counters.parentVisits++; this.observeParent(id, { parent: parent ?? null, origin: "cache" }); }
    this.batchDepth--; this.publishParents();
    this.store.sessionParents = this.parents;
  }
  bindProof(port?: ParentProofPort): void {
    if (this.disposed || this.store.disposed) return;
    const changed = !!port && port !== this.port;
    if (changed) {
      this.stopPort?.(); this.port = port; this.binding++; this.healthSerial = 0; this.capacitySerial++;
      const bound = this.port!, binding = this.binding;
      this.stopPort = bound.available((event) => {
        if (this.disposed || this.store.disposed || this.port !== bound || this.binding !== binding) return;
        this.capacitySerial++;
        if (event.kind === "healthy" && event.serial > this.healthSerial) {
          this.healthSerial = event.serial;
          let armed = false;
          for (const [id, entry] of this.parked) if ((entry.parkedSerial ?? 0) < event.serial) {
            entry.notBefore = Math.max(performance.now(), (entry.failedAt ?? 0) + 1000);
            entry.parkedVersion = undefined; this.parked.delete(id); armed = true;
            // Move only the retry opportunity behind untouched targets. The
            // evidence object/version is retained; this is queue order, not LRU.
            if (this.conflicts.has(id)) { this.conflicts.delete(id); this.conflicts.set(id, entry); }
          }
          if (armed) this.proofScanNeeded = true;
        }
        this.bindProof();
      });
    }
    if (!this.port) return;
    if (changed || this.portEpoch !== this.port.epoch()) {
      this.capacitySerial++;
      this.portEpoch = this.port.epoch();
      for (const [id, entry] of this.witnesses) {
        entry.job = undefined; entry.requestedVersion = undefined; entry.requestedEpoch = undefined;
        entry.parkedVersion = undefined; entry.notBefore = undefined;
        if (entry.fresh) { entry.fresh = undefined; entry.revalidate = true; this.resolve(id, entry); }
      }
      this.parked.clear();
      this.proofIterator = undefined; this.blockedProof = undefined; this.proofScanNeeded = true;
    }
    this.fillProofs();
  }
  private request(id: string, entry: ParentEntry): boolean {
    if (!this.port || this.disposed || this.store.disposed) { this.proofScanNeeded = true; return false; }
    if (entry.parkedVersion === entry.version) return true;
    if (entry.rejectedVersion === entry.version && entry.rejectedSerial === this.capacitySerial) return false;
    if (entry.job && entry.requestedVersion === entry.version && entry.requestedEpoch === this.portEpoch) return true;
    const epoch = this.portEpoch, port = this.port, binding = this.binding, token = Symbol();
    entry.job = token; entry.requestedVersion = entry.version; entry.requestedEpoch = epoch;
    const admitted = port.request(id, entry.version, (outcome, version) => {
      const current = this.witnesses.get(id);
      if (this.disposed || this.store.disposed || this.port !== port || binding !== this.binding || current !== entry
        || current.version !== version || !current.conflict || current.job !== token || epoch !== this.portEpoch || port.epoch() !== epoch) return;
      current.job = undefined; current.requestedVersion = undefined; current.requestedEpoch = undefined;
      if (outcome.status !== "success") {
        if (outcome.status === "error") {
          current.parkedVersion = version; current.failedAt = performance.now(); current.parkedSerial = this.healthSerial;
          this.parked.set(id, current);
        } else this.proofScanNeeded = true;
        return;
      }
      this.parked.delete(id); current.parkedVersion = undefined; current.notBefore = undefined;
      current.revalidate = false;
      // Preserve the real control witness, never turn a fresh lookup into live.
      if (current.liveConflict) current.live = current.liveConflict;
      current.liveConflict = undefined;
      current.fresh = { parent: outcome.parent, origin: "live", proofEpoch: this.portEpoch, proofBinding: this.binding, targetVersion: version };
      this.resolve(id, current); this.store.bump();
    }, entry.notBefore === undefined ? undefined : { notBefore: entry.notBefore });
    if (!admitted && entry.job === token) { entry.job = undefined; entry.requestedVersion = undefined; entry.requestedEpoch = undefined;
      entry.rejectedVersion = entry.version; entry.rejectedSerial = this.capacitySerial; this.proofScanNeeded = true; }
    return admitted;
  }
  private fillProofs(): void {
    if (!this.port || this.store.disposed || this.fillingProofs || !this.conflicts.size
      || (!this.proofIterator && !this.blockedProof && !this.proofScanNeeded)) return;
    if (this.blockedProof && this.blockedSerial === this.capacitySerial) return;
    this.fillingProofs = true;
    try {
      this.proofIterator ??= this.conflicts.entries();
      while (true) {
        const next = this.blockedProof ?? this.proofIterator.next().value; this.blockedProof = undefined;
        if (!next) { this.proofIterator = undefined; this.proofScanNeeded = false; break; }
        this.counters.proofCandidateVisits++;
        const [id, entry] = next;
        if (!entry.conflict || this.conflicts.get(id) !== entry) continue;
        if (!this.request(id, entry)) { this.blockedProof = next; this.blockedSerial = this.capacitySerial; break; }
      }
    } finally { this.fillingProofs = false; }
  }
  observeParent(id: string, witness: Witness): boolean {
    if (this.disposed || this.store.disposed) return false;
    const entry = this.witnesses.get(id) ?? { version: 0, conflict: false };
    const previous = entry[witness.origin];
    if (witness.origin === "cache" && (entry.canonical || entry.live)) { entry.cache = witness; return false; }
    if (witness.origin === "live" && previous) {
      const comparable = witness.sourceEpoch && witness.sourceEpoch === previous.sourceEpoch
        && witness.sourceSequence !== undefined && previous.sourceSequence !== undefined;
      if (comparable && witness.sourceSequence! < previous.sourceSequence!) return false;
      if (comparable && witness.sourceSequence === previous.sourceSequence && witness.parent === previous.parent) return false;
      if ((!comparable || witness.sourceSequence === previous.sourceSequence) && witness.parent !== previous.parent) {
        if (entry.liveConflict?.parent === witness.parent && entry.liveConflict.sourceEpoch === witness.sourceEpoch
          && entry.liveConflict.sourceSequence === witness.sourceSequence) return false;
        entry.liveConflict = witness; entry.version++; entry.parkedVersion = undefined; entry.notBefore = undefined; this.parked.delete(id);
        this.witnesses.set(id, entry); return this.resolve(id, entry);
      }
      entry.liveConflict = undefined;
    }
    if (previous && previous.parent === witness.parent && previous.identity === witness.identity
      && previous.sourceEpoch === witness.sourceEpoch && previous.sourceSequence === witness.sourceSequence) return false;
    entry[witness.origin] = witness;
    // A lower-trust cache refresh is not a new target parent fact and cannot
    // invalidate a query already proving canonical/live disagreement.
    if (witness.origin === "cache" && (entry.canonical || entry.live || entry.fresh)) { this.witnesses.set(id, entry); return false; }
    entry.version++; entry.parkedVersion = undefined; entry.notBefore = undefined; this.parked.delete(id);
    this.witnesses.set(id, entry); return this.resolve(id, entry);
  }
  private resolve(id: string, entry: ParentEntry): boolean {
    const { canonical, live, cache } = entry;
    let winner = canonical ?? live ?? cache;
    entry.conflict = false;
    if (canonical && live) {
      if (canonical.parent === live.parent) { entry.live = undefined; winner = canonical; }
      else if (canonical.sourceEpoch && canonical.sourceEpoch === live.sourceEpoch
        && canonical.sourceSequence !== undefined && live.sourceSequence !== undefined) {
        winner = live.sourceSequence > canonical.sourceSequence ? live : canonical;
      } else {
        entry.conflict = true;
        // Arrival order cannot establish remote causality. Keep the existing
        // interpretation provisional until a fenced fresh entity proves it.
        winner = this.parents.has(id) ? { parent: this.parents.get(id)!, origin: "cache" } : canonical;
      }
    }
    if (entry.liveConflict || entry.revalidate) {
      entry.conflict = true;
      winner = this.parents.has(id) ? { parent: this.parents.get(id)!, origin: "cache" } : winner;
    }
    if (entry.fresh?.proofEpoch === this.portEpoch && entry.fresh.proofBinding === this.binding) {
      if (entry.fresh.targetVersion === entry.version) { winner = entry.fresh; entry.conflict = false; }
      else if (canonical?.parent === entry.fresh.parent) { winner = canonical; entry.live = undefined; entry.fresh = undefined; entry.conflict = false; }
      else {
        // Preserve the last fresh witness as evidence, not as an unfenced new
        // proof. A later incomparable disk snapshot cannot erase it and make
        // two older agreeing observations appear authoritative.
        entry.conflict = true;
        winner = this.parents.has(id) ? { parent: this.parents.get(id)!, origin: "cache" } : entry.fresh;
      }
    }
    if (entry.conflict) { this.conflicts.set(id, entry); this.request(id, entry); } else this.conflicts.delete(id);
    if (this.disposed || this.store.disposed) return false;
    // A legal synchronous success can resolve recursively inside request().
    if (!entry.conflict && entry.fresh?.targetVersion === entry.version && entry.fresh.proofEpoch === this.portEpoch && entry.fresh.proofBinding === this.binding) winner = entry.fresh;
    const before = this.parents.get(id), had = this.parents.has(id);
    if (winner) this.parents.set(id, winner.parent); else this.parents.delete(id);
    return had !== this.parents.has(id) || before !== this.parents.get(id);
  }
  // Retain only normalized-control signatures, not event objects. A replayed
  // old fact is not a new parent observation, even in a later reader batch.
  // Full semantics (rather than an ID or parent value) preserve corrections.
  private readonly canonicalParentFacts = new Set<string>();
  canonicalParents(events: readonly ActivityEvent[], reset: boolean): void {
    if (this.disposed || this.store.disposed) return;
    this.batchDepth++;
    if (reset) {
      this.canonicalParentFacts.clear();
      for (const [id, entry] of this.witnesses) if (entry.canonical) {
        entry.canonical = undefined; entry.version++; this.resolve(id, entry);
      }
    }
    for (const fact of events) if (fact.kind === "parent" || typeof fact.parentSessionID === "string") {
      const signature = canonicalFactSignature(fact);
      if (this.canonicalParentFacts.has(signature)) continue;
      this.canonicalParentFacts.add(signature);
      this.counters.parentVisits++;
      this.observeParent(fact.sessionID, { parent: fact.parentSessionID || null, origin: "canonical",
        identity: fact.sourceEventID ?? fact.eventID, sourceEpoch: fact.instanceID, sourceSequence: fact.sourceSequence });
    }
    this.batchDepth--;
    this.publishParents();
  }
  historyParents(records: readonly HistoryRecord[]): void {
    this.batchDepth++;
    for (const record of records) {
      this.counters.visibleRecordVisits++;
      if (record.parentSessionID && !this.parents.has(record.sessionID)) this.observeParent(record.sessionID, { parent: record.parentSessionID, origin: "cache" });
    }
    this.batchDepth--; this.publishParents();
  }
  private publishParents(): void {
    if (!this.batchDepth && (this.invalidRoots.size || this.invalidScopes.size)) {
      if (this.invalidRoots.size) { this.parentVersion++; this.counters.parentPublications++; }
      this.invalidateMany([...this.invalidRoots, ...this.invalidScopes]); this.invalidRoots.clear(); this.invalidScopes.clear();
    }
  }
  /** Metadata dependency order only, never event/time order. Root-first cold
   * context avoids repeatedly invalidating the growing same descendant chain.
   * A cycle closes once; each requested parent key is visited/copied once. */
  orderedParents(input: ReadonlyMap<string, string | null | undefined> = this.parents): Map<string, string | null | undefined> {
    if (input === this.parents && input.size) this.counters.parentGraphCopies++;
    const result = new Map<string, string | null | undefined>(), state = new Map<string, number>();
    for (const id of input.keys()) {
      if (state.get(id) === 2) continue;
      const stack: Array<[string, boolean]> = [[id, false]];
      while (stack.length) {
        const [key, exit] = stack.pop()!;
        if (exit) { if (!result.has(key)) { result.set(key, input.get(key)); this.counters.parentPatchEntries++; } state.set(key, 2); continue; }
        if (state.has(key)) continue;
        state.set(key, 1); stack.push([key, true]);
        const parent = input.get(key); if (parent && input.has(parent) && !state.has(parent)) stack.push([parent, false]);
      }
    }
    return result;
  }
  private invalidate(id: string): void { this.invalidateMany([id]); }
  visitAffected(ids: Iterable<string>, visit: (id: string) => void): void {
    const pending = [...ids], seen = new Set<string>();
    while (pending.length) { const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id); this.counters.parentVisits++; visit(id); for (const child of this.children.get(id) ?? []) pending.push(child); }
  }
  private invalidateMany(ids: Iterable<string>): void {
    const pending = [...ids], seen = new Set<string>();
    while (pending.length) { const current = pending.pop()!; if (seen.has(current)) continue; seen.add(current);
      this.roots.delete(current); this.eligibility.delete(current); this.ancestryChecked.delete(current); this.counters.parentVisits++;
      for (const child of this.children.get(current) ?? []) pending.push(child);
    }
  }
  root(id: string): string {
    if (this.disposed || this.store.disposed) return id;
    this.bindProof();
    this.adoptParents();
    if (this.roots.has(id)) return this.roots.get(id)!;
    const path: string[] = [], positions = new Map<string, number>(); let current = id, root: string;
    while (true) {
      this.counters.rootVisits++;
      if (this.roots.has(current)) { root = this.roots.get(current)!; break; }
      const cycle = positions.get(current);
      if (cycle !== undefined) { root = path.slice(cycle).sort((a, b) => a.localeCompare(b))[0]; break; }
      positions.set(current, path.length); path.push(current);
      const parent = this.parents.get(current);
      if (!parent || parent === current) { root = current; break; }
      current = parent;
    }
    for (const node of path) this.roots.set(node, root);
    return root;
  }
  syncScopes(target?: string): void {
    if (this.disposed || this.store.disposed) return;
    this.adoptParents();
    if (this.canonicalScopes !== this.store.totalsLedger.sessionScopes) {
      this.batchDepth++;
      this.canonicalScopes = this.store.totalsLedger.sessionScopes;
      const old = new Set(Object.keys(this.scopes));
      for (const id of Object.keys(this.canonicalScopes ?? {})) old.add(id);
      for (const [id] of Object.entries(this.store.sourceScopes.serialize())) old.add(id);
      for (const id of old) this.setScope(id);
      this.registry = this.store.sourceScopes; this.registryRevision = this.registry.revision;
      this.batchDepth--; this.publishParents(); return;
    }
    if (target) { this.setScope(target); this.registry = this.store.sourceScopes; this.registryRevision = this.registry.revision; return; }
    if (this.registry !== this.store.sourceScopes || this.registryRevision !== this.store.sourceScopes.revision) {
      this.batchDepth++;
      for (const id of new Set([...Object.keys(this.scopes), ...Object.keys(this.store.sourceScopes.serialize())])) this.setScope(id);
      this.registry = this.store.sourceScopes; this.registryRevision = this.registry.revision;
      this.batchDepth--; this.publishParents();
    }
  }
  private setScope(id: string): void {
    const next = mergeScopeEvidence(own(this.canonicalScopes, id), this.store.sourceScopes.getPersistentEvidence(id)
      ?? own(this.canonicalScopes, id) ?? { version: 1, sourceScope: "pending", reasons: [] });
    const previous = own(this.scopes, id);
    if (next.parentSessionID) this.observeParent(id, { parent: next.parentSessionID, origin: "cache" });
    if (!previous && next.sourceScope === "pending" && !next.parentSessionID) return;
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    this.scopes[id] = next;
    if ((previous?.sourceScope === "magic-session") !== (next.sourceScope === "magic-session")) {
      this.scopeChanges.set(id, next); this.scopeVersion++; this.dirty = true; this.invalidScopes.add(id); this.publishParents();
    }
  }
  eligible(id: string): boolean {
    if (this.disposed || this.store.disposed) return false;
    this.bindProof();
    this.syncScopes();
    if (this.eligibility.has(id)) return this.eligibility.get(id)!;
    const path: string[] = [], seen = new Set<string>(); let current: string | undefined = id, eligible = true;
    while (current) {
      if (this.eligibility.has(current)) { eligible = this.eligibility.get(current)!; break; }
      if (seen.has(current)) break;
      seen.add(current); path.push(current); this.counters.parentVisits++;
      if (own(this.scopes, current)?.sourceScope === "magic-session") { eligible = false; break; }
      current = this.parents.has(current) ? this.parents.get(current) ?? undefined : own(this.scopes, current)?.parentSessionID;
    }
    for (const node of path) this.eligibility.set(node, eligible);
    return eligible;
  }
  private ensureLedger(): void {
    if (this.ledger === this.store.totalsLedger) return;
    this.ledger = this.store.totalsLedger; this.basis = projectTotalsGenerationBasis(this.ledger);
    this.counters.ledgerBuilds++; this.contributions.clear(); this.canonicalExcluded.clear(); this.deductions.clear(); this.deducted.clear();
    for (const table of [this.basis.settled, this.basis.open]) for (const [id, contribution] of Object.entries(table)) {
      this.counters.canonicalContributionVisits++; this.counters.dictionaryEntriesCopied++;
      this.contributions.set(id, contribution);
      if (contribution !== true && contribution.excluded) this.canonicalExcluded.add(id);
    }
    for (const id of Object.keys(this.basis.messageScopes ?? {})) this.canonicalExcluded.add(id);
    this.counters.dictionaryEntriesCopied += Object.keys(this.basis.sessions).length + Object.keys(this.basis.sessionScopes ?? {}).length
      + Object.keys(this.basis.messageScopes ?? {}).length + Object.keys(this.basis.sessionAgents ?? {}).length;
    this.overlayTerms.clear(); this.overlaySources.clear(); this.overlayTotals.clear();
    for (const id of this.store.optimistic.keys()) this.dirtyResponses.add(id);
    for (const id of this.window.keys()) this.dirtyResponses.add(id);
    for (const id of this.store.messageScopes.keys()) this.applyProof(id);
    this.dirty = true;
  }
  excluded(id: string): boolean { this.ensureLedger(); return this.canonicalExcluded.has(id) || this.store.messageScopes.has(id); }
  noteProof(id: string): void { this.ensureLedger(); this.applyProof(id); this.dirtyResponses.add(id); }
  private applyProof(id: string): void {
    const contribution = this.contributions.get(id);
    const next = !this.canonicalExcluded.has(id) && contribution && contribution !== true && this.store.messageScopes.has(id) ? contribution : undefined;
    const previous = this.deductions.get(id);
    if (previous === next) return;
    if (previous) this.accumulate(previous, -1);
    if (next) { this.accumulate(next, 1); this.deductions.set(id, next); } else this.deductions.delete(id);
    this.counters.deductionUpdates++; this.dirty = true;
  }
  private accumulate(contribution: OpenContribution, sign: 1 | -1): void {
    this.accumulateInto(this.deducted, contribution, sign);
  }
  private accumulateInto(target: Map<string, SessionDirectTotals>, contribution: DisplayContribution, sign: 1 | -1): void {
    let direct = target.get(contribution.sessionID);
    if (!direct) { direct = zero(); target.set(contribution.sessionID, direct); }
    for (const key of tokenFields) direct.tokens[key] += sign * contribution.tokens[key];
    direct.responseCount += sign; direct.cost += sign * contribution.cost;
    const speed = contribution.speed ? updateSpeedTotals(undefined, contribution.speed, 1) : undefined;
    if (speed) {
      direct.speed ??= zeroSpeed();
      // Start at zero; aggregate signed correction amounts without clamping an
      // intermediate negative delta (clamp only the final display projection).
      for (const kind of ["generation", "response"] as const) for (const field of speedFields) (direct.speed[kind] as any)[field] += sign * ((speed[kind] as any)[field] ?? 0);
    }
  }
  filter(records: readonly HistoryRecord[]): HistoryRecord[] {
    this.ensureLedger(); this.syncScopes();
    return records.filter((record) => !this.excluded(record.messageID) && record.scope?.sourceScope !== "magic-message"
      && record.scope?.sourceScope !== "magic-session" && this.eligible(record.sessionID)
      && (this.parents.has(record.sessionID) || !record.parentSessionID || this.eligible(record.parentSessionID)));
  }
  /** One visible projection per actual ledger/parent/scope/overlay revision. */
  totals(records: readonly HistoryRecord[], overlayVersion: object,
    recipe: (ledger: TotalsLedger, record: HistoryRecord) => DisplayTerm[]): TotalsRollupIndex {
    this.ensureLedger(); this.syncScopes();
    if (this.optimistic !== this.store.optimistic) {
      for (const id of this.overlayTerms.keys()) this.dirtyResponses.add(id);
      for (const id of this.store.optimistic.keys()) this.dirtyResponses.add(id);
      this.optimistic = this.store.optimistic;
    }
    if (this.store.optimistic instanceof RevisionMap) { for (const id of this.store.optimistic.changes) this.dirtyResponses.add(id); this.store.optimistic.changes.clear(); }
    if (this.indexRecords !== records) {
      const next = new Map<string, HistoryRecord>();
      for (const record of records) { this.counters.visibleRecordVisits++; next.set(record.messageID, record); if (this.window.get(record.messageID) !== record) this.dirtyResponses.add(record.messageID); }
      for (const id of this.window.keys()) if (!next.has(id)) this.dirtyResponses.add(id);
      this.window = next; this.indexRecords = records;
    }
    for (const id of this.dirtyResponses) {
      const record = this.store.optimistic.get(id) ?? this.window.get(id);
      const excluded = this.excluded(id) || record?.scope?.sourceScope === "magic-message";
      const previous = this.overlaySources.get(id), previousTerms = this.overlayTerms.get(id) ?? [];
      if (previous?.record === record && previous?.excluded === excluded) continue;
      if (!record && !previousTerms.length) { this.overlaySources.delete(id); continue; }
      for (const term of previousTerms) this.accumulateInto(this.overlayTotals, term.contribution, -term.sign as 1 | -1);
      const terms = record && !excluded ? recipe(this.basis!, record) : [];
      for (const term of terms) this.accumulateInto(this.overlayTotals, term.contribution, term.sign);
      if (terms.length) this.overlayTerms.set(id, terms); else this.overlayTerms.delete(id);
      if (record) this.overlaySources.set(id, { record, excluded }); else this.overlaySources.delete(id);
      if (terms.length || previousTerms.length) this.dirty = true;
    }
    this.dirtyResponses.clear();
    if (!this.index || this.dirty || this.indexParent !== this.parentVersion || this.indexScope !== this.scopeVersion) {
      const sessions: Record<string, SessionDirectTotals> = Object.create(null);
      for (const [id, source] of Object.entries(this.basis!.sessions)) sessions[id] = { ...source, tokens: { ...source.tokens }, speed: coerceSpeedTotals(source.speed) };
      for (const [adjustments, sign] of [[this.overlayTotals, 1], [this.deducted, -1]] as const) for (const [id, adjustment] of adjustments) {
        const direct = sessions[id] ??= zero();
        for (const key of tokenFields) direct.tokens[key] += sign * adjustment.tokens[key];
        direct.responseCount += sign * adjustment.responseCount; direct.cost += sign * adjustment.cost;
        if (adjustment.speed) {
          direct.speed ??= updateSpeedTotals(undefined, undefined, 1);
          if (!direct.speed) direct.speed = zeroSpeed();
          for (const kind of ["generation", "response"] as const) for (const field of speedFields) (direct.speed[kind] as any)[field] = ((direct.speed[kind] as any)[field] ?? 0) + sign * ((adjustment.speed[kind] as any)[field] ?? 0);
        }
      }
      for (const direct of Object.values(sessions)) {
        for (const key of tokenFields) direct.tokens[key] = Math.max(0, direct.tokens[key]);
        direct.responseCount = Math.max(0, direct.responseCount); direct.cost = Math.max(0, direct.cost);
        if (direct.speed) for (const kind of ["generation", "response"] as const) for (const field of speedFields) (direct.speed[kind] as any)[field] = Math.max(0, (direct.speed[kind] as any)[field] ?? 0);
      }
      this.counters.visibleBuilds++; this.counters.visibleSessionCopies += Object.keys(sessions).length;
      if (this.index) for (const [key, value] of Object.entries(totalsRollupIndexDiagnostics(this.index))) this.rollupPrevious[key] = (this.rollupPrevious[key] ?? 0) + value;
      this.index = createTotalsRollupIndex(sessions, this.parents, this.scopes);
      this.indexParent = this.parentVersion; this.indexScope = this.scopeVersion; this.indexRecords = records;
      this.dirty = false; this.totalsVersion++;
    }
    return this.index;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.binding++; this.stopPort?.(); this.stopPort = undefined; this.port = undefined;
    if (this.index) for (const [key, value] of Object.entries(totalsRollupIndexDiagnostics(this.index))) this.rollupPrevious[key] = (this.rollupPrevious[key] ?? 0) + value;
    this.proofIterator = undefined; this.blockedProof = undefined; this.proofScanNeeded = false;
    this.parents.discard();
    for (const map of [this.witnesses, this.children, this.roots, this.eligibility, this.conflicts, this.parked,
      this.parentChanges, this.scopeChanges, this.contributions, this.deductions, this.deducted,
      this.overlayTerms, this.overlaySources, this.overlayTotals, this.window]) map.clear();
    for (const set of [this.ancestryChecked, this.canonicalParentFacts, this.canonicalExcluded, this.dirtyResponses, this.invalidRoots, this.invalidScopes]) set.clear();
    for (const id of Object.keys(this.scopes)) delete this.scopes[id];
    this.canonicalScopes = undefined; this.registry = undefined; this.ledger = undefined; this.basis = undefined;
    this.optimistic = undefined; this.index = undefined; this.indexRecords = undefined;
  }
  diagnostics() {
    const rollup = this.index ? { ...totalsRollupIndexDiagnostics(this.index) } : Object.keys(this.rollupPrevious).length ? {} as Record<string, number> : undefined;
    if (rollup) for (const [key, value] of Object.entries(this.rollupPrevious)) (rollup as any)[key] += value;
    return { ...this.counters, parentVersion: this.parentVersion, scopeVersion: this.scopeVersion, parentConflicts: this.conflicts.size, rollup };
  }
}
const models = new WeakMap<RuntimeStore, TuiReadModel>();
export function tuiReadModel(store: RuntimeStore): TuiReadModel { let value = models.get(store); if (!value) { value = new TuiReadModel(store); models.set(store, value); } return value; }
export function disconnectTuiReadModel(store: RuntimeStore): void { models.get(store)?.dispose(); models.delete(store); }
const tokenFields = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;
const speedFields = ["generatedTokens", "durationMs", "responseCount", "estimatedResponseCount", "coverageGeneratedTokens", "shortResponseCount"] as const;
function zeroSpeed() { return { generation: { generatedTokens: 0, durationMs: 0, responseCount: 0, estimatedResponseCount: 0, coverageGeneratedTokens: 0, shortResponseCount: 0 }, response: { generatedTokens: 0, durationMs: 0, responseCount: 0, estimatedResponseCount: 0, coverageGeneratedTokens: 0 } }; }
function zero(): SessionDirectTotals { return { responseCount: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }; }

export function activityIdentity(fact: ActivityEvent): string {
  return JSON.stringify([fact.sessionID, fact.executionID ?? null, fact.sourceEventID ?? fact.eventID, fact.kind,
    fact.kind === "work" ? [fact.source, fact.workID, fact.stepID ?? null, fact.phase] : null]);
}
/** Receive-local sequence/time never make an otherwise identical control new. */
export function activitySemanticIdentity(fact: Record<string, any>): string {
  return JSON.stringify([fact.sessionID, fact.executionID, fact.sourceEventID ?? fact.eventID, fact.kind,
    fact.state, fact.timestamp, fact.parentSessionID, fact.source, fact.workID, fact.stepID, fact.phase,
    fact.scope, fact.measurementScope, fact.classification, fact.coverage, fact.instanceEndedAt, fact.lastObservedAt]);
}
type WorkFact = Extract<ActivityEvent, { kind: "work" }>;
const workKey = (fact: WorkFact) => JSON.stringify([fact.sessionID, fact.executionID ?? `legacy:${fact.instanceID}`, fact.source, fact.stepID ?? null, fact.workID]);
const workBoundary = (fact: WorkFact) => JSON.stringify([fact.phase, fact.timestamp]);
const positive = (scope: CompactScopeEvidence) => scope.sourceScope === "magic-message" || scope.sourceScope === "magic-session";
const boundaryIdentity = (fact: ActivityEvent) => JSON.stringify([fact.kind, fact.timestamp,
  fact.kind === "lifecycle" ? fact.state : fact.kind === "work" ? [fact.source, fact.workID, fact.stepID, fact.phase] : fact.kind === "execution-scope" ? [fact.classification, fact.coverage] : fact.parentSessionID]);
// Keep parent metadata acceptance identical to the existing selector's full
// normalized-fact dedupe, separate from source/business confirmation identity.
const canonicalFactSignature = (fact: ActivityEvent): string => JSON.stringify(fact);
const streamKey = (fact: ActivityStreamKey) => JSON.stringify([fact.sessionID, fact.instanceID, fact.executionID ?? null]);
const executionKey = (fact: ActivityEvent) => JSON.stringify([fact.sessionID, fact.executionID ?? `legacy:${fact.instanceID}`]);
type Stream = { key: ActivityStreamKey; facts: Map<string, ActivityEvent>; hidden: boolean; retired: boolean; canonical: boolean; lastObserved: number };
type Execution = { canonical: Map<string, boolean>; live: Map<string, boolean>; canonicalMissing: number; liveMissing: number;
  canonicalStreams: Set<string>; liveStreams: Set<string>; closed: boolean; retired: boolean; pure: boolean;
  key: string; canonicalBoundaries: Map<string, string>; canonicalReceipts: Map<string, string>; liveBoundaries: Map<string, string> };
type WorkProof = { scope: CompactScopeEvidence; boundaries: Set<string>; receipts: Map<string, { boundary: string; source: string }>; confirmed: boolean };
type PureProof = { timestamp: number; receipt: Map<string, string>; missing: number; confirmed: boolean };
type LegacySummary = { latest?: ActivityEvent; earliestActive?: ActivityEvent; stable: boolean };

/** Selection and source confirmation only. Every duration is computed by the
 * shared projector. Full original (SID, instance, execution) keys are retained. */
export class TuiActivitySelection {
  projector: ActivityProjector = createActivityProjector();
  readonly overlay = new Map<string, ActivityEvent>();
  readonly known = new Set<string>();
  readonly canonicalIDs = new Set<string>();
  readonly legacy = new Map<string, Map<string, LegacySummary>>();
  cursor?: ActivityReadCursor;
  readToken = 0;
  retryNeeded = false;
  readonly counters = { liveAccepted: 0, canonicalIngested: 0, canonicalSessionAssignments: 0, canonicalResets: 0, canonicalAppends: 0, canonicalDuplicates: 0,
    confirmationVisits: 0, selectorChanges: 0, coldStreamRepairs: 0, coldRepairFacts: 0, replayCalls: 0,
    canonicalArrayCopies: 0, readRetries: 0, staleReads: 0, pureReceiptCopies: 0, pureReceiptEntries: 0 };
  private streams = new Map<string, Stream>();
  private streamsBySession = new Map<string, Set<string>>();
  private executions = new Map<string, Execution>();
  private liveSeen = new Set<string>();
  private canonicalSessions = new Set<string>();
  private previousMetrics: Record<string, number> = {};
  private knownRoots = new Map<string, number>();
  private rootBySID = new Map<string, string>();
  private rebuilding = false;
  private disposed = false;
  private workProofs = new Map<string, WorkProof>();
  private rawWorks = new Map<string, Map<string, WorkFact>>();
  private appliedWorkScopes = new WeakMap<WorkFact, string>();
  private pureProofs = new Map<string, PureProof>();
  constructor(readonly store: RuntimeStore) {}
  private stream(fact: ActivityEvent, canonical: boolean): Stream {
    const id = streamKey(fact);
    let stream = this.streams.get(id);
    if (!stream) { stream = { key: { sessionID: fact.sessionID, instanceID: fact.instanceID, executionID: fact.executionID }, facts: new Map(), hidden: false, retired: false, canonical, lastObserved: fact.timestamp }; this.streams.set(id, stream);
      let ids = this.streamsBySession.get(fact.sessionID); if (!ids) this.streamsBySession.set(fact.sessionID, ids = new Set()); ids.add(id);
    }
    if (fact.executionID) {
      const key = executionKey(fact);
      let execution = this.executions.get(key);
      if (!execution) { execution = { key, canonical: new Map(), live: new Map(), canonicalMissing: 0, liveMissing: 0, canonicalBoundaries: new Map(), canonicalReceipts: new Map(), liveBoundaries: new Map(),
        canonicalStreams: new Set(), liveStreams: new Set(), closed: false, retired: false, pure: false }; this.executions.set(key, execution); }
      (canonical ? execution.canonicalStreams : execution.liveStreams).add(id);
    }
    return stream;
  }
  private confirm(fact: ActivityEvent, canonical: boolean): void {
    if (!fact.executionID) return;
    const execution = this.executions.get(executionKey(fact))!;
    const identity = activityIdentity(fact), boundaries = canonical ? execution.canonicalBoundaries : execution.liveBoundaries;
    const before = this.missingIdentity(execution, identity);
    const pure = this.pureProofs.get(execution.key), previous = boundaries.get(identity), next = boundaryIdentity(fact);
    if (canonical && pure) pure.missing += Number(pure.receipt.get(identity) !== next) - Number(previous !== undefined && pure.receipt.get(identity) !== previous);
    boundaries.set(identity, next);
    this.confirmIdentity(execution, identity, canonical, fact.kind === "work" && positive(fact.measurementScope), before);
    if (canonical && fact.kind === "lifecycle" && fact.state !== "busy" && fact.state !== "retry") execution.closed = true;
    if (fact.kind === "execution-scope") {
      if (!canonical) {
        execution.pure = true;
        if (this.rebuilding && this.pureProofs.has(execution.key)) return;
        const receipt = new Map(execution.liveBoundaries);
        this.counters.pureReceiptCopies++; this.counters.pureReceiptEntries += receipt.size;
        this.pureProofs.set(execution.key, { timestamp: fact.timestamp, receipt,
          missing: [...execution.canonicalBoundaries].filter(([id, value]) => receipt.get(id) !== value).length, confirmed: false });
      } else if (pure && pure.timestamp === fact.timestamp) pure.confirmed = true;
    }
  }
  private missingIdentity(execution: Execution, identity: string) {
    const live = execution.liveBoundaries.get(identity), canonical = execution.canonicalBoundaries.get(identity) ?? execution.canonicalReceipts.get(identity);
    const mismatch = live !== undefined && canonical !== undefined && live !== canonical;
    return { canonical: execution.live.has(identity) && (!execution.canonical.has(identity) || mismatch || (execution.live.get(identity) === true && execution.canonical.get(identity) !== true)),
      live: execution.canonical.has(identity) && (!execution.live.has(identity) || mismatch || (execution.canonical.get(identity) === true && execution.live.get(identity) !== true)) };
  }
  private confirmIdentity(execution: Execution, identity: string, canonical: boolean, maintenance: boolean, before = this.missingIdentity(execution, identity)): void {
    this.counters.confirmationVisits++;
    const side = canonical ? execution.canonical : execution.live;
    side.set(identity, side.get(identity) === true || maintenance);
    const after = this.missingIdentity(execution, identity); execution.canonicalMissing += Number(after.canonical) - Number(before.canonical);
    execution.liveMissing += Number(after.live) - Number(before.live);
  }
  private projectedWork(fact: WorkFact): WorkFact {
    const proof = this.workProofs.get(workKey(fact));
    const scope = proof ? mergeScopeEvidence(fact.measurementScope, proof.scope) : fact.measurementScope;
    this.appliedWorkScopes.set(fact, JSON.stringify(scope));
    return proof ? { ...fact, measurementScope: scope } : fact;
  }
  private confirmWork(key: string, execution?: Execution): void {
    const proof = this.workProofs.get(key), raw = this.rawWorks.get(key);
    if (!proof) return;
    const confirmed = new Set<string>(), available = new Set<string>();
    for (const fact of raw?.values() ?? []) {
      available.add(workBoundary(fact));
      if (positive(fact.measurementScope) && JSON.stringify(mergeScopeEvidence(fact.measurementScope, proof.scope)) === JSON.stringify(fact.measurementScope)) confirmed.add(workBoundary(fact));
    }
    proof.confirmed = [...proof.boundaries].every((boundary) => confirmed.has(boundary));
    if (proof.confirmed) for (const [identity, receipt] of proof.receipts) {
      if (!available.has(receipt.boundary)) continue;
      if (execution) {
        if (execution.canonicalBoundaries.has(identity) && execution.canonicalBoundaries.get(identity) !== receipt.source) continue;
        const before = this.missingIdentity(execution, identity);
        execution.canonicalReceipts.set(identity, receipt.source); this.confirmIdentity(execution, identity, true, true, before);
      }
      const pending = this.overlay.get(identity), source = pending && this.streams.get(streamKey(pending));
      if (pending && (source?.retired || !source?.facts.has(identity))) this.overlay.delete(identity);
    }
  }
  private refineWork(fact: WorkFact): void {
    if (!positive(fact.measurementScope)) return;
    const key = workKey(fact), proof = this.workProofs.get(key) ?? { scope: fact.measurementScope, boundaries: new Set(), receipts: new Map(), confirmed: false };
    proof.scope = mergeScopeEvidence(proof.scope, fact.measurementScope); proof.boundaries.add(workBoundary(fact));
    proof.receipts.set(activityIdentity(fact), { boundary: workBoundary(fact), source: boundaryIdentity(fact) });
    this.workProofs.set(key, proof);
    const changes: ActivityEvent[] = [];
    for (const raw of this.rawWorks.get(key)?.values() ?? []) {
      const scope = mergeScopeEvidence(raw.measurementScope, proof.scope);
      if (this.appliedWorkScopes.get(raw) !== JSON.stringify(scope)) changes.push(this.projectedWork(raw));
    }
    if (changes.length) this.projector.ingest(changes);
    this.confirmWork(key, this.executions.get(executionKey(fact))!);
  }
  private select(execution: Execution): void {
    const updates: ActivityStreamUpdate[] = [];
    const retire = execution.closed && execution.live.size > 0 && execution.canonicalMissing === 0;
    const pure = this.pureProofs.get(execution.key);
    const shadow = (!!pure && !pure.confirmed && pure.missing === 0)
      || (!retire && execution.liveMissing === 0 && execution.canonicalMissing > 0 && (!execution.retired || execution.pure));
    for (const id of execution.canonicalStreams) {
      const stream = this.streams.get(id)!;
      const hidden = shadow && !execution.liveStreams.has(id);
      if (stream.hidden !== hidden) { stream.hidden = hidden; updates.push({ key: stream.key, mode: hidden ? "hidden" : "visible" }); }
    }
    if (retire) for (const id of execution.liveStreams) {
      const stream = this.streams.get(id)!;
      if (stream.retired) continue;
      for (const identity of stream.facts.keys()) this.overlay.delete(identity);
      if (!execution.canonicalStreams.has(id)) {
        stream.facts.clear(); stream.retired = true; stream.hidden = true;
        updates.push({ key: stream.key, mode: "replace", events: [] });
      }
      execution.retired = true;
    }
    if (updates.length) { this.counters.selectorChanges += updates.length; this.projector.updateStreams(updates); }
  }
  reset(events: readonly ActivityEvent[]): void {
    if (this.disposed) return;
    for (const [key, count] of Object.entries(activityProjectionDiagnostics(this.projector))) this.previousMetrics[key] = (this.previousMetrics[key] ?? 0) + count;
    this.projector = createActivityProjector(); this.counters.canonicalResets++;
    this.canonicalIDs.clear(); this.canonicalSessions.clear(); this.known.clear(); this.knownRoots.clear(); this.rootBySID.clear(); this.legacy.clear(); this.streams.clear(); this.streamsBySession.clear(); this.executions.clear();
    this.rawWorks.clear(); this.appliedWorkScopes = new WeakMap();
    for (const proof of this.workProofs.values()) proof.confirmed = false;
    for (const proof of this.pureProofs.values()) { proof.confirmed = false; proof.missing = 0; }
    // Rebuild only on a real canonical reset. Unconfirmed live observations keep
    // their original epoch, not the new canonical collector's instanceID.
    const local = [...this.overlay.values()];
    this.overlay.clear();
    const model = tuiReadModel(this.store); model.syncScopes();
    this.projector.setContext({ sessionScopes: model.scopes, parentBySessionID: model.orderedParents() });
    model.parentChanges.clear(); model.scopeChanges.clear();
    this.rebuilding = true;
    this.addCanonical(events, false);
    for (const fact of local) this.addLive(fact);
    this.rebuilding = false;
    for (const execution of this.executions.values()) this.select(execution);
    return;
  }
  addCanonical(events: readonly ActivityEvent[], append = true): ActivityEvent[] {
    if (this.disposed) return [];
    const accepted: ActivityEvent[] = [], affected = new Set<Execution>();
    for (const fact of events) {
      // Reader facts are normalized controls. Preserve accepted conflicting
      // payloads/late scope refinements even when an explicit ID is reused.
      // Source confirmation below still uses the separate business identity.
      const identity = canonicalFactSignature(fact);
      if (this.canonicalIDs.has(identity)) { this.counters.canonicalDuplicates++; continue; }
      this.canonicalIDs.add(identity); accepted.push(fact); this.counters.canonicalIngested++;
      if (!this.canonicalSessions.has(fact.sessionID)) { this.canonicalSessions.add(fact.sessionID); this.counters.canonicalSessionAssignments++; }
      this.stream(fact, true).facts.set(identity, fact); this.noteKnown(fact.sessionID); this.confirm(fact, true);
      if (fact.kind === "work") {
        const key = workKey(fact); let raw = this.rawWorks.get(key); if (!raw) this.rawWorks.set(key, raw = new Map());
        raw.set(identity, fact); this.confirmWork(key, this.executions.get(executionKey(fact))!);
      }
      if (fact.executionID) affected.add(this.executions.get(executionKey(fact))!);
      else this.summarizeLegacy(fact);
    }
    if (accepted.length) {
      this.projector.ingest(accepted.map((fact) => fact.kind === "work" ? this.projectedWork(fact) : fact));
      if (!this.rebuilding) for (const execution of affected) this.select(execution);
      if (append) this.counters.canonicalAppends++;
    }
    return accepted;
  }
  hasLiveSemantic(identity: string): boolean { return this.liveSeen.has(identity); }
  addLive(fact: ActivityEvent, semantic = activitySemanticIdentity(fact)): boolean {
    if (this.disposed || this.store.disposed) return false;
    const identity = activityIdentity(fact);
    if (!this.rebuilding && this.liveSeen.has(semantic)) return false;
    if (!this.rebuilding) this.counters.liveAccepted++;
    this.liveSeen.add(semantic); this.noteKnown(fact.sessionID);
    const stream = this.stream(fact, false);
    stream.lastObserved = Math.max(stream.lastObserved, fact.timestamp);
    const execution = fact.executionID ? this.executions.get(executionKey(fact)) : undefined;
    const metadataOnly = fact.kind === "work" && positive(fact.measurementScope)
      && (stream.retired || (!!execution?.closed && !stream.facts.size));
    if (stream.retired && !metadataOnly) {
      this.projector.updateStreams([{ key: stream.key, mode: "visible" }]); stream.retired = false; stream.hidden = false;
    }
    if (!metadataOnly) stream.facts.set(identity, fact);
    this.overlay.set(identity, fact);
    const viewed = fact.kind === "work" ? this.projectedWork(fact) : fact;
    if (fact.kind === "work") this.workProofs.get(workKey(fact))?.receipts.set(identity, { boundary: workBoundary(fact), source: boundaryIdentity(fact) });
    this.confirm(viewed, false);
    if (!metadataOnly) this.projector.ingest([viewed]);
    if (fact.kind === "work") {
      this.refineWork(fact);
      if (!positive(fact.measurementScope)) this.confirmWork(workKey(fact), execution);
    }
    if (fact.executionID) {
      const execution = this.executions.get(executionKey(fact))!;
      if (!this.rebuilding) this.select(execution);
    }
    return true;
  }
  freeze(instanceID: string, boundary?: number, executionID?: string): void {
    const updates: ActivityStreamUpdate[] = [];
    for (const stream of this.streams.values()) {
      if (stream.canonical || stream.key.instanceID !== instanceID || stream.retired || (executionID !== undefined && stream.key.executionID !== executionID)) continue;
      const events: ActivityEvent[] = [];
      for (const [identity, fact] of stream.facts) {
        const frozen = { ...fact, instanceEndedAt: boundary ?? stream.lastObserved }; events.push(frozen.kind === "work" ? this.projectedWork(frozen) : frozen); stream.facts.set(identity, frozen);
        if (this.overlay.has(identity)) this.overlay.set(identity, frozen);
      }
      if (events.length) { this.counters.coldStreamRepairs++; this.counters.coldRepairFacts += events.length; updates.push({ key: stream.key, mode: "replace", events }); }
    }
    if (updates.length) this.projector.updateStreams(updates);
  }
  patch(): void {
    const model = tuiReadModel(this.store); model.syncScopes();
    if (!model.parentChanges.size && !model.scopeChanges.size) return;
    if (model.parentChanges.size) model.visitAffected(model.parentChanges.keys(), (id) => { if (this.known.has(id)) this.noteKnown(id); });
    this.projector.patchContext({ parents: model.orderedParents(model.parentChanges), sessionScopes: model.scopeChanges });
    model.parentChanges.clear(); model.scopeChanges.clear();
  }
  knownRoot(id: string): boolean {
    return this.knownRoots.has(id);
  }
  private noteKnown(id: string): void {
    const root = tuiReadModel(this.store).root(id), previous = this.rootBySID.get(id);
    this.known.add(id); if (previous === root) return;
    if (previous) { const count = this.knownRoots.get(previous)! - 1; if (count) this.knownRoots.set(previous, count); else this.knownRoots.delete(previous); }
    this.rootBySID.set(id, root); this.knownRoots.set(root, (this.knownRoots.get(root) ?? 0) + 1);
  }
  private summarizeLegacy(fact: ActivityEvent): void {
    let sessions = this.legacy.get(fact.sessionID); if (!sessions) this.legacy.set(fact.sessionID, sessions = new Map());
    let summary = sessions.get(fact.instanceID); if (!summary) sessions.set(fact.instanceID, summary = { stable: false });
    if (fact.executionID || fact.sourceEventID) summary.stable = true;
    if (fact.kind !== "lifecycle") return;
    if (!summary.latest || compareActivityEvents(summary.latest, fact) < 0) summary.latest = fact;
    if ((fact.state === "busy" || fact.state === "retry") && (!summary.earliestActive || compareActivityEvents(fact, summary.earliestActive) < 0)) summary.earliestActive = fact;
  }
  retireLegacy(sid: string, terminal: number): void {
    const updates: ActivityStreamUpdate[] = [];
    for (const key of this.streamsBySession.get(sid) ?? []) {
      const stream = this.streams.get(key)!;
      if (stream.canonical || stream.key.executionID || stream.retired) continue;
      const keep: ActivityEvent[] = [];
      for (const [identity, fact] of stream.facts) if (fact.timestamp <= terminal) { stream.facts.delete(identity); this.overlay.delete(identity); } else keep.push(fact);
      updates.push({ key: stream.key, mode: "replace", events: keep }); this.counters.coldStreamRepairs++; this.counters.coldRepairFacts += keep.length;
      if (!keep.length) stream.retired = true;
    }
    if (updates.length) this.projector.updateStreams(updates);
  }
  diagnostics() {
    const metrics = { ...activityProjectionDiagnostics(this.projector) };
    for (const [key, count] of Object.entries(this.previousMetrics)) (metrics as any)[key] += count;
    return { ...metrics, ...this.counters, canonicalFacts: this.canonicalIDs.size, compactLiveIdentities: this.liveSeen.size,
      retainedStreams: this.streams.size, overlayFacts: this.overlay.size, workProofs: this.workProofs.size,
      pendingWorkProofs: [...this.workProofs.values()].filter((proof) => !proof.confirmed).length, readModel: tuiReadModel(this.store).diagnostics() };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.readToken++; this.cursor = undefined; this.retryNeeded = false;
    for (const [key, count] of Object.entries(activityProjectionDiagnostics(this.projector))) this.previousMetrics[key] = (this.previousMetrics[key] ?? 0) + count;
    for (const map of [this.overlay, this.legacy, this.streams, this.streamsBySession, this.executions, this.knownRoots, this.rootBySID, this.workProofs, this.rawWorks, this.pureProofs]) map.clear();
    for (const set of [this.known, this.canonicalIDs, this.liveSeen, this.canonicalSessions]) set.clear();
    this.appliedWorkScopes = new WeakMap(); this.projector = createActivityProjector();
  }
}
