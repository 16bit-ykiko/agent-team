import type {
  Workspace,
  SystemStatus,
  AgentPreset,
  ModelOption,
  Objective,
  Project,
} from "../state/useServer";

const MOCK_AGENTS = [
  {
    id: "agent-1",
    name: "Coder",
    model: "claude-fable-5-1",
    avatar: "🧑‍💻",
    color: "#528bff",
    isDefault: true,
  },
  {
    id: "agent-2",
    name: "Reviewer",
    model: "claude-opus-5-5",
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
    git: { branch: "feat/new-feature", dirty: 0, ahead: 0, behind: 0 },
    pr: null,
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
    git: { branch: "main", dirty: 0, ahead: 0, behind: 0 },
    pr: null,
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
  { id: "claude-opus-5-5", label: "Opus 5.5", backend: "claude" },
  { id: "claude-fable-5-1", label: "Fable 5.1", backend: "claude" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", backend: "codex" },
];

// A project shaped like a real board (clice's objectives), for ?mock.
const HOUR = 3600_000;
const obj = (id: string, over: Partial<Objective>): Objective => ({
  id,
  area: id.split("/")[0],
  title: id,
  goal: "",
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: Date.now() - 5 * HOUR,
  ...over,
});

export const MOCK_PROJECTS: Project[] = [
  {
    id: "proj-mock",
    name: "clice",
    root: "/home/user/projects/clice",
    leadWorkspaceId: "ws-mock-lead",
    createdAt: Date.now() - 30 * 24 * HOUR,
    objectives: [
      obj("foundation/identity", {
        title: "声明身份",
        goal: "entity + content 闭包替换 USR：索引键、query 稳定 ID、doc 提取、modulize 分析与 lint ODR 检查的地基。",
        priority: "high",
        context: "实现方案已定稿；**entity hash** 已合入，content 闭包在做。",
        tasks: [
          { id: "t1", text: "entity hash 与序列化", state: "done" },
          { id: "t2", text: "content 闭包计算", state: "doing", session: "ws-mock-w1" },
          { id: "t3", text: "索引键切换到新身份", state: "todo" },
          { id: "t4", text: "保留 USR 兼容路径", state: "dropped" },
        ],
        decisions: [
          { id: "d1", question: "hash 宽度？", outcome: "64 位，冲突按 content 二次比较" },
          { id: "d2", question: "模板特化是否单独成 entity？" },
        ],
        sessions: ["ws-mock-w1"],
        updatedAt: Date.now() - HOUR,
      }),
      obj("foundation/canonical-path", {
        title: "路径模型",
        goal: "身份问操作系统、拼写保留 `..`、显示名规则；路径无关表示待拍板。",
        status: "done",
      }),
      obj("foundation/index-access", {
        title: "索引访问模型",
        goal: "只读命令直接读磁盘、写者唯一、live 只问 server。",
        dependsOn: ["foundation/canonical-path"],
        tasks: [
          { id: "t1", text: "代跑调度", state: "todo" },
          { id: "t2", text: "失败状态落盘", state: "todo" },
        ],
        decisions: [{ id: "d1", question: "远程 FS 怎么处理？" }],
      }),
      obj("index/name-ranges", {
        title: "多 token 名的范围",
        goal: "析构名、operator 名等多 token 名的范围表示；rename 的前置。",
        dependsOn: ["foundation/identity"],
        tasks: [{ id: "t1", text: "范围表示与存储格式", state: "todo" }],
        decisions: [{ id: "d1", question: "存范围还是按需重算？" }],
      }),
      obj("index/declaration-records", {
        title: "结构化声明记录",
        goal: "doc、query API 摘要、只读 hover 共用的声明记录进索引。",
        dependsOn: ["foundation/identity"],
        status: "later",
        reason: "等 identity 落地后再设计，先不排。",
      }),
      obj("cli/refactor", {
        title: "全项目 rename",
        goal: "跨 TU rename 与 include-cleaner，编辑器 rename 与 code action 共用引擎。",
        priority: "high",
        dependsOn: ["index/name-ranges", "foundation/identity", "cli/edits"],
        tasks: [
          { id: "t1", text: "新鲜度检查", state: "todo" },
          { id: "t2", text: "冲突与 dirty 处理", state: "todo" },
        ],
      }),
      obj("cli/edits", {
        title: "全项目改写的应用",
        goal: "去重、冲突、原子落盘、diff/apply、不动点。",
        dependsOn: ["foundation/fixit-pipeline"],
        tasks: [
          { id: "t1", text: "原子落盘", state: "review", session: "ws-mock-w2" },
          { id: "t2", text: "diff / apply 输出", state: "done" },
        ],
        sessions: ["ws-mock-w2"],
      }),
      obj("foundation/fixit-pipeline", {
        title: "FixIt 管线",
        goal: "FixIt 经 worker 协议带回：编辑器 quickfix-lite，批处理 lint fix 的输入。",
        status: "done",
      }),
      obj("cli/lint", {
        title: "全项目 lint",
        goal: "clang-tidy 按 TU 缓存作兼容后端 + 项目级 check；增量、fix、与编辑器共用。",
        dependsOn: ["foundation/identity", "cli/edits"],
        decisions: [
          { id: "d1", question: "PCH 与 traversal-scope 截断是否一起上？" },
          { id: "d2", question: "默认开哪些 check？" },
        ],
      }),
      obj("infra/lto", {
        title: "PGO + ThinLTO",
        goal: "前端 PGO + 映射文件，Linux x64 训一份。",
        status: "later",
        priority: "low",
        reason: "等 LLVM 23 自托管稳定。",
      }),
      obj("infra/mingw", {
        title: "mingw 工具链线",
        goal: "Windows mingw 构建。",
        status: "dropped",
        reason: "维护成本高，只保留 MSVC 线。",
      }),
    ],
  },
];

export const MOCK_PROJECT_WORKSPACES: Workspace[] = [
  {
    ...MOCK_WORKSPACES[0],
    id: "ws-mock-lead",
    name: "clice · lead",
    cwd: "/home/user/projects/clice",
    projectLink: { projectId: "proj-mock", role: "lead" },
    messages: [],
    messagesLoaded: true,
  },
  {
    ...MOCK_WORKSPACES[0],
    id: "ws-mock-w1",
    name: "identity: content 闭包",
    cwd: "/home/user/projects/clice-identity",
    projectLink: { projectId: "proj-mock", role: "worker" },
    agents: [{ ...MOCK_AGENTS[0], busy: true }],
    messages: [],
    messagesLoaded: true,
  },
  {
    ...MOCK_WORKSPACES[0],
    id: "ws-mock-w2",
    name: "edits: 原子落盘",
    cwd: "/home/user/projects/clice-edits",
    projectLink: { projectId: "proj-mock", role: "worker" },
    agents: [
      {
        ...MOCK_AGENTS[0],
        state: "waiting",
        backgroundTasks: [
          {
            id: "bmock1",
            type: "local_bash",
            description: "pixi run test -- --filter edits",
            since: Date.now() - 4 * 60_000,
          },
          {
            id: "amock1",
            type: "local_agent",
            description: "Audit write paths for torn renames",
            since: Date.now() - 50_000,
          },
        ],
      },
      {
        ...MOCK_AGENTS[1],
        state: "sleeping",
        wake: { at: Date.now() + 18 * 60_000, reason: "check the CI run on #712" },
      },
    ],
    messages: [],
    messagesLoaded: true,
  },
];
