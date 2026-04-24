"""Discord bot — single bot that manages all agent sessions per task."""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import aiohttp
import discord

from src.formatter import format_for_discord, split_message
from src.orchestrator import Orchestrator, TaskSpec
from src.prompts import ROLE_PROMPTS
from src.session import StreamEvent, create_session, restore_session

log = logging.getLogger(__name__)

STATE_DIR = ".cache"
CHAT_LOG_DIR = ".logs/chats"
STREAM_LOG_DIR = ".logs/streams"


class TaskContext:
    """All sessions and state for a single task thread."""

    def __init__(self, thread_id: int, cwd: str, config: dict):
        self.thread_id = thread_id
        self.cwd = cwd
        self.log_thread_id: int | None = None
        self.sessions: dict[str, object] = {}  # role -> Session
        self.spec: TaskSpec | None = None
        self.mode: str = "discuss"  # "discuss" or "execute"

        # Create sessions for each agent role
        agents_config = config.get("agents", {})
        for role, prompt in ROLE_PROMPTS.items():
            agent_cfg = agents_config.get(role, {})
            self.sessions[role] = create_session(
                backend=agent_cfg.get("backend", "claude"),
                cwd=cwd,
                system_prompt=prompt,
                model=agent_cfg.get("model", "opus"),
                effort=agent_cfg.get("effort", "max"),
                permission_mode=agent_cfg.get("permission_mode", "bypassPermissions"),
            )

    def to_state(self) -> dict:
        return {
            "thread_id": self.thread_id,
            "cwd": self.cwd,
            "log_thread_id": self.log_thread_id,
            "mode": self.mode,
            "sessions": {role: s.to_state() for role, s in self.sessions.items()},
            "spec": self.spec.to_dict() if self.spec else None,
        }


