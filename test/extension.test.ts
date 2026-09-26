import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import jevContinue from "../src/index.ts";
import { isolateJevLogs } from "./log-environment.ts";
import type { ConversationMessage } from "../src/state.ts";

isolateJevLogs();

type Handler = (event: unknown, ctx: ExtensionCommandContext) => unknown;

function harness(t: TestContext, flags: Record<string, string> = {}) {
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-only-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldKey;
  });
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, ToolDefinition>();
  const sent: string[] = [];
  const entries: { type: string; data: unknown }[] = [];
  let pending = false;
  let status = "";
  let terminal: ((data: string) => unknown) | undefined;
  let aborts = 0;
  let sessionMessages: AgentMessage[] = [];
  // The harness supplies only the context capabilities exercised by this extension.
  const ctx = {
    hasUI: true,
    mode: "tui",
    signal: undefined,
    isIdle: () => true,
    abort() { aborts += 1; },
    hasPendingMessages: () => pending,
    sessionManager: { buildSessionProjection: () => ({ messages: sessionMessages }) },
    ui: {
      notify() {},
      setStatus(_key: string, text: string) { status = text; },
      onTerminalInput(handler: (data: string) => unknown) {
        terminal = handler;
        return () => { terminal = undefined; };
      },
    },
  } as unknown as ExtensionCommandContext;
  // Pi's overloaded registration API is erased only inside this in-process test dispatcher.
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, handler); return () => {}; },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, command); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerFlag() {},
    getFlag(name: string) { return flags[name]; },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendUserMessage(text: string) { sent.push(text); },
  } as unknown as ExtensionAPI;
  jevContinue(pi);
  function emit(name: "agent_before_settle", event: AgentBeforeSettleEvent): Promise<AgentBeforeSettleEventResult | undefined>;
  function emit(name: string, event?: unknown): unknown;
  function emit(name: string, event: unknown = {}): unknown {
    return handlers.get(name)?.(event, ctx);
  }
  const command = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
  emit("session_start", { reason: "startup" });
  t.after(() => { emit("session_shutdown"); });
  return {
    ctx, sent, entries, emit, command,
    async choose(params: unknown) {
      const tool = tools.get("jev_choose");
      assert.ok(tool, "The question must be handled by the autonomous-choice tool");
      return tool.execute("question-1", params, ctx.signal, undefined, ctx);
    },
    aborts: () => aborts,
    setPending(value: boolean) { pending = value; },
    setMessages(messages: AgentMessage[]) { sessionMessages = messages; },
    escape(data = "\u001b") { terminal?.(data); },
    status: () => status,
  };
}

function boundary(outcome: AgentBeforeSettleEvent["outcome"] = "completed"): AgentBeforeSettleEvent {
  const report: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Implemented parser error handling. Next: run parser regression checks." }],
    api: "openai-completions", provider: "openai", model: "test-model", timestamp: 0,
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return {
    type: "agent_before_settle", entries: [], continue: false, outcome,
    context: { contextEntries: [], contextMessages: [report], llmMessages: [], pendingMessages: [], canContinue: false },
  };
}

function answer() {
  return Response.json({
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      next_step: { type: "choice", choice: "verify", confidence: 0.95,
        probabilities: { implement: 0.01, fix: 0.01, verify: 0.96, improve: 0.01, other: 0.01 } },
      needs_human: { type: "noul", noul: 0.01 }, in_scope: { type: "noul", noul: 0.99 },
    },
  });
}

function deferred() {
  return Promise.withResolvers<Response>();
}

test("permits the configured number of continuations then stops without another judgment", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-max", "2");
  await h.command("jev-on", "Improve parser error handling");
  for (let n = 1; n <= 2; n++) {
    const next = await h.emit("agent_before_settle", boundary());
    assert.equal(next?.continue, true);
    assert.match(h.status(), new RegExp(`on ${n}/2`));
  }
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 2);
  assert.match(h.status(), /off.*limit/);
});

test("manual stop cancels an in-flight judgment and late results cannot restart pi", async (t) => {
  const h = harness(t);
  const waiting = deferred();
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (_url: unknown, options?: RequestInit) => { signal = options?.signal ?? undefined; return waiting.promise; });
  await h.command("jev-on", "Improve parser error handling");
  const result = h.emit("agent_before_settle", boundary());
  await h.command("jev-off");
  assert.equal(signal?.aborted, true);
  waiting.resolve(answer());
  assert.equal(await result, undefined);
  assert.equal(h.entries.filter((entry) => entry.type === "jev-judgment").length, 0);
  assert.match(h.status(), /off/);
});

