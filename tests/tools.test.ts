import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { evidenceTools } from "../src/agent/evidence-tools.js";
import { ConfigSchema } from "../src/config/index.js";
import type { ChangeSet } from "../src/sources/git.js";
const change: ChangeSet = {
  id: "event",
  source: ConfigSchema.parse({
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
  }).sources[0],
  fromRevision: "before-sha",
  toRevision: "after-sha",
  createdAt: "2026-11-05T00:00:00Z",
  rebased: false,
  evidence: [
    {
      locator: "prd/pricing.md",
      kind: "modified",
      before: "Old pricing clause.",
      after: "New pricing clause. " + "x".repeat(14000),
      beforeHash: "a",
      afterHash: "b",
    },
  ],
};
async function client(t: any) {
  const tools = evidenceTools(change, [
    {
      id: "PRICE-LOCK",
      path: "knowledge/price.md",
      content: "",
      statement: "Keep pricing locked",
      meta: {
        sources: [],
        title: "Price",
        business_effective_status: "active",
      },
    },
  ]);
  const client = new Client({ name: "bk-test", version: "1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await tools.server.instance.connect(b);
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await tools.server.instance.close();
  });
  return client;
}
test("actual MCP evidence server exposes only the three scoped source/knowledge tools", async (t) => {
  const c = await client(t);
  const tools = await c.listTools();
  assert.deepEqual(tools.tools.map((x) => x.name).sort(), [
    "knowledge_find_rules",
    "knowledge_read_rule",
    "source_read_evidence",
  ]);
  const result = await c.callTool({
    name: "source_read_evidence",
    arguments: {
      locator: "prd/pricing.md",
      version: "before",
      offset: 0,
      length: 3,
    },
  });
  const text = JSON.parse((result.content as any[])[0].text);
  assert.equal(text.text, "Old");
  assert.equal(text.revision, "before-sha");
  const rule = await c.callTool({
    name: "knowledge_read_rule",
    arguments: { id: "PRICE-LOCK" },
  });
  assert.equal(
    JSON.parse((rule.content as any[])[0].text).statement,
    "Keep pricing locked",
  );
});
test("actual MCP transport denies unknown paths, oversized reads and unrelated rule access", async (t) => {
  const c = await client(t);
  for (const call of [
    {
      name: "source_read_evidence",
      arguments: { locator: "../../.ssh/id_rsa", version: "after" },
    },
    {
      name: "source_read_evidence",
      arguments: {
        locator: "prd/pricing.md",
        version: "after",
        length: 999999,
      },
    },
    { name: "knowledge_read_rule", arguments: { id: "OTHER-PRIVATE-RULE" } },
  ]) {
    const result = await c.callTool(call);
    assert.equal(result.isError, true);
  }
});
