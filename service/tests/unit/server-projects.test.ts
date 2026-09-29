// The real Server in-process over a seeded data dir. The Claude SDK is a fake
// that records the options each query starts with and never yields, so no CLI
// is spawned; the quota probe is stubbed so no API request is made.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import WebSocket from "ws";
import type { Message, WorkspaceState, AgentState } from "../../src/workspace/workspace";
import type { Project } from "../../src/project/store";
import type { Objective } from "../../src/project/objectives";

vi.mock("../../src/server/quota", () => ({
  QuotaMonitor: class {
    entries = [];
    refreshIfStale() {}
    invalidate() {}
  },
}));

import { Server } from "../../src/server/server";
import { ClaudeSession } from "../../src/session/claude";

interface FakeTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}
interface Launch {
  cwd: string | undefined;
  panel?: { instructions: string; tools: FakeTool[] };
}

let launches: Launch[] = [];
const ENV_KEYS = ["HOME", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  // Keys are restored one by one: replacing process.env itself detaches it
  // from the real environment os.homedir() reads.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]) delete process.env[k];
  launches = [];
  ClaudeSession.sdk = {
    query: ({ options }: { options: Record<string, unknown> }) => {
      const servers = options.mcpServers as Record<string, Launch["panel"]> | undefined;
      launches.push({ cwd: options.cwd as string | undefined, panel: servers?.panel });
      let finish: (r: IteratorResult<unknown>) => void = () => {};
      const pending = new Promise<IteratorResult<unknown>>((r) => (finish = r));
      return {
        [Symbol.asyncIterator]: () => ({ next: () => pending }),
        close: () => finish({ value: undefined, done: true }),
        supportedCommands: () => Promise.resolve([]),
        stopTask: () => Promise.resolve(),
        getContextUsage: () => Promise.resolve(null),
        interrupt: () => Promise.resolve(),
      };
    },
    createSdkMcpServer: (o: { instructions: string; tools: FakeTool[] }) => ({
      instructions: o.instructions,
      tools: o.tools,
    }),
    tool: (name: string, _d: string, _s: unknown, handler: FakeTool["handler"]) => ({
      name,
      handler,
    }),
  } as unknown as typeof ClaudeSession.sdk;
});