test("Escape cancels Jev even while the provider turn is already complete", async (t) => {
  const h = harness(t);
  const waiting = deferred();
  t.mock.method(globalThis, "fetch", () => waiting.promise);
  await h.command("jev-on", "Improve parser error handling");
  const result = h.emit("agent_before_settle", boundary());
  h.escape();
  waiting.resolve(answer());
  assert.equal(await result, undefined);
  assert.match(h.status(), /off.*Escape/);
});

test("a new session invalidates old judgments without rearming the startup goal", async (t) => {
  const h = harness(t, { "jev-goal": "Improve parser error handling" });
  const waiting = deferred();
  t.mock.method(globalThis, "fetch", () => waiting.promise);
  h.emit("before_agent_start");
  const result = h.emit("agent_before_settle", boundary());
  h.emit("session_start", { reason: "new" });
  waiting.resolve(answer());
  assert.equal(await result, undefined);
  assert.equal(h.emit("before_agent_start"), undefined);
  assert.match(h.status(), /off/);
});

test("interactive and RPC input take precedence over automation", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  for (const source of ["interactive", "rpc"]) {
    await h.command("jev-on", "Improve parser error handling");
    h.emit("input", { source, text: "Stop and explain the changes" });
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.match(h.status(), /off.*input/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("queued input arriving during judgment prevents an automatic turn", async (t) => {
  const h = harness(t);
  const waiting = deferred();
  t.mock.method(globalThis, "fetch", () => waiting.promise);
  await h.command("jev-on", "Improve parser error handling");
  const result = h.emit("agent_before_settle", boundary());
  h.setPending(true);
  waiting.resolve(answer());
  assert.equal(await result, undefined);
  assert.match(h.status(), /off.*queued/);
});

test("agent errors and aborts never become automatic retries", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  for (const outcome of ["aborted", "error"] as const) {
    await h.command("jev-on", "Improve parser error handling");
    assert.equal(await h.emit("agent_before_settle", boundary(outcome)), undefined);
    assert.match(h.status(), /off/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("a failed Jev request disables the loop rather than retrying", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await h.command("jev-on", "Improve parser error handling");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(h.status(), /off/);
});

test("missing credentials never start development or judging", async (t) => {
  const h = harness(t);
  delete process.env.TYPESAFE_API_KEY;
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-on", "Improve parser error handling");
  assert.equal(h.sent.length, 0);
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 0);
});

test("final settlement after a host abort disarms further automatic turns", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-on", "Improve parser error handling");
  h.emit("agent_settled");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(h.status(), /off/);
});

test("an explicit command goal takes precedence over an unused startup goal", async (t) => {
  const h = harness(t, { "jev-goal": "Original CLI goal" });
  await h.command("jev-on", "Improve parser error handling");
  h.emit("before_agent_start");
  let submittedGoal: unknown;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body));
    if (body && typeof body === "object" && "state" in body &&
        body.state && typeof body.state === "object" && "goal" in body.state) {
      submittedGoal = body.state.goal;
    }
    return answer();
  });
  await h.emit("agent_before_settle", boundary());
  assert.equal(submittedGoal, "Improve parser error handling");
});

test("Kitty-encoded Escape stops the loop while arrow keys do not", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-on", "Improve parser error handling");
  h.escape("\u001b[A");
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  h.escape("\u001b[27u");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 1);
});

const implementationQuestion = {
  question: "Which database should this local CLI use?",
  context: "Single process, offline, no database server. Persistent storage is required.",
  options: [
    { label: "PostgreSQL", description: "Requires a separate database server." },
    { label: "SQLite", description: "Embedded persistent storage, without a server." },
  ],
  requiresApproval: false,
};

function questionAnswer() {
  return Response.json({
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      selection: { type: "choice", choice: "option_1", confidence: 0.95,
        probabilities: { option_0: 0.01, option_1: 0.98, defer: 0.01 } },
      needs_human: { type: "noul", noul: 0.01 },
      in_scope_0: { type: "noul", noul: 0.01 },
      in_scope_1: { type: "noul", noul: 0.99 },
    },
  });
}

test("an autonomous question returns the non-first choice without disabling the loop", async (t) => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => questionAnswer());
  await h.command("jev-on", "Build an offline single-process CLI with persistent storage and no database server");
  h.emit("tool_execution_start", { toolName: "jev_choose", args: implementationQuestion });
  const result = await h.choose(implementationQuestion);
  assert.ok(result.details && typeof result.details === "object");
  assert.ok("status" in result.details && result.details.status === "answered");
  assert.ok("source" in result.details && result.details.source === "jev");
  assert.ok("optionIndex" in result.details && result.details.optionIndex === 1);
  assert.notEqual(result.terminate, true);
  assert.match(h.status(), /on/);
});

