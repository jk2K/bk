import { z } from "zod";
import { parse, stringify } from "yaml";
import { readFile, realpath, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { safePath } from "../util.js";
export const duration = (s: string): number => {
  const m = /^(\d+)(s|m|h|d)$/.exec(s);
  if (!m || +m[1] === 0) throw new Error(`Invalid duration: ${s}`);
  return +m[1] * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]!;
};
const time = z.string().refine((s) => {
  try {
    duration(s);
    return true;
  } catch {
    return false;
  }
}, "Use a positive duration, e.g. 30m");
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const base = {
  id,
  role: z.enum([
    "requirement",
    "design",
    "implementation",
    "test",
    "external-policy",
  ]),
  url: z
    .string()
    .min(1)
    .refine((s) => !s.startsWith("-") && !/[\r\n\0]/.test(s), "Unsafe URL")
    .refine((s) => {
      try {
        const u = new URL(s);
        return (!u.password && !u.username) || u.protocol === "ssh:";
      } catch {
        return true;
      }
    }, "Credentials must not be embedded in source URLs"),
  interval: time.default("30m"),
  include: z.array(z.string()).default(["**"]),
  exclude: z.array(z.string()).default([]),
  data_classification: z
    .enum(["public", "internal", "restricted"])
    .default("internal"),
};
const git = z
  .object({
    ...base,
    type: z.literal("git"),
    branch: z
      .string()
      .regex(/^[\w][\w./-]*$/)
      .refine((s) => !s.includes(".."))
      .default("main"),
  })
  .strict();
const web = z
  .object({
    ...base,
    type: z.literal("web"),
    browser: z
      .object({
        engine: z.literal("chromium").default("chromium"),
        profile: id,
        headless: z.boolean().default(true),
        interactive: z.boolean().default(false),
        login_url: z.string().url().optional(),
        auth_selector: z.string().optional(),
      })
      .strict(),
    crawl: z
      .object({
        allowed_hosts: z.array(z.string().min(1)).min(1),
        max_depth: z.number().int().min(0).max(10).default(0),
        max_pages: z.number().int().positive().max(500).default(20),
        include: z.array(z.string()).default(["/**"]),
        exclude: z.array(z.string()).default([]),
        wait_for: z.string().optional(),
        timeout_ms: z.number().int().positive().max(120000).default(30000),
      })
      .strict(),
  })
  .strict();
