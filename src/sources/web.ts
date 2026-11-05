import Turndown from "turndown";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { allowed, withBrowser, type WebSource } from "../browser/index.js";
import {
  approvedRecipe,
  replayRecipe,
  RecipeSchema,
} from "../browser/session.js";
import { atomic, hash } from "../util.js";
import { matches, type ChangeSet, type Evidence } from "./git.js";
import { collectImage, type ImageAsset } from "./assets.js";
import type { Config } from "../config/index.js";
import type { AgentProvider } from "../agent/index.js";
const markdown = new Turndown({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
markdown.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    const rows = Array.from((node as HTMLTableElement).rows).map((r) =>
      Array.from(r.cells).map((c) =>
        (c.textContent ?? "").trim().replace(/\|/g, "\\|").replace(/\n/g, " "),
      ),
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) =>
      "| " +
      Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ") +
      " |";
    return (
      "\n\n" +
      [
        line(rows[0]),
        line(Array(width).fill("---")),
        ...rows.slice(1).map(line),
      ].join("\n") +
      "\n\n"
    );
  },
});
export async function extractPage(page: Page) {
  const data = await page.evaluate(() => {
    const area =
        document.querySelector("main,article,[role=main]") ?? document.body,
      clone = area.cloneNode(true) as HTMLElement;
    const original = [area, ...area.querySelectorAll("*")],
      copies = [clone, ...clone.querySelectorAll("*")];
    for (let i = original.length - 1; i >= 0; i--) {
      const n = original[i],
        style = getComputedStyle(n);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        n.getAttribute("aria-hidden") === "true"
      )
        copies[i].remove();
    }
    // Native closed details are not visible except for their summaries.
    clone.querySelectorAll("details:not([open])").forEach((n) =>
      Array.from(n.children)
        .filter((c) => c.tagName !== "SUMMARY")
        .forEach((c) => c.remove()),
    );
    clone
      .querySelectorAll(
        "nav,header,footer,script,style,noscript,time,input,textarea,[aria-hidden=true]",
      )
      .forEach((n) => n.remove());
    clone.querySelectorAll("a[href]").forEach((a) => {
      try {
        a.setAttribute(
          "href",
          new URL(a.getAttribute("href")!, document.baseURI).href,
        );
      } catch {
        a.removeAttribute("href");
      }
    });
    clone.querySelectorAll("img").forEach((img) => {
      const originalImage = Array.from(area.querySelectorAll("img")).find(
        (n) => n.getAttribute("src") === img.getAttribute("src"),
      );
      const url = originalImage?.currentSrc || originalImage?.src;
      if (url) img.src = url;
    });
    return {
      title: document.title,
      html: clone.innerHTML,
      links: Array.from(clone.querySelectorAll("a[href]")).map((a) =>
        a.getAttribute("href")!,
      ),
      images: Array.from(clone.querySelectorAll("img[src]")).map(
        (img) => (img as HTMLImageElement).src,
      ),
    };
  });
  return {
    ...data,
    markdown: markdown
      .turndown(data.html)
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}
export interface WebScanOptions {
  config?: Config;
  agent?: AgentProvider;
  onUsage?: (usage: unknown) => void;
  beforeExplore?: () => void;
}
export async function scanWeb(
  root: string,
  s: WebSource,
  previous: string | null,
  maxPages: number,
  options: WebScanOptions = {},
): Promise<ChangeSet> {
  const initial = allowed(s.url, s);
  if (!matches(initial.pathname, s.crawl.include, s.crawl.exclude))
    throw new Error("Source URL outside crawl scope");
  const old: Record<string, string> = previous
    ? JSON.parse(
        await readFile(
          join(root, ".bk/snapshots", s.id, previous + ".json"),
          "utf8",
        ),
      )
    : {};
  const docs: Record<string, string> = {},
    images: ImageAsset[] = [];
  const queue = [{ url: s.url, depth: 0 }],
    seen = new Set<string>();
  const c = options.config;
  await withBrowser(root, s, async (ctx) => {
    const page = await ctx.newPage();
    let recipe = c ? await approvedRecipe(root, s, c) : null;
    while (queue.length) {
      const item = queue.shift()!,
        u = allowed(item.url, s);
      u.hash = "";
      if (
        seen.has(u.href) ||
        !matches(u.pathname, s.crawl.include, s.crawl.exclude)
      )
        continue;
      if (seen.size >= Math.min(maxPages, s.crawl.max_pages))
        throw new Error("Page budget exceeded; narrow crawl scope");
      seen.add(u.href);
      const navigate = async () => {
        const response = await page.goto(u.href, {
          waitUntil: "domcontentloaded",
          timeout: s.crawl.timeout_ms,
        });
        if (response && [401, 403].includes(response.status()))
          throw new Error("AUTH_REQUIRED");
        if (response && !response.ok())
          throw new Error(`HTTP ${response.status()}`);
        allowed(page.url(), s);
        if (
          !matches(
            new URL(page.url()).pathname,
            s.crawl.include,
            s.crawl.exclude,
          )
        )
          throw new Error("AUTH_REQUIRED: redirected outside content scope");
        if (
          s.browser.login_url &&
          new URL(page.url()).pathname === new URL(s.browser.login_url).pathname
        )
          throw new Error("AUTH_REQUIRED");
        if (
          (s.browser.auth_selector &&
            (await page.locator(s.browser.auth_selector).count()) === 0) ||
          (await page.locator("input[type=password]").count())
        )
          throw new Error("AUTH_REQUIRED");
        if (s.crawl.wait_for)
          await page
            .locator(s.crawl.wait_for)
            .first()
            .waitFor({ timeout: s.crawl.timeout_ms });
      };
      await navigate();
      let usedRecipe = false;
      const needsExploration =
        s.browser.interactive ||
        !!(recipe && item.depth === 0) ||
        recipe?.url === page.url();
      if (recipe?.url === page.url())
        try {
          await replayRecipe(page, s, recipe);
          usedRecipe = true;
        } catch {
          await navigate();
        }
      if (
        !usedRecipe &&
        needsExploration &&
        c?.agent.allow_interactive_browser &&
        options.agent
      ) {
        if (!options.agent.explorePage)
          throw new Error("Interactive browser provider unavailable");
        options.beforeExplore?.();
        const explored = await options.agent.explorePage(page, s, c);
        options.onUsage?.(explored.usage);
        const recorded = RecipeSchema.parse(explored.recipe);
        // Replay on a fresh navigation and compare extracted content before emitting a script-free draft.
        const expected = (await extractPage(page)).markdown;
        await navigate();
        await replayRecipe(page, s, recorded);
        if ((await extractPage(page)).markdown !== expected)
          throw new Error("Browser recipe verification failed");
        await atomic(
          join(root, ".bk/recipe-drafts", s.id, hash(recorded.url) + ".json"),
          JSON.stringify(recorded, null, 2) + "\n",
        );
        usedRecipe = true;
      }
      if (needsExploration && !usedRecipe)
        throw new Error(
          "INTERACTIVE_REQUIRED: use bk sync with allowed interactive browsing, or commit a valid approved Recipe",
        );
      const extracted = await extractPage(page);
      if (extracted.markdown.length < 10 && !extracted.images.length)
        throw new Error("Incomplete page; refusing empty snapshot");
      let body = extracted.markdown;
      if (c?.compiler.image.enabled) {
        const urls = [...new Set(extracted.images)];
        if (urls.length > c.compiler.image.max_per_page)
          throw new Error(
            "Image count budget exceeded; narrow page or increase limit",
          );
        for (const url of urls) {
          const image = await collectImage(
            root,
            ctx.request,
            s,
            url,
            c.compiler.image.max_bytes,
          );
          images.push(image);
          if (images.length > c.compiler.image.max_per_run)
            throw new Error("Image run budget exceeded");
          body += `\n\nIMAGE SHA256 ${image.hash}\nSource image: ${image.url}\n`;
        }
      }
      docs[u.href] = `# ${extracted.title}\n\n${body}`;
      if (Object.values(docs).join("").length > 2_000_000)
        throw new Error("Content budget exceeded");
      if (item.depth < s.crawl.max_depth)
        for (const link of extracted.links) {
          try {
            const next = allowed(link, s);
            next.hash = "";
            if (
              matches(next.pathname, s.crawl.include, s.crawl.exclude) &&
              !seen.has(next.href) &&
              !queue.some((i) => i.url === next.href)
            )
              queue.push({ url: next.href, depth: item.depth + 1 });
          } catch {
            /* external or unsupported links are not crawled */
          }
        }
    }
  });
  // Unlinked pages are retained; link disappearance is not deletion evidence.
  const snapshot = { ...old, ...docs },
    revision = hash(JSON.stringify(Object.entries(snapshot).sort()));
  const evidence: Evidence[] = Object.entries(docs)
    .filter(([url, text]) => old[url] !== text)
    .map(([locator, after]) => ({
      locator,
      kind: old[locator] ? "modified" : "added",
      before: old[locator] ?? "",
      after,
      beforeHash: hash(old[locator] ?? ""),
      afterHash: hash(after),
    }));
  await atomic(
    join(root, ".bk/snapshots", s.id, revision + ".json"),
    JSON.stringify(snapshot),
  );
  return {
    id: hash(JSON.stringify([s.id, s.url, previous, revision, "web-v2"])),
    source: s,
    fromRevision: previous,
    toRevision: revision,
    evidence,
    images,
    rebased: false,
    createdAt: new Date().toISOString(),
  };
}
