import { normalizeAgentNames } from "./agent-names.js";
import { addTokenCounts, emptyTokenCounts } from "./core.js";
import { mergeScopeEvidence } from "./scope.js";
import { addSpeedTotals, GENERATION_BASIS_VERSION, isNewerCompletionUpdate, updateSpeedTotals } from "./statistics.js";
import { projectTotalsGenerationBasis, TOTALS_VERSION, type OpenContribution, type SessionDirectTotals, type TotalsLedger } from "./totals-storage.js";

/** Read-only union of distinct, already validated physical totals files.
 * Cumulative session baselines retain usage outside the history window; only
 * overlapping reversible message snapshots are removed and counted once. */
export function mergeTotalsSources(ledgers: readonly TotalsLedger[]): TotalsLedger {
  if (ledgers.length === 1) return ledgers[0];
  const merged: TotalsLedger = {
    version: TOTALS_VERSION,
    generationBasisVersion: GENERATION_BASIS_VERSION,
    sessions: Object.create(null),
    open: Object.create(null),
    settled: Object.create(null),
  };
  const messages = new Map<string, { contribution: OpenContribution | true; settled: boolean }[]>();
  for (const source of ledgers) {
    const ledger = projectTotalsGenerationBasis(source);
    for (const [sessionID, incoming] of Object.entries(ledger.sessions)) {
      const previous = merged.sessions[sessionID];
      merged.sessions[sessionID] = previous ? {
        tokens: addTokenCounts(previous.tokens, incoming.tokens),
        cost: previous.cost + incoming.cost,
        responseCount: previous.responseCount + incoming.responseCount,
        ...(previous.speed || incoming.speed ? { speed: addSpeedTotals(previous.speed, incoming.speed) } : {}),
      } : incoming;
    }
    for (const field of ["sessionScopes", "messageScopes"] as const) {
      if (!ledger[field]) continue;
      const scopes = merged[field] ??= Object.create(null);
      for (const [id, proof] of Object.entries(ledger[field])) scopes[id] = mergeScopeEvidence(scopes[id], proof);
    }
    if (ledger.sessionAgents) {
      const agents = merged.sessionAgents ??= Object.create(null);
      for (const [sessionID, names] of Object.entries(ledger.sessionAgents)) {
        agents[sessionID] = normalizeAgentNames([...(agents[sessionID] ?? []), ...names]);
      }
    }
    // Settled takes precedence just as it does when applying a live record.
    const snapshots = new Map(Object.entries(ledger.open).map(([id, contribution]) => [id, { contribution: contribution as OpenContribution | true, settled: false }]));
    for (const [id, contribution] of Object.entries(ledger.settled)) snapshots.set(id, { contribution, settled: true });
    for (const [id, snapshot] of snapshots) {
      const copies = messages.get(id);
      if (copies) copies.push(snapshot);
      else messages.set(id, [snapshot]);
    }
  }

  for (const [messageID, copies] of messages) {
    if (copies.length === 1) {
      const { contribution, settled } = copies[0];
      if (settled) merged.settled[messageID] = contribution;
      else merged.open[messageID] = contribution as OpenContribution;
      continue;
    }
    let winner: { contribution: OpenContribution; settled: boolean } | undefined;
    for (const copy of copies) {
      const next = copy.contribution;
      if (next === true) throw new Error(`Cannot merge overlapping legacy settled contribution: ${messageID}`);
      if (!next.excluded) adjustContribution(merged, next, -1);
      if (!winner) {
        winner = { contribution: next, settled: copy.settled };
        continue;
      }
      const previous = winner.contribution;
      if (next.excluded) {
        winner = { contribution: { ...next, excluded: mergeScopeEvidence(previous.excluded, next.excluded) }, settled: true };
        continue;
      }
      if (previous.excluded || (previous.quality === "exact" && next.quality === "provisional")) continue;
      if (!next.update && ((previous.update && previous.quality === next.quality) || previous.speedBackfill)) continue;
      if (next.update) {
        if (previous.update && !isNewerCompletionUpdate(next.update, previous.update)) continue;
      }
      winner = { contribution: next, settled: copy.settled };
    }
    const { contribution, settled } = winner!;
    if (!contribution.excluded) adjustContribution(merged, contribution, 1);
    if (settled || contribution.excluded) merged.settled[messageID] = contribution;
    else merged.open[messageID] = contribution;
  }
  return merged;
}

function adjustContribution(ledger: TotalsLedger, contribution: OpenContribution, sign: 1 | -1): void {
  const session: SessionDirectTotals = ledger.sessions[contribution.sessionID] ??= {
    tokens: emptyTokenCounts(), cost: 0, responseCount: 0,
  };
  for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
    session.tokens[field] = Math.max(0, session.tokens[field] + sign * contribution.tokens[field]);
  }
  session.cost = Math.max(0, session.cost + sign * contribution.cost);
  session.responseCount = Math.max(0, session.responseCount + sign);
  session.speed = updateSpeedTotals(session.speed, contribution.speed, sign);
}