test("unresolved approval blocks later tools until fresh human input", async (t) => {
  const h = harness(t);
  h.ctx.hasUI = false;
  await h.command("jev-on", "Build an offline CLI");
  const fetch = t.mock.method(globalThis, "fetch", async () => questionAnswer());
  const result = await h.choose({ ...implementationQuestion, requiresApproval: true });
  assert.equal(result.terminate, true);
  assert.equal(fetch.mock.callCount(), 0);
  const blocked = h.emit("tool_call", { toolName: "bash", input: { command: "echo should-not-run" } });
  assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block === true);
  h.emit("turn_end");
  assert.equal(h.aborts(), 1);
  h.emit("input", { source: "interactive", text: "Use SQLite, without destructive changes." });
  assert.equal(h.emit("tool_call", { toolName: "bash", input: { command: "echo allowed" } }), undefined);
});

test("manual stop invalidates an in-flight question without opening a fallback dialog", async (t) => {
  const h = harness(t);
  const waiting = deferred();
  t.mock.method(globalThis, "fetch", () => waiting.promise);
  await h.command("jev-on", "Build an offline CLI");
  const pending = h.choose(implementationQuestion);
  await h.command("jev-off");
  waiting.resolve(questionAnswer());
  const result = await pending;
  assert.equal(result.terminate, true);
  assert.ok(result.details && typeof result.details === "object");
  assert.ok("status" in result.details && result.details.status !== "answered");
  assert.equal(h.entries.filter((entry) => entry.type === "jev-choice-judgment").length, 0);
});

for (const [name, args] of [
  ["too few options", { ...implementationQuestion, options: implementationQuestion.options.slice(0, 1) }],
  ["missing approval flag", { question: implementationQuestion.question, context: implementationQuestion.context, options: implementationQuestion.options }],
] as const) {
  test(`host-rejected question (${name}) stops before execute and blocks later tools`, async (t) => {
    const h = harness(t);
    const fetch = t.mock.method(globalThis, "fetch", async () => questionAnswer());
    await h.command("jev-on", "Build an offline CLI");
    // pi emits this before its schema validation; execute is never called on rejection.
    h.emit("tool_execution_start", { toolName: "jev_choose", args });
    assert.match(h.status(), /off/);
    const blocked = h.emit("tool_call", { toolName: "write", input: { path: "forbidden.txt", content: "not approved" } });
    assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block === true);
    h.emit("turn_end");
    assert.equal(h.aborts(), 1);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.equal(fetch.mock.callCount(), 0);
    h.emit("input", { source: "interactive", text: "Correct the question before continuing." });
    assert.equal(h.emit("tool_call", { toolName: "read", input: { path: "README.md" } }), undefined);
  });
}

test("history configuration limits both judgments and zero disables conversation input", async (t) => {
  const h = harness(t, { "jev-history": "2" });
  const history: AgentMessage[] = [
    { role: "user", content: "Older limit", timestamp: 0 },
    ...boundary().context.contextMessages,
    { role: "user", content: "Do not use SQLite", timestamp: 1 },
  ];
  const captured: ConversationMessage[][] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    captured.push(body.state.conversation);
    return body.questions.selection ? questionAnswer() : answer();
  });
  h.setMessages(history);
  await h.command("jev-on", "Build an offline CLI");
  await h.choose(implementationQuestion);
  const event = boundary();
  event.context.contextMessages = [...history, ...event.context.contextMessages];
  await h.emit("agent_before_settle", event);
  for (const conversation of captured) {
    assert.equal(conversation.length, 2);
    assert.equal(conversation[0].role, "assistant");
    assert.deepEqual(conversation[1], { role: "user", text: "Do not use SQLite" });
  }
  assert.equal(captured.length, 2);
  await h.command("jev-history", "0");
  await h.command("jev-history", "-1");
  await h.choose(implementationQuestion);
  await h.emit("agent_before_settle", event);
  assert.deepEqual(captured.slice(2), [[], []]);
});

test("invalid startup history count does not activate the CLI goal", (t) => {
  const h = harness(t, { "jev-goal": "Build an offline CLI", "jev-history": "1.5" });
  assert.equal(h.emit("before_agent_start"), undefined);
  assert.match(h.status(), /off/);
});

test("question history is rebuilt for a new session rather than reusing previous messages", async (t) => {
  const h = harness(t, { "jev-history": "0" });
  const captured: ConversationMessage[][] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)).state.conversation);
    return questionAnswer();
  });
  h.setMessages([{ role: "user", content: "Old session constraint", timestamp: 0 }]);
  await h.command("jev-on", "Build an offline CLI");
  await h.choose(implementationQuestion);
  h.emit("session_start", { reason: "new" });
  h.setMessages([{ role: "user", content: "New session constraint", timestamp: 1 }]);
  await h.command("jev-on", "Build an offline CLI");
  await h.choose(implementationQuestion);
  assert.deepEqual(captured, [[], [{ role: "user", text: "New session constraint" }]]);
});
