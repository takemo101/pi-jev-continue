import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { requestJev, resolveJevEndpoint } from "../src/client.ts";
import { isolateJevLogs } from "./log-environment.ts";

const root = isolateJevLogs();
const apiKey = "test-private-api-key";
const options = { apiKey, model: "jev-1.13.0", signal: new AbortController().signal };
const questions = { selection: { type: "choice", instructions: "Choose a storage engine", criteria: { sqlite: "Embedded storage" } } };

function directory(t: TestContext): string {
  const path = join(root, randomUUID());
  const previous = process.env.JEV_LOG_DIR;
  process.env.JEV_LOG_DIR = path;
  t.after(() => { process.env.JEV_LOG_DIR = previous; });
  return path;
}

interface RecordLine {
  event: string;
  requestId: string;
  timestamp: string;
  body?: string | null;
  status?: number;
  durationMs?: number;
  aborted?: boolean;
  kind?: string;
  url?: string;
}

function records(path: string): RecordLine[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((name) => readFileSync(join(path, name), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)));
}

test("routes requests through the configured base URL and preserves its path prefix", async (t) => {
  const path = directory(t);
  let destination: string | URL | Request | undefined;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    destination = url;
    return Response.json({ model: "jev-1.13.0", answers: {}, usage: {} });
  });
  await requestJev({}, questions, { ...options, baseUrl: "https://proxy.example.test/gateway/" });
  assert.equal(destination, "https://proxy.example.test/gateway/v1/systemone");
  assert.equal(records(path)[0].url, destination);
});

test("resolves default and prefixed HTTP endpoints without losing the base path", () => {
  for (const baseUrl of [undefined, "", " \t\n "]) {
    assert.equal(resolveJevEndpoint(baseUrl), "https://api.typesafe.ai/v1/systemone");
  }
  assert.equal(resolveJevEndpoint(" https://proxy.example.test/gateway/// "), "https://proxy.example.test/gateway/v1/systemone");
  assert.equal(resolveJevEndpoint("http://localhost:8123/nested/base/"), "http://localhost:8123/nested/base/v1/systemone");
});

test("rejects invalid destinations before logging or HTTP without exposing the input", async (t) => {
  const path = directory(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const invalidBases = [
    "https://private-user:private-password@proxy.example.test",
    "https://private-user@proxy.example.test",
    "https://proxy.example.test?private-query",
    "https://proxy.example.test?",
    "https://proxy.example.test#private-fragment",
    "https://proxy.example.test#",
    "ftp://proxy.example.test",
    "//proxy.example.test",
    "/gateway",
    "https:proxy.example.test",
    "https://",
    "not a URL",
  ];
  for (const baseUrl of invalidBases) {
    const hidesInput = (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.ok(!String(error).includes(baseUrl));
      assert.ok(!JSON.stringify(error).includes(baseUrl));
      return true;
    };
    assert.throws(() => resolveJevEndpoint(baseUrl), hidesInput);
    await assert.rejects(requestJev({}, questions, { ...options, baseUrl }), hidesInput);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(existsSync(path), false);
});

test("persists the request before sending and the complete response with a matching ID", async (t) => {
  const path = directory(t);
  const state = { goal: "日本語の目標\n次の行", iteration: 2 };
  const response = '{ "model": "actual-model", "answers": {}, "usage": {"input_tokens": 42} }\n';
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const saved = records(path);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].event, "request");
    assert.equal(saved[0].url, url);
    assert.deepEqual(JSON.parse(saved[0].body!), { state, model: options.model, questions });
    return new Response(response);
  });
  assert.deepEqual(await requestJev(state, questions, options), JSON.parse(response));
  const saved = records(path);
  assert.deepEqual(saved.map((entry) => entry.event), ["request", "response"]);
  assert.equal(saved[0].requestId, saved[1].requestId);
  assert.ok(saved[0].requestId);
  assert.equal(saved[1].status, 200);
  assert.equal(saved[1].body, response);
  assert.ok(Number.isFinite(Date.parse(saved[0].timestamp)));
  assert.ok(typeof saved[1].durationMs === "number" && saved[1].durationMs >= 0);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o700);
    assert.equal(statSync(join(path, readdirSync(path)[0])).mode & 0o777, 0o600);
  }
});

