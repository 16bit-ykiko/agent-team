# Discord Agent Team — 项目规格书

## 概述

基于 Discord Bot + Claude Code CLI 构建一个多 Agent 协作系统。3 个 Bot（Planner、Coder、Reviewer）在 Discord Thread 中协作完成编程任务，每个 Thread 是一个独立任务，支持多任务并行、独立工作目录。

## 架构

```
用户（Discord）
  │
  ├── Thread: "clice2 - 修复 bug"
  │     ├── 🧠 Planner Bot  → claude --cwd /home/ykiko/C++/clice2
  │     ├── 💻 Coder Bot     → claude --cwd /home/ykiko/C++/clice2
  │     └── 🔍 Reviewer Bot  → claude --cwd /home/ykiko/C++/clice2
  │
  └── Thread: "eventide - 重构 serde"
        ├── 🧠 Planner Bot  → claude --cwd /home/ykiko/C++/eventide
        ├── 💻 Coder Bot     → claude --cwd /home/ykiko/C++/eventide
        └── 🔍 Reviewer Bot  → claude --cwd /home/ykiko/C++/eventide
```

- 每个 Bot 是一个独立的 Discord Bot（独立 token、独立进程）
- 每个 Thread 对应一组独立的 Claude Code session
- 每个 session 是一个 `claude` 子进程，通过 `--cwd` 指定工作目录
- 多个 Thread 的 session 并行运行，互不干扰

## 三个 Bot 的角色

### Planner（项目经理）

- **用户唯一入口**：用户 @Planner 描述需求
- 拆解任务，制定实现计划
- 将具体编码任务发给 Coder
- 收集 Reviewer 的反馈，决定是否需要 Coder 修改
- 最终汇总结果回复用户

### Coder（开发者）

- 接收 Planner 分配的任务
- 在指定工作目录中编写代码
- 完成后通知 Reviewer 进行 review
- 根据 Reviewer 反馈修改代码

### Reviewer（审查者）

- 接收 Coder 的 review 请求
- 检查代码正确性、风格、测试覆盖
- 提出修改意见发给 Coder，或确认通过发给 Planner

## 工作流程

```
用户 @Planner: "帮我实现 XXX 功能"
  │
  ▼
Planner: 分析需求，拆解任务，@Coder 分配
  │
  ▼
Coder: 编写代码，@Reviewer 请求 review
  │
  ▼
Reviewer: review 代码
  ├── 有问题 → @Coder 修改 → 循环
  └── 通过 → @Planner 汇报
  │
  ▼
Planner: 汇总结果，回复用户
```

## 任务管理

### 创建任务

用户在指定频道发消息或用 slash command：

```
/task create --name "修复 pointer_name" --cwd /home/ykiko/C++/eventide
```

Bot 自动创建 Thread，三个 Bot 加入，各自初始化对应 cwd 的 Claude Code session。

### 会话路由

```python
# 每个 bot 维护
sessions: dict[int, ClaudeSession] = {}  # thread_id -> session

# 消息进来时
async def on_message(message):
    thread_id = message.channel.id
    session = sessions.get(thread_id)
    if session is None:
        return  # 不属于自己管理的 thread
    response = await session.send(message.content)
    await message.channel.send(response)
```

### Bot 间通信

在同一个 Thread 中，Bot 之间通过 Discord 消息 @mention 通信：

- Planner 发消息 @Coder → Coder 的 `on_message` 收到并处理
- Coder 发消息 @Reviewer → Reviewer 的 `on_message` 收到并处理

简单直接，无需额外的 IPC 机制。所有通信对用户可见。

## Claude Code Session 管理

### 启动

```python
class ClaudeSession:
    def __init__(self, cwd: str, system_prompt: str):
        self.process = subprocess.Popen(
            ["claude", "--cwd", cwd, "--system-prompt", system_prompt, "--json"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    async def send(self, message: str) -> str:
        # 写入 stdin，读取 stdout
        ...

    def close(self):
        self.process.terminate()
```

### System Prompt

每个 Bot 的 system prompt 定义其角色行为：

- **Planner**: "你是项目经理。分析用户需求，拆解为具体任务。不要自己写代码，将任务分配给 @Coder。"
- **Coder**: "你是开发者。根据任务要求编写代码。完成后 @Reviewer 请求 review。"
- **Reviewer**: "你是代码审查者。检查代码正确性、风格和测试覆盖。有问题 @Coder，通过则 @Planner。"

### Thinking Budget

支持配置 Claude 的 thinking budget：

```python
claude_args = ["claude", "--cwd", cwd]
if thinking_budget:
    claude_args.extend(["--thinking-budget", str(thinking_budget)])
```

## 配置

```toml
[discord]
planner_token = "xxx"
coder_token = "xxx"
reviewer_token = "xxx"
guild_id = "xxx"
task_channel_id = "xxx"      # 创建 thread 的主频道

[defaults]
thinking_budget = 10000       # 默认 thinking budget
```

## 技术栈

- Python 3.12+
- `discord.py` — Discord Bot 框架
- `asyncio.subprocess` — 管理 Claude Code 子进程
- `tomllib` — 配置解析

## 非目标（第一版不做）

- Cron 定时任务
- Web UI
- 持久化会话（重启后 session 丢失是可以接受的）
- 多 server 支持（只跑在一个 Discord server 里）
