import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ChangeSet } from "../sources/git.js";
import type { Rule } from "../knowledge/index.js";
import { redact } from "../util.js";
const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: redact(JSON.stringify(data)) }],
});
export function evidenceTools(change: ChangeSet, rules: Rule[]) {
  const definitions = [
    tool(
      "source_read_evidence",
      "Read a bounded slice from the immutable scanned source snapshot, never arbitrary files.",
      {
        locator: z.string(),
        version: z.enum(["before", "after"]),
        offset: z.number().int().min(0).default(0),
        length: z.number().int().positive().max(12000).default(6000),
      },
      async (args) => {
        const e = change.evidence.find((e) => e.locator === args.locator);
        if (!e) throw new Error("Unknown evidence locator");
        const text = e[args.version];
        return result({
          locator: e.locator,
          revision:
            args.version === "before" ? change.fromRevision : change.toRevision,
          text: text.slice(args.offset, args.offset + args.length),
          total: text.length,
          visualInterpretations: change.derivedImages?.filter((image) =>
            e.after.includes(image.hash),
          ),
        });
      },
    ),
    tool(
      "knowledge_read_rule",
      "Read a related approved rule from the fixed analysis baseline.",
      { id: z.string() },
      async ({ id }) => {
        const rule = rules.find((r) => r.id === id);
        if (!rule) throw new Error("Unknown or unrelated rule");
        return result({
          id: rule.id,
          statement: rule.statement,
          sources: rule.meta.sources,
          effective: rule.meta.business_effective_status,
        });
      },
    ),
    tool(
      "knowledge_find_rules",
      "Find related rules already selected by source index and lexical matching.",
      { query: z.string().max(200) },
      async ({ query }) =>
        result(
          rules
            .filter((r) =>
              (r.id + " " + r.statement + " " + r.meta.title)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((r) => ({ id: r.id, title: r.meta.title })),
        ),
    ),
  ];
  return {
    server: createSdkMcpServer({
      name: "bk",
      version: "0.2.0",
      alwaysLoad: true,
      tools: definitions,
    }),
    toolNames: definitions.map((d) => "mcp__bk__" + d.name),
  };
}
