import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChoiceQuestion, ChoiceQuestionSchema } from "../src/choice.ts";
import { registerChoiceTool, type ChoiceToolDetails } from "../src/question-tool.ts";
import { isolateJevLogs } from "./log-environment.ts";

isolateJevLogs();

type ChoiceTool = ToolDefinition<typeof ChoiceQuestionSchema, ChoiceToolDetails, unknown>;
interface Dialog {
  title: string;
  options: string[];
  signal: AbortSignal | undefined;
}
interface NoteDialog {
  title: string;
  placeholder: string | undefined;
  signal: AbortSignal | undefined;
}
interface HarnessOptions {
  enabled?: boolean;
  hasUI?: boolean;
  mode?: ExtensionContext["mode"];
  timeoutMs?: number;
  select?: (dialog: Dialog) => Promise<string | undefined>;
  input?: (dialog: NoteDialog) => Promise<string | undefined>;
}

function question(requiresApproval = false): ChoiceQuestion {
  return {
    question: "Which parser verification should run next?",
    context: "The parser implementation is complete. The goal requires regression coverage.",
    options: [
      { label: "Run the full suite", description: "Run every package's tests." },
      { label: "Run parser regressions", description: "Run the focused parser regression cases first." },
    ],
    requiresApproval,
  };
}

function response(confidence = 0.95): Response {
  return Response.json({
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      selection: { type: "choice", choice: "option_1", confidence,
        probabilities: { option_0: 0.03, option_1: 0.95, defer: 0.02 } },
      needs_human: { type: "noul", noul: 0.01 },
      in_scope_0: { type: "noul", noul: 0.1 },
      in_scope_1: { type: "noul", noul: 0.99 },
    },
  });
}

function harness(t: TestContext, options: HarnessOptions = {}) {
  let registered: ChoiceTool | undefined;
  const goal = options.enabled === false ? undefined : "Improve parser regression coverage";
  const handoffs: string[] = [];
  const entries: { type: string; data: unknown }[] = [];
  const dialogs: Dialog[] = [];
  const dialogOpened = Promise.withResolvers<Dialog>();
  const noteOpened = Promise.withResolvers<NoteDialog>();
  const contextAbort = new AbortController();
  // このハーネスは本ツールが使用する pi の機能だけを実装する。
  const pi = {
    on() { return () => {}; },
    registerTool(tool: ChoiceTool) { registered = tool; },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "rpc",
    signal: contextAbort.signal,
    ui: {
      select(title: string, choices: string[], dialogOptions?: ExtensionUIDialogOptions) {
        const dialog = { title, options: choices, signal: dialogOptions?.signal };
        dialogs.push(dialog);
        dialogOpened.resolve(dialog);
        return options.select?.(dialog) ?? Promise.resolve(choices[1]);
      },
      input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) {
        const dialog = { title, placeholder, signal: dialogOptions?.signal };
        noteOpened.resolve(dialog);
        return options.input?.(dialog) ?? Promise.resolve(undefined);
      },
    },
  } as unknown as ExtensionContext;
  const controller = registerChoiceTool(pi, {
    getGoal: () => goal,
    getConversation: () => [],
    getRequestOptions: (signal) => ({ apiKey: "test-only-secret", model: "jev-1.13.0", signal }),
    waitForHuman(_ctx, reason) {
      handoffs.push(reason);
      // 実際の親 extension と同じく、委譲はツール自身の cancel を呼ぶ。
      controller.cancel();
    },
    onHumanAnswer() {},
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  assert.ok(registered, "registerChoiceTool must register an executable native tool");
  const tool = registered;
  t.after(() => controller.reset());
  return {
    controller, handoffs, entries, dialogs, dialogOpened, noteOpened, contextAbort,
    execute(value: unknown = question(), signal?: AbortSignal) {
      // tool_call フックがホスト検証後に引数を書き換える場合も同じ境界で試す。
      return tool.execute("choice-call", value as ChoiceQuestion, signal, undefined, ctx);
    },
  };
}

function text(result: AgentToolResult<ChoiceToolDetails>): string {
  return result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

function assertUnanswered(result: AgentToolResult<ChoiceToolDetails>): void {
  assert.notEqual(result.details.status, "answered");
  assert.equal(result.terminate, true);
}

test("a confident non-first answer continues through the native result without showing UI", async (t) => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => response());
  const result = await h.execute();
  assert.deepEqual(result.details, {
    status: "answered", source: "jev", optionIndex: 1,
    label: "Run parser regressions", question: question().question,
  });
  assert.notEqual(result.terminate, true);
  assert.match(text(result), /Run parser regressions/);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.controller.isPending(), false);
  assert.equal(h.controller.isAwaitingHuman(), false);
  assert.equal(h.entries.filter((entry) => entry.type === "jev-choice-judgment").length, 1);
});

