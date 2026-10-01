import { z } from "zod";
import { ENTRY_KINDS, type EntryKind } from "../workspace/history-index";
import type { Project } from "./store";
import {
  OBJECTIVE_STATUSES,
  PRIORITIES,
  TASK_STATES,
  type ObjectiveStatus,
  type Priority,
  type TaskState,
} from "./objectives";

// Tools the panel gives its agents, served in-process to the Claude CLI as
// the "panel" MCP server (see ClaudeSession.setPanelTools). A project's lead
// runs sessions, keeps the objectives and talks to other projects' leads; a
// worker session it started reports back to it.

export interface PanelTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface PanelToolset {
  instructions: string;
  tools: PanelTool[];
}

export interface StartSessionArgs {
  title: string;
  cwd: string;
  task: string;
  model?: string;
  objectiveId?: string;
  taskId?: string;
}

// Fields to set on an objective; given lists replace the old ones.
export interface ObjectivePatch {
  id: string;
  title?: string;
  goal?: string;
  status?: ObjectiveStatus;
  priority?: Priority;
  reason?: string;
  context?: string;
  dependsOn?: string[];
  notes?: string;
}

// A task's text and state, or a decision's question and outcome ("" reopens).
export interface ItemPatch {
  text?: string;
  state?: TaskState;
  outcome?: string;
}

// What the tools do, implemented by the ProjectManager. Errors are thrown
// and reach the model as the tool's error result.
// The calls with an effect elsewhere, which the client shows as lines of
// their own in a reply (webview chat/events.ts, kept alike by a test):
// summary pages keep their text and answer.
export const PANEL_ACTIONS: ReadonlySet<string> = new Set([
  "start_session",
  "message_session",
  "message_project",
  "stop_session",
  "archive_session",
  "report_progress",
  "finish_task",
]);

export interface HistorySearch {
  query?: string;
  regex?: string;
  in?: EntryKind[];
  tool?: string;
  call?: string;
  folder?: string;
  session?: string;
  message?: string;
  since?: number;
  until?: number;
  level?: "main" | "subagents";
  caseSensitive?: boolean;
  everywhere: boolean;
  limit: number;
  offset: number;
  lines?: number;
  context?: number;
}

export interface PanelApi {
  projectStatus(projectId: string): Promise<string>;
  startSession(projectId: string, args: StartSessionArgs): string;
  readSession(
    projectId: string,
    sessionId: string,
    count: number,
    around?: string,
    tools?: boolean,
    start?: boolean,
  ): Promise<string>;
  listHistory(projectId: string, everywhere: boolean, limit: number): Promise<string>;
  searchHistory(projectId: string, search: HistorySearch): Promise<string>;
  readEntry(
    projectId: string,
    entry: number,
    from: number,
    count: number,
    fromChar: number,
  ): Promise<string>;
  queryHistory(projectId: string, query: string): Promise<string>;
  messageSession(projectId: string, sessionId: string, text: string): string;
  stopSession(projectId: string, sessionId: string): string;
  archiveSession(projectId: string, sessionId: string): string;
  listObjectives(
    projectId: string,
    filter: { area?: string; status?: string; archived?: boolean },
  ): string;
  readObjective(projectId: string, id: string): string;
  writeObjective(projectId: string, patch: ObjectivePatch): string;
  addItems(projectId: string, objectiveId: string, tasks: string[], decisions: string[]): string;
  updateItem(projectId: string, objectiveId: string, itemId: string, patch: ItemPatch): string;
  deleteObjective(projectId: string, id: string): string;
  archiveObjective(projectId: string, id: string): string;
  restoreObjective(projectId: string, id: string): string;
  listProjects(projectId: string): string;
  messageProject(projectId: string, targetId: string, text: string): string;
  workerReport(workspaceId: string, text: string, final: boolean, blocked?: boolean): string;
  currentTask(workspaceId: string, objectiveId?: string): string;
}

const run = (fn: () => string | Promise<string>) => new Promise<string>((ok) => ok(fn()));