afterEach(() => {
  ClaudeSession.sdk = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

function agent(id: string, name: string, cwd: string): AgentState {
  return {
    id,
    name,
    model: "claude-opus-5-5[1m]",
    avatar: "A",
    color: "#fff",
    isDefault: true,
    session: {
      sessionId: null,
      config: { cwd, backend: "claude", model: "claude-opus-5-5[1m]" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    },
  };
}

const HISTORY: Message[] = [
  { id: "h1", kind: "user", agentId: null, content: "old prompt", timestamp: 1000, status: "done" },
  {
    id: "h2",
    kind: "agent",
    agentId: "a-w",
    content: "old reply",
    timestamp: 1001,
    status: "done",
  },
];

// A project "demo" with its lead, one archived worker with history, one live
// worker, and a workspace still linked to a project that no longer exists.
function seed(opts: { leadArchived?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-server-projects-"));
  const root = path.join(base, "repo");
  const web = path.join(base, "web");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(path.join(base, "home"));
  fs.writeFileSync(path.join(web, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(base, "config.toml"), "");
  process.env.HOME = path.join(base, "home");

  const pdir = path.join(base, ".agent-team", "projects", "proj-1");
  fs.mkdirSync(path.join(pdir, "notes"), { recursive: true });
  const project: Project = {
    id: "proj-1",
    name: "demo",
    root,
    leadWorkspaceId: "ws-lead",
    createdAt: 1,
  };
  fs.writeFileSync(path.join(pdir, "project.json"), JSON.stringify(project));
  fs.mkdirSync(path.join(pdir, "objectives", "core"), { recursive: true });
  fs.writeFileSync(
    path.join(pdir, "objectives", "core", "o.toml"),
    'title = "o"\ngoal = "g"\nsessions = ["ws-w", "ws-live"]\n',
  );

  const now = Date.now();
  const cache = path.join(base, ".agent-team", "cache");
  fs.mkdirSync(path.join(cache, "workspaces"), { recursive: true });
  const states: WorkspaceState[] = [
    {
      id: "ws-lead",
      name: "demo · lead",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [agent("a-lead", "Lead", root)],
      createdAt: 1,
      archivedAt: opts.leadArchived ? 5 : null,
      messages: [],
      projectLink: { projectId: "proj-1", role: "lead" },
    },
    {
      id: "ws-w",
      name: "worker",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [agent("a-w", "Worker", root)],
      createdAt: 1,
      archivedAt: 5,
      messages: HISTORY,
      projectLink: { projectId: "proj-1", role: "worker" },
    },
    {
      id: "ws-live",
      name: "live",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [agent("a-live", "Live", root)],
      createdAt: now,
      messages: [],
      projectLink: { projectId: "proj-1", role: "worker" },
    },
    {
      id: "ws-orphan",
      name: "orphan",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [agent("a-o", "O", root)],
      createdAt: now,
      messages: [],
      projectLink: { projectId: "proj-gone", role: "worker" },
    },
  ];
  for (const s of states) {
    fs.writeFileSync(path.join(cache, "workspaces", `${s.id}.json`), JSON.stringify(s));
  }
  fs.writeFileSync(
    path.join(cache, "index.json"),
    JSON.stringify({ workspaceIds: states.map((s) => s.id) }),
  );
  return { base, root, web };
}

async function start(base: string, web: string) {
  const port = await freePort();
  const server = new Server(port, base, web);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as never));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await until(() => frames.some((f) => f.type === "init"), "init");
  const send = (msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));
  const stop = () => {
    ws.close();
    server.close();
  };
  return { server, frames, send, stop };
}

const readState = (base: string, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(base, ".agent-team", "cache", "workspaces", `${id}.json`), "utf-8"),
  ) as WorkspaceState;

describe("server restart with projects", () => {
  it("re-attaches the panel tools and delivers to an archived worker without losing its history", async () => {
    const { base, root, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      const init = frames.find((f) => f.type === "init")!;
      const infos = init.workspaces as Array<{
        id: string;
        projectLink?: unknown;
        archivedAt: number | null;
      }>;
      // Idle far past archive_after_days, but a lead is never auto-archived.
      expect(infos.find((w) => w.id === "ws-lead")).toMatchObject({
        projectLink: { projectId: "proj-1", role: "lead" },
        archivedAt: null,
      });
      // Its project is unreadable or gone: the link stays (a repaired
      // project.json brings it back), it just gets no tools.
      expect(infos.find((w) => w.id === "ws-orphan")!.projectLink).toBeDefined();
      expect((init.projects as Project[]).map((p) => p.id)).toEqual(["proj-1"]);

      send({ type: "send_message", workspaceId: "ws-lead", content: "hello" });
      await until(() => launches.length === 1, "lead query");
      const lead = launches[0].panel;
      expect(lead, "lead launched without the panel MCP server after restart").toBeDefined();
      expect(lead!.instructions).toContain('project "demo"');
      const tools = Object.fromEntries(lead!.tools.map((t) => [t.name, t]));
      expect(Object.keys(tools)).toEqual(expect.arrayContaining(["message_session"]));

      const reply = await tools.message_session.handler({
        session_id: "ws-w",
        message: "please rebase",
      });
      expect(reply.content[0].text).toBe('Sent to "worker".');
      await until(() => launches.length === 2, "worker query");
      expect(launches[1].cwd).toBe(root);
      expect(launches[1].panel?.tools.map((t) => t.name)).toEqual([
        "report_progress",
        "finish_task",
      ]);
      await until(
        () => frames.some((f) => f.type === "new_message" && f.workspaceId === "ws-w"),
        "delivered frame",
      );
      expect(frames).toContainEqual({ type: "workspace_unarchived", workspaceId: "ws-w" });
      const delivered = frames.find((f) => f.type === "new_message" && f.workspaceId === "ws-w")!
        .message as Message;
      expect(delivered).toMatchObject({
        content: "please rebase",
        status: "done",
        from: { workspaceId: "ws-lead", role: "lead" },
      });
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-w");
    expect(saved.archivedAt).toBeNull();
    expect(saved.messages!.map((m) => m.id).slice(0, 2)).toEqual(["h1", "h2"]);
    expect(saved.messages!.some((m) => m.from?.role === "lead")).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("purges archived workers but never an archived lead, and the board forgets them", async () => {
    const { base, web } = seed({ leadArchived: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "purge_archived" });
      await until(
        () => frames.some((f) => f.type === "workspace_deleted" && f.workspaceId === "ws-w"),
        "worker purge",
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(frames.filter((f) => f.type === "workspace_deleted")).toEqual([
        { type: "workspace_deleted", workspaceId: "ws-w" },
      ]);
      expect(frames.some((f) => f.type === "project_deleted")).toBe(false);
      const updated = frames.filter((f) => f.type === "project_updated").pop()!;
      expect((updated.project as { objectives: Objective[] }).objectives[0].sessions).toEqual([
        "ws-live",
      ]);

      // Deleting the project unlinks its live worker; that survives a restart.
      send({ type: "delete_project", projectId: "proj-1" });
      await until(() => frames.some((f) => f.type === "project_deleted"), "project delete");
      expect(frames).toContainEqual({ type: "workspace_deleted", workspaceId: "ws-lead" });
    } finally {
      stop();
    }
    const again = await start(base, web);
    try {
      const init = again.frames.find((f) => f.type === "init")!;
      const infos = init.workspaces as Array<{ id: string; projectLink?: unknown }>;
      expect(infos.map((w) => w.id).sort()).toEqual(["ws-live", "ws-orphan"]);
      expect(infos.find((w) => w.id === "ws-live")!.projectLink).toBeUndefined();
      expect(init.projects).toEqual([]);
      expect(fs.existsSync(path.join(base, ".agent-team", "projects", "proj-1"))).toBe(false);
    } finally {
      again.stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
});
