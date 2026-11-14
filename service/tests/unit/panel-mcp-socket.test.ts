import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { z } from "zod";
import { PanelMcpSocket, forGemini } from "../../src/session/panel-mcp";
import {
  leadToolset,
  workerToolset,
  type PanelApi,
  type PanelToolset,
} from "../../src/project/tools";

const toolset: PanelToolset = {
  instructions: "x",
  tools: [
    {
      name: "report",
      description: "Report a line.",
      shape: { text: z.string() },
      handler: (args) => Promise.resolve(`got ${String(args.text)}`),
    },
    {
      name: "refuse",
      description: "Always fails.",
      shape: {},
      handler: () => Promise.reject(new Error("no task to report on")),
    },
  ],
};

let server: PanelMcpSocket | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

// The command agy is given, run as agy runs it: JSON-RPC over its stdio.
function client(socket: PanelMcpSocket) {
  const cmd = socket.command("panel");
  const child = spawn(cmd.command, cmd.args, { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line) as { id: number };
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  const call = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { call, child };
}

describe("the panel's MCP server", () => {
  it("serves the panel's tools through the stdio command agy spawns", async () => {
    const answers: unknown[] = [];
    server = new PanelMcpSocket(
      () => toolset,
      (...a) => answers.push(a),
    );
    await server.listen();
    const { call, child } = client(server);
    try {
      expect((await call("server/discover")).result).toEqual({});
      const init = await call("initialize", { protocolVersion: "2025-11-25" });
      expect(init.result).toMatchObject({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
      });
      const list = (await call("tools/list")).result as { tools: Array<Record<string, unknown>> };
      expect(list.tools.map((t) => t.name)).toEqual(["report", "refuse"]);
      expect(list.tools[0].inputSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      });
      // agy adds a toolSummary of its own to every call's arguments.
      const ok = await call("tools/call", {
        name: "report",
        arguments: { text: "hi", toolSummary: "Report" },
      });
      expect(ok.result).toEqual({ content: [{ type: "text", text: "got hi" }] });
      const failed = await call("tools/call", { name: "refuse", arguments: {} });
      expect(failed.result).toMatchObject({
        isError: true,
        content: [{ text: "no task to report on" }],
      });
      const invalid = await call("tools/call", { name: "report", arguments: {} });
      expect(invalid.result).toMatchObject({ isError: true });
      const unknown = await call("tools/call", { name: "nope", arguments: {} });
      expect(unknown.result).toMatchObject({ isError: true });
      expect((await call("resources/list")).error).toMatchObject({ code: -32601 });
      expect(answers[0]).toEqual([
        "report",
        { text: "hi", toolSummary: "Report" },
        "got hi",
        false,
      ]);
      expect(answers[1]).toEqual(["refuse", {}, "no task to report on", true]);
    } finally {
      child.kill();
    }
  });
});

// Gemini refuses a request whose tools hold an empty enum value (a project
// agy agent failed every turn on write_issues' evidence: "" clears).
describe("the panel's tools as agy sends them to Gemini", () => {
  const emptyEnums = (v: unknown, at = ""): string[] => {
    if (Array.isArray(v)) return v.flatMap((x, i) => emptyEnums(x, `${at}[${i}]`));
    if (!v || typeof v !== "object") return [];
    const own =
      Array.isArray((v as { enum?: unknown[] }).enum) &&
      (v as { enum: unknown[] }).enum.includes("")
        ? [at]
        : [];
    return [...own, ...Object.entries(v).flatMap(([k, x]) => emptyEnums(x, `${at}.${k}`))];
  };

  it("names an enum's values in its description when one is empty", () => {
    expect(
      forGemini({
        type: "object",
        properties: {
          evidence: { type: "string", enum: ["R", "V", ""], description: '"" clears' },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { evidence: { type: "string", description: '"" clears. One of "R", "V", ""' } },
    });
    expect(forGemini({ enum: ["a", "b"] })).toEqual({ enum: ["a", "b"] });
  });

  it("lists no empty enum value in any lead or worker tool, and still takes one in a call", async () => {
    const api = new Proxy({} as PanelApi, { get: () => () => Promise.resolve("ok") });
    const project = { id: "p1", name: "x", root: "/r", leadWorkspaceId: null, createdAt: 0 };
    const tools = [
      ...leadToolset(api, project, "/n", ["m"]).tools,
      ...workerToolset(api, "ws-1", project, "/n").tools,
    ];
    server = new PanelMcpSocket(() => ({ instructions: "x", tools }));
    await server.listen();
    const { call, child } = client(server);
    try {
      const list = (await call("tools/list")).result as { tools: Array<Record<string, unknown>> };
      expect(list.tools.some((t) => t.name === "write_issues")).toBe(true);
      expect(list.tools.flatMap((t) => emptyEnums(t.inputSchema, String(t.name)))).toEqual([]);
      const cleared = await call("tools/call", {
        name: "write_issues",
        arguments: { issues: [{ id: "11-14#1", evidence: "" }] },
      });
      expect(cleared.result).not.toMatchObject({ isError: true });
    } finally {
      child.kill();
    }
  });
});
