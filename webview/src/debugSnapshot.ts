// One-tap layout snapshot for debugging rendering on devices we cannot
// attach a debugger to: viewport facts, geometry of the shell elements, the
// CSS variables that drive sizing, and the DOM itself (message bodies
// trimmed). Posted to the server, which stores it as a JSON file.

import { readViewportFacts, ViewportFacts } from "./ViewportInfo";

export interface ElementGeometry {
  selector: string;
  rect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
  display: string;
  position: string;
  height: string;
  paddingTop: string;
  paddingBottom: string;
  bottom: string;
  overflow: string;
  // Scrollers only: distinguishes "scrolled past the content" from "not
  // painted" when the transcript shows up empty.
  scroll?: { top: number; height: number; client: number };
}

export interface DebugSnapshot {
  takenAt: string;
  userAgent: string;
  url: string;
  viewport: ViewportFacts;
  window: { innerWidth: number; innerHeight: number; devicePixelRatio: number; scrollY: number };
  cssVars: Record<string, string>;
  elements: ElementGeometry[];
  html: string;
}

export const SNAPSHOT_SELECTORS = [
  "html",
  "body",
  "#root",
  ".app",
  ".sidebar",
  ".main-panel",
  ".panel-header",
  ".messages",
  ".input-area",
  ".input-row",
  ".chat-input",
  ".empty-state",
  // First and last transcript entries: where the content actually sits.
  ".messages .message",
  ".messages > :last-child",
];

function geometry(selector: string): ElementGeometry | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const round = (n: number) => Math.round(n * 10) / 10;
  const scrolls = cs.overflowY === "auto" || cs.overflowY === "scroll";
  return {
    selector,
    ...(scrolls && {
      scroll: { top: round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight },
    }),
    rect: {
      top: round(r.top),
      bottom: round(r.bottom),
      left: round(r.left),
      right: round(r.right),
      width: round(r.width),
      height: round(r.height),
    },
    display: cs.display,
    position: cs.position,
    height: cs.height,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    bottom: cs.bottom,
    overflow: cs.overflow,
  };
}

// The DOM with message bodies cut down: layout matters, transcripts don't.
export function trimmedHtml(maxMessages = 3): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  for (const list of clone.querySelectorAll(".messages")) {
    const items = [...list.children].filter((c) => !c.classList.contains("history-hint"));
    for (const extra of items.slice(maxMessages)) extra.remove();
  }
  for (const s of clone.querySelectorAll("script")) s.remove();
  return "<!doctype html>\n" + clone.outerHTML;
}

export function collectSnapshot(): DebugSnapshot {
  const rootStyle = document.documentElement.style;
  const cssVars: Record<string, string> = {};
  for (const name of ["--app-height", "--app-offset"]) {
    cssVars[name] = rootStyle.getPropertyValue(name) || "(unset)";
  }
  return {
    takenAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
    viewport: readViewportFacts(),
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollY: window.scrollY,
    },
    cssVars,
    elements: SNAPSHOT_SELECTORS.map(geometry).filter((g): g is ElementGeometry => !!g),
    html: trimmedHtml(),
  };
}

export async function uploadSnapshot(): Promise<string> {
  const snap = collectSnapshot();
  const res = await fetch("debug/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(snap),
  });
  if (!res.ok) throw new Error(`snapshot upload failed: ${res.status}`);
  const data = (await res.json()) as { path: string };
  return data.path;
}
