// Turns a hand-kept bug list into a project's issue files: a directory of
// markdown files, one per module ("# §2 title"), groups under "## 2.1 title"
// with tables of 条目 | 状态 | 问题 | 位置, an "## 已接受（只记不修）" section at
// the end of each (table rows or bullets), and a README with the 速查 table.
// Only reads the list; writes the modules and a report of what did not fit
// into a fresh directory, to be looked over before it is copied into
// .agent-team/projects/<id>/issues/.
//
//   npm run import-issues -- <list dir> <out dir> [<objectives dir>]
//
// With the project's objectives dir, an issue a task names by id is linked
// to that task's objective.
import * as fs from "fs";
import * as path from "path";
import { ObjectiveStore, type Objective } from "../service/src/project/objectives";
import {
  locate,
  parseModule,
  serializeModule,
  type Evidence,
  type Issue,
  type IssueGroup,
  type IssueModule,
  type IssueState,
} from "../service/src/project/issues";

const [listArg, outArg, objectivesArg] = process.argv.slice(2);
if (!listArg || !outArg) {
  throw new Error("usage: npm run import-issues -- <list dir> <out dir> [<objectives dir>]");
}
// npm runs scripts from the package root; a relative path is the caller's.
const at = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
const listDir = at(listArg);
const outDir = at(outArg);
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
  throw new Error(`${outDir} is not empty; give a new directory`);
}

