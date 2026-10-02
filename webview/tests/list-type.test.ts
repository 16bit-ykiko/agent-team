// The lists (sidebar, side panels, board) share one type scale, and a name
// cut short in them shows an ellipsis.
import { describe, it, expect } from "vitest";
import css from "../src/styles.css?raw";
import main from "../src/main.tsx?raw";

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
      ".task-delete",
      ".bp-back",
      ".bp-name",
      ".bp-name-input",
      ".bp-detail-title",
      ".ap-agent-actions button",
      ".ap-toggle",
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
    for (const sel of [".ws-archived-purge", ".ws-group-restore"]) {
      expect(rule(sel, "@media (hover: none)").body).toMatch(/opacity:\s*1/);
    }
    // A new session only from the open session's project; the others' +
    // take no room and no tap.
    expect(rule(".ws-group-header.current .ws-group-add", "@media (hover: none)").body).toMatch(
      /opacity:\s*1/,
    );
    expect(
      rule(".ws-group-header:not(.current) .ws-group-add", "@media (hover: none)").body,
    ).toMatch(/display:\s*none/);
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

  it("keeps a file's line numbers in view, long agent names cut, and a phone panel's end in reach", () => {
    const rule = (sel: string, media: string | null = null) =>
      all.find((r) => r.selectors.includes(sel) && r.media === media)!;
    expect(rule(".code-gutter").body).toMatch(/position:\s*sticky/);
    expect(rule(".ap-agent-name").body).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".side-panel-body", PHONE).body).toMatch(/safe-area-inset-bottom/);
    expect(rule(".tp-task", PHONE).body).toMatch(/"type desc stop"\s*"\. when stop"/);
    expect(rule(".tp-desc", PHONE).body).toMatch(/white-space:\s*normal/);
  });

  it("parts a card into sections on one edge: header, where and what, agents, actions", () => {
    const body = (sel: string) =>
      all.find((r) => r.selectors.includes(sel) && r.media === null)!.body;
    for (const sel of [".ap-session-head", ".ap-brief", ".ap-info", ".ap-agents"]) {
      expect(body(sel)).toMatch(/padding:[^;]*var\(--ap-pad\)/);
    }
    expect(body(".ap-agents")).toMatch(/border-top:\s*1px solid/);
    expect(body(".ap-session-foot")).toMatch(/border-top:\s*1px solid/);
    expect(body(".ap-session-foot")).toMatch(/padding:\s*4px var\(--ap-pad\)/);
    // A button at the edge puts its label there, not its border.
    expect(body(".ap-add")).toMatch(/margin-left:\s*calc\(-1px - var\(--panel-btn-pad\)\)/);
    expect(body(".ap-toggle")).toMatch(/text-align:\s*left/);
  });

  it("keeps every grey of the text readable on every background, each step apart", () => {
    const rule = (sel: string) => all.find((r) => r.selectors.includes(sel) && r.media === null)!;
    const root = rule(":root").body;
    const hex = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(root)![1];
    const luminance = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(h.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (fg: string, bg: string) =>
      (luminance(hex(fg)) + 0.05) / (luminance(hex(bg)) + 0.05);
    const least = (fg: string) =>
      Math.min(
        ...["bg-primary", "bg-secondary", "bg-tertiary", "bg-elevated"].map((bg) =>
          contrast(fg, bg),
        ),
      );
    expect(least("text-strong")).toBeGreaterThanOrEqual(9);
    expect(least("text-primary")).toBeGreaterThanOrEqual(6);
    expect(least("text-secondary")).toBeGreaterThanOrEqual(4.5);
    expect(least("text-muted")).toBeGreaterThanOrEqual(3);
    // An objective's title stands out of its text; its sections' names read.
    expect(rule(".bp-detail-title").body).toMatch(/color:\s*var\(--text-strong\)/);
    expect(rule(".bp-card-title").body).toMatch(/color:\s*var\(--text-strong\)/);
    expect(rule(".bp-section-title").body).toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it("gives an objective's details room: its notes as airy as its goal, sections well apart", () => {
    const body = (sel: string) =>
      all.find((r) => r.selectors.includes(sel) && r.media === null)!.body;
    const lineHeight = (sel: string) => Number(/line-height:\s*([\d.]+);/.exec(body(sel))![1]);
    expect(lineHeight(".bp-md")).toBe(lineHeight(".bp-goal"));
    expect(lineHeight(".bp-md")).toBeGreaterThanOrEqual(1.6);
    // Paragraphs of the notes apart by more than the chat's 4px.
    expect(body(".bp-md p")).toMatch(/margin:\s*0 0 12px/);
    expect(Number(/margin-top:\s*(\d+)px/.exec(body(".bp-section"))![1])).toBeGreaterThanOrEqual(
      24,
    );
    expect(body(".bp-detail")).toMatch(/padding:\s*\d+px 22px/);
  });

  it("lets the dependency graph fill what the board's banners leave", () => {
    const rule = (sel: string, media: string | null = null) =>
      all.find((r) => r.selectors.includes(sel) && r.media === media)!;
    expect(rule(".bp-graph").body).not.toMatch(/min-height:\s*100%/);
    expect(rule(".bp-graph").body).toMatch(/flex:\s*1 0 auto/);
    expect(rule(".bp-main:has(> .bp-graph)").body).toMatch(/flex-direction:\s*column/);
    expect(rule(".bp-main > .bp-broken").body).toMatch(/position:\s*sticky/);
  });

  it("keeps Archive project in a short desktop window, and the quota bars in one column", () => {
    const sideways = all.find(
      (r) => r.selectors.includes(".bp-archive") && r.media?.includes("max-height: 500px"),
    )!;
    expect(sideways.media).toContain("(hover: none)");
    const grid = all.find((r) => r.selectors.includes(".system-status-grid") && !r.media)!;
    expect(grid.body).toMatch(/grid-template-columns:\s*fit-content\(45%\)/);
  });

  it("ends a card's time, its edge buttons' labels and its agents' icons on one edge", () => {
    const rule = (sel: string, media: string | null = null) =>
      all.find((r) => r.selectors.includes(sel) && r.media === media)!;
    const pad = (media: string | null) =>
      Number(/--panel-btn-pad:\s*(\d+)px/.exec(rule(".panel-btn", media).body)![1]);
    const edge = rule(".ap-actions > :last-child");
    expect(edge.selectors).toEqual([".ap-actions > :last-child", ".tp-stop"]);
    expect(edge.body).toMatch(/margin-right:\s*calc\(-1px - var\(--panel-btn-pad\)\)/);
    // The padding an edge button takes back fits in the card's own.
    const cardPad = Number(/--ap-pad:\s*(\d+)px/.exec(rule(".ap-session").body)![1]);
    expect(pad(null) + 1).toBeLessThanOrEqual(cardPad);
    expect(pad(PHONE) + 1).toBeLessThanOrEqual(cardPad);
    // An icon button is wider than its 16px icon: the difference, taken back.
    const iconPad = (media: string | null, button: string) =>
      (Number(new RegExp(`width:\\s*(\\d+)px`).exec(button)![1]) - 16) / 2 ===
      -Number(/margin-right:\s*(-?\d+)px/.exec(rule(".ap-agent-actions", media).body)![1]);
    expect(iconPad(null, rule(".ap-agent-actions button").body)).toBe(true);
    expect(iconPad(PHONE, rule(".ap-agent-actions button", PHONE).body)).toBe(true);
    // Stop and Cancel one width, so the times beside them end in a column.
    const own = (sel: string) =>
      all
        .filter((r) => r.selectors.includes(sel) && !r.media)
        .map((r) => r.body)
        .join("");
    expect(own(".tp-stop")).toMatch(/min-width:\s*calc\(6ch/);
    expect(rule(".tp-type").body).toMatch(/min-width:\s*calc\(7ch/);
  });

  it("shows a panel button's hover border only where there is a pointer", () => {
    const hovers = all.filter((r) => r.selectors.some((s) => /^\.panel-btn.*:hover$/.test(s)));
    expect(hovers.length).toBeGreaterThan(0);
    for (const r of hovers) expect(r.media).toBe("@media (hover: hover)");
  });

  it("sizes the sidebar's icons alike: the header's one size, a row's actions another", () => {
    const size = (sel: string, media: string | null = null) =>
      all
        .filter((r) => r.selectors.includes(sel) && r.media === media)
        .map((r) => /width:\s*(\d+)px/.exec(r.body)?.[1])
        .find(Boolean);
    expect(size(".sidebar-header .icon")).toBe("14");
    expect(size(".ws-group-add .icon")).toBe(size(".task-delete .icon"));
    expect(size(".sidebar-header .icon", PHONE)).toBe("16");
    expect(size(".ws-group-add .icon", PHONE)).toBe(size(".task-delete .icon", PHONE));
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

describe("the bundled font", () => {
  const sheets = import.meta.glob<string>("../src/fonts/sarasa-mono-sc/*/result.css", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const slices = new Set(Object.keys(import.meta.glob("../src/fonts/sarasa-mono-sc/*/*.woff2")));

  it("is loaded in all four faces, sliced by character, and first in the stack", () => {
    // Every face real: none faked by slanting or smearing another.
    for (const [dir, weight, style] of [
      ["regular", 400, "normal"],
      ["bold", 700, "normal"],
      ["italic", 400, "italic"],
      ["bold-italic", 700, "italic"],
    ] as const) {
      const sheet = `fonts/sarasa-mono-sc/${dir}/result.css`;
      expect(main).toContain(`import "./${sheet}";`);
      const faces = sheets[`../src/${sheet}`].match(/@font-face\{[^}]*\}/g)!;
      expect(faces.length).toBeGreaterThan(50);
      for (const f of faces) {
        expect(f).toContain('font-family:"Sarasa Mono SC"');
        expect(f).toContain(`font-weight:${weight}`);
        expect(f).toContain(`font-style:${style}`);
        const slice = /url\("\.\/([0-9a-f]+\.woff2)"\)/.exec(f)![1];
        expect(slices.has(`../src/fonts/sarasa-mono-sc/${dir}/${slice}`)).toBe(true);
      }
    }
    // Before the theme, whose rules would otherwise come first.
    expect(main.indexOf("result.css")).toBeLessThan(main.indexOf('"./styles.css"'));
    const root = all.find((r) => r.selectors[0] === ":root" && !r.media)!;
    expect(root.body).toMatch(/--font-mono:\s*"Sarasa Mono SC",/);
  });
});
