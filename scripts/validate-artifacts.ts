import { writeValidationReport } from "./validation-report.js";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { ConfigSchema } from "../src/config/index.js";
import { installReadonlyPolicy, type WebSource } from "../src/browser/index.js";
import { BrowserSession, replayRecipe } from "../src/browser/session.js";
import { extractPage } from "../src/sources/web.js";
import { pipeline } from "../src/scheduler/index.js";
import { State } from "../src/state/index.js";
import { run } from "../src/util.js";
import type { ChangeSet } from "../src/sources/git.js";
import type { Rule } from "../src/knowledge/index.js";
const root = process.cwd(),
  out = resolve(
    process.env.BK_VALIDATION_DIR ?? join(root, ".bk/validation/latest"),
  );
await mkdir(out, { recursive: true });
await mkdir(join(out, "logs"), { recursive: true });
const started = new Date().toISOString(),
  checks: any[] = [];
function check(name: string, command: string, args: string[]) {
  const began = Date.now();
  const p = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BK_REQUIRE_BROWSER_TESTS: "1" },
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const file = "logs/" + name + ".log";
  return writeFile(join(out, file), (p.stdout ?? "") + (p.stderr ?? "")).then(
    () => {
      checks.push({
        name,
        command: [command, ...args],
        exitCode: p.status,
        durationMs: Date.now() - began,
        log: file,
      });
      if (p.status !== 0)
        throw new Error(`Validation failed: ${name}; see ${file}`);
    },
  );
}
await check("typecheck", "npm", ["run", "typecheck"]);
await check("validation-typecheck", "npm", ["run", "typecheck:validation"]);
const tests = (await readdir(join(root, "tests")))
  .filter((p) => p.endsWith(".test.ts"))
  .sort()
  .map((p) => "tests/" + p);
await check("tests", process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-reporter=spec",
  "--test-reporter-destination=" + join(out, "logs/tests-spec.log"),
  "--test-reporter=junit",
  "--test-reporter-destination=" + join(out, "junit.xml"),
  "--test-reporter=tap",
  "--test-reporter-destination=" + join(out, "logs/tests.tap"),
  ...tests,
]);
await check("build", "npm", ["run", "build"]);
await check("format", "npm", ["run", "format:check"]);
await check("package", "npm", ["pack", "--dry-run"]);
const tap = await readFile(join(out, "logs/tests.tap"), "utf8");
const metric = (name: string) =>
  Number(new RegExp("# " + name + " (\\d+)").exec(tap)?.[1] ?? NaN);
