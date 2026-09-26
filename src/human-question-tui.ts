import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Keybinding,
} from "@earendil-works/pi-tui";
import type { HumanAnswer, HumanQuestionPrompt } from "./human-question.ts";

function displayText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export async function showHumanQuestionTui(
  ctx: ExtensionContext,
  prompt: HumanQuestionPrompt,
): Promise<HumanAnswer | undefined> {
  if (prompt.signal.aborted) return undefined;
  let removeAbortListener = () => {};
  try {
    return await ctx.ui.custom<HumanAnswer | undefined>((tui, theme, keybindings, done) => {
      let selected = 0;
      let notes: string | undefined;
      let editing = false;
      let error = "";
      let closed = false;
      let focused = false;
      let scroll = 0;
      let pageSize = 1;
      let reveal: "option" | "note" | undefined;
      const question = displayText(prompt.question.question);
      const context = displayText(prompt.question.context);
      const reason = displayText(prompt.reason);
      const options = prompt.question.options.map((option) => ({
        label: displayText(option.label),
        description: displayText(option.description),
      }));
      const editor = new Editor(tui, {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      });
      const refresh = () => tui.requestRender();
      const finish = (answer: HumanAnswer | undefined) => {
        if (closed) return;
        closed = true;
        removeAbortListener();
        done(prompt.signal.aborted ? undefined : answer);
      };
      const abort = () => finish(undefined);
      removeAbortListener = () => prompt.signal.removeEventListener("abort", abort);
      prompt.signal.addEventListener("abort", abort, { once: true });
      if (prompt.signal.aborted) abort();

      editor.onSubmit = (value) => {
        const trimmed = value.trim();
        if (trimmed.length > prompt.notesLimit) {
          error = `Note is too long: ${trimmed.length}/${prompt.notesLimit} characters. Shorten it to save.`;
          editor.setText(value);
          refresh();
          return;
        }
        notes = trimmed || undefined;
        error = "";
        editing = false;
        editor.focused = false;
        reveal = "note";
        refresh();
      };
      editor.onChange = () => {
        if (error) {
          const length = editor.getExpandedText().trim().length;
          error = length > prompt.notesLimit
            ? `Note is too long: ${length}/${prompt.notesLimit} characters. Shorten it to save.`
            : "";
        }
      };

      function handleInput(data: string) {
        if (closed) return;
        if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) {
          finish(undefined);
          return;
        }
        if (editing) {
          editor.handleInput(data);
          refresh();
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) {
          selected = Math.max(0, selected - 1);
          reveal = "option";
        } else if (keybindings.matches(data, "tui.select.down")) {
          selected = Math.min(options.length - 1, selected + 1);
          reveal = "option";
        } else if (keybindings.matches(data, "tui.select.pageUp")) {
          scroll = Math.max(0, scroll - pageSize);
          reveal = undefined;
        } else if (keybindings.matches(data, "tui.select.pageDown")) {
          scroll += pageSize;
          reveal = undefined;
        } else if (data === "n") {
          editing = true;
          editor.setText(notes ?? "");
          editor.focused = focused;
          error = "";
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          finish(notes ? { optionIndex: selected, notes } : { optionIndex: selected });
          return;
        }
        refresh();
      }

      function render(width: number): string[] {
        const columns = Math.max(1, width);
        // The inline custom view shares the terminal with pi's path, model, and status footer.
        const height = Math.max(4, tui.terminal.rows - 5);
        const wrap = (text: string) => wrapTextWithAnsi(text, columns);
        const keys = (binding: Keybinding) => keybindings.getKeys(binding).join("/");
        const hints = editing
          ? `${keys("tui.input.submit")} save note (not answer) · ${keys("tui.input.newLine")} newline · Esc cancel`
          : `${keys("tui.select.up")}/${keys("tui.select.down")} choose · ${keys("tui.select.confirm")} submit · n note · ${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")} scroll · Esc cancel`;
        const hintLines = wrap(theme.fg("dim", hints));
        // Keep hints available even when the terminal is unusually short or narrow.
        const footer = hintLines.length <= Math.floor(height / 3)
          ? hintLines
          : [theme.fg("dim", truncateToWidth(editing ? "Enter save · Esc cancel" : "Enter submit · n note · Esc cancel", columns))];
        const status = editing
          ? `Optional note (${editor.getExpandedText().trim().length}/${prompt.notesLimit})`
          : `Selected: ${selected + 1}. ${options[selected]!.label}${notes ? " · Note attached" : ""}`;
        footer.unshift(theme.fg("accent", truncateToWidth(status.replace(/\n/g, " "), columns)));

        if (editing) {
          if (error) {
            footer.unshift(...wrap(theme.fg("error", error)).slice(0, Math.max(1, Math.floor(height / 4))));
          }
          let editorLines = editor.render(columns);
          const editorHeight = Math.max(1, height - footer.length - 1);
          if (editorLines.length > editorHeight) {
            const cursor = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
            const start = Math.max(0, Math.min(editorLines.length - editorHeight, cursor - editorHeight + 1));
            editorLines = editorLines.slice(start, start + editorHeight);
          }
          footer.unshift(...editorLines);
        }
        if (footer.length >= height - 1) {
          return footer.slice(-height).map((line) => truncateToWidth(line, columns));
        }

        const lines: string[] = [];
        const add = (text: string) => lines.push(...wrap(text));
        const section = (title: string, text: string) => {
          add(theme.fg("accent", theme.bold(title)));
          add(text);
          lines.push("");
        };
        section("Question", question);
        section("Context", context || theme.fg("dim", "No additional context."));
        section("Why your input is needed", reason);
        add(theme.fg("accent", theme.bold("Options")));
        const optionLines: number[] = [];
        for (const [index, option] of options.entries()) {
          optionLines.push(lines.length);
          add(theme.fg(index === selected ? "accent" : "text", `${index === selected ? ">" : " "} ${index + 1}. ${option.label}`));
          add(theme.fg("muted", option.description));
          lines.push("");
        }
        const noteLine = lines.length;
        section("Optional note", notes ? displayText(notes) : theme.fg("dim", "None. Press n to add a note to your selected option."));
        pageSize = Math.max(1, height - footer.length - 1);
        if (reveal) {
          const target = reveal === "note" ? noteLine : optionLines[selected]!;
          if (target < scroll || target >= scroll + pageSize) scroll = target;
          reveal = undefined;
        }
        scroll = Math.min(Math.max(0, scroll), Math.max(0, lines.length - pageSize));
        const scrollHint = `${scroll + 1}-${Math.min(lines.length, scroll + pageSize)}/${lines.length} · ${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")} scroll`;
        return [
          ...lines.slice(scroll, scroll + pageSize),
          theme.fg("dim", truncateToWidth(scrollHint, columns)),
          ...footer,
        ].map((line) => truncateToWidth(line, columns));
      }

      return {
        get focused() { return focused; },
        set focused(value: boolean) {
          focused = value;
          editor.focused = value && editing;
        },
        render,
        handleInput,
        invalidate: () => editor.invalidate(),
        dispose: () => {
          closed = true;
          removeAbortListener();
        },
      };
    });
  } finally {
    removeAbortListener();
  }
}
