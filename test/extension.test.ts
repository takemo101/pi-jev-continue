import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import jevContinue from "../src/index.ts";
import { isolateJevLogs } from "./log-environment.ts";
import type { ConversationMessage } from "../src/state.ts";
import type { HumanAnswer } from "../src/human-question.ts";

isolateJevLogs();

type Handler = (event: unknown, ctx: ExtensionCommandContext) => unknown;

function harness(t: TestContext, flags: Record<string, string> = {}, mode: ExtensionCommandContext["mode"] = "rpc") {
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldHome = process.env.HOME;
  const root = mkdtempSync(join(tmpdir(), "jev-extension-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".pi"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  process.env.HOME = home;
  process.env.TYPESAFE_API_KEY = "test-only-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldKey;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, ToolDefinition>();
  const sent: string[] = [];
  const entries: { type: string; data: unknown }[] = [];
  const notifications: string[] = [];
  let pending = false;
  let status = "";
  let terminal: ((data: string) => unknown) | undefined;
  let aborts = 0;
  let sessionMessages: AgentMessage[] = [];
  let select: (options: string[]) => Promise<string | undefined> = async () => undefined;
  let input: () => Promise<string | undefined> = async () => undefined;
  let custom: (() => Promise<HumanAnswer | undefined>) | undefined;
  const noteOpened = Promise.withResolvers<void>();
  const customOpened = Promise.withResolvers<void>();
  const dialogOpened = Promise.withResolvers<string[]>();
  // The harness supplies only the context capabilities exercised by this extension.
  const ctx = {
    cwd,
    hasUI: true,
    mode,
    signal: undefined,
    isIdle: () => true,
    abort() { aborts += 1; },
    hasPendingMessages: () => pending,
    sessionManager: { buildSessionProjection: () => ({ messages: sessionMessages }) },
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus(_key: string, text: string) { status = text; },
      select(_title: string, options: string[]) {
        dialogOpened.resolve(options);
        return select(options);
      },
      input() {
        noteOpened.resolve();
        return input();
      },
      custom() {
        if (!custom) throw new Error("This test must explicitly configure its custom TUI dialog.");
        customOpened.resolve();
        return custom();
      },
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
    pi, ctx, home, sent, entries, notifications, emit, command, dialogOpened, noteOpened, customOpened,
    setSelect(handler: (options: string[]) => Promise<string | undefined>) { select = handler; },
    setInput(handler: () => Promise<string | undefined>) { input = handler; },
    setCustom(handler: () => Promise<HumanAnswer | undefined>) { custom = handler; },
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

function answer(choice: "verify" | "other" = "verify", confidence = 0.95, needsHuman = 0.01, inScope = 0.99) {
  return Response.json({
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      next_step: { type: "choice", choice, confidence,
        probabilities: { implement: 0.01, fix: 0.01, verify: choice === "verify" ? 0.96 : 0.01, improve: 0.01, other: choice === "other" ? 0.96 : 0.01 } },
      needs_human: { type: "noul", noul: needsHuman }, in_scope: { type: "noul", noul: inScope },
    },
  });
}

function deferred() {
  return Promise.withResolvers<Response>();
}

for (const source of ["interactive", "rpc"]) {
  test(`a Jev stop keeps automation enabled for the next ${source} conversation`, async (t) => {
    const h = harness(t);
    let judgments = 0;
    const fetch = t.mock.method(globalThis, "fetch", async () => answer(++judgments === 2 ? "other" : "verify"));
    await h.command("jev-max", "2");
    await h.command("jev-on", "Improve parser error handling");
    h.emit("before_agent_start");
    assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    const stoppedStatus = h.status();
    assert.match(stoppedStatus, /on 1\/2/);
    h.emit("agent_settled");
    assert.equal(h.status(), stoppedStatus);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.equal(fetch.mock.callCount(), 2, "Waiting must not trigger another judgment");

    h.emit("input", { source, text: "Also verify malformed parser input." });
    assert.ok(h.emit("before_agent_start"));
    assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
    assert.match(h.status(), /on 2\/2/);
    assert.equal(fetch.mock.callCount(), 3);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.match(h.status(), /^Jev on\b.*limit/);
    assert.equal(fetch.mock.callCount(), 3, "A new conversation must not reset the continuation limit");
  });
}

for (const stop of ["command", "new session"] as const) {
  test(`${stop} still disables automation while waiting after a Jev stop`, async (t) => {
    const h = harness(t, {}, "tui");
    const fetch = t.mock.method(globalThis, "fetch", async () => answer("other"));
    await h.command("jev-on", "Improve parser error handling");
    await h.emit("agent_before_settle", boundary());
    h.emit("agent_settled");
    if (stop === "command") await h.command("jev-off");
    else h.emit("session_start", { reason: "new" });
    h.emit("input", { source: "interactive", text: "Explain the parser." });
    assert.equal(h.emit("before_agent_start"), undefined);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.equal(fetch.mock.callCount(), 1);
    assert.match(h.status(), /off/);
  });
}

test("a host abort after a Jev stop waits for fresh input without disabling automation", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer("other"));
  await h.command("jev-on", "Improve parser error handling");
  await h.emit("agent_before_settle", boundary());
  h.emit("agent_settled");
  h.emit("input", { source: "rpc", text: "Verify another case." });
  h.emit("before_agent_start");
  h.emit("agent_settled");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(h.status(), /^Jev on\b/);
  h.emit("input", { source: "rpc", text: "Continue checking." });
  assert.ok(h.emit("before_agent_start"));
  await h.emit("agent_before_settle", boundary());
  assert.equal(fetch.mock.callCount(), 2);
});

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
  assert.match(h.status(), /^Jev on\b.*limit/);
  await h.command("jev-max", "3");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  h.emit("input", { source: "rpc", text: "Run one more check." });
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  assert.match(h.status(), /on 3\/3/);
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

test("Escape cancels an in-flight judgment but fresh input can resume the same goal", async (t) => {
  const h = harness(t, {}, "tui");
  const waiting = deferred();
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => ++calls === 1 ? waiting.promise : Promise.resolve(answer()));
  await h.command("jev-on", "Improve parser error handling");
  const result = h.emit("agent_before_settle", boundary());
  h.escape();
  waiting.resolve(answer());
  assert.equal(await result, undefined);
  assert.match(h.status(), /^Jev on\b.*Escape/);
  h.emit("agent_settled");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(calls, 1, "A late judgment must not restart the cancelled run");
  h.emit("input", { source: "interactive", text: "Continue checking the parser." });
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  assert.match(h.status(), /on 1\/unlimited/);
});

