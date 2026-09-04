/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import html from "../index.html?raw";
import manifestRaw from "../public/manifest.webmanifest?raw";

// The install-to-home-screen path is all static metadata; keep it from
// silently regressing.
const icons = import.meta.glob("../public/icons/*.png");

describe("PWA metadata", () => {
  it("declares the manifest, iOS standalone metas and touch icon", () => {
    expect(html).toContain('rel="manifest" href="manifest.webmanifest"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain(
      'name="apple-mobile-web-app-status-bar-style" content="black-translucent"',
    );
    expect(html).toContain('rel="apple-touch-icon" href="icons/apple-touch-icon.png"');
    expect(html).toContain("viewport-fit=cover");
  });

  it("ships a standalone manifest with relative paths and both icons", () => {
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("./");
    const shipped = Object.keys(icons).map((k) => k.replace("../public/", ""));
    for (const icon of manifest.icons) expect(shipped).toContain(icon.src);
    expect(shipped).toContain("icons/apple-touch-icon.png");
  });
});
