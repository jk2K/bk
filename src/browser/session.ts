import type { Page } from "playwright";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WebSource } from "./index.js";
import { allowed } from "./index.js";
import { redact, hash, run, safePath } from "../util.js";
import type { Config } from "../config/index.js";
import { baselineRef } from "../knowledge/index.js";
export const ExplorationSchema = z
  .object({
    completed: z.boolean(),
    uncertainties: z.array(z.string()).max(20),
  })
  .strict();
export const StepSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("click"),
      selector: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      action: z.literal("search"),
      selector: z.string().min(1).max(300),
      query: z.string().max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      pixels: z.number().int().min(0).max(1200),
    })
    .strict(),
]);
export const RecipeSchema = z
  .object({
    version: z.literal(1),
    source_id: z.string(),
    url: z.string().url(),
    scope_hash: z.string().length(64),
    steps: z.array(StepSchema).max(30),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: redact(JSON.stringify(value)) }],
});
export const browserScope = (s: WebSource) =>
  hash(
    JSON.stringify({
      id: s.id,
      url: s.url,
      hosts: s.crawl.allowed_hosts,
      include: s.crawl.include,
      exclude: s.crawl.exclude,
      selectors: s.browser.readonly_selectors,
    }),
  );
export class BrowserSession {
  private calls = 0;
  private steps: Recipe["steps"] = [];
  readonly initialURL: string;
  constructor(
    readonly page: Page,
    readonly source: WebSource,
  ) {
    this.initialURL = page.url();
  }
  private check() {
    if (++this.calls > 128) throw new Error("Browser tool budget exceeded");
    allowed(this.page.url(), this.source);
    if (this.page.url() !== this.initialURL)
      throw new Error("Browser tool changed document URL");
  }
  async snapshot() {
    this.check();
    return this.page.evaluate(() => {
      const body =
        document.querySelector("main,article,[role=main]") ?? document.body;
      const clone = body.cloneNode(true) as HTMLElement;
      const originals = [body, ...body.querySelectorAll("*")],
        copies = [clone, ...clone.querySelectorAll("*")];
      for (let i = originals.length - 1; i >= 0; i--) {
        const style = getComputedStyle(originals[i]);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          originals[i].getAttribute("aria-hidden") === "true"
        )
          copies[i].remove();
      }
      clone.querySelectorAll("details:not([open])").forEach((n) =>
        Array.from(n.children)
          .filter((c) => c.tagName !== "SUMMARY")
          .forEach((c) => c.remove()),
      );
      clone
        .querySelectorAll("script,style,nav,footer,header,input,textarea")
        .forEach((n) => n.remove());
      return {
        title: document.title,
        text: (clone.textContent ?? "").slice(0, 16000),
        controls: Array.from(
          body.querySelectorAll(
            "summary,button,[role=tab],[aria-expanded],input[type=search]",
          ),
        )
          .slice(0, 60)
          .map((n) => ({
            tag: n.tagName,
            id: n.id,
            role: n.getAttribute("role"),
            label: (n.textContent ?? "").trim().slice(0, 100),
            expanded: n.getAttribute("aria-expanded"),
          })),
      };
    });
  }
  private async control(selector: string, search = false) {
    this.check();
    const target = this.page.locator(selector);
    if ((await target.count()) !== 1)
      throw new Error("Control selector must match exactly one element");
    const nativeSummary = await target.evaluate(
      (n) => n.tagName === "SUMMARY" && n.parentElement?.tagName === "DETAILS",
    );
    if (
      !nativeSummary &&
      !this.source.browser.readonly_selectors.includes(selector)
    )
      throw new Error("Control selector is not explicitly allowed");
    const safe = await target.evaluate((n, isSearch) => {
      if (isSearch)
        return (
          n.tagName === "INPUT" && (n as HTMLInputElement).type === "search"
        );
      if (
        n.tagName === "A" ||
        n.tagName === "INPUT" ||
        (n.tagName === "BUTTON" && (n as HTMLButtonElement).type !== "button")
      )
        return false;
      return (
        (n.tagName === "SUMMARY" && n.parentElement?.tagName === "DETAILS") ||
        (n.tagName === "BUTTON" &&
          (n as HTMLButtonElement).type === "button") ||
        n.getAttribute("role") === "tab"
      );
    }, search);
    if (!safe)
      throw new Error(
        "Only native summary, type=button, tabs and approved search inputs are permitted",
      );
    return target;
  }
  async perform(step: z.infer<typeof StepSchema>) {
    StepSchema.parse(step);
    if (this.steps.length >= 30)
      throw new Error("Browser recipe step budget exceeded");
    if (step.action === "click") {
      await (
        await this.control(step.selector)
      ).click({ timeout: this.source.crawl.timeout_ms });
    } else if (step.action === "search") {
      await (
        await this.control(step.selector, true)
      ).fill(step.query, { timeout: this.source.crawl.timeout_ms });
    } else {
      this.check();
      await this.page.evaluate(
        (pixels) => window.scrollBy(0, pixels),
        step.pixels,
      );
    }
    this.check();
    this.steps.push(step);
    return this.snapshot();
  }
  recipe(): Recipe {
    return {
      version: 1,
      source_id: this.source.id,
      url: this.initialURL,
      scope_hash: browserScope(this.source),
      steps: [...this.steps],
    };
  }
  tools() {
    const defs = [
      tool(
        "browser_snapshot",
        "Read current page text and available document controls. No credentials or input values.",
        {},
        async () => text(await this.snapshot()),
      ),
      tool(
        "browser_click_readonly",
        "Expand native summary or an explicitly approved readonly button/tab. Forms and links are forbidden.",
        { selector: z.string().min(1).max(300) },
        async (args) => text(await this.perform({ action: "click", ...args })),
      ),
      tool(
        "browser_fill_search",
        "Fill an explicitly approved input[type=search] without submitting any form.",
        { selector: z.string().min(1).max(300), query: z.string().max(200) },
        async (args) => text(await this.perform({ action: "search", ...args })),
      ),
      tool(
        "browser_screenshot",
        "Read a bounded viewport screenshot with form fields masked. No credentials are persisted.",
        {},
        async () => {
          this.check();
          const image = await this.page.screenshot({
            type: "png",
            fullPage: false,
            mask: [this.page.locator("input,textarea,[data-sensitive]")],
          });
          if (image.length > 2000000)
            throw new Error("Screenshot byte budget exceeded");
          return {
            content: [
              {
                type: "image" as const,
                data: image.toString("base64"),
                mimeType: "image/png",
              },
            ],
          };
        },
      ),
      tool(
        "browser_scroll",
        "Scroll the current document within a bounded step.",
        { pixels: z.number().int().min(0).max(1200) },
        async (args) => text(await this.perform({ action: "scroll", ...args })),
      ),
    ];
    return {
      server: createSdkMcpServer({
        name: "bk",
        version: "0.2.0",
        alwaysLoad: true,
        tools: defs,
      }),
      toolNames: defs.map((d) => "mcp__bk__" + d.name),
    };
  }
}
export async function replayRecipe(
  page: Page,
  source: WebSource,
  raw: unknown,
) {
  const recipe = RecipeSchema.parse(raw);
  if (
    recipe.source_id !== source.id ||
    recipe.scope_hash !== browserScope(source) ||
    recipe.url !== page.url()
  )
    throw new Error("Recipe scope or URL no longer matches");
  const session = new BrowserSession(page, source);
  for (const step of recipe.steps) await session.perform(step);
  return recipe;
}
export async function approvedRecipe(
  root: string,
  source: WebSource,
  c: Config,
): Promise<Recipe | null> {
  if (!source.browser.recipe) return null;
  safePath(root, source.browser.recipe);
  if (!source.browser.recipe.startsWith("recipes/"))
    throw new Error("Approved recipes must be under recipes/");
  const raw = await run(
    "git",
    ["show", `${await baselineRef(root, c)}:${source.browser.recipe}`],
    root,
  );
  return RecipeSchema.parse(JSON.parse(raw));
}
