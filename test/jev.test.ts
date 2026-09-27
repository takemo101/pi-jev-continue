import assert from "node:assert/strict";
import { test } from "node:test";
import { judge } from "../src/jev.ts";
import type { JudgmentState } from "../src/state.ts";
import { EMPTY_POLICY } from "../src/policy.ts";
import { isolateJevLogs } from "./log-environment.ts";

isolateJevLogs();

const state: JudgmentState = {
  goal: "Implement a local task list with persistent storage.",
  latestReport: "The list is implemented. Next I will run the persistence tests.",
  previousReport: null,
  conversation: [],
  recentTools: [],
  iteration: 1,
  policy: EMPTY_POLICY,
};
const options = {
  apiKey: "test-secret-key",
  model: "jev-1.13.0",
  signal: new AbortController().signal,
};

function fixture(choice = "verify", confidence = 0.9, human = 0.01, scope = 0.99) {
  return {
    model: "jev-1.13.0",
    answers: {
      next_step: {
        type: "choice",
        choice,
        confidence,
        probabilities: Object.fromEntries(
          ["implement", "fix", "verify", "improve", "other"].map((name) => [name, name === choice ? 0.96 : 0.01]),
        ),
      },
      needs_human: { type: "noul", noul: human },
      in_scope: { type: "noul", noul: scope },
    },
    usage: { input_tokens: 200, output_tokens: 40 },
  };
}

// These fixtures test deterministic policy, not the accuracy of Jev's judgments.
for (const action of ["implement", "fix", "verify", "improve"]) {
  test(`allows ${action} at all inclusive decision boundaries`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(fixture(action, 0.85, 0.1, 0.9)));
    assert.equal((await judge(state, options)).action, action);
  });
}

