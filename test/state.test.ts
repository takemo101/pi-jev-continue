import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildState } from "../src/state.ts";

type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

function assistant(text: string, stopReason: Assistant["stopReason"] = "stop"): Assistant {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

const user: AgentMessage = { role: "user", content: "Implement the requested feature", timestamp: 0 };

function tool(name: string, output: string, isError = false): ToolResult {
  return {
    role: "toolResult",
    toolCallId: `call-${name}`,
    toolName: name,
    content: [{ type: "text", text: output }],
    details: { privateMetadata: "not judgment input" },
    isError,
    timestamp: 0,
  };
}

test("does not reuse a report from before the latest user prompt", () => {
  assert.throws(() => buildState("Goal", [user, assistant("Old report"), user], null, 1));
  assert.throws(() => buildState("Goal", [user, tool("read", "No report yet")], null, 1));
});

test("fails closed on the latest incomplete or failed assistant instead of reusing an older report", () => {
  const stopReasons: Assistant["stopReason"][] = ["error", "aborted", "toolUse", "length", "pending", "deferred"];
  for (const stopReason of stopReasons) {
    assert.throws(
      () => buildState("Goal", [user, assistant("Earlier report"), assistant("Partial report", stopReason)], null, 1),
      stopReason,
    );
  }
});

test("rejects empty or oversized goals and reports without silently truncating", () => {
  for (const goal of ["", " \n\t", "g".repeat(4001)]) {
    assert.throws(() => buildState(goal, [user, assistant("Report")], null, 1));
  }
  for (const report of ["", " \n\t", "r".repeat(12001)]) {
    assert.throws(() => buildState("Goal", [user, assistant("Old report"), assistant(report)], null, 1));
  }
  const goal = "g".repeat(4000);
  const report = "r".repeat(12000);
  const state = buildState(goal, [user, assistant(report)], null, 1);
  assert.equal(state.goal, goal);
  assert.equal(state.latestReport, report);
});

test("extracts report text and tool text without thinking, arguments, images, or details", () => {
  const report = assistant("unused");
  report.content = [
    { type: "thinking", thinking: "Private reasoning", thinkingSignature: "private signature" },
    { type: "text", text: "Implemented feature." },
    { type: "toolCall", id: "call-read", name: "read", arguments: { secret: "private argument" } },
    { type: "text", text: "Verified behavior." },
  ];
  const result = tool("read", "Textual evidence");
  result.content.push({ type: "image", data: "private image data", mimeType: "image/png" });
  assert.deepEqual(buildState("Goal", [user, result, report], "Earlier report", 3), {
    goal: "Goal",
    latestReport: "Implemented feature.\nVerified behavior.",
    previousReport: "Earlier report",
    conversation: [{ role: "user", text: "Implement the requested feature" }],
    recentTools: [{ name: "read", isError: false, output: "Textual evidence", truncated: false }],
    iteration: 3,
  });
});

test("does not treat thinking-only or tool-call-only assistant content as a report", () => {
  const report = assistant("unused");
  report.content = [{ type: "thinking", thinking: "Not a public report" }];
  assert.throws(() => buildState("Goal", [user, assistant("Older text"), report], null, 1));
  report.content = [{ type: "toolCall", id: "call", name: "read", arguments: {} }];
  assert.throws(() => buildState("Goal", [user, assistant("Older text"), report], null, 1));
});

test("keeps only the last six tools in chronological order within the current report boundary", () => {
  const currentTools = Array.from({ length: 8 }, (_, index) => tool(`tool-${index}`, `result-${index}`, index === 6));
  currentTools[6]!.content = [{ type: "text", text: "x".repeat(2001) }];
  currentTools[7]!.content = [{ type: "text", text: "y".repeat(2000) }];
  const state = buildState("Goal", [
    tool("old-tool", "Old evidence"),
    assistant("Old report"),
    user,
    ...currentTools,
    assistant("Current report"),
    tool("future-tool", "Not evidence for the current report"),
  ], null, 1);
  assert.deepEqual(state.recentTools, [
    { name: "tool-2", isError: false, output: "result-2", truncated: false },
    { name: "tool-3", isError: false, output: "result-3", truncated: false },
    { name: "tool-4", isError: false, output: "result-4", truncated: false },
    { name: "tool-5", isError: false, output: "result-5", truncated: false },
    { name: "tool-6", isError: true, output: "x".repeat(2000), truncated: true },
    { name: "tool-7", isError: false, output: "y".repeat(2000), truncated: false },
  ]);
});

test("accepts an active compacted boundary without a surviving user message", () => {
  const state = buildState("Goal", [tool("check", "Verified"), assistant("Completed report")], null, 1);
  assert.equal(state.latestReport, "Completed report");
  assert.deepEqual(state.recentTools, [{ name: "check", isError: false, output: "Verified", truncated: false }]);
});

test("excludes tool results from before the newest user message even when fewer than six remain", () => {
  const state = buildState("Goal", [
    user,
    tool("old-check", "Outdated verification"),
    assistant("Old report"),
    user,
    tool("current-check", "Current verification"),
    assistant("Current report"),
  ], null, 1);
  assert.equal(state.latestReport, "Current report");
  assert.deepEqual(state.recentTools, [
    { name: "current-check", isError: false, output: "Current verification", truncated: false },
  ]);
});

test("rejects an oversized combined state including multibyte text", () => {
  assert.throws(() => buildState("Goal", [assistant("日".repeat(9000))], null, 1));
  assert.throws(() => buildState("Goal", [assistant("x".repeat(12000))], "y".repeat(12000), 2));
});

test("includes the last ten public conversation messages before the current report", () => {
  const messages: AgentMessage[] = Array.from({ length: 14 }, (_, index) =>
    index % 2 === 0 ? { role: "user", content: `Constraint ${index}`, timestamp: index } : assistant(`Proposal ${index}`),
  );
  const state = buildState("Goal", [...messages, assistant("Current report")], null, 1);
  assert.deepEqual(state.conversation, Array.from({ length: 10 }, (_, offset) => {
    const index = offset + 4;
    return { role: index % 2 === 0 ? "user" : "assistant", text: `${index % 2 === 0 ? "Constraint" : "Proposal"} ${index}` };
  }));
});

test("conversation excludes non-public blocks and does not let empty messages consume the limit", () => {
  const mixed = assistant("unused", "toolUse");
  mixed.content = [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "Proposed approach" },
    { type: "toolCall", id: "call", name: "read", arguments: { secret: "private argument" } },
  ];
  const hidden = assistant(" \n ");
  hidden.content.push({ type: "thinking", thinking: "more private reasoning" });
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "Do not use SQLite" }, { type: "image", data: "private image", mimeType: "image/png" }], timestamp: 0 },
    mixed, tool("read", "private tool output"), hidden, assistant("Current report"),
  ];
  assert.deepEqual(buildState("Goal", messages, null, 1, 2).conversation, [
    { role: "user", text: "Do not use SQLite" },
    { role: "assistant", text: "Proposed approach" },
  ]);
  assert.deepEqual(buildState("Goal", messages, null, 1, 0).conversation, []);
});

test("oversized selected history rejects instead of dropping or clipping user constraints", () => {
  const history: AgentMessage[] = [{ role: "user", content: "制".repeat(8000), timestamp: 0 }, assistant("Current report")];
  assert.throws(() => buildState("Goal", history, null, 1), /byte.*budget/);
  assert.equal(buildState("Goal", history, null, 1, 0).latestReport, "Current report");
});
