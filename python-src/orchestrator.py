"""Task orchestrator — drives the Planner→Coder→Reviewer→Validator loop."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Structured task spec
# ---------------------------------------------------------------------------


class ItemStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    VALIDATING = "validating"
    DONE = "done"
    FAILED = "failed"


@dataclass
class TaskItem:
    """A single work item with per-role briefs."""

    id: int
    title: str
    coder_brief: str
    reviewer_brief: str
    validator_brief: str
    status: ItemStatus = ItemStatus.PENDING
    review_attempts: int = 0
    validate_attempts: int = 0
    max_review_attempts: int = 3
    max_validate_attempts: int = 3

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "coder_brief": self.coder_brief,
            "reviewer_brief": self.reviewer_brief,
            "validator_brief": self.validator_brief,
            "status": self.status.value,
            "review_attempts": self.review_attempts,
            "validate_attempts": self.validate_attempts,
        }


@dataclass
class TaskSpec:
    """Structured spec produced by Planner."""

    goal: str
    items: list[TaskItem] = field(default_factory=list)
    context: str = ""

    @classmethod
    def from_json(cls, data: dict) -> "TaskSpec":
        """Rehydrate from persisted state.json."""
        items = []
        for i, it in enumerate(data.get("items", [])):
            item = TaskItem(
                id=it.get("id", i + 1),
                title=it.get("title", f"Task {i + 1}"),
                coder_brief=it.get("coder_brief", ""),
                reviewer_brief=it.get("reviewer_brief", ""),
                validator_brief=it.get("validator_brief", ""),
            )
            status = it.get("status")
            if status:
                try:
                    item.status = ItemStatus(status)
                except ValueError:
                    pass
            item.review_attempts = it.get("review_attempts", 0)
            item.validate_attempts = it.get("validate_attempts", 0)
            items.append(item)
        return cls(
            goal=data.get("goal", ""),
            items=items,
            context=data.get("context", ""),
        )

    @classmethod
    def from_markdown(cls, md: str) -> "TaskSpec":
        """Parse the planner's Markdown spec output."""
        data = parse_spec_markdown(md)
        items = [
            TaskItem(
                id=i + 1,
                title=d["title"],
                coder_brief=d["coder_brief"],
                reviewer_brief=d["reviewer_brief"],
                validator_brief=d["validator_brief"],
            )
            for i, d in enumerate(data["items"])
        ]
        return cls(goal=data["goal"], context=data["context"], items=items)

    def to_dict(self) -> dict:
        return {
            "goal": self.goal,
            "context": self.context,
            "items": [item.to_dict() for item in self.items],
        }

    def next_pending(self) -> TaskItem | None:
        """Return the next item that hasn't been finished yet.

        Skips FAILED items — those need user intervention (otherwise an
        item that exhausted max_validate_attempts would loop forever).
        """
        for item in self.items:
            if item.status == ItemStatus.PENDING:
                return item
        return None

    def is_complete(self) -> bool:
        """True when every item has reached a terminal state (DONE or FAILED)."""
        return all(
            item.status in (ItemStatus.DONE, ItemStatus.FAILED)
            for item in self.items
        )

    def progress_summary(self) -> str:
        done = sum(1 for i in self.items if i.status == ItemStatus.DONE)
        total = len(self.items)
        lines = [f"**Progress: {done}/{total}**"]
        for item in self.items:
            icon = {
                ItemStatus.DONE: "✅",
                ItemStatus.IN_PROGRESS: "🔧",
                ItemStatus.REVIEW: "🔍",
                ItemStatus.VALIDATING: "✔️",
                ItemStatus.PENDING: "⏳",
                ItemStatus.FAILED: "❌",
            }.get(item.status, "⏳")
            lines.append(f"{icon} {item.id}. {item.title}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Markdown spec parser
# ---------------------------------------------------------------------------

_SECTION = re.compile(r"^##\s+(Goal|Context|Items)\s*$", re.MULTILINE)
_ITEM_HEADING = re.compile(r"^###\s+(\d+)\.\s*(.+?)\s*$", re.MULTILINE)
_SUBSECTION = re.compile(r"^####\s+(Coder|Reviewer|Validator)\s*$", re.MULTILINE)


def _strip_outer_fence(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        if nl != -1:
            s = s[nl + 1 :]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def parse_spec_markdown(md: str) -> dict:
    """Parse planner's Markdown spec into a structured dict.

    Expected shape:
        ## Goal
        ...
        ## Context
        ...
        ## Items
        ### 1. <title>
        #### Coder
        ...
        #### Reviewer
        ...
        #### Validator
        ...
        ### 2. ...
    """
    md = _strip_outer_fence(md)
    top = list(_SECTION.finditer(md))
    if not top:
        raise ValueError("spec has no `## Goal` / `## Context` / `## Items` sections")

    sections: dict[str, str] = {}
    for i, m in enumerate(top):
        end = top[i + 1].start() if i + 1 < len(top) else len(md)
        sections[m.group(1)] = md[m.end() : end].strip()

    if "Goal" not in sections:
        raise ValueError("spec missing `## Goal` section")
    if "Items" not in sections:
        raise ValueError("spec missing `## Items` section")

    items_md = sections["Items"]
    heads = list(_ITEM_HEADING.finditer(items_md))
    if not heads:
        raise ValueError("spec has no items (expected `### N. <title>` headings)")

    items = []
    for i, m in enumerate(heads):
        title = m.group(2).strip()
        body_end = heads[i + 1].start() if i + 1 < len(heads) else len(items_md)
        body = items_md[m.end() : body_end]

        subs: dict[str, str] = {}
        sub_matches = list(_SUBSECTION.finditer(body))
        for j, sm in enumerate(sub_matches):
            s_end = (
                sub_matches[j + 1].start() if j + 1 < len(sub_matches) else len(body)
            )
            subs[sm.group(1)] = body[sm.end() : s_end].strip()

        missing = [r for r in ("Coder", "Reviewer", "Validator") if r not in subs]
        if missing:
            raise ValueError(
                f"item {i + 1} ({title!r}) missing subsection(s): {', '.join(missing)}"
            )

        items.append(
            {
                "title": title,
                "coder_brief": subs["Coder"],
                "reviewer_brief": subs["Reviewer"],
                "validator_brief": subs["Validator"],
            }
        )

    return {
        "goal": sections["Goal"].strip(),
        "context": sections.get("Context", "").strip(),
        "items": items,
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

SendFn = Callable[[str], Awaitable[None]]
LogFn = Callable[[str], Awaitable[None]]


class Orchestrator:
    """Drives the task loop: Coder → Reviewer → Validator for each item."""

    def __init__(
        self,
        coder_send: Callable[[str], Awaitable[str]],
        reviewer_send: Callable[[str], Awaitable[str]],
        validator_send: Callable[[str], Awaitable[str]],
        notify: SendFn,
        notify_log: LogFn | None = None,
    ):
        self.coder_send = coder_send
        self.reviewer_send = reviewer_send
        self.validator_send = validator_send
        self.notify = notify
        self.notify_log = notify_log or (lambda _: None)

    async def execute(self, spec: TaskSpec) -> TaskSpec:
        await self.notify(f"## Task: {spec.goal}\n{spec.progress_summary()}")
        await self.notify_log(
            f"### ▶ Orchestrator start — {len(spec.items)} item(s)"
        )

        while not spec.is_complete():
            item = spec.next_pending()
            if item is None:
                break
            try:
                await self._execute_item(spec, item)
            except Exception as e:
                log.error(
                    "Item %d (%s) crashed: %s",
                    item.id,
                    item.title,
                    e,
                    exc_info=True,
                )
                item.status = ItemStatus.FAILED
                await self.notify_log(
                    f"### 💥 Item {item.id} crashed with exception — "
                    f"marking FAILED\n```\n{e}\n```"
                )
                await self.notify(
                    f"❌ {item.id}. {item.title} — internal error: {e}"
                )

        if spec.is_complete():
            await self.notify(f"## Task Complete\n{spec.progress_summary()}")
            await self.notify_log("### ✅ Orchestrator done — all items passed")
        else:
            await self.notify(
                f"## Task Incomplete\n{spec.progress_summary()}\n"
                "Some items could not be completed."
            )
            await self.notify_log(
                "### ⚠ Orchestrator done — some items failed"
            )
        return spec

    async def _execute_item(self, spec: TaskSpec, item: TaskItem):
        item.status = ItemStatus.IN_PROGRESS
        await self.notify(f"### Working on: {item.id}. {item.title}")
        await self.notify_log(
            f"### ▶ Item {item.id}. {item.title} — starting"
        )

        prev_validate_feedback: str | None = None

        while item.validate_attempts < item.max_validate_attempts:
            item.validate_attempts += 1
            await self.notify_log(
                f"### ▶ Pass {item.validate_attempts}/"
                f"{item.max_validate_attempts} — dispatching Coder"
            )

            # --- Coder: initial implement or fix after validation failure ---
            if prev_validate_feedback is None:
                coder_prompt = (
                    f"## Task: {item.title}\n\n"
                    f"## Context\n{spec.context}\n\n"
                    f"## Your brief\n{item.coder_brief}\n\n"
                    "Implement this. When done, summarize what you changed."
                )
            else:
                coder_prompt = (
                    f"## Task: {item.title}\n\n"
                    f"## Validator rejected attempt "
                    f"#{item.validate_attempts - 1}\n"
                    f"{prev_validate_feedback}\n\n"
                    "Fix the issue and re-summarize your changes."
                )
            coder_result = await self.coder_send(coder_prompt)

            # --- Review loop ---
            item.review_attempts = 0
            item.status = ItemStatus.REVIEW
            while item.review_attempts < item.max_review_attempts:
                item.review_attempts += 1
                await self.notify_log(
                    f"### 🔍 Review {item.review_attempts}/"
                    f"{item.max_review_attempts} — dispatching Reviewer"
                )
                review_prompt = (
                    f"## Review: {item.title}\n\n"
                    f"## Reviewer brief\n{item.reviewer_brief}\n\n"
                    f"## Coder's summary\n{coder_result}\n\n"
                    'Reply with a JSON object: '
                    '{"passed": true/false, "feedback": "..."}'
                )
                review_result = await self.reviewer_send(review_prompt)
                if self._is_infra_error(review_result):
                    await self.notify_log(
                        f"### ⚠ Review {item.review_attempts} — infra error after "
                        "retries, skipping to validation without sending Coder"
                    )
                    break
                if self._parse_review(review_result):
                    await self.notify_log(
                        f"### ✅ Review {item.review_attempts} passed"
                    )
                    break
                await self.notify_log(
                    f"### ❌ Review {item.review_attempts} failed — "
                    "re-dispatching Coder"
                )
                await self.notify(
                    f"Review #{item.review_attempts}: issues, back to Coder..."
                )
                fix_prompt = (
                    f"## Review feedback\n{review_result}\n\n"
                    "Fix the issues. Summarize changes."
                )
                coder_result = await self.coder_send(fix_prompt)

            # --- Validation ---
            item.status = ItemStatus.VALIDATING
            await self.notify_log(
                f"### ✔️ Validation {item.validate_attempts}/"
                f"{item.max_validate_attempts} — dispatching Validator"
            )
            validate_prompt = (
                f"## Validate: {item.title}\n\n"
                f"## Validator brief\n{item.validator_brief}\n\n"
                'Reply with a JSON object: '
                '{"passed": true/false, "reason": "..."}'
            )
            validate_result = await self.validator_send(validate_prompt)

            if self._is_infra_error(validate_result):
                # Infra failure — not the Coder's fault, don't loop them in.
                # Mark FAILED so the user can /resume after fixing infra.
                item.status = ItemStatus.FAILED
                await self.notify_log(
                    f"### 💥 Item {item.id} validator infra error after retries — "
                    f"marking FAILED (not re-dispatching Coder)\n"
                    f"Last error: `{validate_result[:200]}`"
                )
                await self.notify(
                    f"❌ {item.id}. {item.title} — validator infra failure "
                    f"(`{validate_result[:120]}`). "
                    "Fix infra then `/resume` to retry."
                )
                await self.notify(spec.progress_summary())
                return

            if self._parse_validation(validate_result):
                item.status = ItemStatus.DONE
                await self.notify_log(
                    f"### ✅ Item {item.id} passed validation — done"
                )
                await self.notify(f"✅ {item.id}. {item.title} — done")
                await self.notify(spec.progress_summary())
                return

            prev_validate_feedback = validate_result
            await self.notify_log(
                f"### ❌ Validation {item.validate_attempts} failed — "
                "will retry via Coder"
            )
            await self.notify(
                f"Validation #{item.validate_attempts} failed, "
                "sending back to Coder..."
            )

        item.status = ItemStatus.FAILED
        await self.notify_log(
            f"### ❌ Item {item.id} exhausted "
            f"{item.max_validate_attempts} validate attempts — marking FAILED"
        )
        await self.notify(
            f"❌ {item.id}. {item.title} — still failing after "
            f"{item.max_validate_attempts} validate attempts"
        )
        await self.notify(spec.progress_summary())

    @staticmethod
    def _is_infra_error(result: str) -> bool:
        """Tell apart infrastructure failures from real pass/fail verdicts.

        When a subprocess crashes / Claude API terminates mid-stream,
        agent_send returns a canned error string instead of a real answer.
        We must not let that fool us into thinking the agent said "no".
        """
        if not result:
            return True
        stripped = result.lstrip()
        return (
            stripped.startswith("[Claude error")
            or stripped.startswith("[Timeout]")
            or stripped.startswith("[Stream crashed]")
            or stripped.startswith("API Error:")
        )

    def _parse_review(self, result: str) -> bool:
        try:
            for line in result.split("\n"):
                line = line.strip()
                if line.startswith("{"):
                    data = json.loads(line)
                    return bool(data.get("passed", False))
        except (json.JSONDecodeError, ValueError):
            pass
        lower = result.lower()
        if "passed" in lower or "审查通过" in lower or "lgtm" in lower:
            return True
        return False

    def _parse_validation(self, result: str) -> bool:
        try:
            for line in result.split("\n"):
                line = line.strip()
                if line.startswith("{"):
                    data = json.loads(line)
                    return bool(data.get("passed", False))
        except (json.JSONDecodeError, ValueError):
            pass
        lower = result.lower()
        if "passed" in lower or "验收通过" in lower or "all tests pass" in lower:
            return True
        return False
