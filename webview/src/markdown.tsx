import { useState, useRef, memo, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

function CodeBlock({ children, ...rest }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <pre {...rest} ref={preRef}>
      <button
        className="copy-btn"
        onClick={() => {
          navigator.clipboard.writeText(preRef.current?.querySelector("code")?.textContent ?? "");
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

const mdComponents = { pre: CodeBlock, table: ScrollTable };
const mdRemarkPlugins = [remarkGfm];
const mdRehypePlugins = [rehypeHighlight];

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