test("low confidence waits for a manual RPC choice before returning a human answer", async (t) => {
  const h = harness(t, {
    mode: "rpc",
    select: async (dialog) => {
      assert.equal(dialog.signal?.aborted, false);
      return dialog.options[1];
    },
  });
  t.mock.method(globalThis, "fetch", async () => response(0.7));
  const result = await h.execute();
  assert.deepEqual(result.details, {
    status: "answered", source: "human", optionIndex: 1,
    label: "Run parser regressions", question: question().question,
  });
  assert.notEqual(result.terminate, true);
  assert.equal(h.controller.isAwaitingHuman(), false);
});

test("explicit approval is always handed to the human without HTTP", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => response());
  const result = await h.execute(question(true));
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(result.details.status, "answered");
  if (result.details.status === "answered") assert.equal(result.details.source, "human");
  assert.equal(h.entries.length, 0);
});

test("disabled automation asks the human without HTTP", async (t) => {
  const h = harness(t, { enabled: false });
  const fetch = t.mock.method(globalThis, "fetch", async () => response());
  const result = await h.execute();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(result.details.status, "answered");
  if (result.details.status === "answered") assert.equal(result.details.source, "human");
});

test("non-UI handoff exposes the question and options and terminates without a retry loop", async (t) => {
  const h = harness(t, { hasUI: false, mode: "print" });
  const output: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => { output.push(String(chunk)); return true; });
  const fetch = t.mock.method(globalThis, "fetch", async () => response(0.7));
  const result = await h.execute();
  assertUnanswered(result);
  assert.equal(result.details.status, "needs_human");
  assert.match(text(result), /Which parser verification/);
  assert.match(text(result), /Run parser regressions/);
  assert.match(output.join(""), /Run the full suite/);
  assert.match(output.join(""), /focused parser regression/);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.controller.isAwaitingHuman(), true);
  assertUnanswered(await h.execute());
  assert.equal(fetch.mock.callCount(), 1);
});

test("dismissing a manual dialog does not pick its first option or ask again", async (t) => {
  const h = harness(t, { select: async () => undefined });
  t.mock.method(globalThis, "fetch", async () => response(0.7));
  assertUnanswered(await h.execute());
  assert.equal(h.controller.isAwaitingHuman(), true);
  assertUnanswered(await h.execute());
  assert.equal(h.dialogs.length, 1);
});

test("a response not offered by the dialog cannot become an answer", async (t) => {
  const h = harness(t, { select: async () => "Run parser regressions" });
  t.mock.method(globalThis, "fetch", async () => response(0.7));
  assertUnanswered(await h.execute());
  assert.equal(h.controller.isAwaitingHuman(), true);
});

test("stop invalidates a pending request even if fetch ignores cancellation", async (t) => {
  const h = harness(t);
  const waiting = Promise.withResolvers<Response>();
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (_url: unknown, options?: RequestInit) => {
    signal = options?.signal ?? undefined;
    return waiting.promise;
  });
  const result = h.execute();
  assert.equal(h.controller.isPending(), true);
  h.controller.cancel();
  assert.equal(signal?.aborted, true);
  assertUnanswered(await result);
  waiting.resolve(response());
  await delay(0);
  assert.equal(h.entries.length, 0);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.controller.isAwaitingHuman(), true);
});

test("new-session reset permits a new question without accepting the old request", async (t) => {
  const h = harness(t);
  const waiting = Promise.withResolvers<Response>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => ++calls === 1 ? waiting.promise : Promise.resolve(response()));
  const stale = h.execute();
  h.controller.reset();
  const current = await h.execute();
  waiting.resolve(response());
  assertUnanswered(await stale);
  assert.equal(current.details.status, "answered");
  assert.equal(h.controller.isAwaitingHuman(), false);
  assert.equal(h.entries.length, 1);
});

