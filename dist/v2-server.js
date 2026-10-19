import { classifyMessageMetadata } from "./scope.js";

/** The Promise plugin API shipped in @opencode/plugin 2.0.27. */

const object = value => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

/** Type-only ingress gate: do not touch data/properties, even for ownership. */
export function isContentOnlyEvent(type) {
  if (typeof type !== "string") return false;
  return type === "message.part.delta" || type === "message.part.updated" || /^session\.(?:next\.)?(?:text|reasoning)\./.test(type) || /^session\.(?:next\.)?tool\.input\./.test(type) || type === "session.tool.progress" || type === "session.next.tool.progress";
}
export function isV2ControlEvent(type) {
  return typeof type === "string" && /^(?:server\.connected|session\.(?:(?:created|forked|metadata\.updated|agent\.selected|renamed|status|idle)|execution\.(?:started|succeeded|failed|interrupted)|retry\.scheduled|step\.(?:started|ended|failed)|tool\.(?:called|success|failed)))$/.test(type);
}

/**
 * V2 has no public message.updated or request-ID events. Each model step is a
 * request, identified by assistantMessageID; execution transitions identify the
 * session, not a message. Keep these identities separate from the envelope id
 * and tool id. UsageUpdated is cumulative and must NOT become another call.
 */
export function createV2EventAdapter() {
  const starts = new Map();
  const current = new Map();
  const executions = new Map();
  const bySession = new Map();
  const works = new Map();
  const stepIDs = new Map();
  const transitions = new Set(); // compact durable identity, not response objects
  let proofWorkChecks = 0;
  const updateWork = (execution, key, work) => {
    const wasReady = works.get(key)?.pureReady === true;
    const ready = work.start !== undefined && work.end !== undefined && ["magic-message", "magic-session"].includes(work.scope.sourceScope);
    proofWorkChecks++;
    if (!execution.works.has(key)) {
      execution.works.add(key);
      if (!ready) execution.unready++;
    } else if (wasReady !== ready) execution.unready += ready ? -1 : 1;
    work.pureReady = ready;
    works.set(key, work);
  };
  const localScope = info => {
    const scope = classifyMessageMetadata(info);
    return scope.sourceScope === "magic-session" ? {
      ...scope,
      sourceScope: "magic-message"
    } : scope;
  };
  const invalidate = sessionID => {
    // A closed execution can still await a late boundary/proof. A transport
    // gap must invalidate that unfinished certificate, not only current work.
    for (const execution of executions.values()) if ((!sessionID || execution.sessionID === sessionID) && !execution.pureEmitted) execution.complete = false;
    for (const [id, execution] of current) if (!sessionID || id === sessionID) {
      execution.complete = false;
      current.delete(id);
    }
    for (const [id, info] of starts) if (!sessionID || info.sessionID === sessionID) starts.delete(id);
  };
  return {
    invalidate,
    clear: () => {
      invalidate();
      works.clear();
      stepIDs.clear();
      executions.clear();
      bySession.clear();
      transitions.clear();
    },
    retainedState: () => ({
      activeResponses: starts.size,
      compactWork: works.size,
      compactExecutions: executions.size,
      durableIdentities: transitions.size,
      proofWorkChecks
    }),
    events(raw) {
      const event = object(raw);
      if (!event || !isV2ControlEvent(event.type)) return [];
      const data = object(event?.data);
      if (!event || !data || typeof event.type !== "string") return [];
      const sessionID = data.sessionID;
      const messageID = data.assistantMessageID;
      const base = {
        id: event.id,
        timestamp: event.created,
        revision: event.durable?.seq,
        sourceEventID: event.id,
        sourceSequence: event.durable?.seq
      };
      const emit = (type, properties) => ({
        ...base,
        type,
        properties
      });
      const identity = {
        sessionID,
        messageID
      };
      const stepIdentity = JSON.stringify([sessionID, messageID]);
      const stepKey = executionID => JSON.stringify(["step", sessionID, executionID, messageID]);
      const knownStep = () => works.get(stepKey(boundaryExecution().id)) ?? works.get(stepIDs.get(stepIdentity) ?? "");
      const sessionMetadata = () => emit("session.updated", {
        sessionID,
        info: {
          id: sessionID,
          agent: data.agent,
          title: data.title,
          ...(Object.prototype.hasOwnProperty.call(data, "parentID") || Object.prototype.hasOwnProperty.call(data, "parentSessionID") ? {
            parentID: data.parentID ?? data.parentSessionID
          } : {}),
          metadata: {
            magic_context: data.metadata?.magic_context,
            role: data.metadata?.role
          }
        }
      });
      const partial = () => {
        let execution = current.get(sessionID);
        if (!execution) {
          execution = {
            id: `partial:${event.id}`,
            sessionID,
            complete: false,
            works: new Set(),
            unready: 0
          };
          current.set(sessionID, execution);
          executions.set(execution.id, execution);
        }
        return execution;
      };
      const boundaryExecution = () => {
        const sequence = event.durable?.seq;
        const history = bySession.get(sessionID) ?? [];
        for (let index = history.length - 1; index >= 0; index--) {
          const candidate = history[index];
          if (typeof sequence === "number" && candidate.sourceSequence !== undefined ? candidate.sourceSequence <= sequence : candidate.startedAt !== undefined && candidate.startedAt <= event.created) return candidate;
        }
        return current.get(sessionID) ?? partial();
      };
      const fact = (value, timestamp = event.created) => emit("pulse.activity", {
        sessionID,
        fact: {
          ...value,
          sessionID,
          timestamp,
          sourceEventID: event.id,
          sourceSequence: event.durable?.seq,
          eventID: `oc-tps:work:${event.id}:${value.kind}:${value.workID ?? value.executionID}:${value.phase ?? "scope"}`
        }
      });
      const workFact = (work, phase) => fact({
        kind: "work",
        executionID: work.executionID,
        workID: work.workID,
        source: work.source,
        phase,
        stepID: work.stepID,
        measurementScope: work.scope
      }, work[phase]);
      const pure = execution => {
        if (execution.pureEmitted || !execution.complete || execution.terminal === undefined || !execution.works.size || execution.unready) return [];
        execution.pureEmitted = true;
        const proof = fact({
          kind: "execution-scope",
          executionID: execution.id,
          classification: "pure-maintenance",
          coverage: "complete"
        }, execution.terminal);
        proof.properties.fact.eventID = `oc-tps:execution-scope:${JSON.stringify([sessionID, execution.id, "pure-maintenance"])}`;
        return [proof];
      };
      switch (event.type) {
        case "session.created":
        case "session.forked":
        case "session.metadata.updated":
        case "session.agent.selected":
        case "session.renamed":
          return [sessionMetadata()];
        case "session.execution.started":
          {
            if (typeof event.id !== "string" || transitions.has(event.id)) return [];
            transitions.add(event.id);
            const previous = current.get(sessionID);
            const newer = !previous || (typeof event.durable?.seq === "number" && previous.sourceSequence !== undefined ? event.durable.seq > previous.sourceSequence : event.created >= (previous.startedAt ?? -Infinity));
            const execution = {
              id: event.id,
              sessionID,
              complete: newer,
              works: new Set(),
              unready: 0,
              startedAt: event.created,
              sourceSequence: event.durable?.seq
            };
            if (newer) current.set(sessionID, execution);
            executions.set(execution.id, execution);
            const history = bySession.get(sessionID) ?? [];
            const compare = (a, b) => a.sourceSequence !== undefined && b.sourceSequence !== undefined ? a.sourceSequence - b.sourceSequence : (a.startedAt ?? 0) - (b.startedAt ?? 0);
            if (!history.length || compare(history.at(-1), execution) <= 0) history.push(execution);else {
              const index = history.findIndex(candidate => compare(candidate, execution) > 0);
              history.splice(index, 0, execution);
            }
            bySession.set(sessionID, history);
            return [{
              ...emit("session.status", {
                sessionID,
                status: {
                  type: "busy"
                }
              }),
              executionID: execution.id
            }];
          }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          {
            if (typeof event.id !== "string" || transitions.has(event.id)) return [];
            transitions.add(event.id);
            const execution = boundaryExecution();
            execution.terminal = event.created;
            if (current.get(sessionID) === execution) current.delete(sessionID);
            for (const key of execution.works) starts.delete(key);
            const type = event.type.endsWith("succeeded") ? "session.completed" : event.type.endsWith("failed") ? "session.error" : "session.aborted";
            return [{
              ...emit(type, {
                sessionID
              }),
              executionID: execution.id
            }, ...pure(execution)];
          }
        case "session.retry.scheduled":
          return [{
            ...emit("session.next.retried", identity),
            executionID: boundaryExecution().id
          }];
        case "session.step.started":
          {
            if (typeof messageID !== "string" || typeof sessionID !== "string") {
              const execution = current.get(sessionID);
              if (execution) execution.complete = false;
              return [];
            }
            const info = {
              id: messageID,
              sessionID,
              role: "assistant",
              agent: data.agent,
              // V2 Model.Ref uses id; expose the legacy alias only on the
              // normalized info used by the shared scope classifier.
              model: {
                providerID: data.model?.providerID,
                id: data.model?.id,
                modelID: data.model?.id
              },
              time: {
                created: data.started
              }
            };
            const history = bySession.get(sessionID) ?? [];
            let startedExecution;
            if (typeof data.started === "number") for (let index = history.length - 1; index >= 0; index--) {
              const candidate = history[index];
              if (candidate.startedAt !== undefined && candidate.startedAt <= data.started) {
                startedExecution = candidate;
                break;
              }
            }
            const execution = startedExecution ?? boundaryExecution();
            const known = works.get(stepKey(execution.id));
            const key = stepKey(execution.id);
            starts.delete(key);
            if (known?.end === undefined && execution.terminal === undefined) starts.set(key, info);
            const work = {
              ...known,
              sessionID,
              executionID: execution.id,
              workID: messageID,
              source: "step",
              start: data.started ?? event.created,
              scope: localScope(info),
              model: info.model,
              agent: info.agent
            };
            updateWork(execution, key, work);
            stepIDs.set(stepIdentity, key);
            const proofs = [workFact(work, "start")];
            if (work.end !== undefined) proofs.push(workFact(work, "end"));
            for (const key of execution.works) {
              const tool = works.get(key);
              if (tool.source !== "tool" || tool.stepID !== messageID) continue;
              tool.scope = work.scope;
              updateWork(execution, key, tool);
              if (tool.start !== undefined) proofs.push(workFact(tool, "start"));
              if (tool.end !== undefined) proofs.push(workFact(tool, "end"));
            }
            return [emit("message.updated", {
              sessionID,
              messageID,
              info,
              executionID: execution.id
            }), emit("session.next.step.started", {
              sessionID,
              messageID,
              stepID: messageID
            }), ...proofs, ...pure(execution)];
          }
        case "session.step.ended":
        case "session.step.failed":
          {
            if (typeof messageID !== "string" || typeof sessionID !== "string") {
              const execution = current.get(sessionID);
              if (execution) execution.complete = false;
              return [];
            }
            const known = knownStep();
            const execution = known ? executions.get(known.executionID) : boundaryExecution();
            const key = stepKey(execution.id);
            const start = starts.get(key) ?? (known ? {
              agent: known.agent,
              model: known.model,
              time: {
                created: known.start
              }
            } : undefined);
            starts.delete(key);
            const failed = event.type === "session.step.failed";
            let work = known;
            if (!work) {
              work = {
                sessionID,
                executionID: execution.id,
                workID: messageID,
                source: "step",
                scope: localScope({
                  role: "assistant"
                })
              };
              stepIDs.set(stepIdentity, key);
            }
            work.end = event.created;
            updateWork(execution, key, work);
            const proof = workFact(work, "end");
            // A failed step may have no billable usage. Do not invent an exact zero
            // call, nor close execution while a retry/continuation can still run.
            if (failed && !object(data.tokens)) return [emit("session.step.failed", identity), proof, ...pure(execution)];
            const info = {
              ...start,
              id: messageID,
              sessionID,
              role: "assistant",
              tokens: data.tokens,
              cost: data.cost,
              finish: data.finish,
              time: {
                ...start?.time,
                completed: event.created
              }
            };
            return [...(failed ? [emit("session.step.failed", identity)] : []), emit("message.updated", {
              sessionID,
              messageID,
              info,
              executionID: execution.id,
              // Canonical durable data is stable even if setup restarted and
              // the start-metadata cache no longer contains this request.
              v2Completion: {
                sessionID,
                messageID,
                tokens: data.tokens,
                cost: data.cost,
                finish: data.finish,
                created: event.created
              }
            }), proof, ...pure(execution)];
          }
        case "session.tool.called":
        case "session.tool.success":
        case "session.tool.failed":
          {
            if (typeof data.id !== "string" || typeof sessionID !== "string") {
              const execution = current.get(sessionID);
              if (execution) execution.complete = false;
              return [];
            }
            const step = knownStep();
            const execution = step ? executions.get(step.executionID) : boundaryExecution();
            const key = JSON.stringify(["tool", sessionID, execution.id, step?.workID ?? messageID ?? null, data.id]);
            let tool = works.get(key);
            if (!tool) tool = {
              sessionID,
              executionID: execution.id,
              workID: data.id,
              source: "tool",
              stepID: step?.workID ?? messageID,
              scope: step?.scope ?? localScope({
                role: "assistant"
              })
            };
            const phase = event.type === "session.tool.called" ? "start" : "end";
            tool[phase] = event.created;
            updateWork(execution, key, tool);
            return [workFact(tool, phase), emit("pulse.tool", {
              sessionID,
              messageID,
              executionID: execution.id,
              stepID: tool.stepID,
              toolID: data.id,
              pending: phase === "start" && tool.end === undefined && execution.terminal === undefined
            }), ...pure(execution)];
          }
        case "session.status":
        case "session.idle":
          return [{
            ...emit(event.type, {
              sessionID,
              status: data.status,
              state: data.state
            }),
            executionID: boundaryExecution().id
          }];
        case "server.connected":
          return [emit(event.type, {})];
        default:
          // Streamed is NOT completed (tools may still be running). Compaction,
          // title and cumulative usage are not primary assistant requests.
          return [];
      }
    }
  };
}

/** No ctx.session.status/active exists in the 2.0.27 plugin domain. A fresh get
 * can prove terminal execution only with its outcome and idle watermark. */
export async function readV2Idle(ctx, sessionID, signal) {
  if (signal.aborted) return;
  const session = await ctx.session.get({
    sessionID
  }, {
    signal
  });
  if (signal.aborted || session.id !== sessionID || session.location.directory !== ctx.location.directory) return;
  const timestamp = session.time.idle;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
  const state = session.outcome === "succeeded" ? "completed" : session.outcome === "failed" ? "failed" : session.outcome === "interrupted" ? "aborted" : undefined;
  return state ? {
    state,
    timestamp
  } : undefined;
}
