/** Shared, clock-free source classification. No SDK calls or message text retained. */

export const SCOPE_VERSION = 1;
export const MAGIC_CONTEXT_AGENTS = new Set(["dreamer", "dreamer-docs", "dreamer-reviewer", "dreamer-retrospective", "dreamer-primer-investigator", "dreamer-memory-mapper", "dreamer-classifier", "smart-note-compiler", "historian", "historian-recomp", "historian-editor"]);
export const SCOPE_REASONS = ["hidden-metadata", "session-agent", "session-title", "message-agent", "message-mode", "magic-model", "compaction-summary", "compaction-agent", "normal-agent", "parent-link"];
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function evidence(sourceScope, reason, parentSessionID) {
  return {
    version: 1,
    sourceScope,
    reasons: reason ? [reason] : [],
    ...(parentSessionID ? {
      parentSessionID
    } : {})
  };
}
export function coerceScopeEvidence(value) {
  const raw = object(value);
  if (raw.version !== 1 || !["user", "magic-session", "magic-message", "pending"].includes(raw.sourceScope)) return undefined;
  const reasons = Array.isArray(raw.reasons) ? [...new Set(raw.reasons.slice(0, 64).filter(reason => SCOPE_REASONS.includes(reason)))] : [];
  return {
    version: 1,
    sourceScope: raw.sourceScope,
    reasons: reasons.slice(0, SCOPE_REASONS.length),
    ...(typeof raw.parentSessionID === "string" && raw.parentSessionID ? {
      parentSessionID: raw.parentSessionID
    } : {})
  };
}
export function classifySessionMetadata(value) {
  const raw = object(value);
  const metadata = object(raw.metadata);
  const parent = raw.parentID ?? raw.parentSessionID;
  const parentID = typeof parent === "string" && parent ? parent : undefined;
  if (metadata.magic_context === "hidden-run" && (metadata.role === undefined || ["historian", "dreamer", "dreamer-curate"].includes(metadata.role))) return evidence("magic-session", "hidden-metadata", parentID);
  if (MAGIC_CONTEXT_AGENTS.has(raw.agent)) return evidence("magic-session", "session-agent", parentID);
  if (typeof raw.title === "string" && (raw.title.startsWith("magic-context-") || raw.title === "Magic Context historian" || raw.title === "Magic Context dreamer")) return evidence("magic-session", "session-title", parentID);
  if (typeof raw.agent === "string" && raw.agent) return evidence("user", "normal-agent", parentID);
  return evidence("pending", parentID ? "parent-link" : undefined, parentID);
}
export function classifyMessageMetadata(value) {
  const raw = object(value);
  if (raw.role !== undefined && raw.role !== "assistant") return evidence("pending");
  // Exact hidden assistant identity is whole-session authority even when a
  // message also carries a synthetic model/compaction marker.
  if (MAGIC_CONTEXT_AGENTS.has(raw.agent)) return evidence("magic-session", "message-agent");
  if (MAGIC_CONTEXT_AGENTS.has(raw.mode)) return evidence("magic-session", "message-mode");
  if (raw.providerID === "magic-context" || raw.modelID === "magic-context" || object(raw.model).providerID === "magic-context" || object(raw.model).modelID === "magic-context") return evidence("magic-message", "magic-model");
  if (raw.summary === true && raw.mode === "compaction") return evidence("magic-message", "compaction-summary");
  if (raw.agent === "compaction") return evidence("magic-message", "compaction-agent");
  if (typeof raw.agent === "string" && raw.agent || typeof raw.mode === "string" && raw.mode) return evidence("user", "normal-agent");
  return evidence("pending");
}
export function mergeScopeEvidence(previous, next) {
  const sourceScope = previous?.sourceScope === "magic-session" || next.sourceScope === "magic-session" ? "magic-session" : previous?.sourceScope === "magic-message" || next.sourceScope === "magic-message" ? "magic-message" : next.sourceScope === "pending" && previous ? previous.sourceScope : next.sourceScope;
  return {
    version: 1,
    sourceScope,
    reasons: [...new Set([...(previous?.reasons ?? []), ...next.reasons])].slice(0, SCOPE_REASONS.length),
    ...(next.parentSessionID ?? previous?.parentSessionID ? {
      parentSessionID: next.parentSessionID ?? previous?.parentSessionID
    } : {})
  };
}
/** Cycle-safe O(depth). Only whole-session exclusion is inherited. */
export function isSessionScopeExcluded(sessionID, scopes = {}, parents) {
  const seen = new Set();
  let current = sessionID;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (scopes[current]?.sourceScope === "magic-session") return true;
    const explicit = parents instanceof Map ? parents.get(current) : parents?.[current];
    const hasExplicit = parents instanceof Map ? parents.has(current) : !!parents && Object.prototype.hasOwnProperty.call(parents, current);
    current = hasExplicit ? explicit : scopes[current]?.parentSessionID;
  }
  return false;
}
export function isMeasurementScopeEligible(record, scopes = {}, parents) {
  if (record.scope?.sourceScope === "magic-message" || record.scope?.sourceScope === "magic-session") return false;
  if (isSessionScopeExcluded(record.sessionID, scopes, parents)) return false;
  return !record.parentSessionID || !isSessionScopeExcluded(record.parentSessionID, scopes, parents);
}

