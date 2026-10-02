// Side panels in the app: how wide, docked or floating, maximised, and the
// chat header beside them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { App } from "../src/App";
import type { Project, Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

const NOW = Date.now();
const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "clice",
  hostId: "local",
  cwd: `/repo/${id}`,
  git: null,
  pr: null,
  agents: [{ id: `${id}-a`, name: "A", model: "m", avatar: "A", color: "#fff", isDefault: true }],
  messages: [],
  createdAt: NOW - 5000,
  lastMessageAt: NOW - 5000,
  ...over,
});
const project: Project = {
  id: "p1",
  name: "clice",
  root: "/repo/clice",
  leadWorkspaceId: "lead",
  createdAt: 0,
  objectives: [],
};
const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo/clice",
  projectLink: { projectId: "p1", role: "lead" },
});
const worker = ws("w1", { name: "modules", projectLink: { projectId: "p1", role: "worker" } });

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ kind: "dir", path: "/repo/clice", truncated: false, entries: [] }),
      }),
    ),
  );
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

function boot(active: string, workspaces = [lead, worker]) {
  localStorage.setItem("activeWsId", active);
  const utils = render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  act(() => sock.open());
  act(() =>
    sock.receive({
      type: "init",
      workspaces,
      config: { presets: [], models: [], commands: [], hosts: {} },
      hosts: [],
      projects: [project],
    }),
  );
  return utils;
}
const rail = (label: string) =>
  fireEvent.click(document.querySelector(`.side-rail [aria-label="${label}"]`)!);
const panel = () => document.querySelector(".side-panel") as HTMLElement;
const resize = (width: number) =>
  act(() => {
    vi.stubGlobal("innerWidth", width);
    window.dispatchEvent(new Event("resize"));
  });

describe("the chat header's title", () => {
  it("names the folder unless the session's name already starts with it as a word", () => {
    const first = boot("lead");
    expect(document.querySelector(".panel-title")!.textContent).toBe("clice · lead");
    first.unmount();
    const second = boot("w1");
    expect(document.querySelector(".panel-title")!.textContent).toBe("modules — clice");
    second.unmount();
    boot("x", [ws("x", { name: "clicer perf" })]);
    expect(document.querySelector(".panel-title")!.textContent).toBe("clicer perf — clice");
  });
});

