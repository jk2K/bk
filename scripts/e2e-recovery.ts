import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/index.js";
import { pipeline, watch, withPipeline } from "../src/scheduler/index.js";
import { State } from "../src/state/index.js";
import { run } from "../src/util.js";

const [mode, argument] = process.argv.slice(2);
if (mode === "worker") {
  const root = argument;
  const phase = process.env.BK_E2E_PHASE;
  if (phase === "watch") {
    const controller = new AbortController();
    process.on("SIGTERM", () => controller.abort());
    await watch(
      root,
      (value) => console.log(JSON.stringify(value)),
      controller.signal,
    );
  } else {
    const result = await withPipeline(root, async (state) =>
      pipeline(
        root,
        await loadConfig(root),
        state,
        { scanOnly: phase === "scan" },
        {
          async analyze(change) {
            if (phase === "analysis") {
              await writeFile(process.env.BK_E2E_MARKER!, "analyzing");
              await sleep(60000);
            }
            const evidence = change.evidence[0];
            return {
              assessment: {
                actions: [
                  {
                    action: "add_rule",
                    ruleId: "PRICE-LOCK",
                    domain: "pricing",
                    summary: "Price lock",
                    before: "",
                    after: evidence.after,
                    evidence: [
                      {
                        locator: evidence.locator,
                        revision: change.toRevision,
                        quote: evidence.after,
                      },
                    ],
                    rationale: "Deterministic E2E fixture adapter.",
                    uncertainty: [],
                    businessEffectiveStatus: "pending_release",
                  },
                ],
              },
              usage: null,
            };
          },
        },
      ),
    );
    console.log(JSON.stringify(result));
    process.exitCode = result.failed ? 1 : 0;
  }
} else {
  const temp = await mkdtemp(join(tmpdir(), "bk-e2e-"));
  const children = new Set<ChildProcess>();
  const evidence: Record<string, unknown>[] = [];
  function start(command: string, args: string[], env = process.env) {
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let log = "";
    child.stdout.on("data", (data) => {
      log += data;
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
    const finished = new Promise<{
      code: number | null;
      signal: string | null;
      log: string;
    }>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        children.delete(child);
        accept({ code, signal, log });
      });
    });
    return { child, finished, log: () => log };
  }
  function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
    if (child.pid) process.kill(-child.pid, signal);
  }
  async function until(test: () => boolean | Promise<boolean>, label: string) {
    const deadline = Date.now() + 15000;
    while (!(await test())) {
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for " + label);
      await sleep(40);
    }
  }
  try {
    const upstream = join(temp, "upstream"),
      root = join(temp, "knowledge");
    const origin = join(temp, "origin.git"),
      bin = join(temp, "bin");
    const marker = join(temp, "barrier"),
      review = join(temp, "review-created");
    await mkdir(bin);
    const realGit = (await run("which", ["git"])).trim();
    for (const path of [upstream, root]) {
      await mkdir(path);
      await run("git", ["init", "-b", "main"], path);
      await run("git", ["config", "user.name", "BK E2E"], path);
      await run("git", ["config", "user.email", "test@localhost"], path);
      await writeFile(join(path, ".gitignore"), ".bk/\n");
      await run("git", ["add", "."], path);
      await run("git", ["commit", "-m", "Initialize fixture"], path);
    }
    await run("git", ["clone", "--bare", root, origin]);
    await run("git", ["remote", "add", "origin", origin], root);
    const socket = createServer();
    await new Promise<void>((ok) => socket.listen(0, "127.0.0.1", ok));
    const addr = socket.address();
    assert.ok(addr && typeof addr !== "string");
    const port = addr.port;
    await new Promise<void>((ok, fail) =>
      socket.close((error) => (error ? fail(error) : ok())),
    );
    const source = `git://127.0.0.1:${port}/upstream`;
    const daemon = async () => {
      const git = start(realGit, [
        "daemon",
        "--verbose",
        "--reuseaddr",
        "--export-all",
        "--listen=127.0.0.1",
        "--port=" + port,
        "--base-path=" + temp,
        temp,
      ]);
      await until(() => git.log().includes("Ready to rumble"), "git daemon");
      return git;
    };
    let server = await daemon();
    await writeFile(
      join(root, "bk.yaml"),
      stringify({
        version: 1,
        sources: [
          {
            id: "prd",
            type: "git",
            branch: "main",
            url: source,
            role: "requirement",
            data_classification: "public",
            interval: "1s",
            include: ["**/*.md"],
          },
        ],
        watch: {
          tick_interval: "1s",
          retry: { initial_delay: "1s", max_delay: "1s" },
        },
        review: { mode: "pull-request", provider: "github", cli: "gh" },
      }),
    );
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
if [ "$BK_E2E_PHASE" = scan ] && [ "$3" = fetch ]; then
  printf scan > "$BK_E2E_MARKER"
  sleep 60
fi
exec "$BK_E2E_REAL_GIT" "$@"
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh
set -eu
case "$2" in
  list) if [ -f "$BK_E2E_REVIEW" ]; then echo '[{"url":"https://example.test/pull/1"}]'; else echo '[]'; fi ;;
  create)
    echo created >> "$BK_E2E_REVIEW"
    if [ "$BK_E2E_PHASE" = submission ]; then
      printf submitted > "$BK_E2E_MARKER"
      sleep 60
    fi
    echo 'https://example.test/pull/1' ;;
  view) echo '{"state":"OPEN","mergeCommit":null}' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    const worker = (phase: string) =>
      start(
        process.execPath,
        ["--import", "tsx", fileURLToPath(import.meta.url), "worker", root],
        {
          ...process.env,
          PATH: bin + ":" + process.env.PATH,
          BK_E2E_PHASE: phase,
          BK_E2E_MARKER: marker,
          BK_E2E_REVIEW: review,
          BK_E2E_REAL_GIT: realGit,
        },
      );
    const check = async (phase = "normal", expected = 0) => {
      const result = await worker(phase).finished;
      assert.equal(result.code, expected, result.log);
      return JSON.parse(result.log.trim().split("\n").at(-1)!);
    };
    const inspect = (query: string) => {
      const state = new State(root);
      try {
        return state.db.prepare(query).all();
      } finally {
        state.close();
      }
    };
    const currentRevision = () =>
      inspect("SELECT revision FROM sources")[0].revision;
    const killAtBarrier = async (phase: string) => {
      const child = worker(phase);
      await until(
        async () => (await readFile(marker, "utf8").catch(() => "")).length > 0,
        phase + " barrier",
      );
      stop(child.child);
      const ended = await child.finished;
      assert.equal(ended.signal, "SIGKILL", ended.log);
      await rm(marker);
    };
    await check();
    const baseline = currentRevision();
    await writeFile(
      join(upstream, "pricing.md"),
      "A submitted merchant price remains locked until the request closes.\n",
    );
    await run("git", ["add", "."], upstream);
    await run("git", ["commit", "-m", "Add source requirement"], upstream);
    const next = (await run("git", ["rev-parse", "HEAD"], upstream)).trim();
    await killAtBarrier("scan");
    assert.equal(currentRevision(), baseline);
    assert.equal(inspect("SELECT id FROM changes").length, 0);
    evidence.push({
      scenario: "SIGKILL before Git fetch during scan",
      cursor: baseline,
      queuedChanges: 0,
    });
    stop(server.child);
    await server.finished;
    const offline = await check("normal", 1);
    assert.match(JSON.stringify(offline), /connect|refused/i);
    assert.equal(currentRevision(), baseline);
    evidence.push({
      scenario: "Git TCP endpoint stopped",
      result: offline,
      cursor: baseline,
    });
    server = await daemon();
    await killAtBarrier("analysis");
    assert.equal(currentRevision(), next);
    assert.deepEqual(
      inspect("SELECT status FROM changes").map((r) => r.status),
      ["analyzing"],
    );
    assert.equal(inspect("SELECT id FROM proposals").length, 0);
    evidence.push({
      scenario: "SIGKILL during analysis",
      cursor: next,
      queuedForRecovery: 1,
      model: "deterministic fixture adapter",
    });
    await killAtBarrier("submission");
    const prepared = inspect("SELECT branch,status FROM proposals");
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].status, "prepared");
    const remoteRef = "refs/heads/" + prepared[0].branch;
    const pushed = (
      await run("git", ["--git-dir", origin, "rev-parse", remoteRef])
    ).trim();
    assert.equal(await readFile(review, "utf8"), "created\n");
    await check();
    await check();
    assert.deepEqual(
      inspect("SELECT status FROM proposals").map((r) => r.status),
      ["open"],
    );
    assert.deepEqual(
      inspect("SELECT status FROM changes").map((r) => r.status),
      ["done"],
    );
    assert.equal(await readFile(review, "utf8"), "created\n");
    assert.equal(
      (await run("git", ["--git-dir", origin, "rev-parse", remoteRef])).trim(),
      pushed,
    );
    assert.equal(
      (
        await run("git", [
          "--git-dir",
          origin,
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/bk",
        ])
      ).trim(),
      remoteRef,
    );
    evidence.push({
      scenario: "SIGKILL after actual Git push and simulated review creation",
      remoteRef,
      commit: pushed,
      reviewCreates: 1,
      finishedEvents: 1,
      reviewService: "fixture CLI",
    });
    const startTime = Date.now();
    const watchMs = Number(process.env.BK_E2E_WATCH_MS ?? 3000);
    assert.ok(Number.isSafeInteger(watchMs) && watchMs >= 3000);
    const watcher = worker("watch");
    await until(
      () => watcher.log().includes('"failed":false'),
      "first watch tick",
    );
    await writeFile(
      join(upstream, "excluded.txt"),
      "Outside the configured scope.\n",
    );
    await run("git", ["add", "."], upstream);
    await run("git", ["commit", "-m", "Change excluded source file"], upstream);
    const watchRevision = (
      await run("git", ["rev-parse", "HEAD"], upstream)
    ).trim();
    await until(
      () => currentRevision() === watchRevision,
      "watch cursor advance",
    );
    await sleep(Math.max(0, watchMs - (Date.now() - startTime)));
    watcher.child.kill("SIGTERM");
    const watched = await watcher.finished;
    assert.equal(watched.code, 0, watched.log);
    const runs = watched.log
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.ok(
      runs.length >= 2 && runs.every((r) => !r.failed && !r.status),
      watched.log,
    );
    assert.deepEqual(
      inspect("SELECT status FROM changes").map((r) => r.status),
      ["done"],
    );
    assert.equal(await readFile(review, "utf8"), "created\n");
    evidence.push({
      scenario: "Real watch loop across an excluded Git revision",
      elapsedMs: Date.now() - startTime,
      ticks: runs.length,
      cursor: watchRevision,
      reviewCreates: 1,
      finishedEvents: 1,
    });
  } finally {
    for (const child of children) {
      try {
        stop(child);
      } catch {}
    }
    await rm(temp, { force: true, recursive: true });
    const output = resolve(mode ?? ".bk/validation/e2e-recovery.json");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify({ node: process.version, evidence }, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify(evidence, null, 2));
}
