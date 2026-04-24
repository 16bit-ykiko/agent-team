"""Discord message formatting utilities."""

import re
import unicodedata

DISCORD_MSG_LIMIT = 2000


def format_for_discord(text: str) -> list[str]:
    """Split on --- separators and then split each part by Discord's limit."""
    text = convert_markdown_tables(text)
    parts = re.split(r"\n-{3,}\n", text)
    chunks = []
    for part in parts:
        part = part.strip()
        if part:
            chunks.extend(split_message(part))
    return chunks if chunks else [text]


def convert_markdown_tables(text: str) -> str:
    """Convert GFM tables to padded monospace blocks Discord can render.

    Discord does not render markdown tables. Inspired by
    smitmartijn/discord-table-builder, we pad each cell to a fixed column
    width and wrap the table in a fenced code block so Discord's monospace
    font keeps columns aligned.
    """
    lines = text.split("\n")
    result: list[str] = []
    i = 0
    in_fence = False
    fence_marker = ""
    while i < len(lines):
        line = lines[i]
        stripped = line.lstrip()

        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif stripped.startswith(fence_marker):
                in_fence = False
                fence_marker = ""
            result.append(line)
            i += 1
            continue

        if in_fence:
            result.append(line)
            i += 1
            continue

        if (
            i + 1 < len(lines)
            and _is_table_row(lines[i])
            and _is_separator_row(lines[i + 1])
        ):
            header = _parse_row(lines[i])
            i += 2
            rows: list[list[str]] = []
            while i < len(lines) and _is_table_row(lines[i]):
                rows.append(_parse_row(lines[i]))
                i += 1
            result.append(_render_table(header, rows))
            continue

        result.append(line)
        i += 1
    return "\n".join(result)


_SEP_CELL_RE = re.compile(r"^:?-+:?$")


def _is_table_row(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("|") and stripped.count("|") >= 2


def _is_separator_row(line: str) -> bool:
    if not _is_table_row(line):
        return False
    cells = _parse_row(line)
    if not cells:
        return False
    return all(_SEP_CELL_RE.match(c.strip()) for c in cells)


def _parse_row(line: str) -> list[str]:
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    return [c.strip() for c in stripped.split("|")]


def _display_width(s: str) -> int:
    width = 0
    for ch in s:
        if unicodedata.east_asian_width(ch) in ("W", "F"):
            width += 2
        else:
            width += 1
    return width


def _pad(s: str, width: int) -> str:
    return s + " " * max(width - _display_width(s), 0)


_COL_GAP = 3

# Discord does not render markdown inside inline code (`...`), so `**x**`
# would show as the literal string. Strip the emphasis markers before
# wrapping a cell so the text at least reads cleanly.
_EMPHASIS_RES = [
    (re.compile(r"\*\*(.+?)\*\*"), r"\1"),
    (re.compile(r"__(.+?)__"), r"\1"),
    (re.compile(r"~~(.+?)~~"), r"\1"),
    (re.compile(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)"), r"\1"),
    (re.compile(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)"), r"\1"),
]


def _strip_inline_markdown(text: str) -> str:
    for pat, repl in _EMPHASIS_RES:
        text = pat.sub(repl, text)
    return text


def _render_table(header: list[str], rows: list[list[str]]) -> str:
    ncols = len(header)
    for r in rows:
        ncols = max(ncols, len(r))
    header = header + [""] * (ncols - len(header))
    rows = [r + [""] * (ncols - len(r)) for r in rows]

    widths = [_display_width(header[i]) for i in range(ncols)]
    for r in rows:
        for i, cell in enumerate(r):
            widths[i] = max(widths[i], _display_width(cell))

    # Pre-process cells: strip markdown that won't render inside inline code.
    header = [_strip_inline_markdown(c).replace("`", "") for c in header]
    rows = [[_strip_inline_markdown(c).replace("`", "") for c in r] for r in rows]

    # Recompute widths on the stripped text, otherwise columns get over-wide.
    widths = [_display_width(header[i]) for i in range(ncols)]
    for r in rows:
        for i, cell in enumerate(r):
            widths[i] = max(widths[i], _display_width(cell))

    def render(cells: list[str]) -> str:
        parts: list[str] = []
        last = len(cells) - 1
        for i, c in enumerate(cells):
            gap = _COL_GAP if i < last else 0
            parts.append(_pad(c, widths[i] + gap))
        return "`" + "".join(parts) + "`"

    lines = [render(header)]
    for r in rows:
        lines.append(render(r))
    return "\n".join(lines)


def split_message(text: str, limit: int = DISCORD_MSG_LIMIT) -> list[str]:
    """Split a long message into chunks, preserving code block and quote edges.

    If a split would land inside an unclosed ``` fence, we first try to move
    it before the opening fence; failing that we close the fence on this
    chunk and reopen it on the next. If a split breaks a `> ` quoted line,
    the continuation is re-prefixed so Discord keeps rendering it as a quote.
    """
    if len(text) <= limit:
        return [text]

    # Reserve headroom for markers we may append when a split lands
    # mid-structure (closing fence = 4 bytes, quote prefix = 2 bytes).
    working = limit - 8

    chunks: list[str] = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break

        candidate = text[:working]

        # If we'd end mid code fence, prefer moving the split before the fence.
        if candidate.count("```") % 2 == 1:
            last_fence = candidate.rfind("```")
            split_at = candidate.rfind("\n", 0, last_fence)
            if split_at > 0:
                chunks.append(text[:split_at])
                text = text[split_at:].lstrip("\n")
                continue

        # Prefer newline boundary; otherwise hard-split.
        idx = candidate.rfind("\n")
        split_mid_line = idx <= 0
        if split_mid_line:
            idx = working
        chunk = text[:idx]
        rest = text[idx:] if split_mid_line else text[idx:].lstrip("\n")

        # If the chunk still ends inside an unclosed fence (couldn't move
        # the split point earlier), balance the fence across chunks.
        if chunk.count("```") % 2 == 1:
            chunk = chunk + "\n```"
            rest = "```\n" + rest

        # If we broke a line inside a `> ` block quote, re-prefix the
        # continuation so the next Discord message still renders as a quote.
        if split_mid_line:
            tail_line = chunk.rsplit("\n", 1)[-1]
            if tail_line.startswith("> "):
                rest = "> " + rest

        chunks.append(chunk)
        text = rest

    return chunks
