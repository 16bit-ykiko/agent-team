"""Session backends for AI agents."""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Protocol


@dataclass
class StreamEvent:
    """A parsed event from an AI backend's stream output."""

    kind: str  # "thinking", "text", "tool_use", "tool_result", "result", "error"
    content: str  # human-readable content
    data: dict  # raw data


@dataclass
class UsageStats:
    """Accumulated usage statistics."""

    total_cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    num_turns: int = 0
    total_duration_ms: int = 0

    def update(self, result: dict) -> None:
        """Accumulate from a Claude stream-json `result` event."""
        self.total_cost_usd += result.get("total_cost_usd", 0.0)
        self.num_turns += result.get("num_turns", 0)
        self.total_duration_ms += result.get("duration_ms", 0)
        u = result.get("usage") or {}
        self.input_tokens += u.get("input_tokens", 0)
        self.output_tokens += u.get("output_tokens", 0)
        self.cache_read_tokens += u.get("cache_read_input_tokens", 0)
        self.cache_creation_tokens += u.get("cache_creation_input_tokens", 0)


class Session(Protocol):
    """Protocol for AI session backends."""

    cwd: str
    session_id: str | None
    usage: UsageStats
    model: str
    effort: str

    async def stream(self, message: str) -> AsyncIterator[StreamEvent]: ...

    async def send(self, message: str) -> str: ...

    def abort(self) -> None: ...

    def to_state(self) -> dict: ...

    @classmethod
    def from_state(cls, state: dict, system_prompt: str) -> "Session": ...


def create_session(
    backend: str,
    cwd: str,
    system_prompt: str,
    model: str,
    effort: str,
    **kwargs,
) -> "Session":
    """Factory to create a session from backend name."""
    if backend == "claude":
        from src.session.claude import ClaudeSession

        return ClaudeSession(
            cwd=cwd,
            system_prompt=system_prompt,
            model=model,
            effort=effort,
            permission_mode=kwargs.get("permission_mode", "bypassPermissions"),
        )
    elif backend == "codex":
        from src.session.codex import CodexSession

        return CodexSession(
            cwd=cwd,
            system_prompt=system_prompt,
            model=model,
            effort=effort,
        )
    else:
        raise ValueError(f"Unknown backend: {backend}")


def restore_session(state: dict, system_prompt: str) -> "Session":
    """Restore a session from saved state."""
    backend = state.get("backend", "claude")
    if backend == "claude":
        from src.session.claude import ClaudeSession

        return ClaudeSession.from_state(state, system_prompt)
    elif backend == "codex":
        from src.session.codex import CodexSession

        return CodexSession.from_state(state, system_prompt)
    else:
        raise ValueError(f"Unknown backend: {backend}")
