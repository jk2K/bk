import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Source } from "../config/index.js";
export type SDKQuery = (
  params: Parameters<typeof query>[0],
) => AsyncIterable<SDKMessage>;
export interface ImageInput {
  mime: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}
export interface RuntimeInput {
  prompt: string;
  images?: ImageInput[];
  server?: NonNullable<Options["mcpServers"]>[string];
  toolNames?: string[];
}
export function assertTransmission(
  source: Pick<Source, "data_classification">,
  config: Config,
) {
  if (
    source.data_classification === "restricted" ||
    (source.data_classification === "internal" &&
      !config.agent.allow_internal_data)
  )
    throw new Error(
      "BLOCKED_BY_POLICY: source requires explicit agent.allow_internal_data",
    );
}
export class AgentRuntime {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly sdk: SDKQuery = query) {}
  async execute<T>(schema: z.ZodType<T>, input: RuntimeInput, c: Config) {
    let release!: () => void;
    const preceding = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      return await this.perform(schema, input, c);
    } finally {
      release();
    }
  }
  private async perform<T>(
    schema: z.ZodType<T>,
    input: RuntimeInput,
    c: Config,
  ) {
    if (
      this.sdk === query &&
      !process.env.ANTHROPIC_API_KEY &&
      process.env.CLAUDE_CODE_USE_BEDROCK !== "1" &&
      process.env.CLAUDE_CODE_USE_VERTEX !== "1"
    )
      throw new Error(
        "AUTH_REQUIRED: configure approved enterprise model authentication",
      );
    if (input.prompt.length > 120000)
      throw new Error("Agent prompt budget exceeded; narrow the source scope");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), c.agent.timeout_ms);
    const cwd = await mkdtemp(join(tmpdir(), "bk-agent-"));
    const names = input.toolNames ?? [];
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: input.prompt },
            ...(input.images ?? []).map((i) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: i.mime,
                data: i.base64,
              },
            })),
          ],
        },
      };
    }
    try {
      for await (const m of this.sdk({
        prompt: prompt(),
        options: {
          cwd,
          tools: [],
          allowedTools: names,
          mcpServers: input.server ? { bk: input.server } : {},
          settingSources: [],
          persistSession: false,
          permissionMode: "dontAsk",
          canUseTool: async (name) =>
            names.includes(name)
              ? { behavior: "allow" }
              : {
                  behavior: "deny",
                  message: "Only registered read-only BK tools are permitted",
                },
          maxTurns: c.agent.max_turns,
          maxBudgetUsd: c.agent.max_budget_usd,
          abortController: controller,
          outputFormat: {
            type: "json_schema",
            schema: z.toJSONSchema(schema) as Record<string, unknown>,
          },
          ...(c.agent.model === "configured-by-environment"
            ? {}
            : { model: c.agent.model }),
        },
      })) {
        if (m.type === "result") {
          if (m.subtype !== "success")
            throw new Error(`Agent failed: ${m.subtype}`);
          return {
            value: schema.parse(m.structured_output),
            usage: { cost: m.total_cost_usd, usage: m.usage },
          };
        }
      }
      throw new Error("Agent ended without structured output");
    } finally {
      clearTimeout(timer);
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
