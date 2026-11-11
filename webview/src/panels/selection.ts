import { useEffect, type RefObject } from "react";

// The whole lines a selection touches: numbered as the file (or the diff's
// new side) numbers them, and their text.
export interface PickedLines {
  from: number;
  to: number;
  text: string;
}

// Where one end of a selection falls in `root`'s text: 0 before it, its
// length past it.
export function textOffset(root: Node, range: Range, end: "start" | "end"): number {
  const [node, offset] =
    end === "start"
      ? [range.startContainer, range.startOffset]
      : [range.endContainer, range.endOffset];
  const r = document.createRange();
  r.selectNodeContents(root);
  if (!root.contains(node)) return r.comparePoint(node, offset) < 0 ? 0 : r.toString().length;
  r.setEnd(node, offset);
  return r.toString().length;
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = content.indexOf("\n"); i >= 0 && i < offset; i = content.indexOf("\n", i + 1))
    line++;
  return line;
}

// The lines of `content` between two offsets into it; a selection starting
// at the very end of a line starts at the next, one ending at the very
// start of a line stops at the line before.
export function pickLines(content: string, start: number, end: number): PickedLines | null {
  if (end <= start) return null;
  const from = lineAt(content, content[start] === "\n" && start + 1 < end ? start + 1 : start);
  const to = Math.max(from, lineAt(content, content[end - 1] === "\n" ? end - 1 : end));
  return {
    from,
    to,
    text: content
      .split("\n")
      .slice(from - 1, to)
      .join("\n"),
  };
}

// Reports the lines selected within `area` as the selection changes (only
// when they change: a drag fires this for every pixel), and none once it
// leaves, collapses or the area goes away. A selection with neither end in
// the area (select-all) is not one of its lines.
export function useSelectedLines(
  area: RefObject<HTMLElement | null>,
  read: (range: Range) => PickedLines | null,
  onPick: ((lines: PickedLines | null) => void) | undefined,
): void {
  useEffect(() => {
    if (!onPick) return;
    let last: PickedLines | null = null;
    const update = () => {
      const el = area.current;
      const sel = document.getSelection();
      const range = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      const inside =
        el && range && (el.contains(range.startContainer) || el.contains(range.endContainer));
      const lines = inside ? read(range) : null;
      if (lines?.from === last?.from && lines?.to === last?.to && lines?.text === last?.text)
        return;
      last = lines;
      onPick(lines);
    };
    document.addEventListener("selectionchange", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      onPick(null);
    };
  }, [area, read, onPick]);
}
