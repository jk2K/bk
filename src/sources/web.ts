import Turndown from "turndown";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { allowed, withBrowser, type WebSource } from "../browser/index.js";
import { atomic, hash } from "../util.js";
import { matches, type ChangeSet, type Evidence } from "./git.js";
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
export async function scanWeb(
  root: string,
  s: WebSource,
  previous: string | null,
  maxPages: number,
): Promise<ChangeSet> {
  const old: Record<string, string> = previous
    ? JSON.parse(
        await readFile(
          join(root, ".bk/snapshots", s.id, previous + ".json"),
          "utf8",
        ),
      )
    : {};
  const docs: Record<string, string> = {};
  const queue = [{ url: s.url, depth: 0 }];
  const seen = new Set<string>();
  await withBrowser(root, s, async (ctx) => {
    const page = await ctx.newPage();
    while (queue.length) {
      if (seen.size >= Math.min(maxPages, s.crawl.max_pages))
        throw new Error("Page budget exceeded; narrow crawl scope");
      const item = queue.shift()!;
      const u = allowed(item.url, s);
      u.hash = "";
      if (seen.has(u.href)) continue;
      if (!matches(u.pathname, s.crawl.include, s.crawl.exclude)) continue;
      seen.add(u.href);
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
        !matches(new URL(page.url()).pathname, s.crawl.include, s.crawl.exclude)
      )
        throw new Error("AUTH_REQUIRED: redirected outside content scope");
      if (
        s.browser.login_url &&
        new URL(page.url()).pathname === new URL(s.browser.login_url).pathname
      )
        throw new Error("AUTH_REQUIRED");
      if (
        s.browser.auth_selector &&
        (await page.locator(s.browser.auth_selector).count()) === 0
      )
        throw new Error("AUTH_REQUIRED");
      if (await page.locator("input[type=password]").count())
        throw new Error("AUTH_REQUIRED");
      if (s.crawl.wait_for)
        await page
          .locator(s.crawl.wait_for)
          .first()
          .waitFor({ timeout: s.crawl.timeout_ms });
      const extracted = await page.evaluate(() => {
        const area =
          document.querySelector("main,article,[role=main]") ?? document.body;
        const clone = area.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            "nav,header,footer,script,style,noscript,time,[aria-hidden=true]",
          )
          .forEach((n) => n.remove());
        return {
          title: document.title,
          html: clone.innerHTML,
          links: Array.from(area.querySelectorAll("a[href]")).map(
            (a) => (a as HTMLAnchorElement).href,
          ),
        };
      });
      const text = markdown
        .turndown(extracted.html)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text.length < 10)
        throw new Error("Incomplete page; refusing empty snapshot");
      docs[u.href] = `# ${extracted.title}\n\n${text}`;
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
            /* external links are not crawled */
          }
        }
    }
  });
  const revision = hash(JSON.stringify(Object.entries(docs).sort()));
  const evidence: Evidence[] = Object.entries(docs)
    .filter(([u, t]) => old[u] !== t)
    .map(([locator, after]) => ({
      locator,
      kind: old[locator] ? "modified" : "added",
      before: old[locator] ?? "",
      after,
      beforeHash: hash(old[locator] ?? ""),
      afterHash: hash(after),
    }));
  // Missing links cannot prove deletion; preserve previous pages until positively verified.
  await atomic(
    join(root, ".bk/snapshots", s.id, revision + ".json"),
    JSON.stringify(docs),
  );
  return {
    id: hash(JSON.stringify([s.id, s.url, previous, revision, "web-v1"])),
    source: s,
    fromRevision: previous,
    toRevision: revision,
    evidence,
    rebased: false,
    createdAt: new Date().toISOString(),
  };
}
