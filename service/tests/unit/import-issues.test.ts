// scripts/import-issues.ts over a small list written the way clice's is:
// what lands where, what is reported, and what is linked.
import { it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseModule, type Issue } from "../../src/project/issues";
import { tmpDir } from "./projectHarness";

const ROOT = path.resolve(__dirname, "../../..");

const MODULE = `# §1 命令行（src/command/）

模块说明第一行，
接着第二行。

## 1.1 参数渲染

同一根子：渲染不对。

| 条目 | 状态 | 问题 | 位置 |
|---|---|---|---|
| 10-01#1 | R（低，Windows） | （少见）\`cl\` 参数丢了 | command.cpp:10 |
| 10-01#2 | V（CI 一次，run 123） | 光标在 \`printf|("x")\` 末尾 | a.cpp |
| h1r3#1、09-27#19 | R、V | 同一根子 | b.cpp |
| 10-01#3 | 决策项 | 算不算缺陷？ | c.cpp |

## 已接受（只记不修）

review 收敛后只记不修的边角；不计入待修，真实用户撞上再说。

| 条目 | 状态 | 问题 | 位置 |
|---|---|---|---|
| 10-01#4 | 接受（#784 review） | 只记 | d.cpp |

- F13-B（低，H）：长条目
  续上一行。
- 没有编号的一条
`;

const README = `# 清单

> 纪律：C/H 动手前先复核。

| § | 文件 | 主题 | 待修 | 已接受 |
|---|---|---|---|---|
| 1 | 01-command.md | 命令行 | 4 | 3 |

## 崩溃 / 挂死 / 数据丢失速查

| 组 | 条目 |
|---|---|
| 崩溃 | **10-01#1** 崩；10-01#2 / #3 也是 |
`;

const OBJECTIVE = (state: string, text: string) => `title = "T"
goal = "G"

[[tasks]]
id = "t1"
text = ${JSON.stringify(text)}
state = "${state}"
`;

it("turns a markdown bug list into issue files and a report", () => {
  const base = tmpDir();
  const list = path.join(base, "temp", "issues");
  fs.mkdirSync(list, { recursive: true });
  fs.mkdirSync(path.join(base, ".git"));
  fs.writeFileSync(path.join(list, "01-command.md"), MODULE);
  fs.writeFileSync(path.join(list, "README.md"), README);
  fs.mkdirSync(path.join(base, "temp", "repro", "10-01-001"), { recursive: true });
  fs.writeFileSync(path.join(base, "temp", "repro", "10-01-001", "run.sh"), "");
  const objectives = path.join(base, "objectives");
  fs.mkdirSync(path.join(objectives, "a"), { recursive: true });
  fs.writeFileSync(path.join(objectives, "a", "todo.toml"), OBJECTIVE("todo", "修 10-01#1、#2"));
  fs.writeFileSync(path.join(objectives, "a", "done.toml"), OBJECTIVE("done", "10-01#3 转 a/todo"));
  const out = path.join(base, "out");

  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules/tsx/dist/cli.mjs"),
      path.join(ROOT, "scripts/import-issues.ts"),
      list,
      out,
      objectives,
    ],
    { stdio: "pipe" },
  );

  const m = parseModule("01-command", fs.readFileSync(path.join(out, "01-command.toml"), "utf-8"));
  expect(m.title).toBe("命令行（src/command/）");
  expect(m.notes).toBe("模块说明第一行，接着第二行。");
  const [g] = m.groups;
  expect({ id: g.id, title: g.title, notes: g.notes }).toEqual({
    id: "1.1",
    title: "参数渲染",
    notes: "同一根子：渲染不对。",
  });
  const byId = new Map<string, Issue>([...m.issues, ...g.issues].map((x) => [x.id, x]));
  expect([...byId.keys()]).toEqual([
    "10-01#4",
    "F13-B",
    "imp#1",
    "10-01#1",
    "10-01#2",
    "h1r3#1",
    "10-01#3",
  ]);

  const one = byId.get("10-01#1")!;
  expect(one).toMatchObject({ state: "open", evidence: "R", objectives: ["a/todo"] });
  expect(one.tags.sort()).toEqual(["Windows", "严重", "低"].sort());
  expect(one.text).toBe(
    "（少见）`cl` 参数丢了\n\n位置：command.cpp:10\n\n复现：`temp/repro/10-01-001/run.sh`",
  );
  // An unescaped | in code is kept as it was; a note on the evidence stays.
  expect(byId.get("10-01#2")!.text).toContain('`printf|("x")`');
  expect(byId.get("10-01#2")!.text).toContain("状态：V（CI 一次，run 123）");
  expect(byId.get("10-01#2")!.objectives).toEqual(["a/todo"]);
  expect(byId.get("h1r3#1")!.text).toContain("别名：09-27#19");
  expect(byId.get("h1r3#1")!.text).toContain("状态：R、V");
  // Named only by a finished task: not linked.
  expect(byId.get("10-01#3")).toMatchObject({ state: "decision", objectives: [] });
  expect(byId.get("10-01#4")).toMatchObject({ state: "accepted", tags: [] });
  expect(byId.get("F13-B")).toMatchObject({ state: "accepted", evidence: "H", tags: ["低"] });
  expect(byId.get("F13-B")!.text).toBe("F13-B（低，H）：长条目续上一行。");
  expect(byId.get("imp#1")).toMatchObject({ state: "accepted", text: "没有编号的一条" });

  const report = fs.readFileSync(path.join(out, "import-report.md"), "utf-8");
  expect(report).toContain("| 01-command | 4 | 3 |  |");
  expect(report).toContain('"没有编号的一条" has no id; it is imp#1');
  expect(report).toContain("10-01#1, 10-01#2, 10-01#3");
  expect(report).toContain("- a/done: 10-01#3");
  expect(report).toContain("> 纪律：C/H 动手前先复核。");
});
