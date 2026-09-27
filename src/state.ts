import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { EMPTY_POLICY, type ContinuationPolicy } from "./policy.ts";

export const DEFAULT_HISTORY_COUNT = 10;

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

/** 現在のコンテキストから公開発言だけを取り、発言者と時系列を保持する。 */
export function extractConversation(
  messages: readonly AgentMessage[],
  limit = DEFAULT_HISTORY_COUNT,
  end = messages.length,
): ConversationMessage[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("History count must be a non-negative safe integer.");
  const conversation: ConversationMessage[] = [];
  for (let index = end - 1; index >= 0 && conversation.length < limit; index--) {
    const message = messages[index];
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    if (text.trim()) conversation.push({ role: message.role, text });
  }
  return conversation.reverse();
}

// 文字数制限とリクエスト全体の UTF-8 バイト制限は別物。
// 目標の上限はコマンド受付時にも使い、受付と送信で条件がずれないようにする。
export const INPUT_LIMITS = {
  goalCharacters: 4_000,
  reportCharacters: 12_000,
  toolResults: 6,
  toolOutputCharacters: 2_000,
  stateBytes: 24_000,
} as const;

export interface JudgmentState {
  goal: string;
  latestReport: string;
  previousReport: string | null;
  conversation: ConversationMessage[];
  recentTools: Array<{
    name: string;
    isError: boolean;
    output: string;
    truncated: boolean;
  }>;
  iteration: number;
  policy: ContinuationPolicy;
}

/**
 * 現在の分岐の公開テキストだけを Jev に渡す。完了報告がなければ例外で停止する。
 * thinking・画像・ツール引数・details は、判定に不要なので含めない。
 */
export function buildState(
  goal: string,
  messages: readonly AgentMessage[],
  previousReport: string | null,
  iteration: number,
  historyCount = DEFAULT_HISTORY_COUNT,
  policy: ContinuationPolicy = EMPTY_POLICY,
): JudgmentState {
  if (!goal.trim() || goal.length > INPUT_LIMITS.goalCharacters) {
    throw new Error(`Goal must contain text and be at most ${INPUT_LIMITS.goalCharacters} characters.`);
  }

  // 古い完了報告で新しい依頼を判断しない。圧縮で user が消えた場合は -1 を境界にする。
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  const reportIndex = messages.findLastIndex((message) => message.role === "assistant");
  const report = messages[reportIndex];
  if (reportIndex <= userIndex || report?.role !== "assistant" || report.stopReason !== "stop") {
    throw new Error("A completed assistant report after the latest user message is required.");
  }

  const latestReport = report.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  if (!latestReport.trim() || latestReport.length > INPUT_LIMITS.reportCharacters) {
    throw new Error(`Assistant report must contain text and be at most ${INPUT_LIMITS.reportCharacters} characters.`);
  }

  // 新しい結果から上限件数まで拾い、送信時だけ時系列順に戻す。
  // 報告・目標と違い、補助資料のツール出力だけは省略フラグ付きで切り詰める。
  const recentTools: JudgmentState["recentTools"] = [];
  for (let index = reportIndex - 1; index > userIndex && recentTools.length < INPUT_LIMITS.toolResults; index--) {
    const message = messages[index];
    if (message?.role !== "toolResult") continue;
    const output = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    recentTools.push({
      name: message.toolName,
      isError: message.isError,
      output: output.slice(0, INPUT_LIMITS.toolOutputCharacters),
      truncated: output.length > INPUT_LIMITS.toolOutputCharacters,
    });
  }
  recentTools.reverse();

  // 判定対象の最新報告は別フィールドにあるため、履歴にはそれより前の発言を入れる。
  const conversation = extractConversation(messages, historyCount, reportIndex);
  const state = { goal, latestReport, previousReport, conversation, recentTools, iteration, policy };
  // CJK を含む入力でも、質問文を加える余地を残す。判断材料を黙って削らず停止する。
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > INPUT_LIMITS.stateBytes) {
    throw new Error(`Judgment state exceeds the ${INPUT_LIMITS.stateBytes}-byte input budget; reduce the history count or shorten the goal or iteration report.`);
  }
  return state;
}
