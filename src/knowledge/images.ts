import { z } from "zod";
import { hash, atomic } from "../util.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Config } from "../config/index.js";
import type { WebSource } from "../browser/index.js";
import type { ImageAsset } from "../sources/assets.js";
import { readImage } from "../sources/assets.js";
import type { AgentProvider } from "../agent/index.js";
import { validateMarkdown } from "../validation/index.js";
import { assertTransmission } from "../agent/runtime.js";
export const ImageVerificationSchema = z
  .object({
    verified: z.boolean(),
    issues: z.array(z.string().max(1000)).max(30),
  })
  .strict();
export const ImageInterpretationSchema = z
  .object({
    kind: z.enum(["diagram", "chart", "ui", "photo", "other"]),
    description: z.string().min(1).max(10000),
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
            label: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(60),
    edges: z
      .array(
        z
          .object({
            from: z.string(),
            to: z.string(),
            label: z.string().max(200),
          })
          .strict(),
      )
      .max(100),
    table: z.array(z.array(z.string().max(500)).max(20)).max(100),
    uncertainties: z.array(z.string().max(1000)).max(30),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ids = new Set(r.nodes.map((n) => n.id));
    if (
      ids.size !== r.nodes.length ||
      r.edges.some((e) => !ids.has(e.from) || !ids.has(e.to))
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate nodes or edge references unknown node",
      });
    if (r.kind !== "diagram" && (r.nodes.length || r.edges.length))
      ctx.addIssue({
        code: "custom",
        message: "Non-diagram images cannot define relationships",
      });
    if (r.kind === "diagram" && !r.nodes.length)
      ctx.addIssue({ code: "custom", message: "Diagram requires nodes" });
  });
export type ImageInterpretation = z.infer<typeof ImageInterpretationSchema>;
const label = (s: string) =>
  s
    .replace(/[<>\[\]{}|`\\]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/[\r\n]/g, " ");
export async function renderImage(raw: unknown, image: ImageAsset) {
  const value = ImageInterpretationSchema.parse(raw);
  let markdown = `Visual interpretation (UNVERIFIED, needs human review)\nImage SHA-256: ${image.hash}\nSource: ${image.url}\n\n${value.description}\n`;
  if (value.kind === "diagram") {
    const code =
      "flowchart TD\n" +
      value.nodes.map((n) => `  ${n.id}["${label(n.label)}"]`).join("\n") +
      "\n" +
      value.edges
        .map(
          (e) =>
            `  ${e.from} -->${e.label ? '|"' + label(e.label) + '"|' : ""} ${e.to}`,
        )
        .join("\n");
    await validateMarkdown("```mermaid\n" + code + "\n```");
    markdown += "\n```mermaid\n" + code + "\n```\n";
  } else if (value.kind === "chart" && value.table.length) {
    const width = Math.max(...value.table.map((row) => row.length));
    const row = (r: string[]) =>
      "| " +
      Array.from({ length: width }, (_, i) =>
        (r[i] ?? "").replace(/\|/g, "\\|").replace(/[\r\n]/g, " "),
      ).join(" | ") +
      " |";
    markdown +=
      "\n" +
      [
        row(value.table[0]),
        row(Array(width).fill("---")),
        ...value.table.slice(1).map(row),
      ].join("\n") +
      "\n";
  }
  if (value.uncertainties.length)
    markdown +=
      "\nUncertainties:\n" +
      value.uncertainties.map((u) => "- " + u).join("\n");
  return { value, markdown };
}
export async function interpretCached(
  root: string,
  image: ImageAsset,
  source: WebSource,
  c: Config,
  agent: AgentProvider,
  beforeModel: () => void = () => {},
) {
  assertTransmission(source, c);
  if (!agent.interpretImage) throw new Error("Image provider unavailable");
  const key = hash(
    JSON.stringify([
      image.hash,
      c.agent.model,
      "image-prompt-v1",
      "image-schema-v1",
      c.compiler.image.verify_semantics,
    ]),
  );
  const path = join(root, ".bk/image-analysis", key + ".json");
  const base64 = await readImage(root, image, c.compiler.image.max_bytes);
  try {
    const cached = JSON.parse(await readFile(path, "utf8"));
    const rendered = await renderImage(cached.value, image);
    return { ...rendered, usage: null, cached: true };
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }

  const draftPath = path + ".draft";
  let value: ImageInterpretation;
  const usages: unknown[] = [];
  try {
    value = ImageInterpretationSchema.parse(
      JSON.parse(await readFile(draftPath, "utf8")),
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    beforeModel();
    const result = await agent.interpretImage(image, base64, source, c);
    value = ImageInterpretationSchema.parse(result.value);
    await renderImage(value, image);
    usages.push(result.usage);
    await atomic(draftPath, JSON.stringify(value));
  }
  if (c.compiler.image.verify_semantics) {
    if (!agent.verifyImage)
      throw new Error("Image verification provider unavailable");
    beforeModel();
    const checked = await agent.verifyImage(image, base64, value, source, c);
    usages.push(checked.usage);
    const verification = ImageVerificationSchema.parse(checked.value);
    if (!verification.verified || verification.issues.length)
      value.uncertainties = Array.from(
        new Set([
          "Independent visual verification did not confirm every fact",
          ...value.uncertainties,
          ...verification.issues,
        ]),
      ).slice(0, 30);
  }
  const rendered = await renderImage(value, image);
  await atomic(path, JSON.stringify({ value: rendered.value }));
  return { ...rendered, usage: usages, cached: false };
}