test("stop while paused invalidates a late manual selection", async (t) => {
  const waiting = Promise.withResolvers<string | undefined>();
  const h = harness(t, { select: () => waiting.promise });
  t.mock.method(globalThis, "fetch", async () => response(0.7));
  const result = h.execute();
  const dialog = await h.dialogOpened.promise;
  assert.equal(dialog.signal?.aborted, false);
  assert.equal(h.controller.isPending(), true);
  h.controller.cancel();
  assert.equal(dialog.signal?.aborted, true);
  assertUnanswered(await result);
  waiting.resolve(dialog.options[1]);
  await delay(0);
  assert.equal(h.controller.isAwaitingHuman(), true);
});

test("a stale manual selection after reset does not restore the human gate", async (t) => {
  const waiting = Promise.withResolvers<string | undefined>();
  const h = harness(t, { enabled: false, select: () => waiting.promise });
  const result = h.execute();
  const dialog = await h.dialogOpened.promise;
  h.controller.reset();
  waiting.resolve(dialog.options[1]);
  assertUnanswered(await result);
  assert.equal(h.controller.isAwaitingHuman(), false);
  assert.equal(h.entries.length, 0);
});

test("tool abort cancels a pending manual dialog", async (t) => {
  const waiting = Promise.withResolvers<string | undefined>();
  const h = harness(t, { enabled: false, select: () => waiting.promise });
  const abort = new AbortController();
  const result = h.execute(question(), abort.signal);
  const dialog = await h.dialogOpened.promise;
  abort.abort(new Error("test-only-secret"));
  waiting.resolve(dialog.options[1]);
  const cancelled = await result;
  assertUnanswered(cancelled);
  assert.doesNotMatch(text(cancelled), /test-only-secret/);
  assert.equal(h.controller.isAwaitingHuman(), true);
});

test("context abort also invalidates a pending automatic judgment", async (t) => {
  const h = harness(t);
  const waiting = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", () => waiting.promise);
  const result = h.execute();
  h.contextAbort.abort();
  waiting.resolve(response());
  assertUnanswered(await result);
  assert.equal(h.entries.length, 0);
  assert.equal(h.dialogs.length, 0);
});

test("concurrent direct executions fail closed instead of asking two questions", async (t) => {
  const h = harness(t);
  const waiting = Promise.withResolvers<Response>();
  const fetch = t.mock.method(globalThis, "fetch", () => waiting.promise);
  const first = h.execute();
  const second = await h.execute();
  waiting.resolve(response());
  assertUnanswered(second);
  assertUnanswered(await first);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.entries.length, 0);
  assert.equal(h.controller.isAwaitingHuman(), true);
});

test("HTTP errors pause for a manual answer without leaking exception credentials", async (t) => {
  const h = harness(t, { select: async () => undefined });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("test-only-secret"); });
  const result = await h.execute();
  assertUnanswered(result);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.entries.length, 0);
  assert.doesNotMatch(JSON.stringify({ result, handoffs: h.handoffs, dialogs: h.dialogs, entries: h.entries }), /test-only-secret/);
});

test("dialog failure is unresolved rather than a guessed answer", async (t) => {
  const h = harness(t, { enabled: false, select: async () => { throw new Error("test-only-secret"); } });
  const result = await h.execute();
  assertUnanswered(result);
  assert.equal(h.controller.isAwaitingHuman(), true);
  assert.doesNotMatch(text(result), /test-only-secret/);
});

test("arguments mutated after host validation are rejected before HTTP or UI", async (t) => {
  const h = harness(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => response());
  const result = await h.execute({ ...question(), options: [{ label: "oversized", description: "x".repeat(1601) }] });
  assertUnanswered(result);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.controller.isAwaitingHuman(), true);
  assert.doesNotMatch(text(result), /x{1601}/);
});

test("the HTTP deadline does not impose a deadline on human thinking", async (t) => {
  const waiting = Promise.withResolvers<Response>();
  const selection = Promise.withResolvers<string | undefined>();
  const h = harness(t, { timeoutMs: 10, select: () => selection.promise });
  t.mock.method(globalThis, "fetch", () => waiting.promise);
  const result = h.execute();
  // AbortSignal.timeout 自体はイベントループを維持しないため、待機も明示する。
  await delay(30);
  const dialog = await h.dialogOpened.promise;
  await delay(30);
  assert.equal(dialog.signal?.aborted, false);
  selection.resolve(dialog.options[1]);
  const answered = await result;
  assert.equal(answered.details.status, "answered");
  if (answered.details.status === "answered") assert.equal(answered.details.source, "human");
  waiting.resolve(response());
});

