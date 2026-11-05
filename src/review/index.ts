import { CLIReviewProvider } from "./provider.js";
import { join, relative } from "node:path";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { run, atomic, safeOutput, hash } from "../util.js";
import type { Config } from "../config/index.js";
import type { ChangeSet } from "../sources/git.js";
import {
  baselineRef,
  renderRule,
  type Assessment,
  type Rule,
} from "../knowledge/index.js";
import type { State } from "../state/index.js";
export function providerCli(c: Config) {
  if (c.review.cli !== "auto") return c.review.cli;
  if (c.review.provider === "github") return "gh";
  if (c.review.provider === "gitlab") return "glab";
  if (c.review.provider === "gitea") return "gt";
  throw new Error("Set review.provider explicitly for remote review");
}
export async function remoteProposal(
  root: string,
  c: Config,
  branch: string,
  reportPath: string,
  title: string,
): Promise<string> {
  return new CLIReviewProvider(providerCli(c), root).create(
    branch,
    c.knowledge.target_branch,
    title,
    reportPath,
  );
}
export async function createProposal(
  root: string,
  c: Config,
  state: State,
  change: ChangeSet,
  assessment: Assessment,
  rules: Rule[],
  local: boolean,
  dryRun: boolean,
) {
  const active = assessment.actions.filter((a) => a.action !== "no_change");
  if (!active.length) return { status: "no_change" };
  const existing: any = state.db
    .prepare("SELECT * FROM proposals WHERE change_id=?")
    .get(change.id);
  if (existing && existing.status !== "prepared")
    return {
      status: existing.status,
      id: existing.id,
      remote: existing.remote,
    };
  const currentBase = (
    await run(
      "git",
      ["rev-parse", `${await baselineRef(root, c)}^{commit}`],
      root,
    )
  ).trim();
  if (existing && existing.base !== currentBase)
    throw new Error(
      "Knowledge baseline advanced during proposal recovery; inspect the prepared proposal before retrying",
    );
  const base = existing?.base ?? currentBase;
  const id =
    existing?.id ??
    hash(change.id + base + JSON.stringify(assessment)).slice(0, 24);
  const branch = existing?.branch ?? c.review.proposal_branch_prefix + id;
  const report =
    `# BK proposal ${id}\n\nSource: ${change.source.id}\nRevision: ${change.toRevision}\nBase: ${base}\n\nHuman approval required. A merge does not imply business deployment.\n\n` +
    active
      .map(
        (a) =>
          `## ${a.ruleId}: ${a.summary}\n\nAction: ${a.action}\n\nBefore:\n${a.before}\n\nAfter:\n${a.after}\n\nRationale: ${a.rationale}\n\nUncertainty: ${a.uncertainty.join("; ") || "none reported"}\n\nEvidence:\n${a.evidence.map((e) => `- ${e.locator} @ ${e.revision}\n  > ${e.quote.replace(/\n/g, "\n  > ")}`).join("\n")}\n`,
      )
      .join("\n");
  if (dryRun) return { status: "preview", id, report };
  const dir = join(root, ".bk/proposals", id),
    worktree = join(dir, "worktree"),
    reportPath = join(dir, "report.md");
  await atomic(reportPath, report);
  state.db
    .prepare(
      "INSERT OR IGNORE INTO proposals(id,change_id,base,branch,status,report) VALUES(?,?,?,?,'prepared',?)",
    )
    .run(id, change.id, base, branch, reportPath);
  try {
    await run("git", ["rev-parse", "--verify", branch], root);
  } catch {
    await run("git", ["branch", branch, base], root);
  }
  try {
    await readFile(join(worktree, ".git"));
  } catch {
    await run("git", ["worktree", "add", worktree, branch], root);
  }
  if (
    (await run("git", ["rev-parse", "--show-toplevel"], worktree)).trim() !==
    worktree
  )
    throw new Error("Invalid isolated worktree");
  const writes = active.filter((a) =>
    ["add_rule", "update_rule"].includes(a.action),
  );
  for (const a of writes) {
    const old = rules.find((r) => r.id === a.ruleId);
    const path =
      old?.path ?? join(c.knowledge.root, a.domain, a.ruleId + ".md");
    const target = await safeOutput(worktree, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, renderRule(a, change, old));
  }
  const indexPath = join(c.knowledge.indexes, `proposal-${id}.json`);
  const indexTarget = await safeOutput(worktree, indexPath);
  await mkdir(join(indexTarget, ".."), { recursive: true });
  await writeFile(
    indexTarget,
    JSON.stringify(
      {
        changeId: change.id,
        source: change.source.id,
        revision: change.toRevision,
        rules: writes.map((a) => a.ruleId),
        report: active.filter((a) => !writes.includes(a)),
      },
      null,
      2,
    ) + "\n",
  );
  const allowed = [c.knowledge.root, c.knowledge.indexes].map(
    (p) => p.replace(/^\.\//, "").replace(/\/$/, "") + "/",
  );
  const changed = (
    await run(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      worktree,
    )
  )
    .split("\n")
    .filter(Boolean)
    .map((s) => s.slice(3));
  if (changed.some((p) => !allowed.some((prefix) => p.startsWith(prefix))))
    throw new Error("Proposal contains files outside allowed directories");
  await run(
    "git",
    ["add", "--", c.knowledge.root, c.knowledge.indexes],
    worktree,
  );
  const staged = await run("git", ["diff", "--cached", "--binary"], worktree);
  if (staged)
    await run(
      "git",
      [
        "-c",
        "user.name=BK",
        "-c",
        "user.email=bk@localhost",
        "commit",
        "-m",
        `knowledge: ${change.source.id} (${id})`,
      ],
      worktree,
    );
  await atomic(
    join(dir, "proposal.patch"),
    await run("git", ["diff", "--binary", base, "HEAD"], worktree),
  );
  state.db
    .prepare(
      "INSERT INTO proposals(id,change_id,base,branch,status,report) VALUES(?,?,?,?,'prepared',?) ON CONFLICT(change_id) DO UPDATE SET status='prepared'",
    )
    .run(id, change.id, base, branch, reportPath);
  if (local || c.review.mode === "local") {
    state.db
      .prepare("UPDATE proposals SET status='local' WHERE change_id=?")
      .run(change.id);
    return { status: "local", id, reportPath };
  }
  await run(
    "git",
    ["push", "origin", `${branch}:refs/heads/${branch}`],
    worktree,
  );
  const remote = await remoteProposal(
    root,
    c,
    branch,
    reportPath,
    `BK: ${change.source.id} business knowledge`,
  );
  state.db
    .prepare("UPDATE proposals SET status='open',remote=? WHERE change_id=?")
    .run(remote, change.id);
  return { status: "open", id, remote };
}
export async function reconcile(root: string, c: Config, state: State) {
  const rows = state.db
    .prepare("SELECT * FROM proposals WHERE status='open'")
    .all() as any[];
  if (!rows.length) return;
  const cli = providerCli(c);
  for (const p of rows) {
    try {
      const remote = await new CLIReviewProvider(cli, root).status(p.remote);
      const merged = remote.state === "merged",
        closed = remote.state === "closed",
        commit = remote.commit;
      if (merged) {
        await run("git", ["fetch", "origin", c.knowledge.target_branch], root);
        if (!commit) throw new Error("Missing merge commit");
        await run(
          "git",
          ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"],
          root,
        );
        state.db
          .prepare("UPDATE proposals SET status='merged' WHERE id=?")
          .run(p.id);
        state.event("published", { proposal: p.id, commit });
      } else if (closed) {
        state.db
          .prepare("UPDATE proposals SET status='rejected' WHERE id=?")
          .run(p.id);
        state.event("rejected", { proposal: p.id });
      }
    } catch (e: any) {
      state.event("review_error", { proposal: p.id, error: e.message });
    }
  }
}