test("a new session invalidates old judgments without rearming the startup goal", async (t) => {
  const h = harness(t, { "jev-goal": "Improve parser error handling" }, "tui");
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
    assert.match(h.status(), /^Jev on\b.*input/);
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
  assert.match(h.status(), /^Jev on\b.*queued/);
});

test("agent errors and aborts never become automatic retries", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  for (const outcome of ["aborted", "error"] as const) {
    await h.command("jev-on", "Improve parser error handling");
    assert.equal(await h.emit("agent_before_settle", boundary(outcome)), undefined);
    assert.match(h.status(), /^Jev on\b/);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("a failed Jev request waits without retrying and resumes only after fresh input", async (t) => {
  const h = harness(t);
  let calls = 0;
  const fetch = t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? new Response(null, { status: 503 }) : answer());
  await h.command("jev-on", "Improve parser error handling");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(h.status(), /^Jev on\b/);
  h.emit("input", { source: "rpc", text: "Try checking again." });
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  assert.equal(fetch.mock.callCount(), 2);
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

test("final settlement after a host abort waits without automatically retrying", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-on", "Improve parser error handling");
  h.emit("agent_settled");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(h.status(), /^Jev on\b/);
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
  const h = harness(t, {}, "tui");
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

function questionAnswer(needsHuman = 0.01, confidence = 0.95, inScope = 0.99) {
  return Response.json({
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      selection: { type: "choice", choice: "option_1", confidence,
        probabilities: { option_0: 0.01, option_1: 0.98, defer: 0.01 } },
      needs_human: { type: "noul", noul: needsHuman },
      in_scope_0: { type: "noul", noul: 0.01 },
      in_scope_1: { type: "noul", noul: inScope },
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
  assert.match(h.status(), /^Jev on\b/);
});

for (const handoff of ["approval", "judgment", "HTTP error"] as const) {
  test(`${handoff} handoff keeps Jev enabled and resumes judgments after a human answer`, async (t) => {
    const h = harness(t);
    const selection = Promise.withResolvers<string | undefined>();
    h.setSelect(() => selection.promise);
    const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).questions.selection) {
        return handoff === "HTTP error" ? new Response(null, { status: 503 }) : questionAnswer(0.8);
      }
      return answer();
    });
    await h.command("jev-max", "2");
    await h.command("jev-on", "Build an offline CLI");
    assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
    const pending = h.choose({ ...implementationQuestion, requiresApproval: handoff === "approval" });
    const choices = await h.dialogOpened.promise;
    assert.match(h.status(), /on 1\/2/);
    const callsBeforeAnswer = fetch.mock.callCount();
    assert.equal(callsBeforeAnswer, handoff === "approval" ? 1 : 2);
    const blocked = h.emit("tool_call", { toolName: "write" });
    assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block === true);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.equal(fetch.mock.callCount(), callsBeforeAnswer);
    selection.resolve(choices[1]);
    const result = await pending;
    assert.ok(result.details && typeof result.details === "object");
    assert.ok("source" in result.details && result.details.source === "human");
    assert.ok("optionIndex" in result.details && result.details.optionIndex === 1);
    assert.notEqual(result.terminate, true);
    assert.equal(h.emit("tool_call", { toolName: "write" }), undefined);
    assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
    assert.match(h.status(), /on 2\/2/);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.match(h.status(), /^Jev on\b.*limit/);
    assert.equal(fetch.mock.callCount(), callsBeforeAnswer + 1);
  });
}

