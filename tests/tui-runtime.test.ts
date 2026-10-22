import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import assert from "node:assert/strict";
import test from "node:test";
import type { TokenCounts } from "../src/core.js";
import {
  buildSessionDetailsTree, cacheSessionParentFromEvent, createRuntimeStore,
  handleSessionLifecycle, selectSessionDetails,
} from "../src/tui.js";

function tokens(output: number, reasoning = 0): TokenCounts {
  return {
    input: 10,
    output,
    reasoning,
    cacheRead: 2,
    cacheWrite: 1,
  };
}

test("session lifecycle keeps an unknown child's idle event before busy", () => {
  const store = createRuntimeStore(10, 0);
  const api = {} as TuiPluginApi;
  handleSessionLifecycle(store, api, "session.idle", { sessionID: "child" }, {
    type: "session.idle",
    timestamp: 100,
    properties: { sessionID: "child" },
  }, 4);
  handleSessionLifecycle(store, api, "session.status", { sessionID: "child", status: "busy" }, {
    type: "session.status",
    timestamp: 200,
    properties: { sessionID: "child", status: "busy" },
  }, 4);
  handleSessionLifecycle(store, api, "session.idle", { sessionID: "child" }, {
    type: "session.idle",
    timestamp: 500,
    properties: { sessionID: "child" },
  }, 4);
  assert.equal(store.taskRuns.get("child")?.lastRunWallTime?.wallTime, 300);
  store.disposeSignals();
});

test("message parentID is not treated as a session parent", () => {
  const store = createRuntimeStore(10);
  assert.equal(cacheSessionParentFromEvent(store, {
    type: "message.updated",
    properties: { info: { id: "message", sessionID: "child", parentID: "parent-message" } },
  }), false);
  assert.equal(store.sessionParents.has("child"), false);
  store.disposeSignals();
});

test("details tree traverses empty intermediate parents, visits cycles once and handles empty/no-child scopes", () => {
  const store = createRuntimeStore(1);
  store.totalsLedger.sessions.child = { tokens: tokens(12, 3), cost: 1, responseCount: 1 };
  store.sessionParents = new Map([["middle", "root"], ["child", "middle"], ["root", "child"], ["self", "self"]]);
  const tree = buildSessionDetailsTree(store, "root");
  assert.deepEqual(tree.nodes.map((node) => [node.sessionID, node.depth]), [["root", 0], ["middle", 1], ["child", 2]]);
  assert.equal(tree.including.tokens.output + tree.including.tokens.reasoning, 15);
  assert.equal(tree.including.responseCount, 1);
  assert.equal(selectSessionDetails(tree, "middle", store.lastCompletedBySession).last, undefined);
  const empty = buildSessionDetailsTree(store, "empty");
  assert.deepEqual(empty.nodes.map((node) => node.sessionID), ["empty"]);
  assert.equal(empty.including.responseCount, 0);
  assert.equal(empty.including.tokens.output + empty.including.tokens.reasoning, 0);
  assert.equal(buildSessionDetailsTree(store, "self").nodes.length, 1);
  store.disposeSignals();
});
