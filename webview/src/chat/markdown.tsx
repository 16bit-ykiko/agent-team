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
import { FILE_EXT, FILE_NAME, FileOpenContext, linkFileRef, parseFileRef } from "./fileRef";
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

interface Found {
  index: number;
  text: string;
  url: string;
}

// Text nodes only: never inside code, nor inside a link of its own.
function linkText(node: MdNode, find: (text: string) => Found[]): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value) {
      linkText(child, find);
      return [child];
    }
    const text = child.value;
    const parts: MdNode[] = [];
    let last = 0;
    for (const f of find(text)) {
      if (f.index > last) parts.push({ type: "text", value: text.slice(last, f.index) });
      parts.push({ type: "link", url: f.url, children: [{ type: "text", value: f.text }] });
      last = f.index + f.text.length;
    }
    if (parts.length === 0) return [child];
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
    return parts;
  });
}

function remarkIssueRefs(pattern: RegExp) {
  const find = (text: string) =>
    [...text.matchAll(pattern)].map((m) => ({
      index: m.index,
      text: m[0],
      url: ISSUE_HREF + encodeURIComponent(m[0]),
    }));
  return () => (tree: MdNode) => linkText(tree, find);
}

// Where it is on (the board), file paths written in prose, not in code or a
// link ("见 notes/ideas.md。"), link to the file: those with a folder in
// them, as a file reference reads them, that it can open. A path in code
// or a link it cannot open is no link either.
export const ProsePathContext = createContext<((path: string) => boolean) | null>(null);

