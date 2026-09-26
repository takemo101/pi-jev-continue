export interface JevRequestOptions {
  apiKey: string;
  model: string;
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
  let response: Response;
  try {
    response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model, questions }),
      signal,
      // 固定 API 以外へ認証ヘッダーを転送しない。
      redirect: "error",
    });
  } catch {
    // エラー本文や低レベル例外には機密情報が含まれ得るため、呼出し元へ転送しない。
    ensureActive(signal);
    throw new Error("Jev request failed before receiving a response.");
  }
  ensureActive(signal);
  if (!response.ok) throw new Error(`Jev request failed (HTTP ${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    ensureActive(signal);
    invalidResponse();
  }
  ensureActive(signal);
  return body;
}
