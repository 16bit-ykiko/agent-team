// The lists (sidebar, side panels, board) share one type scale, and a name
// cut short in them shows an ellipsis.
import { describe, it, expect } from "vitest";
import css from "../src/styles.css?raw";

interface Rule {
  selectors: string[];
  body: string;
  media: string | null;
}

function rules(text: string, media: string | null = null): Rule[] {
  const out: Rule[] = [];
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith("@media")) out.push(...rules(body, head));
    else out.push({ selectors: head.split(",").map((s) => s.trim()), body, media });
    i = j;
  }
  return out;
}

const all = rules(css);
const PHONE = "@media (max-width: 768px), (max-height: 500px)";
const scale = (vars: string) =>
  Object.fromEntries(
    [...vars.matchAll(/--(fs-\w+):\s*([\d.]+)px/g)].map((m) => [m[1], Number(m[2])]),
  );

describe("the lists' type", () => {
  it("sizes their text from the scale, so a phone takes it all a size up", () => {
    const list =
      /^\.(task-|ws-group|ws-archive|search-result|unread-badge|sidebar-empty|side-panel-|panel-btn|agents-panel|ap-|tasks-panel|tp-|board-page|bp-|fp-|file-note|dir-entry|change)/;
    // Glyphs (+, ×, arrows, dots) and headings are sized for themselves.
    const own = new Set([
      ".ws-group-add",
      ".ws-group-dirty",
      ".task-delete",
      ".bp-back",
      ".bp-name",
      ".bp-name-input",
      ".bp-detail-title",
      ".ap-agent-actions button",
    ]);
    const raw = all
      .filter((r) => r.selectors.some((s) => list.test(s) && !own.has(s)))
      .filter((r) => /font-size:\s*[\d.]+px/.test(r.body))
      .map((r) => r.selectors.join(", "));
    expect(raw).toEqual([]);

    const desktop = scale(all.find((r) => r.selectors[0] === ":root" && !r.media)!.body);
    const phone = scale(all.find((r) => r.selectors[0] === ":root" && r.media === PHONE)!.body);
    expect(Object.keys(desktop)).toEqual(["fs-name", "fs-text", "fs-meta", "fs-tag"]);
    expect(Object.keys(phone)).toEqual(Object.keys(desktop));
    for (const k of Object.keys(desktop)) expect(phone[k]).toBeGreaterThan(desktop[k]);
    // Text in a list reads like the chat beside it.
    const chat = all.find((r) => r.selectors.includes(".message-content") && r.media === PHONE)!;
    expect(chat.body).toContain(`font-size: ${phone["fs-text"]}px`);
  });

  it("cuts no text in a flex row: its own ellipsis would never show", () => {
    const flexCut = all
      .filter(
        (r) => /display:\s*(inline-)?flex/.test(r.body) && /text-overflow:\s*ellipsis/.test(r.body),
      )
      .map((r) => r.selectors.join(", "));
    expect(flexCut).toEqual([]);
  });

  it("shows a session row's time and × on hover, keyboard focus or, on touch, when open", () => {
    const rule = (sel: string, media: string | null = null) =>
      all.find((r) => r.selectors.includes(sel) && r.media === media)!;
    const shown = rule(".task-item:hover .task-hover");
    expect(shown.selectors).toContain(".task-hover:focus-within");
    expect(shown.body).toMatch(/opacity:\s*1/);
    expect(shown.body).toMatch(/pointer-events:\s*auto/);
    expect(rule(".task-item.active .task-hover", "@media (hover: none)").body).toMatch(
      /opacity:\s*1/,
    );
    // The project's row keeps its own ×: shown on hover, on touch only when
    // open, and no tap lands on it while hidden.
    expect(rule(".ws-group-header:hover .task-delete").body).toMatch(/opacity:\s*1/);
    expect(rule(".ws-group-header:not(.active) .task-delete", "@media (hover: none)").body).toMatch(
      /visibility:\s*hidden/,
    );
    for (const sel of [".ws-group-add", ".ws-archived-purge", ".ws-group-restore"]) {
      expect(rule(sel, "@media (hover: none)").body).toMatch(/opacity:\s*1/);
    }
  });

  it("breaks a board's long paths and URLs, and keeps one close button on a phone's details", () => {
    const board = all.find((r) => r.selectors.includes(".board-page") && !r.media)!;
    expect(board.body).toMatch(/overflow-wrap:\s*anywhere/);
    // .side-panel-btn sets the button's display later in the sheet: only a
    // more specific rule hides it.
    const hidden = all.find(
      (r) => r.media === PHONE && r.selectors.some((s) => s.endsWith(".bp-detail-close")),
    )!;
    expect(hidden.selectors).toContain(".bp-detail-head .bp-detail-close");
    expect(hidden.body).toMatch(/display:\s*none/);
  });

  it("fits a dialog in a narrow phone", () => {
    const dialog = all.find((r) => r.selectors.includes(".dialog") && !r.media)!;
    expect(dialog.body).toMatch(/min-width:\s*min\(360px, calc\(100vw - 24px\)\)/);
  });

  it("keeps the chat header's title on the row of its menu and agents, cut short", () => {
    const top = all.filter((r) => r.selectors.includes(".panel-header-top"));
    expect(top.length).toBeGreaterThan(0);
    for (const r of top) expect(r.body).not.toMatch(/flex-wrap:\s*wrap/);
    const title = all.find((r) => r.selectors.includes(".panel-title") && !r.media)!;
    expect(title.body).toMatch(/min-width:\s*0/);
    expect(title.body).toMatch(/text-overflow:\s*ellipsis/);
    expect(title.body).toMatch(/white-space:\s*nowrap/);
    expect(title.body).toMatch(/overflow:\s*hidden/);
    const chip = all.find((r) => r.selectors.includes(".agents-chip") && !r.media)!;
    expect(chip.body).toMatch(/flex-shrink:\s*0/);
  });
});
