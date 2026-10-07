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
import { EVIDENCE, ISSUE_STATES, type Evidence, type IssueState } from "./issues";
import type { GroupPatch, IssueFilter, IssuePatch } from "./issue-board";

// Tools the panel gives its agents, served in-process to the Claude CLI as
// the "panel" MCP server (see ClaudeSession.setPanelTools). A project's lead
// runs sessions, keeps the objectives and talks to other projects' leads; a
// worker session it started reports back to it.

export interface PanelTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
  // Refused to the session's subagents, which inherit its tools, with this
  // as the reason: the call speaks for the session itself.
  subagentRefusal?: string;
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
  // sessionId: the worker session that made the call, if one did.
  writeObjective(projectId: string, patch: ObjectivePatch, sessionId?: string): string;
  addItems(projectId: string, objectiveId: string, tasks: string[], decisions: string[]): string;
  updateItem(
    projectId: string,
    objectiveId: string,
    itemId: string,
    patch: ItemPatch,
    sessionId?: string,
  ): string;
  deleteObjective(projectId: string, id: string): string;
  archiveObjective(projectId: string, id: string): string;
  restoreObjective(projectId: string, id: string): string;
  listIssues(projectId: string, filter: IssueFilter): string;
  readIssue(projectId: string, target: { id?: string; module?: string; group?: string }): string;
  writeIssues(projectId: string, patches: IssuePatch[]): string;
  writeIssueGroup(projectId: string, patch: GroupPatch): string;
  closeIssues(projectId: string, ids: string[], fixedBy: string): string;
  listProjects(projectId: string): string;
  messageProject(projectId: string, targetId: string, text: string): string;
  workerReport(workspaceId: string, text: string, final: boolean): string;
  currentTask(workspaceId: string, objectiveId?: string): string;
}

const run = (fn: () => string | Promise<string>) => new Promise<string>((ok) => ok(fn()));

// UTC unless the time says otherwise, as the history prints them.
function time(name: string, value: string): number {
  const t = Date.parse(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(value) ? `${value}Z` : value);
  if (Number.isNaN(t)) throw new Error(`${name}: not a date or time: ${value}`);
  return t;
}

// What the history tools reach, the lead's and its workers' alike.
const HISTORY =
  "Everything said and done in this project is recorded: the lead's conversation, every worker session's, and the project's history (archived sessions, from before the project too) — what was said, thinking, every tool call with its input and its output, errors, and what subagents did. When the user refers to past work, search_history finds it like grep would (words or a regular expression; by kind, tool, session, message, time; with context lines), read_entry reads a hit in full or by lines (a whole command output, a file that was read), and read_session reads a session in context, with its tool calls when you ask. query_history runs read-only SQL over the same records for what search cannot express (counts, grouping, one tool's calls across sessions). list_history lists the earlier sessions.";

// What the issues are and how they move, the lead's and its workers' alike.
const ISSUES =
  "The project's known defects are its issues, kept apart from the objectives: one file per module (an area of the code), the issues in groups that one fix would settle together, each group with what its issues have in common. An issue has an id (one you are given, or the next MM-DD#N), a state (open: to fix; decision: whether it is a defect at all is the user's call; accepted: recorded, not to be fixed, until a real user runs into it), its evidence (R reproduced by a script, V confirmed by a probe, H read from the code only, S still there on an earlier re-test, C another agent's probe not checked here), tags, its text (what goes wrong, how common, where in the code, how to fix it) and the objectives that work on it; a group or a module can name objectives for all its issues. Confirm an H or C issue and raise its evidence before fixing it; a fix comes with a regression test. Once the fix is merged, close_issues deletes the issues with what fixed them: nothing else keeps fixed issues. list_issues, read_issue, write_issues (many at once) and write_issue_group keep them.";

