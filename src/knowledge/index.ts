import { z } from "zod";
import { parse, stringify } from "yaml";
import { run } from "../util.js";
import type { Config } from "../config/index.js";
import type { ChangeSet } from "../sources/git.js";
export const ActionSchema = z
  .object({
    action: z.enum([
      "no_change",
      "add_rule",
      "update_rule",
      "deprecate_candidate",
      "conflict",
      "needs_clarification",
    ]),
    ruleId: z.string().regex(/^[A-Z][A-Z0-9_-]{2,99}$/),
    domain: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
    summary: z.string().min(1).max(500),
    before: z.string().max(20000),
    after: z.string().max(20000),
    evidence: z
      .array(
        z
          .object({
            locator: z.string(),
            revision: z.string(),
            quote: z.string().min(1).max(3000),
          })
          .strict(),
      )
      .min(1),
    rationale: z.string().min(1).max(5000),
    uncertainty: z.array(z.string()),
    businessEffectiveStatus: z.enum(["active", "pending_release", "unknown"]),
  })
  .strict();
export const AssessmentSchema = z
  .object({ actions: z.array(ActionSchema).max(100) })
  .strict();
export type Assessment = z.infer<typeof AssessmentSchema>;
export interface Rule {
  id: string;
  path: string;
  content: string;
  statement: string;
  meta: Record<string, any>;
}
export async function readRules(
  root: string,
  c: Config,
  revision = "HEAD",
): Promise<Rule[]> {
  const result: Rule[] = [];
  const paths = (
    await run(
      "git",
      ["ls-tree", "-r", "--name-only", "-z", revision, "--", c.knowledge.root],
      root,
    )
  )
    .split("\0")
    .filter((p) => p.endsWith(".md"));
  for (const path of paths) {
    const content = await run("git", ["show", `${revision}:${path}`], root);
    const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
    if (!m) throw new Error(`Rule missing YAML metadata: ${path}`);
    const meta = parse(m[1]);
    if (!meta?.id || !Array.isArray(meta.sources))
      throw new Error(`Invalid rule metadata: ${path}`);
    const statement =
      /<!-- bk:statement -->\n([\s\S]*?)\n<!-- \/bk:statement -->/.exec(
        content,
      )?.[1];
    if (statement === undefined)
      throw new Error(`Rule requires managed statement markers: ${path}`);
    if (result.some((r) => r.id === meta.id))
      throw new Error(`Duplicate rule ID: ${meta.id}`);
    result.push({ id: meta.id, path, content, statement, meta });
  }
  return result;
}
export function validateAssessment(
  raw: unknown,
  change: ChangeSet,
  rules: Rule[],
): Assessment {
  const assessment = AssessmentSchema.parse(raw);
  const ids = new Set<string>();
  for (const a of assessment.actions) {
    if (ids.has(a.ruleId)) throw new Error(`Multiple actions for ${a.ruleId}`);
    ids.add(a.ruleId);
    const old = rules.find((r) => r.id === a.ruleId);
    if (a.action === "update_rule" && (!old || a.before !== old.statement))
      throw new Error(`Stale or missing rule: ${a.ruleId}`);
    if (a.action === "add_rule" && (old || a.before !== "" || !a.after.trim()))
      throw new Error(`Invalid new rule: ${a.ruleId}`);
    if (a.action === "update_rule" && !a.after.trim())
      throw new Error("Empty update");
    for (const e of a.evidence) {
      const doc = change.evidence.find((d) => d.locator === e.locator);
      if (
        !doc ||
        !(
          (e.revision === change.toRevision && doc.after.includes(e.quote)) ||
          (e.revision === change.fromRevision && doc.before.includes(e.quote))
        )
      )
        throw new Error(`Unverifiable evidence: ${e.locator}`);
    }
    if (
      (change.source.role === "implementation" ||
        change.source.role === "test" ||
        change.rebased) &&
      ["add_rule", "update_rule"].includes(a.action)
    ) {
      a.action = "conflict";
      a.uncertainty.push(
        "Implementation/test evidence or rebased history cannot independently approve business intent",
      );
    }
    if (
      a.evidence.some((e) =>
        change.evidence
          .find((doc) => doc.locator === e.locator)
          ?.after.includes("IMAGE SHA256 "),
      )
    ) {
      a.uncertainty.push(
        "Visual evidence is a derived interpretation requiring human verification",
      );
    }
    if (a.uncertainty.length || a.businessEffectiveStatus === "unknown") {
      if (["add_rule", "update_rule"].includes(a.action))
        a.action = "needs_clarification";
    }
    if (/<!--\s*\/?bk:statement\s*-->/.test(a.after))
      throw new Error("Statement contains reserved markers");
  }
  return assessment;
}
export function renderRule(
  a: Assessment["actions"][number],
  change: ChangeSet,
  old?: Rule,
): string {
  const sources = a.evidence.map((e) => ({
    source_id: change.source.id,
    kind: change.source.role,
    locator: e.locator,
    revision: e.revision,
    content_hash:
      e.revision === change.fromRevision
        ? change.evidence.find((d) => d.locator === e.locator)!.beforeHash
        : change.evidence.find((d) => d.locator === e.locator)!.afterHash,
    quote: e.quote,
  }));
  const meta = {
    ...old?.meta,
    id: a.ruleId,
    domain: a.domain,
    title: a.summary,
    status:
      a.businessEffectiveStatus === "pending_release"
        ? "approved_pending_release"
        : "approved",
    business_effective_status: a.businessEffectiveStatus,
    sources: [
      ...(old?.meta.sources ?? []).filter(
        (s: any) => s.source_id !== change.source.id,
      ),
      ...sources,
    ],
    related_rules: old?.meta.related_rules ?? [],
    last_verified_at: change.createdAt,
  };
  const body = old
    ? old.content
        .replace(/^---\n[\s\S]*?\n---\n/, "")
        .replace(
          /<!-- bk:statement -->\n[\s\S]*?\n<!-- \/bk:statement -->/,
          `<!-- bk:statement -->\n${a.after}\n<!-- /bk:statement -->`,
        )
    : `\n# ${a.summary}\n\n<!-- bk:statement -->\n${a.after}\n<!-- /bk:statement -->\n`;
  return `---\n${stringify(meta)}---\n${body}`;
}
export async function baselineRef(root: string, c: Config) {
  const ref = `refs/remotes/origin/${c.knowledge.target_branch}`;
  try {
    await run("git", ["rev-parse", "--verify", ref], root);
    return ref;
  } catch {
    return c.knowledge.target_branch;
  }
}
