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

// Toggle display on the app shell (must be full viewport height) so WebKit
// recomputes the viewport; keep the message list's scroll position across it.
export function healViewport(shell: HTMLElement | null, scroller: HTMLElement | null): void {
  if (!shell) return;
  const top = scroller?.scrollTop ?? 0;
  shell.style.display = "none";
  void shell.offsetHeight;
  shell.style.display = "";
  if (scroller) scroller.scrollTop = top;
}
