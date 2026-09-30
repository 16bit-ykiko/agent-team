// The panel's actions in a reply: a session started, a message sent (or
// failed), a report to the lead — each a line of its own, not a step.
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MessageItem } from "../src/App";
import { SessionLinkContext } from "../src/chat/messages";
import type { Message, StreamEvent } from "../src/state/useServer";

const call = (tool: string, content: string, over: Partial<StreamEvent> = {}): StreamEvent => ({
  kind: "tool_use",
  content,
  toolName: `mcp__panel__${tool}`,
  toolUseId: `t-${tool}-${content.length}`,
  ...over,
});

const events: StreamEvent[] = [
  call(
    "start_session",
    "**start_session** fix lexer in `wt/lexer`\n\n> Fix the lexer overflow.\n> Then run the tests.",
    { toolResult: 'Started session ws-17-abc ("fix lexer") in /repo/wt/lexer on claude-opus-5-5.' },
  ),
  call("read_session", "**read_session** `ws-17-abc`", { toolResult: "Session ws-17-abc …" }),
  call("message_session", "**message_session** `ws-17-abc`\n\n> please rebase", {
    toolResult: 'Sent to "fix lexer" (queued: it is busy).',
  }),
  call("message_session", "**message_session** `ws-9`\n\n> hi", {
    toolResult: "No session ws-9 in this project",
    toolResultIsError: true,
  }),
  call("finish_task", "**finish_task**\n\n> Lexer fixed, tests green."),
];

const msg: Message = {
  id: "m1",
  kind: "agent",
  agentId: "a1",
  content: "",
  timestamp: 0,
  status: "done",
  events,
};

describe("the panel's actions in a reply", () => {
  it("stand as lines of their own: what, to whom, what was sent, and whether it failed", () => {
    const open = vi.fn();
    const { container } = render(<MessageItem msg={msg} agents={[]} onOpenWorkspace={open} />);
    const actions = [...container.querySelectorAll<HTMLElement>(".banner-action")];
    const line = (a: HTMLElement) =>
      [
        a.dataset.action,
        a.querySelector(".banner-label")?.textContent,
        a.querySelector(".action-target")?.textContent,
        a.querySelector(".banner-first-line, .action-error")?.textContent,
      ].join(" | ");
    expect(actions.map(line)).toEqual([
      "start_session | New session | fix lexer | Fix the lexer overflow.",
      "message_session | Message | fix lexer | please rebase",
      "message_session | Message | ws-9 | No session ws-9 in this project",
      "finish_task | Task finished |  | Lexer fixed, tests green.",
    ]);
    expect(actions[2].className).toContain("banner-failed");
    expect(actions[3].className).toContain("banner-pending");
    // Reads stay among the steps.
    expect(container.querySelector(".step-group")!.textContent).toContain("read_session");

    // The session opens from its name.
    fireEvent.click(actions[0].querySelector("button.action-target")!);
    fireEvent.click(actions[1].querySelector("button.action-target")!);
    expect(open.mock.calls).toEqual([["ws-17-abc"], ["ws-17-abc"]]);

    // The whole task and what the panel answered, a click away.
    fireEvent.click(actions[0].querySelector(".banner-toggle")!);
    expect(actions[0].textContent).toContain("Then run the tests.");
    expect(actions[0].querySelector(".action-result")!.textContent).toContain(
      "Started session ws-17-abc",
    );
  });

  it("name sessions as they are called now, from a history page too", () => {
    // A summary page: no answer yet for the new session, the message's
    // answer cut; the names come from the sessions the panel knows.
    const summary: Message = {
      ...msg,
      detail: "summary",
      events: [
        call("start_session", "**start_session** fix lexer in `wt/lexer`\n\n> Fix it.", {
          resultLength: 80,
        }),
        call("message_session", "**message_session** `ws-17-abc`\n\n> please rebase", {
          toolResult: "Sent to",
          resultLength: 40,
        }),
        call("message_project", "**message_project** `proj-2`\n\n> can you look?", {
          resultLength: 60,
        }),
      ],
    };
    const load = vi.fn();
    const names = new Map([
      ["ws-17-abc", "lexer overflow"],
      ["proj-2", "kotatsu"],
    ]);
    const { container } = render(
      <SessionLinkContext.Provider value={{ nameOf: (id) => names.get(id) }}>
        <MessageItem msg={summary} agents={[]} onLoadDetails={load} />
      </SessionLinkContext.Provider>,
    );
    const actions = [...container.querySelectorAll<HTMLElement>(".banner-action")];
    expect(actions.map((a) => a.querySelector(".action-target")!.textContent)).toEqual([
      "fix lexer",
      "lexer overflow",
      "kotatsu",
    ]);
    expect(actions[1].querySelector(".banner-first-line")!.textContent).toBe("please rebase");
    // Opening one fetches what the page left out.
    fireEvent.click(actions[1].querySelector(".banner-toggle")!);
    expect(load).toHaveBeenCalledWith("m1");
  });
});
