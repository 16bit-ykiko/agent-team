// Loaded on first use (see markdown.tsx): KaTeX and its fonts are larger
// than the rest of the markdown pipeline, and most replies have no math.
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

export const mathRemark = [remarkMath, { singleDollarTextMath: false }] as const;
// A formula KaTeX cannot parse renders as its source in red, never throws.
export const mathRehype = [rehypeKatex, { strict: "ignore" }] as const;
