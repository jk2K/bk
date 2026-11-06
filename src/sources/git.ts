import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import type { Source } from "../config/index.js";
import { hash, run } from "../util.js";
export interface Evidence {
  locator: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  oldLocator?: string;
  beforeOffset?: number;
  afterOffset?: number;
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
  related?: ChangeSet[];
  feedback?: Array<{
    ruleId: string;
    decision: string;
    statementHash: string;
    sourceId: string;
  }>;
  images?: import("./assets.js").ImageAsset[];
  derivedImages?: Array<{ hash: string; markdown: string }>;
}
const MAX_FILE = 15 * 1024 * 1024,
  CHUNK = 96_000,
  MAX_TOTAL = 2_000_000;
export const matches = (path: string, include: string[], exclude: string[]) =>
  picomatch(include, { dot: true })(path) &&
  !picomatch(exclude, { dot: true })(path);
export async function scanGitBatches(
  root: string,
  source: Extract<Source, { type: "git" }>,
  previous: string | null,
): Promise<ChangeSet[]> {
  let mirror = join(root, ".bk/git-mirrors", source.id);
  try {
    await access(mirror);
    const configured = (
      await run("git", ["--git-dir", mirror, "remote", "get-url", "origin"])
    ).trim();
    if (configured !== source.url)
      mirror += "-" + hash(source.url).slice(0, 16);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
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
      paths.set(p, { kind: rebased ? "modified" : "added" });
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
  const batches: Evidence[][] = [[]];
  let total = 0;
  function append(item: Evidence) {
    const size = item.before.length + item.after.length;
    if (
      total + size > MAX_TOTAL ||
      batches.at(-1)!.length >= 120 ||
      batches.at(-1)!.some((e) => e.locator === item.locator)
    ) {
      batches.push([]);
      total = 0;
    }
    batches.at(-1)!.push(item);
    total += size;
  }
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
    const oldPath = info.oldLocator ?? locator;
    const oldInScope = matches(oldPath, source.include, source.exclude);
    const newInScope = matches(locator, source.include, source.exclude);
    if (!oldInScope && !newInScope) continue;
    const before =
      oldInScope && info.kind !== "added"
        ? await content(previous, oldPath)
        : "";
    const after =
      newInScope && info.kind !== "deleted"
        ? await content(revision, locator)
        : "";
    if (before === after && info.kind !== "renamed") continue;
    const target = newInScope ? locator : oldPath;
    const kind =
      info.kind === "renamed" && (!oldInScope || !newInScope)
        ? newInScope
          ? "added"
          : "deleted"
        : info.kind;
    const length = Math.max(before.length, after.length);
    const beforeHash = hash(before),
      afterHash = hash(after);
    for (let offset = 0; offset < Math.max(1, length);) {
      let end = offset + CHUNK;
      if (
        [before, after].some((value) => {
          const unit = value.charCodeAt(end - 1);
          return end < value.length && unit >= 0xd800 && unit <= 0xdbff;
        })
      )
        end--;
      const b = before.slice(offset, end),
        a = after.slice(offset, end);
      const chunkOffset = offset;
      offset = end;
      if (length > CHUNK && a === b && kind !== "renamed") continue;
      append({
        locator: target,
        kind,
        ...(oldInScope && newInScope && info.oldLocator
          ? { oldLocator: info.oldLocator }
          : {}),
        before: b,
        after: a,
        beforeHash,
        afterHash,
        ...(length > CHUNK
          ? { beforeOffset: chunkOffset, afterOffset: chunkOffset }
          : {}),
      });
    }
  }
  return batches.map((evidence, batch) => ({
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
        "normalize-v2",
        batch,
      ]),
    ),
  }));
}
export async function scanGit(
  root: string,
  source: Extract<Source, { type: "git" }>,
  previous: string | null,
): Promise<ChangeSet> {
  const batches = await scanGitBatches(root, source, previous);
  if (batches.length !== 1)
    throw new Error(
      "Multi-batch Git changes must be processed by the scheduler",
    );
  return batches[0];
}
