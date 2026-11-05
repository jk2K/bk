import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  renderImage,
  interpretCached,
  ImageInterpretationSchema,
} from "../src/knowledge/images.js";
import { ConfigSchema } from "../src/config/index.js";
import type { ImageAsset } from "../src/sources/assets.js";
const image: ImageAsset = {
  url: "https://wiki.example/image.png",
  hash: "a".repeat(64),
  mime: "image/png",
  bytes: 1,
};
const diagram = () => ({
  kind: "diagram" as const,
  description: "Order flows to payment",
  nodes: [
    { id: "order", label: "Order" },
    { id: "payment", label: "Payment" },
  ],
  edges: [{ from: "order", to: "payment", label: "submit" }],
  table: [],
  uncertainties: [] as string[],
});
test("visual IR validates graph references and emits actual Mermaid through the parser", async () => {
  const rendered = await renderImage(diagram(), image);
  assert.match(rendered.markdown, /flowchart TD/);
  assert.match(rendered.markdown, /UNVERIFIED/);
  assert.throws(() =>
    ImageInterpretationSchema.parse({
      ...diagram(),
      edges: [{ from: "missing", to: "payment", label: "" }],
    }),
  );
  assert.throws(() =>
    ImageInterpretationSchema.parse({ ...diagram(), kind: "photo" }),
  );
});
test("charts emit tables and UI/photos never invent a relationship graph", async () => {
  for (const kind of ["chart", "photo", "ui"] as const) {
    const r = await renderImage(
      {
        kind,
        description: "Visible source content",
        nodes: [],
        edges: [],
        table:
          kind === "chart"
            ? [
                ["Metric", "Value"],
                ["Orders", "10"],
              ]
            : [],
        uncertainties: ["Some labels unclear"],
      },
      image,
    );
    assert.doesNotMatch(r.markdown, /```mermaid/);
    if (kind === "chart") assert.match(r.markdown, /Orders \| 10/);
    assert.match(r.markdown, /Some labels unclear/);
  }
});
test("image inference caches by content/model version and verification uncertainty remains explicit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bk-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = Buffer.from("fixture image bytes"),
    hash = createHash("sha256").update(data).digest("hex");
  await mkdir(join(root, ".bk/assets"), { recursive: true });
  await writeFile(join(root, ".bk/assets", hash), data);
  const asset = { ...image, hash, bytes: data.length };
  const c = ConfigSchema.parse({
    version: 1,
    sources: [
      {
        id: "wiki",
        type: "web",
        role: "requirement",
        url: "https://wiki.example/",
        data_classification: "public",
        browser: { profile: "wiki" },
        crawl: { allowed_hosts: ["wiki.example"] },
      },
    ],
  });
  const source = c.sources[0];
  if (source.type !== "web") return;
  let calls = 0,
    verifications = 0;
  const agent = {
    analyze: async () => ({ assessment: { actions: [] }, usage: {} }),
    interpretImage: async () => {
      calls++;
      return { value: diagram(), usage: {} };
    },
    verifyImage: async () => {
      verifications++;
      return {
        value: { verified: false, issues: ["Edge not clearly visible"] },
        usage: {},
      };
    },
  };
  const first = await interpretCached(root, asset, source, c, agent);
  assert.equal(first.cached, false);
  assert.match(first.markdown, /Edge not clearly visible/);
  const second = await interpretCached(root, asset, source, c, agent);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.equal(verifications, 1);
  await assert.rejects(
    () =>
      interpretCached(
        root,
        asset,
        { ...source, data_classification: "restricted" },
        c,
        agent,
      ),
    /BLOCKED_BY_POLICY/,
  );
  c.agent.model = "different-model";
  await interpretCached(root, asset, source, c, agent);
  assert.equal(calls, 2);
});
test("vision resumes a saved intermediate result when a run budget expires before verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bk-image-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = Buffer.from("fixture"),
    hash = createHash("sha256").update(data).digest("hex"),
    asset = { ...image, hash, bytes: data.length };
  await mkdir(join(root, ".bk/assets"), { recursive: true });
  await writeFile(join(root, ".bk/assets", hash), data);
  const c = ConfigSchema.parse({
    version: 1,
    sources: [
      {
        id: "wiki",
        type: "web",
        role: "requirement",
        url: "https://wiki.example/",
        data_classification: "public",
        browser: { profile: "wiki" },
        crawl: { allowed_hosts: ["wiki.example"] },
      },
    ],
  });
  const source = c.sources[0];
  if (source.type !== "web") return;
  let inference = 0,
    verify = 0,
    calls = 0;
  const agent = {
    analyze: async () => ({ assessment: { actions: [] }, usage: {} }),
    interpretImage: async () => {
      inference++;
      return { value: diagram(), usage: {} };
    },
    verifyImage: async () => {
      verify++;
      return { value: { verified: true, issues: [] }, usage: {} };
    },
  };
  const budget = () => {
    if (calls++ >= 1) throw new Error("MODEL_RUN_BUDGET_EXHAUSTED");
  };
  await assert.rejects(
    () => interpretCached(root, asset, source, c, agent, budget),
    /MODEL_RUN_BUDGET/,
  );
  assert.equal(inference, 1);
  assert.equal(verify, 0);
  calls = 0;
  const resumed = await interpretCached(root, asset, source, c, agent, budget);
  assert.equal(inference, 1);
  assert.equal(verify, 1);
  assert.equal(resumed.cached, false);
});