for (const stop of ["command", "escape", "session switch"] as const) {
  test(`${stop} during a human question rejects late answers and preserves the correct enabled state`, async (t) => {
    const h = harness(t, {}, stop === "escape" ? "tui" : "rpc");
    const selection = Promise.withResolvers<string | undefined>();
    const customAnswer = Promise.withResolvers<HumanAnswer | undefined>();
    h.setSelect(() => selection.promise);
    h.setCustom(() => customAnswer.promise);
    const fetch = t.mock.method(globalThis, "fetch", async () => answer());
    await h.command("jev-on", "Build an offline CLI");
    const pending = h.choose({ ...implementationQuestion, requiresApproval: true });
    const choices = stop === "escape"
      ? (await h.customOpened.promise, [])
      : await h.dialogOpened.promise;
    if (stop === "command") await h.command("jev-off");
    else if (stop === "escape") h.escape();
    else h.emit("session_before_switch");
    selection.resolve(choices[1]);
    customAnswer.resolve({ optionIndex: 1 });
    const result = await pending;
    assert.equal(result.terminate, true);
    h.emit("agent_settled");
    assert.match(h.status(), stop === "escape" ? /^Jev on\b/ : /^Jev off\b/);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.equal(fetch.mock.callCount(), 0);
    h.emit("input", { source: "rpc", text: "Explain the choices." });
    if (stop === "escape") {
      assert.ok(h.emit("before_agent_start"));
      assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
      assert.equal(fetch.mock.callCount(), 1);
    } else {
      assert.equal(h.emit("before_agent_start"), undefined);
      assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
      assert.equal(fetch.mock.callCount(), 0);
    }
  });
}

test("a human answer while Jev is disabled does not enable automation", async (t) => {
  const h = harness(t);
  h.setSelect(async (choices) => choices[1]);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  const result = await h.choose(implementationQuestion);
  assert.ok(result.details && typeof result.details === "object" && "source" in result.details && result.details.source === "human");
  assert.match(h.status(), /off/);
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 0);
});

