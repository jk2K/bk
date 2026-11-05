import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, duration, loadConfig } from "../src/config/index.js";
import { run, hash, lock } from "../src/util.js";
import { State } from "../src/state/index.js";
import { scanGit } from "../src/sources/git.js";
import {
  validateAssessment,
  renderRule,
  readRules,
} from "../src/knowledge/index.js";
import { pipeline, withPipeline } from "../src/scheduler/index.js";
import type { Source } from "../src/config/index.js";
import type { ChangeSet } from "../src/sources/git.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "bk-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function repo(path: string) {
  await mkdir(path, { recursive: true });
  await run("git", ["init", "-b", "main"], path);
  await run("git", ["config", "user.name", "Test"], path);
  await run("git", ["config", "user.email", "test@example.com"], path);
  await writeFile(join(path, ".gitignore"), ".bk/\n");
  await commit(path);
}
async function commit(path: string) {
  await run("git", ["add", "."], path);
  await run("git", ["commit", "--allow-empty", "-m", "fixture"], path);
  return (await run("git", ["rev-parse", "HEAD"], path)).trim();
}
const source = (url: string): Source =>
  ConfigSchema.parse({
    version: 1,
    sources: [
      {
        id: "prd",
        type: "git",
        role: "requirement",
        url,
        include: ["**/*.md"],
        data_classification: "public",
      },
    ],
  }).sources[0];
