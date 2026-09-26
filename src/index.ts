import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentBeforeSettleEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { JevRequestOptions } from "./client.ts";
import { judge } from "./jev.ts";
import { buildState, DEFAULT_HISTORY_COUNT, extractConversation, INPUT_LIMITS } from "./state.ts";
import { registerChoiceTool } from "./question-tool.ts";
import { getJevLogPath } from "./request-log.ts";

const DEFAULT_MODEL = "jev-1.13.0";
const JUDGMENT_TIMEOUT_MS = 30_000;

const REPORT_INSTRUCTIONS = `Work in bounded iterations toward the goal below. After each iteration, report concisely:
- What changed and what execution evidence you observed.
- Any blocker requiring human input, credentials, or approval.
- One concrete next action within the goal, including a useful improvement if the original implementation is complete.
Do not invent work outside the goal or claim unobserved verification. If no worthwhile in-scope action remains, say so.
Do not ask routine permission to continue. For an unresolved multiple-choice implementation question, call jev_choose with the question, relevant context, and concrete options instead of asking in prose or using another question tool.
Call jev_choose alone, without other tools in the same batch; wait for its result before acting on the choice.
Set requiresApproval to true for destructive operations, deployment, purchases, permission changes, access to secrets, or a request for explicit human authorization. Do not rephrase approval as a routine implementation choice.
Never treat this loop or an automatic choice as human authorization. If jev_choose cannot answer, stop and wait for the user.`;

const ACTIONS = {
  implement: "Implement the next concrete change proposed in your last report.",
  fix: "Diagnose and fix the concrete failure identified in your last report.",
  verify: "Run the next relevant verification proposed in your last report and inspect the result.",
  improve: "Make the concrete, goal-scoped improvement proposed in your last report; verify its effect.",
} as const;

/** 小数や末尾の文字を黙って受け入れず、件数設定を共通の形式で検証する。 */
function parseNonNegativeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) ? limit : undefined;
}

function getJevOptions(signal: AbortSignal): JevRequestOptions {
  return {
    apiKey: process.env.TYPESAFE_API_KEY?.trim() ?? "",
    model: process.env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL,
    signal,
  };
}

