// Lines selected in the Files panel, a file's or a diff's, offered to ask
// about in the chat: which whole lines a selection covers, how they are
// numbered, and the button that hands them over.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import css from "../src/styles.css?raw";
import { FilesPanel, type CodeQuote } from "../src/panels/FilesPanel";
import { parseDiff, pickRows } from "../src/panels/ChangesView";
import { pickLines } from "../src/panels/selection";

describe("the lines a selection covers", () => {
  const text = "one\ntwo\nthree\nfour\n";

  it("takes every line it touches, whole", () => {
    expect(pickLines(text, 1, 2)).toEqual({ from: 1, to: 1, text: "one" });
    expect(pickLines(text, 5, 10)).toEqual({ from: 2, to: 3, text: "two\nthree" });
    expect(pickLines(text, 0, text.length - 1)).toEqual({
      from: 1,
      to: 4,
      text: "one\ntwo\nthree\nfour",
    });
    expect(pickLines(text, 3, 3)).toBeNull();
  });

  it("leaves out a line the selection only touches the end or the start of", () => {
    // From "two" to just after its newline: the next line is not picked.
    expect(pickLines(text, 4, 8)).toEqual({ from: 2, to: 2, text: "two" });
    // From past the end of "one" into "three": "one" is not picked.
    expect(pickLines(text, 3, 10)).toEqual({ from: 2, to: 3, text: "two\nthree" });
    expect(pickLines(text, 3, 4)).toEqual({ from: 1, to: 1, text: "one" });
  });

  it("quotes a diff's rows as a diff, numbered by the new side unless they only remove", () => {
    const rows = parseDiff(
      ["@@ -10,3 +10,3 @@", " a", "-b", "+B", " c", "\\ No newline at end of file"].join("\n"),
    );
    expect(pickRows(rows)).toEqual({
      from: 10,
      to: 12,
      text: "@@ -10,3 +10,3 @@\n a\n-b\n+B\n c",
    });
    expect(pickRows(rows.slice(2, 3))).toEqual({ from: 11, to: 11, text: "-b" });
    expect(pickRows(rows.slice(0, 1))).toBeNull();
  });
});