// How the panel's agents talk to the user.
const LANGUAGE =
  "Write to the user in 简体中文: replies, questions, summaries. Code, identifiers, commit messages and the files you write stay in English.";

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
      LANGUAGE,
      "You keep the whole project in view: from the board and the sessions you discuss with the user what to do, and start worker sessions with start_session. A worker is a separate Claude session, running in the folder you choose, that the user opens and talks to directly: the repository itself, or one of a few git worktrees of it that you reuse rather than make one per session (at most four unless the user wants more). For new work take a worktree no live session works in (project_status shows which) with nothing uncommitted and its branch merged or pushed: archive the idle session that worked there, then start the work's branch in it (git -C <worktree> switch -c <branch> origin/main). Make a new worktree only when every one is taken. Start one for a piece of work the user decided on, or for a topic the user wants to go into in depth: then its task says what to discuss, and that it starts no work on its own. Give it a complete, self-contained task. Start sessions only when the user asks for it.",
      [
        "Once a worker is started, step back: tell the user which session to talk to, and leave that conversation to them. A worker decides what it can itself and asks the user, in its own session, what is theirs to decide; do not answer for the user, relay, chase or poll. Message a worker (message_session) only when the user asks you to, to pass on what reached you from outside its session (another project's request, say), or to retry a failed turn as below.",
        "Worker sessions report back; their messages reach you prefixed [From session …]: finished (its tasks on the board move to review) or, rarely, progress that changes the plan. Take a finished report as you would a subagent's result: when it shows the work is done, mark the tasks done (dropped, with the reason, when the user called the work off) and tell the user in a sentence; read the session (read_session) or the changes only when something in it is unclear or risky. When something looks missing or wrong, tell the user what: they take it up with the worker. Bring a progress report to the user only when it changes the plan.",
        "The panel tells you, prefixed [From the panel, about session …], when a worker's turn on what you sent failed, and when it answered your later message without calling finish_task, with its last reply. Act on it when there is something to do; a question in it for the user is theirs to answer in that session: tell them in a sentence that the worker waits for them. Do not message the worker only to ask for a report. Retry a failed turn once at most; if it fails again, tell the user. A turn a server restart cut off, the panel has the worker carry on; cut off again, you are told: tell it to carry on. A worker the user has written to since, or stopped, is theirs: you are not told of it.",
        "When a worker's worktree is about to be reused or removed, archive its session with archive_session.",
      ].join(" "),
      [
        "The objectives are the project's board and memory, one per piece of work, with an id area/name (for example index/name-ranges). Each says what it is for (goal), where things stand (context), what must come first (depends_on: other objective ids), its tasks and the decisions still to settle.",
        "Workers keep the objectives they work on current themselves: where it stands, their tasks as they move, the decisions settled with them, new work decided with them. Read the board for where things stand rather than asking them, and do not mirror their progress onto it. You record what the user decides with you, including in passing: new objectives, status later for what is put off, dropped with the reason for what will not be done (so it is not reopened), priority high/normal/low, and the reason for either. Tasks move todo → doing → review → done (or dropped); settle a decision by giving its outcome.",
        "Change them only through write_objective, add_items and update_item; list_objectives gives the board, read_objective one objective in full. When an objective is done or dropped for good, archive_objective files it away. The user sees the board as a dependency view: keep depends_on accurate.",
      ].join(" "),
      ISSUES,
      `Longer-lived notes (decisions, background, plans) go in markdown files under ${notesDir}; read and write them with your file tools. Subagents can maintain them too.`,
      "Other projects have leads of their own: list_projects shows them, message_project sends one a message without waiting. Its answer arrives later as a message from that project.",
      "project_status gives the board, the running sessions and the repository's worktrees at a glance.",
      HISTORY,
    ].join("\n\n"),
    tools: [
      projectStatusTool(api, id),
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
      ...historyTools(api, id),
      {
        name: "message_session",
        description:
          "Send a message to a worker session (queued if it is busy), in the cases your instructions name. It shows as coming from you. Its answer comes back as its report or, when it just replies, as a notice from the panel with that reply.",
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
      ...boardTools(api, id),
      ...issueTools(api, id),
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

function projectStatusTool(api: PanelApi, id: string): PanelTool {
  return {
    name: "project_status",
    description:
      "The project at a glance: its worktrees (branch, uncommitted changes), the worker sessions (state, last reply) and the objectives board.",
    shape: {},
    handler: () => run(() => api.projectStatus(id)),
  };
}

// Reading the project's sessions and history, the lead's and its workers'
// alike: nothing here acts on another session.
function historyTools(api: PanelApi, id: string): PanelTool[] {
  return [
    {
      name: "read_session",
      description:
        "Messages of a session of the project (a live one's latest, and whether it is working; or an earlier one from the history): the last ones, the first ones, or those around a message id (a search hit in context). With tools, each message's tool calls and outputs are listed by entry (read_entry reads one).",
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
        limit: z.number().int().min(1).max(200).optional().describe("How many, newest first (30)"),
      },
      handler: (a) => run(() => api.listHistory(id, a.everywhere === true, Number(a.limit ?? 30))),
    },
    {
      name: "search_history",
      description:
        "Search the recorded sessions of this project (the lead's, the workers', the history), newest first, like grep: a hit is one entry (something said, a thinking block, a tool call, a tool's output, an error, a subagent's task) with its matching lines numbered, and the ids for read_entry and read_session. By default only what was said is searched; when that finds nothing, the answer says which other kinds would match. Without words or a pattern it lists entries (every Bash call of a session, say).",
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
        "Tables: sessions(id, name, cwd, project, role, created_at, last_active, archived_at); entries(id, session, message, ts, kind, role, tool, depth, lines, call, duration_ms, text) — kind as in search_history, depth 0 in the session itself and more inside subagents, lines its line count, call a tool_output's tool_call entry id, duration_ms a tool_call's time from call to result and a subagent entry's run (a background command's included), null on records from before it was measured; messages(session, id, seq, ts, kind, status, hash, body) — body is the message as JSON (json_extract(body, '$.model')).",
        "entries_fts is a trigram index of entries.text (its rowid is entries.id), for words of 3 characters or more: `entries.id in (select rowid from entries_fts where entries_fts match '\"words\"')`; shorter ones with instr(text, 'x'). regexp(pattern, text) and iregexp (any case) match JavaScript regular expressions. Times are milliseconds since the epoch.",
        "For example: select s.name, count(*) as n from entries e join sessions s on s.id = e.session where e.tool = 'Bash' group by s.name order by n desc; select tool, count(*), avg(duration_ms), max(duration_ms) from entries where kind = 'tool_call' and duration_ms is not null group by tool.",
      ].join(" "),
      shape: { sql: z.string() },
      handler: (a) => run(() => api.queryHistory(id, String(a.sql))),
    },
  ];
}