export default function jevContinue(pi: ExtensionAPI) {
  let enabled = false;
  let goal = "";
  // count は最初の実行を除く自動継続回数。max === 0 は無制限。
  let count = 0;
  let max = 0;
  let historyCount = DEFAULT_HISTORY_COUNT;
  let reason = "not started";
  let previousReport: string | null = null;
  // 中断だけでは応答到着と競合し得るため、世代番号でも古い結果の適用を防ぐ。
  let generation = 0;
  // CLI の目標は最初のプロンプトでだけ有効化し、reload/new では再適用しない。
  let pendingGoal: string | undefined;
  let request: AbortController | undefined;
  let removeTerminalListener: (() => void) | undefined;

  const status = () => `Jev ${enabled ? "on" : "off"} ${count}/${max || "unlimited"}: ${reason}`;
  const updateStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("jev-continue", status());
  };
  const notify = (ctx: ExtensionContext, message: string, warning = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, warning ? "warning" : "info");
    else process.stderr.write(`[jev-continue] ${message}\n`);
  };
  // 停止・再開・セッション切替は必ずここを通し、処理中の結果を無効化する。
  const cancelRequest = () => {
    generation += 1;
    request?.abort();
    request = undefined;
    choiceTool.cancel();
  };
  const pause = (ctx: ExtensionContext, why: string) => {
    enabled = false;
    pendingGoal = undefined;
    reason = why;
    cancelRequest();
    updateStatus(ctx);
    pi.appendEntry("jev-continue-state", { enabled, count, max, reason });
    notify(ctx, status());
  };
  const activate = (text: string, ctx: ExtensionContext): boolean => {
    const nextGoal = text.trim();
    if (!nextGoal || nextGoal.length > INPUT_LIMITS.goalCharacters) {
      notify(ctx, `Specify a goal of 1–${INPUT_LIMITS.goalCharacters} characters: /jev-on <goal>`, true);
      return false;
    }
    if (!process.env.TYPESAFE_API_KEY?.trim()) {
      notify(ctx, "TYPESAFE_API_KEY is required. Set it before starting pi.", true);
      return false;
    }
    cancelRequest();
    choiceTool.reset();
    pendingGoal = undefined;
    goal = nextGoal;
    count = 0;
    previousReport = null;
    enabled = true;
    reason = "working";
    updateStatus(ctx);
    pi.appendEntry("jev-continue-state", { enabled, goal, count, max, reason });
    return true;
  };
  const directive = (action: string) => `${action}\n\n${REPORT_INSTRUCTIONS}\n\nGoal:\n${goal}`;

  const choiceTool = registerChoiceTool(pi, {
    getGoal: () => enabled ? goal : undefined,
    getConversation: (ctx) => historyCount === 0 ? [] : extractConversation(ctx.sessionManager.buildSessionProjection().messages, historyCount),
    getRequestOptions: getJevOptions,
    pause,
    timeoutMs: JUDGMENT_TIMEOUT_MS,
  });

  // 人への確認が未解決なら、モデルが別のツールで選択を迂回することも防ぐ。
  // すでに開始済みの別ツールを巻き戻す仕組みではないため、質問ツールは単独呼出しにする。
  pi.on("tool_call", () => {
    if (choiceTool.isAwaitingHuman()) return { block: true, reason: "An unanswered Jev question requires human input." };
  });
  pi.on("turn_end", (_event, ctx) => {
    // terminate は同じバッチの全ツールの同意が必要。混在バッチでも次のモデル要求へ進ませない。
    if (choiceTool.isAwaitingHuman()) ctx.abort();
  });

  pi.registerFlag("jev-goal", { type: "string", description: "Enable Jev continuation for this goal on the first prompt" });
  pi.registerFlag("jev-max", { type: "string", default: "0", description: "Maximum Jev continuations; 0 means unlimited" });
  pi.registerFlag("jev-history", { type: "string", default: String(DEFAULT_HISTORY_COUNT), description: "Recent public conversation messages sent to Jev; 0 disables history" });

  pi.on("session_start", (event, ctx) => {
    cancelRequest();
    choiceTool.reset();
    removeTerminalListener?.();
    removeTerminalListener = undefined;
    enabled = false;
    goal = "";
    count = 0;
    max = 0;
    historyCount = DEFAULT_HISTORY_COUNT;
    reason = "session started; explicit activation required";
    previousReport = null;
    pendingGoal = undefined;
    if (event.reason === "startup") {
      const flagGoal = pi.getFlag("jev-goal");
      const flagMax = parseNonNegativeInteger(String(pi.getFlag("jev-max") ?? "0"));
      const flagHistory = parseNonNegativeInteger(String(pi.getFlag("jev-history") ?? DEFAULT_HISTORY_COUNT));
      if (flagMax === undefined || flagHistory === undefined) {
        notify(ctx, `Invalid --jev-${flagMax === undefined ? "max" : "history"}: use a non-negative integer. Automation is disabled.`, true);
      } else {
        max = flagMax;
        historyCount = flagHistory;
        if (typeof flagGoal === "string") pendingGoal = flagGoal;
      }
    }
    if (ctx.mode === "tui") {
      removeTerminalListener = ctx.ui.onTerminalInput((data) => {
        if (matchesKey(data, "escape") && (enabled || pendingGoal !== undefined || choiceTool.isPending())) {
          pause(ctx, "Escape pressed");
        }
        return undefined;
      });
    }
    updateStatus(ctx);
  });

  // extension 自身が送った開始メッセージでは停止せず、人の入力だけを優先する。
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") {
      if (enabled) pause(ctx, "user input takes priority");
      choiceTool.reset();
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (pendingGoal !== undefined) {
      const text = pendingGoal;
      pendingGoal = undefined;
      activate(text, ctx);
    }
    if (!enabled) return;
    return {
      message: {
        customType: "jev-directive",
        content: directive("Begin the next development iteration."),
        display: false,
      },
    };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!enabled) return;
    if (event.outcome !== "completed" || ctx.signal?.aborted) {
      pause(ctx, `agent ${event.outcome === "completed" ? "aborted" : event.outcome}`);
      return;
    }
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) {
      pause(ctx, "queued input takes priority");
      return;
    }
    if (event.continue) return;
    if (max > 0 && count >= max) {
      pause(ctx, "continuation limit reached");
      return;
    }
    if (request) return;
    return evaluateContinuation(event.context.contextMessages, ctx);
  });

  // 開始条件はイベント側、await をまたぐ競合と結果適用はここに閉じ込める。
  async function evaluateContinuation(
    messages: readonly AgentMessage[],
    ctx: ExtensionContext,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const ticket = generation;
    const controller = new AbortController();
    request = controller;
    // 境界では ctx.signal がない場合がある。独自の中断とタイムアウトを常に用意する。
    const signals = [controller.signal, AbortSignal.timeout(JUDGMENT_TIMEOUT_MS)];
    if (ctx.signal) signals.push(ctx.signal);
    const signal = AbortSignal.any(signals);
    reason = "judging";
    updateStatus(ctx);
    try {
      const state = buildState(goal, messages, previousReport, count + 1, historyCount);
      const result = await judge(state, getJevOptions(signal));
      // await 中に停止・新規開始・セッション切替が起きたら、通知もログも残さない。
      if (generation !== ticket || !enabled) return;
      if (signal.aborted) {
        pause(ctx, "judgment cancelled or timed out");
        return;
      }
      // 判定中にもユーザー入力や上限変更が可能なので、実行直前に再確認する。
      if (ctx.hasPendingMessages()) {
        pause(ctx, "queued input takes priority");
        return;
      }
      pi.appendEntry("jev-judgment", { iteration: count + 1, ...result });
      if (result.action === "stop") {
        pause(ctx, result.reason);
        return;
      }
      if (max > 0 && count >= max) {
        pause(ctx, "continuation limit reached");
        return;
      }
      previousReport = state.latestReport;
      count += 1;
      reason = result.action;
      updateStatus(ctx);
      // canContinue は現在の末尾が assistant だと false になる。ここで指示を追加すると
      // Pi が継続可否を再計算するため、判定前の値では継続を拒否しない。
      return {
        continue: true,
        entries: [{
          type: "custom_message" as const,
          customType: "jev-directive",
          content: directive(ACTIONS[result.action]),
          display: true,
          details: { iteration: count, action: result.action, reason: result.reason },
        }],
      };
    } catch (error) {
      if (generation !== ticket || !enabled) return;
      const cancelled = signal.aborted;
      pause(ctx, cancelled ? "judgment cancelled or timed out" : "Jev request or report validation failed");
      if (!cancelled && error instanceof Error) notify(ctx, error.message, true);
    } finally {
      // 古い処理の finally で、新しい世代が開始したリクエストを消さない。
      if (request === controller) request = undefined;
    }
  }

  pi.registerCommand("jev-on", {
    description: "Start continuous development: /jev-on <goal> (sends reports to TypeSafe)",
    handler: async (args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages() || request || choiceTool.isPending()) {
        notify(ctx, "Stop the current run before starting a new Jev goal.", true);
        return;
      }
      if (!activate(args || goal, ctx)) return;
      try {
        pi.sendUserMessage(`Work toward this goal:\n${goal}`);
      } catch {
        pause(ctx, "pi could not start the goal");
      }
    },
  });
  pi.registerCommand("jev-off", {
    description: "Disable Jev continuation and cancel any pending judgment",
    handler: async (_args, ctx) => pause(ctx, "stopped by user"),
  });
  pi.registerCommand("jev-status", {
    description: "Show Jev continuation state, goal, and JSONL log path",
    handler: async (_args, ctx) => notify(ctx, `${status()}${goal ? `\nGoal: ${goal}` : ""}\nHistory messages: ${historyCount}\nJSONL log: ${getJevLogPath()}`),
  });
  pi.registerCommand("jev-max", {
    description: "Set continuation limit: /jev-max <integer>; 0 means unlimited",
    handler: async (args, ctx) => {
      const value = parseNonNegativeInteger(args.trim());
      if (value === undefined) {
        notify(ctx, "Usage: /jev-max <non-negative integer>; 0 means unlimited", true);
        return;
      }
      max = value;
      updateStatus(ctx);
    },
  });
  pi.registerCommand("jev-history", {
    description: "Set recent conversation message count sent to Jev; 0 disables history",
    handler: async (args, ctx) => {
      const value = parseNonNegativeInteger(args.trim());
      if (value === undefined) {
        notify(ctx, "Usage: /jev-history <non-negative integer>; 0 disables history", true);
        return;
      }
      historyCount = value;
      notify(ctx, `Jev history: ${historyCount} messages. Applies to subsequent requests.`);
    },
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!enabled) return;
    // Pi の中断では before-settle が再度呼ばれない場合もあるため、最終通知でも解除する。
    enabled = false;
    cancelRequest();
    reason = "pi settled without continuation";
    updateStatus(ctx);
    notify(ctx, status());
  });

  const leaveSession = (_event: unknown, ctx: ExtensionContext) => {
    if (enabled || pendingGoal !== undefined) pause(ctx, "session or branch changing");
    else cancelRequest();
    choiceTool.reset();
  };
  pi.on("session_before_switch", leaveSession);
  pi.on("session_before_fork", leaveSession);
  pi.on("session_before_tree", leaveSession);
  pi.on("session_tree", leaveSession);
  pi.on("session_shutdown", () => {
    enabled = false;
    pendingGoal = undefined;
    cancelRequest();
    removeTerminalListener?.();
    removeTerminalListener = undefined;
  });
}
