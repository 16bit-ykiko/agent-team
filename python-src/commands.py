"""Slash commands for the Discord Agent Team."""

import asyncio
import logging
import os

import aiohttp
import discord
from discord import app_commands

from src.bot import AgentTeamBot

log = logging.getLogger(__name__)

RETRIABLE = (
    aiohttp.ClientConnectorError,
    aiohttp.ClientOSError,
    ConnectionResetError,
    discord.DiscordServerError,
    discord.HTTPException,
)


async def _retry(coro_fn, *, max_retries: int = 10, label: str = ""):
    for attempt in range(max_retries):
        try:
            return await coro_fn()
        except RETRIABLE as e:
            if attempt < max_retries - 1:
                wait = min(3**attempt, 120)
                log.warning(
                    "[%s] failed (%d/%d), retry in %ds: %s",
                    label,
                    attempt + 1,
                    max_retries,
                    wait,
                    e,
                )
                await asyncio.sleep(wait)
            else:
                log.error("[%s] failed after %d attempts: %s", label, max_retries, e)
                raise


async def _respond(interaction: discord.Interaction, content: str, **kwargs):
    async def _send():
        if not interaction.response.is_done():
            await interaction.response.send_message(content, **kwargs)
        else:
            await interaction.followup.send(content, **kwargs)

    await _retry(_send, label="respond")


