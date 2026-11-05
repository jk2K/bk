import { chromium, type BrowserContext } from "playwright";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Source } from "../config/index.js";
import { matches } from "../sources/git.js";
import { lock, run } from "../util.js";
export type WebSource = Extract<Source, { type: "web" }>;
export function allowed(url: string, s: WebSource, login = false) {
  const u = new URL(url);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    !s.crawl.allowed_hosts.includes(u.host)
  )
    throw new Error(`URL outside allowed hosts: ${u.origin}`);
  if (
    login &&
    s.browser.login_url &&
    u.origin !== new URL(s.browser.login_url).origin
  )
    throw new Error("Login origin not allowed");
  return u;
}
export async function withBrowser<T>(
  root: string,
  s: WebSource,
  fn: (ctx: BrowserContext) => Promise<T>,
  headed = false,
) {
  try {
    await run(
      "git",
      ["check-ignore", "--quiet", "--", ".bk/browser-profiles/profile"],
      root,
    );
  } catch {
    throw new Error("Add .bk/ to .gitignore before browser login");
  }
  const release = await lock(
    join(root, ".bk/locks", `profile-${s.browser.profile}.lock`),
  );
  let ctx: BrowserContext | undefined;
  try {
    await mkdir(join(root, ".bk/browser-profiles"), {
      recursive: true,
      mode: 0o700,
    });
    ctx = await chromium.launchPersistentContext(
      join(root, ".bk/browser-profiles", s.browser.profile),
      {
        headless: headed ? false : s.browser.headless,
        ...(process.env.BK_CHROMIUM_EXECUTABLE_PATH
          ? {
              executablePath: process.env.BK_CHROMIUM_EXECUTABLE_PATH,
              args:
                process.env.BK_CHROMIUM_NO_SANDBOX === "1"
                  ? ["--no-sandbox"]
                  : [],
            }
          : {}),
        acceptDownloads: false,
        serviceWorkers: "block",
      },
    );
    if (!headed) await installReadonlyPolicy(ctx, s);
    return await fn(ctx);
  } finally {
    await ctx?.close().catch(() => {});
    await release();
  }
}
export async function browserLogin(root: string, s: WebSource) {
  allowed(s.browser.login_url ?? s.url, s);
  await withBrowser(
    root,
    s,
    async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(s.browser.login_url ?? s.url);
      await new Promise<void>((resolve) => ctx.once("close", () => resolve()));
    },
    true,
  );
}

export async function installReadonlyPolicy(ctx: BrowserContext, s: WebSource) {
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    try {
      const u = allowed(req.url(), s);
      if (
        req.isNavigationRequest() &&
        !matches(u.pathname, s.crawl.include, s.crawl.exclude)
      )
        throw new Error("Navigation outside source scope");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method()))
        throw new Error("Write request blocked");
      await route.continue();
    } catch {
      await route.abort();
    }
  });
}