const counts = {
  tests: metric("tests"),
  passed: metric("pass"),
  failed: metric("fail"),
  skipped: metric("skipped"),
};
assert.ok(counts.tests > 0);
assert.equal(counts.failed, 0);
assert.equal(counts.skipped, 0);
const temp = await mkdtemp(join(tmpdir(), "bk-validation-"));
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let browserVersion = "";
const scenarios: any[] = [];
const frames: string[] = [];
const timestamps: number[] = [];
const writes: Promise<unknown>[] = [];
try {
  // A real Git pipeline, with an explicitly deterministic model adapter.
  const upstream = join(temp, "prd"),
    knowledge = join(temp, "knowledge");
  for (const path of [upstream, knowledge]) {
    await mkdir(path);
    await run("git", ["init", "-b", "main"], path);
    await run("git", ["config", "user.name", "BK Validation"], path);
    await run("git", ["config", "user.email", "validation@localhost"], path);
    await writeFile(join(path, ".gitignore"), ".bk/\n");
    await run("git", ["add", "."], path);
    await run("git", ["commit", "-m", "Initialize fixture"], path);
  }
  const first = "Merchant prices remain locked until withdrawal.",
    second =
      "Merchant prices remain locked until withdrawal or approved rejection.";
  await writeFile(join(upstream, "pricing.md"), first);
  await run("git", ["add", "."], upstream);
  await run("git", ["commit", "-m", "Add pricing requirement"], upstream);
  const config = ConfigSchema.parse({
      version: 1,
      sources: [
        {
          id: "pricing-prd",
          type: "git",
          role: "requirement",
          url: upstream,
          data_classification: "public",
          include: ["**/*.md"],
        },
      ],
    }),
    state = new State(knowledge);
  let modelCalls = 0;
  const agent = {
    analyze: async (change: ChangeSet, rules: Rule[]) => {
      modelCalls++;
      const after = change.evidence[0].after;
      return {
        assessment: {
          actions: [
            {
              action: rules.length ? "update_rule" : "add_rule",
              ruleId: "PROMO-PRICE-LOCK-001",
              domain: "marketing",
              summary: "Price lock release conditions",
              before: rules[0]?.statement ?? "",
              after,
              evidence: [
                {
                  locator: "pricing.md",
                  revision: change.toRevision,
                  quote: after,
                },
              ],
              rationale:
                "Deterministic fixture adapter copies the explicit requirement clause; this is not real Claude inference.",
              uncertainty: [],
              businessEffectiveStatus: "pending_release",
            },
          ],
        },
        usage: { provider: "deterministic-test-adapter" },
      };
    },
  };
  const imported = await pipeline(
    knowledge,
    config,
    state,
    { local: true },
    agent,
  );
  assert.equal(imported.failed, false);
  const proposal: any = state.db.prepare("SELECT * FROM proposals").get();
  await run("git", ["merge", "--ff-only", proposal.branch], knowledge);
  const callsBefore = modelCalls;
  const unchanged = await pipeline(
    knowledge,
    config,
    state,
    { local: true },
    agent,
  );
  assert.equal(modelCalls, callsBefore);
  assert.equal(unchanged.failed, false);
  await writeFile(join(upstream, "pricing.md"), second);
  await run("git", ["add", "."], upstream);
  await run(
    "git",
    ["commit", "-m", "Add approved rejection release condition"],
    upstream,
  );
  const updated = await pipeline(
    knowledge,
    config,
    state,
    { local: true },
    agent,
  );
  assert.equal(updated.failed, false);
  const candidate: any = state.db
    .prepare("SELECT * FROM proposals ORDER BY rowid DESC LIMIT 1")
    .get();
  const patch = await readFile(
    join(knowledge, ".bk/proposals", candidate.id, "proposal.patch"),
    "utf8",
  );
  assert.match(patch, /approved rejection/);
  const touchedFiles = [...patch.matchAll(/^diff --git a\/(.+) b\/.+$/gm)].map(
    (m) => m[1],
  );
  assert.equal(touchedFiles.length, 2);
  assert.ok(
    touchedFiles.every(
      (p) =>
        p.startsWith("indexes/proposal-") ||
        p === "knowledge/marketing/PROMO-PRICE-LOCK-001.md",
    ),
  );
  await writeFile(join(out, "knowledge-proposal.patch"), patch);
  const current = await run(
    "git",
    ["show", "HEAD:knowledge/marketing/PROMO-PRICE-LOCK-001.md"],
    knowledge,
  );
  assert.ok(current.includes(first));
  assert.ok(!current.includes(second));
  await writeFile(
    join(out, "pipeline-results.json"),
    JSON.stringify(
      {
        model: "deterministic fixture adapter (not Claude)",
        imported,
        unchanged,
        updated,
        modelCalls,
        touchedFiles,
        mainWorktreeRetainedApprovedVersion: true,
      },
      null,
      2,
    ),
  );
  state.close();
  scenarios.push({
    name: "Git scan → local proposal → simulated human merge → requirement update",
    status: "passed",
    evidence: "pipeline-results.json",
    model: "mock",
    assertions: [
      "unchanged source made zero additional model calls",
      "second requirement generated a minimal patch",
      "unapproved update did not alter the formal worktree",
    ],
  });
  let receivedWrites = 0;
  server = createServer((req, res) => {
    if (req.method === "POST") {
      receivedWrites++;
      res.end("Unexpected write");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>BK browser validation fixture</title><style>*{box-sizing:border-box}body{margin:0;background:#eef2f6;color:#172437;font:18px Arial,sans-serif}.banner{padding:18px 50px;background:#122238;color:white;font-size:14px;letter-spacing:1px}.layout{display:grid;grid-template-columns:1fr 320px;gap:28px;margin:40px 50px}main,aside{background:white;border:1px solid #d6dfe8;border-radius:12px;padding:28px}small{color:#62768d}h1{font-size:32px;line-height:1.2;margin:14px 0}h2{font-size:20px}.id{font-size:14px;color:#375fd0}p{line-height:1.6}details{margin:24px 0;border:1px solid #d6dfe8;padding:18px;border-radius:8px}summary{cursor:pointer;font-weight:bold}.badge{display:inline-block;background:#e6f5ed;color:#196344;padding:7px 12px;border-radius:6px;font-size:14px}button{font-size:15px;border:1px solid #c3cddd;padding:11px 14px;border-radius:6px;background:white;margin-top:15px;cursor:pointer}#result{font-size:16px;line-height:1.7;color:#314a67}.note{padding-top:20px;font-size:13px;color:#75869a}</style></head><body><div class="banner">BK 0.2 · LOCAL SOURCE-DOCUMENT FIXTURE · REAL CHROMIUM RECORDING · NO LIVE AI MODEL</div><div class="layout"><main><small>SIMULATED WIKI / MARKETING REQUIREMENTS</small><h1>Promotion price locking</h1><div class="id">PROMO-PRICE-LOCK-001</div><p>After a merchant submits an activity application, all participating SKU prices remain locked.</p><details><summary id="expand">Release conditions — expand the source clause</summary><p id="release">The price lock ends after withdrawal, approved rejection, activity exit, or activity completion.</p></details><button id="attempt-write" type="button" onclick="fetch('/write',{method:'POST'}).catch(()=>{document.body.dataset.blocked='yes'})">Exercise write-request protection</button><p class="note">This page is a test fixture, not a BK web application or a production business page. Actions are driven by the actual BrowserSession implementation.</p></main><aside><small>VALIDATION STEP</small><h2 id="stage">1 / Initial document</h2><span class="badge" id="badge">Read-only browser context</span><p id="result">The release conditions are collapsed. The test will expand them using a scoped browser tool.</p><div class="note">Model calls in this recording: 0<br>Data: synthetic fixture only</div></aside></div></body></html>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const host = "127.0.0.1:" + (server.address() as any).port;
  const source = ConfigSchema.parse({
    version: 1,
    sources: [
      {
        id: "browser-evidence",
        type: "web",
        role: "requirement",
        url: "http://" + host + "/",
        data_classification: "public",
        browser: {
          profile: "evidence",
          readonly_selectors: ["#attempt-write"],
        },
        crawl: { allowed_hosts: [host] },
      },
    ],
  }).sources[0] as WebSource;
  browser = await chromium.launch({
    ...(process.env.BK_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.BK_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    headless: true,
    args: process.env.BK_CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  browserVersion = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    serviceWorkers: "block",
  });
  await installReadonlyPolicy(context, source);
  const page = await context.newPage(),
    cdp = await context.newCDPSession(page);
  const framesDir = join(temp, "frames");
  await mkdir(framesDir);
  cdp.on("Page.screencastFrame", (event) => {
    const index = frames.length,
      path = join(framesDir, String(index).padStart(5, "0") + ".jpg");
    frames.push(path);
    timestamps.push(Date.now());
    writes.push(writeFile(path, Buffer.from(event.data, "base64")));
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 85,
    maxWidth: 1280,
    maxHeight: 720,
    everyNthFrame: 1,
  });
  await page.goto(source.url);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, "01-source-collapsed.png") });
  const session = new BrowserSession(page, source);
  assert.doesNotMatch(
    (await extractPage(page)).markdown,
    /The price lock ends/,
  );
  await session.perform({ action: "click", selector: "#expand" });
  const expanded = (await extractPage(page)).markdown;
  assert.match(expanded, /approved rejection/);
  await page.evaluate(() => {
    document.querySelector("#stage")!.textContent =
      "2 / Source extraction verified";
    document.querySelector("#result")!.textContent =
      "PASS: the expanded release conditions are present in the extracted Markdown snapshot.";
  });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(out, "02-source-expanded.png") });
  const recipe = session.recipe();
  await writeFile(
    join(out, "browser-recipe.json"),
    JSON.stringify(recipe, null, 2),
  );
  await page.reload();
  await replayRecipe(page, source, recipe);
  assert.equal((await extractPage(page)).markdown, expanded);
  await page.evaluate(() => {
    document.querySelector("#stage")!.textContent =
      "3 / Recipe replay verified";
    document.querySelector("#result")!.textContent =
      "PASS: replay on a fresh navigation produced the same extracted source content.";
  });
  await page.waitForTimeout(1800);
  await new BrowserSession(page, source).perform({
    action: "click",
    selector: "#attempt-write",
  });
  await page.waitForFunction(() => document.body.dataset.blocked === "yes");
  assert.equal(receivedWrites, 0);
  await page.evaluate(() => {
    document.querySelector("#stage")!.textContent =
      "4 / Write protection verified";
    document.querySelector("#badge")!.textContent =
      "PASS · 0 writes reached the server";
    document.querySelector("#result")!.textContent =
      "The BK read-only request policy blocked the attempted POST. The fixture server received zero write requests.";
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(out, "03-write-protection.png") });
  await cdp.send("Page.stopScreencast");
  await Promise.all(writes);
  await context.close();
  await browser.close();
  browser = undefined;
  assert.ok(frames.length > 2);
  const concat =
    frames
      .map(
        (p, i) =>
          `file '${p}'\nduration ${Math.max(0.04, ((timestamps[i + 1] ?? timestamps[i] + 1200) - timestamps[i]) / 1000).toFixed(3)}`,
      )
      .join("\n") + `\nfile '${frames.at(-1)}'\n`;
  await writeFile(join(temp, "frames.txt"), concat);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(temp, "frames.txt"),
      "-vf",
      "scale=1280:720,pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-r",
      "25",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(out, "browser-validation.mp4"),
    ],
    { timeout: 120000 },
  );
  scenarios.push({
    name: "Real Chromium scoped browsing, recipe replay and POST blocking",
    status: "passed",
    screenshots: [
      "01-source-collapsed.png",
      "02-source-expanded.png",
      "03-write-protection.png",
    ],
    video: "browser-validation.mp4",
    frames: frames.length,
    modelCalls: 0,
    receivedWrites,
  });
} finally {
  await browser?.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await rm(temp, { recursive: true, force: true });
}
const sourceFiles: string[] = [];
async function walk(dir: string) {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else sourceFiles.push(p);
  }
}
await walk("src");
await walk("tests");
await walk("scripts");
sourceFiles.push(
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.validation.json",
  "docs/VALIDATION-GAPS.md",
  ".github/workflows/ci.yml",
);
const fingerprints: Record<string, string> = {};
for (const p of sourceFiles.sort())
  fingerprints[p] = createHash("sha256")
    .update(await readFile(join(root, p)))
    .digest("hex");
const manifest = {
  startedAt: started,
  finishedAt: new Date().toISOString(),
  baseCommit: (await run("git", ["rev-parse", "HEAD"], root)).trim(),
  workingTreeChanges: (await run("git", ["status", "--porcelain"], root))
    .trim()
    .split("\n")
    .filter(Boolean),
  node: process.version,
  browser:
    process.env.BK_CHROMIUM_EXECUTABLE_PATH ?? "Playwright bundled Chromium",
  browserVersion,
  counts,
  checks,
  scenarios,
  sourceFingerprints: fingerprints,
  limitations: [
    "Claude reasoning and image interpretation use deterministic/mock adapters in tests; no real enterprise model evaluation",
    "No real enterprise SSO or live GitHub/Gitea/GitLab publication round trip",
    "Video is an actual browser screencast of a synthetic local wiki fixture; it is not a BK web UI or an autonomous live-model demonstration",
  ],
};
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeValidationReport(root, out, manifest);
console.log(
  JSON.stringify({ output: out, counts, scenarios: scenarios.length }),
);
