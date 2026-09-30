// Fills a dev instance's data dir with a demo to try the UI on: a clone of
// this repository with worker worktrees, a project with its lead and worker
// sessions (history with tools, cards, delivered messages and file
// references), an objectives board with dependencies and an archive, and a
// workspace outside the project. No session is started: the agents are idle
// until someone writes to them. Never point it at the production data dir.
//
//   npm run demo -- .agent-team/dev-9801
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ProjectStore } from "../service/src/project/store";
import { ObjectiveStore, type Objective } from "../service/src/project/objectives";
import { saveIndex, saveWorkspace } from "../service/src/workspace/state";
import type {
  AgentState,
  Message,
  MessageOrigin,
  WorkspaceState,
} from "../service/src/workspace/workspace";
import type { StreamEvent } from "../service/src/session/claude";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: npm run demo -- <data dir of a dev instance>");
if (fs.existsSync(path.join(base, ".agent-team", "cache"))) {
  throw new Error(`${base} already has workspaces; seed an empty data dir`);
}

const demo = path.join(base, "demo");
const repo = path.join(demo, "agent-team");
const tree = (name: string) => path.join(demo, "agent-team-wt", name);
const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });

fs.mkdirSync(demo, { recursive: true });
git("clone", "--quiet", "--no-hardlinks", ROOT, repo);
for (const [name, branch] of [
  ["mobile-panels", "ui/mobile-panels"],
  ["wake-time", "fix/wake-time"],
  ["file-routes", "fix/file-routes"],
]) {
  git("-C", repo, "worktree", "add", "--quiet", "-b", branch, tree(name));
}
// Work in progress, for the changed-files count.
fs.appendFileSync(
  path.join(tree("mobile-panels"), "webview/src/styles.css"),
  "\n/* sheet header: 44px touch targets */\n",
);
fs.writeFileSync(
  path.join(tree("mobile-panels"), "NOTES.md"),
  "# Mobile panels\n\n- [ ] sheet header\n",
);

const now = Date.now();
const ago = (min: number) => now - min * 60_000;
let seq = 0;
const id = (p: string) => `${p}-${now.toString(36)}-${++seq}`;

const usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  turns: 0,
  duration_ms: 0,
};
const agent = (
  name: string,
  avatar: string,
  color: string,
  cwd: string,
  model = "claude-opus-5-5",
): AgentState => ({
  id: id("agent"),
  name,
  model,
  avatar,
  color,
  isDefault: true,
  session: { sessionId: null, config: { cwd, backend: "claude", model }, usage },
});

const user = (min: number, content: string, from?: MessageOrigin): Message => ({
  id: id("msg"),
  kind: "user",
  agentId: null,
  content,
  timestamp: ago(min),
  status: "done",
  ...(from && { from }),
});
const reply = (
  a: AgentState,
  min: number,
  content: string,
  events: StreamEvent[],
  tokens: number,
): Message => ({
  id: id("msg"),
  kind: "agent",
  agentId: a.id,
  content,
  timestamp: ago(min),
  status: "done",
  events,
  effort: "high",
  context: { tokens, window: 1_000_000 },
});
const system = (min: number, content: string): Message => ({
  id: id("msg"),
  kind: "system",
  agentId: null,
  content,
  timestamp: ago(min),
  status: "done",
});

let tool = 0;
const read = (file: string, result: string, step: number, at = 0): StreamEvent => ({
  kind: "tool_use",
  content: `**Read** \`${file}\``,
  toolName: "Read",
  toolUseId: `toolu_demo${++tool}`,
  toolResult: result,
  step,
  contentOffset: at,
});
const bash = (command: string, result: string, step: number, at = 0): StreamEvent => ({
  kind: "tool_use",
  content: `**Bash**\n\`\`\`bash\n${command}\n\`\`\``,
  toolName: "Bash",
  toolUseId: `toolu_demo${++tool}`,
  toolResult: result,
  step,
  contentOffset: at,
});
const edit = (file: string, from: string, to: string, step: number, at = 0): StreamEvent => ({
  kind: "tool_use",
  content: `**Edit** \`${file}\`\n\`\`\`diff\n${from
    .split("\n")
    .map((l) => `- ${l}`)
    .join("\n")}\n${to
    .split("\n")
    .map((l) => `+ ${l}`)
    .join("\n")}\n\`\`\``,
  toolName: "Edit",
  toolInput: { tool: "Edit", file_path: file, old_string: from, new_string: to },
  toolUseId: `toolu_demo${++tool}`,
  toolResult: `The file ${file} has been updated.`,
  step,
  contentOffset: at,
});
const thinking = (content: string, step: number, at = 0): StreamEvent => ({
  kind: "thinking",
  content,
  step,
  contentOffset: at,
  durationMs: 4200,
  tokens: 180,
});
const explore = (description: string, summary: string, at = 0): StreamEvent[] => {
  const toolUseId = `toolu_demo${++tool}`;
  const subagent = {
    taskId: `a${tool}demo`,
    description,
    prompt: `${description}. Report file paths with line numbers.`,
    agentType: "Explore",
    taskType: "local_agent",
  };
  return [
    {
      kind: "subagent_start",
      content: description,
      toolUseId,
      contentOffset: at,
      subagent: {
        ...subagent,
        status: "completed",
        summary,
        usage: { totalTokens: 41_200, toolUses: 14, durationMs: 48_000 },
      },
    },
    {
      kind: "subagent_done",
      content: summary,
      toolUseId,
      contentOffset: at,
      subagent: { taskId: subagent.taskId, description: "", status: "completed", summary },
    },
  ];
};

