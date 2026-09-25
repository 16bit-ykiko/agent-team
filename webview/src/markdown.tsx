import { Fragment, useState, useRef, memo, type ComponentProps } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeCodeHighlight } from "./highlight";
import "highlight.js/styles/github-dark.css";

function CodeBlock({ children, ...rest }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <pre {...rest} ref={preRef}>
      <button
        className="copy-btn"
        onClick={() => {
          void navigator.clipboard.writeText(
            preRef.current?.querySelector("code")?.textContent ?? "",
          );
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {children}
    </pre>
  );
}

function ScrollTable(props: ComponentProps<"table">) {
  return (
    <div className="table-scroll-wrapper">
      <table {...props} />
    </div>
  );
}

// A link must never navigate the app itself: a home-screen app has no back
// button, and agents link local paths ([a.cpp:514](/home/...)) that the
// server answers with "Not found". Web links open a new tab; the rest show
// as code with the target on hover.
function Link({ href, children, node: _node, ...rest }: ComponentProps<"a"> & ExtraProps) {
  if (href && /^https?:\/\//i.test(href)) {
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return <code title={href}>{children}</code>;
}

const mdComponents = { pre: CodeBlock, table: ScrollTable, a: Link };
const mdRemarkPlugins = [remarkGfm];
const mdRehypePlugins = [rehypeCodeHighlight];

// Markdown parsing + highlighting is the hottest path during streaming.
// Memoized so a re-render only re-parses blocks whose text actually changed
// (inline plugin arrays would defeat react-markdown's own memoization).
export const MdBlock = memo(function MdBlock({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={mdRemarkPlugins}
      rehypePlugins={mdRehypePlugins}
      components={mdComponents}
    >
      {children}
    </Markdown>
  );
});

// A backtick fence's info string cannot contain a backtick: "```x``` y" is
// inline code, not a fence.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
// Indented (list item continuation, indented code) or a list item: after a
// blank line these can still belong to the block before.
const CONTINUES = /^(\s|[-*+](\s|$)|\d{1,9}[.)](\s|$))/;
// Link and footnote definitions resolve across the whole text, from inside
// quotes and list items too; HTML blocks of CommonMark types 1-5 (<pre>,
// <script>, <style>, <textarea>, comments, <?, <!X, CDATA) run across blank
// lines. Text with either is parsed whole.
const WHOLE_ONLY = new RegExp(
  [
    /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*\[[^\]]+\]:/.source,
    /^ {0,3}(?:<(?:script|pre|style|textarea)(?:\s|>|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/.source,
  ].join("|"),
  "im",
);

// Splits markdown at blank lines outside code fences, only where a single
// parse would also start a new top-level block, so rendering the pieces one
// after another gives the same output as rendering the whole.
export function markdownBlocks(text: string): string[] {
  if (WHOLE_ONLY.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: string | null = null;
  let afterBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    if (!line.trim()) {
      afterBlank = true;
      continue;
    }
    if (afterBlank && !CONTINUES.test(line)) {
      blocks.push(lines.slice(start, i).join("\n"));
      start = i;
    }
    afterBlank = false;
    fence = FENCE_OPEN.exec(line)?.[1] ?? null;
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}

// A streaming reply grows at its end: parsed block by block, the finished
// blocks keep their memoized output and only the last one re-parses per
// frame, instead of the whole reply (quadratic over a long answer).
export function StreamingMdBlock({ children }: { children: string }) {
  return (
    <>
      {markdownBlocks(children).map((block, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <MdBlock>{block}</MdBlock>
        </Fragment>
      ))}
    </>
  );
}
