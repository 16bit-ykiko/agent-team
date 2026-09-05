// iOS standalone (home-screen) web apps have a WebKit bug: the first time the
// software keyboard opens, the layout viewport shrinks by roughly the height
// of Safari's toolbar (~59px) and never grows back for the rest of the
// session — innerHeight, visualViewport.height and 100dvh all stay small, and
// a dead band appears under the app. Forcing a re-layout of a full-viewport
// element after the keyboard closes makes WebKit re-measure the viewport.
// See https://dev.to/cederhook/fixing-the-ios-standalone-pwa-keyboard-bug-that-shrinks-your-viewport-for-good-63d

export const HEAL_TOLERANCE = 4;

export class ViewportTracker {
  maxHeight: number;
  // Seed with the tallest height we have reason to believe in, not just the
  // current one: after a reload the viewport is often already shrunk, and a
  // tracker seeded from it would take the broken height for the maximum and
  // never heal.
  constructor(initial: number) {
    this.maxHeight = initial;
  }
  observe(height: number): void {
    if (height > this.maxHeight) this.maxHeight = height;
  }
  // The viewport is short of its known maximum by more than measurement noise.
  needsHeal(height: number, keyboardOpen: boolean): boolean {
    if (keyboardOpen) return false;
    return this.maxHeight - height > HEAL_TOLERANCE;
  }
}

// The keyboard is on its way in (or up) whenever a text field has focus. The
// viewport numbers lag the keyboard animation by a few hundred ms, so during
// that window innerHeight is already short while visualViewport still looks
// keyboard-free — exactly what needsHeal() takes for the standalone bug.
// Healing then re-measures the viewport mid-animation and WebKit is left
// painting the app against a stale geometry until the keyboard closes.
export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || (el as HTMLElement).isContentEditable === true;
}

export function isAtBottom(el: HTMLElement, slack = 4): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= slack;
}

// When a scroller's box changes size (keyboard in/out, the viewport heal),
// WebKit's asynchronous scrolling tree can keep the old offset even though
// it now lies past the new maximum: the visible strip maps to nothing, the
// transcript looks empty, and the first finger-scroll re-clamps it. Pinning
// scrollTop to scrollHeight while the keyboard is up (so the composer's
// context stays in view) makes that offset the largest possible one. So
// after each such change re-assert an in-range offset from the main thread,
// and move it by a pixel across two frames so the compositor re-tiles.
export function settleScroller(el: HTMLElement | null, stickToBottom: boolean): void {
  if (!el || el.clientHeight === 0) return;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const target = stickToBottom ? max : Math.min(Math.max(0, el.scrollTop), max);
  el.scrollTop = target === max ? Math.max(0, target - 1) : target + 1;
  requestAnimationFrame(() => {
    el.scrollTop = target;
  });
}

// Toggle display on the app shell (must be full viewport height) so WebKit
// recomputes the viewport; keep the message list's scroll position across it.
export function healViewport(shell: HTMLElement | null, scroller: HTMLElement | null): void {
  if (!shell) return;
  const top = scroller?.scrollTop ?? 0;
  const bottom = scroller ? scroller.clientHeight > 0 && isAtBottom(scroller) : false;
  shell.style.display = "none";
  void shell.offsetHeight;
  shell.style.display = "";
  if (scroller) {
    scroller.scrollTop = top;
    settleScroller(scroller, bottom);
  }
}