test("a human note accompanies only an explicitly selected existing option", async (t) => {
  let selections = 0;
  const h = harness(t, {
    select: async (dialog) => ++selections === 1 ? dialog.options.at(-1) : dialog.options[1],
    input: async () => "  Keep fixtures offline.\nDo not change the API.  ",
  });
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)).state);
    return response(0.7);
  });
  const result = await h.execute();
  assert.deepEqual(result.details, {
    status: "answered", source: "human", optionIndex: 1,
    label: question().options[1].label, question: question().question,
    notes: "Keep fixtures offline.\nDo not change the API.",
  });
  assert.match(text(result), /Keep fixtures offline\.\nDo not change the API\./);
  assert.doesNotMatch(JSON.stringify(requests), /Keep fixtures offline/);
});

test("saving a note keeps the question unresolved until an option is selected", async (t) => {
  const nextSelection = Promise.withResolvers<string | undefined>();
  const redrawn = Promise.withResolvers<Dialog>();
  let selections = 0;
  const h = harness(t, {
    enabled: false,
    select: (dialog) => {
      if (++selections === 1) return Promise.resolve(dialog.options.at(-1));
      redrawn.resolve(dialog);
      return nextSelection.promise;
    },
    input: async () => "Keep the public API.",
  });
  const pending = h.execute();
  const dialog = await redrawn.promise;
  assert.match(dialog.title, /Keep the public API\./);
  assert.equal(h.controller.isPending(), true);
  assert.equal(h.controller.isAwaitingHuman(), true);
  nextSelection.resolve(dialog.options[1]);
  const result = await pending;
  assert.equal(result.details.status, "answered");
  assert.equal(h.controller.isAwaitingHuman(), false);
});

test("cancelling note input leaves the question unanswered", async (t) => {
  const h = harness(t, {
    enabled: false,
    select: async (dialog) => dialog.options.at(-1),
    input: async () => undefined,
  });
  assertUnanswered(await h.execute());
  assert.equal(h.controller.isAwaitingHuman(), true);
});

for (const stop of ["cancel", "reset", "tool abort", "context abort"] as const) {
  test(`${stop} during note entry rejects a late note without reopening selection`, async (t) => {
    const note = Promise.withResolvers<string | undefined>();
    const abort = new AbortController();
    const h = harness(t, {
      enabled: false,
      select: async (dialog) => dialog.options.at(-1),
      input: () => note.promise,
    });
    const pending = h.execute(question(), abort.signal);
    const dialog = await h.noteOpened.promise;
    if (stop === "tool abort") abort.abort();
    else if (stop === "context abort") h.contextAbort.abort();
    else h.controller[stop]();
    assert.equal(dialog.signal?.aborted, true);
    assertUnanswered(await pending);
    note.resolve("Stale note");
    await delay(0);
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.controller.isAwaitingHuman(), stop !== "reset");
  });
}

test("editing a note to whitespace clears it from the final answer", async (t) => {
  let selections = 0;
  let edits = 0;
  const h = harness(t, {
    enabled: false,
    select: async (dialog) => ++selections <= 2 ? dialog.options.at(-1) : dialog.options[0],
    input: async () => ++edits === 1 ? "Remove this note" : " \n\t ",
  });
  const result = await h.execute();
  assert.deepEqual(result.details, {
    status: "answered", source: "human", optionIndex: 0,
    label: question().options[0].label, question: question().question,
  });
  assert.doesNotMatch(text(result), /Remove this note/);
});

test("overlimit notes remain editable without accepting or silently truncating them", async (t) => {
  let selections = 0;
  let edits = 0;
  const tooLong = "x".repeat(2001);
  const h = harness(t, {
    enabled: false,
    select: async (dialog) => ++selections === 1 ? dialog.options.at(-1) : dialog.options[1],
    input: async (dialog) => {
      if (++edits === 1) return tooLong;
      assert.match(dialog.title, /2000/);
      assert.equal(dialog.placeholder, tooLong);
      assert.equal(h.controller.isAwaitingHuman(), true);
      return "x".repeat(2000);
    },
  });
  const result = await h.execute();
  assert.equal(result.details.status, "answered");
  if (result.details.status === "answered" && result.details.source === "human") {
    assert.equal(result.details.notes, "x".repeat(2000));
  }
});
