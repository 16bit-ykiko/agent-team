import {
  Fragment,
  createContext,
  useState,
  useRef,
  useMemo,
  useEffect,
  useContext,
  memo,
  type ComponentProps,
  type ReactNode,
} from "react";
import Markdown, { defaultUrlTransform, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeCodeHighlight } from "./highlight";
import { prepareSource } from "./mdSource";
import { FileOpenContext, linkFileRef, parseFileRef } from "./fileRef";
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

// Inside a link, code is part of the link's text, not a reference of its own.
const InLink = createContext(false);

// Where it is given (the board's objective details), the ids of the
// project's issues named in text link to the issue.
export interface IssueRefs {
  pattern: RegExp;
  open: (id: string) => void;
}
export const IssueRefContext = createContext<IssueRefs | null>(null);

const ISSUE_HREF = "#issue:";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

// Text nodes only: never inside code, nor inside a link of its own.
function linkIssueRefs(node: MdNode, pattern: RegExp): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value) {
      linkIssueRefs(child, pattern);
      return [child];
    }
    const text = child.value;
    const parts: MdNode[] = [];
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
      parts.push({
        type: "link",
        url: ISSUE_HREF + encodeURIComponent(m[0]),
        children: [{ type: "text", value: m[0] }],
      });
      last = m.index + m[0].length;
    }
    if (parts.length === 0) return [child];
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
    return parts;
  });
}

function remarkIssueRefs(pattern: RegExp) {
  return () => (tree: MdNode) => linkIssueRefs(tree, pattern);
}

// The issue an href links to, if it is one.
function issueOf(href: string | undefined): string | null {
  return href?.startsWith(ISSUE_HREF) ? decodeURIComponent(href.slice(ISSUE_HREF.length)) : null;
}

function IssueLink({ id, children }: { id: string; children: ReactNode }) {
  const refs = useContext(IssueRefContext);
  return (
    <button
      type="button"
      className="issue-ref"
      title={`Issue ${id}`}
      onClick={() => refs?.open(id)}
    >
      {children}
    </button>
  );
}

function FileRefCode({
  target,
  title,
  children,
}: {
  target: string;
  title?: string;
  children: ReactNode;
}) {
  const openFile = useContext(FileOpenContext)!;
  return (
    <code
      className="file-ref"
      title={title}
      role="button"
      tabIndex={0}
      onClick={() => openFile(target)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        openFile(target);
      }}
    >
      {children}
    </code>
  );
}

// A link must never navigate the app itself: a home-screen app has no back
// button, and agents link local paths ([a.cpp:514](/home/...)) that the
// server answers with "Not found". Web links open a new tab; the rest show
// as code with the target on hover, and open in the file viewer.
function Link({ href, children, node: _node, ...rest }: ComponentProps<"a"> & ExtraProps) {
  const openFile = useContext(FileOpenContext);
  const issue = issueOf(href);
  if (issue) return <IssueLink id={issue}>{children}</IssueLink>;
  if (href && /^(https?:|mailto:)/i.test(href)) {
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        <InLink.Provider value={true}>{children}</InLink.Provider>
      </a>
    );
  }
  const target = href ? linkFileRef(href) : null;
  return (
    <InLink.Provider value={true}>
      {openFile && target ? (
        <FileRefCode target={target} title={target}>
          {children}
        </FileRefCode>
      ) : (
        <code title={href}>{children}</code>
      )}
    </InLink.Provider>
  );
}

// Inline code naming a file ("src/a.ts:12", "/tmp/report.md") opens it.
function InlineCode({ children, node: _node, ...rest }: ComponentProps<"code"> & ExtraProps) {
  const openFile = useContext(FileOpenContext);
  const inLink = useContext(InLink);
  const text = typeof children === "string" ? children : null;
  if (
    openFile &&
    !inLink &&
    text &&
    !text.includes("\n") &&
    !rest.className &&
    parseFileRef(text)
  ) {
    return <FileRefCode target={text}>{children}</FileRefCode>;
  }
  return <code {...rest}>{children}</code>;
}

// react-markdown blanks hrefs with a scheme it does not know, and "a.ts:12"
// reads as one; Link decides what a local target is.
function urlTransform(url: string): string {
  return /^file:\/\//i.test(url) || linkFileRef(url) ? url : defaultUrlTransform(url);
}

const mdComponents = { pre: CodeBlock, table: ScrollTable, a: Link, code: InlineCode };
const mdRemarkPlugins: Options["remarkPlugins"] = [remarkGfm];
const mdRehypePlugins: Options["rehypePlugins"] = [rehypeCodeHighlight];

