import { useEffect, useState } from "react";
import { isStandalone } from "./viewport";

// One muted line of viewport facts (sidebar, small screens only) so layout
// problems on real phones can be diagnosed from a screenshot: what iOS
// reports for the window, the visual viewport, safe areas and display mode.
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

export function formatViewportFacts(f: ViewportFacts): string {
  const r = (n: number | null) => (n == null ? "–" : String(Math.round(n)));
  return [
    `inner ${r(f.inner)}`,
    `outer ${r(f.outer)}`,
    `screen ${r(f.screen)}`,
    `vv ${r(f.vv)}${f.vvTop ? `+${r(f.vvTop)}` : ""}`,
    `dvh ${r(f.dvh)}`,
    `safe ${r(f.safeTop)}/${r(f.safeBottom)}`,
    f.standalone ? "standalone" : "browser",
  ].join(" · ");
}

export function ViewportInfo() {
  const [facts, setFacts] = useState<ViewportFacts | null>(null);
  useEffect(() => {
    const update = () => setFacts(readViewportFacts());
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  if (!facts) return null;
  return (
    <div className="viewport-info" title="Viewport diagnostics">
      {formatViewportFacts(facts)}
    </div>
  );
}
