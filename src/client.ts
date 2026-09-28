import { createJevRequestLog } from "./request-log.ts";

export interface JevRequestOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  signal: AbortSignal;
}

export interface JevResponse {
  model: string;
  answers: Record<string, unknown>;
  usage: Record<string, unknown>;
}

export interface ChoiceAnswer<T extends string> {
  choice: T;
  confidence: number;
}

export function resolveJevEndpoint(baseUrl?: string): string {
  const base = baseUrl?.trim() || "https://api.typesafe.ai";
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Invalid Jev base URL.");
  }
  if (
    !/^https?:\/\//i.test(base)
    || (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== ""
    || url.password !== ""
    || /[?#\\\u0000-\u0020\u007f]/.test(base)
  ) {
    throw new Error("Invalid Jev base URL.");
  }
  return `${url.href.replace(/\/+$/, "")}/v1/systemone`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalidResponse(): never {
  throw new Error("Jev returned an invalid judgment response.");
}

export function parseEnvelope(value: unknown): JevResponse {
  if (!record(value) || typeof value.model !== "string" || !value.model.trim() ||
      !record(value.answers) || !record(value.usage)) invalidResponse();
  for (const key of ["input_tokens", "output_tokens"]) {
    const count = value.usage[key];
    if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
      invalidResponse();
    }
  }
  return { model: value.model, answers: value.answers, usage: value.usage };
}

export function parseChoice<T extends string>(value: unknown, choices: readonly T[]): ChoiceAnswer<T> {
  if (!record(value) || value.type !== "choice" || !probability(value.confidence) ||
      !record(value.probabilities)) invalidResponse();
  const selected = choices.find((choice) => choice === value.choice);
  if (selected === undefined || Object.keys(value.probabilities).length !== choices.length) invalidResponse();
  let total = 0;
  let maximum = 0;
  for (const choice of choices) {
    const p = value.probabilities[choice];
    if (!probability(p)) invalidResponse();
    total += p;
    maximum = Math.max(maximum, p);
  }
  // 丸め誤差は許容するが、分布と選択値が矛盾する回答は採用しない。
  if (Math.abs(total - 1) > 0.000001 || value.probabilities[selected] !== maximum) invalidResponse();
  return { choice: selected, confidence: value.confidence };
}

export function parseNoul(value: unknown): number {
  if (!record(value) || value.type !== "noul" || !probability(value.noul)) invalidResponse();
  return value.noul;
}

function ensureActive(signal: AbortSignal): void {
  // signal.reason は呼出し元の任意の値なので、その内容を通知やログに流さない。
  if (signal.aborted) throw new DOMException("Jev judgment was cancelled.", "AbortError");
}

/** 両判定の通信を一か所に集約する。再試行や認証情報を含むエラーの転送はしない。 */
export async function requestJev(
  state: unknown,
  questions: Record<string, unknown>,
  options: JevRequestOptions,
): Promise<unknown> {
  const { apiKey, model, signal } = options;
  ensureActive(signal);
  const url = resolveJevEndpoint(options.baseUrl);
  const bodyText = JSON.stringify({ state, model, questions });
  const log = createJevRequestLog(apiKey);
  const started = performance.now();
  const durationMs = () => Math.round((performance.now() - started) * 1000) / 1000;
  log.append({ event: "request", url, method: "POST", model, body: bodyText });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: bodyText,
      signal,
      // 設定した送信先以外へ認証ヘッダーを転送しない。
      redirect: "error",
    });
  } catch {
    log.append({ event: "error", kind: signal.aborted ? "cancelled" : "network", durationMs: durationMs() });
    ensureActive(signal);
    throw new Error("Jev request failed before receiving a response.");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    log.append({ event: "response", status: response.status, durationMs: durationMs(), body: null, aborted: signal.aborted });
    log.append({ event: "error", kind: signal.aborted ? "cancelled" : "response_body", status: response.status, durationMs: durationMs() });
    ensureActive(signal);
    throw new Error("Jev response body could not be read.");
  }
  // 中断後の遅い応答や不正 JSON、HTTP エラーも、判断に採用する前に記録する。
  log.append({ event: "response", status: response.status, durationMs: durationMs(), body: text, aborted: signal.aborted });
  ensureActive(signal);
  if (!response.ok) throw new Error(`Jev request failed (HTTP ${response.status}).`);
  try {
    return JSON.parse(text);
  } catch {
    log.append({ event: "error", kind: "invalid_json", status: response.status, durationMs: durationMs() });
    invalidResponse();
  }
}