test("a dismissed human question keeps Jev enabled but gated until fresh input", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-on", "Build an offline CLI");
  const result = await h.choose({ ...implementationQuestion, requiresApproval: true });
  assert.equal(result.terminate, true);
  h.emit("turn_end");
  assert.equal(h.aborts(), 1);
  await h.emit("agent_before_settle", boundary("aborted"));
  h.emit("agent_settled");
  assert.match(h.status(), /^Jev on\b/);
  assert.equal(fetch.mock.callCount(), 0);
  h.emit("input", { source: "rpc", text: "Use SQLite." });
  h.emit("before_agent_start");
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  assert.equal(fetch.mock.callCount(), 1);
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
  await h.emit("agent_before_settle", boundary("aborted"));
  h.emit("agent_settled");
  assert.match(h.status(), /^Jev on\b/);
  h.emit("input", { source: "interactive", text: "Use SQLite, without destructive changes." });
  assert.equal(h.emit("tool_call", { toolName: "bash", input: { command: "echo allowed" } }), undefined);
  h.emit("before_agent_start");
  fetch.mock.mockImplementation(async () => answer());
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
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
    assert.match(h.status(), /^Jev on\b/);
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

for (const enabled of [false, true]) {
  test(`saving a note leaves tools gated and preserves enabled=${enabled} until selection`, async (t) => {
    const h = harness(t);
    if (enabled) await h.command("jev-on", "Build an offline CLI");
    let selections = 0;
    const redrawn = Promise.withResolvers<string[]>();
    const selection = Promise.withResolvers<string | undefined>();
    h.setSelect((choices) => {
      if (++selections === 1) return Promise.resolve(choices.at(-1));
      redrawn.resolve(choices);
      return selection.promise;
    });
    h.setInput(async () => "Keep data local.");
    const fetch = t.mock.method(globalThis, "fetch", async () => answer());
    const pending = h.choose({ ...implementationQuestion, requiresApproval: true });
    const choices = await redrawn.promise;
    const blocked = h.emit("tool_call", { toolName: "write" });
    assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block === true);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    selection.resolve(choices[1]);
    const result = await pending;
    assert.ok(result.details && typeof result.details === "object" && "notes" in result.details);
    assert.equal(result.details.notes, "Keep data local.");
    assert.equal(h.emit("tool_call", { toolName: "write" }), undefined);
    assert.match(h.status(), enabled ? /^Jev on\b/ : /^Jev off\b/);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

for (const stop of ["command", "session switch"] as const) {
  test(`${stop} during note input rejects late text and keeps automation disabled`, async (t) => {
    const h = harness(t);
    const note = Promise.withResolvers<string | undefined>();
    h.setSelect(async (choices) => choices.at(-1));
    h.setInput(() => note.promise);
    await h.command("jev-on", "Build an offline CLI");
    const pending = h.choose({ ...implementationQuestion, requiresApproval: true });
    await h.noteOpened.promise;
    if (stop === "command") await h.command("jev-off");
    else h.emit("session_before_switch");
    const result = await pending;
    note.resolve("Do not accept this stale note");
    assert.equal(result.terminate, true);
    assert.match(h.status(), /off/);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  });
}

test("report validation failure keeps the goal and counter for the next conversation", async (t) => {
  const h = harness(t);
  const states: { goal: string; iteration: number; previousReport: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    states.push(JSON.parse(String(init?.body)).state);
    return answer();
  });
  await h.command("jev-max", "2");
  await h.command("jev-on", "Improve parser error handling");
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  const missingReport = boundary();
  missingReport.context.contextMessages = [];
  assert.equal(await h.emit("agent_before_settle", missingReport), undefined);
  assert.match(h.status(), /^Jev on 1\/2/);
  h.emit("agent_settled");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(states.length, 1);
  h.emit("input", { source: "rpc", text: "Continue with the report restored." });
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  assert.equal(states[1]?.goal, "Improve parser error handling");
  assert.equal(states[1]?.iteration, 2);
  assert.equal(states[1]?.previousReport, "Implemented parser error handling. Next: run parser regression checks.");
  assert.match(h.status(), /^Jev on 2\/2/);
});

test("failure to start a goal leaves it enabled but idle until the next user input", async (t) => {
  const h = harness(t);
  const send = t.mock.method(h.pi, "sendUserMessage", () => { throw new Error("Host refused to start"); });
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-on", "Improve parser error handling");
  assert.match(h.status(), /^Jev on\b/);
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 0);
  send.mock.restore();
  h.emit("input", { source: "rpc", text: "Start now." });
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
});

for (const activation of ["command", "cli"] as const) {
  test(`${activation} policy load failure does not start automation`, async (t) => {
    const h = harness(t, activation === "cli" ? { "jev-goal": "Verify parser behavior" } : {});
    mkdirSync(join(h.ctx.cwd, ".pi", "CONTINUE.md"));
    const fetch = t.mock.method(globalThis, "fetch", async () => answer());
    if (activation === "command") await h.command("jev-on", "Verify parser behavior");
    assert.equal(h.emit("before_agent_start"), undefined);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.equal(h.sent.length, 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.match(h.status(), /^Jev off\b/);
    assert.ok(h.notifications.some(message => message.includes(join(h.ctx.cwd, ".pi", "CONTINUE.md"))));
  });
}

test("policy files stay frozen during a run and are reloaded only on explicit activation", async (t) => {
  const h = harness(t);
  const path = join(h.ctx.cwd, ".pi", "CONTINUE.md");
  writeFileSync(path, "Continue local parser verification.");
  const fetch = t.mock.method(globalThis, "fetch", async () => answer());
  await h.command("jev-on", "Verify parser behavior");
  rmSync(path);
  mkdirSync(path);
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  await h.command("jev-on", "A different goal");
  assert.equal(h.sent.length, 1, "Failed reactivation must not launch a different goal");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(fetch.mock.callCount(), 1, "Failed reactivation must wait for input, not use a partial policy");
  rmSync(path, { recursive: true });
  writeFileSync(path, "Stop after the required checks.");
  await h.command("jev-on", "Verify parser behavior");
  assert.equal(h.sent.length, 2);
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
});

test("level command reports thresholds without enabling automation and rejects invalid changes", async (t) => {
  const h = harness(t);
  await h.command("jev-level");
  assert.match(h.notifications.at(-1)!, /Level: 5\b/);
  for (const value of ["0.85", "0.1", "0.9"]) assert.ok(h.notifications.at(-1)!.includes(value));
  for (const [value, confidence, needsHuman, inScope] of [
    ["1", "0.65", "0.3", "0.7"],
    ["2", "0.7", "0.25", "0.75"],
    ["3", "0.75", "0.2", "0.8"],
    ["4", "0.8", "0.15", "0.85"],
    ["5", "0.85", "0.1", "0.9"],
  ] as const) {
    await h.command("jev-level", value);
    await h.command("jev-status");
    const message = h.notifications.at(-1)!;
    assert.match(message, new RegExp(`Level: ${value}\\b`));
    assert.match(message, new RegExp(`minConfidence: ${confidence.replace(".", "\\.")}(?:[, )]|$)`));
    assert.match(message, new RegExp(`maxNeedsHuman: ${needsHuman.replace(".", "\\.")}(?:[, )]|$)`));
    assert.match(message, new RegExp(`minInScope: ${inScope.replace(".", "\\.")}(?:[, )]|$)`));
  }
  await h.command("jev-level", " 3 ");
  for (const invalid of ["0", "6", "-1", "1.5", "03", "3x", "3 4", "NaN", "Infinity"]) {
    await h.command("jev-level", invalid);
    await h.command("jev-level");
    assert.match(h.notifications.at(-1)!, /Level: 3\b/);
  }
  await h.command("jev-status");
  assert.match(h.notifications.at(-1)!, /Level: 3\b/);
  for (const value of ["0.75", "0.2", "0.8"]) assert.ok(h.notifications.at(-1)!.includes(value));
  assert.match(h.status(), /^Jev off\b/);
  assert.equal(h.emit("before_agent_start"), undefined);
  assert.equal(h.sent.length, 0);
});

for (const activation of ["command", "cli"] as const) {
  test(`${activation} level applies to both judge paths and preserves the active goal, policy, and limit`, async (t) => {
    const h = harness(t, activation === "cli" ? { "jev-goal": "Verify parser behavior", "jev-level": "3", "jev-max": "2" } : {});
    const policyPath = join(h.ctx.cwd, ".pi", "CONTINUE.md");
    writeFileSync(policyPath, "Continue local verification.");
    const captured: { goal: string; policy: unknown }[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      captured.push({ goal: body.state.goal, policy: body.state.policy });
      return body.questions.selection ? questionAnswer(0.18, 0.78, 0.82) : answer("verify", 0.78, 0.18, 0.82);
    });
    if (activation === "command") {
      await h.command("jev-max", "2");
      await h.command("jev-on", "Verify parser behavior");
      await h.command("jev-level", "3");
    }
    assert.ok(h.emit("before_agent_start"));
    assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
    writeFileSync(policyPath, "A changed policy must not be loaded by a level change.");
    await h.command("jev-level", "1");
    const result = await h.choose(implementationQuestion);
    assert.ok(result.details && typeof result.details === "object" && "source" in result.details);
    assert.equal(result.details.source, "jev");
    assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
    assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
    assert.match(h.status(), /on 2\/2/);
    assert.deepEqual(captured, [captured[0], captured[0], captured[0]]);
    assert.equal(captured[0].goal, "Verify parser behavior");
    assert.equal(h.sent.length, activation === "command" ? 1 : 0);
    assert.deepEqual(h.entries.filter(entry => entry.type === "jev-judgment" || entry.type === "jev-choice-judgment")
      .map(entry => {
        assert.ok(entry.data && typeof entry.data === "object" && "level" in entry.data);
        return entry.data.level;
      }), [3, 1, 1]);
  });
}

for (const value of ["0", "6", "1.5", "03", "2x", " 3 ", ""]) {
  test(`invalid startup level ${JSON.stringify(value)} prevents CLI activation`, async (t) => {
    const h = harness(t, { "jev-goal": "Verify parser behavior", "jev-level": value });
    assert.equal(h.emit("before_agent_start"), undefined);
    assert.match(h.status(), /^Jev off\b/);
    await h.command("jev-level");
    assert.match(h.notifications.at(-1)!, /Level: 5\b/);
  });
}

for (const reason of ["new", "reload", "switch"] as const) {
  test(`${reason} resets the level without reapplying startup settings`, async (t) => {
    const h = harness(t, { "jev-goal": "Verify parser behavior", "jev-level": "1" });
    assert.ok(h.emit("before_agent_start"));
    await h.command("jev-level", "2");
    h.emit("session_start", { reason });
    await h.command("jev-level");
    assert.match(h.notifications.at(-1)!, /Level: 5\b/);
    assert.equal(h.emit("before_agent_start"), undefined);
    assert.match(h.status(), /^Jev off\b/);
  });
}

test("a pending continuation retains its level while later requests use the changed level", async (t) => {
  const h = harness(t);
  const waiting = deferred();
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => ++calls === 1 ? waiting.promise : Promise.resolve(answer("verify", 0.78, 0.18, 0.82)));
  await h.command("jev-on", "Verify parser behavior");
  const pending = h.emit("agent_before_settle", boundary());
  await h.command("jev-level", "3");
  waiting.resolve(answer("verify", 0.78, 0.18, 0.82));
  assert.equal(await pending, undefined, "The pending level-5 judgment must still stop");
  await h.command("jev-level", "4");
  await h.command("jev-level", "3");
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(calls, 1, "A level change must not restart a stopped run");
  h.emit("input", { source: "interactive", text: "Continue verification." });
  assert.ok(h.emit("before_agent_start"));
  assert.equal((await h.emit("agent_before_settle", boundary()))?.continue, true);
  assert.deepEqual(h.entries.filter(entry => entry.type === "jev-judgment")
    .map(entry => {
      assert.ok(entry.data && typeof entry.data === "object" && "level" in entry.data);
      return entry.data.level;
    }), [5, 3]);
});