export const ConfigSchema = z
  .object({
    version: z.literal(1),
    knowledge: z
      .object({
        root: z.string().default("./knowledge"),
        diagrams: z.string().default("./diagrams"),
        indexes: z.string().default("./indexes"),
        entrypoint: z.string().default("./AGENTS.md"),
        target_branch: z
          .string()
          .regex(/^[\w][\w./-]*$/)
          .default("main"),
      })
      .strict()
      .default({
        root: "./knowledge",
        diagrams: "./diagrams",
        indexes: "./indexes",
        entrypoint: "./AGENTS.md",
        target_branch: "main",
      }),
    watch: z
      .object({
        enabled: z.boolean().default(true),
        tick_interval: time.default("1m"),
        max_concurrent_sources: z.number().int().positive().max(20).default(3),
        max_concurrent_agents: z.literal(1).default(1),
        retry: z
          .object({
            max_attempts: z.number().int().positive().max(10).default(3),
            initial_delay: time.default("30s"),
            max_delay: time.default("30m"),
          })
          .strict()
          .default({ max_attempts: 3, initial_delay: "30s", max_delay: "30m" }),
        budgets: z
          .object({
            max_pages_per_run: z.number().int().positive().default(200),
            max_agent_jobs_per_run: z.number().int().positive().default(20),
          })
          .strict()
          .default({ max_pages_per_run: 200, max_agent_jobs_per_run: 20 }),
      })
      .strict()
      .default({
        enabled: true,
        tick_interval: "1m",
        max_concurrent_sources: 3,
        max_concurrent_agents: 1,
        retry: { max_attempts: 3, initial_delay: "30s", max_delay: "30m" },
        budgets: { max_pages_per_run: 200, max_agent_jobs_per_run: 20 },
      }),
    sources: z.array(z.discriminatedUnion("type", [git, web])).default([]),
    agent: z
      .object({
        provider: z.literal("claude-agent-sdk").default("claude-agent-sdk"),
        model: z.string().default("configured-by-environment"),
        max_turns: z.number().int().positive().max(50).default(10),
        max_budget_usd: z.number().positive().default(2),
        timeout_ms: z.number().int().positive().default(180000),
        allow_internal_data: z.boolean().default(false),
        allow_interactive_browser: z.boolean().default(false),
        tool_policy: z
          .literal("read-only-sources")
          .default("read-only-sources"),
        analysis_budget: z.enum(["low", "medium", "high"]).default("medium"),
      })
      .strict()
      .default({
        provider: "claude-agent-sdk",
        model: "configured-by-environment",
        max_turns: 10,
        max_budget_usd: 2,
        timeout_ms: 180000,
        allow_internal_data: false,
        allow_interactive_browser: false,
        tool_policy: "read-only-sources",
        analysis_budget: "medium",
      }),
    compiler: z
      .object({
        emit: z
          .array(z.enum(["markdown", "mermaid"]))
          .default(["markdown", "mermaid"]),
        image: z
          .object({
            enabled: z.boolean().default(false),
            mode: z
              .literal("diagram-or-description")
              .default("diagram-or-description"),
            verify_semantics: z.boolean().default(true),
          })
          .strict()
          .default({
            enabled: false,
            mode: "diagram-or-description",
            verify_semantics: true,
          }),
        rules: z
          .object({
            require_source_evidence: z.literal(true),
            conflict_requires_review: z.literal(true),
            preserve_stable_ids: z.literal(true),
          })
          .strict()
          .default({
            require_source_evidence: true,
            conflict_requires_review: true,
            preserve_stable_ids: true,
          }),
      })
      .strict()
      .default({
        emit: ["markdown", "mermaid"],
        image: {
          enabled: false,
          mode: "diagram-or-description",
          verify_semantics: true,
        },
        rules: {
          require_source_evidence: true,
          conflict_requires_review: true,
          preserve_stable_ids: true,
        },
      }),
    review: z
      .object({
        mode: z.enum(["local", "pull-request"]).default("local"),
        provider: z.enum(["auto", "github", "gitlab", "gitea"]).default("auto"),
        cli: z.enum(["auto", "gh", "glab", "gt", "tea"]).default("auto"),
        auto_merge: z.literal(false).default(false),
        proposal_branch_prefix: z
          .string()
          .regex(/^[\w][\w/-]*\/$/)
          .default("bk/knowledge/"),
      })
      .strict()
      .default({
        mode: "local",
        provider: "auto",
        cli: "auto",
        auto_merge: false,
        proposal_branch_prefix: "bk/knowledge/",
      }),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.sources.map((s) => s.id)).size !== c.sources.length)
      ctx.addIssue({ code: "custom", message: "Duplicate source ID" });
  });
export type Config = z.infer<typeof ConfigSchema>;
export type Source = Config["sources"][number];
export async function loadConfig(root: string): Promise<Config> {
  const c = ConfigSchema.parse(
    parse(await readFile(resolve(root, "bk.yaml"), "utf8")),
  );
  for (const p of [
    c.knowledge.root,
    c.knowledge.diagrams,
    c.knowledge.indexes,
    c.knowledge.entrypoint,
    ".bk",
  ]) {
    const target = safePath(root, p);
    if (
      p !== ".bk" &&
      target
        .slice(resolve(root).length + 1)
        .split("/")
        .some((part) => part === ".git" || part === ".bk")
    )
      throw new Error("Reserved output directory");
    const parts = target.slice(resolve(root).length + 1).split("/");
    let current = resolve(root);
    for (const part of parts) {
      current = resolve(current, part);
      const st = await lstat(current).catch(() => null);
      if (st?.isSymbolicLink())
        throw new Error(`Symlink not allowed: ${current}`);
    }
  }
  return c;
}
export const defaultYaml = () =>
  stringify(ConfigSchema.parse({ version: 1, sources: [] }));
