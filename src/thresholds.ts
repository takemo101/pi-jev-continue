export type JudgmentLevel = 1 | 2 | 3 | 4 | 5;

export const DEFAULT_JUDGMENT_LEVEL: JudgmentLevel = 5;

export interface JudgmentThresholds {
  readonly minConfidence: number;
  readonly maxNeedsHuman: number;
  readonly minInScope: number;
}

// Operational preferences, not calibrated safety probabilities or model instructions.
const THRESHOLDS: Readonly<Record<JudgmentLevel, Readonly<JudgmentThresholds>>> = Object.freeze({
  1: Object.freeze({ minConfidence: 0.65, maxNeedsHuman: 0.3, minInScope: 0.7 }),
  2: Object.freeze({ minConfidence: 0.7, maxNeedsHuman: 0.25, minInScope: 0.75 }),
  3: Object.freeze({ minConfidence: 0.75, maxNeedsHuman: 0.2, minInScope: 0.8 }),
  4: Object.freeze({ minConfidence: 0.8, maxNeedsHuman: 0.15, minInScope: 0.85 }),
  5: Object.freeze({ minConfidence: 0.85, maxNeedsHuman: 0.1, minInScope: 0.9 }),
});

export function getJudgmentThresholds(level: JudgmentLevel): Readonly<JudgmentThresholds> {
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    throw new Error("Judgment level must be an integer from 1 to 5.");
  }
  return THRESHOLDS[level];
}

export function parseJudgmentLevel(value: string): JudgmentLevel | undefined {
  switch (value) {
    case "1": return 1;
    case "2": return 2;
    case "3": return 3;
    case "4": return 4;
    case "5": return 5;
    default: return undefined;
  }
}
