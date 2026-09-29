import {
  Fragment,
  useState,
  useRef,
  useMemo,
  useEffect,
  useContext,
  memo,
  type ComponentProps,
} from "react";
import Markdown, { type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeCodeHighlight } from "./highlight";
import { prepareSource } from "./mdSource";
import { FileOpenContext, parseFileRef } from "./fileRef";
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
// as code with the target on hover, and open in the file viewer.
function Link({ href, children, node: _node, ...rest }: ComponentProps<"a"> & ExtraProps) {
  const openFile = useContext(FileOpenContext);
  if (href && /^https?:\/\//i.test(href)) {
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  const target = href?.replace(/^file:\/\//, "");
  if (openFile && target) {
    return (
      <code className="file-ref" title={target} role="button" onClick={() => openFile(target)}>
        {children}
      </code>
    );
  }
  return <code title={href}>{children}</code>;
}

// Inline code naming a file ("src/a.ts:12", "/tmp/report.md") opens it.
function InlineCode({ children, node: _node, ...rest }: ComponentProps<"code"> & ExtraProps) {
  const openFile = useContext(FileOpenContext);
  const text = typeof children === "string" ? children : null;
  if (openFile && text && !text.includes("\n") && !rest.className && parseFileRef(text)) {
    return (
      <code {...rest} className="file-ref" role="button" onClick={() => openFile(text)}>
        {children}
      </code>
    );
  }
  return <code {...rest}>{children}</code>;
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
  return (
    <Markdown
      remarkPlugins={math?.remark ?? mdRemarkPlugins}
      rehypePlugins={math?.rehype ?? mdRehypePlugins}
      components={mdComponents}
    >
      {text}
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