// A path may follow a word in Chinese ("见src/a.cpp"), but a slash right
// after one joins words ("孤儿/ABA/无上界"), it starts no absolute path.
const PROSE_PATH =
  /(?<![\w./~:#{}@$%+-])(?:~\/|\.{1,2}\/|(?<![\p{L}\p{N}])\/)?(?:[\w.-]+\/)+[\w.-]*(?::\d+(?:-\d+)?)?/gu;

export function prosePaths(text: string): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(PROSE_PATH)) {
    // A sentence's own full stop is not part of the name.
    const t = m[0].replace(/[.:]+$/, "");
    const ref = parseFileRef(t);
    if (!ref || !ref.path.slice(0, -1).includes("/")) continue;
    // Words run on past a slash ("UTF-16/CRLF/代理对", "docs/{en,zh}/"), or
    // alternatives ("clice.toml/compile_commands.json", ".cppm/.cpp").
    const next = text.slice(m.index + m[0].length);
    if (ref.path.endsWith("/") && /^[\p{L}\p{N}{]/u.test(next)) continue;
    const segments = ref.path.split("/").filter(Boolean);
    if (segments.slice(0, -1).some(namesFile) || segments.some(onlyExtension)) continue;
    out.push({ index: m.index, text: t, url: t });
  }
  return out;
}

function namesFile(segment: string): boolean {
  return FILE_EXT.test(segment) || (FILE_NAME.test(segment) && !segment.startsWith("."));
}

function onlyExtension(segment: string): boolean {
  return /^\.[^.]+$/.test(segment) && FILE_EXT.test(segment);
}

function remarkProsePaths(accept: (path: string) => boolean) {
  const find = (text: string) =>
    prosePaths(text).filter((f) => accept(parseFileRef(f.text)?.path ?? f.text));
  return () => (tree: MdNode) => linkText(tree, find);
}

// Which paths in prose link, where the board turns them on and has a viewer.
function useProsePaths(): ((path: string) => boolean) | null {
  const openFile = useContext(FileOpenContext);
  const accept = useContext(ProsePathContext);
  return openFile ? accept : null;
}

// Whether a file reference may link here: anywhere a viewer opens files,
// except paths the board cannot open.
function useOpenable(): ((ref: string) => boolean) | null {
  const openFile = useContext(FileOpenContext);
  const accept = useContext(ProsePathContext);
  return useMemo(
    () => openFile && ((ref: string) => !accept || accept(parseFileRef(ref)?.path ?? ref)),
    [openFile, accept],
  );
}

// Inside a button: no link of its own (an issue, a file).
export function NoLinks({ children }: { children: ReactNode }) {
  return (
    <IssueRefContext.Provider value={null}>
      <ProsePathContext.Provider value={null}>
        <FileOpenContext.Provider value={null}>{children}</FileOpenContext.Provider>
      </ProsePathContext.Provider>
    </IssueRefContext.Provider>
  );
}

// The issue an href links to, if it is one. Text can spell one out by
// hand, badly escaped too.
function issueOf(href: string | undefined): string | null {
  if (!href?.startsWith(ISSUE_HREF)) return null;
  try {
    return decodeURIComponent(href.slice(ISSUE_HREF.length));
  } catch {
    return null;
  }
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
  className,
  children,
}: {
  target: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const openFile = useContext(FileOpenContext)!;
  // A drag selecting the path to copy it ends in a click on it; a click,
  // on a selected path too, does not move.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  return (
    <code
      className={className ? `${className} file-ref` : "file-ref"}
      title={title}
      role="button"
      tabIndex={0}
      onMouseDown={(e) => {
        pressedAt.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        const from = pressedAt.current;
        const dragged = !!from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 3;
        if (dragged && !(window.getSelection()?.isCollapsed ?? true)) return;
        openFile(target);
      }}
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
  const openable = useOpenable();
  const issue = useContext(IssueRefContext) ? issueOf(href) : null;
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
      {openable && target && openable(target) ? (
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
  const openable = useOpenable();
  const inLink = useContext(InLink);
  const text = typeof children === "string" ? children : null;
  if (
    openable &&
    !inLink &&
    text &&
    !text.includes("\n") &&
    !rest.className &&
    parseFileRef(text) &&
    openable(text)
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
  const paths = useProsePaths();
  const remark = math?.remark ?? mdRemarkPlugins;
  const remarkPlugins = useMemo(
    () =>
      refs || paths
        ? [
            ...(remark ?? []),
            ...(refs ? [remarkIssueRefs(refs.pattern)] : []),
            ...(paths ? [remarkProsePaths(paths)] : []),
          ]
        : remark,
    [refs, paths, remark],
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
// Only what the board's plugins link gets here (see InlineMd): an issue, a
// file; any other link is text.
function InlineLink({ href, children }: ComponentProps<"a">) {
  const openable = useOpenable();
  const issue = issueOf(href);
  if (issue) return <IssueLink id={issue}>{children}</IssueLink>;
  const target = openable && href ? linkFileRef(href) : null;
  return (
    <InLink.Provider value={true}>
      {target && openable?.(target) ? (
        <FileRefCode target={target}>{children}</FileRefCode>
      ) : (
        children
      )}
    </InLink.Provider>
  );
}
// Code naming a file opens it where the board links paths.
function InlineCodeText({ children }: { children?: ReactNode }) {
  const paths = useProsePaths();
  const openable = useOpenable();
  const inLink = useContext(InLink);
  const text = typeof children === "string" ? children : null;
  return paths && openable && !inLink && text && parseFileRef(text) && openable(text) ? (
    <FileRefCode target={text} className="inline-code">
      {children}
    </FileRefCode>
  ) : (
    <code className="inline-code">{children}</code>
  );
}
const inlineComponents: Options["components"] = {
  p: ({ children }) => <>{children}</>,
  code: ({ children }) => <InlineCodeText>{children}</InlineCodeText>,
  a: ({ href, children }) => <InlineLink href={href}>{children}</InlineLink>,
};
const INLINE_WITH_LINKS = [...INLINE_ELEMENTS, "a"];
export const InlineMd = memo(function InlineMd({ children }: { children: string }) {
  const refs = useContext(IssueRefContext);
  const paths = useProsePaths();
  const remarkPlugins = useMemo(
    () =>
      refs || paths
        ? [
            ...(mdRemarkPlugins ?? []),
            ...(refs ? [remarkIssueRefs(refs.pattern)] : []),
            ...(paths ? [remarkProsePaths(paths)] : []),
          ]
        : mdRemarkPlugins,
    [refs, paths],
  );
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      allowedElements={refs || paths ? INLINE_WITH_LINKS : INLINE_ELEMENTS}
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