// The project and its sessions.
const store = new ProjectStore(base);
const project = store.create("agent-team", repo);
const origin = (ws: WorkspaceState, role: MessageOrigin["role"]): MessageOrigin => ({
  workspaceId: ws.id,
  name: ws.name,
  role,
  projectId: project.id,
});

const session = (
  name: string,
  cwd: string,
  a: AgentState,
  role: "lead" | "worker" | null,
  created: number,
): WorkspaceState => ({
  id: id("ws"),
  name,
  project: path.basename(repo),
  hostId: "local",
  cwd,
  agents: [a],
  messages: [],
  createdAt: ago(created),
  lastActivityAt: ago(created),
  archivedAt: null,
  ...(role && { projectLink: { projectId: project.id, role } }),
});

const leadAgent = agent("Lead", "avatars/Kisara.jpg", "#D8A0D8", repo);
const lead = session("agent-team · lead", repo, leadAgent, "lead", 300);
const mobileAgent = agent("Isla", "avatars/Isla.jpg", "#C0C0C0", tree("mobile-panels"));
const mobile = session("mobile panels", tree("mobile-panels"), mobileAgent, "worker", 90);
const wakeAgent = agent("Alice", "avatars/Alice.jpg", "#F0D264", tree("wake-time"));
const wake = session("wake-up time", tree("wake-time"), wakeAgent, "worker", 70);
const routesAgent = agent("Alice", "avatars/Alice.jpg", "#F0D264", tree("file-routes"));
const routes = session("file routes", tree("file-routes"), routesAgent, "worker", 200);
routes.archivedAt = ago(120);
project.leadWorkspaceId = lead.id;
store.save(project);

lead.messages = [
  system(300, "🤖 **Lead** joined the team"),
  user(
    95,
    "面板在大屏上太小了，手机上按钮也不好点。先把移动端的 sheet 做好，唤醒时间那个 bug 也顺手修掉。",
  ),
  reply(
    leadAgent,
    94,
    [
      "分成两件事，各开一个 worker：",
      "",
      "1. **mobile panels** — `webview/src/panels/SidePanel.tsx` 的 sheet 头部按钮只有 26px，" +
        "`webview/src/styles.css:3588` 的 body 内边距在手机上也偏小。worktree 在 `ui/mobile-panels`。",
      "2. **wake-up time** — CLI 把唤醒时间向上取整到整分钟，结果面板比实际早 30–90 秒。" +
        "见 `service/src/session/claude.ts:1461` 的 `noteSchedule`。",
      "",
      "看板上记为 `ui/mobile-panels`（依赖 `ui/side-panels`）和 `session/wake-time`。",
    ].join("\n"),
    [
      thinking("两个互不相关的改动，可以并行；移动端依赖已经完成的面板框架。", 1),
      read("webview/src/panels/SidePanel.tsx", "export function SidePanel({ … }) {\n  …\n}", 2),
      ...explore(
        "Find where the wake-up time is computed",
        "service/src/session/claude.ts:1461 noteSchedule: at = now + delaySeconds; the CLI's result says the real delay.",
      ),
      {
        kind: "tool_use",
        content: `**start_session** mobile panels in \`${tree("mobile-panels")}\`\n\n> Sheet header and Files toolbar: 44px touch targets.`,
        toolName: "mcp__panel__start_session",
        toolUseId: `toolu_demo${++tool}`,
        toolResult: `Started "mobile panels" (${mobile.id}) in ${tree("mobile-panels")}.`,
        step: 4,
        contentOffset: 0,
      },
      {
        kind: "tool_use",
        content: `**start_session** wake-up time in \`${tree("wake-time")}\`\n\n> Take the wake-up time from the CLI's result.`,
        toolName: "mcp__panel__start_session",
        toolUseId: `toolu_demo${++tool}`,
        toolResult: `Started "wake-up time" (${wake.id}) in ${tree("wake-time")}.`,
        step: 5,
        contentOffset: 0,
      },
    ],
    48_300,
  ),
  user(
    40,
    [
      "唤醒时间修好了：`service/src/session/claude.ts:1470-1476` 改成读 CLI 的 tool result（`in 93s`），" +
        "被拒绝的调用不再算作已安排。",
      "",
      "测试：`service/tests/unit/claude-session.test.ts`，snap `service/tests/snap/claude/wakeup-interrupt.snap.md` 两行时间变了，" +
        "和 CLI 自己说的 12:51 / 12:53 对得上。",
    ].join("\n"),
    origin(wake, "worker"),
  ),
  reply(
    leadAgent,
    39,
    "收到。已在看板把 `session/wake-time` 标为 done 并归档。改动在 worktree `fix/wake-time`，可以直接看 " +
      "[claude.ts](service/src/session/claude.ts:1461) 的 diff。",
    [
      {
        kind: "tool_use",
        content: "**update_objective** session/wake-time → done",
        toolName: "mcp__panel__update_objective",
        toolUseId: `toolu_demo${++tool}`,
        toolResult: "Updated.",
        step: 1,
        contentOffset: 0,
      },
    ],
    52_900,
  ),
  user(
    12,
    "进度：sheet 头部改到 44px，`webview/src/styles.css` 里加了 `--touch`。还差文件工具栏的按钮，预计半小时。",
    origin(mobile, "worker"),
  ),
];

