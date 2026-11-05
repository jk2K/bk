import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, type SDKQuery } from "../src/agent/runtime.js";
import { ClaudeAgent } from "../src/agent/index.js";
import { ConfigSchema } from "../src/config/index.js";
import { RuleIndex } from "../src/knowledge/retrieval.js";
import { validateAssessment, type Rule } from "../src/knowledge/index.js";
import type { ChangeSet } from "../src/sources/git.js";
import { z } from "zod";
const config = () =>
  ConfigSchema.parse({
    version: 1,
    sources: [
      {
        id: "prd",
        type: "git",
        role: "requirement",
        url: "/fixture",
        data_classification: "public",
      },
    ],
  });
const change = (): ChangeSet => ({
  id: "c",
  source: config().sources[0],
  fromRevision: null,
  toRevision: "v1",
  createdAt: new Date().toISOString(),
  rebased: false,
  evidence: [
    {
      locator: "pricing.md",
      kind: "added",
      before: "",
      after: "专题活动商品报名后锁价，直到退出活动。",
      beforeHash: "",
      afterHash: "a",
    },
  ],
});
const rule = (id: string, source = "prd", path = "pricing.md"): Rule => ({
  id,
  path: "knowledge/" + id + ".md",
  content: "",
  statement: "商品报名后锁价",
  meta: {
    title: "专题活动锁价",
    sources: [{ source_id: source, locator: path }],
    related_rules: [],
  },
});
test("rule index matches source anchors, renamed paths and Chinese text, then follows related IDs", () => {
  const direct = rule("PRICE-LOCK");
  direct.meta.sources[0].locator = "pricing.md#lock";
  direct.meta.related_rules = ["PAYMENT-STATUS"];
  const related = rule("PAYMENT-STATUS", "payments", "other.md");
  related.statement = "结算周期";
  related.meta.title = "Payment";
  const index = new RuleIndex([direct, related]);
  assert.deepEqual(
    index.find(change()).map((r) => r.id),
    ["PRICE-LOCK", "PAYMENT-STATUS"],
  );
  const lexical = new RuleIndex([rule("OTHER", "other", "another.md")]);
  assert.equal(lexical.find(change()).length, 1);
  const renamed = change();
  renamed.evidence[0].locator = "new.md";
  renamed.evidence[0].oldLocator = "pricing.md";
  assert.equal(index.find(renamed)[0].id, "PRICE-LOCK");
});
test("SDK runtime disables shell/project settings and only permits explicit read-only tools", async () => {
  let called = false;
  const sdk: SDKQuery = async function* (params) {
    called = true;
    assert.deepEqual(params.options?.tools, []);
    assert.deepEqual(params.options?.settingSources, []);
    assert.equal(params.options?.persistSession, false);
    assert.equal(params.options?.permissionMode, "dontAsk");
    const gate = params.options!.canUseTool!;
    assert.equal((await gate("Bash", {}, {} as any)).behavior, "deny");
    assert.equal(
      (await gate("mcp__bk__read", {}, {} as any)).behavior,
      "allow",
    );
    yield {
      type: "result",
      subtype: "success",
      structured_output: { ok: true },
      total_cost_usd: 0,
      usage: {},
    } as any;
  };
  const result = await new AgentRuntime(sdk).execute(
    z.object({ ok: z.boolean() }),
    { prompt: "Untrusted source", toolNames: ["mcp__bk__read"] },
    config(),
  );
  assert.equal(result.value.ok, true);
  assert.equal(called, true);
});
test("Claude adapter registers bounded evidence tools and blocks restricted transmission before any SDK call", async () => {
  let calls = 0;
  const sdk: SDKQuery = async function* (params) {
    calls++;
    assert.deepEqual(params.options?.allowedTools, [
      "mcp__bk__source_read_evidence",
      "mcp__bk__knowledge_read_rule",
      "mcp__bk__knowledge_find_rules",
    ]);
    assert.ok(params.options?.mcpServers?.bk);
    yield {
      type: "result",
      subtype: "success",
      structured_output: { actions: [] },
      usage: {},
      total_cost_usd: 0,
    } as any;
  };
  const agent = new ClaudeAgent(new AgentRuntime(sdk));
  await agent.analyze(change(), [], config());
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      agent.analyze(
        {
          ...change(),
          source: { ...change().source, data_classification: "restricted" },
        },
        [],
        config(),
      ),
    /BLOCKED_BY_POLICY/,
  );
  assert.equal(calls, 1);
});
test("public source cannot leak related internal approved rules to a model", async () => {
  const agent = new ClaudeAgent(
    new AgentRuntime(async function* () {
      throw new Error("Must not call model");
    }),
  );
  await assert.rejects(
    () =>
      agent.analyze(change(), [rule("PRIVATE", "unknown-internal")], config()),
    /BLOCKED_BY_POLICY/,
  );
});
test("SDK errors and malformed structured outputs fail closed", async () => {
  const runtime = new AgentRuntime(async function* () {
    yield { type: "result", subtype: "error_max_budget_usd" } as any;
  });
  await assert.rejects(
    () =>
      runtime.execute(
        z.object({ ok: z.boolean() }),
        { prompt: "test" },
        config(),
      ),
    /error_max_budget_usd/,
  );
  const malformed = new AgentRuntime(async function* () {
    yield {
      type: "result",
      subtype: "success",
      structured_output: { wrong: true },
      usage: {},
      total_cost_usd: 0,
    } as any;
  });
  await assert.rejects(() =>
    malformed.execute(
      z.object({ ok: z.boolean() }),
      { prompt: "test" },
      config(),
    ),
  );
});
test("image-bearing source actions require human clarification even with a textual quote", () => {
  const c = change();
  c.evidence[0].after += "\nIMAGE SHA256 " + "a".repeat(64);
  const result = validateAssessment(
    {
      actions: [
        {
          action: "add_rule",
          ruleId: "PRICE-LOCK",
          domain: "pricing",
          summary: "锁价",
          before: "",
          after: "报名后锁价",
          evidence: [
            { locator: "pricing.md", revision: "v1", quote: "商品报名后锁价" },
          ],
          rationale: "来源条款",
          uncertainty: [],
          businessEffectiveStatus: "pending_release",
        },
      ],
    },
    c,
    [],
  );
  assert.equal(result.actions[0].action, "needs_clarification");
});
test("shared SDK runtime serializes exploration, vision and analysis calls under one agent limit", async () => {
  let active = 0,
    maximum = 0;
  const runtime = new AgentRuntime(async function* () {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    yield {
      type: "result",
      subtype: "success",
      structured_output: { ok: true },
      usage: {},
      total_cost_usd: 0,
    } as any;
  });
  await Promise.all(
    [1, 2, 3].map(() =>
      runtime.execute(
        z.object({ ok: z.boolean() }),
        { prompt: "fixture" },
        config(),
      ),
    ),
  );
  assert.equal(maximum, 1);
});
