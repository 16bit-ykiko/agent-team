"""OpenAI Codex CLI session backend."""

import asyncio
import json
import logging
from typing import AsyncIterator

from src.session import StreamEvent, UsageStats

log = logging.getLogger(__name__)


def _parse_codex_event(data: dict) -> StreamEvent | None:
    """Parse a codex JSONL event into a StreamEvent."""
    etype = data.get("type", "")

    if etype == "thread.started":
        return None  # handled separately for session_id

    elif etype == "item.started":
        # Ignore — we show tool info on item.completed only
        return None

    elif etype == "item.completed":
        item = data.get("item", {})
        itype = item.get("type", "")
        if itype == "agent_message":
            text = item.get("text", "")
            if text:
                # Intermediate messages shown as text, final one
                # becomes result (handled by the stream consumer
                # which keeps the last agent_message as result)
                return StreamEvent("text", text, data)
        elif itype == "command_execution":
            cmd = item.get("command", "")
            output = item.get("aggregated_output", "")
            exit_code = item.get("exit_code", 0)
            status = "ok" if exit_code == 0 else f"exit {exit_code}"
            parts = [f"### Tool: `shell` ({status})", f"```bash\n{cmd}\n```"]
            if output.strip():
                parts.append(f"-# Output\n```\n{output}\n```")
            return StreamEvent("tool_use", "\n".join(parts), data)

    elif etype == "turn.completed":
        usage = data.get("usage", {})
        return StreamEvent(
            "usage",
            f"tokens: in={usage.get('input_tokens', 0)}, "
            f"out={usage.get('output_tokens', 0)}",
            data,
        )

    elif etype == "turn.failed":
        err = data.get("error", {})
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        return StreamEvent("error", f"[Codex error] {msg}", data)

    elif etype == "error":
        return StreamEvent(
            "error", f"[Codex error] {data.get('message', str(data))}", data
        )

    return None


class CodexSession:
    """A multi-turn Codex CLI session via subprocess."""

    backend = "codex"

    def __init__(
        self,
        cwd: str,
        system_prompt: str,
        model: str = "gpt-5.4",
        effort: str = "xhigh",
    ):
        self.cwd = cwd
        self.system_prompt = system_prompt
        self.model = model
        self.effort = effort
        self.session_id: str | None = None
        self.usage = UsageStats()
        self._lock = asyncio.Lock()
        self._proc: asyncio.subprocess.Process | None = None

    def abort(self):
        if self._proc and self._proc.returncode is None:
            self._proc.kill()
            log.info("Aborted codex process (cwd=%s)", self.cwd)

    def _build_args(self, message: str) -> list[str]:
        args = [
            "codex",
            "exec",
            "--json",
            "--cd",
            self.cwd,
            "-c",
            f'model="{self.model}"',
            "-c",
            f'model_reasoning_effort="{self.effort}"',
            "--dangerously-bypass-approvals-and-sandbox",
        ]
        # System prompt prepended to user message
        full_msg = f"[System]\n{self.system_prompt}\n\n[User]\n{message}"
        if self.session_id:
            args.extend(["resume", self.session_id, full_msg])
        else:
            args.append(full_msg)
        return args

    async def stream(
        self, message: str, idle_timeout: float = 600
    ) -> AsyncIterator[StreamEvent]:
        async with self._lock:
            args = self._build_args(message)
            self._proc = proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
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
                            "Codex idle %ds, killing (cwd=%s)",
                            idle_timeout,
                            self.cwd,
                        )
                        proc.kill()
                        yield StreamEvent(
                            "error",
                            f"[Timeout] Codex idle {idle_timeout}s, killed.",
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

                    # Capture thread_id as session_id
                    if data.get("type") == "thread.started":
                        tid = data.get("thread_id")
                        if tid and not self.session_id:
                            self.session_id = tid
                            log.info("Codex session: %s (cwd=%s)", tid, self.cwd)

                    # Track usage
                    if data.get("type") == "turn.completed":
                        u = data.get("usage", {})
                        self.usage.input_tokens += u.get("input_tokens", 0)
                        self.usage.output_tokens += u.get("output_tokens", 0)
                        self.usage.num_turns += 1

                    event = _parse_codex_event(data)
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
                        "Codex failed (rc=%d): %s",
                        proc.returncode,
                        err[:200] or "(no output)",
                    )
                    yield StreamEvent(
                        "error",
                        f"[Codex error rc={proc.returncode}] {err or 'unknown'}",
                        {},
                    )

    async def send(self, message: str) -> str:
        result = ""
        async for event in self.stream(message):
            if event.kind == "text":
                result = event.content  # last text becomes result
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
    def from_state(cls, state: dict, system_prompt: str) -> "CodexSession":
        s = cls(
            cwd=state["cwd"],
            system_prompt=system_prompt,
            model=state.get("model", "gpt-5.4"),
            effort=state.get("effort", "xhigh"),
        )
        s.session_id = state.get("session_id")
        return s