test("changing level during a pending question neither rejudges nor resolves its human handoff", async (t) => {
  const h = harness(t);
  const waiting = deferred();
  const selection = Promise.withResolvers<string | undefined>();
  h.setSelect(() => selection.promise);
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => ++calls === 1 ? waiting.promise : Promise.resolve(questionAnswer(0.18, 0.78, 0.82)));
  await h.command("jev-on", "Verify parser behavior");
  const pending = h.choose(implementationQuestion);
  await h.command("jev-level", "3");
  waiting.resolve(questionAnswer(0.18, 0.78, 0.82));
  const choices = await h.dialogOpened.promise;
  await h.command("jev-level", "1");
  const blocked = h.emit("tool_call", { toolName: "write" });
  assert.ok(blocked && typeof blocked === "object" && "block" in blocked && blocked.block);
  assert.equal(await h.emit("agent_before_settle", boundary()), undefined);
  assert.equal(calls, 1);
  assert.match(h.status(), /on 0\/unlimited/);
  selection.resolve(choices[1]);
  const human = await pending;
  assert.ok(human.details && typeof human.details === "object" && "source" in human.details);
  assert.equal(human.details.source, "human");
  const automatic = await h.choose(implementationQuestion);
  assert.ok(automatic.details && typeof automatic.details === "object" && "source" in automatic.details);
  assert.equal(automatic.details.source, "jev");
  assert.deepEqual(h.entries.filter(entry => entry.type === "jev-choice-judgment")
    .map(entry => {
      assert.ok(entry.data && typeof entry.data === "object" && "level" in entry.data);
      return entry.data.level;
    }), [5, 1]);
  assert.equal(h.sent.length, 1);
});
