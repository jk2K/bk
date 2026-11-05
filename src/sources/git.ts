import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import type { Source } from "../config/index.js";
import { hash, run } from "../util.js";
export interface Evidence {
  locator: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  oldLocator?: string;
  before: string;
  after: string;
  beforeHash: string;
  afterHash: string;
}
export interface ChangeSet {
  id: string;
  source: Source;
  fromRevision: string | null;
  toRevision: string;
  evidence: Evidence[];
  rebased: boolean;
  createdAt: string;
  images?: import("./assets.js").ImageAsset[];
  derivedImages?: Array<{ hash: string; markdown: string }>;
}
const MAX_FILE = 512_000,
  MAX_TOTAL = 2_000_000;
export const matches = (path: string, include: string[], exclude: string[]) =>
  picomatch(include, { dot: true })(path) &&
  !picomatch(exclude, { dot: true })(path);
export async function scanGit(
  root: string,
  source: Extract<Source, { type: "git" }>,
  previous: string | null,
): Promise<ChangeSet> {
  const mirror = join(root, ".bk/git-mirrors", source.id);
  await mkdir(join(root, ".bk/git-mirrors"), { recursive: true, mode: 0o700 });
  try {
    await access(mirror);
  } catch {
    await run("git", ["clone", "--mirror", "--", source.url, mirror]);
  }
  await run("git", ["--git-dir", mirror, "fetch", "--prune", "origin"]);
  const git = (args: string[]) => run("git", ["--git-dir", mirror, ...args]);
  const revision = (
    await git(["rev-parse", `refs/heads/${source.branch}^{commit}`])
  ).trim();
  const base = {
    source,
    fromRevision: previous,
    toRevision: revision,
    createdAt: new Date().toISOString(),
  };
  let rebased = false;
  if (previous) {
    try {
      await git(["merge-base", "--is-ancestor", previous, revision]);
    } catch {
      rebased = true;
    }
  }
  const paths = new Map<
    string,
    { kind: Evidence["kind"]; oldLocator?: string }
  >();
  if (!previous || rebased) {
    for (const p of (
      await git(["ls-tree", "-r", "--name-only", "-z", revision])
    )
      .split("\0")
      .filter(Boolean))
      paths.set(p, { kind: "added" });
    if (rebased && previous) {
      for (const p of (
        await git(["ls-tree", "-r", "--name-only", "-z", previous])
      )
        .split("\0")
        .filter(Boolean))
        if (!paths.has(p)) paths.set(p, { kind: "deleted" });
    }
  } else if (previous !== revision) {
    const entries = (
      await git([
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        previous,
        revision,
        "--",
      ])
    ).split("\0");
    for (let i = 0; i < entries.length - 1;) {
      const status = entries[i++],
        p = entries[i++];
      if (status.startsWith("R"))
        paths.set(entries[i++], { kind: "renamed", oldLocator: p });
      else
        paths.set(p, {
          kind:
            status === "A" ? "added" : status === "D" ? "deleted" : "modified",
        });
    }
  }
  const evidence: Evidence[] = [];
  let total = 0;
  async function content(rev: string | null, path: string) {
    if (!rev) return "";
    const meta = (await git(["ls-tree", rev, "--", path])).trim();
    if (!meta) return "";
    if (!meta.startsWith("100644 ") && !meta.startsWith("100755 "))
      throw new Error(`Unsupported source object: ${path}`);
    const size = +(await git(["cat-file", "-s", `${rev}:${path}`])).trim();
    if (size > MAX_FILE) throw new Error(`File budget exceeded: ${path}`);
    const s = await git(["show", `${rev}:${path}`]);
    if (s.includes("\0"))
      throw new Error(`Binary source requires manual conversion: ${path}`);
    return s;
  }
  for (const [locator, info] of paths) {
    if (
      !matches(locator, source.include, source.exclude) &&
      !(
        info.oldLocator &&
        matches(info.oldLocator, source.include, source.exclude)
      )
    )
      continue;
    const before = await content(previous, info.oldLocator ?? locator),
      after = info.kind === "deleted" ? "" : await content(revision, locator);
    total += before.length + after.length;
    if (total > MAX_TOTAL)
      throw new Error("ChangeSet budget exceeded; narrow source.include");
    if (before === after && info.kind !== "renamed") continue;
    evidence.push({
      ...info,
      locator,
      before,
      after,
      beforeHash: hash(before),
      afterHash: hash(after),
    });
  }
  return {
    ...base,
    evidence,
    rebased,
    id: hash(
      JSON.stringify([
        source.id,
        source.url,
        source.branch,
        source.include,
        source.exclude,
        previous,
        revision,
        "normalize-v1",
      ]),
    ),
  };
}
