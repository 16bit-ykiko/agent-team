import { z } from "zod";
import { ENTRY_KINDS, type EntryKind } from "../workspace/history-index";
import type { Project } from "./store";
import {
  LIMITS,
  OBJECTIVE_STATUSES,
  PRIORITIES,
  TASK_STATES,
  type ObjectiveStatus,
  type Priority,
  type TaskState,
} from "./objectives";
import { EVIDENCE, ISSUE_STATES, ISSUE_TEXT_LIMIT, type Evidence, type IssueState } from "./issues";
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

// A task's text and state, or a decision's question and outcome ("" reopens);
// remove deletes the item.
export interface ItemPatch {
  text?: string;
  state?: TaskState;
  outcome?: string;
  remove?: boolean;
}

// What a worker's finish_task also writes: its objective's new context.
export interface FinishPatch {
  context?: string;
  objectiveId?: string;
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
  readObjective(projectId: string, id: string): Promise<string>;
  // sessionId: the worker session that made the call, if one did.
  writeObjective(projectId: string, patch: ObjectivePatch, sessionId?: string): Promise<string>;
  addItems(projectId: string, objectiveId: string, tasks: string[], decisions: string[]): string;
  updateItem(
    projectId: string,
    objectiveId: string,
    itemId: string,
    patch: ItemPatch,
    sessionId?: string,
  ): string;
  deleteObjective(projectId: string, id: string): string;
  listIssues(projectId: string, filter: IssueFilter): string;
  readIssue(
    projectId: string,
    target: { id?: string; module?: string; group?: string },
  ): Promise<string>;
  // sessionId: the worker session that made the call, if one did.
  writeIssues(projectId: string, patches: IssuePatch[], sessionId?: string): Promise<string>;
  writeIssueGroup(projectId: string, patch: GroupPatch): string;
  closeIssues(projectId: string, ids: string[], fixedBy: string): string;
  listProjects(projectId: string): string;
  messageProject(projectId: string, targetId: string, text: string): string;
  workerReport(
    workspaceId: string,
    text: string,
    final: boolean,
    finish?: FinishPatch,
  ): Promise<string>;
  currentTask(workspaceId: string, objectiveId?: string): Promise<string>;
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
  "When the user refers to past work, search_history finds it in the recorded sessions (every message, thinking block, tool call and output, earlier sessions included); read_entry and read_session read on from a hit.";

// What the board and the notes hold, the lead's and its workers' alike.
const LIVE =
  "The board and the notes hold only what is live: what is being worked on, what is left, what is undecided; the history keeps everything said and done, git what changed. Write state, not events: a context says in a few lines where things stand and is rewritten, never extended with dates, PR chronicles or what came before. Copy nothing the code, git or CI can tell; a decision that shapes the code goes in the repository. Delete what is done or obsolete, keeping nothing as legacy or history. Check what you read there against the code before acting on it: it says when it was written.";

const ISSUES = "Known defects are the project's issues; the issue tools say how they are kept.";

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
      "You keep the whole project in view: from the board and the sessions you discuss with the user what to do, and start worker sessions with start_session, only when the user asks for it: for a piece of work the user decided on, with its objective and task, or for a topic the user wants to go into in depth (then its task says what to discuss, and that it starts no work on its own). A worker is a separate Claude session the user opens and talks to directly. Give it a complete, self-contained task.",
      [
        "Once a worker is started, step back: tell the user which session to talk to, and leave that conversation to them. A worker decides what it can itself and asks the user, in its own session, what is theirs to decide; do not answer for the user, relay, chase or poll. Message a worker (message_session) only when the user asks you to, to pass on what reached you from outside its session (another project's request, say), or to retry a failed turn as below.",
        "Worker sessions report back; their messages reach you prefixed [From session …]: finished (its tasks on the board move to review) or, rarely, progress that changes the plan. Take a finished report as you would a subagent's result: when it shows the work is done, mark the tasks done (dropped, with the reason, when the user called the work off), delete the objective once all its work is done, and tell the user in a sentence; when it says something was replaced, check the board keeps nothing about the old one. Read the session (read_session) or the changes only when something in it is unclear or risky. When something looks missing or wrong, tell the user what: they take it up with the worker. Bring a progress report to the user only when it changes the plan.",
        "The panel tells you, prefixed [From the panel, about session …], when a worker's turn on what you sent failed, and when it answered your later message without calling finish_task, with its last reply. Act on it when there is something to do; a question in it for the user is theirs to answer in that session: tell them in a sentence that the worker waits for them. Do not message the worker only to ask for a report. Retry a failed turn once at most; if it fails again, tell the user. A turn a server restart cut off, the panel has the worker carry on; cut off again, you are told: tell it to carry on. A worker the user has written to since, or stopped, is theirs: you are not told of it.",
        "When a worker's worktree is about to be reused or removed, archive its session with archive_session.",
      ].join(" "),
      [
        "The objectives are the project's board, one per piece of work (id area/name): goal, context (where it stands), depends_on (the user sees the board as a dependency view), tasks and open decisions. Workers keep theirs current: read the board rather than asking them, and do not mirror their progress onto it.",
        "You record what the user decides with you, in passing too: new objectives, later for what is put off, dropped with the reason for what will not be done (it shrinks to its title and reason, so it is not proposed again), priority. Tasks move todo → doing → review → done, one line each, and go with their objective; a decision is settled by its outcome. Tasks and decisions that no longer matter are removed (update_item).",
      ].join(" "),
      LIVE,
      ISSUES,
      `Notes are markdown files under ${notesDir}, read and written with your file tools: designs and plans that outlive one task, kept as live as the board.`,
      "Other projects have leads of their own: list_projects shows them, message_project sends one a message without waiting. Its answer arrives later as a message from that project.",
      "project_status gives the board, the running sessions, the repository's worktrees and the board's size at a glance.",
      HISTORY,
    ].join("\n\n"),
    tools: [
      projectStatusTool(api, id),
      {
        name: "start_session",
        description: `Start a worker: a Claude session in cwd whose first message is task. cwd is the repository or one of at most four worktrees, reused: one no live session uses (project_status), clean, its branch merged or pushed; archive its idle session, then git -C <worktree> switch -c <branch> origin/main. A new worktree only when all are taken. Models: ${models.join(", ")}.`,
        shape: {
          title: z.string(),
          cwd: z.string(),
          task: z.string().describe("Complete and self-contained"),
          model: z
            .string()
            .optional()
            .describe(`Default ${models[0]}; another only when the user asks`),
          objective_id: z.string().optional(),
          task_id: z.string().optional().describe("Doing now, review when it finishes"),
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
          "Message a worker (queued if busy), in the cases your instructions name; its answer comes back as a report or a notice from the panel.",
        shape: { session_id: z.string(), message: z.string() },
        handler: (a) => run(() => api.messageSession(id, String(a.session_id), String(a.message))),
      },
      {
        name: "stop_session",
        description: "Stop a worker's turn and drop your messages queued for it.",
        shape: { session_id: z.string() },
        handler: (a) => run(() => api.stopSession(id, String(a.session_id))),
      },
      {
        name: "archive_session",
        description: "Archive an idle worker; a new message restores it.",
        shape: { session_id: z.string() },
        handler: (a) => run(() => api.archiveSession(id, String(a.session_id))),
      },
      ...boardTools(api, id),
      ...issueTools(api, id),
      {
        name: "delete_objective",
        description:
          "Delete an objective that is done, a duplicate or a mistake; depends_on and issue links lose it. Work that will not be done is dropped instead.",
        shape: { id: z.string() },
        handler: (a) => run(() => api.deleteObjective(id, String(a.id))),
      },
      {
        name: "list_projects",
        description: "The other projects and whether their lead is busy.",
        shape: {},
        handler: () => run(() => api.listProjects(id)),
      },
      {
        name: "message_project",
        description: "Message another project's lead; an answer comes later as a message.",
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
      "Worktrees, worker sessions, active objectives, issues, and the size of the board and notes.",
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
        "A session's messages, live or archived: the last ones, the first (start) or those around a message id; with tools, their tool calls by entry.",
      shape: {
        session_id: z.string(),
        last: z.number().int().min(1).max(50).optional().describe("How many (6)"),
        start: z.boolean().optional(),
        around: z.string().optional(),
        tools: z.boolean().optional(),
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
      name: "search_history",
      description:
        "Grep the project's recorded sessions, newest first: a hit is an entry with its matching lines and the ids for read_entry and read_session. Without words or a pattern it lists entries.",
      shape: {
        query: z
          .string()
          .optional()
          .describe('Words all in the entry, any case; "a phrase" keeps its spaces'),
        regex: z.string().optional().describe("JavaScript; ^ and $ at lines"),
        in: z
          .array(z.enum(ENTRY_KINDS as [EntryKind, ...EntryKind[]]))
          .optional()
          .describe("Default said; with tool, tool_call and tool_output; with call, tool_output"),
        tool: z.string().optional().describe("Bash, Edit, …, or an MCP tool's own name"),
        call: z.string().optional().describe("Outputs of calls holding this text"),
        folder: z.string().optional(),
        session: z.string().optional(),
        message: z.string().optional(),
        since: z.string().optional().describe("ISO, UTC unless it says"),
        until: z.string().optional(),
        level: z.enum(["main", "subagents"]).optional(),
        lines: z.number().int().min(1).max(50).optional().describe("Per hit (3)"),
        context: z.number().int().min(0).max(20).optional().describe("Around each line (0)"),
        case_sensitive: z.boolean().optional(),
        everywhere: z.boolean().optional().describe("Every archived session, any folder"),
        limit: z.number().int().min(1).max(100).optional().describe("(20)"),
        offset: z.number().int().min(0).optional(),
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
        "An entry in full, or some of its lines; from_char reads on in a line that was cut.",
      shape: {
        entry: z.number().int(),
        from_line: z.number().int().min(1).optional(),
        lines: z.number().int().min(1).max(2000).optional().describe("(200)"),
        from_char: z.number().int().min(0).optional(),
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
        "One read-only SQLite statement over the sessions search_history reaches with everywhere, at most 200 rows: for counts, grouping, listing sessions.",
        "Tables: sessions(id, name, cwd, project, role, created_at, last_active, archived_at); entries(id, session, message, ts, kind, role, tool, depth, lines, call, duration_ms, text), call being a tool_output's tool_call id; messages(session, id, seq, ts, kind, status, hash, body JSON).",
        "entries_fts: trigram index of entries.text, rowid = entries.id, words of 3+ characters. regexp() and iregexp() take JavaScript patterns. Times: ms since the epoch.",
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
        "The board by area: status, priority, progress, open decisions, blockers; archived lists the archive.",
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
      description: "One objective in full.",
      shape: { id: z.string() },
      handler: (a) => run(() => api.readObjective(id, String(a.id))),
    },
    {
      name: "write_objective",
      description:
        'Create an objective (title, goal) or change one: only the fields given change, "" clears. Dropped, with its reason, keeps only its title and the reason.',
      shape: {
        id: z.string().describe("area/name"),
        title: z.string().optional(),
        goal: z.string().optional().describe("A sentence or two"),
        status: z.enum(OBJECTIVE_STATUSES).optional().describe("Done work is deleted instead"),
        priority: z.enum(PRIORITIES).optional(),
        reason: z.string().optional().describe("For the status or priority"),
        context: z
          .string()
          .optional()
          .describe(`Where it stands now, a few lines (≤${LIMITS.context}), rewritten whole`),
        depends_on: z.array(z.string()).optional(),
        notes: z.string().optional().describe(`Links to design docs (≤${LIMITS.notes})`),
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
      description: "Add tasks and decisions (questions) to an objective.",
      shape: {
        objective_id: z.string(),
        tasks: z.array(z.string()).optional().describe(`One line each (≤${LIMITS.task})`),
        decisions: z.array(z.string()).optional().describe(`≤${LIMITS.decision}`),
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
        'Change a task (text, state) or a decision (text, outcome; "" reopens), or remove one that no longer matters.',
      shape: {
        objective_id: z.string(),
        item_id: z.string().describe("t1… or d1…"),
        text: z.string().optional(),
        state: z.enum(TASK_STATES).optional(),
        outcome: z.string().optional().describe(`≤${LIMITS.decision}`),
        remove: z.boolean().optional(),
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
              ...(a.remove === true && { remove: true }),
            },
            sessionId,
          ),
        ),
    },
  ];
}

const ISSUE_FIELDS = {
  id: z.string().optional().describe("Left out, a new one gets the next MM-DD#N"),
  module: z.string().optional().describe("Required for a new one; another moves it"),
  group: z.string().optional().describe('"" ungroups'),
  state: z.enum(ISSUE_STATES).optional(),
  evidence: z
    .enum([...EVIDENCE, ""])
    .optional()
    .describe('"" clears'),
  tags: z.array(z.string()).optional(),
  text: z
    .string()
    .optional()
    .describe(`What goes wrong, how common, where, how to fix (≤${ISSUE_TEXT_LIMIT})`),
  objectives: z.array(z.string()).optional(),
};

// The issues' tools, the lead's and its workers' alike; a worker passes its
// session, whose folder's commit dates what it writes.
function issueTools(api: PanelApi, id: string, sessionId?: string): PanelTool[] {
  return [
    {
      name: "list_issues",
      description: "Open and to-decide issues (unless states) by module and group, one line each.",
      shape: {
        module: z.string().optional(),
        states: z.array(z.enum(ISSUE_STATES)).optional(),
        evidence: z.array(z.enum(EVIDENCE)).optional(),
        tag: z.string().optional(),
        objective: z.string().optional(),
        query: z.string().optional().describe("Words in the id or text"),
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
      description: "An issue in full, or a module or group with its issues.",
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
      description: [
        "Create or change issues, all or none: only the fields given change. Issues are known defects, one file per module, grouped by what one fix settles.",
        "State: open, decision (whether it is a defect is the user's call), accepted (not fixed until a real user hits it). Evidence: R script repro, V probe, H code reading, S seen on a re-test, C another agent's, unchecked. Confirm H or C before fixing; a fix brings a regression test.",
      ].join(" "),
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
            sessionId,
          ),
        ),
    },
    {
      name: "write_issue_group",
      description:
        "Create or change a module (no group) or a group: title (a new one needs it), notes on what its issues share, objectives for all of them; remove drops an empty one.",
      shape: {
        module: z.string(),
        group: z.string().optional(),
        title: z.string().optional(),
        notes: z.string().optional(),
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
        "Delete issues whose fix is merged, or that no longer hold; their text comes back in the result.",
      shape: {
        ids: z.array(z.string()),
        fixed_by: z.string().describe("The PR or commit, or why they no longer hold"),
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

export function workerToolset(
  api: PanelApi,
  workspaceId: string,
  project: Project,
  notesDir: string,
): PanelToolset {
  return {
    instructions: [
      `You are a session of the project "${project.name}" (repository ${project.root}). Its lead agent coordinates the work there and may have started you with a task; the user may also talk to you directly.`,
      LANGUAGE,
      "The task is yours: decide what you can yourself. What is the user's to decide, ask them here, in your reply, and stop (not the lead): they come to this session to talk it over with you. A task to discuss something with the user is that discussion: start work only when they ask for it.",
      "When the task is done, or the user calls it off, call finish_task once with a concise summary for the lead: what changed, where (branch, commits, PR), what is left. Use report_progress only for what changes the lead's plans before you finish (the scope changed, the plan proved wrong, a finding that affects other work), not for milestones.",
      "The lead's messages reach you prefixed [From the project lead], the panel's [From the panel]; the rest is the user's. When the lead asks you something after the task, just answer: your reply reaches it once you stop, or at once with report_progress while background work or a scheduled wake-up keeps you going. When the user changes the lead's task, say so in your finish_task summary. Work the lead sends after you finished ends with finish_task too; what the user asks after that needs one only if what you reported no longer holds.",
      "The board follows your task at its edges: start_session made it doing; finish_task, given the objective's new context, writes it and moves the task to review. In between, write only when the plan changes: a task found, taken up (doing makes it yours) or no longer needed, a decision the user settles with you, new work the user decides on with you, what your work showed elsewhere on the board. An objective whose work is done the lead deletes.",
      "When your work replaces something (a build system, a module, a test suite, an API, a workflow), it is done only when the old one is gone wherever it is described: docs, CLAUDE.md, skills, scripts, comments, objectives, tasks, issues, notes. Search by its names; delete what applied only to the old one and keep what still holds. That is part of the task, not scope creep. Before finish_task, delete what your work made obsolete.",
      LIVE,
      ISSUES,
      `The project's notes are markdown files under ${notesDir}. When unsure what exactly the task is or what was decided (a long task, a compacted context), call current_task. When your work touches what another session did, read it (project_status, read_session) rather than asking the user.`,
      HISTORY,
    ].join("\n\n"),
    tools: [
      {
        name: "report_progress",
        description: "Tell the lead, briefly, what changes its plans; not milestones.",
        shape: { text: z.string() },
        handler: (a) => run(() => api.workerReport(workspaceId, String(a.text), false)),
        subagentRefusal: REPORT_REFUSAL,
      },
      {
        name: "finish_task",
        description:
          "Report the task done, or called off, to the lead, once: what changed, where, what is left, what it replaced and where its traces were removed. Moves your tasks to review.",
        shape: {
          summary: z.string(),
          context: z
            .string()
            .optional()
            .describe(`Your objective's new context (≤${LIMITS.context})`),
          objective_id: z.string().optional().describe("When you work on more than one"),
        },
        handler: (a) =>
          run(() =>
            api.workerReport(workspaceId, String(a.summary), true, {
              ...(typeof a.context === "string" && { context: a.context }),
              ...(typeof a.objective_id === "string" && { objectiveId: a.objective_id }),
            }),
          ),
        subagentRefusal: REPORT_REFUSAL,
      },
      {
        name: "current_task",
        description:
          "Your task, the lead's later messages and your objectives as they stand; objective_id reads another objective in full.",
        shape: { objective_id: z.string().optional() },
        handler: (a) =>
          run(() =>
            api.currentTask(
              workspaceId,
              typeof a.objective_id === "string" ? a.objective_id : undefined,
            ),
          ),
      },
      ...boardTools(api, project.id, workspaceId).filter((t) => t.name !== "read_objective"),
      ...issueTools(api, project.id, workspaceId),
      projectStatusTool(api, project.id),
      ...historyTools(api, project.id),
    ],
  };
}