const change: ChangeSet = {
  id: "c",
  source: source("/fixture"),
  fromRevision: null,
  toRevision: "sha",
  rebased: false,
  createdAt: "2026-11-05T00:00:00Z",
  evidence: [
    {
      locator: "prd.md",
      kind: "added",
      before: "",
      after: "Price stays locked until withdrawal.",
      beforeHash: hash(""),
      afterHash: hash("Price stays locked until withdrawal."),
    },
  ],
};
const action = () => ({
  action: "add_rule",
  ruleId: "PROMO-LOCK-001",
  domain: "marketing",
  summary: "Price lock",
  before: "",
  after: "Price stays locked until withdrawal.",
  evidence: [
    { locator: "prd.md", revision: "sha", quote: "Price stays locked" },
  ],
  rationale: "The approved PRD defines a lock.",
  uncertainty: [],
  businessEffectiveStatus: "pending_release",
});
test("strict config rejects unknown keys, duplicates, invalid durations and automatic merge", () => {
  assert.throws(() => ConfigSchema.parse({ version: 1, unknown: true }));
  assert.throws(() =>
    ConfigSchema.parse({ version: 1, review: { auto_merge: true } }),
  );
  const s = source("/tmp/example");
  assert.throws(() => ConfigSchema.parse({ version: 1, sources: [s, s] }));
  assert.throws(() => duration("0m"));
  assert.throws(() => duration("1ms"));
  assert.equal(duration("2h"), 7200000);
});
test("config cannot follow symlink output directories", async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  await writeFile(join(root, "bk.yaml"), "version: 1\n");
  await symlink(outside, join(root, "knowledge"));
  await assert.rejects(() => loadConfig(root), /Symlink/);
});
test("repository lock excludes concurrent writers and releases", async (t) => {
  const root = await fixture(t),
    path = join(root, "writer.lock");
  const release = await lock(path);
  await assert.rejects(() => lock(path), /Already running/);
  await release();
  await (
    await lock(path)
  )();
});
test("Git scans first import, modifications, renames and deletions", async (t) => {
  const root = await fixture(t),
    upstream = join(root, "source"),
    knowledge = join(root, "knowledge");
  await repo(upstream);
  await mkdir(knowledge);
  await writeFile(join(upstream, "prd.md"), "First business rule");
  let revision = await commit(upstream);
  const s = source(upstream);
  assert.equal(s.type, "git");
  if (s.type !== "git") return;
  let scan = await scanGit(knowledge, s, null);
  assert.equal(scan.evidence.length, 1);
  assert.equal(scan.toRevision, revision);
  assert.equal((await scanGit(knowledge, s, revision)).evidence.length, 0);
  await run("git", ["mv", "prd.md", "rule.md"], upstream);
  await writeFile(
    join(upstream, "rule.md"),
    "First business rule, with an exception",
  );
  await commit(upstream);
  scan = await scanGit(knowledge, s, revision);
  assert.ok(scan.evidence.some((e) => e.locator === "rule.md"));
  revision = scan.toRevision;
  await rm(join(upstream, "rule.md"));
  await commit(upstream);
  scan = await scanGit(knowledge, s, revision);
  assert.equal(scan.evidence[0].kind, "deleted");
});
test("whitespace changes are retained because whitespace can carry business meaning", async (t) => {
  const root = await fixture(t),
    upstream = join(root, "source");
  await repo(upstream);
  await writeFile(join(upstream, "prd.md"), "Price lock");
  const revision = await commit(upstream);
  await writeFile(join(upstream, "prd.md"), "Price   lock\n");
  await commit(upstream);
  const s = source(upstream);
  if (s.type === "git")
    assert.equal((await scanGit(root, s, revision)).evidence.length, 1);
});
test("force push is detected and requires reconfirmation", async (t) => {
  const root = await fixture(t),
    upstream = join(root, "source");
  await repo(upstream);
  await writeFile(join(upstream, "prd.md"), "Approved rule");
  const old = await commit(upstream);
  const s = source(upstream);
  if (s.type !== "git") return;
  await scanGit(root, s, null);
  await run("git", ["checkout", "--orphan", "replacement"], upstream);
  await writeFile(join(upstream, "prd.md"), "Changed rule");
  await commit(upstream);
  await run("git", ["branch", "-M", "main"], upstream);
  const r = await scanGit(root, s, old);
  assert.equal(r.rebased, true);
});
test("evidence must reference exact source, revision and verbatim content", () => {
  assert.equal(
    validateAssessment({ actions: [action()] }, change, []).actions.length,
    1,
  );
  for (const field of ["locator", "revision", "quote"]) {
    const a = action();
    (a.evidence[0] as any)[field] = "invented";
    assert.throws(
      () => validateAssessment({ actions: [a] }, change, []),
      /Unverifiable/,
    );
  }
});
test("code and test evidence cannot approve a rule", () => {
  for (const role of ["implementation", "test"] as const) {
    const r = validateAssessment(
      { actions: [action()] },
      { ...change, source: { ...change.source, role } },
      [],
    );
    assert.equal(r.actions[0].action, "conflict");
  }
});
test("uncertain or unknown-effective rules become clarification reports", () => {
  const a = action();
  a.businessEffectiveStatus = "unknown";
  assert.equal(
    validateAssessment({ actions: [a] }, change, []).actions[0].action,
    "needs_clarification",
  );
});
test("stale before statement is rejected and manual text is preserved by rendering", () => {
  const original = renderRule(action() as any, change);
  const old = {
    id: "PROMO-LOCK-001",
    path: "knowledge/marketing/PROMO-LOCK-001.md",
    content: original + "\nHuman-maintained context.\n",
    statement: action().after,
    meta: { sources: [] },
  };
  const a = { ...action(), action: "update_rule", before: "wrong" };
  assert.throws(
    () => validateAssessment({ actions: [a] }, change, [old]),
    /Stale/,
  );
  a.before = old.statement;
  a.after = "Revised lock";
  const next = renderRule(a as any, change, old);
  assert.match(next, /Human-maintained context/);
  assert.match(next, /Revised lock/);
});
test("SQLite transactions roll back and interrupted analysis recovers", async (t) => {
  const root = await fixture(t),
    s = new State(root);
  t.after(() => s.close());
  assert.throws(() =>
    s.transaction(() => {
      s.event("discard", {});
      throw Error("rollback");
    }),
  );
  assert.equal(s.db.prepare("SELECT count(*) n FROM history").get()!.n, 0);
  s.db
    .prepare(
      "INSERT INTO changes(id,source_id,revision,payload,status) VALUES('id','prd','sha','{}','analyzing')",
    )
    .run();
  s.recover();
  assert.equal(s.pending().length, 1);
});
test("scan → failed model → retry → isolated proposal → unchanged sync is idempotent", async (t) => {
  const root = await fixture(t),
    upstream = join(root, "source"),
    knowledge = join(root, "knowledge");
  await repo(upstream);
  await writeFile(join(upstream, "prd.md"), change.evidence[0].after);
  await commit(upstream);
  await repo(knowledge);
  const c = ConfigSchema.parse({ version: 1, sources: [source(upstream)] });
  const state = new State(knowledge);
  t.after(() => state.close());
  let calls = 0;
  const agent = {
    analyze: async (cs: ChangeSet) => {
      calls++;
      return {
        assessment: {
          actions: [
            {
              ...action(),
              evidence: [
                {
                  locator: "prd.md",
                  revision: cs.toRevision,
                  quote: "Price stays locked",
                },
              ],
            },
          ],
        },
        usage: {},
      };
    },
  };
  await pipeline(knowledge, c, state, { scanOnly: true }, agent);
  assert.equal(calls, 0);
  assert.equal(state.pending().length, 1);
  let result = await pipeline(
    knowledge,
    c,
    state,
    { analyzeOnly: true },
    {
      analyze: async () => {
        throw Error("network timeout");
      },
    },
  );
  assert.equal(result.failed, true);
  assert.equal(
    state.db.prepare("SELECT status FROM changes").get()!.status,
    "retry",
  );
  state.db.prepare("UPDATE changes SET retry_at=0").run();
  await writeFile(join(knowledge, "personal.txt"), "Uncommitted user work");
  result = await pipeline(
    knowledge,
    c,
    state,
    { analyzeOnly: true, local: true },
    agent,
  );
  assert.equal(result.failed, false, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(
    await readFile(join(knowledge, "personal.txt"), "utf8"),
    "Uncommitted user work",
  );
  assert.equal((await readRules(knowledge, c)).length, 0);
  const p: any = state.db.prepare("SELECT * FROM proposals").get();
  assert.equal(p.status, "local");
  const rules = await readRules(knowledge, c, p.branch);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "PROMO-LOCK-001");
  await pipeline(knowledge, c, state, {}, agent);
  assert.equal(calls, 1);
  assert.equal(
    state.db.prepare("SELECT COUNT(*) n FROM proposals").get()!.n,
    1,
  );
});
test("dry run leaves jobs pending and creates no branch or proposal", async (t) => {
  const root = await fixture(t),
    upstream = join(root, "source"),
    knowledge = join(root, "knowledge");
  await repo(upstream);
  await writeFile(join(upstream, "prd.md"), change.evidence[0].after);
  await commit(upstream);
  await repo(knowledge);
  const c = ConfigSchema.parse({ version: 1, sources: [source(upstream)] }),
    state = new State(knowledge);
  t.after(() => state.close());
  const result = await pipeline(
    knowledge,
    c,
    state,
    { dryRun: true },
    {
      analyze: async (cs) => ({
        assessment: {
          actions: [
            {
              ...action(),
              evidence: [
                {
                  locator: "prd.md",
                  revision: cs.toRevision,
                  quote: "Price stays locked",
                },
              ],
            },
          ],
        },
        usage: {},
      }),
    },
  );
  assert.equal(result.failed, false);
  assert.equal(state.pending().length, 1);
  assert.equal(
    state.db.prepare("SELECT COUNT(*) n FROM proposals").get()!.n,
    0,
  );
  assert.equal(
    (await run("git", ["branch", "--list", "bk/*"], knowledge)).trim(),
    "",
  );
});
test("CLI init preserves existing content and exposes useful commands", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "AGENTS.md"), "my instructions");
  await run(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", "-C", root, "init"],
    process.cwd(),
  );
  assert.equal(
    await readFile(join(root, "AGENTS.md"), "utf8"),
    "my instructions",
  );
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /\.bk\//);
  const help = await run(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", "--help"],
    process.cwd(),
  );
  for (const cmd of ["sync", "watch", "scan", "analyze", "proposals"])
    assert.match(help, new RegExp(cmd));
});