describe("panel widths", () => {
  it("give the Files panel its own automatic and saved width, apart from the lists", () => {
    vi.stubGlobal("innerWidth", 2560);
    boot("lead");
    rail("Files");
    expect(panel().getAttribute("aria-label")).toBe("Files");
    expect(panel().style.width).toBe("1075px");
    const edge = document.querySelector(".side-panel-resize")!;
    fireEvent.pointerDown(edge, { clientX: 1500, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 1400, pointerId: 1 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(panel().style.width).toBe("1175px");
    expect(localStorage.getItem("filesPanelWidth")).toBe("1175");
    rail("Agents and sessions");
    expect(panel().style.width).toBe("560px");
    expect(localStorage.getItem("listPanelWidth")).toBeNull();
  });

  it("leave the chat its room when the window narrows", () => {
    vi.stubGlobal("innerWidth", 1440);
    boot("lead");
    rail("Files");
    expect(panel().style.width).toBe("605px");
    resize(960);
    // 960 - 260 (sidebar) - 44 (rail) - 360 (the chat's least), or the panel's least.
    expect(panel().style.width).toBe("300px");
  });
});

describe("docked or floating", () => {
  it("docks unless floating was chosen, and saves a change", () => {
    localStorage.setItem("panelDock", "0");
    const first = boot("lead");
    rail("Agents and sessions");
    expect(panel().className).toContain("floating");
    first.unmount();
    localStorage.removeItem("panelDock");
    boot("lead");
    rail("Agents and sessions");
    expect(panel().className).toContain("docked");
    fireEvent.click(document.querySelector(".side-panel-pin")!);
    expect(panel().className).toContain("floating");
    expect(localStorage.getItem("panelDock")).toBe("0");
  });

  it("floats a pinned panel over a chat too narrow to use, and docks it again", () => {
    vi.stubGlobal("innerWidth", 1440);
    boot("lead");
    rail("Files");
    expect(panel().className).toContain("docked");
    // 900 - 260 (sidebar) - 44 (rail) - 300 (the panel) leaves the chat 296px:
    // narrow, but Send is in view.
    resize(900);
    expect(panel().className).toContain("docked");
    // 800 leaves it 196px: the panel floats, and cannot be pinned there.
    resize(800);
    expect(panel().className).toContain("floating");
    const pin = document.querySelector(".side-panel-pin") as HTMLButtonElement;
    expect([pin.disabled, pin.getAttribute("aria-pressed")]).toEqual([true, "false"]);
    resize(1440);
    expect(panel().className).toContain("docked");
    expect(localStorage.getItem("panelDock")).toBeNull();
  });
});

describe("a maximised panel", () => {
  it("steps back when another panel, or another session, is opened", () => {
    boot("lead");
    rail("Agents and sessions");
    fireEvent.click(document.querySelector(".side-panel-max")!);
    expect(panel().className).toContain("maximized");
    rail("Files");
    expect(panel().className).not.toContain("maximized");
    expect(document.querySelector(".side-panel-pin")).not.toBeNull();

    rail("Agents and sessions");
    fireEvent.click(document.querySelector(".side-panel-max")!);
    fireEvent.click(document.querySelector('[aria-label="modules"] .ap-session-name')!);
    expect(document.querySelector(".panel-title")!.textContent).toBe("modules — clice");
    expect(panel().className).not.toContain("maximized");
  });

  it("does not follow to a workspace picked in the sidebar", () => {
    boot("lead");
    rail("Files");
    fireEvent.click(document.querySelector(".side-panel-max")!);
    fireEvent.click(
      [...document.querySelectorAll(".task-item")].find((el) =>
        el.textContent?.includes("modules"),
      )!,
    );
    expect(panel().className).not.toContain("maximized");
  });
});

describe("panel chrome", () => {
  it("titles every panel over the same second line, and keeps the pin's label", () => {
    boot("lead");
    rail("Files");
    expect(document.querySelector(".side-panel-sub")!.textContent).toBe("clice");
    const pin = () => document.querySelector(".side-panel-pin")!;
    const [label, pressed] = [pin().getAttribute("title"), pin().getAttribute("aria-pressed")];
    fireEvent.click(pin());
    expect(pin().getAttribute("title")).toBe(label);
    expect(pin().getAttribute("aria-pressed")).not.toBe(pressed);
  });

  it("sets the board apart in the rail, and cuts the folder path at its front", () => {
    boot("lead");
    expect(document.querySelector(".side-rail .rail-page")!.getAttribute("aria-label")).toBe(
      "Objectives of clice",
    );
    expect(document.querySelector(".ws-info-path")!.textContent).toBe("/repo/clice");
    rail("Objectives of clice");
    expect(document.querySelector(".bp-head .bp-close svg")).not.toBeNull();
  });
});

describe("the composer on a phone", () => {
  it("has a placeholder that fits, and keeps a reader at the end as it grows", () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true,
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    const observers = new Map<Element, () => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {}
        observe(el: Element) {
          observers.set(el, this.cb);
        }
        disconnect() {}
      },
    );
    boot("lead");
    expect(document.querySelector("textarea")!.placeholder).toBe("Message, or / for commands");

    const el = document.querySelector(".messages") as HTMLElement;
    const resized = () => observers.get(el)!();
    let height = 600;
    let top = 1400;
    Object.defineProperty(el, "clientHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "scrollHeight", { get: () => 2000, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => (top = v),
      configurable: true,
    });
    resized();
    // A long draft takes 100px from below: the end stays in view.
    height = 500;
    resized();
    expect(top).toBe(2000);
    // A pixel short is the keyboard's settle nudge: left alone.
    top = 1499;
    height = 501;
    resized();
    height = 500;
    resized();
    expect(top).toBe(1499);
    // Read back up, the reader stays where they are.
    top = 200;
    fireEvent.scroll(el);
    height = 400;
    resized();
    expect(top).toBe(200);
  });

  it("leaves the reader where they are when a box they opened at the end grew first", () => {
    const observers = new Map<Element, () => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {}
        observe(el: Element) {
          observers.set(el, this.cb);
        }
        disconnect() {}
      },
    );
    boot("lead");
    const el = document.querySelector(".messages") as HTMLElement;
    let height = 600;
    let scrollHeight = 2000;
    let top = 1400;
    Object.defineProperty(el, "clientHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => (top = v),
      configurable: true,
    });
    observers.get(el)!();
    // The last box opens: the transcript grows below, no scroll happens.
    scrollHeight = 2600;
    // A long draft then takes room: the reader stays on the box.
    height = 480;
    observers.get(el)!();
    expect(top).toBe(1400);
  });
});