mobile.messages = [
  system(90, "🤖 **Isla** joined the team"),
  user(
    89,
    [
      "目标 `ui/mobile-panels`：手机上的面板 sheet 要好点。",
      "",
      "- 头部按钮至少 44px 触控区",
      "- 文件工具栏按钮同样处理，路径保持可读",
      "- 完成后用 report_progress 汇报，附上改了哪些文件",
    ].join("\n"),
    origin(lead, "lead"),
  ),
  reply(
    mobileAgent,
    60,
    [
      "sheet 头部已经改好，截图对比过：",
      "",
      "| 元素 | 之前 | 之后 |",
      "| --- | --- | --- |",
      "| 关闭 / 固定按钮 | 26px | 44px |",
      "| 文件工具栏按钮 | 24px | 36px |",
      "| 目录行高 | 30px | 44px |",
      "",
      "改动在 `webview/src/styles.css` 和 `webview/src/panels/SidePanel.tsx:62`。测试：",
      "",
      "```bash",
      "npx vitest run tests/agents-panel.test.tsx tests/files-panel.test.tsx",
      "```",
    ].join("\n"),
    [
      read("webview/src/styles.css", "…", 1),
      edit(
        "webview/src/styles.css",
        ".side-panel-close {\n  width: 26px;\n  height: 26px;",
        ".side-panel-close {\n  width: var(--touch, 26px);\n  height: var(--touch, 26px);",
        2,
      ),
      bash(
        "npx vitest run tests/agents-panel.test.tsx tests/files-panel.test.tsx",
        " Test Files  2 passed (2)\n      Tests  31 passed (31)",
        3,
      ),
      {
        kind: "subagent_start",
        content: "npm run build",
        toolUseId: `toolu_demo${++tool}`,
        contentOffset: 0,
        subagent: {
          taskId: "bdemo1",
          description: "Build the bundle",
          prompt: "```bash\nnpm run build\n```",
          agentType: "shell",
          taskType: "local_bash",
          status: "completed",
          summary: 'Background command "Build the bundle" completed (exit code 0)',
        },
      },
    ],
    96_400,
  ),
];

wake.messages = [
  system(70, "🤖 **Alice** joined the team"),
  user(
    69,
    "目标 `session/wake-time`：唤醒时间用 CLI 的结果算，不要用请求的 delaySeconds。完成后 finish_task。",
    origin(lead, "lead"),
  ),
  reply(
    wakeAgent,
    41,
    "改好了，`noteSchedule` 现在读 tool result 里的 `(in 93s)`，读不到再退回 delaySeconds。见 `service/src/session/claude.ts:1461`。",
    [
      read("service/src/session/claude.ts", "…", 1),
      edit(
        "service/src/session/claude.ts",
        "const delay = Number(input.delaySeconds ?? 0);",
        "const delay = Number(/\\(in (\\d+)s\\)/.exec(result)?.[1] ?? input.delaySeconds ?? 0);",
        2,
      ),
      bash("npm test -w service", " Test Files  23 passed (23)\n      Tests  316 passed (316)", 3),
    ],
    61_800,
  ),
];

routes.messages = [
  system(200, "🤖 **Alice** joined the team"),
  user(199, "目标 `ui/file-routes`：/api/file 读不了的文件不能让进程退出。", origin(lead, "lead")),
  reply(
    routesAgent,
    150,
    "已修复并提交，见 `service/src/server/http.ts` 的 `sendRaw`。",
    [bash("npm test -w service", "Tests  316 passed (316)", 1)],
    40_100,
  ),
];

