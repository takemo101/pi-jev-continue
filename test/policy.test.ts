import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EMPTY_POLICY, loadContinuationPolicy, POLICY_MAX_BYTES } from "../src/policy.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-jev-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  return { root, home, cwd };
}

function writePolicy(directory: string, text: string | Uint8Array): string {
  mkdirSync(join(directory, ".pi"), { recursive: true });
  const path = join(directory, ".pi", "CONTINUE.md");
  writeFileSync(path, text);
  return path;
}

test("allows missing policy files without creating them", (t) => {
  const { home, cwd } = fixture(t);
  assert.equal(loadContinuationPolicy(cwd, home), EMPTY_POLICY);
  assert.deepEqual(EMPTY_POLICY, []);
  assert.equal(Object.isFrozen(EMPTY_POLICY), true);
});

test("loads global then project policy preserving exact UTF-8 text", (t) => {
  const { home, cwd } = fixture(t);
  const globalText = "\uFEFF# Global\r\n  Continue: 日本語\r\n\r\n";
  const projectText = "\n# Project\nStop at the goal.\t\n";
  const globalPath = writePolicy(home, globalText);
  const projectPath = writePolicy(cwd, projectText);
  const policy = loadContinuationPolicy(cwd, home);
  assert.deepEqual(policy, [
    { scope: "global", path: globalPath, text: globalText },
    { scope: "project", path: projectPath, text: projectText },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(policy)), policy);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy[0]), true);
  assert.equal(Object.isFrozen(policy[1]), true);
  assert.throws(() => Object.assign(policy[0], { text: "changed" }), TypeError);
  assert.throws(() => Object.assign(policy, { 0: policy[1] }), TypeError);
});

test("does not discover policy in an ancestor directory", (t) => {
  const { root, home, cwd } = fixture(t);
  writePolicy(root, "Ancestor policy must not apply.");
  assert.deepEqual(loadContinuationPolicy(cwd, home), []);
});

test("applies identical home and cwd policy once with project scope", (t) => {
  const { home } = fixture(t);
  const text = "x".repeat(POLICY_MAX_BYTES);
  const path = writePolicy(home, text);
  assert.deepEqual(loadContinuationPolicy(join(home, "."), home), [
    { scope: "project", path, text },
  ]);
});

test("keeps the active snapshot unchanged while a new load sees edits and additions", (t) => {
  const { home, cwd } = fixture(t);
  const globalPath = writePolicy(home, "Original global policy");
  const snapshot = loadContinuationPolicy(cwd, home);
  writePolicy(home, "Updated global policy");
  const projectPath = writePolicy(cwd, "New project policy");
  assert.deepEqual(snapshot, [
    { scope: "global", path: globalPath, text: "Original global policy" },
  ]);
  assert.deepEqual(loadContinuationPolicy(cwd, home), [
    { scope: "global", path: globalPath, text: "Updated global policy" },
    { scope: "project", path: projectPath, text: "New project policy" },
  ]);
});

test("limits combined raw UTF-8 bytes rather than characters and accepts the exact boundary", (t) => {
  const { home, cwd } = fixture(t);
  const globalText = "あ".repeat(1000);
  const projectText = "é".repeat((POLICY_MAX_BYTES - Buffer.byteLength(globalText)) / 2);
  writePolicy(home, globalText);
  const projectPath = writePolicy(cwd, projectText);
  assert.deepEqual(loadContinuationPolicy(cwd, home).map((entry) => entry.text), [globalText, projectText]);
  writePolicy(cwd, `${projectText}x`);
  assert.throws(() => loadContinuationPolicy(cwd, home), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(projectPath));
    assert.match(error.message, /8000.*bytes/);
    assert.equal(error.message.includes(projectText), false);
    return true;
  });
});

test("accepts an empty project file when the global policy uses the entire byte budget", (t) => {
  const { home, cwd } = fixture(t);
  writePolicy(home, "g".repeat(POLICY_MAX_BYTES));
  const path = writePolicy(cwd, "");
  assert.deepEqual(loadContinuationPolicy(cwd, home)[1], { scope: "project", path, text: "" });
});

test("rejects a huge sparse policy file without reading its contents", (t) => {
  const { home, cwd } = fixture(t);
  const path = writePolicy(cwd, "");
  truncateSync(path, 1024 * 1024 * 1024);
  assert.throws(() => loadContinuationPolicy(cwd, home), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path));
    assert.match(error.message, /8000.*bytes/);
    return true;
  });
});

test("rejects invalid UTF-8 instead of silently substituting replacement characters", (t) => {
  const { home, cwd } = fixture(t);
  writePolicy(home, "Valid global policy");
  const path = writePolicy(cwd, Uint8Array.from([0xc3, 0x28]));
  assert.throws(() => loadContinuationPolicy(cwd, home), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path));
    assert.match(error.message, /UTF-8/);
    return true;
  });
});

test("rejects a directory at the policy path", (t) => {
  const { home, cwd } = fixture(t);
  const path = join(cwd, ".pi", "CONTINUE.md");
  mkdirSync(path, { recursive: true });
  assert.throws(() => loadContinuationPolicy(cwd, home), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path));
    assert.match(error.message, /regular file/);
    return true;
  });
});

test("does not treat non-directory path errors as a missing policy", (t) => {
  const { home, cwd } = fixture(t);
  writeFileSync(join(cwd, ".pi"), "Not a directory");
  assert.throws(() => loadContinuationPolicy(cwd, home), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(join(cwd, ".pi", "CONTINUE.md")));
    assert.match(error.message, /ENOTDIR/);
    return true;
  });
});

test("rejects an unreadable policy rather than silently omitting it", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, (t) => {
  const { home, cwd } = fixture(t);
  const path = writePolicy(cwd, "Private policy text");
  chmodSync(path, 0o000);
  try {
    assert.throws(() => loadContinuationPolicy(cwd, home), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path));
      assert.match(error.message, /EACCES|EPERM/);
      assert.equal(error.message.includes("Private policy text"), false);
      return true;
    });
  } finally {
    chmodSync(path, 0o600);
  }
});
