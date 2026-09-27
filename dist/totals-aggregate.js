import { addTokenCounts, emptyTokenCounts } from "./core.js";
/**
 * Fold caller-supplied direct totals by parent links.
 * `direct` is the session alone. `including` adds every descendant once.
 * Null, empty, and self parents are ignored. Cycles are visited once.
 * This module does not read history or live activity.
 */
export function rollupSessionTotals(sessions, parentBySessionID, sessionID) {
  const childrenByParent = indexChildren(parentBySessionID);
  return {
    direct: copyTotals(lookup(sessions, sessionID)),
    including: sumReachable(sessions, childrenByParent, sessionID),
    children: directChildIDs(childrenByParent, sessionID).map(childID => ({
      sessionID: childID,
      direct: copyTotals(lookup(sessions, childID)),
      including: sumReachable(sessions, childrenByParent, childID)
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
function sumReachable(sessions, childrenByParent, rootID) {
  const totals = zeroTotals();
  const visited = new Set();
  const pending = [rootID];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const source = lookup(sessions, current);
    if (source) {
      totals.tokens = addTokenCounts(totals.tokens, source.tokens);
      totals.cost += source.cost;
      totals.responseCount += source.responseCount;
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
    responseCount: source.responseCount
  };
}
function zeroTotals() {
  return {
    tokens: emptyTokenCounts(),
    cost: 0,
    responseCount: 0
  };
}
