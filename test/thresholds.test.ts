import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJudgmentLevel } from "../src/thresholds.ts";

for (const level of [1, 2, 3, 4, 5] as const) {
  test(`parses exact judgment level ${level}`, () => {
    assert.equal(parseJudgmentLevel(String(level)), level);
  });
}

for (const value of ["", "0", "6", "-1", "1.5", "01", "1.0", "+1", "1e0", " 1", "1 ", "1\n", "NaN", "Infinity", "１", "true"]) {
  test(`rejects non-level input ${JSON.stringify(value)} without coercion`, () => {
    assert.equal(parseJudgmentLevel(value), undefined);
  });
}
