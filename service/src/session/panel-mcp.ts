import { randomBytes } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { z } from "zod";
import type { PanelToolset } from "../project/tools";

// The panel's tools as an MCP server on a Unix socket, for a backend that
// takes MCP servers only as commands it spawns (agy's ACP session/new:
// stdio servers alone). The command is this node piping its stdio to the
// socket, so the protocol is served here, in-process, like every other
// backend's panel tools. Newline-delimited JSON-RPC, the subset agy uses:
// server/discover, initialize, tools/list, tools/call, ping.
const PIPE =
  'const s=require("net").connect(process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);' +
  's.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0));';

export interface StdioServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown> };

// Gemini refuses a whole request whose tools hold an empty string in an
// enum ("INVALID_ARGUMENT ... enum[5]: cannot be empty"), and agy sends
// every tool with every request: such an enum becomes a string that names
// its values. The call is still checked against the tool's own schema.
export function forGemini(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(forGemini);
  if (!v || typeof v !== "object") return v;
  const o: Record<string, unknown> = Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, forGemini(x)]),
  );
  if (Array.isArray(o.enum) && o.enum.includes("")) {
    const values = o.enum.map((e) => JSON.stringify(e)).join(", ");
    delete o.enum;
    o.description = [o.description, `One of ${values}`].filter(Boolean).join(". ");
  }
  return o;
}

export class PanelMcpSocket {
  readonly path = path.join(
    os.tmpdir(),
    `agent-team-mcp-${process.pid}-${randomBytes(6).toString("hex")}.sock`,
  );
  private server = net.createServer((socket) => this.serve(socket));
  private sockets = new Set<net.Socket>();

  constructor(
    private tools: () => PanelToolset | null,
    // Each call's answer, which the backend may not pass on.
    private onAnswer?: (tool: string, args: unknown, text: string, isError: boolean) => void,
  ) {
    this.server.on("error", () => {});
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => {
        fs.chmodSync(this.path, 0o600);
        resolve();
      });
    });
  }

  command(name: string): StdioServer {
    return { name, command: process.execPath, args: ["-e", PIPE, this.path], env: [] };
  }

  close(): void {
    for (const s of this.sockets) s.destroy();
    this.server.close();
    fs.rm(this.path, { force: true }, () => {});
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const reply = (id: Rpc["id"], body: { result: unknown } | { error: unknown }) => {
      if (!socket.destroyed) socket.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
    };
    readline.createInterface({ input: socket }).on("line", (line) => {
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        return;
      }
      if (msg.id == null || !msg.method) return;
      void this.answer(msg.method, msg.params ?? {}).then(
        (result) => reply(msg.id, { result }),
        (e: Error & { code?: number }) =>
          reply(msg.id, { error: { code: e.code ?? -32603, message: e.message } }),
      );
    });
  }

  private async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-team", version: "1" },
        };
      // agy asks first and goes on to initialize when the answer is empty.
      case "server/discover":
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: (this.tools()?.tools ?? []).map((t) => {
            const { $schema: _, ...schema } = z.toJSONSchema(z.object(t.shape)) as Record<
              string,
              unknown
            >;
            return { name: t.name, description: t.description, inputSchema: forGemini(schema) };
          }),
        };
      case "tools/call":
        return this.call(params);
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  private async call(params: Record<string, unknown>) {
    const text = (t: string, isError = false) => {
      this.onAnswer?.(String(params.name), params.arguments, t, isError);
      return { content: [{ type: "text", text: t }], ...(isError && { isError: true }) };
    };
    const tool = this.tools()?.tools.find((t) => t.name === params.name);
    if (!tool) return text(`${String(params.name)} is not available to this session.`, true);
    const args = z.object(tool.shape).safeParse(params.arguments ?? {});
    if (!args.success) return text(z.prettifyError(args.error), true);
    try {
      return text(await tool.handler(args.data));
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true);
    }
  }
}
