// The real Server in-process over a seeded data dir. The Claude SDK is a fake
// that records the options each query starts with and the prompts sent to it,
// and yields only the frames a test emits, so no CLI is spawned; the quota
// probe is stubbed so no API request is made.
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
import { ProjectManager } from "../../src/project/manager";
import { closeHistory, historyOf, saveIndex, saveWorkspace } from "../../src/workspace/state";
import { ClaudeSession } from "../../src/session/claude";

interface FakeTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}
interface Launch {
  cwd: string | undefined;
  model?: string;
  effort?: string;
  panel?: { instructions: string; tools: FakeTool[] };
  prompts: string[];
  emit: (frame: unknown) => void;
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
    query: ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<{ message: { content: string } }>;
      options: Record<string, unknown>;
    }) => {
      const servers = options.mcpServers as Record<string, Launch["panel"]> | undefined;
      const frames: unknown[] = [];
      let wake = () => {};
      let closed = false;
      const launch: Launch = {
        cwd: options.cwd as string | undefined,
        model: options.model as string | undefined,
        effort: options.effort as string | undefined,
        panel: servers?.panel,
        prompts: [],
        emit: (frame) => {
          frames.push(frame);
          wake();
        },
      };
      launches.push(launch);
      void (async () => {
        for await (const m of prompt) launch.prompts.push(m.message.content);
      })();
      const next = async (): Promise<IteratorResult<unknown>> => {
        while (!frames.length && !closed) await new Promise<void>((r) => (wake = r));
        return closed ? { value: undefined, done: true } : { value: frames.shift(), done: false };
      };
      return {
        [Symbol.asyncIterator]: () => ({ next }),
        close: () => {
          closed = true;
          wake();
        },
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
// livePaused, orphanPaused: ms from now (past or future) to the reset the
// live worker's and the orphan's pending rate-limit retries wait for (the
// orphan's is the live one's unless given); liveQueued: a message still queued
// for the live worker.
function seed(
  opts: {
    leadArchived?: boolean;
    livePaused?: number;
    orphanPaused?: number;
    liveQueued?: boolean;
  } = {},
) {
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
  const paused = (ms?: number) =>
    ms !== undefined && { pausedUntil: now + ms, lastPrompt: "carry on" };
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
      agents: [{ ...agent("a-live", "Live", root), ...paused(opts.livePaused) }],
      createdAt: now,
      messages: opts.liveQueued
        ? [
            {
              id: "q1",
              kind: "user",
              agentId: null,
              content: "go on",
              timestamp: now,
              status: "queued",
              queuedFor: "a-live",
              queuedPrompt: "go on",
            },
          ]
        : [],
      projectLink: { projectId: "proj-1", role: "worker" },
    },
    {
      id: "ws-orphan",
      name: "orphan",
      project: "repo",
      hostId: "local",
      cwd: root,
      agents: [{ ...agent("a-o", "O", root), ...paused(opts.orphanPaused ?? opts.livePaused) }],
      createdAt: now,
      messages: [],
      projectLink: { projectId: "proj-gone", role: "worker" },
    },
  ];
  for (const s of states) saveWorkspace(base, s);
  saveIndex(
    base,
    states.map((s) => s.id),
  );
  closeHistory(base);
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
  return { server, port, frames, send, stop };
}

