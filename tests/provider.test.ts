import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLIReviewProvider, type ReviewCLI } from "../src/review/provider.js";
for (const cli of ["gh", "glab", "gt", "tea"] as ReviewCLI[])
  test(`${cli}: create, discover duplicate, and reconcile review states`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bk-provider-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const body = join(dir, "body.md");
    await writeFile(body, "Evidence and risk\n\n`literal` $shell");
    let created = false;
    let state = "open";
    const url =
      "https://forge.example/owner/repo/" +
      (cli === "glab" ? "merge_requests" : cli === "tea" ? "pulls" : "pull") +
      "/1";
    const calls: string[][] = [];
    const fake = async (command: string, args: string[]) => {
      assert.equal(command, cli);
      calls.push(args);
      if (args.includes("create")) {
        assert.ok(args.includes("bk/proposal"));
        assert.ok(
          args.includes(
            cli === "glab"
              ? "--description"
              : cli === "tea"
                ? "--description-file"
                : "--body-file",
          ),
        );
        created = true;
        return cli === "tea" ? JSON.stringify({ url }) : url;
      }
      if (args.includes("list"))
        return JSON.stringify(
          created
            ? [
                cli === "glab"
                  ? { web_url: url }
                  : cli === "tea"
                    ? { head: "bk/proposal", url }
                    : { url },
              ]
            : [],
        );
      return JSON.stringify(
        cli === "glab"
          ? { state, merge_commit_sha: "merged-sha" }
          : cli === "tea"
            ? {
                state,
                merged: state === "merged",
                merge_commit_sha: "merged-sha",
              }
            : {
                state: state.toUpperCase(),
                mergeCommit: { oid: "merged-sha" },
              },
      );
    };
    const provider = new CLIReviewProvider(cli, dir, fake);
    assert.equal(
      await provider.create("bk/proposal", "main", "Title", body),
      url,
    );
    assert.equal(
      await provider.create("bk/proposal", "main", "Title", body),
      url,
    );
    assert.equal(calls.filter((a) => a.includes("create")).length, 1);
    for (const s of ["open", "closed", "merged"] as const) {
      state = s;
      assert.equal((await provider.status(url)).state, s);
    }
  });
