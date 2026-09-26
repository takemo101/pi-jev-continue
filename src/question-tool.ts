import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChoiceQuestionSchema, judgeQuestion, parseQuestion, type ChoiceQuestion } from "./choice.ts";
import type { JevRequestOptions } from "./client.ts";

export interface ChoiceToolHooks {
  getGoal(): string | undefined;
  getRequestOptions(signal: AbortSignal): JevRequestOptions;
  pause(ctx: ExtensionContext, reason: string): void;
  timeoutMs: number;
}

export interface ChoiceToolController {
  cancel(): void;
  reset(): void;
  isPending(): boolean;
  isAwaitingHuman(): boolean;
}

export type ChoiceToolDetails =
  | { status: "answered"; source: "jev" | "human"; optionIndex: number; label: string; question: string }
  | { status: "needs_human" | "cancelled"; question: string; reason: string; options: ChoiceQuestion["options"] };

interface Operation {
  generation: number;
  controller: AbortController;
  signal: AbortSignal;
}

// fetch や UI が中断を無視しても、ツールの完了を遅延させず古い応答を捨てる。
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException("Choice cancelled.", "AbortError"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([promise, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function unanswered(
  question: ChoiceQuestion | undefined,
  reason: string,
  status: "needs_human" | "cancelled" = "needs_human",
): AgentToolResult<ChoiceToolDetails> {
  const title = question?.question ?? "The multiple-choice question is invalid.";
  const options = question?.options ?? [];
  const text = [
    `No answer was selected. ${reason}`,
    title,
    ...(question?.context ? [question.context] : []),
    ...options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`),
    "Wait for human input. Do not assume a default answer or call jev_choose again for this unresolved question.",
  ].join("\n");
  return { content: [{ type: "text", text }], details: { status, question: title, reason, options }, terminate: true };
}

function answered(question: ChoiceQuestion, optionIndex: number, source: "jev" | "human"): AgentToolResult<ChoiceToolDetails> {
  const label = question.options[optionIndex].label;
  return {
    content: [{ type: "text", text: `Selected option ${optionIndex + 1}: ${label}\nSource: ${source}. This answers only the stated question; it does not grant additional authorization.${source === "human" ? " Jev automation remains off." : ""}` }],
    details: { status: "answered", source, optionIndex, label, question: question.question },
  };
}

export function registerChoiceTool(pi: ExtensionAPI, hooks: ChoiceToolHooks): ChoiceToolController {
  let generation = 0;
  let active: Operation | undefined;
  let awaitingHuman = false;

  const controller: ChoiceToolController = {
    cancel() {
      generation += 1;
      if (active) awaitingHuman = true;
      active?.controller.abort();
      active = undefined;
    },
    reset() {
      controller.cancel();
      awaitingHuman = false;
    },
    isPending: () => active !== undefined,
    isAwaitingHuman: () => awaitingHuman,
  };

  function begin(toolSignal: AbortSignal | undefined, contextSignal: AbortSignal | undefined): Operation {
    const abort = new AbortController();
    const signals = [abort.signal];
    if (toolSignal) signals.push(toolSignal);
    if (contextSignal) signals.push(contextSignal);
    const operation = { generation, controller: abort, signal: AbortSignal.any(signals) };
    active = operation;
    return operation;
  }

  function isFresh(operation: Operation): boolean {
    return active === operation && operation.generation === generation && !operation.signal.aborted;
  }

  function cancelled(question: ChoiceQuestion, operation: Operation, ctx: ExtensionContext): AgentToolResult<ChoiceToolDetails> {
    // reset 後の古い呼出しから、新しいセッションの停止状態を書き戻さない。
    if (active === operation && operation.generation === generation) {
      awaitingHuman = true;
      hooks.pause(ctx, "The multiple-choice question was cancelled without an answer.");
    }
    return unanswered(question, "The multiple-choice question was cancelled.", "cancelled");
  }

  pi.registerTool<typeof ChoiceQuestionSchema, ChoiceToolDetails, unknown>({
    name: "jev_choose",
    label: "Jev choice",
    description: "Ask one bounded multiple-choice question with explicit context and described options. Jev may answer only a confident, goal-scoped routine decision while automation is enabled; otherwise the human chooses. Approval, personal information/preferences, credentials, financial/destructive actions and external authorization always require a human. Never include secrets. Independent judgments are not a security sandbox.",
    promptSnippet: "Resolve a structured multiple-choice question through Jev or a human.",
    promptGuidelines: [
      "Call jev_choose alone, never in a batch with other tools. Supply 2–8 distinct labeled options and their descriptions; do not hide a default answer in prose.",
      "Set requiresApproval to true for approval or authorization. Never use an automatic answer to grant approval or bypass another extension's UI.",
      "Use the selected label from the tool result. If no answer is selected, stop and await human input; do not retry the question or guess. A human choice leaves Jev automation off.",
    ],
    parameters: ChoiceQuestionSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let question: ChoiceQuestion;
      try {
        // tool_call フックはホストの schema 検証後に引数を変更できる。
        question = parseQuestion(params);
      } catch {
        awaitingHuman = true;
        hooks.pause(ctx, "Invalid multiple-choice question; human input is required.");
        return unanswered(undefined, "Provide a valid bounded question through human input.");
      }
      if (active) {
        awaitingHuman = true;
        hooks.pause(ctx, "Concurrent multiple-choice questions require human input.");
        return unanswered(question, "Another question is already pending. Both questions require human attention.");
      }
      if (awaitingHuman) return unanswered(question, "An earlier question still requires human input.");

      let operation = begin(signal, ctx.signal);
      try {
        if (!isFresh(operation)) return cancelled(question, operation, ctx);
        const goal = hooks.getGoal();
        let reason = question.requiresApproval
          ? "This question requires explicit human approval."
          : "Jev automation is off; a human must answer this question.";
        if (goal !== undefined && !question.requiresApproval) {
          try {
            const requestSignal = AbortSignal.any([operation.signal, AbortSignal.timeout(hooks.timeoutMs)]);
            const judgment = await waitFor(judgeQuestion(goal, question, hooks.getRequestOptions(requestSignal)), requestSignal);
            if (!isFresh(operation)) return cancelled(question, operation, ctx);
            // 設定・質問本文・未検証の追加メタデータを永続ログへ流さない。
            pi.appendEntry("jev-choice-judgment", {
              action: judgment.action,
              reason: judgment.reason,
              ...(judgment.action === "answer" ? { optionIndex: judgment.optionIndex } : {}),
            });
            if (judgment.action === "answer") return answered(question, judgment.optionIndex, "jev");
            reason = judgment.reason;
          } catch {
            if (!isFresh(operation)) return cancelled(question, operation, ctx);
            // 通信や設定取得の例外、signal.reason は認証情報を含む可能性がある。
            reason = "Jev could not safely answer this question. A human answer is required.";
          }
        }

        if (!isFresh(operation)) return cancelled(question, operation, ctx);
        awaitingHuman = true;
        hooks.pause(ctx, reason);
        // pause は controller.cancel を呼ぶため、手動 UI 用に新しい世代の中断を登録する。
        // HTTP の締切は人の思考時間には適用しない。
        operation = begin(signal, ctx.signal);
        if (!isFresh(operation)) return cancelled(question, operation, ctx);
        if (!ctx.hasUI) {
          const result = unanswered(question, reason);
          for (const item of result.content) {
            if (item.type === "text") process.stderr.write(`[jev-continue] ${item.text}\n`);
          }
          return result;
        }

        const choices = question.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`);
        const title = [question.question, question.context, reason].filter(Boolean).join("\n\n");
        let selection: string | undefined;
        try {
          selection = await waitFor(ctx.ui.select(title, choices, { signal: operation.signal }), operation.signal);
        } catch {
          if (!isFresh(operation)) return cancelled(question, operation, ctx);
          return unanswered(question, "The selection dialog failed. Human input is still required.");
        }
        if (!isFresh(operation)) return cancelled(question, operation, ctx);
        if (selection === undefined) return unanswered(question, "The selection dialog was dismissed.", "cancelled");
        const optionIndex = choices.indexOf(selection);
        if (optionIndex < 0) return unanswered(question, "The dialog did not return one of the offered options.");
        awaitingHuman = false;
        return answered(question, optionIndex, "human");
      } finally {
        if (active === operation) active = undefined;
      }
    },
  });
  return controller;
}