class AgentTeamBot:
    """Single Discord bot that manages multi-agent task workflows."""

    DEBOUNCE_SECONDS = 3

    def __init__(self, token: str, config: dict):
        self.token = token
        self.config = config

        proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
        intents = discord.Intents.default()
        intents.message_content = True
        self.client = discord.Client(intents=intents, proxy=proxy)
        self.tasks: dict[int, TaskContext] = {}  # thread_id -> TaskContext

        # Debounce state
        self._pending: dict[int, list[str]] = {}
        self._debounce_tasks: dict[int, asyncio.Task] = {}
        self._debounce_meta: dict[int, discord.Message] = {}

        self._setup_events()

    def _setup_events(self):
        @self.client.event
        async def on_ready():
            log.info(
                "Bot ready as %s (ID: %s)",
                self.client.user,
                self.client.user.id,
            )

        @self.client.event
        async def on_message(message: discord.Message):
            await self._on_message(message)

    # ------------------------------------------------------------------
    # Message handling with debounce
    # ------------------------------------------------------------------

    async def _on_message(self, message: discord.Message):
        if message.author == self.client.user:
            return
        if not isinstance(message.channel, discord.Thread):
            return

        thread_id = message.channel.id
        if thread_id not in self.tasks:
            return

        is_mentioned = self.client.user.mentioned_in(message)
        is_follow_up = thread_id in self._pending
        if not is_mentioned and not is_follow_up:
            return

        content = message.content
        for mention_str in [
            f"<@{self.client.user.id}>",
            f"<@!{self.client.user.id}>",
        ]:
            content = content.replace(mention_str, "").strip()
        if not content:
            return

        if thread_id not in self._pending:
            self._pending[thread_id] = []
            self._debounce_meta[thread_id] = message
        self._pending[thread_id].append(content)

        if thread_id in self._debounce_tasks:
            self._debounce_tasks[thread_id].cancel()
        self._debounce_tasks[thread_id] = asyncio.create_task(
            self._debounce_process(thread_id)
        )

    async def _debounce_process(self, thread_id: int):
        await asyncio.sleep(self.DEBOUNCE_SECONDS)

        parts = self._pending.pop(thread_id, [])
        message = self._debounce_meta.pop(thread_id, None)
        self._debounce_tasks.pop(thread_id, None)

        if not parts or not message:
            return

        combined = "\n".join(parts)
        log.info("Thread %d received: %s", thread_id, combined[:100])
        self._log_chat(thread_id, "user", str(message.author), combined)

        task = self.tasks.get(thread_id)
        if not task:
            return

        channel = message.channel

        if task.mode == "discuss":
            await self._handle_discuss(task, channel, combined)
        elif task.mode == "execute":
            # During execution, user messages go to planner for guidance
            await self._handle_discuss(task, channel, combined)

    # ------------------------------------------------------------------
    # Discussion mode (Planner talks to user)
    # ------------------------------------------------------------------

    async def _handle_discuss(
        self, task: TaskContext, channel: discord.Thread, content: str
    ):
        planner = task.sessions.get("planner")
        if not planner:
            return

        log_thread = await self._get_log_thread(task)

        # Spec-gen auto-trigger is disabled — low efficiency in current form.
        # The `_generate_and_execute_spec` + Orchestrator code is kept for
        # later revival, but no keyword in chat will invoke it now.

        # Log the user's prompt going to planner
        await self._notify_log(
            log_thread, f"### → Planner (discuss)\n```\n{content}\n```"
        )

        result_text = ""
        try:
            async with channel.typing():
                async for event in planner.stream(content):
                    self._log_stream(task.thread_id, "planner", event)
                    if event.kind in ("result", "text"):
                        result_text = event.content
                    elif event.kind == "error":
                        result_text = event.content
                    elif log_thread and event.kind in (
                        "thinking",
                        "tool_use",
                        "tool_result",
                    ):
                        await self._notify_log(log_thread, event.content)
        except Exception as e:
            log.error("Discuss stream crashed: %s", e, exc_info=True)
            if not result_text:
                result_text = f"[Stream crashed] {e}"

        self.save_state()

        if result_text:
            self._log_chat(task.thread_id, "bot", "Planner", result_text)
            await self._notify_log(
                log_thread,
                f"### ← Planner response ({len(result_text)} chars)\n{result_text}",
            )
            for chunk in format_for_discord(result_text):
                await self._send_with_retry(channel, chunk)

    # ------------------------------------------------------------------
    # Spec generation and execution
    # ------------------------------------------------------------------

    async def _generate_and_execute_spec(
        self, task: TaskContext, channel: discord.Thread, content: str
    ):
        await self._send_with_retry(
            channel,
            "Generating structured spec... (详细工具调用见 log thread)",
        )

        planner = task.sessions["planner"]
        log_thread = await self._get_log_thread(task)
        await self._notify_log(
            log_thread,
            "### ▶ Spec generation started\n"
            f"User trigger: ```\n{content}\n```",
        )
        spec_prompt = (
            f"{content}\n\n"
            "Based on our discussion, write a task spec in Markdown that tells "
            "three downstream agents (Coder, Reviewer, Validator) how to do "
            "their jobs. Output ONLY Markdown in EXACTLY this shape:\n\n"
            "## Goal\n"
            "<one-sentence outcome>\n\n"
            "## Context\n"
            "<shared background: motivation, constraints, non-goals, "
            "key decisions already made>\n\n"
            "## Items\n\n"
            "### 1. <short title>\n\n"
            "#### Coder\n"
            "<what to build, which files/modules to touch, design decisions "
            "already made, pitfalls to avoid>\n\n"
            "#### Reviewer\n"
            "<what to scrutinize: correctness invariants, style concerns, "
            "scope-creep to catch, specific risky areas>\n\n"
            "#### Validator\n"
            "<exact verification steps — commands to run, expected output, "
            "tests/builds/grep-checks that must pass>\n\n"
            "### 2. <next title>\n"
            "...\n\n"
            "Strict rules:\n"
            "- Do NOT wrap the whole response in ``` fences.\n"
            "- Every item MUST have all three subsections "
            "(Coder, Reviewer, Validator), with exactly those headings.\n"
            "- Number items as `### 1.`, `### 2.`, etc.\n"
            "- Inside each subsection you may use sub-lists, inline code, "
            "and fenced code blocks freely.\n"
            "- No other top-level `##` sections. No prose outside the structure."
        )

        result = ""
        try:
            async with channel.typing():
                async for event in planner.stream(spec_prompt):
                    self._log_stream(task.thread_id, "planner", event)
                    if event.kind in ("result", "text"):
                        result = event.content
                    elif event.kind == "error":
                        result = event.content
                    elif log_thread and event.kind in (
                        "thinking",
                        "tool_use",
                        "tool_result",
                    ):
                        await self._notify_log(log_thread, event.content)
        except Exception as e:
            log.error("Spec-gen stream crashed: %s", e, exc_info=True)
            if not result:
                result = f"[Stream crashed] {e}"

        self.save_state()

        # Always dump planner's raw response to log thread, success or not
        await self._notify_log(
            log_thread,
            f"### ← Planner raw spec ({len(result)} chars)\n{result}",
        )

        try:
            task.spec = TaskSpec.from_markdown(result)
        except ValueError as e:
            await self._notify_log(
                log_thread, f"### ❌ Spec parse failed\n```\n{e}\n```"
            )
            await self._send_with_retry(
                channel,
                f"Failed to parse spec: {e}\n\nPlanner's response:\n{result[:1000]}",
            )
            return

        # Log parsed spec summary
        parsed_lines = [
            f"### ✅ Spec parsed — {len(task.spec.items)} item(s)",
            f"**Goal**: {task.spec.goal}",
        ]
        for it in task.spec.items:
            parsed_lines.append(
                f"- {it.id}. **{it.title}**\n"
                f"  - coder: {len(it.coder_brief)} chars\n"
                f"  - reviewer: {len(it.reviewer_brief)} chars\n"
                f"  - validator: {len(it.validator_brief)} chars"
            )
        await self._notify_log(log_thread, "\n".join(parsed_lines))

        # Show spec to user
        await self._send_with_retry(
            channel,
            f"## Spec: {task.spec.goal}\n{task.spec.progress_summary()}\n\n"
            f"Starting execution...",
        )

        # Switch to execution mode
        task.mode = "execute"
        self.save_state()

        await self.run_orchestrator(task, channel)

    # ------------------------------------------------------------------
    # Orchestrator run (shared by spec-gen completion and /resume)
    # ------------------------------------------------------------------

    async def run_orchestrator(self, task: TaskContext, channel: discord.Thread):
        """Drive Coder→Reviewer→Validator for every pending item in task.spec.

        Wrapped in `channel.typing()` so Discord shows the typing indicator
        throughout the whole execution. Writes full prompts/responses and
        lifecycle markers to the task's log thread.
        """
        if task.spec is None:
            log.warning("run_orchestrator called with no spec for task %d", task.thread_id)
            return

        log_thread = await self._get_log_thread(task)

        async def notify(msg: str):
            for chunk in format_for_discord(msg):
                await self._send_with_retry(channel, chunk)

        async def notify_log(msg: str):
            await self._notify_log(log_thread, msg)

        async def agent_send(role: str, msg: str) -> str:
            """Stream one turn. Retry pure-infra failures transparently."""
            session = task.sessions[role]
            Role = role.capitalize()
            await self._notify_log(
                log_thread,
                f"### → {Role} prompt ({len(msg)} chars)\n{msg}",
            )
            MAX_INFRA_RETRIES = 3
            result = ""
            for attempt in range(1, MAX_INFRA_RETRIES + 1):
                result = ""
                got_real_content = False
                async for event in session.stream(msg):
                    self._log_stream(task.thread_id, role, event)
                    if event.kind in ("result", "text"):
                        result = event.content
                        got_real_content = True
                    elif event.kind == "error":
                        result = event.content
                    elif log_thread and event.kind in (
                        "thinking",
                        "tool_use",
                        "tool_result",
                    ):
                        # tool_use / tool_result count as real work; thinking
                        # (especially the encrypted placeholder) does NOT —
                        # the model can crash right after one thinking block
                        # with no actual output, and we must still retry.
                        if event.kind in ("tool_use", "tool_result"):
                            got_real_content = True
                        await self._notify_log(log_thread, event.content)
                if got_real_content:
                    break
                if attempt < MAX_INFRA_RETRIES:
                    # Drop the cursed session_id — a session that errored
                    # mid-stream on the server side often stays poisoned for
                    # --resume. Starting fresh is cheaper than looping.
                    if getattr(session, "session_id", None):
                        await self._notify_log(
                            log_thread,
                            f"### ⟳ {Role} dropping session "
                            f"`{session.session_id[:8]}…` before retry",
                        )
                        session.session_id = None
                    backoff = 2**attempt
                    await self._notify_log(
                        log_thread,
                        f"### ⚠ {Role} infra failure "
                        f"({attempt}/{MAX_INFRA_RETRIES}): "
                        f"`{result[:120]}` — retrying in {backoff}s",
                    )
                    await asyncio.sleep(backoff)
            await self._notify_log(
                log_thread,
                f"### ← {Role} response ({len(result)} chars)\n{result}",
            )
            return result

        orch = Orchestrator(
            coder_send=lambda msg: agent_send("coder", msg),
            reviewer_send=lambda msg: agent_send("reviewer", msg),
            validator_send=lambda msg: agent_send("validator", msg),
            notify=notify,
            notify_log=notify_log,
        )

        try:
            async with channel.typing():
                await orch.execute(task.spec)
        except Exception as e:
            log.error("Orchestrator crashed: %s", e, exc_info=True)
            await self._notify_log(
                log_thread, f"### 💥 Orchestrator crashed\n```\n{e}\n```"
            )

        task.mode = "discuss"
        self.save_state()

        await self._send_with_retry(
            channel,
            "Execution finished. Continue discussing or start a new task.",
        )

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def _log_chat(self, thread_id: int, role: str, author: str, content: str):
        os.makedirs(CHAT_LOG_DIR, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "thread_id": thread_id,
            "role": role,
            "author": author,
            "content": content,
        }
        try:
            path = os.path.join(CHAT_LOG_DIR, f"{thread_id}.jsonl")
            with open(path, "a") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            log.error("Failed to write chat log: %s", e)

    def _log_stream(self, thread_id: int, role: str, event: StreamEvent):
        os.makedirs(STREAM_LOG_DIR, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "thread_id": thread_id,
            "bot": role,
            "kind": event.kind,
            "content": event.content,
        }
        try:
            path = os.path.join(STREAM_LOG_DIR, f"{thread_id}.jsonl")
            with open(path, "a") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            log.error("Failed to write stream log: %s", e)

    # ------------------------------------------------------------------
    # Network helpers
    # ------------------------------------------------------------------

    async def _notify_log(self, log_thread, text: str):
        """Post text to the log thread, split by Discord's message limit.

        Absorbs all exceptions — the log thread is best-effort; failures here
        MUST NOT kill the orchestrator or any other caller.
        """
        if not log_thread or not text:
            return
        try:
            for chunk in split_message(text):
                await self._send_with_retry(log_thread, chunk)
        except Exception as e:
            log.error("notify_log dropped: %s", e, exc_info=True)

    async def _get_log_thread(self, task: TaskContext):
        if not task.log_thread_id:
            return None
        for attempt in range(3):
            try:
                ch = self.client.get_channel(task.log_thread_id)
                if ch is None:
                    ch = await self.client.fetch_channel(task.log_thread_id)
                return ch
            except Exception as e:
                if attempt < 2:
                    await asyncio.sleep(2**attempt)
                else:
                    log.warning("Failed to fetch log thread: %s", e)
        return None

    async def _send_with_retry(
        self, channel, content: str, max_retries: int = 10, **kwargs
    ):
        for attempt in range(max_retries):
            try:
                await channel.send(content, **kwargs)
                return
            except (aiohttp.ClientError, ConnectionError, discord.HTTPException) as e:
                if attempt < max_retries - 1:
                    wait = min(3**attempt, 120)
                    log.warning(
                        "Send failed (%d/%d), retry in %ds: %s",
                        attempt + 1,
                        max_retries,
                        wait,
                        e,
                    )
                    await asyncio.sleep(wait)
                else:
                    log.error("Send failed after %d attempts: %s", max_retries, e)
            except Exception as e:
                # Never let a Discord send bring down the orchestrator.
                log.error("Send failed with unexpected error: %s", e, exc_info=True)
                return

    # ------------------------------------------------------------------
    # Task management
    # ------------------------------------------------------------------

    def create_task(
        self, thread_id: int, cwd: str, log_thread_id: int | None = None
    ) -> TaskContext:
        task = TaskContext(thread_id, cwd, self.config)
        task.log_thread_id = log_thread_id
        self.tasks[thread_id] = task
        log.info("Task created for thread %d (cwd=%s)", thread_id, cwd)
        self.save_state()
        return task

    # ------------------------------------------------------------------
    # State persistence
    # ------------------------------------------------------------------

    def _state_path(self) -> str:
        return os.path.join(STATE_DIR, "state.json")

    def save_state(self):
        existing = {}
        try:
            with open(self._state_path()) as f:
                existing = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            pass

        for tid, task in self.tasks.items():
            existing[str(tid)] = task.to_state()

        if not existing:
            return

        os.makedirs(STATE_DIR, exist_ok=True)
        try:
            with open(self._state_path(), "w") as f:
                json.dump(existing, f, indent=2, ensure_ascii=False)
        except Exception as e:
            log.error("Failed to save state: %s", e)

    def load_state(self):
        try:
            with open(self._state_path()) as f:
                state = json.load(f)
        except FileNotFoundError:
            return
        except Exception as e:
            log.error("Failed to load state: %s", e)
            return

        for tid_str, task_data in state.items():
            tid = int(tid_str)
            task = TaskContext.__new__(TaskContext)
            task.thread_id = tid
            task.cwd = task_data["cwd"]
            task.log_thread_id = task_data.get("log_thread_id")
            task.mode = task_data.get("mode", "discuss")
            task.sessions = {}

            for role, sess_data in task_data.get("sessions", {}).items():
                prompt = ROLE_PROMPTS.get(role, "")
                task.sessions[role] = restore_session(sess_data, prompt)

            if task_data.get("spec"):
                task.spec = TaskSpec.from_json(task_data["spec"])
            else:
                task.spec = None

            self.tasks[tid] = task

        log.info("Restored %d task(s) from state", len(state))

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self):
        for attempt in range(10):
            try:
                await self.client.start(self.token)
                return
            except Exception as e:
                wait = min(3**attempt, 120)
                log.warning(
                    "Start failed (%d/10), retry in %ds: %s",
                    attempt + 1,
                    wait,
                    e,
                )
                self.client.ws = None
                self.client._ready.clear()
                await asyncio.sleep(wait)
        log.error("Failed to start after 10 attempts")

    async def close(self):
        self.save_state()
        self.tasks.clear()
        await self.client.close()
