import { validateMarkdown } from "../validation/index.js";
import { join } from "node:path";
import type { Config, Source } from "../config/index.js";
import { duration, loadConfig } from "../config/index.js";
import { State } from "../state/index.js";
import { hash, lock, delay, run } from "../util.js";
import { scanGit, type ChangeSet } from "../sources/git.js";
import { scanWeb } from "../sources/web.js";
import {
  baselineRef,
  readRules,
  validateAssessment,
} from "../knowledge/index.js";
import { ClaudeAgent, type AgentProvider } from "../agent/index.js";
import { createProposal, reconcile } from "../review/index.js";
export interface Options {
  source?: string;
  local?: boolean;
  dryRun?: boolean;
  dueOnly?: boolean;
  scanOnly?: boolean;
  analyzeOnly?: boolean;
}
export async function pipeline(
  root: string,
  c: Config,
  state: State,
  options: Options = {},
  agent: AgentProvider = new ClaudeAgent(),
) {
  const output: unknown[] = [];
  let failed = false;
  if (options.source && !c.sources.some((s) => s.id === options.source))
    throw new Error(`Unknown source: ${options.source}`);
  if (!options.scanOnly) {
    const remotes = (await run("git", ["remote"], root)).trim().split("\n");
    if (remotes.includes("origin"))
      await run(
        "git",
        [
          "fetch",
          "origin",
          `refs/heads/${c.knowledge.target_branch}:refs/remotes/origin/${c.knowledge.target_branch}`,
        ],
        root,
      );
    await reconcile(root, c, state);
  }
  if (!options.analyzeOnly) {
    const selected = c.sources.filter(
      (s) => !options.source || s.id === options.source,
    );
    let pageBudget = c.watch.budgets.max_pages_per_run;
    // Bounded source concurrency; page quotas are allocated before starting each scan.
    const jobs = selected.map((source) => ({
      source,
      pages:
        source.type === "web"
          ? Math.min(source.crawl.max_pages, Math.max(0, pageBudget))
          : 0,
    }));
    for (const j of jobs)
      if (j.source.type === "web") {
        j.pages = Math.min(j.source.crawl.max_pages, Math.max(0, pageBudget));
        pageBudget -= j.pages;
      }
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(c.watch.max_concurrent_sources, jobs.length) },
        async () => {
          while (next < jobs.length) {
            const { source, pages } = jobs[next++];
            const prev = state.getSource(source.id);
            if (
              options.dueOnly &&
              prev &&
              (prev.due > Date.now() ||
                ["auth_required", "needs_review"].includes(prev.status))
            )
              continue;
            const fingerprint = hash(
              JSON.stringify([
                source.type,
                source.url,
                source.type === "git" ? source.branch : source.browser.profile,
                source.include,
                source.exclude,
                source.type === "web" ? source.crawl : null,
              ]),
            );
            if (prev?.revision && prev.fingerprint !== fingerprint) {
              failed = true;
              output.push({
                source: source.id,
                status: "migration_required",
                error: "Source identity/scope changed; use a new source ID",
              });
              continue;
            }
            try {
              if (source.type === "web" && pages === 0)
                throw new Error("Run page budget exhausted");
              const change =
                source.type === "git"
                  ? await scanGit(root, source, prev?.revision ?? null)
                  : await scanWeb(root, source, prev?.revision ?? null, pages);
              state.transaction(() => {
                if (change.evidence.length)
                  state.db
                    .prepare(
                      "INSERT OR IGNORE INTO changes(id,source_id,revision,payload) VALUES(?,?,?,?)",
                    )
                    .run(
                      change.id,
                      source.id,
                      change.toRevision,
                      JSON.stringify(change),
                    );
                state.db
                  .prepare(
                    "INSERT INTO sources(id,fingerprint,revision,due,status) VALUES(?,?,?,?,'ok') ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,revision=excluded.revision,due=excluded.due,status='ok',error=NULL,attempts=0",
                  )
                  .run(
                    source.id,
                    fingerprint,
                    change.toRevision,
                    Date.now() + duration(source.interval),
                  );
              });
              output.push({
                source: source.id,
                status: change.evidence.length ? "queued" : "unchanged",
                files: change.evidence.length,
              });
            } catch (e: any) {
              failed = true;
              const attempts = (prev?.attempts ?? 0) + 1;
              const status =
                /AUTH_REQUIRED|authenticat|Permission denied/i.test(e.message)
                  ? "auth_required"
                  : attempts >= c.watch.retry.max_attempts
                    ? "needs_review"
                    : "failed";
              state.db
                .prepare(
                  "INSERT INTO sources(id,fingerprint,due,status,error,attempts) VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET due=excluded.due,status=excluded.status,error=excluded.error,attempts=sources.attempts+1",
                )
                .run(
                  source.id,
                  fingerprint,
                  Date.now() +
                    Math.min(
                      duration(c.watch.retry.max_delay),
                      duration(c.watch.retry.initial_delay) *
                        2 ** (attempts - 1),
                    ),
                  status,
                  e.message,
                );
              output.push({ source: source.id, status, error: e.message });
            }
          }
        },
      ),
    );
  }
  if (!options.scanOnly) {
    let count = 0;
    for (const job of state.pending(options.source)) {
      if (count++ >= c.watch.budgets.max_agent_jobs_per_run) break;
      const change: ChangeSet = JSON.parse(job.payload);
      // Removed sources are paused; queued changes keep their original policy snapshot.
      if (!c.sources.some((s) => s.id === change.source.id)) {
        output.push({ change: job.id, status: "source_removed" });
        continue;
      }
      if (!options.dryRun)
        state.db
          .prepare(
            "UPDATE changes SET status='analyzing',attempts=attempts+1 WHERE id=?",
          )
          .run(job.id);
      try {
        const rules = await readRules(root, c, await baselineRef(root, c));
        const result = job.result
          ? { assessment: JSON.parse(job.result), usage: null }
          : await agent.analyze(change, rules, c);
        const assessment = validateAssessment(result.assessment, change, rules);
        for (const action of assessment.actions)
          await validateMarkdown(action.after);
        if (!options.dryRun)
          state.db
            .prepare("UPDATE changes SET result=? WHERE id=?")
            .run(JSON.stringify(assessment), job.id);
        const proposal = await createProposal(
          root,
          c,
          state,
          change,
          assessment,
          rules,
          !!options.local,
          !!options.dryRun,
        );
        if (!options.dryRun) {
          state.db
            .prepare("UPDATE changes SET status='done',error=NULL WHERE id=?")
            .run(job.id);
          state.event("analysis", {
            change: job.id,
            proposal,
            usage: result.usage,
          });
        }
        output.push({ change: job.id, ...proposal });
      } catch (e: any) {
        failed = true;
        const blocked = /BLOCKED_BY_POLICY|not implemented/.test(e.message);
        const attempts = job.attempts + 1;
        const status = blocked
          ? "blocked"
          : attempts >= c.watch.retry.max_attempts
            ? "needs_review"
            : "retry";
        const retry =
          Date.now() +
          Math.min(
            duration(c.watch.retry.max_delay),
            duration(c.watch.retry.initial_delay) * 2 ** job.attempts,
          );
        if (!options.dryRun)
          state.db
            .prepare(
              "UPDATE changes SET status=?,retry_at=?,error=? WHERE id=?",
            )
            .run(status, retry, e.message, job.id);
        output.push({ change: job.id, status, error: e.message });
      }
    }
  }
  state.event("run", { failed, output });
  return { failed, results: output };
}
export async function withPipeline<T>(
  root: string,
  fn: (s: State) => Promise<T>,
) {
  try {
    await run(
      "git",
      ["check-ignore", "--quiet", "--", ".bk/state.sqlite"],
      root,
    );
  } catch {
    throw new Error("Add .bk/ to .gitignore before running BK");
  }
  const release = await lock(join(root, ".bk/locks/pipeline.lock"));
  let state: State | undefined;
  try {
    state = new State(root);
    state.recover();
    return await fn(state);
  } finally {
    state?.close();
    await release();
  }
}
export async function watch(
  root: string,
  emit: (x: unknown) => void,
  signal: AbortSignal,
) {
  const release = await lock(join(root, ".bk/locks/watch.lock"));
  let config = await loadConfig(root);
  try {
    while (!signal.aborted) {
      try {
        config = await loadConfig(root);
      } catch (e: any) {
        emit({ status: "invalid_config", error: e.message });
      }
      if (config.watch.enabled)
        try {
          emit(
            await withPipeline(root, (s) =>
              pipeline(root, config, s, { dueOnly: true }),
            ),
          );
        } catch (e: any) {
          emit({ status: "failed", error: e.message });
        }
      await delay(duration(config.watch.tick_interval), signal);
    }
  } finally {
    await release();
  }
}
