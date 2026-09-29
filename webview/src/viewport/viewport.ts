// Sizing the app shell on mobile comes down to two corrections:
//
//  * While the software keyboard is up, iOS overlays it on the layout instead
//    of resizing it, so the app is pinned to the visual viewport (size + pan
//    offset) and the composer lands right on the keyboard's top edge.
//  * In a home-screen (standalone) app, WebKit's layout viewport can end up
//    permanently shorter than the screen — the web view still covers the whole
//    display, so the shortfall shows as a dead band of page background under
//    the composer. There the screen height is the truth, not innerHeight/dvh.
export interface ViewportVars {
  height: string | null;
  offset: string | null;
}

export const KEYBOARD_THRESHOLD = 120;

// A short viewport is only trusted as the standalone bug when the gap is
// toolbar-sized. Anything larger is a different situation (a rotated screen
// whose screen.height still reports portrait, a split view, …) and is left
// alone rather than guessed at.
export const MAX_SHORTFALL = 120;

export interface ViewportMetrics {
  vvHeight: number;
  vvOffsetTop: number;
  innerHeight: number;
  // window.screen.height — unaffected by the layout-viewport bug.
  screenHeight: number;
  // env(safe-area-inset-top); non-zero means the web view really does extend
  // under the status bar, i.e. it owns the full screen height.
  safeTop: number;
  standalone: boolean;
}

// env() is only readable from a real element, so measure it off a throwaway
// probe. Returns 0 where safe areas are unsupported (desktop, older WebKit).
export function readSafeTop(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top,0px)";
  document.body.appendChild(probe);
  const top = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return top;
}

export function isStandalone(): boolean {
  return (
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches)
  );
}

// The height the app should occupy when no keyboard is up, or null to leave
// the CSS default (top/bottom pinning) in charge.
export function fullHeight(f: ViewportMetrics): number | null {
  if (!f.standalone || f.safeTop <= 0) return null;
  const shortfall = f.screenHeight - f.innerHeight;
  if (shortfall <= 0 || shortfall > MAX_SHORTFALL) return null;
  return f.screenHeight;
}

export function keyboardOpen(f: ViewportMetrics): boolean {
  return f.innerHeight - f.vvHeight > KEYBOARD_THRESHOLD;
}

export function viewportVars(f: ViewportMetrics): ViewportVars {
  if (keyboardOpen(f)) return { height: `${f.vvHeight}px`, offset: `${f.vvOffsetTop}px` };
  const full = fullHeight(f);
  return { height: full == null ? null : `${full}px`, offset: null };
}
