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
            sourceId: z.string().optional(),
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
function resolveEvidence(
  change: ChangeSet,
  e: Assessment["actions"][number]["evidence"][number],
) {
  const candidates = [change, ...(change.related ?? [])].filter(
    (c) => c.source.id === (e.sourceId ?? change.source.id),
  );
  for (const source of candidates) {
    const version: "before" | "after" | undefined =
      e.revision === source.toRevision
        ? "after"
        : e.revision === source.fromRevision
          ? "before"
          : undefined;
    if (!version) continue;
    const doc = source.evidence.find(
      (d) => d.locator === e.locator && d[version].includes(e.quote),
    );
    if (doc) return { source, doc, version };
  }
  throw new Error(`Unverifiable evidence: ${e.locator}`);
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
    const references = a.evidence.map((e) => resolveEvidence(change, e));
    if (!references.some((r) => r.source === change))
      throw new Error("Action must cite the triggering source event");
    if (
      ["add_rule", "update_rule"].includes(a.action) &&
      (change.rebased ||
        ["implementation", "test", "request"].includes(change.source.role) ||
        !references.some((r) => r.source === change && r.version === "after"))
    ) {
      a.action = "conflict";
      a.uncertainty.push(
        "Current approved intent cannot be inferred from code, tests, open requests, historical or rewritten evidence alone",
      );
    }
    if (references.some((r) => r.doc[r.version].includes("IMAGE SHA256 "))) {
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
  const sources = a.evidence.map((e) => {
    const { source, doc, version } = resolveEvidence(change, e);
    return {
      source_id: source.source.id,
      kind: source.source.role,
      locator: e.locator,
      revision: e.revision,
      content_hash: version === "before" ? doc.beforeHash : doc.afterHash,
      quote: e.quote,
    };
  });
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
        (s: any) =>
          !sources.some(
            (source) =>
              source.source_id === s.source_id && source.locator === s.locator,
          ),
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
          () => `<!-- bk:statement -->\n${a.after}\n<!-- /bk:statement -->`,
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
