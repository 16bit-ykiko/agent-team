// The app body is sized to the visual viewport only while the on-screen
// keyboard is up (iOS Safari overlays it instead of resizing the layout).
// Otherwise the CSS default (100dvh) wins: in a home-screen (standalone)
// app the visual viewport can report less than the screen, which left a
// dead band under the composer.
export interface ViewportVars {
  height: string | null;
  offset: string | null;
}

export const KEYBOARD_THRESHOLD = 120;

export function viewportVars(
  vvHeight: number,
  vvOffsetTop: number,
  innerHeight: number,
): ViewportVars {
  const keyboardOpen = innerHeight - vvHeight > KEYBOARD_THRESHOLD;
  if (!keyboardOpen) return { height: null, offset: null };
  return { height: `${vvHeight}px`, offset: `${vvOffsetTop}px` };
}
