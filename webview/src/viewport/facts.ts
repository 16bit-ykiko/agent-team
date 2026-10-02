import { isStandalone } from "./viewport";

// What iOS reports for the window, the visual viewport, safe areas and
// display mode: the first thing a layout snapshot from a phone needs.
export interface ViewportFacts {
  inner: number;
  outer: number;
  screen: number;
  vv: number | null;
  vvTop: number | null;
  dvh: number;
  safeTop: number;
  safeBottom: number;
  standalone: boolean;
}

export function readViewportFacts(): ViewportFacts {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;height:100dvh;" +
    "padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const facts: ViewportFacts = {
    inner: window.innerHeight,
    outer: window.outerHeight,
    screen: window.screen.height,
    vv: window.visualViewport?.height ?? null,
    vvTop: window.visualViewport?.offsetTop ?? null,
    dvh: probe.offsetHeight,
    safeTop: parseFloat(cs.paddingTop) || 0,
    safeBottom: parseFloat(cs.paddingBottom) || 0,
    standalone: isStandalone(),
  };
  probe.remove();
  return facts;
}
