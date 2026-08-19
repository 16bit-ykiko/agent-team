import type { Workspace, SystemStatus, AgentPreset, ModelOption } from "./useServer";

const MOCK_AGENTS = [
  {
    id: "agent-1",
    name: "Coder",
    model: "claude-sonnet-4-6",
    avatar: "🧑‍💻",
    color: "#528bff",
    isDefault: true,
  },
  {
    id: "agent-2",
    name: "Reviewer",
    model: "claude-opus-4-6",
    avatar: "🔍",
    color: "#e5c07b",
    isDefault: false,
  },
];

export const MOCK_WORKSPACES: Workspace[] = [
  {
    id: "ws-mock-1",
    name: "Demo Workspace",
    project: "my-project",
    hostId: "local",
    cwd: "/home/user/projects/my-project",
    gitBranch: "feat/new-feature",
    prUrl: null,
    prTitle: null,
    agents: MOCK_AGENTS,
    messages: [
      {
        id: "msg-1",
        kind: "system",
        agentId: null,
        content: "🧑‍💻 **Coder** joined the team",
        timestamp: Date.now() - 60000,
        status: "done",
      },
      {
        id: "msg-2",
        kind: "user",
        agentId: null,
        content: "@Coder fix the login bug in auth.ts",
        timestamp: Date.now() - 50000,
        status: "done",
      },
      {
        id: "msg-3",
        kind: "agent",
        agentId: "agent-1",
        content: "Let me look at the auth code to find the bug.",
        timestamp: Date.now() - 48000,
        status: "done",
        turnId: "turn-1",
        events: [
          {
            kind: "thinking",
            content:
              "The user wants me to fix a login bug. Let me:\n\n1. First read `auth.ts` to understand the current code\n2. Identify the issue\n3. Apply the fix\n\nI suspect the issue might be related to **token validation** or **session handling**.",
          },
          {
            kind: "tool_use",
            content: "**Read** `src/auth.ts`",
          },
          {
            kind: "tool_result",
            content:
              "import jwt from 'jsonwebtoken';\n\nfunction validateToken(token: string): boolean {\n  const decoded = jwt.decode(token);\n  const now = Date.now(); // BUG: milliseconds vs seconds\n  return decoded.exp > now;\n}",
          },
        ],
      },
      {
        id: "msg-3b",
        kind: "agent",
        agentId: "agent-1",
        content:
          "Found it — `Date.now()` returns milliseconds but JWT `exp` is in seconds. Fixing now.",
        timestamp: Date.now() - 45000,
        status: "done",
        turnId: "turn-1",
        events: [
          {
            kind: "tool_use",
            content: "**Edit** `src/auth.ts`",
          },
          {
            kind: "tool_result",
            content: "File edited successfully.",
          },
        ],
      },
      {
        id: "msg-3c",
        kind: "agent",
        agentId: "agent-1",
        content:
          "I found the issue in the `validateToken` function. The token expiry check was comparing timestamps in different units (seconds vs milliseconds). Here's the fix:\n\n```typescript\nfunction validateToken(token: string): boolean {\n  const decoded = jwt.decode(token);\n  const now = Math.floor(Date.now() / 1000); // seconds\n  return decoded.exp > now;\n}\n```\n\nAll tests pass.",
        timestamp: Date.now() - 42000,
        status: "done",
        turnId: "turn-1",
        events: [
          {
            kind: "tool_use",
            content: "**Bash**\n```bash\nnpm test -- --filter auth\n```",
          },
          {
            kind: "tool_result",
            content:
              "PASS src/auth.test.ts\n  ✓ validates valid token (3ms)\n  ✓ rejects expired token (1ms)\n  ✓ handles malformed token (2ms)\n\nTest Suites: 1 passed, 1 total\nTests:       3 passed, 3 total",
          },
        ],
      },
      {
        id: "msg-4",
        kind: "user",
        agentId: null,
        content: "Can you also check the error handling?",
        timestamp: Date.now() - 30000,
        status: "done",
      },
      {
        id: "msg-5",
        kind: "agent",
        agentId: "agent-1",
        content: "",
        timestamp: Date.now() - 25000,
        status: "streaming",
        turnId: "turn-2",
        events: [
          {
            kind: "thinking",
            content: "Let me check the error handling paths in the auth module...",
          },
          {
            kind: "tool_use",
            content: "**Grep** `catch` in `src/auth.ts`",
          },
        ],
      },
    ],
    createdAt: Date.now() - 120000,
  },
  {
    id: "ws-mock-2",
    name: "Refactor Task",
    project: "api-server",
    hostId: "local",
    cwd: "/home/user/projects/api-server",
    gitBranch: "main",
    prUrl: null,
    prTitle: null,
    agents: [],
    messages: [],
    createdAt: Date.now() - 300000,
  },
];

export const MOCK_SYSTEM_STATUS: SystemStatus = {
  osName: "Linux 6.6.87-microsoft-WSL2",
  osArch: "x64",
  cpuModel: "AMD Ryzen 9 7950X",
  cpuCores: 32,
  cpuUsage: 23,
  memTotal: 34359738368,
  memUsed: 18253611008,
  uptime: 86400 + 3600 * 3 + 60 * 42,
  hostname: "dev-machine",
  quota: [],
};

export const MOCK_PRESETS: AgentPreset[] = [
  { name: "Coder", avatar: "🧑‍💻", color: "#528bff" },
  { name: "Reviewer", avatar: "🔍", color: "#e5c07b" },
  { name: "Architect", avatar: "🏗️", color: "#c678dd" },
];

export const MOCK_MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", backend: "claude" },
  { id: "claude-opus-4-6", label: "Opus 4.6", backend: "claude" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", backend: "codex" },
];
