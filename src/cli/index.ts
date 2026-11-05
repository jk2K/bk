#!/usr/bin/env node
import { validateMarkdown, validateLinks } from "../validation/index.js";
import { Command } from "commander";
import { resolve, join } from "node:path";
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { stringify } from "yaml";
import { defaultYaml, loadConfig, ConfigSchema } from "../config/index.js";
import { run, redact } from "../util.js";
import { State } from "../state/index.js";
import { pipeline, watch, withPipeline } from "../scheduler/index.js";
import { browserLogin, withBrowser, allowed } from "../browser/index.js";
import { providerCli } from "../review/index.js";
import { readRules } from "../knowledge/index.js";
const program = new Command()
  .name("bk")
  .description("Git-native business knowledge evolution")
  .version("0.1.0")
  .option("-C, --cwd <path>", "Knowledge repository", ".")
  .option("--json", "Machine-readable JSON");
const root = () => resolve(program.opts().cwd);
const emit = (x: unknown) =>
  console.log(JSON.stringify(x, null, program.opts().json ? undefined : 2));
program
  .command("init")
  .argument("[path]", "Destination", ".")
  .description("Initialize a knowledge repository without overwriting files")
  .action(async (path) => {
    const dest = resolve(root(), path);
    await mkdir(dest, { recursive: true });
    for (const dir of [
      "knowledge",
      "glossary",
      "decisions",
      "diagrams",
      "indexes",
    ])
      await mkdir(join(dest, dir), { recursive: true });
    const files: Record<string, string> = {
      "bk.yaml": defaultYaml(),
      "AGENTS.md":
        "# Business knowledge\n\nRead approved rules under knowledge/. Check business_effective_status: pending_release is not current behavior. Follow evidence references to verify versions. Never consume .bk/ proposals as approved facts.\n",
      "README.md":
        "# Business knowledge\n\nConfigure bk.yaml, commit this repository, run bk doctor, then bk sync --dry-run.\n",
    };
    const created: string[] = [];
    for (const [file, content] of Object.entries(files)) {
      try {
        await writeFile(join(dest, file), content, { flag: "wx" });
        created.push(file);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    const ignore = join(dest, ".gitignore");
    let text = await readFile(ignore, "utf8").catch(() => "");
    if (
      !text.split("\n").some((l) => l.trim() === ".bk/" || l.trim() === ".bk")
    )
      await writeFile(
        ignore,
        text + (text.endsWith("\n") || !text ? "" : "\n") + ".bk/\n",
      );
    emit({
      path: dest,
      created,
      next: 'git init -b main && git add . && git commit -m "Initialize knowledge"',
    });
  });
program
  .command("doctor")
  .description(
    "Check configuration, runtime, browser, authentication and review CLI",
  )
  .action(async () => {
    const c = await loadConfig(root());
    const checks: any[] = [];
    checks.push({
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 24,
      version: process.version,
    });
    for (const command of [
      "git",
      ...(c.review.mode === "pull-request" ? [providerCli(c)] : []),
    ])
      try {
        checks.push({
          name: command,
          ok: true,
          version: (await run(command, ["--version"])).trim().split("\n")[0],
        });
      } catch {
        checks.push({ name: command, ok: false, hint: `Install ${command}` });
      }
    try {
      await run(
        "git",
        ["rev-parse", `${c.knowledge.target_branch}^{commit}`],
        root(),
      );
      checks.push({ name: "knowledge_git", ok: true });
    } catch {
      checks.push({
        name: "knowledge_git",
        ok: false,
        hint: "Initialize Git and commit knowledge repository on target_branch",
      });
    }
    const { chromium } = await import("playwright");
    try {
      await access(chromium.executablePath());
      checks.push({ name: "chromium", ok: true });
    } catch {
      checks.push({
        name: "chromium",
        ok: !c.sources.some((s) => s.type === "web"),
        hint: "npx playwright install chromium",
      });
    }
    checks.push({
      name: "agent_auth_environment",
      ok: !!(
        process.env.ANTHROPIC_API_KEY ||
        process.env.CLAUDE_CODE_USE_BEDROCK ||
        process.env.CLAUDE_CODE_USE_VERTEX
      ),
      hint: "Environment presence only; live model access is checked during analyze",
    });
    if (
      c.sources.some(
        (s) =>
          s.data_classification === "restricted" ||
          (s.data_classification === "internal" &&
            !c.agent.allow_internal_data),
      )
    )
      checks.push({
        name: "data_policy",
        ok: false,
        hint: "Internal source transmission requires agent.allow_internal_data; restricted sources are blocked",
      });
    emit({ checks });
    if (checks.some((x) => !x.ok)) process.exitCode = 1;
  });
const source = program
  .command("source")
  .description("Manage configured sources");
source
  .command("list")
  .action(async () => emit((await loadConfig(root())).sources));
source
  .command("add")
  .argument("<json>", "Source config JSON")
  .action(async (json) => {
    const c = await loadConfig(root());
    c.sources.push(JSON.parse(json));
    await writeFile(join(root(), "bk.yaml"), stringify(ConfigSchema.parse(c)));
    emit({ status: "added" });
  });
source
  .command("remove")
  .argument("<id>")
  .action(async (id) => {
    const c = await loadConfig(root());
    if (!c.sources.some((s) => s.id === id)) throw new Error("Unknown source");
    c.sources = c.sources.filter((s) => s.id !== id);
    await writeFile(join(root(), "bk.yaml"), stringify(c));
    emit({ status: "removed", id });
  });
source
  .command("test")
  .argument("<id>")
  .action(async (id) => {
    const c = await loadConfig(root()),
      s = c.sources.find((s) => s.id === id);
    if (!s) throw new Error("Unknown source");
    if (s.type === "git")
      await run("git", [
        "ls-remote",
        "--exit-code",
        "--",
        s.url,
        `refs/heads/${s.branch}`,
      ]);
    else
      await withBrowser(root(), s, async (ctx) => {
        allowed(s.url, s);
        const page = await ctx.newPage();
        const r = await page.goto(s.url);
        allowed(page.url(), s);
        if (
          !r?.ok() ||
          (await page.locator("input[type=password]").count()) ||
          (s.browser.auth_selector &&
            (await page.locator(s.browser.auth_selector).count()) === 0)
        )
          throw new Error("AUTH_REQUIRED or unreachable");
      });
    emit({ id, status: "ok" });
  });
const browser = program.command("browser");
for (const kind of ["login", "status"])
  browser
    .command(kind)
    .argument("<id>")
    .action(async (id) => {
      const c = await loadConfig(root()),
        s = c.sources.find((s) => s.id === id);
      if (!s || s.type !== "web") throw new Error("Expected web source");
      if (kind === "login") await browserLogin(root(), s);
      else
        await withBrowser(root(), s, async (ctx) => {
          allowed(s.url, s);
          const page = await ctx.newPage();
          const r = await page.goto(s.url);
          allowed(page.url(), s);
          if (
            !r?.ok() ||
            (await page.locator("input[type=password]").count()) ||
            (s.browser.auth_selector &&
              (await page.locator(s.browser.auth_selector).count()) === 0)
          )
            throw new Error("AUTH_REQUIRED");
        });
      await withPipeline(root(), async (state) => {
        state.db
          .prepare(
            "UPDATE sources SET status='ok',due=0,attempts=0,error=NULL WHERE id=?",
          )
          .run(id);
      });
      emit({
        id,
        status: kind === "login" ? "profile_saved" : "reachable",
        note: "Configure auth_selector to verify authenticated content",
      });
    });
for (const kind of ["scan", "analyze", "sync"])
  program
    .command(kind)
    .option("--source <id>")
    .option("--dry-run", "Preview; never push, commit proposals, or create PRs")
    .option("--local", "Generate isolated local proposals only")
    .action(async (opts) => {
      const c = await loadConfig(root());
      const result = await withPipeline(root(), (s) =>
        pipeline(root(), c, s, {
          ...opts,
          scanOnly: kind === "scan",
          analyzeOnly: kind === "analyze",
        }),
      );
      emit(result);
      if (result.failed) process.exitCode = 1;
    });
program.command("watch").action(async () => {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watch(root(), emit, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
});
for (const kind of ["status", "history", "proposals"])
  program
    .command(kind)
    .option("--limit <count>", "Maximum rows", "20")
    .action(async (opts) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("limit must be 1..1000");
      const s = new State(root());
      try {
        if (kind === "status")
          emit({
            sources: s.db.prepare("SELECT * FROM sources").all(),
            changes: s.db
              .prepare(
                "SELECT status,COUNT(*) AS count FROM changes GROUP BY status",
              )
              .all(),
          });
        else
          emit(
            s.db
              .prepare(
                `SELECT * FROM ${kind === "history" ? "history" : "proposals"} ORDER BY rowid DESC LIMIT ?`,
              )
              .all(limit),
          );
      } finally {
        s.close();
      }
    });
program
  .command("retry")
  .argument("<change-id>")
  .description(
    "Requeue a failed or policy-blocked change after fixing the cause",
  )
  .action(async (id) => {
    await withPipeline(root(), async (s) => {
      const r = s.db
        .prepare(
          "UPDATE changes SET status='queued',attempts=0,retry_at=0,error=NULL WHERE id=? AND status IN ('retry','needs_review','blocked')",
        )
        .run(id);
      if (!r.changes) throw new Error("No retryable change found");
    });
    emit({ id, status: "queued" });
  });
program.command("validate").action(async () => {
  const c = await loadConfig(root());
  const rules = await readRules(root(), c, c.knowledge.target_branch);
  for (const r of rules) {
    await validateMarkdown(r.content);
    await validateLinks(root(), c.knowledge.target_branch, r.path, r.content);
  }
  emit({
    status: "ok",
    rules: rules.length,
    scope:
      "Committed rules: metadata, IDs, managed boundaries, Mermaid syntax and local links",
  });
});
program.parseAsync().catch((e) => {
  console.error(JSON.stringify({ error: redact(e.message) }));
  process.exitCode = 1;
});
