import { JSDOM } from "jsdom";
import { run } from "../util.js";
let parser: Promise<typeof import("mermaid")> | undefined;
export async function validateMarkdown(markdown: string) {
  if (/%%\{|^\s*click\s|<script|javascript:/im.test(markdown))
    throw new Error("Unsafe Markdown/Mermaid directive");
  const diagrams = [...markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );
  if (diagrams.length) {
    if (!parser) {
      const dom = new JSDOM("<!doctype html><html><body></body></html>");
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
      });
      parser = import("mermaid");
    }
    const mermaid = (await parser).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    for (const code of diagrams) await mermaid.parse(code);
  }
}
export async function validateLinks(
  root: string,
  revision: string,
  path: string,
  markdown: string,
) {
  const { posix } = await import("node:path");
  for (const m of markdown.matchAll(
    /\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const url = m[1];
    if (url.startsWith("#") || /^https?:\/\//i.test(url)) continue;
    if (/^[a-z]+:/i.test(url))
      throw new Error(`Unsupported link protocol: ${url}`);
    const target = posix.normalize(
      posix.join(posix.dirname(path), decodeURIComponent(url.split("#")[0])),
    );
    if (target.startsWith("..") || target.startsWith("/"))
      throw new Error(`Link outside repository: ${url}`);
    try {
      await run("git", ["cat-file", "-e", `${revision}:${target}`], root);
    } catch {
      throw new Error(`Broken local link: ${path} -> ${url}`);
    }
  }
}
