import { CLIReviewProvider } from "./provider.js";
import { join, relative } from "node:path";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { run, atomic, safeOutput, hash } from "../util.js";
import type { Config } from "../config/index.js";
import type { ChangeSet } from "../sources/git.js";
import {
  baselineRef,
  renderRule,
  readRules,
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
  expectedBase?: string,
  recipe?: { path: string; content: string },
) {
  const active = assessment.actions.filter((a) => a.action !== "no_change");
  if (!active.length && !recipe) return { status: "no_change" };
  const linked: any = state.db
    .prepare(
      "SELECT p.*, (SELECT MAX(head) FROM proposal_rules WHERE proposal_id=p.id) AS head FROM proposals p WHERE p.change_id=? OR p.id=(SELECT proposal_id FROM proposal_events WHERE change_id=?)",
    )
    .get(change.id, change.id);
  if (linked && linked.status !== "prepared") {
    return { status: linked.status, id: linked.id, remote: linked.remote };
  }
  const writes = active.filter((a) =>
    ["add_rule", "update_rule"].includes(a.action),
  );
  const ruleIds = [...new Set(writes.map((a) => a.ruleId))];
  const remoteMode = !local && c.review.mode !== "local";
  const currentBase = (
    await run(
      "git",
      ["rev-parse", `${await baselineRef(root, c)}^{commit}`],
      root,
    )
  ).trim();
  let candidates =
    !linked && ruleIds.length
      ? (state.db
          .prepare(
            `SELECT DISTINCT p.*, r.head FROM proposals p JOIN proposal_rules r ON r.proposal_id=p.id WHERE r.rule_id IN (${ruleIds.map(() => "?").join(",")}) AND p.status IN (?, 'prepared')`,
          )
          .all(...ruleIds, remoteMode ? "open" : "local") as any[])
      : [];
  if (!remoteMode) {
    for (const candidate of candidates.filter(
      (p) => p.status === "local" && p.head && p.base !== currentBase,
    )) {
      try {
        await run(
          "git",
          ["merge-base", "--is-ancestor", candidate.head, currentBase],
          root,
        );
      } catch {
        continue;
      }
      candidates = candidates.filter((p) => p.id !== candidate.id);
      if (!dryRun)
        state.db
          .prepare("UPDATE proposals SET status='merged' WHERE id=?")
          .run(candidate.id);
    }
  }
  if (candidates.length > 1 || candidates.some((p) => p.status === "prepared"))
    throw new Error(
      "Another proposal for this rule requires recovery or review",
    );
  const existing = linked ?? candidates[0];
  const reusable = !linked && !!existing;
  if (expectedBase && expectedBase !== currentBase)
    throw new Error(
      "Knowledge baseline advanced during analysis; retry against the new approved revision",
    );
  if (existing && existing.base !== currentBase)
    throw new Error(
      "Knowledge baseline advanced during proposal recovery; inspect the prepared proposal before retrying",
    );
  const base = existing?.base ?? currentBase;
  const id =
    existing?.id ??
    hash(change.id + base + JSON.stringify(assessment)).slice(0, 24);
  const branch = existing?.branch ?? c.review.proposal_branch_prefix + id;
  if (reusable && remoteMode && !dryRun) {
    const status = await new CLIReviewProvider(providerCli(c), root).status(
      existing.remote,
    );
    if (status.state !== "open")
      throw new Error("Proposal is no longer open; reconcile before retry");
  }
  const report =
    `# BK proposal ${id}\n\nSource: ${change.source.id}\nRevision: ${change.toRevision}\nBase: ${base}\n\nHuman approval required. A merge does not imply business deployment.\n\n` +
    (recipe ? `Verified read-only Recipe: ${recipe.path}\n\n` : "") +
    active
      .map(
        (a) =>
          `## ${a.ruleId}: ${a.summary}\n\nAction: ${a.action}\n\nBefore:\n${a.before}\n\nAfter:\n${a.after}\n\nRationale: ${a.rationale}\n\nUncertainty: ${a.uncertainty.join("; ") || "none reported"}\n\nEvidence:\n${a.evidence.map((e) => `- ${e.sourceId ?? change.source.id}:${e.locator} @ ${e.revision}\n  > ${e.quote.replace(/\n/g, "\n  > ")}`).join("\n")}\n`,
      )
      .join("\n");
  if (dryRun) return { status: "preview", id, report };
  const dir = join(root, ".bk/proposals", id),
    worktree = join(dir, "worktree"),
    reportPath = join(dir, "report.md");

  if (reusable) {
    const head = (await run("git", ["rev-parse", "HEAD"], worktree)).trim();
    const dirty = await run("git", ["status", "--porcelain"], worktree);
    if (!existing.head || head !== existing.head || dirty)
      throw new Error(
        "Proposal contains reviewer edits; manual reconciliation required",
      );
    if (remoteMode) {
      const remote = await run(
        "git",
        ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`],
        worktree,
      );
      if (remote.split(/\s+/)[0] !== head)
        throw new Error(
          "Remote proposal contains reviewer commits; manual reconciliation required",
        );
    }
  }
  await atomic(reportPath, report);
  state.transaction(() => {
    state.db
      .prepare(
        "INSERT OR IGNORE INTO proposals(id,change_id,base,branch,status,report) VALUES(?,?,?,?,'prepared',?)",
      )
      .run(id, change.id, base, branch, reportPath);
    state.db
      .prepare("INSERT OR IGNORE INTO proposal_events VALUES(?,?)")
      .run(change.id, id);
    for (const ruleId of ruleIds)
      state.db
        .prepare(
          "INSERT OR IGNORE INTO proposal_rules(proposal_id,rule_id) VALUES(?,?)",
        )
        .run(id, ruleId);
    state.db
      .prepare("UPDATE proposals SET status='prepared' WHERE id=?")
      .run(id);
  });
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
  for (const a of writes) {
    const priorCandidate = existing?.head
      ? (await readRules(root, c, existing.head)).find((r) => r.id === a.ruleId)
      : undefined;
    const old = priorCandidate ?? rules.find((r) => r.id === a.ruleId);
    const path =
      old?.path ?? join(c.knowledge.root, a.domain, a.ruleId + ".md");
    const target = await safeOutput(worktree, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, renderRule(a, change, old));
  }
  if (recipe) {
    if (!/^recipes\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.json$/.test(recipe.path))
      throw new Error("Unsafe recipe proposal path");
    await atomic(await safeOutput(worktree, recipe.path), recipe.content);
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
        rules: (
          state.db
            .prepare(
              "SELECT rule_id FROM proposal_rules WHERE proposal_id=? ORDER BY rule_id",
            )
            .all(id) as Array<{ rule_id: string }>
        ).map((row) => row.rule_id),
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
  if (
    changed.some(
      (p) =>
        p !== recipe?.path && !allowed.some((prefix) => p.startsWith(prefix)),
    )
  )
    throw new Error("Proposal contains files outside allowed directories");
  await run(
    "git",
    [
      "add",
      "--",
      c.knowledge.indexes,
      ...(writes.length ? [c.knowledge.root] : []),
      ...(recipe ? [recipe.path] : []),
    ],
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
  if (ruleIds.length)
    state.db
      .prepare("UPDATE proposal_rules SET head=? WHERE proposal_id=?")
      .run((await run("git", ["rev-parse", "HEAD"], worktree)).trim(), id);
  if (local || c.review.mode === "local") {
    state.db.prepare("UPDATE proposals SET status='local' WHERE id=?").run(id);
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
    .prepare("UPDATE proposals SET status='open',remote=? WHERE id=?")
    .run(remote, id);
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
        const approved = await readRules(root, c, commit);
        state.transaction(() => {
          state.db
            .prepare("UPDATE proposals SET status='merged' WHERE id=?")
            .run(p.id);
          recordFeedback(state, p, "merged", commit, approved);
        });
        state.event("published", { proposal: p.id, commit });
      } else if (closed) {
        state.transaction(() => {
          state.db
            .prepare("UPDATE proposals SET status='rejected' WHERE id=?")
            .run(p.id);
          recordFeedback(state, p, "rejected");
        });
        state.event("rejected", { proposal: p.id });
      }
    } catch (e: any) {
      state.event("review_error", { proposal: p.id, error: e.message });
    }
  }
}

function recordFeedback(
  state: State,
  p: { id: string },
  decision: string,
  commit?: string,
  approved?: Rule[],
) {
  const events = state.db
    .prepare(
      "SELECT c.payload,c.result FROM changes c WHERE c.result IS NOT NULL AND c.id IN (SELECT change_id FROM proposal_events WHERE proposal_id=? UNION SELECT change_id FROM proposals WHERE id=?) ORDER BY c.rowid DESC",
    )
    .all(p.id, p.id) as Array<{ payload: string; result: string }>;
  const actions = events.slice(0, 5).flatMap((e) =>
    (JSON.parse(e.result) as Assessment).actions.map((a) => ({
      ruleId: a.ruleId,
      action: a.action,
      statementHash: hash(a.after),
      sourceId: (JSON.parse(e.payload) as ChangeSet).source.id,
    })),
  );
  const latest = actions.filter(
    (a, i) =>
      actions.findIndex(
        (other) => other.ruleId === a.ruleId && other.sourceId === a.sourceId,
      ) === i,
  );
  const observations = latest.map((action) => {
    const rule = approved?.find((r) => r.id === action.ruleId);
    const approvedStatementHash = rule ? hash(rule.statement) : undefined;
    return {
      ...action,
      approvedStatementHash,
      reviewerEdited: approvedStatementHash
        ? approvedStatementHash !== action.statementHash
        : undefined,
    };
  });
  state.db
    .prepare("INSERT OR REPLACE INTO review_feedback VALUES(?,?,?)")
    .run(p.id, decision, JSON.stringify({ commit, actions: observations }));
}
