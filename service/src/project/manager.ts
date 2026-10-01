import * as os from "os";
import * as path from "path";
import { AGENT_PRESETS, MODEL_OPTIONS } from "../config/presets";
import { resolveWorkspacePath } from "../repo/dirs";
import { gitStatus, gitWorktrees, repositoryRoot } from "../repo/git";
import type { EntryInfo, EntryKind, SessionRow, SqlValue } from "../workspace/history-index";
import type { HistoryService } from "../workspace/history-service";
import {
  originLabel,
  type MessageOrigin,
  type ProjectLink,
  type Workspace,
} from "../workspace/workspace";
import { ProjectStore, type Project } from "./store";
import {
  OBJECTIVE_STATUSES,
  ObjectiveStore,
  checkId,
  dependencies,
  cycleThrough,
  type BrokenObjective,
  type Objective,
} from "./objectives";
import {
  leadToolset,
  workerToolset,
  type ItemPatch,
  type ObjectivePatch,
  type PanelApi,
  type HistorySearch,
  type PanelToolset,
  type StartSessionArgs,
} from "./tools";

// Of the history tools' output: characters per line and in all of
// read_entry, per cell of query_history; rows of query_history; entries per
// message of read_session.
const LINE_CAP = 4000;
const OUTPUT_CAP = 60_000;
const CELL_CAP = 1000;
const SQL_ROWS = 200;
const ENTRIES_SHOWN = 60;

// A long-lived lead has the whole project in its context.
export const LEAD_MODEL = "claude-opus-5-5";

// A lead asked to start everything at once must not spawn a burst of CLI
// sessions on the user's account: worker tasks go out this far apart.
export const START_SPACING_MS = 15_000;

// A worker has had nothing to run for this long before the lead is told it
// went idle without reporting: a finished background task starts the turn
// that reads its output a second or two after the task is gone.
export const SETTLE_MS = 15_000;

// Two leads can keep answering each other with nobody watching; past this
// many messages between two projects within the window, message_project is
// refused until it calms down.
const PEER_LIMIT = 6;
const PEER_WINDOW_MS = 10 * 60_000;

// What the manager needs from the server that owns the workspaces.
export interface ProjectHost {
  workspaces(): Iterable<Workspace>;
  workspace(id: string): Workspace | undefined;
  createWorkspace(name: string, cwd: string, link: ProjectLink): Workspace;
  addAgent(workspace: Workspace, name: string, model: string, avatar: string, color: string): void;
  // Deletes a workspace without the project bookkeeping of a user delete.
  removeWorkspace(id: string): void;
  // False when the workspace is still busy.
  archiveWorkspace(workspace: Workspace): boolean;
  // Unarchives and loads the history; false when it cannot be read.
  restoreWorkspace(workspace: Workspace): boolean;
  loadWorkspace(workspace: Workspace): boolean;
  history: HistoryService;
  persistWorkspace(workspace: Workspace): void;
  // Right away: a shutdown drops pending debounced saves of unloaded
  // (archived) workspaces.
  saveWorkspaceNow(workspace: Workspace): void;
  // Its name or project link changed.
  workspaceChanged(workspace: Workspace): void;
  broadcast(msg: unknown): void;
}

export type ProjectInfo = Project & { objectives: Array<Objective | BrokenObjective> };