// UTC unless the time says otherwise, as the history prints them.
function time(name: string, value: string): number {
  const t = Date.parse(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(value) ? `${value}Z` : value);
  if (Number.isNaN(t)) throw new Error(`${name}: not a date or time: ${value}`);
  return t;
}

export function leadToolset(
  api: PanelApi,
  project: Project,
  notesDir: string,
  models: string[],
): PanelToolset {
  const id = project.id;
  return {
    instructions: [
      `You are the lead agent of the project "${project.name}" (repository ${project.root}).`,
      "You discuss ideas with the user and keep the whole project in view. When the user decides to start a piece of work, hand it to a worker session with start_session: a separate Claude session, running in the folder you choose (the repository, or a git worktree of it you create with git), that the user can also open and talk to. Give it a complete, self-contained task. Start work only when the user asks for it.",
      [
        "Worker sessions report back; their messages reach you prefixed [From session …]: progress, finished (its tasks on the board move to review) or blocked on a decision. Take a finished report as you would a subagent's result: when it shows the work is done, mark the tasks done (dropped, with the reason, when the user called the work off) and tell the user in a sentence; read the session (read_session) or the changes only when something in it is unclear or risky. Send work back only for a concrete gap, saying exactly what is missing, not for polish. What is the user's to decide goes to the user: when a worker is blocked, answer what the user has already decided and ask the user the rest.",
        "When a worker goes idle after your message without calling finish_task, you are told so, prefixed [From the panel, about session …], with how its turn ended and its last reply: often just its answer to you. Take that reply as its report: act on it when there is something to do, or ask the user what is theirs to decide, as for a blocked worker; it needs no answer otherwise, and do not message the worker only to ask for a report. Retry a failed turn once at most; if it fails again, tell the user. A turn a server restart cut off is no failure: tell the worker to carry on. A stop by the user is their call: do not restart that work unasked.",
        "The user can open any worker and talk to it directly; leave those conversations to them. Steer workers with message_session. When a worker's worktree is about to be removed, archive its session with archive_session.",
      ].join(" "),
      [
        "The objectives are the project's board and memory, one per piece of work, with an id area/name (for example index/name-ranges). Each says what it is for (goal), where things stand (context), what must come first (depends_on: other objective ids), its tasks and the decisions still to settle.",
        "Record what the user decides as you talk, including in passing: status later for what is put off, dropped with the reason for what will not be done (so it is not reopened), priority high/normal/low, and the reason for either. Tasks move todo → doing → review → done (or dropped); settle a decision by giving its outcome.",
        "Change them only through write_objective, add_items and update_item; list_objectives gives the board, read_objective one objective in full. When an objective is done or dropped for good, archive_objective files it away. The user sees the board as a dependency view: keep depends_on accurate.",
      ].join(" "),
      `Longer-lived notes (decisions, background, plans) go in markdown files under ${notesDir}; read and write them with your file tools. Subagents can maintain them too.`,
      "Other projects have leads of their own: list_projects shows them, message_project sends one a message without waiting. Its answer arrives later as a message from that project.",
      "project_status gives the board, the running sessions and the repository's worktrees at a glance.",
      "Everything said and done here is recorded: your own conversation, the worker sessions', and the project's history (archived sessions, from before the project too) — what was said, thinking, every tool call with its input and its output, errors, and what subagents did. When the user refers to past work, search_history finds it like grep would (words or a regular expression; by kind, tool, session, message, time; with context lines), read_entry reads a hit in full or by lines (a whole command output, a file that was read), and read_session reads a session in context, with its tool calls when you ask. query_history runs read-only SQL over the same records for what search cannot express (counts, grouping, one tool's calls across sessions). list_history lists the earlier sessions.",
    ].join("\n\n"),
    tools: [
      {
        name: "project_status",
        description:
          "The project at a glance: its worktrees (branch, uncommitted changes), the worker sessions (state, last reply) and the objectives board.",
        shape: {},
        handler: () => run(() => api.projectStatus(id)),
      },
      {
        name: "start_session",
        description: `Start a worker session: a new Claude session in \`cwd\` (absolute, or relative to the repository root) that receives \`task\` as its first message. Returns its session id. Models: ${models.join(", ")}.`,
        shape: {
          title: z.string().describe("Short title shown in the panel"),
          cwd: z.string().describe("Folder the session works in (repository or a worktree)"),
          task: z.string().describe("The complete task description sent as the first message"),
          model: z
            .string()
            .optional()
            .describe(
              `Model id; defaults to ${models[0]}. Another only when the user asked for it`,
            ),
          objective_id: z.string().optional().describe("Objective this session works on"),
          task_id: z.string().optional().describe("Its task this session carries out"),
        },
        handler: (a) =>
          run(() =>
            api.startSession(id, {
              title: String(a.title),
              cwd: String(a.cwd),
              task: String(a.task),
              ...(typeof a.model === "string" && { model: a.model }),
              ...(typeof a.objective_id === "string" && { objectiveId: a.objective_id }),
              ...(typeof a.task_id === "string" && { taskId: a.task_id }),
            }),
          ),
      },
      {
        name: "read_session",
        description:
          "Messages of a session (a worker's latest, and whether it is working; yours; or an earlier one from the history): the last ones, the first ones, or those around a message id (a search hit in context). With tools, each message's tool calls and outputs are listed by entry (read_entry reads one).",
        shape: {
          session_id: z.string(),
          last: z.number().int().min(1).max(50).optional().describe("How many messages (6)"),
          start: z.boolean().optional().describe("From the first message instead of the last"),
          around: z.string().optional().describe("A message id: the messages around it"),
          tools: z.boolean().optional().describe("List each message's tool calls by entry"),
        },
        handler: (a) =>
          run(() =>
            api.readSession(
              id,
              String(a.session_id),
              Number(a.last ?? 6),
              typeof a.around === "string" ? a.around : undefined,
              a.tools === true,
              a.start === true,
            ),
          ),
      },
      {
        name: "list_history",
        description:
          "Earlier sessions in this repository (archived, from before the project or since): id, folder, dates.",
        shape: {
          everywhere: z.boolean().optional().describe("Every archived session, in any folder"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("How many, newest first (30)"),
        },
        handler: (a) =>
          run(() => api.listHistory(id, a.everywhere === true, Number(a.limit ?? 30))),
      },
      {
        name: "search_history",
        description:
          "Search the recorded sessions of this project (yours, the workers', the history), newest first, like grep: a hit is one entry (something said, a thinking block, a tool call, a tool's output, an error, a subagent's task) with its matching lines numbered, and the ids for read_entry and read_session. By default only what was said is searched; when that finds nothing, the answer says which other kinds would match. Without words or a pattern it lists entries (every Bash call of a session, say).",
        shape: {
          query: z
            .string()
            .optional()
            .describe(
              'Words that must all be in the entry: substrings in any case (a path, an identifier, Chinese); "a quoted phrase" keeps its spaces.',
            ),
          regex: z
            .string()
            .optional()
            .describe(
              "A JavaScript regular expression the entry must match, in any case unless case_sensitive; ^ and $ match at lines",
            ),
          in: z
            .array(z.enum(ENTRY_KINDS as [EntryKind, ...EntryKind[]]))
            .optional()
            .describe(
              "Kinds of entry: said (what the user, agents and subagents wrote), thinking, tool_call (a tool's input: the command, the path, the edit), tool_output (what it returned; a failed command's output often starts with \"Exit code\"), error (the session itself failing), subagent (a subagent's task and summary). Default said; with tool, tool_call and tool_output; with call, tool_output.",
            ),
          tool: z
            .string()
            .optional()
            .describe(
              "Only this tool's calls and output: Bash, Read, Edit, Write, Grep, Agent, …; an MCP tool by its own name (start_session)",
            ),
          call: z
            .string()
            .optional()
            .describe(
              "Only the output of calls holding this text: the command (ctest, ninja), the path",
            ),
          folder: z
            .string()
            .optional()
            .describe(
              "Only sessions working in this folder or below (absolute, or in the repository)",
            ),
          session: z.string().optional().describe("Only this session"),
          message: z.string().optional().describe("Only this message of it"),
          since: z
            .string()
            .optional()
            .describe(
              "From this date or time (ISO, UTC unless it gives a zone); an entry has its message's start time",
            ),
          until: z.string().optional().describe("Before this date or time"),
          level: z
            .enum(["main", "subagents"])
            .optional()
            .describe("Only the sessions' own turns, or only what their subagents did"),
          lines: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Matching lines shown per hit (3)"),
          context: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe("Lines shown before and after each matching line (0)"),
          case_sensitive: z.boolean().optional(),
          everywhere: z.boolean().optional().describe("Every archived session, in any folder"),
          limit: z.number().int().min(1).max(100).optional().describe("How many hits (20)"),
          offset: z.number().int().min(0).optional().describe("Hits to skip, to page (0)"),
        },
        handler: (a) =>
          run(() =>
            api.searchHistory(id, {
              ...(typeof a.query === "string" && { query: a.query }),
              ...(typeof a.regex === "string" && { regex: a.regex }),
              ...(Array.isArray(a.in) && a.in.length > 0 && { in: a.in as EntryKind[] }),
              ...(typeof a.tool === "string" && { tool: a.tool }),
              ...(typeof a.call === "string" && { call: a.call }),
              ...(typeof a.folder === "string" && { folder: a.folder }),
              ...(typeof a.session === "string" && { session: a.session }),
              ...(typeof a.message === "string" && { message: a.message }),
              ...(typeof a.since === "string" && { since: time("since", a.since) }),
              ...(typeof a.until === "string" && { until: time("until", a.until) }),
              ...((a.level === "main" || a.level === "subagents") && { level: a.level }),
              ...(typeof a.lines === "number" && { lines: a.lines }),
              ...(typeof a.context === "number" && { context: a.context }),
              caseSensitive: a.case_sensitive === true,
              everywhere: a.everywhere === true,
              limit: Number(a.limit ?? 20),
              offset: Number(a.offset ?? 0),
            }),
          ),
      },
      {
        name: "read_entry",
        description:
          "Read an entry found by search_history or read_session in full, or some of its lines: a whole command output, a file a tool read, a long message. A very long line is cut; from_char reads on from where it was cut.",
        shape: {
          entry: z.number().int().describe("The entry's number (#123)"),
          from_line: z.number().int().min(1).optional().describe("First line (1)"),
          lines: z.number().int().min(1).max(2000).optional().describe("How many lines (200)"),
          from_char: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Where the first line starts, in characters (0)"),
        },
        handler: (a) =>
          run(() =>
            api.readEntry(
              id,
              Number(a.entry),
              Number(a.from_line ?? 1),
              Number(a.lines ?? 200),
              Number(a.from_char ?? 0),
            ),
          ),
      },
      {
        name: "query_history",
        description: [
          "One read-only SQL statement (SQLite) over the sessions search_history reaches with everywhere, for what search cannot express: counts, grouping, one tool's use across sessions. At most 200 rows; long cells are cut (read_entry reads an entry in full).",
          "Tables: sessions(id, name, cwd, project, role, created_at, last_active, archived_at); entries(id, session, message, ts, kind, role, tool, depth, lines, call, text) — kind as in search_history, depth 0 in the session itself and more inside subagents, lines its line count, call a tool_output's tool_call entry id; messages(session, id, seq, ts, kind, status, hash, body) — body is the message as JSON (json_extract(body, '$.model')).",
          "entries_fts is a trigram index of entries.text (its rowid is entries.id), for words of 3 characters or more: `entries.id in (select rowid from entries_fts where entries_fts match '\"words\"')`; shorter ones with instr(text, 'x'). regexp(pattern, text) and iregexp (any case) match JavaScript regular expressions. Times are milliseconds since the epoch.",
          "For example: select s.name, count(*) as n from entries e join sessions s on s.id = e.session where e.tool = 'Bash' group by s.name order by n desc.",
        ].join(" "),
        shape: { sql: z.string() },
        handler: (a) => run(() => api.queryHistory(id, String(a.sql))),
      },
      {
        name: "message_session",
        description:
          "Send a message to a worker session (queued if it is busy). It shows as coming from you. Its answer comes back as its report or, when it just replies, as a notice from the panel with that reply.",
        shape: { session_id: z.string(), message: z.string() },
        handler: (a) => run(() => api.messageSession(id, String(a.session_id), String(a.message))),
      },
      {
        name: "stop_session",
        description:
          "Stop what a worker session is doing right now and drop your messages still queued for it.",
        shape: { session_id: z.string() },
        handler: (a) => run(() => api.stopSession(id, String(a.session_id))),
      },
      {
        name: "archive_session",
        description:
          "Archive an idle worker session: it leaves the active list, its history stays readable and a new message restores it.",
        shape: { session_id: z.string() },
        handler: (a) => run(() => api.archiveSession(id, String(a.session_id))),
      },
      {
        name: "list_objectives",
        description:
          "The objectives by area: status, priority, task progress, open decisions and what blocks each. Filter by area or status; archived lists the archive instead.",
        shape: {
          area: z.string().optional(),
          status: z.enum(OBJECTIVE_STATUSES).optional(),
          archived: z.boolean().optional(),
        },
        handler: (a) =>
          run(() =>
            api.listObjectives(id, {
              ...(typeof a.area === "string" && { area: a.area }),
              ...(typeof a.status === "string" && { status: a.status }),
              ...(a.archived === true && { archived: true }),
            }),
          ),
      },
      {
        name: "read_objective",
        description:
          "One objective in full: goal, context, tasks, decisions, notes, what it depends on and what depends on it.",
        shape: { id: z.string() },
        handler: (a) => run(() => api.readObjective(id, String(a.id))),
      },
      {
        name: "write_objective",
        description:
          "Create an objective (title and goal required) or change one. Only the fields given change: depends_on replaces the whole list, an empty string clears reason, context or notes, and a new status or priority given without a reason clears the old reason.",
        shape: {
          id: z.string().describe("area/name, lowercase letters, digits and -"),
          title: z.string().optional(),
          goal: z.string().optional().describe("What it is for, in a sentence or two"),
          status: z.enum(OBJECTIVE_STATUSES).optional(),
          priority: z.enum(PRIORITIES).optional(),
          reason: z.string().optional().describe("Why it is put off, dropped or prioritised so"),
          context: z.string().optional().describe("Where things stand (markdown)"),
          depends_on: z.array(z.string()).optional().describe("Objective ids that must come first"),
          notes: z.string().optional().describe("Background, history, links (markdown)"),
        },
        handler: (a) =>
          run(() =>
            api.writeObjective(id, {
              id: String(a.id),
              ...(typeof a.title === "string" && { title: a.title }),
              ...(typeof a.goal === "string" && { goal: a.goal }),
              ...(typeof a.status === "string" && { status: a.status as ObjectiveStatus }),
              ...(typeof a.priority === "string" && { priority: a.priority as Priority }),
              ...(typeof a.reason === "string" && { reason: a.reason }),
              ...(typeof a.context === "string" && { context: a.context }),
              ...(Array.isArray(a.depends_on) && { dependsOn: a.depends_on.map(String) }),
              ...(typeof a.notes === "string" && { notes: a.notes }),
            }),
          ),
      },
      {
        name: "add_items",
        description: "Add tasks and decisions to settle to an objective. Returns their ids.",
        shape: {
          objective_id: z.string(),
          tasks: z.array(z.string()).optional(),
          decisions: z.array(z.string()).optional().describe("Questions to settle"),
        },
        handler: (a) =>
          run(() =>
            api.addItems(
              id,
              String(a.objective_id),
              Array.isArray(a.tasks) ? a.tasks.map(String) : [],
              Array.isArray(a.decisions) ? a.decisions.map(String) : [],
            ),
          ),
      },
      {
        name: "update_item",
        description:
          "Change a task (text, state) or a decision (text = the question, outcome settles it; an empty outcome reopens it).",
        shape: {
          objective_id: z.string(),
          item_id: z.string().describe("t1, t2… for tasks, d1, d2… for decisions"),
          text: z.string().optional(),
          state: z.enum(TASK_STATES).optional(),
          outcome: z.string().optional(),
        },
        handler: (a) =>
          run(() =>
            api.updateItem(id, String(a.objective_id), String(a.item_id), {
              ...(typeof a.text === "string" && { text: a.text }),
              ...(typeof a.state === "string" && { state: a.state as TaskState }),
              ...(typeof a.outcome === "string" && { outcome: a.outcome }),
            }),
          ),
      },
      {
        name: "delete_objective",
        description:
          "Delete an objective created by mistake or a duplicate. Work that will not be done is status dropped instead, with the reason.",
        shape: { id: z.string() },
        handler: (a) => run(() => api.deleteObjective(id, String(a.id))),
      },
      {
        name: "archive_objective",
        description:
          "File a done or dropped objective away: it leaves the board's main view, stays readable, and still counts as done for what depends on it.",
        shape: { id: z.string() },
        handler: (a) => run(() => api.archiveObjective(id, String(a.id))),
      },
      {
        name: "restore_objective",
        description: "Bring an archived objective back onto the board.",
        shape: { id: z.string() },
        handler: (a) => run(() => api.restoreObjective(id, String(a.id))),
      },
      {
        name: "list_projects",
        description:
          "The other projects on this panel, with their ids and whether their lead is busy.",
        shape: {},
        handler: () => run(() => api.listProjects(id)),
      },
      {
        name: "message_project",
        description:
          "Send a message to another project's lead without waiting for it. Its answer arrives later as a message from that project.",
        shape: { project_id: z.string(), message: z.string() },
        handler: (a) => run(() => api.messageProject(id, String(a.project_id), String(a.message))),
      },
    ],
  };
}

export function workerToolset(api: PanelApi, workspaceId: string, project: Project): PanelToolset {
  return {
    instructions: [
      `You are a session of the project "${project.name}" (repository ${project.root}). Its lead agent coordinates the work there and may have started you with a task; the user may also talk to you directly.`,
      "When you finish a task the lead gave you, call finish_task with a concise summary for the lead: what changed, where (branch, commits, PR), what is left. If you are blocked and need a decision, call it with blocked set and say what you need. Use report_progress only for milestones the lead should know about before you finish.",
      "The lead's messages reach you prefixed [From the project lead]; the rest is the user's. When the lead only asks you something, just answer: your reply reaches it once you stop, or at once with report_progress while background work or a scheduled wake-up keeps you going. When the user changes the lead's task, say so in your finish_task summary; when they call it off, call finish_task right away to say so. Work the lead sends after you finished ends with finish_task too; what the user asks after that needs one only if what you reported no longer holds.",
      "current_task shows what you are working on as it stands: the task the lead gave you, its later messages to you, and your objectives on the project's board (tasks, decisions, what they depend on). A long task or a compacted context loses these; call it whenever you are not sure what exactly the task is or what was decided.",
    ].join("\n\n"),
    tools: [
      {
        name: "report_progress",
        description: "Tell the project's lead about a milestone. Keep it short.",
        shape: { text: z.string() },
        handler: (a) => run(() => api.workerReport(workspaceId, String(a.text), false)),
      },
      {
        name: "finish_task",
        description:
          "Report the task as done, or as blocked on a decision, to the project's lead, with a concise summary.",
        shape: {
          summary: z.string(),
          blocked: z.boolean().optional().describe("You stopped because you need a decision"),
        },
        handler: (a) =>
          run(() => api.workerReport(workspaceId, String(a.summary), true, a.blocked === true)),
      },
      {
        name: "current_task",
        description:
          "What you are working on, as it stands now: the task the lead gave you and its later messages to you, and your objectives on the project's board with their tasks, decisions and dependencies. With objective_id, another objective of the board (one yours depends on, say).",
        shape: {
          objective_id: z.string().optional().describe("Another objective to read, by its id"),
        },
        handler: (a) =>
          run(() =>
            api.currentTask(
              workspaceId,
              typeof a.objective_id === "string" ? a.objective_id : undefined,
            ),
          ),
      },
    ],
  };
}