/** Recover session identity from compact stored proofs; message proofs stay local. */
export function collectSessionScopeEvidence(records, scopes = {}) {
  let collected;
  for (const record of records) {
    if (record.scope?.sourceScope !== "magic-session") continue;
    collected ??= {
      ...scopes
    };
    collected[record.sessionID] = mergeScopeEvidence(collected[record.sessionID], record.scope);
  }
  return collected ?? scopes;
}

/** Positive identity persists indefinitely; only negative/unknown metadata is LRU bounded. */
export class ScopeRegistry {
  positive = Object.create(null);
  transient = new Map();
  parents = new Map();
  revision = 0;
  constructor(scopes = {}, transientLimit = 2048) {
    this.transientLimit = transientLimit;
    for (const [id, raw] of Object.entries(scopes)) {
      const proof = coerceScopeEvidence(raw);
      if (proof) this.observe(id, proof);
    }
  }
  observeSessionMetadata(sessionID, metadata) {
    const raw = object(metadata);
    if (Object.prototype.hasOwnProperty.call(raw, "parentID") || Object.prototype.hasOwnProperty.call(raw, "parentSessionID")) {
      const parent = raw.parentID ?? raw.parentSessionID;
      const nextParent = typeof parent === "string" && parent ? parent : undefined;
      if (!this.parents.has(sessionID) || this.parents.get(sessionID) !== nextParent) {
        this.parents.set(sessionID, nextParent);
        this.revision++;
      }
    }
    return this.observe(sessionID, classifySessionMetadata(metadata));
  }
  observeMessageMetadata(sessionID, metadata) {
    const proof = classifyMessageMetadata(metadata);
    // A compaction message cannot poison the enclosing user session.
    return proof.sourceScope === "magic-message" ? proof : this.observe(sessionID, proof);
  }
  getScope(sessionID) {
    return this.isExcluded(sessionID) ? "magic-session" : this.direct(sessionID)?.sourceScope ?? "pending";
  }
  isExcluded(sessionID) {
    return isSessionScopeExcluded(sessionID, this.positive, this.parents);
  }
  getEvidence(sessionID) {
    const proof = this.direct(sessionID);
    return proof ? coerceScopeEvidence(proof) : undefined;
  }
  /** Compact positive identities plus parent edges needed to recover ancestry. */
  serialize() {
    const result = Object.create(null);
    for (const [id, proof] of Object.entries(this.positive)) result[id] = coerceScopeEvidence(proof);
    for (const [id, parent] of this.parents) {
      if (parent) result[id] = {
        ...(result[id] ?? evidence("pending", "parent-link")),
        parentSessionID: parent
      };else if (result[id]) delete result[id].parentSessionID;
    }
    return result;
  }
  direct(id) {
    return this.positive[id] ?? this.transient.get(id);
  }
  observe(id, proof) {
    if (!id) throw new TypeError("sessionID must be non-empty");
    const previous = this.direct(id);
    const merged = mergeScopeEvidence(previous, proof);
    if (proof.parentSessionID && !this.parents.has(id)) this.parents.set(id, proof.parentSessionID);
    if (merged.sourceScope === "magic-session") {
      this.positive[id] = merged;
      this.transient.delete(id);
    } else {
      this.transient.delete(id);
      this.transient.set(id, merged);
      while (this.transient.size > Math.max(0, this.transientLimit)) this.transient.delete(this.transient.keys().next().value);
    }
    if (JSON.stringify(previous) !== JSON.stringify(merged)) this.revision++;
    return coerceScopeEvidence(merged);
  }
}
export function createScopeRegistry(scopes = {}, transientLimit = 2048) {
  return new ScopeRegistry(scopes, transientLimit);
}
