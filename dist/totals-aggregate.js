import { addTokenCounts, emptyTokenCounts } from "./core.js";
import { addSpeedTotals, coerceSpeedTotals } from './statistics.js';
import { isSessionScopeExcluded } from "./scope.js";
const totalsIndexCounters = new WeakMap();
/** Structural test hook only: no persistent/runtime telemetry. */
export function totalsRollupIndexDiagnostics(index) {
  return {
    ...totalsIndexCounters.get(index)
  };
}
/** Input-version snapshot, not a cache keyed by mutable Map/object identity.
 * Functional parent graphs are compressed into cycle components, then folded
 * once. get costs O(1 + direct children), including fresh mutable result copies. */
export function createTotalsRollupIndex(sessions, parentBySessionID, sessionScopes = {}) {
  const counts = {
    builds: 1,
    sessionEntries: 0,
    parentEntries: 0,
    scopeEntries: 0,
    nodeVisits: 0,
    parentVisits: 0,
    childVisits: 0,
    merges: 0,
    sortComparisons: 0,
    gets: 0,
    resultCopies: 0
  };
  const nodes = new Map();
  const ensure = id => {
    counts.nodeVisits++;
    let item = nodes.get(id);
    if (!item) {
      item = {
        id,
        explicit: false,
        magic: false,
        children: [],
        direct: zeroTotals(),
        own: zeroTotals()
      };
      nodes.set(id, item);
    }
    return item;
  };
  const merge = (target, source) => {
    counts.merges++;
    target.tokens = addTokenCounts(target.tokens, source.tokens);
    target.cost += source.cost;
    target.responseCount += source.responseCount;
    const speed = addSpeedTotals(target.speed, source.speed);
    if (speed) target.speed = speed;
  };
  for (const id of Object.keys(sessions)) {
    counts.sessionEntries++;
    const item = ensure(id),
      source = sessions[id];
    item.direct = copyTotals(source);
    if (source) merge(item.own, source);
  }
  const addParent = (id, value) => {
    counts.parentEntries++;
    const item = ensure(id);
    item.explicit = true;
    item.rawParent = value;
    if (typeof value === "string" && value.length) ensure(value);
  };
  if (isParentMap(parentBySessionID)) {
    for (const [id, parent] of parentBySessionID) addParent(id, parent);
  } else {
    for (const id of Object.keys(parentBySessionID)) addParent(id, parentBySessionID[id]);
  }
  for (const id of Object.keys(sessionScopes)) {
    counts.scopeEntries++;
    const item = ensure(id),
      proof = sessionScopes[id];
    item.magic = !!id && proof?.sourceScope === "magic-session";
    item.proofParent = proof?.parentSessionID;
    if (!item.explicit && item.proofParent) ensure(item.proofParent);
  }
  for (const item of nodes.values()) {
    counts.nodeVisits++;
    counts.parentVisits++;
    const parentID = normalizeParent(item.id, item.rawParent);
    if (parentID !== undefined) {
      item.parent = nodes.get(parentID);
      counts.nodeVisits++;
      counts.childVisits++;
      item.parent.children.push(item);
    }
  }
  // Eligibility has its own parent semantics: an explicit null/empty/self
  // suppresses scope.parent fallback, even though it is not a rollup edge.
  for (const first of nodes.values()) {
    counts.nodeVisits++;
    if (first.eligible !== undefined) continue;
    const path = [],
      positions = new Map();
    let current = first;
    while (current && current.eligible === undefined && !positions.has(current)) {
      counts.nodeVisits++;
      positions.set(current, path.length);
      path.push(current);
      counts.parentVisits++;
      const parent = current.id ? current.explicit ? current.rawParent : current.proofParent : undefined;
      current = typeof parent === "string" && parent ? nodes.get(parent) : undefined;
    }
    if (current) counts.nodeVisits++;
    let eligible = current?.eligible ?? true;
    if (current && positions.has(current)) {
      for (let i = positions.get(current); i < path.length; i++) {
        counts.nodeVisits++;
        if (path[i].magic) eligible = false;
      }
    }
    for (let i = path.length - 1; i >= 0; i--) {
      counts.nodeVisits++;
      eligible = eligible && !path[i].magic;
      path[i].eligible = eligible;
    }
  }
  const components = [];
  const component = () => {
    const value = {
      total: zeroTotals(),
      remaining: 0
    };
    components.push(value);
    return value;
  };
  // Nonrecursive functional-graph SCC discovery: every node enters one path.
  for (const first of nodes.values()) {
    counts.nodeVisits++;
    if (first.component) continue;
    const path = [],
      positions = new Map();
    let current = first;
    while (current && !current.component && !positions.has(current)) {
      counts.nodeVisits++;
      positions.set(current, path.length);
      path.push(current);
      counts.parentVisits++;
      // The legacy traversal stops at an excluded node, rather than letting an
      // eligible empty-ID child leak through it. Compress only traversable edges.
      current = current.eligible && current.parent?.eligible ? current.parent : undefined;
    }
    if (current) counts.nodeVisits++;
    let parent = current?.component,
      end = path.length;
    if (current && positions.has(current)) {
      end = positions.get(current);
      parent = component();
      for (let i = end; i < path.length; i++) {
        counts.nodeVisits++;
        path[i].component = parent;
      }
    }
    for (let i = end - 1; i >= 0; i--) {
      counts.nodeVisits++;
      const own = component();
      own.parent = parent;
      path[i].component = own;
      parent = own;
    }
  }
  for (const item of nodes.values()) {
    counts.nodeVisits++;
    if (item.eligible) merge(item.component.total, item.own);
    // Sorting costs at most sum(degree * log degree), once per snapshot.
    item.children.sort((a, b) => {
      counts.sortComparisons++;
      return a.id.localeCompare(b.id);
    });
  }
  const ready = [];
  for (const item of components) {
    counts.nodeVisits++;
    counts.parentVisits++;
    if (item.parent) {
      counts.nodeVisits++;
      item.parent.remaining++;
    }
  }
  for (const item of components) {
    counts.nodeVisits++;
    if (!item.remaining) ready.push(item);
  }
  for (let i = 0; i < ready.length; i++) {
    const item = ready[i];
    counts.nodeVisits++;
    counts.parentVisits++;
    if (item.parent) {
      counts.nodeVisits++;
      counts.childVisits++;
      merge(item.parent.total, item.total);
      if (--item.parent.remaining === 0) ready.push(item.parent);
    }
  }
  const copy = source => {
    counts.resultCopies++;
    return copyTotals(source);
  };
  const index = {
    get(id) {
      counts.gets++;
      counts.nodeVisits++;
      const item = nodes.get(id);
      if (!item) return {
        direct: copy(),
        including: copy(),
        children: []
      };
      const children = [];
      for (const child of item.children) {
        counts.childVisits++;
        counts.nodeVisits++;
        if (child.eligible) children.push({
          sessionID: child.id,
          direct: copy(child.direct),
          including: copy(child.component.total)
        });
      }
      return {
        direct: copy(item.eligible ? item.direct : undefined),
        including: copy(item.component.total),
        children
      };
    }
  };
  totalsIndexCounters.set(index, counts);
  return index;
}

