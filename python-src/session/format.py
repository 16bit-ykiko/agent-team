"""Stream event parsing and formatting for Discord display."""

import os

from src.session import StreamEvent

_EXT_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".jsx": "jsx",
    ".tsx": "tsx",
    ".c": "c",
    ".h": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hxx": "cpp",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".json": "json",
    ".toml": "toml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".sql": "sql",
    ".md": "markdown",
    ".cmake": "cmake",
}


def _lang_for_path(path: str) -> str:
    _, ext = os.path.splitext(path)
    return _EXT_TO_LANG.get(ext.lower(), "")


def format_tool_use(name: str, inp: dict, *, is_subagent: bool = False) -> str:
    """Format a tool use event for Discord display."""
    tag = " [subagent]" if is_subagent else ""
    if name == "Agent":
        desc = inp.get("description", "")
        prompt = inp.get("prompt", "")
        agent_type = inp.get("subagent_type", "general-purpose")
        return f"### Subagent: `{agent_type}` *{desc}*\n> {prompt}"
    elif name == "Bash":
        cmd = inp.get("command", "")
        desc = inp.get("description", "")
        header = f"### Tool{tag}: `Bash`"
        if desc:
            header += f" *{desc}*"
        return f"{header}\n```bash\n{cmd}\n```"
    elif name == "Edit":
        path = inp.get("file_path", "")
        lang = _lang_for_path(path)
        old = inp.get("old_string", "")
        new = inp.get("new_string", "")
        return (
            f"### Tool{tag}: `Edit` `{path}`\n"
            f"-# old\n```{lang}\n{old}\n```\n"
            f"-# new\n```{lang}\n{new}\n```"
        )
    elif name == "Write":
        path = inp.get("file_path", "")
        lang = _lang_for_path(path)
        content = inp.get("content", "")
        return f"### Tool{tag}: `Write` `{path}`\n```{lang}\n{content}\n```"
    elif name == "Read":
        path = inp.get("file_path", "")
        return f"### Tool{tag}: `Read` `{path}`"
    elif name in ("Grep", "Glob"):
        pattern = inp.get("pattern", "")
        path = inp.get("path", "")
        extra = f" in `{path}`" if path else ""
        return f"### Tool{tag}: `{name}` `{pattern}`{extra}"
    else:
        summary = str(inp)
        return f"### Tool{tag}: `{name}`\n```\n{summary}\n```"


def parse_claude_event(data: dict) -> StreamEvent | None:
    """Parse a Claude stream-json line into a StreamEvent."""
    etype = data.get("type")
    is_subagent = data.get("parent_tool_use_id") is not None

    if etype == "assistant":
        msg = data.get("message", {})
        for block in msg.get("content", []):
            btype = block.get("type")
            if btype == "thinking":
                text = block.get("thinking", "")
                if text:
                    if is_subagent:
                        return StreamEvent(
                            "thinking",
                            f"-# Subagent Thinking\n```\n{text}\n```",
                            data,
                        )
                    else:
                        lines = text.split("\n")
                        quoted = "\n".join(f"> {ln}" for ln in lines)
                        return StreamEvent("thinking", f"### Thinking\n{quoted}", data)
                elif block.get("signature"):
                    label = (
                        "-# Subagent Thinking (encrypted)"
                        if is_subagent
                        else "### Thinking (encrypted)"
                    )
                    return StreamEvent("thinking", label, data)
            elif btype == "text":
                text = block.get("text", "")
                if text:
                    return StreamEvent("text", text, data)
            elif btype == "tool_use":
                name = block.get("name", "unknown")
                inp = block.get("input", {})
                formatted = format_tool_use(name, inp, is_subagent=is_subagent)
                return StreamEvent("tool_use", formatted, data)
            elif btype == "tool_result":
                content = block.get("content", "")
                if isinstance(content, list):
                    content = "\n".join(
                        c.get("text", "") for c in content if c.get("type") == "text"
                    )
                if content:
                    label = "Subagent Output" if is_subagent else "Tool Output"
                    return StreamEvent(
                        "tool_result",
                        f"-# {label}\n```\n{content}\n```",
                        data,
                    )

    elif etype == "result":
        if data.get("is_error"):
            return StreamEvent("error", data.get("result", "unknown error"), data)
        return StreamEvent("result", data.get("result", ""), data)

    elif etype == "rate_limit_event":
        info = data.get("rate_limit_info", {})
        status = info.get("status", "")
        util = info.get("utilization", 0)
        if status in ("rejected", "allowed_warning"):
            pct = int(util * 100)
            msg = f"**Rate limit**: {pct}% used ({status})"
            if status == "rejected":
                msg += " — request rejected, please wait."
            return StreamEvent("error", msg, data)

    elif etype == "error":
        return StreamEvent(
            "error",
            data.get("error", {}).get("message", str(data)),
            data,
        )

    return None
