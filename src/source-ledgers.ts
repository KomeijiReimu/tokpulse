import { isDeepStrictEqual } from "node:util";
import { normalizeAgentNames } from "./agent-names.js";
import { addTokenCounts, emptyTokenCounts } from "./core.js";
import { mergeScopeEvidence } from "./scope.js";
import { addSpeedTotals, emptySpeedTotals, GENERATION_BASIS_VERSION, isNewerCompletionUpdate, updateSpeedTotals } from "./statistics.js";
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
    const snapshots = copies.map((copy) => {
      const next = copy.contribution;
      if (next === true) throw new Error(`Cannot merge overlapping legacy settled contribution: ${messageID}`);
      if (!next.excluded) adjustContribution(merged, next, -1);
      return { contribution: next, settled: copy.settled, value: next.excluded ? null : {
        sessionID: next.sessionID, tokens: next.tokens, cost: next.cost,
        speed: updateSpeedTotals(undefined, next.speed, 1) ?? emptySpeedTotals(),
      } };
    });
    // Exclusion is sticky; quality wins before revision, even for newer provisional copies.
    const excluded = snapshots.filter((copy) => copy.contribution.excluded);
    const eligible = excluded.length ? excluded : snapshots;
    const exact = eligible.filter((copy) => copy.contribution.quality === "exact");
    const candidates = exact.length ? exact : eligible;
    // Compare against every copy rather than throwing on the first ambiguous pair:
    // a third, authoritative update can resolve both older conflicting snapshots.
    const winners = candidates.filter((copy) => candidates.every((other) =>
      isDeepStrictEqual(copy.value, other.value) || supersedesContribution(copy.contribution, other.contribution)));
    if (!winners.length) throw new Error(`Cannot merge conflicting totals contribution without comparable update: ${messageID}`);
    const latest = winners.filter((copy) => !winners.some((other) => supersedesContribution(other.contribution, copy.contribution)));
    // Only equivalent effective contributions reach this tie-break. Keep metadata
    // deterministic without using usage volume or physical source order as authority.
    const equivalent = latest.length ? latest : winners;
    equivalent.sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    let { contribution } = equivalent[0];
    const { settled } = equivalent[0];
    if (excluded.length) {
      const proofs = excluded.map((copy) => copy.contribution.excluded!);
      proofs.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      contribution = { ...contribution, excluded: proofs.reduce((previous, next) => mergeScopeEvidence(previous, next)) };
    }
    if (!contribution.excluded) adjustContribution(merged, contribution, 1);
    if (settled || contribution.excluded) merged.settled[messageID] = contribution;
    else merged.open[messageID] = contribution;
  }
  return merged;
}

function supersedesContribution(next: OpenContribution, previous: OpenContribution): boolean {
  if (next.update && previous.update) {
    // Ingress timestamps can tie across instances; mutual "newer" is not evidence.
    return isNewerCompletionUpdate(next.update, previous.update) && !isNewerCompletionUpdate(previous.update, next.update);
  }
  if (next.update || previous.update) return !!next.update;
  return false;
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