// A workspace of its own, outside the project.
const soloAgent = agent("Kisara", "avatars/Kisara.jpg", "#D8A0D8", ROOT);
const solo = session("agent-team", ROOT, soloAgent, null, 20);
solo.project = "agent-team";
solo.messages = [
  system(20, "🤖 **Kisara** joined the team"),
  user(18, "README 里的部署一节还准确吗？"),
  reply(
    soloAgent,
    17,
    [
      "基本准确，两处过时：",
      "",
      "- `README.md` 提到的 `npm run deploy` 已经换成 `scripts/deploy-deferred.sh`",
      "- 配置示例见 `config.example.toml`，`[auth]` 一节多了 `max_age_days`",
      "",
      "要我改吗？",
    ].join("\n"),
    [
      read("README.md", "# Agent Team\n…", 1),
      bash("grep -n deploy README.md", "88:npm run deploy", 2),
    ],
    22_700,
  ),
];

const all = [lead, mobile, wake, routes, solo];
for (const w of all) {
  w.lastActivityAt = Math.max(...w.messages!.map((m) => m.timestamp));
  saveWorkspace(base, w);
}
saveIndex(
  base,
  all.map((w) => w.id),
);

// The board.
const objectives = new ObjectiveStore(store.objectivesDir(project.id));
const objective = (
  o: Partial<Objective> & Pick<Objective, "id" | "title" | "goal">,
): Objective => ({
  area: o.id.split("/")[0],
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: now,
  ...o,
});
for (const o of [
  objective({
    id: "ui/side-panels",
    title: "Side panels beside the chat",
    goal: "Agents, background tasks and files in panels that float or pin, instead of the header.",
    status: "done",
    tasks: [
      { id: "rail", text: "Rail of panels, pin or float, width saved", state: "done" },
      { id: "agents", text: "Agents panel", state: "done" },
      { id: "tasks", text: "Background tasks panel with per-task stop", state: "done" },
      { id: "files", text: "Files panel, references in replies open it", state: "done" },
    ],
  }),
  objective({
    id: "ui/mobile-panels",
    title: "Panels on phones",
    goal: "The panels as full-screen sheets that are comfortable to use by touch.",
    priority: "high",
    dependsOn: ["ui/side-panels"],
    context: "Sheet header done (44px); the Files toolbar is next.",
    tasks: [
      {
        id: "header",
        text: "44px touch targets in the sheet header",
        state: "done",
        session: mobile.id,
      },
      {
        id: "toolbar",
        text: "Files toolbar buttons and folder rows",
        state: "doing",
        session: mobile.id,
      },
      { id: "landscape", text: "Phones held sideways", state: "todo" },
    ],
    sessions: [mobile.id],
    decisions: [{ id: "swipe", question: "Swipe down to close the sheet?" }],
  }),
  objective({
    id: "ui/panel-size",
    title: "Panels that use a big screen",
    goal: "On a wide or full-screen window a panel can take most of the room, e.g. to read code.",
    priority: "high",
    dependsOn: ["ui/side-panels"],
    tasks: [
      { id: "default", text: "Default width grows with the window", state: "todo" },
      { id: "max", text: "Maximise a panel over the chat", state: "todo" },
    ],
  }),
  objective({
    id: "session/wake-time",
    title: "Wake-ups at the CLI's time",
    goal: "The Tasks panel shows when a wake-up really fires.",
    status: "done",
    tasks: [
      { id: "parse", text: "Read the delay from the tool result", state: "done", session: wake.id },
    ],
    sessions: [wake.id],
    archived: true,
  }),
  objective({
    id: "ui/file-routes",
    title: "File routes that cannot crash the server",
    goal: "No file the panel opens can take the process down or block it.",
    status: "done",
    sessions: [routes.id],
    archived: true,
  }),
  objective({
    id: "ui/file-search",
    title: "Search in the Files panel",
    goal: "Find a file by name without walking folders.",
    status: "later",
    reason: "After the mobile work; ripgrep --files is fast enough, no index.",
    dependsOn: ["ui/side-panels"],
  }),
  objective({
    id: "infra/deploy-preview",
    title: "Preview deploys per branch",
    goal: "Try a worker's branch on its own port before merging.",
    priority: "low",
    dependsOn: ["ui/mobile-panels"],
    decisions: [{ id: "ports", question: "Fixed port range or ask the OS?" }],
  }),
  objective({
    id: "infra/windows",
    title: "Native Windows server",
    goal: "Run the server on Windows without WSL.",
    status: "dropped",
    reason: "WSL works well; not worth two code paths.",
  }),
]) {
  objectives.write(o);
}

console.log(`demo in ${base}: ${all.length} workspaces, project ${project.id}`);
