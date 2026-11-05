import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ConfigSchema } from "../src/config/index.js";
import { scanWeb, extractPage } from "../src/sources/web.js";
import { withBrowser, type WebSource } from "../src/browser/index.js";
import {
  BrowserSession,
  replayRecipe,
  browserScope,
} from "../src/browser/session.js";
import { run } from "../src/util.js";
const executable =
  process.env.BK_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();
const available = existsSync(executable);
if (process.env.BK_REQUIRE_BROWSER_TESTS === "1" && !available)
  throw new Error("Required browser executable is missing");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5QAAAABJRU5ErkJggg==",
  "base64",
);
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "bk-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run("git", ["init", "-b", "main"], root);
  await writeFile(join(root, ".gitignore"), ".bk/\n");
  let image = Buffer.from(png),
    writes = 0;
  let linked = true;
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      writes++;
      res.end("mutated");
      return;
    }
    if (req.url === "/auth" && !req.headers.cookie?.includes("auth=ok")) {
      res.writeHead(401);
      res.end("login");
      return;
    }
    if (req.url === "/escape") {
      res.writeHead(302, { location: "http://localhost:9/offsite" });
      res.end();
      return;
    }
    if (req.url === "/image.png") {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": image.length,
      });
      res.end(image);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      `<html><head><title>Business PRD</title></head><body><main><p>Base pricing rule is immutable.</p><details><summary id="expand">Price conditions</summary><p>Withdraw the application to unlock the price.</p></details><div style="display:none">HIDDEN-SECRET</div><textarea>PRIVATE-TEXTAREA</textarea><button id="readonly" type="button" onclick="document.querySelector('#dynamic').textContent='Loaded readonly content'">Tab</button><span id="dynamic"></span><form><button id="submit" role="tab">Delete</button></form><button type="button" id="write" onclick="fetch('/mutate',{method:'POST'}).catch(()=>{document.body.dataset.blocked='yes'})">Write</button>${req.url === "/images" ? '<img src="/image.png" alt="flow">' : ""}${req.url === "/" && linked ? '<a href="/linked">Related PRD</a>' : ""}</main><script>document.querySelector('#dynamic').textContent='JS rendered pricing text';</script></body></html>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const host = "127.0.0.1:" + (server.address() as any).port;
  const make = (path = "/") => {
    const c = ConfigSchema.parse({
      version: 1,
      sources: [
        {
          id: "wiki",
          type: "web",
          role: "requirement",
          url: `http://${host}${path}`,
          data_classification: "public",
          browser: {
            profile: "wiki",
            readonly_selectors: ["#readonly", "#write", "#submit"],
          },
          crawl: { allowed_hosts: [host], max_depth: 0, max_pages: 5 },
        },
      ],
    });
    return { c, source: c.sources[0] as WebSource };
  };
  return {
    root,
    host,
    make,
    server,
    changeImage: () => {
      image = Buffer.concat([png, Buffer.from("updated")]);
    },
    writes: () => writes,
    removeLink: () => {
      linked = false;
    },
  };
}
test(
  "browser: visible JS content, normalized snapshots, unchanged hash and page limits",
  { skip: !available },
  async (t) => {
    const f = await fixture(t),
      { source } = f.make();
    const first = await scanWeb(f.root, source, null, 5);
    assert.equal(first.evidence.length, 1);
    assert.match(first.evidence[0].after, /JS rendered pricing text/);
    assert.doesNotMatch(
      first.evidence[0].after,
      /HIDDEN-SECRET|PRIVATE-TEXTAREA|Withdraw the application/,
    );
    const second = await scanWeb(f.root, source, first.toRevision, 5);
    assert.equal(second.evidence.length, 0);
    assert.equal(first.toRevision, second.toRevision);
    const deep = { ...source, crawl: { ...source.crawl, max_depth: 1 } };
    await assert.rejects(() => scanWeb(f.root, deep, null, 1), /Page budget/);
  },
);
test(
  "browser: readonly controls, verified recipe replay, form blocking and network write interception",
  { skip: !available },
  async (t) => {
    const f = await fixture(t),
      { source } = f.make();
    await withBrowser(f.root, source, async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(source.url);
      const session = new BrowserSession(page, source);
      const initial = await session.snapshot();
      assert.doesNotMatch(
        initial.text,
        /HIDDEN-SECRET|PRIVATE-TEXTAREA|Withdraw/,
      );
      await assert.rejects(() =>
        session.perform({ action: "click", selector: "#unknown" }),
      );
      await assert.rejects(
        () => session.perform({ action: "click", selector: "#submit" }),
        /Only native/,
      );
      await session.perform({ action: "click", selector: "#expand" });
      await session.perform({ action: "click", selector: "#readonly" });
      const expanded = (await extractPage(page)).markdown;
      assert.match(expanded, /Withdraw the application/);
      assert.match(expanded, /Loaded readonly content/);
      const tools = session.tools(),
        client = new Client({ name: "browser-test", version: "1.0" }),
        [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
      await tools.server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const screenshot = await client.callTool({
          name: "browser_screenshot",
          arguments: {},
        });
        assert.notEqual(screenshot.isError, true);
        const item = (screenshot.content as any[])[0];
        assert.equal(item.type, "image");
        assert.equal(item.mimeType, "image/png");
        assert.ok(Buffer.from(item.data, "base64").length > 8);
      } finally {
        await client.close();
        await tools.server.instance.close();
      }
      const recipe = session.recipe();
      await page.goto(source.url);
      await replayRecipe(page, source, recipe);
      assert.equal((await extractPage(page)).markdown, expanded);
      await assert.rejects(
        () =>
          replayRecipe(
            page,
            {
              ...source,
              browser: { ...source.browser, readonly_selectors: [] },
            },
            recipe,
          ),
        /scope/,
      );
      await page.locator("#write").click();
      await page.waitForFunction(() => document.body.dataset.blocked === "yes");
      assert.equal(f.writes(), 0);
    });
  },
);
test(
  "browser: profile cookies persist and expired authentication never becomes unchanged",
  { skip: !available },
  async (t) => {
    const f = await fixture(t),
      { source } = f.make("/auth");
    await assert.rejects(
      () => scanWeb(f.root, source, null, 5),
      /AUTH_REQUIRED/,
    );
    await withBrowser(f.root, source, async (ctx) => {
      await ctx.addCookies([
        {
          name: "auth",
          value: "ok",
          url: source.url,
          expires: Math.floor(Date.now() / 1000) + 86400,
        },
      ]);
    });
    assert.equal((await scanWeb(f.root, source, null, 5)).evidence.length, 1);
  },
);
test(
  "browser: off-host redirect is blocked before destination navigation",
  { skip: !available },
  async (t) => {
    const f = await fixture(t),
      { source } = f.make("/escape");
    await assert.rejects(() => scanWeb(f.root, source, null, 5));
  },
);
test(
  "browser: image bytes changing at the same URL trigger a new immutable source revision",
  { skip: !available },
  async (t) => {
    const f = await fixture(t),
      { source, c } = f.make("/images");
    c.compiler.image.enabled = true;
    const first = await scanWeb(f.root, source, null, 5, { config: c });
    assert.equal(first.images?.length, 1);
    assert.match(first.evidence[0].after, /IMAGE SHA256 [a-f0-9]{64}/);
    f.changeImage();
    const second = await scanWeb(f.root, source, first.toRevision, 5, {
      config: c,
    });
    assert.notEqual(first.toRevision, second.toRevision);
    assert.notEqual(first.images![0].hash, second.images![0].hash);
  },
);
test(
  "browser: sync exploration drafts a replay-verified recipe while scan-only never calls a model",
  { skip: !available },
  async (t) => {
    const f = await fixture(t),
      { source, c } = f.make();
    source.browser.interactive = true;
    c.agent.allow_interactive_browser = true;
    let calls = 0;
    const agent = {
      analyze: async () => ({ assessment: { actions: [] }, usage: {} }),
      explorePage: async (page: any) => {
        calls++;
        const session = new BrowserSession(page, source);
        await session.perform({ action: "click", selector: "#expand" });
        return { recipe: session.recipe(), usage: {} };
      },
    };
    await assert.rejects(
      () => scanWeb(f.root, source, null, 5, { config: c }),
      /INTERACTIVE_REQUIRED/,
    );
    assert.equal(calls, 0);
    const enhanced = await scanWeb(f.root, source, null, 5, {
      config: c,
      agent,
    });
    assert.equal(calls, 1);
    assert.match(enhanced.evidence[0].after, /Withdraw/);
  },
);
test(
  "browser: disappearing navigation link retains earlier page snapshots",
  { skip: !available },
  async (t) => {
    const f = await fixture(t),
      { source } = f.make();
    source.crawl.max_depth = 1;
    const first = await scanWeb(f.root, source, null, 5);
    assert.equal(first.evidence.length, 2);
    f.removeLink();
    const second = await scanWeb(f.root, source, first.toRevision, 5);
    const persisted = JSON.parse(
      await readFile(
        join(f.root, ".bk/snapshots", source.id, second.toRevision + ".json"),
        "utf8",
      ),
    );
    assert.ok(persisted[`http://${f.host}/linked`]);
  },
);