// Projects: a lead workspace per repository that starts worker sessions
// through the panel tools, keeps the objectives, and talks to other
// projects' leads. Every message between sessions goes through the normal
// send path, shown with its sender (Message.from).
export class ProjectManager {
  private store: ProjectStore;
  private nextStartAt = 0;
  private peerLog = new Map<string, number[]>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private boards = new Map<string, ObjectiveStore>();
  private settling = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    baseDir: string,
    private host: ProjectHost,
  ) {
    this.store = new ProjectStore(baseDir);
  }

  get(id: string): Project | undefined {
    return this.store.get(id);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.settling.clear();
    for (const b of this.boards.values()) b.close();
    this.boards.clear();
  }

  list(): ProjectInfo[] {
    return this.store.list().map((p) => ({ ...p, objectives: this.board(p.id).list() }));
  }

  create(name: string, root: string, model = LEAD_MODEL): Project {
    if (!claudeModels().includes(model)) throw new Error(`The lead needs a Claude model: ${model}`);
    const taken = this.store.list().find((p) => p.root === root);
    if (taken) throw new Error(`${root} is already the project "${taken.name}"`);
    const project = this.store.create(name, root);
    let lead: Workspace | undefined;
    try {
      lead = this.host.createWorkspace(`${name} · lead`, root, {
        projectId: project.id,
        role: "lead",
      });
      project.leadWorkspaceId = lead.id;
      this.store.save(project);
      const preset = AGENT_PRESETS[0];
      this.host.addAgent(lead, "Lead", model, preset.avatar, preset.color);
    } catch (e) {
      if (lead) this.host.removeWorkspace(lead.id);
      this.store.remove(project.id);
      throw e;
    }
    this.changed(project.id);
    return project;
  }

  // Every folder is part of a project, the one of its repository (a git
  // worktree's is the checkout it was added to); the first workspace there
  // brings the project and its lead into being. The lead runs nothing until
  // it is written to.
  ensureFor(cwd: string): Project {
    const root = repositoryRoot(cwd);
    const project =
      this.store.list().find((p) => p.root === root) ??
      this.create(path.basename(root) || root, root);
    // Work there again brings an archived project back.
    if (project.archivedAt) this.setArchived(project.id, false);
    return project;
  }

  // Every workspace is a session of its folder's project: those from before
  // projects join theirs (made for them if need be) as archived or live
  // sessions, as they are. A project made only for archived ones starts
  // archived itself.
  adoptAll(): void {
    const byRoot = new Map<string, Workspace[]>();
    const roots = new Map<string, string>();
    for (const w of this.host.workspaces()) {
      if (w.projectLink) continue;
      let root = roots.get(w.cwd);
      if (root === undefined) roots.set(w.cwd, (root = repositoryRoot(w.cwd)));
      byRoot.set(root, [...(byRoot.get(root) ?? []), w]);
    }
    for (const [root, list] of byRoot) {
      let project = this.store.list().find((p) => p.root === root);
      if (!project) {
        project = this.create(path.basename(root) || root, root);
        if (list.every((w) => w.isArchived)) this.setArchived(project.id, true);
      }
      for (const w of list) {
        w.projectLink = { projectId: project.id, role: "worker" };
        const tools = this.toolsFor(w);
        for (const a of w.agents.values()) a.session.setPanelTools?.(tools);
        this.host.saveWorkspaceNow(w);
      }
      this.changed(project.id);
    }
  }

  setArchived(id: string, archived: boolean): void {
    const project = this.require(id);
    project.archivedAt = archived ? Date.now() : null;
    this.store.save(project);
    this.changed(id);
  }

  // A workspace from before projects (restored from the archive) joins the
  // project of its folder as one of its sessions.
  adopt(w: Workspace): void {
    if (w.projectLink) return;
    const project = this.ensureFor(w.cwd);
    w.projectLink = { projectId: project.id, role: "worker" };
    const tools = this.toolsFor(w);
    for (const a of w.agents.values()) a.session.setPanelTools?.(tools);
    this.host.saveWorkspaceNow(w);
    this.host.workspaceChanged(w);
  }

  rename(id: string, name: string): void {
    const project = this.require(id);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("A project needs a name");
    project.name = trimmed;
    this.store.save(project);
    const lead = this.leadOf(id);
    if (lead) {
      lead.name = `${trimmed} · lead`;
      this.host.saveWorkspaceNow(lead);
      this.host.workspaceChanged(lead);
    }
    // The tools' instructions carry the name.
    for (const w of this.members(id)) {
      const tools = this.toolsFor(w);
      for (const a of w.agents.values()) a.session.setPanelTools?.(tools);
    }
    this.changed(id);
  }

  // Deletes the project with its lead and its memory (objectives, notes).
  // Its worker sessions stay, as plain workspaces.
  delete(id: string): void {
    this.require(id);
    for (const w of this.members(id)) {
      if (w.projectLink?.role === "lead") {
        this.host.removeWorkspace(w.id);
        continue;
      }
      w.projectLink = undefined;
      for (const a of w.agents.values()) a.session.setPanelTools?.(null);
      this.dropQueuedFromLead(w);
      this.host.saveWorkspaceNow(w);
      this.host.workspaceChanged(w);
    }
    this.boards.get(id)?.close();
    this.boards.delete(id);
    this.store.remove(id);
    this.host.broadcast({ type: "project_deleted", projectId: id });
  }

  // A worker session is being deleted: the objectives stop pointing at it,
  // and what it was doing goes back to todo. Never fails the delete itself.
  forget(workspace: Workspace): void {
    const id = workspace.projectLink?.projectId;
    if (!id || !this.store.get(id)) return;
    this.rewrite(
      id,
      (o) => o.sessions.includes(workspace.id) || o.tasks.some((t) => t.session === workspace.id),
      (o) => ({
        ...o,
        sessions: o.sessions.filter((s) => s !== workspace.id),
        tasks: o.tasks.map((t) =>
          t.session === workspace.id
            ? { ...t, session: undefined, state: t.state === "doing" ? ("todo" as const) : t.state }
            : t,
        ),
      }),
    );
  }

  // Applies `change` to every objective `match` picks, each read fresh from
  // disk right before it is written; one that fails is logged and skipped.
  private rewrite(
    projectId: string,
    match: (o: Objective) => boolean,
    change: (o: Objective) => Objective,
  ): void {
    const board = this.board(projectId);
    let touched = false;
    for (const listed of this.objectives(projectId)) {
      if (!match(listed)) continue;
      try {
        const fresh = board.get(listed.id);
        if (!fresh || !match(fresh)) continue;
        board.write({ ...change(fresh), updatedAt: Date.now() });
        touched = true;
      } catch (e) {
        console.error(`[projects] ${listed.id}: not updated`, e);
      }
    }
    if (touched) this.changed(projectId);
  }

  // The project's objectives, watched so hand edits reach the board too.
  private board(id: string): ObjectiveStore {
    let board = this.boards.get(id);
    if (!board) {
      if (this.closed) throw new Error("The server is shutting down");
      board = new ObjectiveStore(this.store.objectivesDir(id));
      board.watch(() => this.changed(id));
      this.boards.set(id, board);
    }
    return board;
  }

  private objectives(id: string): Objective[] {
    return this.board(id)
      .list()
      .filter((o): o is Objective => !("error" in o));
  }

  private objective(projectId: string, id: string): Objective {
    checkId(id);
    const o = this.board(projectId).get(id);
    if (!o) throw new Error(`No objective ${id}`);
    return o;
  }

  private saveObjective(projectId: string, o: Objective): void {
    this.board(projectId).write({ ...o, updatedAt: Date.now() });
    this.changed(projectId);
  }

  // The tools a project workspace's agents get: the lead's or a worker's.
  toolsFor(workspace: Workspace): PanelToolset | null {
    const link = workspace.projectLink;
    const project = link && this.store.get(link.projectId);
    if (!link || !project) return null;
    return link.role === "lead"
      ? leadToolset(this.api, project, this.store.notesDir(project.id), claudeModels())
      : workerToolset(this.api, workspace.id, project);
  }

  // A worker's turn ended or its agent went idle: the check waits until it
  // has stayed so for SETTLE_MS.
  workerIdle(w: Workspace): void {
    if (w.projectLink?.role === "worker") this.settleAfter(w, SETTLE_MS);
  }

  // After a restart: workers that still owe their lead a word (a turn the
  // restart cut off, a notice that was still waiting) are checked again,
  // spaced out like starts so the leads do not all wake at once.
  recheckWorkers(): void {
    for (const w of this.host.workspaces()) {
      const link = w.projectLink;
      if (link?.role !== "worker" || w.isArchived) continue;
      const lead = this.leadOf(link.projectId);
      const owed = w.lastDelivered().some((d) => fromLead(d.input, lead) && !d.answered);
      if (owed) this.settleAfter(w, this.takeStartSlot(SETTLE_MS));
    }
  }

  // The next free start slot, START_SPACING_MS after the last one handed
  // out and `earliest` ms from now at the soonest: worker tasks, the lead's
  // messages that wake a worker, and a restart's queued messages and
  // notices all take one. Returns its delay.
  takeStartSlot(earliest = 0): number {
    const now = Date.now();
    const delay = Math.max(earliest, this.nextStartAt - now);
    this.nextStartAt = now + delay + START_SPACING_MS;
    return delay;
  }

  private settleAfter(w: Workspace, ms: number): void {
    const pending = this.settling.get(w.id);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(pending);
    }
    const t = this.later(ms, () => {
      this.settling.delete(w.id);
      this.tellIfSilent(w.id);
    });
    if (t) this.settling.set(w.id, t);
  }

  // A worker the lead gave work went quiet without reporting on it: the lead
  // hears it once, with how the turn ended and the last reply (the answer to
  // a question it asked, often). The user's own turns with the worker after
  // it are theirs; the notice only says there were some.
  private tellIfSilent(workspaceId: string): void {
    const w = this.host.workspace(workspaceId);
    const link = w?.projectLink;
    if (!w || link?.role !== "worker" || w.isArchived || !w.messagesLoaded || !w.isQuiet) return;
    const project = this.store.get(link.projectId);
    const lead = this.leadOf(link.projectId);
    if (!project || project.archivedAt || !lead || lead.isArchived) return;
    for (const { input, replies, stopped, answered, since } of w.lastDelivered()) {
      if (!fromLead(input, lead) || answered) continue;
      const last = replies[replies.length - 1];
      const error = last?.events?.filter((e) => e.kind === "error").pop();
      const text = replies
        .map((m) =>
          (m.content.endsWith(INTERRUPTED)
            ? m.content.slice(0, -INTERRUPTED.length)
            : m.content
          ).trim(),
        )
        .filter(Boolean)
        .pop();
      const how =
        stopped === "restart"
          ? "a server restart cut it off"
          : stopped === "user"
            ? "the user stopped it"
            : last?.status === "error"
              ? `its turn failed: ${oneLine(error?.content ?? "", 500)}`
              : "its turn ended";
      const body = [
        `No report on your message "${oneLine(input.content, 80)}" (${how}).`,
        text ? `Its last reply:\n\n${text.length > 1500 ? `…${text.slice(-1500)}` : text}` : "",
        since ? "The user has written to it since; that conversation is theirs." : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      this.deliver(
        lead,
        body,
        { workspaceId: w.id, name: w.name, role: "panel" },
        `[From the panel, about session "${w.name}" (${w.id}). Act on it if there is something to do; no reply to the session is needed.]\n\n${body}`,
      );
      w.markAnswered(input.id);
      this.host.persistWorkspace(w);
    }
  }

  private markAnswered(w: Workspace): void {
    for (const { input } of w.lastDelivered()) {
      if (input.from?.role === "lead") w.markAnswered(input.id);
    }
    this.host.persistWorkspace(w);
  }

  // What the lead said that has not run yet (a task still waiting for its
  // start slot, follow-ups queued behind a turn).
  private dropQueuedFromLead(w: Workspace): void {
    const queued = w.messages.filter((m) => m.status === "queued" && m.from?.role === "lead");
    for (const m of queued) {
      if (w.cancelQueued(m.id)) {
        this.host.broadcast({ type: "message_removed", workspaceId: w.id, messageId: m.id });
      }
    }
  }

  // A throw in a timer would take the server down.
  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> | undefined {
    if (this.closed) return undefined;
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        fn();
      } catch (e) {
        console.error("[projects]", e);
      }
    }, ms);
    this.timers.add(t);
    return t;
  }

  private changed(id: string): void {
    const project = this.store.get(id);
    if (!project) return;
    this.host.broadcast({
      type: "project_updated",
      project: { ...project, objectives: this.board(id).list() },
    });
  }

  private require(id: string): Project {
    const project = this.store.get(id);
    if (!project) throw new Error(`No project ${id}`);
    return project;
  }

  private members(id: string): Workspace[] {
    return [...this.host.workspaces()].filter((w) => w.projectLink?.projectId === id);
  }

  private workers(id: string): Workspace[] {
    return this.members(id).filter((w) => w.projectLink?.role === "worker");
  }

  private leadOf(id: string): Workspace | undefined {
    const leadId = this.store.get(id)?.leadWorkspaceId;
    return leadId ? this.host.workspace(leadId) : undefined;
  }

  private session(projectId: string, sessionId: string): Workspace {
    const w = this.host.workspace(sessionId);
    if (!w || w.projectLink?.projectId !== projectId || w.projectLink.role !== "worker") {
      throw new Error(`No session ${sessionId} in this project`);
    }
    return w;
  }

  // `text` is what the panel shows, `prompt` what the model reads. Throws
  // when the target cannot take it, so the tool reports the failure.
  private deliver(
    target: Workspace,
    text: string,
    from: MessageOrigin,
    prompt: string,
  ): "sent" | "queued" {
    if (target.agents.size === 0) throw new Error(`"${target.name}" has no agent`);
    if (!this.host.restoreWorkspace(target)) throw new Error(`"${target.name}" cannot be loaded`);
    const outcome = target.deliver(text, from, prompt);
    this.host.persistWorkspace(target);
    return outcome;
  }

  private fromLead(projectId: string, text: string): [MessageOrigin, string] {
    const origin: MessageOrigin = {
      workspaceId: this.leadOf(projectId)?.id ?? "",
      name: "lead",
      role: "lead",
    };
    return [origin, `[From the project lead]\n\n${text}`];
  }

  private async status(projectId: string): Promise<string> {
    const project = this.require(projectId);
    const out = [
      `# ${project.name}`,
      `Repository: ${project.root}`,
      `Notes: ${this.store.notesDir(projectId)}`,
      "",
      "## Worktrees",
    ];
    for (const wt of await gitWorktrees(project.root)) {
      const git = await gitStatus(wt);
      out.push(
        git
          ? `- ${wt} — ${git.branch ?? "detached"}, ${git.dirty} uncommitted, ahead ${git.ahead}, behind ${git.behind}`
          : `- ${wt}`,
      );
    }
    out.push("", "## Sessions");
    const sessions = this.workers(projectId);
    if (sessions.length === 0) out.push("(none)");
    for (const w of sessions) {
      const last = w.messagesLoaded
        ? [...w.getMessages()].reverse().find((m) => m.kind === "agent")
        : undefined;
      const cut = last && (last.status === "error" || last.content.endsWith(INTERRUPTED));
      const state = `${sessionState(w)}${cut ? ", its last turn did not finish" : ""}`;
      const excerpt = last ? ` — last reply: ${oneLine(last.content, 160)}` : "";
      out.push(`- ${w.id} "${w.name}" in ${w.cwd} — ${state}${excerpt}`);
    }
    out.push("", "## Active objectives", this.listObjectives(projectId, { status: "active" }));
    return out.join("\n");
  }

  private startSession(projectId: string, a: StartSessionArgs): string {
    const project = this.require(projectId);
    const input =
      a.cwd === "~" || a.cwd.startsWith("~/") ? path.join(os.homedir(), a.cwd.slice(1)) : a.cwd;
    const cwd = resolveWorkspacePath(path.resolve(project.root, input));
    if (!cwd) {
      throw new Error(
        `Not a directory: ${a.cwd}. Create it first (a worktree: git -C ${project.root} worktree add <path> -b <branch>).`,
      );
    }
    const models = claudeModels();
    if (a.model && !models.includes(a.model)) {
      throw new Error(`Unknown model ${a.model}; one of: ${models.join(", ")}`);
    }
    const objective = a.objectiveId ? this.objective(projectId, a.objectiveId) : undefined;
    if (a.taskId && !objective) throw new Error("task_id needs objective_id");
    if (a.taskId && !objective!.tasks.some((t) => t.id === a.taskId)) {
      throw new Error(`No task ${a.taskId} in ${objective!.id}`);
    }

    const model = a.model ?? LEAD_MODEL;
    const preset = AGENT_PRESETS[this.workers(projectId).length % AGENT_PRESETS.length];
    const w = this.host.createWorkspace(a.title, cwd, { projectId, role: "worker" });
    try {
      this.host.addAgent(w, preset.name, model, preset.avatar, preset.color);
    } catch (e) {
      this.host.removeWorkspace(w.id);
      throw e;
    }
    if (objective) {
      this.saveObjective(projectId, {
        ...objective,
        sessions: [...objective.sessions, w.id],
        tasks: objective.tasks.map((t) =>
          t.id === a.taskId
            ? { ...t, session: w.id, state: t.state === "todo" ? ("doing" as const) : t.state }
            : t,
        ),
      });
    }
    const delay = this.spaceStart(w);
    this.deliver(w, a.task, ...this.fromLead(projectId, a.task));
    const started = `Started session ${w.id} ("${a.title}") in ${cwd} on ${model}.`;
    return delay === 0
      ? started
      : `${started} Its task goes out in ${Math.ceil(delay / 1000)} s: starts are spaced out.`;
  }

  // A lead's message that starts a worker's turn goes out spaced from the
  // others: it waits as a queued message (saved, shown, ahead of any
  // follow-up) behind a pause on the worker's agent; after a restart the
  // server's spaced dequeue sends it. Returns the wait.
  private spaceStart(w: Workspace): number {
    const agent = w.resolveAgent();
    const now = Date.now();
    const waits =
      !agent ||
      agent.session.isRunning ||
      agent.retryPending ||
      (agent.pausedUntil !== undefined && now < agent.pausedUntil) ||
      w.messages.some((m) => m.status === "queued" && m.queuedFor === agent.info.id);
    if (waits) return 0;
    const delay = this.takeStartSlot();
    if (delay > 0) {
      const agentId = agent.info.id;
      w.pauseAgent(agentId, now + delay);
      this.later(delay, () => {
        if (this.host.workspace(w.id) === w) w.endPause(agentId);
      });
    }
    return delay;
  }

  // A project's own sessions (its lead's too), and the history: archived
  // sessions no other project holds.
  private readable(projectId: string, sessionId: string): Workspace {
    const w = this.host.workspace(sessionId);
    const link = w?.projectLink;
    if (w && link?.projectId === projectId) return w;
    if (w?.isArchived && !link) return w;
    throw new Error(`No session ${sessionId} in this project or its history`);
  }

  // Archived sessions that belong to no other project, in the project's
  // folders (the repository, folders in it, its worktrees) or anywhere.
  private async history(projectId: string, everywhere: boolean): Promise<Workspace[]> {
    const project = this.require(projectId);
    const roots = everywhere ? [] : await gitWorktrees(project.root);
    const inside = (cwd: string) => roots.some((r) => cwd === r || cwd.startsWith(`${r}/`));
    return [...this.host.workspaces()]
      .filter((w) => w.isArchived && (!w.projectLink || w.projectLink.projectId === projectId))
      .filter((w) => everywhere || inside(w.cwd))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  private async listHistory(
    projectId: string,
    everywhere: boolean,
    limit: number,
  ): Promise<string> {
    const all = await this.history(projectId, everywhere);
    if (all.length === 0) return "(no earlier sessions)";
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const lines = all
      .slice(0, limit)
      .map(
        (w) => `- ${w.id} "${w.name}" in ${w.cwd} · ${day(w.createdAt)} → ${day(w.lastActivityAt)}`,
      );
    const more = all.length > limit ? [`(${all.length - limit} older not shown)`] : [];
    return [...lines, ...more].join("\n");
  }

  // What the history tools reach: the project's sessions, its lead's
  // included, and the history (with everywhere, in any folder).
  private async scope(projectId: string, everywhere: boolean, session?: string) {
    if (session) return [this.readable(projectId, session)];
    return [
      ...new Set([...this.members(projectId), ...(await this.history(projectId, everywhere))]),
    ];
  }

  private async searchHistory(projectId: string, a: HistorySearch): Promise<string> {
    const folder = a.folder && path.resolve(this.require(projectId).root, a.folder);
    const sessions = (await this.scope(projectId, a.everywhere, a.session)).filter(
      (w) => !folder || w.cwd === folder || w.cwd.startsWith(`${folder}/`),
    );
    const names = new Map(sessions.map((w) => [w.id, w.name]));
    const kinds: EntryKind[] =
      a.in ?? (a.call ? ["tool_output"] : a.tool ? ["tool_call", "tool_output"] : ["said"]);
    const terms = queryTerms(a.query ?? "");
    const result = await this.host.history.search({
      terms,
      regex: a.regex,
      caseSensitive: a.caseSensitive,
      kinds,
      tool: a.tool,
      call: a.call,
      sessions: sessions.map((w) => w.id),
      message: a.message,
      since: a.since,
      until: a.until,
      depth: a.level,
      limit: a.limit,
      offset: a.offset,
      lines: a.lines,
      context: a.context,
    });
    const listed = terms.length === 0 && !a.regex;
    const out = result.hits.map((h) => {
      const lines: string[] = [];
      let last = -1;
      for (const l of h.lines) {
        if (a.context && last >= 0 && l.n > last + 1) lines.push("  --");
        lines.push(`  ${l.n}${l.match || listed ? ":" : "-"} ${l.text}`);
        last = l.n;
      }
      const call = h.call ? ` · output of #${h.call.entry}: ${oneLine(h.call.head, 100)}` : "";
      const more = h.moreLines
        ? [`  (+${h.moreLines} more ${listed ? "lines" : "matching lines"})`]
        : [];
      return [`- ${entryHeader(h, names.get(h.session))}${call}`, ...lines, ...more].join("\n");
    });
    if (result.more) out.push(`(more: offset ${a.offset + a.limit})`);
    if (out.length === 0) {
      out.push(`(nothing matches in ${kinds.join(", ")})`);
      const elsewhere = Object.entries(result.elsewhere ?? {});
      if (elsewhere.length) {
        out.push(
          `(it does in ${elsewhere.map(([k, n]) => `${n} ${k}`).join(", ")} entries: ask with in)`,
        );
      }
      if (result.tools) {
        out.push(`(the tools used there: ${result.tools.join(", ") || "none"})`);
      }
    }
    if (result.pending) {
      out.push(`(the index is catching up: ${result.pending} messages are not searchable yet)`);
    }
    return out.join("\n");
  }

  private async readEntry(
    projectId: string,
    entry: number,
    from: number,
    count: number,
    fromChar: number,
  ): Promise<string> {
    const e = await this.host.history.read(entry, from, count, fromChar);
    if (!e) throw new Error(`No entry #${entry}`);
    const w = this.readable(projectId, e.session);
    if (e.lines.length === 0) return `#${e.entry} has ${e.lineCount} lines`;
    const out: string[] = [];
    let size = 0;
    let n = e.from;
    for (const [i, line] of e.lines.entries()) {
      const offset = i === 0 ? fromChar : 0;
      const piece =
        line.length > LINE_CAP
          ? `${line.slice(0, LINE_CAP)}…(the line goes on: from_line ${n} from_char ${offset + LINE_CAP})`
          : line;
      if (out.length && size + piece.length > OUTPUT_CAP) break;
      out.push(`${n}: ${piece}`);
      size += piece.length;
      n++;
    }
    const last = n - 1;
    return [
      `${entryHeader(e, w.name)} — lines ${e.from}–${last} of ${e.lineCount}`,
      ...out,
      ...(last < e.lineCount ? [`(more: from_line ${last + 1})`] : []),
    ].join("\n");
  }

  private async readSession(
    projectId: string,
    sessionId: string,
    count: number,
    around?: string,
    tools = false,
    start = false,
  ): Promise<string> {
    const w = this.readable(projectId, sessionId);
    if (!this.host.loadWorkspace(w)) throw new Error(`"${w.name}" cannot be loaded`);
    const agents = new Map([...w.agents.values()].map((a) => [a.info.id, a.info.name]));
    const messages = w.getMessages().filter((x) => x.kind !== "system");
    const at = around ? messages.findIndex((m) => m.id === around) : -1;
    if (around && at < 0) throw new Error(`No message ${around} in "${w.name}"`);
    const shown =
      at >= 0
        ? messages.slice(Math.max(0, at - 5), at + 6)
        : start
          ? messages.slice(0, count)
          : messages.slice(-count);
    const out = [
      `Session ${w.id} "${w.name}" in ${w.cwd} — ${w.isArchived ? "archived" : sessionState(w)} · ${messages.length} messages`,
    ];
    const entries = new Map<string, Array<EntryInfo & { head: string }>>();
    for (const e of await this.host.history.entries(
      w.id,
      shown.map((m) => m.id),
    )) {
      const list = entries.get(e.message) ?? [];
      list.push(e);
      entries.set(e.message, list);
    }
    for (const m of shown) {
      const who = m.from
        ? originLabel(m.from)
        : m.kind === "user"
          ? "user"
          : (agents.get(m.agentId ?? "") ?? "agent");
      const calls = (m.events ?? []).filter((e) => e.kind === "tool_use").length;
      const list = entries.get(m.id);
      const said = list?.find((e) => e.kind === "said" && e.depth === 0);
      out.push(
        "",
        `--- ${who} · ${new Date(m.timestamp).toISOString()} · ${m.status}${calls ? ` · ${calls} tool calls` : ""} · ${m.id}`,
        m.content.length > 3000
          ? `${m.content.slice(0, 3000)} …(truncated${said ? `: read_entry #${said.entry}` : ""})`
          : m.content,
      );
      if (!tools) continue;
      const others = list?.filter((e) => e !== said) ?? [];
      if (!list && m.events?.length) {
        out.push("  (not indexed yet)");
        continue;
      }
      for (const e of others.slice(0, ENTRIES_SHOWN)) {
        out.push(
          `  #${e.entry} ${entryLabel(e)} · ${e.lineCount} lines${e.head ? ` · ${oneLine(e.head, 120)}` : ""}`,
        );
      }
      if (others.length > ENTRIES_SHOWN) {
        out.push(
          `  (+${others.length - ENTRIES_SHOWN} more: search_history with session ${w.id} and message ${m.id})`,
        );
      }
    }
    return out.join("\n");
  }

  // One read-only SQL statement over the histories this lead may read.
  private async queryHistory(projectId: string, query: string): Promise<string> {
    const sessions: SessionRow[] = (await this.scope(projectId, true)).map((w) => ({
      id: w.id,
      name: w.name,
      cwd: w.cwd,
      project: w.projectLink ? (this.store.get(w.projectLink.projectId)?.name ?? null) : null,
      role: w.projectLink?.role ?? null,
      created_at: w.createdAt,
      last_active: w.lastActivityAt,
      archived_at: w.archivedAt,
    }));
    const r = await this.host.history.sql(query, sessions, SQL_ROWS);
    if (r.rows.length === 0) return "(no rows)";
    const cell = (v: SqlValue): string => {
      if (v == null) return "NULL";
      const t = String(v).replace(/\t/g, "  ").replace(/\n/g, "\\n");
      return t.length > CELL_CAP ? `${t.slice(0, CELL_CAP)}…(${t.length - CELL_CAP} more)` : t;
    };
    return [
      r.columns.join("\t"),
      ...r.rows.map((row) => r.columns.map((c) => cell(row[c])).join("\t")),
      `(${r.rows.length} rows${r.truncated ? `, stopped at ${SQL_ROWS}: narrow it or page with limit/offset` : ""})`,
    ].join("\n");
  }

  private listProjects(projectId: string): string {
    const others = this.store.list().filter((p) => p.id !== projectId);
    if (others.length === 0) return "(no other projects)";
    return others
      .map((p) => {
        const lead = this.leadOf(p.id);
        return `- ${p.id} "${p.name}" — ${p.root} — lead ${lead ? sessionState(lead) : "missing"}${p.archivedAt ? " — archived" : ""}`;
      })
      .join("\n");
  }

  private messageProject(projectId: string, targetId: string, text: string): string {
    if (targetId === projectId) throw new Error("That is this project; use message_session");
    const self = this.require(projectId);
    const other = this.require(targetId);
    const lead = this.leadOf(targetId);
    if (!lead) throw new Error(`Project "${other.name}" has no lead`);
    const pair = [projectId, targetId].sort().join(" ");
    const now = Date.now();
    const recent = (this.peerLog.get(pair) ?? []).filter((t) => now - t < PEER_WINDOW_MS);
    if (recent.length >= PEER_LIMIT) {
      throw new Error(
        `${recent.length} messages with "${other.name}" in the last ${PEER_WINDOW_MS / 60_000} minutes; stop here and tell the user`,
      );
    }
    this.deliver(
      lead,
      text,
      { workspaceId: this.leadOf(projectId)?.id ?? "", name: self.name, role: "peer", projectId },
      `[From the lead of project "${self.name}" (${projectId}). If they ask for something, answer with message_project; otherwise no reply is needed.]\n\n${text}`,
    );
    this.peerLog.set(pair, [...recent, now]);
    return `Sent to the lead of "${other.name}". An answer, if any, arrives later as a message from that project.`;
  }

  private listObjectives(
    projectId: string,
    filter: { area?: string; status?: string; archived?: boolean },
  ): string {
    const all = this.board(projectId).list();
    const objectives = all.filter((o): o is Objective => !("error" in o));
    const deps = dependencies(objectives);
    const inView = objectives.filter((o) => !!o.archived === !!filter.archived);
    const shown = inView.filter(
      (o) =>
        (!filter.area || o.area === filter.area) && (!filter.status || o.status === filter.status),
    );
    const broken = all.filter((o): o is BrokenObjective => "error" in o);
    const out: string[] = [];
    let area = "";
    for (const o of shown) {
      if (o.area !== area) {
        area = o.area;
        out.push(`${out.length ? "\n" : ""}## ${area}`);
      }
      const live = o.tasks.filter((t) => t.state !== "dropped");
      const done = live.filter((t) => t.state === "done").length;
      const open = o.decisions.filter((d) => !d.outcome).length;
      const { blockedBy, dropped } = deps.get(o.id)!;
      out.push(
        `- ${o.id} [${o.status}, ${o.priority}] ${o.title} — tasks ${done}/${live.length}` +
          (open ? `, ${open} open decision${open === 1 ? "" : "s"}` : "") +
          (blockedBy.length ? `; blocked by ${blockedBy.join(", ")}` : "") +
          (dropped.length ? `; prerequisite dropped: ${dropped.join(", ")}` : ""),
      );
    }
    for (const b of broken) out.push(`- ${b.id} UNREADABLE: ${b.error}`);
    if (shown.length === 0) {
      // Say what there is, so an empty filter is not taken for an empty board.
      const counts = OBJECTIVE_STATUSES.map(
        (st) => [st, inView.filter((o) => o.status === st).length] as const,
      )
        .filter(([, n]) => n)
        .map(([st, n]) => `${n} ${st}`);
      const archived = objectives.filter((o) => o.archived).length;
      if (!filter.archived && archived) counts.push(`${archived} archived`);
      out.unshift(
        `No ${filter.status ?? ""} objectives here${counts.length ? ` (${counts.join(", ")})` : ""}.`.replace(
          "  ",
          " ",
        ),
      );
    }
    return out.join("\n");
  }

  private readObjective(projectId: string, id: string): string {
    const o = this.objective(projectId, id);
    const objectives = this.objectives(projectId);
    const byId = new Map(objectives.map((x) => [x.id, x]));
    const info = dependencies(objectives).get(o.id)!;
    const ref = (x: string) => {
      const target = byId.get(x);
      if (!target) return `${x} (missing)`;
      const flags = [
        target.status,
        info.blockedBy.includes(x) && "blocking",
        target.archived && "archived",
      ];
      return `${x} (${flags.filter(Boolean).join(", ")})`;
    };
    const session = (sid: string) => {
      const w = this.host.workspace(sid);
      return w ? `${sid} "${w.name}" (${sessionState(w)})` : `${sid} (deleted)`;
    };
    const out = [
      `${o.id} — ${o.title}`,
      `status: ${o.status}${o.archived ? " (archived)" : ""}, priority: ${o.priority}${o.reason ? ` — ${o.reason}` : ""}`,
      `goal: ${o.goal}`,
      `depends on: ${o.dependsOn.map(ref).join(", ") || "nothing"}`,
      `needed by: ${info.unblocks.join(", ") || "nothing"}`,
      `sessions: ${o.sessions.map(session).join(", ") || "none"}`,
      `updated: ${new Date(o.updatedAt).toISOString()}`,
    ];
    if (o.context) out.push("", "context:", o.context);
    out.push("", "tasks:");
    for (const t of o.tasks) {
      out.push(`- ${t.id} [${t.state}] ${t.text}${t.session ? ` (session ${t.session})` : ""}`);
    }
    if (o.tasks.length === 0) out.push("(none)");
    out.push("", "decisions:");
    for (const d of o.decisions) {
      out.push(
        d.outcome
          ? `- ${d.id} settled: ${d.question} → ${d.outcome}`
          : `- ${d.id} open: ${d.question}`,
      );
    }
    if (o.decisions.length === 0) out.push("(none)");
    if (o.notes) out.push("", "notes:", o.notes);
    return out.join("\n");
  }

  private writeObjective(projectId: string, patch: ObjectivePatch): string {
    checkId(patch.id);
    const board = this.board(projectId);
    const current = board.get(patch.id);
    if (current?.archived) throw new Error(`${patch.id} is archived; restore_objective it first`);
    if (!current && (!patch.title || !patch.goal)) {
      throw new Error(`${patch.id} does not exist yet: give it a title and a goal`);
    }
    if (patch.title === "" || patch.goal === "") throw new Error("title and goal cannot be empty");
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as ObjectivePatch;
    const next: Objective = {
      ...(current ?? {
        id: patch.id,
        area: patch.id.split("/")[0],
        title: "",
        goal: "",
        status: "active",
        priority: "normal",
        dependsOn: [],
        tasks: [],
        decisions: [],
        sessions: [],
        updatedAt: 0,
      }),
      ...defined,
    };
    // A reason explains the status or priority it was given with.
    const moved =
      current &&
      ((patch.status && patch.status !== current.status) ||
        (patch.priority && patch.priority !== current.priority));
    if (moved && patch.reason === undefined) delete next.reason;
    for (const key of ["reason", "context", "notes"] as const)
      if (next[key] === "") delete next[key];
    next.dependsOn = [...new Set(next.dependsOn)].filter((d) => d !== next.id);
    for (const d of next.dependsOn) checkId(d);
    const others = this.objectives(projectId).filter((o) => o.id !== next.id);
    const cycle = cycleThrough([...others, next], next.id);
    if (cycle) throw new Error(`That makes a dependency cycle: ${cycle.join(" → ")}`);
    this.saveObjective(projectId, next);
    const known = new Set(others.map((o) => o.id));
    const missing = next.dependsOn.filter((d) => !known.has(d));
    const deps =
      patch.dependsOn !== undefined
        ? ` Depends on: ${next.dependsOn.join(", ") || "nothing"}.`
        : "";
    const warn = missing.length ? ` Not objectives (yet): ${missing.join(", ")}.` : "";
    return `${current ? "Updated" : "Created"} ${next.id} [${next.status}, ${next.priority}].${deps}${warn}`;
  }

  private updateItem(projectId: string, oid: string, itemId: string, patch: ItemPatch): string {
    const o = this.objective(projectId, oid);
    if (o.tasks.some((t) => t.id === itemId)) {
      if (patch.outcome !== undefined)
        throw new Error(`${itemId} is a task; outcome is for decisions`);
      this.saveObjective(projectId, {
        ...o,
        tasks: o.tasks.map((t) =>
          t.id === itemId
            ? {
                ...t,
                ...(patch.text && { text: patch.text }),
                ...(patch.state && { state: patch.state }),
              }
            : t,
        ),
      });
      return `Updated ${o.id} ${itemId}.`;
    }
    if (o.decisions.some((d) => d.id === itemId)) {
      if (patch.state) throw new Error(`${itemId} is a decision; settle it with an outcome`);
      this.saveObjective(projectId, {
        ...o,
        decisions: o.decisions.map((d) => {
          if (d.id !== itemId) return d;
          const next = { ...d, ...(patch.text && { question: patch.text }) };
          if (patch.outcome === "") delete next.outcome;
          else if (patch.outcome !== undefined) next.outcome = patch.outcome;
          return next;
        }),
      });
      return `Updated ${o.id} ${itemId}.`;
    }
    throw new Error(`No item ${itemId} in ${o.id}`);
  }

  // What a worker session is on, for when its own context no longer holds
  // it: the task as the lead gave it, the lead's later messages, and its
  // objectives on the board as they are now.
  private currentTask(workspaceId: string, objectiveId?: string): string {
    const w = this.host.workspace(workspaceId);
    const projectId = w?.projectLink?.projectId;
    if (!w || !projectId) throw new Error("This session belongs to no project");
    if (objectiveId) return this.readObjective(projectId, objectiveId);
    if (!this.host.loadWorkspace(w)) throw new Error(`"${w.name}" cannot be loaded`);
    const fromLead = w.getMessages().filter((m) => m.from?.role === "lead");
    const when = (t: number) => new Date(t).toISOString();
    const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …(cut)` : s);
    const out = [`You are session ${w.id} "${w.name}" in ${w.cwd}.`, ""];
    const [task, ...later] = fromLead;
    out.push(
      task
        ? `The task, as the lead gave it (${when(task.timestamp)}):\n\n${cap(task.content, 6000)}`
        : "(no task from the lead in this session)",
    );
    for (const m of later.slice(-5)) {
      out.push("", `Later from the lead (${when(m.timestamp)}):\n\n${cap(m.content, 2000)}`);
    }
    const mine = this.objectives(projectId).filter(
      (o) => o.sessions.includes(w.id) || o.tasks.some((t) => t.session === w.id),
    );
    for (const o of mine) out.push("", "---", "", this.readObjective(projectId, o.id));
    if (mine.length === 0) out.push("", "(no objective on the board names this session)");
    return out.join("\n");
  }

  // A worker's report to its lead. Finishing moves the tasks it was doing to
  // review; a blocked worker leaves them in progress for the lead to sort out.
  private workerReport(workspaceId: string, text: string, final: boolean, blocked = false): string {
    const w = this.host.workspace(workspaceId);
    const projectId = w?.projectLink?.role === "worker" ? w.projectLink.projectId : undefined;
    const lead = projectId ? this.leadOf(projectId) : undefined;
    if (!w || !projectId || !lead) throw new Error("This session has no project lead");
    if (final) this.markAnswered(w);
    const body = `${!final ? "Progress" : blocked ? "Blocked" : "Finished"}:\n\n${text}`;
    this.deliver(
      lead,
      body,
      { workspaceId: w.id, name: w.name, role: "worker" },
      `[From session "${w.name}" (${w.id})]\n\n${body}`,
    );
    if (final && !blocked) {
      const doing = (t: { session?: string; state: string }) =>
        t.session === w.id && t.state === "doing";
      this.rewrite(
        projectId,
        (o) => o.tasks.some(doing),
        (o) => ({
          ...o,
          tasks: o.tasks.map((t) => (doing(t) ? { ...t, state: "review" as const } : t)),
        }),
      );
    }
    return final ? "Reported to the lead." : "Sent to the lead.";
  }

  private api: PanelApi = {
    projectStatus: (pid) => this.status(pid),
    startSession: (pid, a) => this.startSession(pid, a),
    readSession: (pid, sid, count, around, tools, start) =>
      this.readSession(pid, sid, count, around, tools, start),
    listHistory: (pid, everywhere, limit) => this.listHistory(pid, everywhere, limit),
    searchHistory: (pid, a) => this.searchHistory(pid, a),
    readEntry: (pid, entry, from, count, fromChar) =>
      this.readEntry(pid, entry, from, count, fromChar),
    queryHistory: (pid, query) => this.queryHistory(pid, query),
    messageSession: (pid, sid, text) => {
      const w = this.session(pid, sid);
      const delay = this.spaceStart(w);
      const outcome = this.deliver(w, text, ...this.fromLead(pid, text));
      if (delay > 0) {
        return `Sent to "${w.name}"; it goes out in ${Math.ceil(delay / 1000)} s: starts are spaced out.`;
      }
      return `Sent to "${w.name}"${outcome === "queued" ? " (queued: it is busy)" : ""}.`;
    },
    stopSession: (pid, sid) => {
      const w = this.session(pid, sid);
      this.dropQueuedFromLead(w);
      this.markAnswered(w);
      w.abortAll();
      this.host.persistWorkspace(w);
      return `Stopped "${w.name}".`;
    },
    archiveSession: (pid, sid) => {
      const w = this.session(pid, sid);
      if (w.isArchived) return `"${w.name}" is already archived.`;
      if (!this.host.archiveWorkspace(w)) {
        throw new Error(`"${w.name}" is still working or has queued messages; stop it first`);
      }
      return `Archived "${w.name}".`;
    },
    listObjectives: (pid, filter) => {
      this.require(pid);
      return this.listObjectives(pid, filter);
    },
    readObjective: (pid, id) => {
      this.require(pid);
      return this.readObjective(pid, id);
    },
    currentTask: (wid, oid) => this.currentTask(wid, oid),
    writeObjective: (pid, patch) => {
      this.require(pid);
      return this.writeObjective(pid, patch);
    },
    addItems: (pid, oid, tasks, decisions) => {
      this.require(pid);
      const o = this.objective(pid, oid);
      const next = (prefix: string, ids: string[]) => {
        const n = Math.max(0, ...ids.map((x) => Number(x.slice(1)) || 0));
        return (i: number) => `${prefix}${n + i + 1}`;
      };
      const taskId = next(
        "t",
        o.tasks.map((t) => t.id),
      );
      const decisionId = next(
        "d",
        o.decisions.map((d) => d.id),
      );
      const added = {
        tasks: tasks.map((text, i) => ({ id: taskId(i), text, state: "todo" as const })),
        decisions: decisions.map((question, i) => ({ id: decisionId(i), question })),
      };
      this.saveObjective(pid, {
        ...o,
        tasks: [...o.tasks, ...added.tasks],
        decisions: [...o.decisions, ...added.decisions],
      });
      const ids = [...added.tasks, ...added.decisions].map((x) => x.id);
      return ids.length ? `Added ${ids.join(", ")} to ${o.id}.` : "Nothing to add.";
    },
    updateItem: (pid, oid, itemId, patch) => {
      this.require(pid);
      return this.updateItem(pid, oid, itemId, patch);
    },
    deleteObjective: (pid, id) => {
      this.require(pid);
      const o = this.objective(pid, id);
      const dependents = this.objectives(pid).filter((x) => x.dependsOn.includes(o.id));
      this.board(pid).remove(o.id);
      this.changed(pid);
      const left = dependents.length
        ? ` Still listed as a prerequisite by ${dependents.map((x) => x.id).join(", ")}.`
        : "";
      return `Deleted ${o.id}.${left}`;
    },
    listProjects: (pid) => {
      this.require(pid);
      return this.listProjects(pid);
    },
    messageProject: (pid, target, text) => this.messageProject(pid, target, text),
    workerReport: (wsId, text, final, blocked) => this.workerReport(wsId, text, final, blocked),
    archiveObjective: (pid, id) => {
      this.require(pid);
      const o = this.objective(pid, id);
      if (o.archived) return `${o.id} is already archived.`;
      if (o.status !== "done" && o.status !== "dropped") {
        throw new Error(`${o.id} is ${o.status}; only done or dropped objectives are archived`);
      }
      this.board(pid).move(o.id, true);
      this.changed(pid);
      return `Archived ${o.id}.`;
    },
    restoreObjective: (pid, id) => {
      this.require(pid);
      const o = this.objective(pid, id);
      if (!o.archived) return `${o.id} is not archived.`;
      this.board(pid).move(o.id, false);
      this.changed(pid);
      return `Restored ${o.id} [${o.status}].`;
    },
  };
}

// How the workspace marks a turn cut off (a stop, a restart).
const INTERRUPTED = "*\\[interrupted\\]*";

// A message the project's current lead sent (not one from before the project
// was deleted and the worker adopted again).
function fromLead(m: { from?: MessageOrigin }, lead: Workspace | undefined): boolean {
  return m.from?.role === "lead" && !!lead && m.from.workspaceId === lead.id;
}

function claudeModels(): string[] {
  return MODEL_OPTIONS.filter((m) => m.backend === "claude").map((m) => m.id);
}

function sessionState(w: Workspace): "archived" | "working" | "waiting to start" | "idle" {
  if (w.isArchived) return "archived";
  if ([...w.agents.values()].some((a) => a.session.isRunning)) return "working";
  return w.messages.some((m) => m.status === "queued") ? "waiting to start" : "idle";
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Words, and "quoted phrases" kept whole.
function queryTerms(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

// What an entry of the history is, on one line.
function entryLabel(e: Pick<EntryInfo, "kind" | "role" | "tool" | "depth">): string {
  const what =
    e.kind === "said" ? `said by ${e.role ?? "?"}` : e.tool ? `${e.kind} ${e.tool}` : e.kind;
  return e.depth > 0 ? `${what}, in a subagent` : what;
}

function entryHeader(e: EntryInfo, name: string | undefined): string {
  return `#${e.entry} · ${e.session} "${name ?? "?"}" · ${new Date(e.ts).toISOString()} · ${entryLabel(e)} · message ${e.message}`;
}