// The board's tools, the lead's and its workers' alike. A worker passes its
// session: an objective it creates names it, a task it takes up is its.
function boardTools(api: PanelApi, id: string, sessionId?: string): PanelTool[] {
  return [
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
          api.writeObjective(
            id,
            {
              id: String(a.id),
              ...(typeof a.title === "string" && { title: a.title }),
              ...(typeof a.goal === "string" && { goal: a.goal }),
              ...(typeof a.status === "string" && { status: a.status as ObjectiveStatus }),
              ...(typeof a.priority === "string" && { priority: a.priority as Priority }),
              ...(typeof a.reason === "string" && { reason: a.reason }),
              ...(typeof a.context === "string" && { context: a.context }),
              ...(Array.isArray(a.depends_on) && { dependsOn: a.depends_on.map(String) }),
              ...(typeof a.notes === "string" && { notes: a.notes }),
            },
            sessionId,
          ),
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
          api.updateItem(
            id,
            String(a.objective_id),
            String(a.item_id),
            {
              ...(typeof a.text === "string" && { text: a.text }),
              ...(typeof a.state === "string" && { state: a.state as TaskState }),
              ...(typeof a.outcome === "string" && { outcome: a.outcome }),
            },
            sessionId,
          ),
        ),
    },
  ];
}

