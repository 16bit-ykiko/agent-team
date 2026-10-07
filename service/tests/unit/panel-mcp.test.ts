// The panel tools through the real SDK's createSdkMcpServer (in-process, no
// CLI): the schemas and the argument validation the CLI sees.
import { describe, it, expect } from "vitest";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { leadToolset, type PanelApi } from "../../src/project/tools";

type Handler = (req: unknown, extra: unknown) => Promise<Record<string, unknown>>;

describe("panel tools via createSdkMcpServer", () => {
  const calls: unknown[][] = [];
  const api = new Proxy({} as PanelApi, {
    get:
      (_t, name) =>
      (...a: unknown[]) => {
        calls.push([name, ...a]);
        return "ok";
      },
  });
  const set = leadToolset(
    api,
    { id: "p1", name: "x", root: "/r", leadWorkspaceId: null, createdAt: 0 },
    "/n",
    ["m"],
  );
  const server = createSdkMcpServer({
    name: "panel",
    instructions: set.instructions,
    alwaysLoad: true,
    tools: set.tools.map((t) =>
      tool(t.name, t.description, t.shape, async (args: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: await t.handler(args) }],
      })),
    ),
  });
  const handlers = (
    server.instance as unknown as { server: { _requestHandlers: Map<string, Handler> } }
  ).server._requestHandlers;
  const extra = { signal: new AbortController().signal, requestId: 1, sendNotification: () => {} };

  it("lists schemas", async () => {
    const res = await handlers.get("tools/list")!(
      { method: "tools/list", params: {}, jsonrpc: "2.0", id: 1 },
      extra,
    );
    const tools = res.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    console.log(JSON.stringify(byName.read_session), JSON.stringify(byName.update_objective));
    expect(Object.keys(byName)).toContain("start_session");
  });

  it("calls a tool with validated args", async () => {
    const res = await handlers.get("tools/call")!(
      {
        method: "tools/call",
        params: { name: "read_session", arguments: { session_id: "ws-1", last: 3 } },
        jsonrpc: "2.0",
        id: 2,
      },
      extra,
    );
    console.log(JSON.stringify(res), JSON.stringify(calls));
    expect(calls).toContainEqual(["readSession", "p1", "ws-1", 3, undefined, false, false]);
  });

  it("passes write_issues its patches, and refuses a misspelt field in one", async () => {
    const call = (issues: unknown[], id: number) =>
      handlers.get("tools/call")!(
        {
          method: "tools/call",
          params: { name: "write_issues", arguments: { issues } },
          jsonrpc: "2.0",
          id,
        },
        extra,
      );
    await call([{ id: "a#1", evidence: "", group: "", tags: ["低"], module: "" }], 3);
    expect(calls).toContainEqual([
      "writeIssues",
      "p1",
      [{ id: "a#1", evidence: "", group: "", tags: ["低"] }],
    ]);
    const before = calls.length;
    const res = await call([{ id: "a#1", evidance: "R" }], 4);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(before);
  });
});