for (const scenario of [
  { name: "confidence just below the floor", confidence: 0.849999, human: 0.1, scope: 0.9, reason: /confidence/i },
  { name: "uncertain next action", confidence: 0.5, human: 0.1, scope: 0.9, reason: /confidence/i },
  { name: "human risk just above the ceiling", confidence: 0.85, human: 0.100001, scope: 0.9, reason: /human/i },
  { name: "uncertain human dependency", confidence: 0.9, human: 0.5, scope: 0.99, reason: /human/i },
  { name: "scope just below the floor", confidence: 0.85, human: 0.1, scope: 0.899999, reason: /goal/i },
  { name: "out-of-scope action", confidence: 0.9, human: 0, scope: 0, reason: /goal/i },
  { name: "uncertain scope", confidence: 0.9, human: 0, scope: 0.5, reason: /goal/i },
]) {
  test(`pauses for ${scenario.name}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(
      fixture("verify", scenario.confidence, scenario.human, scenario.scope),
    ));
    const result = await judge(state, options);
    assert.equal(result.action, "stop");
    assert.match(result.reason, scenario.reason);
  });
}

test("human veto takes precedence over scope, low confidence, and no actionable task", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(fixture("other", 0.2, 1, 0)));
  const result = await judge(state, options);
  assert.equal(result.action, "stop");
  assert.match(result.reason, /human/i);
});

test("other pauses even with confident, in-scope, human-independent answers", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(fixture("other", 1, 0, 1)));
  const result = await judge(state, options);
  assert.equal(result.action, "stop");
  assert.match(result.reason, /no supported concrete next action/i);
});

function withNext(overrides: Record<string, unknown>) {
  const body = fixture();
  return { ...body, answers: { ...body.answers, next_step: { ...body.answers.next_step, ...overrides } } };
}

const valid = fixture();
const malformed = [
  { name: "null response", body: null },
  { name: "missing answers", body: { model: valid.model, usage: valid.usage } },
  { name: "missing scope even when human vetoes", body: { ...valid, answers: { next_step: valid.answers.next_step, needs_human: { type: "noul", noul: 1 } } } },
  { name: "missing human answer", body: { ...valid, answers: { next_step: valid.answers.next_step, in_scope: valid.answers.in_scope } } },
  { name: "missing next action", body: { ...valid, answers: { needs_human: valid.answers.needs_human, in_scope: valid.answers.in_scope } } },
  { name: "unrecognized choice", body: withNext({ choice: "deploy" }) },
  { name: "incorrect choice type", body: withNext({ type: "score" }) },
  { name: "missing confidence", body: withNext({ confidence: undefined }) },
  { name: "string confidence", body: withNext({ confidence: "0.99" }) },
  { name: "confidence above one", body: withNext({ confidence: 1.01 }) },
  { name: "negative confidence", body: withNext({ confidence: -0.01 }) },
  { name: "missing distribution", body: withNext({ probabilities: undefined }) },
  { name: "incomplete distribution", body: withNext({ probabilities: { verify: 1 } }) },
  { name: "negative probability", body: withNext({ probabilities: { ...valid.answers.next_step.probabilities, fix: -0.01 } }) },
  { name: "probability above one", body: withNext({ probabilities: { ...valid.answers.next_step.probabilities, verify: 1.1 } }) },
  { name: "non-normalized distribution", body: withNext({ probabilities: { implement: 0, fix: 0, verify: 0.9, improve: 0, other: 0 } }) },
  { name: "choice inconsistent with distribution", body: withNext({ choice: "fix" }) },
  { name: "unknown distribution option", body: withNext({ probabilities: { ...valid.answers.next_step.probabilities, deploy: 0 } }) },
  { name: "incorrect human answer type", body: { ...valid, answers: { ...valid.answers, needs_human: { type: "choice", noul: 0 } } } },
  { name: "human probability below zero", body: fixture("verify", 0.9, -0.1) },
  { name: "scope probability above one", body: fixture("verify", 0.9, 0, 1.1) },
  { name: "string Noul", body: { ...valid, answers: { ...valid.answers, in_scope: { type: "noul", noul: "1" } } } },
  { name: "missing model", body: { answers: valid.answers, usage: valid.usage } },
  { name: "missing usage", body: { model: valid.model, answers: valid.answers } },
];

for (const scenario of malformed) {
  test(`rejects ${scenario.name}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(scenario.body));
    await assert.rejects(judge(state, options), /invalid judgment response/i);
  });
}

test("rejects non-finite probability parsed from JSON", async (t) => {
  const body = JSON.stringify(withNext({ confidence: "overflow" })).replace('"overflow"', "1e999");
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  await assert.rejects(judge(state, options), /invalid judgment response/i);
});

test("invalid JSON errors do not expose response text", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`private provider text ${options.apiKey}`));
  await assert.rejects(judge(state, options), (error: Error) => {
    assert.match(error.message, /invalid judgment response/i);
    assert.doesNotMatch(error.message, /private provider text|test-secret-key/);
    return true;
  });
});

test("HTTP failure fails closed without retry or leaking body or credentials", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(
    `private provider text ${options.apiKey}`, { status: 429, statusText: options.apiKey },
  ));
  await assert.rejects(judge(state, options), (error: Error) => {
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /private provider text|test-secret-key/);
    return true;
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("network failures do not expose exception details", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`network details ${options.apiKey}`); });
  await assert.rejects(judge(state, options), (error: Error) => {
    assert.match(error.message, /request failed/i);
    assert.doesNotMatch(error.message, /network details|test-secret-key/);
    return true;
  });
});

test("already-cancelled judgments never contact the service", async (t) => {
  const controller = new AbortController();
  controller.abort(new Error(options.apiKey));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fixture()));
  await assert.rejects(judge(state, { ...options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("cancellation while waiting for the service rejects instead of continuing", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => reject(new Error(options.apiKey)), { once: true });
    return promise;
  });
  const pending = judge(state, { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: Error) => {
    assert.equal(error.name, "AbortError");
    assert.doesNotMatch(error.message, /test-secret-key/);
    return true;
  });
});