const ISSUE_FIELDS = {
  id: z
    .string()
    .optional()
    .describe("The issue to change; a new one without it gets the next MM-DD#N"),
  module: z.string().optional().describe("Its module: required for a new issue; another moves it"),
  group: z.string().optional().describe('Its group in the module; "" takes it out of its group'),
  state: z.enum(ISSUE_STATES).optional(),
  evidence: z
    .enum([...EVIDENCE, ""])
    .optional()
    .describe('R, V, H, S or C; "" clears it'),
  tags: z.array(z.string()).optional().describe("Replace its tags"),
  text: z
    .string()
    .optional()
    .describe(
      "What goes wrong, how common, where in the code (markdown); required for a new issue",
    ),
  objectives: z.array(z.string()).optional().describe("Replace the objectives it is linked to"),
};

// The issues' tools, the lead's and its workers' alike.
function issueTools(api: PanelApi, id: string): PanelTool[] {
  return [
    {
      name: "list_issues",
      description:
        "The issues by module and group, one line each (id, state, evidence, tags, the start of its text), the open and to-decide ones unless states says otherwise. Filter by module, evidence, tag, a linked objective or words in the id or text.",
      shape: {
        module: z.string().optional(),
        states: z.array(z.enum(ISSUE_STATES)).optional().describe("Default open and decision"),
        evidence: z.array(z.enum(EVIDENCE)).optional(),
        tag: z.string().optional(),
        objective: z.string().optional().describe("Only those linked to this objective"),
        query: z.string().optional().describe("Words in the id or text, as written"),
      },
      handler: (a) =>
        run(() =>
          api.listIssues(id, {
            ...(typeof a.module === "string" && { module: a.module }),
            ...(Array.isArray(a.states) && { states: a.states as IssueState[] }),
            ...(Array.isArray(a.evidence) && { evidence: a.evidence as Evidence[] }),
            ...(typeof a.tag === "string" && { tag: a.tag }),
            ...(typeof a.objective === "string" && { objective: a.objective }),
            ...(typeof a.query === "string" && { query: a.query }),
          }),
        ),
    },
    {
      name: "read_issue",
      description:
        "An issue in full with its module, group and linked objectives; or a module, or one group of it, with all its issues in full.",
      shape: {
        id: z.string().optional(),
        module: z.string().optional(),
        group: z.string().optional(),
      },
      handler: (a) =>
        run(() =>
          api.readIssue(id, {
            ...(typeof a.id === "string" && { id: a.id }),
            ...(typeof a.module === "string" && { module: a.module }),
            ...(typeof a.group === "string" && { group: a.group }),
          }),
        ),
    },
    {
      name: "write_issues",
      description:
        "Create issues or change them, many in one call: only the fields given change. Nothing is written when one of them is refused.",
      shape: { issues: z.array(z.object(ISSUE_FIELDS).strict()) },
      handler: (a) =>
        run(() =>
          api.writeIssues(
            id,
            (Array.isArray(a.issues) ? a.issues : []).map((x: Record<string, unknown>) => ({
              // An empty id or module is one not given.
              ...(typeof x.id === "string" && x.id && { id: x.id }),
              ...(typeof x.module === "string" && x.module && { module: x.module }),
              ...(typeof x.group === "string" && { group: x.group }),
              ...(typeof x.state === "string" && { state: x.state as IssueState }),
              ...(typeof x.evidence === "string" && { evidence: x.evidence as Evidence | "" }),
              ...(Array.isArray(x.tags) && { tags: x.tags.map(String) }),
              ...(typeof x.text === "string" && { text: x.text }),
              ...(Array.isArray(x.objectives) && { objectives: x.objectives.map(String) }),
            })),
          ),
        ),
    },
    {
      name: "write_issue_group",
      description:
        "Create or change a module (without group: its title, notes, objectives for all its issues) or a group of it (its title, notes on what its issues have in common, objectives). A new one needs a title; remove drops one with no issues left.",
      shape: {
        module: z.string().describe("lowercase letters, digits and -"),
        group: z.string().optional().describe("lowercase letters, digits, . and -"),
        title: z.string().optional(),
        notes: z.string().optional().describe('Markdown; "" clears it'),
        objectives: z.array(z.string()).optional(),
        remove: z.boolean().optional(),
      },
      handler: (a) =>
        run(() =>
          api.writeIssueGroup(id, {
            module: String(a.module),
            ...(typeof a.group === "string" && a.group && { group: a.group }),
            ...(typeof a.title === "string" && { title: a.title }),
            ...(typeof a.notes === "string" && { notes: a.notes }),
            ...(Array.isArray(a.objectives) && { objectives: a.objectives.map(String) }),
            ...(a.remove === true && { remove: true }),
          }),
        ),
    },
    {
      name: "close_issues",
      description:
        "Delete issues whose fix is merged, saying what fixed them. Their text comes back in the result, which keeps it in the history.",
      shape: {
        ids: z.array(z.string()),
        fixed_by: z.string().describe("The PR or commit that fixed them"),
      },
      handler: (a) =>
        run(() =>
          api.closeIssues(
            id,
            Array.isArray(a.ids) ? a.ids.map(String) : [],
            typeof a.fixed_by === "string" ? a.fixed_by : "",
          ),
        ),
    },
  ];
}

