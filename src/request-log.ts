import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type JevLogEvent =
  | { event: "request"; url: string; method: "POST"; model: string; body: string }
  | { event: "response"; status: number; durationMs: number; body: string | null; aborted: boolean }
  | { event: "error"; kind: "network" | "cancelled" | "response_body" | "invalid_json"; durationMs: number; status?: number };

export interface JevRequestLog {
  append(event: JevLogEvent): void;
}

// インスタンスごとに分離し、別の pi プロセスや reload と同じファイルへ書き込まない。
const filename = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${randomUUID()}.jsonl`;

export function getJevLogPath(): string {
  const directory = process.env.JEV_LOG_DIR?.trim() || join(getAgentDir(), "jev-continue", "logs");
  return join(resolve(directory), filename);
}

/** 送信前の記録を保証するため同期追記し、書けなければ未記録のまま続行しない。 */
export function createJevRequestLog(apiKey: string): JevRequestLog {
  // 通信待ちの間に環境変数が変わっても、一組の送受信ログの保存先は変えない。
  const path = getJevLogPath();
  const requestId = randomUUID();
  const encodedKey = JSON.stringify(apiKey).slice(1, -1);
  return {
    append(event) {
      const record = { version: 1, timestamp: new Date().toISOString(), requestId, ...event };
      const line = JSON.stringify(record, (_key, value: unknown) => {
        if (typeof value !== "string" || !apiKey) return value;
        // HTTP 本文内にキーが混入していても、プレーン表現と JSON エスケープ表現を除去する。
        return value.replaceAll(encodedKey, "[REDACTED]").replaceAll(apiKey, "[REDACTED]");
      });
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // fs の例外本文にはパスなどが含まれるため、そのまま通知へ渡さない。
        throw new Error("Could not write Jev JSONL log. Check JEV_LOG_DIR, directory permissions, and free disk space.");
      }
    },
  };
}