// Words of the 状态 column's brackets that are tags; the rest of a bracket
// stays in the text.
const TAGS: Record<string, string> = {
  低: "低",
  性能: "性能",
  不可达: "不可达",
  不可达级: "不可达",
  部分: "部分",
  Windows: "Windows",
  常见: "常见",
  TODO: "TODO",
  崩溃: "崩溃",
  上游: "上游",
};
const SEVERE = "严重";
const ID = /^(\d\d-\d\d#F?\d+|h\d+r\d+#\d+|h\d+v#\d+|F\d+(?:-[A-Z])?|ro#\d+)$/;
const LEADING_ID = /^(?:§[\d.]+\s+)?(\d\d-\d\d#\d+|h\d+r\d+#\d+|h\d+v#\d+|F\d+)/;

// A paragraph wrapped over lines: no space where the break falls between
// two CJK characters.
const CJK = /[　-〿㐀-鿿＀-￯]/;
function unwrap(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .reduce((acc, l) => {
      if (!acc) return l;
      const joint = CJK.test(acc.at(-1)!) && CJK.test(l[0]) ? "" : " ";
      return acc + joint + l;
    }, "");
}

function paragraphs(lines: string[]): string | undefined {
  const out: string[] = [];
  let run: string[] = [];
  for (const l of [...lines, ""]) {
    if (l.trim()) run.push(l);
    else if (run.length) {
      out.push(unwrap(run));
      run = [];
    }
  }
  return out.length ? out.join("\n\n") : undefined;
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

interface Status {
  state?: IssueState;
  evidence?: Evidence;
  tags: string[];
  // The cell as written, when it says more than the evidence and tags.
  note?: string;
}

function parseStatus(cell: string): Status {
  const parts = [...cell.matchAll(/[（(]([^）)]*)[）)]/g)]
    .flatMap((m) => m[1].split(/[，、；,;]\s*/))
    .map((p) => p.trim())
    .filter(Boolean);
  const tags = new Set<string>();
  for (const p of parts) {
    const tag = TAGS[p] ?? (p.startsWith("回归") ? "回归" : undefined);
    if (tag) tags.add(tag);
  }
  const accepted = /^(接受|取舍)/.test(cell) || cell.includes("已接受");
  const decision = !accepted && cell.includes("决策项");
  // Says no more than the state, the evidence and the tags.
  const plain =
    /^(决策项|接受)?([RVHSC]|R、V)?(（[^）]*）)?$/.test(cell) &&
    parts.every((p) => TAGS[p] || p === "已接受" || p === "决策项");
  const evidence = /^[RVHSC]/.exec(cell)?.[0] as Evidence | undefined;
  return {
    ...(accepted ? { state: "accepted" as const } : decision ? { state: "decision" as const } : {}),
    ...(evidence && { evidence }),
    tags: [...tags],
    ...(!plain && cell && { note: cell }),
  };
}

const report: string[] = [];
const irregular: string[] = [];
const notes: string[] = [];
const pending: Array<{ issue: Issue; module: string; label: string }> = [];

function reproOf(id: string, root: string): string | undefined {
  const dated = /^(\d\d-\d\d)#(\d+)$/.exec(id);
  const names = dated
    ? [`${dated[1]}-${dated[2].padStart(3, "0")}`, `${dated[1]}-${dated[2]}`]
    : [id, id.replace("#", "-")];
  for (const n of names) {
    const file = path.join(listDir, "..", "repro", n, "run.sh");
    if (fs.existsSync(file)) return path.relative(root, file);
  }
  return undefined;
}

function repositoryRoot(dir: string): string {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
  }
  return path.dirname(dir);
}
const root = repositoryRoot(listDir);

function issueText(problem: string, location: string, extra: string[]): string {
  const lines = [problem];
  if (location) lines.push(`位置：${location}`);
  return [...lines, ...extra].filter(Boolean).join("\n\n");
}

function parseFile(file: string): IssueModule {
  const id = path.basename(file, ".md");
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const title = (lines[0] ?? "").replace(/^#\s*/, "").replace(/^§\d+\s*/, "");
  const module: IssueModule = {
    id,
    title,
    objectives: [],
    issues: [],
    groups: [],
    updatedAt: Date.now(),
  };
  const moduleNotes: string[] = [];
  let group: IssueGroup | null = null;
  let groupNotes: string[] = [];
  let accepted = false;
  let bullet: string[] | null = null;

  const closeGroup = () => {
    if (group) {
      const n = paragraphs(groupNotes);
      if (n) group.notes = n;
    }
    groupNotes = [];
  };
  const add = (issue: Issue, label: string) => {
    (group && !accepted ? group : module).issues.push(issue);
    if (!ID.test(label)) pending.push({ issue, module: id, label });
  };
  const flushBullet = () => {
    if (!bullet) return;
    const text = unwrap(bullet);
    bullet = null;
    const lead = LEADING_ID.exec(text);
    const tags = new Set<string>();
    const bracket = /^[^（(]{0,40}[（(]([^）)]*)[）)]/.exec(text)?.[1] ?? "";
    for (const p of bracket.split(/[，、；,;]\s*/)) if (TAGS[p.trim()]) tags.add(TAGS[p.trim()]);
    add(
      {
        id: lead?.[1] ?? "",
        state: "accepted",
        tags: [...tags],
        text,
        objectives: [],
      },
      lead?.[1] ?? text.slice(0, 40),
    );
  };

  for (const line of lines.slice(1)) {
    if (bullet && /^\s{2,}\S/.test(line)) {
      bullet.push(line);
      continue;
    }
    flushBullet();
    if (line.startsWith("## ")) {
      closeGroup();
      const heading = line.slice(3).trim();
      if (heading.includes("已接受")) {
        accepted = true;
        group = null;
        continue;
      }
      accepted = false;
      const m = /^(\d+(?:\.\d+)*)\s+(.*)$/.exec(heading);
      group = {
        id: m ? m[1] : `g${module.groups.length + 1}`,
        title: m ? m[2] : heading,
        objectives: [],
        issues: [],
      };
      if (!m) irregular.push(`- ${id}: group "${heading}" has no number; its id is ${group.id}`);
      module.groups.push(group);
      continue;
    }
    if (line.startsWith("|")) {
      const cells = cellsOf(line);
      if (cells[0] === "条目" || cells.every((c) => /^[-: ]*$/.test(c))) continue;
      const [label, ...rest] = cells;
      const four = rest.length >= 3;
      const status = four ? parseStatus(rest[0]) : { tags: [] };
      const problem = (four ? rest.slice(1, -1) : rest.slice(0, -1)).join(" | ");
      const location = rest.at(-1) ?? "";
      if (rest.length > 3) {
        irregular.push(`- ${id} ${label}: an unescaped | split the row; joined again`);
      }
      const [first, ...aliases] = label.split(/\s*(?:、|\s\/\s)\s*/);
      const extra: string[] = [];
      if (aliases.length) extra.push(`别名：${aliases.join("、")}`);
      if (status.note) extra.push(`状态：${status.note}`);
      const own = /^(\S+)（(.*)）$/.exec(first);
      const issueId = own ? own[1] : first;
      if (own) extra.push(`别名：${own[2]}`);
      const repro = ID.test(issueId) ? reproOf(issueId, root) : undefined;
      if (repro) extra.push(`复现：\`${repro}\``);
      if (/已修/.test(problem.slice(0, 40))) {
        notes.push(`- ${issueId} (${id}) says it is fixed: ${problem.slice(0, 60)}…`);
      }
      add(
        {
          id: issueId,
          state: accepted ? "accepted" : (status.state ?? "open"),
          ...(status.evidence && { evidence: status.evidence }),
          tags: status.tags,
          text: issueText(problem, location, extra),
          objectives: [],
        },
        issueId,
      );
      continue;
    }
    if (line.startsWith("- ") && accepted) {
      bullet = [line.slice(2)];
      continue;
    }
    if (accepted) {
      if (line.trim() && !/^(review 收敛后只记不修|无。)/.test(line.trim())) {
        irregular.push(`- ${id}: text in 已接受 kept as module notes: ${line.slice(0, 60)}`);
        moduleNotes.push(line);
      }
      continue;
    }
    (group ? groupNotes : moduleNotes).push(line);
  }
  flushBullet();
  closeGroup();
  const n = paragraphs(moduleNotes);
  if (n) module.notes = n;
  return module;
}

const files = fs
  .readdirSync(listDir)
  .filter((f) => /^\d+-.*\.md$/.test(f))
  .sort();
const modules = files.map((f) => parseFile(path.join(listDir, f)));

// What has no id of its own, or one taken already, gets the next of today.
const today = new Date();
const prefix = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const seen = new Set<string>();
const all = modules.flatMap((m) => [...m.issues, ...m.groups.flatMap((g) => g.issues)]);
let next = Math.max(
  0,
  ...all.map((x) => (x.id.startsWith(`${prefix}#`) ? Number(x.id.slice(6)) || 0 : 0)),
);
for (const m of modules) {
  for (const x of [...m.issues, ...m.groups.flatMap((g) => g.issues)]) {
    const p = pending.find((e) => e.issue === x);
    if (x.id && !seen.has(x.id) && !p) {
      seen.add(x.id);
      continue;
    }
    const was = x.id;
    x.id = `${prefix}#${++next}`;
    seen.add(x.id);
    if (p) {
      const label = p.label.length > 40 ? `${p.label}…` : p.label;
      if (!x.text.includes(p.label)) x.text = `原条目：${p.label}\n\n${x.text}`;
      irregular.push(`- ${m.id}: "${label}" has no id; it is ${x.id}`);
    } else {
      x.text = `原编号：${was}（重复）\n\n${x.text}`;
      irregular.push(`- ${m.id}: ${was} is there twice; the second is ${x.id}`);
    }
  }
}

// The 速查 table: every id it names is severe.
const severe = new Set<string>();
const readme = path.join(listDir, "README.md");
if (fs.existsSync(readme)) {
  const text = fs.readFileSync(readme, "utf-8");
  const table = text.split(/^## /m).find((s) => s.startsWith("崩溃"));
  for (const line of (table ?? "").split("\n").filter((l) => l.startsWith("|"))) {
    const cell = cellsOf(line)[1] ?? "";
    for (const m of cell.matchAll(/(\d\d-\d\d)#(\d+)(?:\s*\/\s*#(\d+))?/g)) {
      severe.add(`${m[1]}#${m[2]}`);
      if (m[3]) severe.add(`${m[1]}#${m[3]}`);
    }
  }
}
const { byId } = locate(modules);
for (const id of severe) {
  const x = byId.get(id)?.issue;
  if (x && !x.tags.includes(SEVERE)) x.tags.push(SEVERE);
  if (!x) irregular.push(`- 速查 names ${id}, which is not in the list`);
}

// Tasks that name an issue link it to their objective.
const links: string[] = [];
if (objectivesArg) {
  const objectives = new ObjectiveStore(at(objectivesArg))
    .list()
    .filter((o): o is Objective => !("error" in o) && !o.archived);
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length);
  const escaped = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![A-Za-z0-9_#-])(?:${escaped.join("|")})(?![A-Za-z0-9_#])`, "g");
  for (const o of objectives) {
    for (const t of o.tasks) {
      for (const m of t.text.matchAll(pattern)) {
        const x = byId.get(m[0])!.issue;
        if (x.objectives.includes(o.id)) continue;
        x.objectives.push(o.id);
        links.push(`- ${m[0]} → ${o.id} (${t.id}: ${t.text.slice(0, 60)})`);
      }
    }
  }
}

// The README's table of counts, to check nothing went missing.
const expected = new Map<string, [number, number]>();
if (fs.existsSync(readme)) {
  for (const line of fs.readFileSync(readme, "utf-8").split("\n")) {
    const c = cellsOf(line);
    if (c.length >= 5 && /\.md$/.test(c[1]) && /^\d+$/.test(c[3])) {
      expected.set(c[1].replace(/\.md$/, ""), [Number(c[3]), Number(c[4])]);
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
const counts: string[] = [];
let open = 0;
let accepted = 0;
for (const m of modules) {
  const text = serializeModule(m);
  parseModule(m.id, text);
  fs.writeFileSync(path.join(outDir, `${m.id}.toml`), text);
  const issues = [...m.issues, ...m.groups.flatMap((g) => g.issues)];
  const o = issues.filter((x) => x.state !== "accepted").length;
  const a = issues.length - o;
  open += o;
  accepted += a;
  const want = expected.get(m.id);
  const off = want && (want[0] !== o || want[1] !== a) ? `README: ${want[0]} / ${want[1]}` : "";
  counts.push(`| ${m.id} | ${o} | ${a} | ${off} |`);
}

report.push(
  `# Import of ${listDir}`,
  "",
  `${modules.length} modules, ${open} to fix (open or to decide), ${accepted} accepted.`,
  "",
  "| module | to fix | accepted | |",
  "|---|---|---|---|",
  ...counts,
  "",
  "## Did not fit as written",
  "",
  ...(irregular.length ? irregular : ["(nothing)"]),
  "",
  "## Say they are fixed: close them once the fix is merged",
  "",
  ...(notes.length ? notes : ["(none)"]),
  "",
  `## Tagged ${SEVERE} (the 速查 table)`,
  "",
  [...severe].join(", ") || "(none)",
  "",
  "## Linked to objectives (a task names them)",
  "",
  ...(links.length ? links : ["(none)"]),
);
fs.writeFileSync(path.join(outDir, "import-report.md"), report.join("\n") + "\n");
console.log(`${modules.length} modules, ${open} to fix, ${accepted} accepted → ${outDir}`);
console.log(`Report: ${path.join(outDir, "import-report.md")}`);
