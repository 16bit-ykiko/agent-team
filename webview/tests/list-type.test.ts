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

  it("brings a session row's time and × back on hover, the × on keyboard focus too", () => {
    const rule = (sel: string) => all.filter((r) => r.selectors.includes(sel) && !r.media);
    expect(rule(".task-item:hover .task-time")[0].body).toMatch(/display:\s*inline/);
    expect(rule(".task-item-archived .task-time")[0].body).toMatch(/display:\s*inline/);
    const shown = rule(".task-item .task-delete:focus-visible")[0];
    expect(shown.selectors).toContain(".task-item:hover .task-delete");
    expect(shown.body).toMatch(/width:\s*auto/);
    expect(shown.body).toMatch(/opacity:\s*1/);
    // The project's row keeps its own ×, shown on hover.
    expect(rule(".ws-group-header:hover .task-delete")[0].body).toMatch(/opacity:\s*1/);
    expect(all.filter((r) => r.selectors.includes(".task-delete") && !r.media)[0].body).not.toMatch(
      /display:\s*none/,
    );
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
