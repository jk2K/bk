import { readFile } from "node:fs/promises";
import { run } from "../util.js";
export type ReviewCLI = "gh" | "glab" | "gt" | "tea";
export type Execute = typeof run;
export class CLIReviewProvider {
  constructor(
    readonly cli: ReviewCLI,
    readonly root: string,
    readonly execute: Execute = run,
  ) {}
  async find(branch: string): Promise<string | null> {
    const cli = this.cli;
    if (cli === "gh" || cli === "gt") {
      const result = JSON.parse(
        await this.execute(
          cli,
          ["pr", "list", "--head", branch, "--state", "all", "--json", "url"],
          this.root,
        ),
      );
      return result[0]?.url ?? null;
    }
    if (cli === "glab") {
      const result = JSON.parse(
        await this.execute(
          cli,
          [
            "mr",
            "list",
            "--source-branch",
            branch,
            "--all",
            "--output",
            "json",
          ],
          this.root,
        ),
      );
      return result[0]?.web_url ?? null;
    }
    // Older tea versions expose list records with head and url fields.
    const result = JSON.parse(
      await this.execute(
        "tea",
        [
          "pulls",
          "list",
          "--state",
          "all",
          "--fields",
          "index,head,url,state",
          "--output",
          "json",
          "--limit",
          "1000",
        ],
        this.root,
      ),
    );
    if (result.length >= 1000)
      throw new Error(
        "Gitea PR search limit exceeded; inspect existing proposals",
      );
    const row = result.find(
      (p: any) =>
        (typeof p.head === "string" ? p.head : p.head?.ref) === branch,
    );
    return row?.url ?? row?.html_url ?? null;
  }
  async create(
    branch: string,
    base: string,
    title: string,
    bodyFile: string,
  ): Promise<string> {
    const existing = await this.find(branch);
    if (existing) return existing;
    let result: string;
    if (this.cli === "gh" || this.cli === "gt")
      result = await this.execute(
        this.cli,
        [
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          base,
          "--title",
          title,
          "--body-file",
          bodyFile,
          "--draft",
        ],
        this.root,
      );
    else if (this.cli === "glab")
      result = await this.execute(
        this.cli,
        [
          "mr",
          "create",
          "--source-branch",
          branch,
          "--target-branch",
          base,
          "--title",
          `Draft: ${title}`,
          "--description",
          await readFile(bodyFile, "utf8"),
          "--yes",
        ],
        this.root,
      );
    else
      result = await this.execute(
        "tea",
        [
          "pulls",
          "create",
          "--head",
          branch,
          "--base",
          base,
          "--title",
          title,
          "--description-file",
          bodyFile,
          "--draft",
          "--output",
          "json",
        ],
        this.root,
      );
    if (this.cli === "tea") {
      try {
        const p = JSON.parse(result);
        if (p.url ?? p.html_url) return p.url ?? p.html_url;
      } catch {
        /* retrieve created PR by branch below */
      }
    }
    const url = result.match(
      /https?:\/\/[^\s]+\/(?:pull|pulls|merge_requests)\/\d+/,
    )?.[0];
    if (url) return url;
    const remote = await this.find(branch);
    if (remote) return remote;
    throw new Error(
      "PR creation returned no verifiable URL; retry will discover by branch",
    );
  }
  async status(
    remote: string,
  ): Promise<{ state: "open" | "merged" | "closed"; commit?: string }> {
    if (this.cli === "gh" || this.cli === "gt") {
      const p = JSON.parse(
        await this.execute(
          this.cli,
          ["pr", "view", remote, "--json", "state,mergeCommit"],
          this.root,
        ),
      );
      return { state: p.state.toLowerCase(), commit: p.mergeCommit?.oid };
    }
    if (this.cli === "glab") {
      const p = JSON.parse(
        await this.execute(
          this.cli,
          ["mr", "view", remote, "--output", "json"],
          this.root,
        ),
      );
      return { state: p.state, commit: p.merge_commit_sha };
    }
    const number = /\/pulls\/(\d+)$/.exec(remote)?.[1];
    if (!number) throw new Error("Invalid tea PR URL");
    const p = JSON.parse(
      await this.execute(
        "tea",
        ["pulls", number, "--output", "json"],
        this.root,
      ),
    );
    return {
      state: p.merged ? "merged" : p.state === "closed" ? "closed" : "open",
      commit: p.merge_commit_sha,
    };
  }
}