// A workspace as saved: what it is, and its history.
const readState = (base: string, id: string): WorkspaceState => {
  const dir = path.join(base, ".agent-team", "cache", "workspaces");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf-8")) as WorkspaceState;
  const messages = historyOf(base).load(id);
  closeHistory(base);
  return { ...meta, messages };
};

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
        "current_task",
        "list_objectives",
        "write_objective",
        "add_items",
        "update_item",
        "project_status",
        "read_session",
        "list_history",
        "search_history",
        "read_entry",
        "query_history",
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

  it("shows a worker waiting for the user to a client that connects, and once restored", async () => {
    const { base, web } = seed();
    const waiting = (agentId: string): Message[] => [
      {
        id: `${agentId}-t`,
        kind: "user",
        agentId: null,
        content: "do it",
        timestamp: 1000,
        status: "done",
        from: { workspaceId: "ws-lead", name: "lead", role: "lead" },
      },
      {
        id: `${agentId}-r`,
        kind: "agent",
        agentId,
        content: "Which branch?",
        timestamp: 1001,
        status: "done",
      },
    ];
    historyOf(base).save("ws-live", waiting("a-live"), "all");
    historyOf(base).save("ws-w", waiting("a-w"), "all");
    closeHistory(base);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop, port } = await start(base, web);
    try {
      const infos = frames.find((f) => f.type === "init")!.workspaces as Array<{
        id: string;
        awaitsUser?: boolean;
      }>;
      expect(infos.find((w) => w.id === "ws-live")!.awaitsUser).toBe(true);
      expect(infos.find((w) => w.id === "ws-w")!.awaitsUser).toBeUndefined();
      expect(infos.find((w) => w.id === "ws-lead")!.awaitsUser).toBeUndefined();

      // The user writes to it: what a client that connects now gets, the
      // first is told too.
      send({ type: "send_message", workspaceId: "ws-live", content: "main" });
      await until(() => launches.length === 1, "the turn");
      const other = new WebSocket(`ws://127.0.0.1:${port}/`);
      const got: Array<Record<string, unknown>> = [];
      other.on("message", (raw: Buffer) => got.push(JSON.parse(raw.toString()) as never));
      await until(() => got.some((f) => f.type === "init"), "the second client's list");
      other.close();
      const live = (got.find((f) => f.type === "init")!.workspaces as typeof infos).find(
        (w) => w.id === "ws-live",
      )!;
      expect(live.awaitsUser).toBeUndefined();
      const told = () => {
        const updates = frames
          .filter((f) => f.type === "workspace_updated")
          .map((f) => f.workspace as { id: string; awaitsUser?: boolean })
          .filter((w) => w.id === "ws-live");
        return updates.length > 0 && updates[updates.length - 1].awaitsUser === undefined;
      };
      await until(told, "the first client told it no longer waits");

      send({ type: "unarchive_workspace", workspaceId: "ws-w" });
      const updated = () =>
        frames
          .filter((f) => f.type === "workspace_updated")
          .map((f) => f.workspace as { id: string; awaitsUser?: boolean })
          .filter((w) => w.id === "ws-w");
      await until(() => updated().length > 0, "the restored worker's update");
      expect(updated()[0].awaitsUser).toBe(true);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("has the projects check a worker whose turn ended or who went idle", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const idle = vi.spyOn(ProjectManager.prototype, "workerIdle");
    const { send, stop } = await start(base, web);
    try {
      send({ type: "abort", workspaceId: "ws-live" });
      await until(() => idle.mock.calls.length > 0, "the check");
      expect(idle.mock.calls[0][0].id).toBe("ws-live");
    } finally {
      stop();
      idle.mockRestore();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("saves a worker's turn a shutdown cut off as cut by the restart, and what drove it", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-lead", content: "hello" });
      await until(() => launches.length === 1, "lead query");
      const tools = Object.fromEntries(launches[0].panel!.tools.map((t) => [t.name, t]));
      await tools.message_session.handler({ session_id: "ws-live", message: "build it" });
      await until(() => launches.length === 2, "worker query");
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-live");
    const asked = saved.messages!.find((m) => m.content === "build it")!;
    expect(saved.agents[0].delivered).toMatchObject({ id: asked.id, stopped: "restart" });
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("retries the turns a rate limit paused before the restart, one at a time", async () => {
    // Both wait for the same reset, still to come.
    const { base, web, root } = seed({ livePaused: 7000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    try {
      for (let i = 0; i < 1000 && launches.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(launches[0].cwd).toBe(root);
      // The other one waits for its own slot.
      await new Promise((r) => setTimeout(r, 2500));
      expect(launches).toHaveLength(1);
    } finally {
      stop();
      log.mockRestore();
    }
    expect(readState(base, "ws-live").agents[0].pausedUntil).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  }, 20_000);

  it("retries a turn whose limit has reset without waiting behind another's retry hours away", async () => {
    const { base, web } = seed({ livePaused: 3600_000, orphanPaused: -1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    try {
      await until(() => launches.length === 1, "the due retry");
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("starts a queued message and a due retry one slot apart", async () => {
    const { base, web } = seed({ liveQueued: true, orphanPaused: -1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stop } = await start(base, web);
    try {
      await until(() => launches.length === 1, "the first start");
      await new Promise((r) => setTimeout(r, 2500));
      expect(launches).toHaveLength(1);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("runs no retry for a worker archived while it waited for it", async () => {
    const { base, web } = seed({ livePaused: -1000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { send, stop } = await start(base, web);
    try {
      send({ type: "archive_workspace", workspaceId: "ws-live" });
      send({ type: "archive_workspace", workspaceId: "ws-orphan" });
      await new Promise((r) => setTimeout(r, 2000));
      expect(launches).toEqual([]);
    } finally {
      stop();
      log.mockRestore();
    }
    expect(readState(base, "ws-live").agents[0].pausedUntil).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("keeps a lead out of the archive: its project is archived instead", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "archive_workspace", workspaceId: "ws-lead" });
      await until(() => frames.some((f) => f.type === "error"), "the refusal");
      expect(frames.find((f) => f.type === "error")!.message).toBe(
        "A lead goes with its project: archive the project from its board",
      );
      expect(frames.some((f) => f.type === "workspace_archived")).toBe(false);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("runs a new lead and the workers it starts on Opus 5.5 at xhigh unless asked otherwise", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      const root = path.join(base, "other");
      fs.mkdirSync(root);
      send({ type: "create_project", name: "other", path: root });
      const created = () =>
        frames.find(
          (f) => f.type === "workspace_created" && (f.workspace as { cwd: string }).cwd === root,
        );
      await until(() => created() !== undefined, "the new lead");
      const leadId = (created()!.workspace as { id: string }).id;
      send({ type: "send_message", workspaceId: leadId, content: "hello" });
      await until(() => launches.length === 1, "lead query");
      expect(launches[0]).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });

      const start_session = launches[0].panel!.tools.find((t) => t.name === "start_session")!;
      await start_session.handler({ title: "w", cwd: ".", task: "t" });
      await until(() => launches.length === 2, "worker query");
      expect(launches[1]).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
    } finally {
      stop();
      log.mockRestore();
    }
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
      const infos = init.workspaces as Array<{
        id: string;
        cwd: string;
        projectLink?: { projectId: string; role: string };
      }>;
      expect(fs.existsSync(path.join(base, ".agent-team", "projects", "proj-1"))).toBe(false);
      // Every workspace belongs to its folder's project: the deleted project's
      // live worker joins a new one, with a fresh lead and no memory.
      const live = infos.find((w) => w.id === "ws-live")!;
      const projects = init.projects as Array<Project & { objectives: unknown[] }>;
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ root: live.cwd, objectives: [] });
      expect(projects[0].archivedAt ?? null).toBeNull();
      expect(live.projectLink).toEqual({ projectId: projects[0].id, role: "worker" });
      expect(infos.map((w) => w.id)).toContain(projects[0].leadWorkspaceId);
    } finally {
      again.stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("rate limits on the server", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const limit = (rateLimitType: string) => ({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType },
    session_id: "s",
  });
  const result = (text: string) => ({
    type: "result",
    subtype: "success",
    result: text,
    session_id: "s",
  });

  it("lets the retry the user's message started run through a weekly-limit failover", async () => {
    const { base, web } = seed();
    fs.writeFileSync(path.join(base, "config.toml"), '[accounts.other]\noauth_token = "t"\n');
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      launches[0].emit(limit("seven_day"));
      launches[0].emit({ ...result("limit"), is_error: true });
      await wait(100);
      send({ type: "send_message", workspaceId: "ws-live", content: "U" });
      await wait(1500);
      expect(launches.map((l) => l.prompts)).toEqual([["P"], ["P"]]);
      launches[1].emit(result("done"));
      await until(() => launches[1].prompts.length === 2, "the user's message");
      expect(launches[1].prompts).toEqual(["P", "U"]);
    } finally {
      stop();
      log.mockRestore();
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("retries nothing after a limit on a turn the CLI started itself", async () => {
    const { base, web } = seed();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { frames, send, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-live", content: "P" });
      await until(() => launches[0]?.prompts.length === 1, "the turn");
      const q = launches[0];
      q.emit(result("done"));
      q.emit(limit("five_hour"));
      q.emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "limit" }] },
        parent_tool_use_id: null,
        session_id: "s",
      });
      q.emit({ ...result("limit"), is_error: true });
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "new_message" &&
              (f.message as Message).content.includes("hit the 5-hour limit"),
          ),
        "the pause",
      );
    } finally {
      stop();
      log.mockRestore();
    }
    const saved = readState(base, "ws-live").agents[0];
    expect(saved.pausedUntil).toBeDefined();
    expect(saved.lastPrompt).toBeUndefined();
    fs.rmSync(base, { recursive: true, force: true });
  });
});