interface MathPlugins {
  remark: Options["remarkPlugins"];
  rehype: Options["rehypePlugins"];
}
let mathPlugins: MathPlugins | null = null;
let mathLoading: Promise<MathPlugins> | null = null;

export function loadMath(): Promise<MathPlugins> {
  mathLoading ??= import("./mathPlugins").then(
    ({ mathRemark, mathRehype }) => {
      mathPlugins = {
        remark: [...mdRemarkPlugins!, [...mathRemark]],
        // KaTeX first: a ```math block must not reach the highlighter.
        rehype: [[...mathRehype], ...mdRehypePlugins!],
      };
      return mathPlugins;
    },
    (e: unknown) => {
      // Offline, or a chunk gone after a redeploy: the next block retries.
      mathLoading = null;
      throw e;
    },
  );
  return mathLoading;
}

// Plugins for text with math: null until KaTeX has loaded (the text shows
// its raw TeX meanwhile), then the block re-renders with them.
function useMathPlugins(needed: boolean): MathPlugins | null {
  const [plugins, setPlugins] = useState(mathPlugins);
  useEffect(() => {
    if (needed && !plugins) loadMath().then(setPlugins, () => {});
  }, [needed, plugins]);
  return needed ? (plugins ?? mathPlugins) : null;
}

// Markdown parsing + highlighting is the hottest path during streaming.
// Memoized so a re-render only re-parses blocks whose text actually changed
// (inline plugin arrays would defeat react-markdown's own memoization).
export const MdBlock = memo(function MdBlock({ children }: { children: string }) {
  const { text, hasMath } = useMemo(() => prepareSource(children), [children]);
  const math = useMathPlugins(hasMath);
  const refs = useContext(IssueRefContext);
  const remark = math?.remark ?? mdRemarkPlugins;
  const remarkPlugins = useMemo(
    () => (refs ? [...(remark ?? []), remarkIssueRefs(refs.pattern)] : remark),
    [refs, remark],
  );
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={math?.rehype ?? mdRehypePlugins}
      components={mdComponents}
      urlTransform={urlTransform}
    >
      {text}
    </Markdown>
  );
});

// Text written as markdown (a task, an objective's title or goal) shown in
// a row: one paragraph, its code, bold and italics; no blocks or links.
const INLINE_ELEMENTS = ["p", "code", "strong", "em", "del"];
// "1. first", "- item", "# 640": text, not a list or a heading.
const BLOCK_START = /^(?:(\d{1,9})([.)])|([-+*>]|#{1,6}))(?=\s|$)/;
const inlineComponents: Options["components"] = {
  p: ({ children }) => <>{children}</>,
  code: ({ children }) => <code className="inline-code">{children}</code>,
  // Only issue references get here (see InlineMd); any other link is text.
  a: ({ href, children }) => {
    const issue = issueOf(href);
    return issue ? <IssueLink id={issue}>{children}</IssueLink> : <>{children}</>;
  },
};
const INLINE_WITH_LINKS = [...INLINE_ELEMENTS, "a"];
export const InlineMd = memo(function InlineMd({ children }: { children: string }) {
  const refs = useContext(IssueRefContext);
  const remarkPlugins = useMemo(
    () => (refs ? [...(mdRemarkPlugins ?? []), remarkIssueRefs(refs.pattern)] : mdRemarkPlugins),
    [refs],
  );
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      allowedElements={refs ? INLINE_WITH_LINKS : INLINE_ELEMENTS}
      unwrapDisallowed
      components={inlineComponents}
    >
      {children
        .trim()
        .replace(/\s*\n\s*/g, " ")
        .replace(BLOCK_START, (_, n: string, dot: string, mark: string) =>
          n ? `${n}\\${dot}` : `\\${mark}`,
        )}
    </Markdown>
  );
});

// A backtick fence's info string cannot contain a backtick: "```x``` y" is
// inline code, not a fence.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
// Display math may hold blank lines: $$ or \[ starting a line and not
// closed on it runs to a line that ends with $$ or \].
const MATH_OPEN = /^\s*(\$\$|\\\[)(.*)$/;
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
  let mathClose: string | null = null;
  let afterBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mathClose) {
      if (line.trimEnd().endsWith(mathClose)) mathClose = null;
      continue;
    }
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close?.[0] === fence[0] && close.length >= fence.length) fence = null;
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
    const math = MATH_OPEN.exec(line);
    const closer = math?.[1] === "$$" ? "$$" : "\\]";
    if (math && !math[2].trimEnd().endsWith(closer)) mathClose = closer;
    else fence = FENCE_OPEN.exec(line)?.[1] ?? null;
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
