/** The Promise plugin API shipped in @opencode/plugin 2.0.27. */

const object = value => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

/**
 * V2 has no public message.updated or request-ID events. Each model step is a
 * request, identified by assistantMessageID; execution transitions identify the
 * session, not a message. Keep these identities separate from the envelope id
 * and tool id. UsageUpdated is cumulative and must NOT become another call.
 */
export function createV2EventAdapter() {
  const starts = new Map();
  return {
    clear: () => starts.clear(),
    events(raw) {
      const event = object(raw);
      const data = object(event?.data);
      if (!event || !data || typeof event.type !== "string") return [];
      const sessionID = data.sessionID;
      const messageID = data.assistantMessageID;
      const base = {
        ...event,
        timestamp: event.created,
        revision: event.durable?.seq
      };
      const emit = (type, properties) => ({
        ...base,
        type,
        properties
      });
      const identity = {
        ...data,
        messageID
      };
      const sessionMetadata = () => emit("session.updated", {
        sessionID,
        info: {
          ...data,
          id: sessionID
        }
      });
      switch (event.type) {
        case "session.created":
        case "session.forked":
        case "session.metadata.updated":
        case "session.agent.selected":
        case "session.renamed":
          return [sessionMetadata()];
        case "session.execution.started":
          return [emit("session.status", {
            sessionID,
            status: {
              type: "busy"
            }
          })];
        case "session.execution.succeeded":
          return [emit("session.completed", {
            sessionID
          })];
        case "session.execution.failed":
          return [emit("session.error", data)];
        case "session.execution.interrupted":
          return [emit("session.aborted", data)];
        case "session.retry.scheduled":
          return [emit("session.next.retried", identity)];
        case "session.step.started":
          {
            if (typeof messageID !== "string" || typeof sessionID !== "string") return [];
            const info = {
              id: messageID,
              sessionID,
              role: "assistant",
              agent: data.agent,
              // V2 Model.Ref uses id; expose the legacy alias only on the
              // normalized info used by the shared scope classifier.
              model: {
                ...data.model,
                modelID: data.model?.id
              },
              time: {
                created: data.started
              },
              metadata: event.metadata
            };
            starts.delete(messageID);
            starts.set(messageID, info);
            while (starts.size > 2048) starts.delete(starts.keys().next().value);
            return [emit("message.updated", {
              sessionID,
              messageID,
              info
            }), emit("session.next.step.started", {
              sessionID,
              messageID,
              stepID: messageID
            })];
          }
        case "session.step.ended":
        case "session.step.failed":
          {
            if (typeof messageID !== "string" || typeof sessionID !== "string") return [];
            const start = starts.get(messageID);
            const failed = event.type === "session.step.failed";
            // A failed step may have no billable usage. Do not invent an exact zero
            // call, nor close execution while a retry/continuation can still run.
            if (failed && !object(data.tokens)) return [emit("session.step.failed", identity)];
            const info = {
              ...start,
              id: messageID,
              sessionID,
              role: "assistant",
              tokens: data.tokens,
              cost: data.cost,
              finish: data.finish,
              error: data.error,
              time: {
                ...start?.time,
                completed: event.created
              }
            };
            return [...(failed ? [emit("session.step.failed", identity)] : []), emit("message.updated", {
              sessionID,
              messageID,
              info,
              // Canonical durable data is stable even if setup restarted and
              // the start-metadata cache no longer contains this request.
              v2Completion: {
                data,
                created: event.created
              }
            })];
          }
        case "session.text.delta":
        case "session.reasoning.delta":
        case "session.tool.input.delta":
          return [emit(event.type.replace("session.", "session.next."), identity)];
        case "session.text.started":
        case "session.reasoning.started":
        case "session.text.ended":
        case "session.reasoning.ended":
          {
            const kind = event.type.includes("reasoning") ? "reasoning" : "text";
            return [emit("message.part.updated", {
              sessionID,
              messageID,
              part: {
                id: `${messageID}:${kind}:${data.ordinal}`,
                messageID,
                sessionID,
                type: kind,
                text: data.text ?? "",
                time: event.type.endsWith(".started") ? {
                  start: event.created
                } : {
                  end: event.created
                }
              }
            })];
          }
        case "session.tool.input.started":
        case "session.tool.called":
        case "session.tool.progress":
        case "session.tool.success":
        case "session.tool.failed":
          return [emit("message.part.updated", {
            sessionID,
            messageID,
            part: {
              id: `${messageID}:tool:${data.id}`,
              messageID,
              sessionID,
              type: "tool",
              state: {
                status: event.type === "session.tool.success" ? "completed" : event.type === "session.tool.failed" ? "error" : "running"
              }
            }
          })];
        case "session.status":
        case "session.idle":
          return [emit(event.type, data)];
        case "server.connected":
          return [emit(event.type, data)];
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