test("logs non-JSON HTTP failure bodies but never records the configured credential", async (t) => {
  const path = directory(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(`failed\n${apiKey}`, { status: 429 }));
  await assert.rejects(requestJev({ report: `Do not expose ${apiKey}` }, questions, options), /HTTP 429/);
  const saved = records(path);
  const response = saved.find((entry) => entry.event === "response");
  assert.equal(response?.status, 429);
  assert.equal(response?.body, "failed\n[REDACTED]");
  assert.doesNotMatch(JSON.stringify(saved), /test-private-api-key|Authorization|Bearer/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("retains invalid successful JSON for diagnosis without leaking it into errors", async (t) => {
  const path = directory(t);
  t.mock.method(globalThis, "fetch", async () => new Response("<html>provider failure</html>\n"));
  await assert.rejects(requestJev({}, questions, options), /invalid judgment response/);
  assert.equal(records(path).find((entry) => entry.event === "response")?.body, "<html>provider failure</html>\n");
});

test("records a sanitized transport failure correlated to its request", async (t) => {
  const path = directory(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private socket diagnostics"); });
  await assert.rejects(requestJev({}, questions, options), /request failed/);
  const saved = records(path);
  assert.deepEqual(saved.map((entry) => entry.event), ["request", "error"]);
  assert.equal(saved[0].requestId, saved[1].requestId);
  assert.equal(saved[1].kind, "network");
  assert.doesNotMatch(JSON.stringify(saved), /private socket diagnostics/);
});

test("logs an aborted HTTP request without recording signal.reason", async (t) => {
  const path = directory(t);
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const waiting = Promise.withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => waiting.reject(init.signal?.reason), { once: true });
    return waiting.promise;
  });
  const pending = requestJev({}, questions, { ...options, signal: controller.signal });
  controller.abort(new Error("private cancellation reason"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(records(path).find((entry) => entry.event === "error")?.kind, "cancelled");
  assert.doesNotMatch(JSON.stringify(records(path)), /private cancellation reason/);
});

test("retains a late response even when its judgement is discarded after cancellation", async (t) => {
  const path = directory(t);
  const controller = new AbortController();
  const waiting = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", async () => waiting.promise);
  const pending = requestJev({}, questions, { ...options, signal: controller.signal });
  controller.abort();
  waiting.resolve(Response.json({ late: true }));
  await assert.rejects(pending, { name: "AbortError" });
  const response = records(path).find((entry) => entry.event === "response");
  assert.equal(response?.aborted, true);
  assert.deepEqual(JSON.parse(response!.body!), { late: true });
});

test("does not send if the request log cannot be persisted", async (t) => {
  const path = directory(t);
  writeFileSync(path, "not a directory");
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(requestJev({}, questions, options), /Jev JSONL log/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("does not return an answer if response logging fails", async (t) => {
  const path = directory(t);
  t.mock.method(globalThis, "fetch", async () => {
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, "not a directory");
    return Response.json({ accepted: true });
  });
  await assert.rejects(requestJev({}, questions, options), /Jev JSONL log/);
});

test("concurrent requests remain independently correlated when responses arrive out of order", async (t) => {
  const path = directory(t);
  const waiting = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
  let index = 0;
  t.mock.method(globalThis, "fetch", async () => waiting[index++].promise);
  const first = requestJev({ task: "first" }, questions, options);
  const second = requestJev({ task: "second" }, questions, options);
  waiting[1].resolve(Response.json({ result: "second" }));
  await second;
  waiting[0].resolve(Response.json({ result: "first" }));
  await first;
  const saved = records(path);
  const requests = saved.filter((entry) => entry.event === "request");
  assert.equal(new Set(requests.map((entry) => entry.requestId)).size, 2);
  for (const request of requests) {
    const response = saved.find((entry) => entry.event === "response" && entry.requestId === request.requestId);
    assert.equal(JSON.parse(request.body!).state.task, JSON.parse(response!.body!).result);
  }
});

test("records a response body read failure without exposing stream errors", async (t) => {
  const path = directory(t);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("private stream diagnostics")); },
  })));
  await assert.rejects(requestJev({}, questions, options), /response body could not be read/);
  const saved = records(path);
  assert.equal(saved.find((entry) => entry.event === "response")?.body, null);
  assert.equal(saved.find((entry) => entry.event === "error")?.kind, "response_body");
  assert.doesNotMatch(JSON.stringify(saved), /private stream diagnostics/);
});

test("redacts configured credentials inside JSON-escaped request text and plain response text", async (t) => {
  const path = directory(t);
  const secret = 'private"quoted\\key';
  t.mock.method(globalThis, "fetch", async () => new Response(secret, { status: 401 }));
  await assert.rejects(requestJev({ note: secret }, questions, { ...options, apiKey: secret }), /HTTP 401/);
  const saved = records(path);
  assert.equal(JSON.parse(saved.find((entry) => entry.event === "request")!.body!).state.note, "[REDACTED]");
  assert.equal(saved.find((entry) => entry.event === "response")?.body, "[REDACTED]");
});
