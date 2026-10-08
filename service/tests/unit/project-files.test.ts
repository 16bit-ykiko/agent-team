// A project's board reads and opens files of its notes and repository only:
// the path rules, api/file with a project, api/open, and VS Code's CLI found
// and pointed at a live window.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Auth } from "../../src/server/auth";
import { HttpHandler } from "../../src/server/http";
import { resolveProjectPath } from "../../src/project/paths";
import { openInVSCode, VSCodeUnavailable } from "../../src/repo/vscode";

let base: string;
let root: string;
let notes: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-pfiles-")));
  root = path.join(base, "repo");
  notes = path.join(base, "data", "notes");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(notes, "rules"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.cpp"), "int a;\n");
  fs.writeFileSync(path.join(notes, "rules", "cli.md"), "# CLI\n");
  fs.writeFileSync(path.join(base, "secret.txt"), "no");
  fs.symlinkSync(base, path.join(root, "out"));
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("board paths", () => {
  it("lead notes/ to the notes, the rest into the repository, and nowhere else", () => {
    const r = (p: string) => resolveProjectPath(p, root, notes);
    expect(r("notes/rules/cli.md")).toBe(path.join(notes, "rules", "cli.md"));
    expect(r("notes")).toBe(notes);
    expect(r("src/a.cpp")).toBe(path.join(root, "src", "a.cpp"));
    expect(r("./src/a.cpp")).toBe(path.join(root, "src", "a.cpp"));
    expect(r(path.join(root, "src", "a.cpp"))).toBe(path.join(root, "src", "a.cpp"));
    expect(r("src/missing.cpp")).toBe(path.join(root, "src", "missing.cpp"));
    expect(r("../secret.txt")).toBeNull();
    expect(r("notes/../../secret.txt")).toBeNull();
    expect(r(path.join(base, "secret.txt"))).toBeNull();
    // A symlink in the repository does not lead out of it.
    expect(r("out/secret.txt")).toBeNull();
  });
});

describe("api/file and api/open for a project", () => {
  let server: http.Server;
  let port: number;
  const opened: Array<[string, number | undefined]> = [];
  let fail: Error | null = null;

  beforeAll(async () => {
    const handler = new HttpHandler(
      new Auth(() => null),
      base,
      base,
      base,
      () => undefined,
      () => undefined,
      (id) => (id === "p1" ? { root, notesDir: notes } : undefined),
      (file, line) => {
        if (fail) return Promise.reject(fail);
        opened.push([file, line]);
        return Promise.resolve();
      },
    );
    server = http.createServer((req, res) => handler.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const get = (q: string) =>
    fetch(`http://127.0.0.1:${port}/api/file?${q}`).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as Record<string, unknown>,
    }));
  const open = (body: unknown, type = "application/json") =>
    fetch(`http://127.0.0.1:${port}/api/open`, {
      method: "POST",
      headers: { "Content-Type": type },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  it("read a note, list the notes, and refuse what lies outside", async () => {
    const note = await get("project=p1&path=notes/rules/cli.md");
    expect(note).toMatchObject({ status: 200, body: { kind: "text", content: "# CLI\n" } });
    const dir = await get("project=p1&path=notes");
    expect(dir.body.kind).toBe("dir");
    expect((dir.body.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(["rules"]);
    expect((await get("project=p1&path=src/a.cpp")).body.content).toBe("int a;\n");
    expect((await get("project=p1&path=../secret.txt")).status).toBe(403);
    expect((await get(`project=p1&path=${encodeURIComponent(base)}/secret.txt`)).status).toBe(403);
    expect((await get("project=nope&path=notes")).status).toBe(404);
    const raw = await fetch(`http://127.0.0.1:${port}/api/file/raw?project=p1&path=../secret.txt`);
    expect(raw.status).toBe(403);
  });

  it("open a file of the project in VS Code, and say when it cannot", async () => {
    expect(await open({ project: "p1", path: "src/a.cpp", line: 3 })).toEqual({
      status: 200,
      body: { opened: path.join(root, "src", "a.cpp") },
    });
    expect(opened).toEqual([[path.join(root, "src", "a.cpp"), 3]]);
    expect((await open({ project: "p1", path: "../secret.txt" })).status).toBe(403);
    expect((await open({ project: "p1", path: "src/a.cpp" }, "text/plain")).status).toBe(415);
    expect((await open({ path: "src/a.cpp" })).status).toBe(400);
    fail = new VSCodeUnavailable("No VS Code window is connected");
    expect(await open({ project: "p1", path: "notes/rules/cli.md" })).toEqual({
      status: 503,
      body: { error: "No VS Code window is connected" },
    });
    fail = null;
    expect(opened).toHaveLength(1);
  });
});

describe("VS Code's CLI", () => {
  it("is called with the hook of a live window, the newest live socket first", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-vsc-"));
    try {
      const cli = path.join(dir, "server", "bin", "abc", "bin", "remote-cli", "code");
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      const log = path.join(dir, "log");
      fs.writeFileSync(cli, `#!/bin/sh\necho "$VSCODE_IPC_HOOK_CLI $*" > ${log}\n`, {
        mode: 0o755,
      });
      const run = path.join(dir, "run");
      fs.mkdirSync(run);
      const env = { serverDir: path.join(dir, "server"), runtimeDir: run };

      await expect(openInVSCode("/repo/a.cpp", 3, env)).rejects.toBeInstanceOf(VSCodeUnavailable);

      const live = path.join(run, "vscode-ipc-live.sock");
      const window = net.createServer((c) => c.end());
      await new Promise<void>((r) => window.listen(live, r));
      // Left behind by a closed window, and newer.
      const dead = path.join(run, "vscode-ipc-dead.sock");
      const gone = net.createServer();
      await new Promise<void>((r) => gone.listen(dead, r));
      await new Promise<void>((r) => gone.close(() => r()));
      fs.writeFileSync(dead, "");
      fs.utimesSync(live, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

      await openInVSCode("/repo/a.cpp", 3, env);
      expect(fs.readFileSync(log, "utf-8").trim()).toBe(`${live} --goto /repo/a.cpp:3`);
      await new Promise<void>((r) => window.close(() => r()));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is reported missing when no VS Code server is installed", async () => {
    await expect(
      openInVSCode("/a", undefined, { serverDir: "/nonexistent", runtimeDir: "/nonexistent" }),
    ).rejects.toThrow(/not installed/);
  });
});
