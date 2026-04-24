"""Claude Code CLI session backend."""

import asyncio
import json
import logging
import os
from typing import AsyncIterator

from src.session import StreamEvent, UsageStats
from src.session.format import parse_claude_event

log = logging.getLogger(__name__)

DISALLOWED_TOOLS = (
    "AskUserQuestion,Monitor,TaskOutput,TaskStop,CronCreate,CronDelete,CronList"
)


class ClaudeSession:
    """A multi-turn Claude Code session via subprocess."""

    backend = "claude"

    def __init__(
        self,
        cwd: str,
        system_prompt: str,
        model: str = "opus",
        effort: str = "max",
        permission_mode: str = "bypassPermissions",
    ):
        self.cwd = cwd
        self.system_prompt = system_prompt
        self.model = model
        self.effort = effort
        self.permission_mode = permission_mode
        self.session_id: str | None = None
        self.usage = UsageStats()
        self._lock = asyncio.Lock()
        self._proc: asyncio.subprocess.Process | None = None

    def abort(self):
        if self._proc and self._proc.returncode is None:
            self._proc.kill()
            log.info("Aborted claude process (cwd=%s)", self.cwd)

    def _build_args(self, message: str) -> list[str]:
        args = [
            "claude",
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            self.model,
            "--effort",
            self.effort,
            "--permission-mode",
            self.permission_mode,
            "--disallowed-tools",
            DISALLOWED_TOOLS,
            "--append-system-prompt",
            self.system_prompt,
        ]
        if self.session_id:
            args.extend(["--resume", self.session_id])
        args.append(message)
        return args

    async def stream(
        self, message: str, idle_timeout: float = 600
    ) -> AsyncIterator[StreamEvent]:
        async with self._lock:
            args = self._build_args(message)
            env = {**os.environ, "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "true"}
            self._proc = proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=self.cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                limit=10 * 1024 * 1024,
            )

            try:
                while True:
                    try:
                        raw = await asyncio.wait_for(
                            proc.stdout.readline(), timeout=idle_timeout
                        )
                    except asyncio.TimeoutError:
                        log.warning(
                            "Claude idle %ds, killing (cwd=%s)",
                            idle_timeout,
                            self.cwd,
                        )
                        proc.kill()
                        yield StreamEvent(
                            "error",
                            f"[Timeout] Claude idle {idle_timeout}s, killed.",
                            {},
                        )
                        break

                    if not raw:
                        break

                    line = raw.decode().strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    sid = data.get("session_id")
                    if sid and not self.session_id:
                        self.session_id = sid
                        log.info("Claude session: %s (cwd=%s)", sid, self.cwd)

                    if data.get("type") == "result":
                        self.usage.update(data)

                    event = parse_claude_event(data)
                    if event:
                        yield event

            finally:
                if proc.returncode is None:
                    proc.kill()
                await proc.wait()
                self._proc = None
                if proc.returncode and proc.returncode != 0:
                    stderr_data = await proc.stderr.read()
                    err = stderr_data.decode().strip()
                    if not err:
                        stdout_data = await proc.stdout.read()
                        err = stdout_data.decode().strip()[:500]
                    log.error(
                        "Claude failed (rc=%d): %s",
                        proc.returncode,
                        err[:200] or "(no output)",
                    )
                    yield StreamEvent(
                        "error",
                        f"[Claude error rc={proc.returncode}] {err or 'unknown'}",
                        {},
                    )

    async def send(self, message: str) -> str:
        result = ""
        async for event in self.stream(message):
            if event.kind == "result":
                result = event.content
            elif event.kind == "error":
                result = event.content
        return result

    def to_state(self) -> dict:
        return {
            "backend": self.backend,
            "session_id": self.session_id,
            "cwd": self.cwd,
            "model": self.model,
            "effort": self.effort,
        }

    @classmethod
    def from_state(cls, state: dict, system_prompt: str) -> "ClaudeSession":
        s = cls(
            cwd=state["cwd"],
            system_prompt=system_prompt,
            model=state.get("model", "opus"),
            effort=state.get("effort", "max"),
        )
        s.session_id = state.get("session_id")
        return s
