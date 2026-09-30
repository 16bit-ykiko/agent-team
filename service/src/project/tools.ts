import { z } from "zod";
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
export interface PanelApi {
  projectStatus(projectId: string): Promise<string>;
  startSession(projectId: string, args: StartSessionArgs): string;
  readSession(projectId: string, sessionId: string, last: number, around?: string): string;
  listHistory(projectId: string, everywhere: boolean, limit: number): Promise<string>;
  searchHistory(
    projectId: string,
    query: string,
    everywhere: boolean,
    limit: number,
    toolOutput: boolean,
  ): Promise<string>;
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
}

const run = (fn: () => string | Promise<string>) => new Promise<string>((ok) => ok(fn()));

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
      "Worker sessions report back; their messages reach you prefixed [From session …]. Check on them with read_session, steer them with message_session. When a worker's worktree is about to be removed, archive its session with archive_session.",
      [
        "The objectives are the project's board and memory, one per piece of work, with an id area/name (for example index/name-ranges). Each says what it is for (goal), where things stand (context), what must come first (depends_on: other objective ids), its tasks and the decisions still to settle.",
        "Record what the user decides as you talk, including in passing: status later for what is put off, dropped with the reason for what will not be done (so it is not reopened), priority high/normal/low, and the reason for either. Tasks move todo → doing → review → done (or dropped); settle a decision by giving its outcome.",
        "Change them only through write_objective, add_items and update_item; list_objectives gives the board, read_objective one objective in full. When an objective is done or dropped for good, archive_objective files it away. The user sees the board as a dependency view: keep depends_on accurate.",
      ].join(" "),
      `Longer-lived notes (decisions, background, plans) go in markdown files under ${notesDir}; read and write them with your file tools. Subagents can maintain them too.`,
      "Other projects have leads of their own: list_projects shows them, message_project sends one a message without waiting. Its answer arrives later as a message from that project.",
      "project_status gives the board, the running sessions and the repository's worktrees at a glance.",
      "Earlier conversations here are the project's history: sessions from before the project and archived ones. When the user refers to past work, search_history finds it and read_session reads it in context; list_history lists those sessions with their history files (JSON lines, one message per line, and beside each a .text.jsonl with only what was said, no tool calls; search them with rg, not grep) and the Claude CLI's own transcripts.",
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
          model: z.string().optional().describe("Model id; defaults to yours"),
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
          "Messages of a worker session (the latest, and whether it is working), or of an earlier one from the history; around a message id to read a search hit in context.",
        shape: {
          session_id: z.string(),
          last: z.number().int().min(1).max(50).optional().describe("How many messages (6)"),
          around: z.string().optional().describe("A message id: the messages around it"),
        },
        handler: (a) =>
          run(() =>
            api.readSession(
              id,
              String(a.session_id),
              Number(a.last ?? 6),
              typeof a.around === "string" ? a.around : undefined,
            ),
          ),
      },
      {
        name: "list_history",
        description:
          "Earlier sessions in this repository (archived, from before the project or since): id, folder, dates, and the Claude transcript files to grep.",
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
          "Find what was said in this project's sessions and its history: all words must match. Hits give the session and message ids for read_session.",
        shape: {
          query: z.string(),
          everywhere: z.boolean().optional().describe("Every archived session, in any folder"),
          limit: z.number().int().min(1).max(100).optional().describe("How many hits (20)"),
          tool_output: z
            .boolean()
            .optional()
            .describe("Also search what tools returned (command output, files read)"),
        },
        handler: (a) =>
          run(() =>
            api.searchHistory(
              id,
              String(a.query),
              a.everywhere === true,
              Number(a.limit ?? 20),
              a.tool_output === true,
            ),
          ),
      },
      {
        name: "message_session",
        description:
          "Send a message to a worker session (queued if it is busy). It shows as coming from you.",
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
    ],
  };
}
