import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { z } from "zod";
import { PanelMcpSocket } from "../../src/session/panel-mcp";
import type { PanelToolset } from "../../src/project/tools";

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