def register_commands(
    tree: app_commands.CommandTree,
    guild: discord.Object,
    bot: AgentTeamBot,
    config: dict,
):
    projects = config.get("projects", {})
    project_choices = [
        app_commands.Choice(name=name, value=path) for name, path in projects.items()
    ]

    # ------------------------------------------------------------------
    # Error handler
    # ------------------------------------------------------------------

    @tree.error
    async def on_error(
        interaction: discord.Interaction, error: app_commands.AppCommandError
    ):
        log.error("Command error: %s", error)
        try:
            msg = f"Command failed: {error}. Please try again."
            if interaction.response.is_done():
                await interaction.followup.send(msg, ephemeral=True)
            else:
                await interaction.response.send_message(msg, ephemeral=True)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # /task
    # ------------------------------------------------------------------

    @tree.command(name="task", description="Create a new task thread", guild=guild)
    @app_commands.describe(
        name="Task name",
        project="Select a project",
        custom_cwd="Custom working directory",
    )
    @app_commands.choices(project=project_choices)
    async def task_create(
        interaction: discord.Interaction,
        name: str,
        project: app_commands.Choice[str] | None = None,
        custom_cwd: str | None = None,
    ):
        cwd = custom_cwd or (project.value if project else None)
        if not cwd:
            await _respond(
                interaction, "Select a project or provide custom_cwd.", ephemeral=True
            )
            return
        cwd = os.path.expanduser(cwd)
        if not os.path.isdir(cwd):
            await _respond(interaction, f"Directory not found: `{cwd}`", ephemeral=True)
            return

        await _retry(lambda: interaction.response.defer(), label="task.defer")

        channel = interaction.channel
        thread = await _retry(
            lambda: channel.create_thread(
                name=name, type=discord.ChannelType.public_thread
            ),
            label="task.thread",
        )
        log_thread = await _retry(
            lambda: channel.create_thread(
                name=f"[log] {name}", type=discord.ChannelType.public_thread
            ),
            label="task.log_thread",
        )

        # Bot joins threads
        for tid in (thread.id, log_thread.id):
            try:
                ch = bot.client.get_channel(tid)
                if ch is None:
                    ch = await bot.client.fetch_channel(tid)
                await ch.join()
            except Exception as e:
                log.warning("Failed to join thread: %s", e)

        # Create task context
        bot.create_task(thread.id, cwd, log_thread.id)

        # Notify in log thread
        await _retry(
            lambda: log_thread.send(
                f"<@{interaction.user.id}> Log thread for task **{name}**"
            ),
            label="task.log_notify",
        )

        project_label = project.name if project else cwd
        agents = config.get("agents", {})
        agent_info = ", ".join(
            f"**{role}**(`{cfg.get('backend', 'claude')}/{cfg.get('model', '?')}`)"
            for role, cfg in agents.items()
        )
        await _retry(
            lambda: thread.send(
                f"Task **{name}** created!\n"
                f"Project: `{project_label}` — `{cwd}`\n"
                f"Agents: {agent_info}\n"
                f"Log: <#{log_thread.id}>\n\n"
                f"Discuss with me, then say **生成 spec** to start execution."
            ),
            label="task.welcome",
        )

        await _retry(
            lambda: interaction.followup.send(
                f"Task created: {thread.mention}", ephemeral=True
            ),
            label="task.followup",
        )
        log.info("Task created: %s (thread=%d, cwd=%s)", name, thread.id, cwd)

    # ------------------------------------------------------------------
    # /stop
    # ------------------------------------------------------------------

    role_choices = [
        app_commands.Choice(name=r, value=r)
        for r in ["planner", "coder", "reviewer", "validator", "all"]
    ]

    @tree.command(
        name="stop",
        description="Stop running AI process in this thread",
        guild=guild,
    )
    @app_commands.describe(role="Which agent to stop")
    @app_commands.choices(role=role_choices)
    async def stop_cmd(
        interaction: discord.Interaction, role: app_commands.Choice[str]
    ):
        if not isinstance(interaction.channel, discord.Thread):
            await _respond(interaction, "Use inside a task thread.", ephemeral=True)
            return

        task = bot.tasks.get(interaction.channel.id)
        if not task:
            await _respond(
                interaction, "No active task in this thread.", ephemeral=True
            )
            return

        stopped = []
        targets = task.sessions.keys() if role.value == "all" else [role.value]
        for r in targets:
            session = task.sessions.get(r)
            if session:
                session.abort()
                stopped.append(r)

        await _respond(
            interaction,
            f"Stopped: {', '.join(stopped)}" if stopped else "Nothing to stop.",
        )

    # ------------------------------------------------------------------
    # /backend
    # ------------------------------------------------------------------

    backend_choices = [
        app_commands.Choice(name=n, value=v)
        for n, v in [("Claude", "claude"), ("Codex", "codex")]
    ]
    model_choices = [
        app_commands.Choice(name=n, value=v)
        for n, v in [
            ("Opus", "opus"),
            ("Sonnet", "sonnet"),
            ("Haiku", "haiku"),
            ("GPT-5.4", "gpt-5.4"),
        ]
    ]
    effort_choices = [
        app_commands.Choice(name=n, value=v)
        for n, v in [
            ("Max", "max"),
            ("High", "high"),
            ("Medium", "medium"),
            ("Low", "low"),
            ("XHigh", "xhigh"),
        ]
    ]

    @tree.command(
        name="backend",
        description="Switch backend/model/effort for an agent in this thread",
        guild=guild,
    )
    @app_commands.describe(
        role="Which agent",
        backend="Backend to use",
        model="Model",
        effort="Effort level",
    )
    @app_commands.choices(
        role=role_choices,
        backend=backend_choices,
        model=model_choices,
        effort=effort_choices,
    )
    async def backend_cmd(
        interaction: discord.Interaction,
        role: app_commands.Choice[str],
        backend: app_commands.Choice[str] | None = None,
        model: app_commands.Choice[str] | None = None,
        effort: app_commands.Choice[str] | None = None,
    ):
        if not isinstance(interaction.channel, discord.Thread):
            await _respond(interaction, "Use inside a task thread.", ephemeral=True)
            return

        task = bot.tasks.get(interaction.channel.id)
        if not task:
            await _respond(
                interaction, "No active task in this thread.", ephemeral=True
            )
            return

        targets = list(task.sessions.keys()) if role.value == "all" else [role.value]
        changes = []
        for r in targets:
            session = task.sessions.get(r)
            if not session:
                continue
            if backend:
                from src.prompts import ROLE_PROMPTS
                from src.session import create_session

                prompt = ROLE_PROMPTS.get(r, "")
                m = model.value if model else session.model
                e = effort.value if effort else session.effort
                task.sessions[r] = create_session(
                    backend=backend.value,
                    cwd=task.cwd,
                    system_prompt=prompt,
                    model=m,
                    effort=e,
                )
                changes.append(f"{r} → {backend.value}/{m}")
            else:
                if model:
                    session.model = model.value
                if effort:
                    session.effort = effort.value
                parts = []
                if model:
                    parts.append(f"model={model.name}")
                if effort:
                    parts.append(f"effort={effort.name}")
                if parts:
                    changes.append(f"{r}: {', '.join(parts)}")

        bot.save_state()
        await _respond(
            interaction,
            "\n".join(changes) if changes else "No changes.",
        )

    # ------------------------------------------------------------------
    # /resume
    # ------------------------------------------------------------------

    @tree.command(
        name="resume",
        description="Re-run the orchestrator on pending/stuck items in this thread",
        guild=guild,
    )
    async def resume_cmd(interaction: discord.Interaction):
        if not isinstance(interaction.channel, discord.Thread):
            await _respond(interaction, "Use inside a task thread.", ephemeral=True)
            return

        task = bot.tasks.get(interaction.channel.id)
        if not task:
            await _respond(
                interaction, "No active task in this thread.", ephemeral=True
            )
            return
        if not task.spec:
            await _respond(
                interaction,
                "No spec on this task — generate one first (`开始实现` / `生成 spec`).",
                ephemeral=True,
            )
            return

        from src.orchestrator import ItemStatus

        reset = []
        for item in task.spec.items:
            if item.status in (
                ItemStatus.IN_PROGRESS,
                ItemStatus.REVIEW,
                ItemStatus.VALIDATING,
            ):
                item.status = ItemStatus.PENDING
                item.review_attempts = 0
                item.validate_attempts = 0
                reset.append(item.id)

        task.mode = "execute"
        bot.save_state()

        pending = sum(
            1 for i in task.spec.items if i.status == ItemStatus.PENDING
        )
        msg = (
            f"Resuming orchestrator — {pending} pending item(s)"
            + (f", reset stuck: {reset}" if reset else "")
            + "."
        )
        await _respond(interaction, msg)

        async def _kick():
            try:
                await bot.run_orchestrator(task, interaction.channel)
            except Exception as e:
                log.error("resume_cmd crashed: %s", e, exc_info=True)

        asyncio.create_task(_kick())

    # ------------------------------------------------------------------
    # /status
    # ------------------------------------------------------------------

    @tree.command(name="status", description="Show active tasks and usage", guild=guild)
    async def status_cmd(interaction: discord.Interaction):
        try:
            proc = await asyncio.create_subprocess_exec(
                "pgrep",
                "-cf",
                r"claude.*-p|codex.*exec",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            ai_procs = int(stdout.decode().strip()) if proc.returncode == 0 else 0
        except Exception:
            ai_procs = 0

        lines = [f"**AI processes**: {ai_procs}\n"]

        for tid, task in bot.tasks.items():
            lines.append(f"**Thread** <#{tid}> — `{task.cwd}` ({task.mode})")
            for role, session in task.sessions.items():
                u = session.usage
                lines.append(
                    f"  {role}: `{session.backend}/{session.model}` "
                    f"in={u.input_tokens} out={u.output_tokens}"
                )
            if task.spec:
                lines.append(f"  {task.spec.progress_summary()}")

        if not bot.tasks:
            lines.append("No active tasks.")

        await _respond(interaction, "\n".join(lines))
