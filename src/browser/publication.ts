import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/index.js";
import { hash, safeOutput, run } from "../util.js";
import { allowed, withBrowser, type WebSource } from "./index.js";
import { RecipeSchema, recipePath, replayRecipe } from "./session.js";
import { extractPage } from "../sources/web.js";
import { matches } from "../sources/git.js";
import { createProposal } from "../review/index.js";
import type { State } from "../state/index.js";

export async function proposeRecipe(
  root: string,
  config: Config,
  state: State,
  source: WebSource,
  url: string,
  local: boolean,
  dryRun: boolean,
) {
  const document = allowed(url, source);
  document.hash = "";
  if (!matches(document.pathname, source.crawl.include, source.crawl.exclude))
    throw new Error("Recipe URL outside crawl scope");
  if (source.data_classification === "restricted")
    throw new Error("Restricted sources cannot publish Recipes");
  const path = recipePath(source, document.href);
  const draft = await safeOutput(
    root,
    join(".bk/recipe-drafts", source.id, hash(document.href) + ".json"),
  );
  const recipe = RecipeSchema.parse(JSON.parse(await readFile(draft, "utf8")));
  if (recipe.steps.some((step) => step.action === "search"))
    throw new Error(
      "Search values require manual review and removal before Recipe publication",
    );
  await withBrowser(root, source, async (ctx) => {
    const page = await ctx.newPage();
    const replay = async () => {
      const response = await page.goto(document.href, {
        timeout: source.crawl.timeout_ms,
        waitUntil: "domcontentloaded",
      });
      if (
        !response?.ok() ||
        page.url() !== document.href ||
        (source.browser.login_url &&
          new URL(source.browser.login_url).pathname === document.pathname) ||
        (source.browser.auth_selector &&
          !(await page.locator(source.browser.auth_selector).count())) ||
        (await page.locator("input[type=password]").count())
      )
        throw new Error("Cannot verify Recipe document or authentication");
      if (source.crawl.wait_for)
        await page
          .locator(source.crawl.wait_for)
          .first()
          .waitFor({ timeout: source.crawl.timeout_ms });
      await replayRecipe(page, source, recipe);
      return (await extractPage(page)).markdown;
    };
    const first = await replay();
    if (first.length < 10 || first !== (await replay()))
      throw new Error("Recipe did not reproduce the same document content");
  });
  const content = JSON.stringify(recipe, null, 2) + "\n",
    revision = hash(content);
  if (!local && !dryRun && config.review.mode !== "local") {
    const target = config.knowledge.target_branch;
    await run(
      "git",
      ["fetch", "origin", `refs/heads/${target}:refs/remotes/origin/${target}`],
      root,
    );
  }
  return createProposal(
    root,
    config,
    state,
    {
      id: hash("recipe:" + path + revision),
      source,
      fromRevision: null,
      toRevision: revision,
      evidence: [],
      rebased: false,
      createdAt: new Date().toISOString(),
    },
    { actions: [] },
    [],
    local,
    dryRun,
    undefined,
    { path, content },
  );
}
