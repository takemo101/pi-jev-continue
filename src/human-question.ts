import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChoiceQuestion } from "./choice.ts";
import { showHumanQuestionTui } from "./human-question-tui.ts";

export interface HumanAnswer {
  optionIndex: number;
  notes?: string;
}

export interface HumanQuestionPrompt {
  question: ChoiceQuestion;
  reason: string;
  signal: AbortSignal;
  notesLimit: number;
}

export const HUMAN_NOTES_LIMIT = 2000;

async function askRpc(ctx: ExtensionContext, prompt: HumanQuestionPrompt): Promise<HumanAnswer | undefined> {
  const { question, reason, signal, notesLimit } = prompt;
  const choices = question.options.map((option, index) => `${index + 1}. ${option.label}\n   ${option.description}`);
  const noteAction = "Add/edit note (optional; not an answer)";
  let notes: string | undefined;
  while (!signal.aborted) {
    const title = [
      `Question\n${question.question}`,
      `Context\n${question.context || "No additional context."}`,
      `Why your input is needed\n${reason}`,
      ...(notes ? [`Your note\n${notes}`] : []),
      "Options\nChoose an option to submit. A note alone does not answer the question or grant additional authorization.",
    ].join("\n\n");
    const selection = await ctx.ui.select(title, [...choices, noteAction], { signal });
    if (signal.aborted || selection === undefined) return undefined;
    const optionIndex = choices.indexOf(selection);
    if (optionIndex >= 0) return { optionIndex, ...(notes ? { notes } : {}) };
    if (selection !== noteAction) return undefined;

    let draft = notes;
    let error: string | undefined;
    while (!signal.aborted) {
      const noteTitle = [
        `Optional note (maximum ${notesLimit} characters)`,
        "Enter a replacement note; leave empty to clear. Saving returns to the options without submitting an answer.",
        ...(error ? [error] : []),
      ].join("\n\n");
      const value = await ctx.ui.input(noteTitle, draft, { signal });
      if (signal.aborted || value === undefined) return undefined;
      const trimmed = value.trim();
      if (trimmed.length > notesLimit) {
        draft = value;
        error = `Note is too long (${trimmed.length}/${notesLimit} characters). Shorten it before saving; nothing has been submitted.`;
        continue;
      }
      notes = trimmed || undefined;
      break;
    }
  }
  return undefined;
}

export async function askHumanQuestion(
  ctx: ExtensionContext,
  question: ChoiceQuestion,
  reason: string,
  signal: AbortSignal,
): Promise<HumanAnswer | undefined> {
  if (signal.aborted) return undefined;
  const prompt: HumanQuestionPrompt = { question, reason, signal, notesLimit: HUMAN_NOTES_LIMIT };
  return ctx.mode === "tui" ? showHumanQuestionTui(ctx, prompt) : askRpc(ctx, prompt);
}
