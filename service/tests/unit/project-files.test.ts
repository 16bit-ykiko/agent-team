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
import { execFileSync } from "child_process";
import { findBySuffix, resolveProjectPath } from "../../src/project/paths";
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
  for (const d of ["a", "b"]) {
    fs.mkdirSync(path.join(notes, "rules", d));
    fs.writeFileSync(path.join(notes, "rules", d, "dup.md"), "");
  }
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
    // A symlink in the repository does not lead out of it, to a file there or not.
    expect(r("out/secret.txt")).toBeNull();
    expect(r("out/new.txt")).toBeNull();
    expect(r("..foo")).toBe(path.join(root, "..foo"));
    // A root reached through a symlink, the path written as it really is.
    const link = path.join(base, "repo-link");
    if (!fs.existsSync(link)) fs.symlinkSync(root, link);
    expect(resolveProjectPath(path.join(root, "src", "a.cpp"), link, notes)).toBe(
      path.join(root, "src", "a.cpp"),
    );
  });
});

describe("a path missing from the repository", () => {
  it("is the one file or folder whose path ends with it, if there is one", async () => {
    const repo = path.join(base, "suffix");
    for (const f of ["src/sched/batch.cpp", "docs/en/cli/format.md", "docs/zh/cli/format.md"]) {
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), "");
    }
    fs.writeFileSync(path.join(repo, "untracked.cpp"), "");
    fs.writeFileSync(path.join(repo, "ignored.cpp"), "");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.cpp\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "src", "docs"], { cwd: repo });
    const find = async (p: string) => (await findBySuffix(p, repo, notes)).map((f) => f.ref);
    expect(await findBySuffix("sched/batch.cpp", repo, notes)).toEqual([
      { ref: "src/sched/batch.cpp", abs: path.join(repo, "src/sched/batch.cpp") },
    ]);
    expect(await find("batch.cpp")).toEqual(["src/sched/batch.cpp"]);
    expect(await find("untracked.cpp")).toEqual(["untracked.cpp"]);
    expect(await find("sched/")).toEqual(["src/sched"]);
    expect(await find("rules/cli.md")).toEqual(["notes/rules/cli.md"]);
    expect(await find("cli/format.md")).toEqual(["docs/en/cli/format.md", "docs/zh/cli/format.md"]);
    // Part of a name, or a path the board reads as it is.
    expect(await find("ched/batch.cpp")).toEqual([]);
    expect(await find("ignored.cpp")).toEqual([]);
    expect(await find("notes/cli.md")).toEqual([]);
    expect(await find("../batch.cpp")).toEqual([]);
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
    expect((await get("project=p1&path=cli.md")).body.path).toBe(path.join(notes, "rules/cli.md"));
    expect(await get("project=p1&path=dup.md")).toMatchObject({
      status: 404,
      body: { candidates: ["notes/rules/a/dup.md", "notes/rules/b/dup.md"] },
    });
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
    // Neither null nor a folder (VS Code would open a window for it) nor a flood.
    expect((await open(null)).status).toBe(400);
    expect((await open({ project: "p1", path: "src" })).status).toBe(400);
    expect((await open({ project: "p1", path: "src/nope.cpp" })).status).toBe(404);
    expect((await open({ project: "p1", path: "x".repeat(70_000) })).status).toBe(413);
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

  it("moves on from a window that does not answer, leaving nothing behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-vsc-"));
    try {
      const run = path.join(dir, "run");
      fs.mkdirSync(run);
      const hung = path.join(run, "vscode-ipc-hung.sock");
      const live = path.join(run, "vscode-ipc-live.sock");
      const cli = path.join(dir, "server", "bin", "abc", "bin", "remote-cli", "code");
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      const log = path.join(dir, "log");
      const pid = path.join(dir, "pid");
      fs.writeFileSync(
        cli,
        `#!/bin/sh\nif [ "$VSCODE_IPC_HOOK_CLI" = "${hung}" ]; then sleep 30 & echo $! > ${pid}; wait; fi\necho "$VSCODE_IPC_HOOK_CLI" > ${log}\n`,
        { mode: 0o755 },
      );
      const servers = [hung, live].map(() => net.createServer(() => {}));
      await Promise.all(
        servers.map((srv, i) => new Promise<void>((r) => srv.listen([hung, live][i], r))),
      );
      fs.utimesSync(live, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

      await openInVSCode("/repo/a.cpp", undefined, {
        serverDir: path.join(dir, "server"),
        runtimeDir: run,
        timeoutMs: 300,
      });
      expect(fs.readFileSync(log, "utf-8").trim()).toBe(live);
      const sleeper = Number(fs.readFileSync(pid, "utf-8"));
      await new Promise((r) => setTimeout(r, 100));
      expect(() => process.kill(sleeper, 0)).toThrow();
      await Promise.all(servers.map((srv) => new Promise<void>((r) => srv.close(() => r()))));
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
