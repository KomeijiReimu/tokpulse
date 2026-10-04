import { addTokenCounts, emptyTokenCounts } from "./core.js";
import { addSpeedTotals, coerceSpeedTotals } from './statistics.js';
import type { SessionDirectTotals } from "./totals-storage.js";

export interface TotalsRollupChild {
  sessionID: string;
  direct: SessionDirectTotals;
  including: SessionDirectTotals;
}

export interface TotalsRollup {
  direct: SessionDirectTotals;
  including: SessionDirectTotals;
  children: TotalsRollupChild[];
}

/**
 * Fold caller-supplied direct totals by parent links.
 * `direct` is the session alone. `including` adds every descendant once.
 * Null, empty, and self parents are ignored. Cycles are visited once.
 * This module does not read history or live activity.
 */
export function rollupSessionTotals(
  sessions: Readonly<Record<string, SessionDirectTotals>>,
  parentBySessionID: ReadonlyMap<string, string | null | undefined> | Readonly<Record<string, string | null | undefined>>,
  sessionID: string,
): TotalsRollup {
  const childrenByParent = indexChildren(parentBySessionID);
  return {
    direct: copyTotals(lookup(sessions, sessionID)),
    including: sumReachable(sessions, childrenByParent, sessionID),
    children: directChildIDs(childrenByParent, sessionID).map((childID) => ({
      sessionID: childID,
      direct: copyTotals(lookup(sessions, childID)),
      including: sumReachable(sessions, childrenByParent, childID),
    })),
  };
}

function indexChildren(
  parentBySessionID: ReadonlyMap<string, string | null | undefined> | Readonly<Record<string, string | null | undefined>>,
): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  const add = (childID: string, parent: string | null | undefined) => {
    const parentID = normalizeParent(childID, parent);
    if (parentID === undefined) return;
    const children = childrenByParent.get(parentID);
    if (children) children.push(childID);
    else childrenByParent.set(parentID, [childID]);
  };

  if (isParentMap(parentBySessionID)) {
    for (const [childID, parent] of parentBySessionID) add(childID, parent);
    return childrenByParent;
  }

  for (const childID of Object.keys(parentBySessionID)) add(childID, parentBySessionID[childID]);
  return childrenByParent;
}

function isParentMap(
  value: ReadonlyMap<string, string | null | undefined> | Readonly<Record<string, string | null | undefined>>,
): value is ReadonlyMap<string, string | null | undefined> {
  return value instanceof Map;
}

function normalizeParent(sessionID: string, parent: string | null | undefined): string | undefined {
  if (typeof parent !== "string" || parent.length === 0 || parent === sessionID) return undefined;
  return parent;
}

function directChildIDs(childrenByParent: ReadonlyMap<string, readonly string[]>, sessionID: string): string[] {
  return (childrenByParent.get(sessionID) ?? []).slice().sort((left, right) => left.localeCompare(right));
}

function sumReachable(
  sessions: Readonly<Record<string, SessionDirectTotals>>,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  rootID: string,
): SessionDirectTotals {
  const totals = zeroTotals();
  const visited = new Set<string>();
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

function lookup(
  sessions: Readonly<Record<string, SessionDirectTotals>>,
  sessionID: string,
): SessionDirectTotals | undefined {
  if (!Object.prototype.hasOwnProperty.call(sessions, sessionID)) return undefined;
  return sessions[sessionID];
}

function copyTotals(source: SessionDirectTotals | undefined): SessionDirectTotals {
  if (!source) return zeroTotals();
  return {
    tokens: addTokenCounts(emptyTokenCounts(), source.tokens),
    cost: source.cost,
    responseCount: source.responseCount,
    ...(source.speed ? { speed: coerceSpeedTotals(source.speed) } : {}),
  };
}

function zeroTotals(): SessionDirectTotals {
  return {
    tokens: emptyTokenCounts(),
    cost: 0,
    responseCount: 0,
  };
}