/**
 * Fold caller-supplied direct totals by parent links.
 * `direct` is the session alone. `including` adds every descendant once.
 * Null, empty, and self parents are ignored. Cycles are visited once.
 * This module does not read history or live activity.
 */
export function rollupSessionTotals(sessions, parentBySessionID, sessionID, sessionScopes = {}) {
  const childrenByParent = indexChildren(parentBySessionID);
  const eligibility = new Map();
  const eligible = id => {
    if (!eligibility.has(id)) eligibility.set(id, !isSessionScopeExcluded(id, sessionScopes, parentBySessionID));
    return eligibility.get(id);
  };
  return {
    direct: copyTotals(eligible(sessionID) ? lookup(sessions, sessionID) : undefined),
    including: sumReachable(sessions, childrenByParent, sessionID, eligible),
    children: directChildIDs(childrenByParent, sessionID).filter(eligible).map(childID => ({
      sessionID: childID,
      direct: copyTotals(lookup(sessions, childID)),
      including: sumReachable(sessions, childrenByParent, childID, eligible)
    }))
  };
}
function indexChildren(parentBySessionID) {
  const childrenByParent = new Map();
  const add = (childID, parent) => {
    const parentID = normalizeParent(childID, parent);
    if (parentID === undefined) return;
    const children = childrenByParent.get(parentID);
    if (children) children.push(childID);else childrenByParent.set(parentID, [childID]);
  };
  if (isParentMap(parentBySessionID)) {
    for (const [childID, parent] of parentBySessionID) add(childID, parent);
    return childrenByParent;
  }
  for (const childID of Object.keys(parentBySessionID)) add(childID, parentBySessionID[childID]);
  return childrenByParent;
}
function isParentMap(value) {
  return value instanceof Map;
}
function normalizeParent(sessionID, parent) {
  if (typeof parent !== "string" || parent.length === 0 || parent === sessionID) return undefined;
  return parent;
}
function directChildIDs(childrenByParent, sessionID) {
  return (childrenByParent.get(sessionID) ?? []).slice().sort((left, right) => left.localeCompare(right));
}
function sumReachable(sessions, childrenByParent, rootID, eligible) {
  const totals = zeroTotals();
  const visited = new Set();
  const pending = [rootID];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    if (!eligible(current)) continue;
    const source = lookup(sessions, current);
    if (source) {
      totals.tokens = addTokenCounts(totals.tokens, source.tokens);
      totals.cost += source.cost;
      totals.responseCount += source.responseCount;
      const speed = addSpeedTotals(totals.speed, source.speed);
      if (speed) totals.speed = speed;
    }
    const children = childrenByParent.get(current);
    if (!children) continue;
    for (const childID of children) {
      if (!visited.has(childID)) pending.push(childID);
    }
  }
  return totals;
}
function lookup(sessions, sessionID) {
  if (!Object.prototype.hasOwnProperty.call(sessions, sessionID)) return undefined;
  return sessions[sessionID];
}
function copyTotals(source) {
  if (!source) return zeroTotals();
  return {
    tokens: addTokenCounts(emptyTokenCounts(), source.tokens),
    cost: source.cost,
    responseCount: source.responseCount,
    ...(source.speed ? {
      speed: coerceSpeedTotals(source.speed)
    } : {})
  };
}
function zeroTotals() {
  return {
    tokens: emptyTokenCounts(),
    cost: 0,
    responseCount: 0
  };
}