const REPORT_REFUSAL =
  "Only the session's own agent reports to the project's lead. Put this in your final reply instead: it goes to the agent that started you.";

export function workerToolset(api: PanelApi, workspaceId: string, project: Project): PanelToolset {
  return {
    instructions: [
      `You are a session of the project "${project.name}" (repository ${project.root}). Its lead agent coordinates the work there and may have started you with a task; the user may also talk to you directly.`,
      LANGUAGE,
      "The task is yours: decide what you can yourself. What is the user's to decide, ask the user here, in your reply, and stop: they come to this session to talk it over with you. Do not take it to the lead. A task to discuss something with the user is that discussion: start work only when the user asks for it.",
      "When the task is done, or the user calls it off, call finish_task once with a concise summary for the lead: what changed, where (branch, commits, PR), what is left. Use report_progress only for what changes the lead's plans before you finish (the scope changed, the plan proved wrong, a finding that affects other work), not for milestones.",
      "The project's board is how the lead and the user follow the work: keep the objectives you work on current as you go, with write_objective, add_items and update_item. Where it stands goes in its context; a task you take up goes to doing (it becomes yours), one you finish to review; add the tasks you find; settle a decision when the user settles it with you; and make an objective for new work the user decides on with you. Change other objectives only for what your work showed about them. list_objectives gives the board; current_task with objective_id reads one objective in full.",
      "The lead's messages reach you prefixed [From the project lead], the panel's [From the panel]; the rest is the user's. When the lead asks you something after the task, just answer: your reply reaches it once you stop, or at once with report_progress while background work or a scheduled wake-up keeps you going. When the user changes the lead's task, say so in your finish_task summary. Work the lead sends after you finished ends with finish_task too; what the user asks after that needs one only if what you reported no longer holds.",
      ISSUES,
      "current_task shows what you are working on as it stands: the task the lead gave you, its later messages to you, and your objectives on the project's board (tasks, decisions, what they depend on). A long task or a compacted context loses these; call it whenever you are not sure what exactly the task is or what was decided.",
      "project_status shows the board, the other sessions and the repository's worktrees at a glance. When your work touches what another session did or decided, read it there rather than asking the user.",
      HISTORY,
    ].join("\n\n"),
    tools: [
      {
        name: "report_progress",
        description:
          "Tell the project's lead what changes its plans: the scope changed, the plan proved wrong, a finding that affects other work. Not for milestones. Keep it short.",
        shape: { text: z.string() },
        handler: (a) => run(() => api.workerReport(workspaceId, String(a.text), false)),
        subagentRefusal: REPORT_REFUSAL,
      },
      {
        name: "finish_task",
        description:
          "Report the task as done, or as called off by the user, to the project's lead, with a concise summary. Once per task.",
        shape: { summary: z.string() },
        handler: (a) => run(() => api.workerReport(workspaceId, String(a.summary), true)),
        subagentRefusal: REPORT_REFUSAL,
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
      ...boardTools(api, project.id, workspaceId).filter((t) => t.name !== "read_objective"),
      ...issueTools(api, project.id),
      projectStatusTool(api, project.id),
      ...historyTools(api, project.id),
    ],
  };
}