describe("asking about lines from the Files panel", () => {
  const file = {
    kind: "text",
    path: "/w/src/lex.cpp",
    size: 30,
    content: "int a;\nint b;\nint c;\nint d;\n",
    truncated: false,
  };
  const changes = {
    top: "/w",
    branch: "feature",
    base: "origin/main",
    against: "a".repeat(40),
    truncated: false,
    files: [{ path: "src/lex.cpp", status: "modified", added: 1, removed: 1 }],
  };
  const diff = {
    path: "src/lex.cpp",
    binary: false,
    truncated: false,
    diff: "@@ -1,3 +1,3 @@\n int a;\n-int b;\n+int b2;\n int c;\n",
  };
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const body = url.startsWith("api/diff/file")
          ? diff
          : url.startsWith("api/diff")
            ? changes
            : file;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }),
    );
  });
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
  });

  // The text node and offset in it where `el`'s text reaches `offset`:
  // highlighting splits code into many nodes.
  const at = (el: Node, offset: number): [Node, number] => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const len = n.textContent!.length;
      if (offset <= len) return [n, offset];
      offset -= len;
    }
    throw new Error("past the end");
  };
  const select = (start: Node, startOffset: number, end: Node, endOffset: number) =>
    act(() => {
      const range = document.createRange();
      range.setStart(...at(start, startOffset));
      range.setEnd(...at(end, endOffset));
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  const selectRaw = (start: Node, startOffset: number, end: Node, endOffset: number) =>
    act(() => {
      const range = document.createRange();
      range.setStart(start, startOffset);
      range.setEnd(end, endOffset);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  const clear = () =>
    act(() => {
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

  const panel = (onAsk: (q: CodeQuote) => void) =>
    render(
      <FilesPanel
        wsId="w1"
        target={{ path: "src/lex.cpp" }}
        roots={[{ label: "w", path: "/w" }]}
        onAsk={onAsk}
      />,
    );

  it("offers the lines selected in a file, and hands them over with its path", async () => {
    const asked: CodeQuote[] = [];
    const { container, queryByTitle, getByTitle } = panel((q) => asked.push(q));
    await waitFor(() => expect(container.querySelector(".code-text")).not.toBeNull());
    // The selection is listened to from an effect, run after the paint.
    await act(async () => {});
    expect(queryByTitle("Ask about these lines in the chat")).toBeNull();

    // From inside "int b;" to inside "int c;".
    const code = container.querySelector(".code-text")!;
    select(code, 9, code, 16);
    const ask = getByTitle("Ask about these lines in the chat");
    expect(ask.textContent).toBe("Ask · L2–3");
    fireEvent.click(ask);
    expect(asked).toEqual([
      { path: "/w/src/lex.cpp", lang: "cpp", from: 2, to: 3, text: "int b;\nint c;" },
    ]);
    expect(document.getSelection()!.isCollapsed).toBe(true);

    select(code, 0, code, 3);
    expect(getByTitle("Ask about these lines in the chat").textContent).toBe("Ask · L1");
    clear();
    expect(queryByTitle("Ask about these lines in the chat")).toBeNull();

    // A selection elsewhere on the page is not the file's.
    const outside = document.body.appendChild(document.createElement("p"));
    outside.textContent = "chat text";
    select(outside, 0, outside, 4);
    expect(queryByTitle("Ask about these lines in the chat")).toBeNull();
    // Nor is the whole page, selected with Ctrl+A.
    selectRaw(document.body, 0, document.body, document.body.childNodes.length);
    expect(queryByTitle("Ask about these lines in the chat")).toBeNull();
    outside.remove();

    // Over the code, not in the bar, where appearing would move the lines.
    select(code, 0, code, 3);
    expect(container.querySelector(".fp-bar .fp-ask")).toBeNull();
    expect(container.querySelector(".files-panel > .fp-ask")).not.toBeNull();
  });

  it("offers the rows selected in a diff, as a diff", async () => {
    const asked: CodeQuote[] = [];
    const { container, getByTitle } = panel((q) => asked.push(q));
    await waitFor(() => expect(container.querySelector(".code-text")).not.toBeNull());
    fireEvent.click(getByTitle("Changes against the base branch"));
    await waitFor(() => expect(container.querySelector(".change-entry")).not.toBeNull());
    fireEvent.click(container.querySelector(".change-entry")!);
    await waitFor(() => expect(container.querySelector(".diff-row")).not.toBeNull());
    await act(async () => {});

    const rows = [...container.querySelectorAll(".diff-row .diff-code")];
    // From the removed line into the added one.
    select(rows[2], 1, rows[3], 2);
    fireEvent.click(getByTitle("Ask about these lines in the chat"));
    expect(asked).toEqual([
      { path: "/w/src/lex.cpp", lang: "diff", from: 2, to: 2, text: "-int b;\n+int b2;" },
    ]);

    // A triple-click ends at the start of the next row's code; a drag can
    // start past the end of a row. Neither row is picked.
    selectRaw(rows[1].firstChild!.firstChild ?? rows[1], 0, rows[2], 0);
    fireEvent.click(getByTitle("Ask about these lines in the chat"));
    expect(asked.at(-1)).toMatchObject({ from: 1, to: 1, text: " int a;" });
    const end = rows[1].textContent.length;
    select(rows[1], end, rows[3], 2);
    fireEvent.click(getByTitle("Ask about these lines in the chat"));
    expect(asked.at(-1)).toMatchObject({ from: 2, to: 2, text: "-int b;\n+int b2;" });
    // Ending in the gutter of a row leaves it out too.
    selectRaw(rows[1].firstChild!.firstChild ?? rows[1], 0, rows[4].previousSibling!, 0);
    expect(getByTitle("Ask about these lines in the chat").textContent).toBe("Ask · L1–2");

    // Leaving the diff drops what was picked in it.
    select(rows[1], 0, rows[4], 3);
    expect(getByTitle("Ask about these lines in the chat").textContent).toBe("Ask · L1–3");
    fireEvent.click(getByTitle("All changes"));
    await waitFor(() => expect(container.querySelector(".changes")).not.toBeNull());
    fireEvent.click(container.querySelector(".change-entry")!);
    await waitFor(() => expect(container.querySelector(".diff-row")).not.toBeNull());
    expect(container.querySelector(".fp-ask")).toBeNull();
  });

  it("draws native controls dark: a select's option list follows the page", () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark;/);
  });

  it("paints a file and a diff on the panel's background, not highlight.js's darker one", () => {
    // highlight.js's theme colours .hljs; a single class of ours, loaded
    // before it, would lose.
    expect(css).toMatch(/\.code-text\.hljs,\s*\.diff-inner\.hljs\s*\{\s*background:\s*none;/);
  });
});
