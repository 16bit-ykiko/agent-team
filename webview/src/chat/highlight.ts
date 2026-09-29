import type { Element, ElementContent, Root, RootContent } from "hast";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// The languages agents actually fence code in (counted over real stream
// logs). rehype-highlight bundles lowlight's 37 "common" grammars whatever
// `languages` it is given, a third of the app bundle.
const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  lua,
  makefile,
  markdown,
  plaintext,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
});

function language(code: Element): string | null {
  const classes = code.properties.className;
  if (!Array.isArray(classes)) return null;
  for (const cls of classes) {
    const name = String(cls);
    if (name.startsWith("language-")) return name.slice(9);
  }
  return null;
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

function highlightCode(code: Element): void {
  const lang = language(code);
  if (!lang) return;
  const classes = code.properties.className as Array<string | number>;
  classes.unshift("hljs");
  if (!lowlight.registered(lang)) return;
  const tree = lowlight.highlight(lang, code.children.map(textOf).join(""));
  if (tree.children.length > 0) code.children = tree.children as ElementContent[];
}

function visit(node: Root | RootContent, parent: Root | Element | null): void {
  if (node.type === "element") {
    if (node.tagName === "code" && parent?.type === "element" && parent.tagName === "pre") {
      highlightCode(node);
      return;
    }
    for (const child of node.children) visit(child, node);
  } else if (node.type === "root") {
    for (const child of node.children) visit(child, node);
  }
}

// Syntax highlighting for fenced code with a language, as rehype-highlight
// does it: blocks without one stay untouched, unknown languages get the
// code-block styling but no colours.
export function rehypeCodeHighlight() {
  return (tree: Root) => visit(tree, null);
}

// Highlighted tree for a whole file in the file viewer, or null when the
// language is not one of those bundled.
export function highlightTree(lang: string, code: string): Root | null {
  return lowlight.registered(lang) ? lowlight.highlight(lang, code) : null;
}
