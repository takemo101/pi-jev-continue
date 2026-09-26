import type { AgentMessage } from "@earendil-works/pi-agent-core";

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
  recentTools: Array<{
    name: string;
    isError: boolean;
    output: string;
    truncated: boolean;
  }>;
  iteration: number;
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

  const state = { goal, latestReport, previousReport, recentTools, iteration };
  // CJK を含む入力でも、質問文を加える余地を残す。判断材料を黙って削らず停止する。
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > INPUT_LIMITS.stateBytes) {
    throw new Error(`Judgment state exceeds the ${INPUT_LIMITS.stateBytes}-byte input budget; shorten the goal or iteration report.`);
  }
  return state;
}
