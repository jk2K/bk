import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../src/util.js";

const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "bk-release-"));
try {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  await run("npm", ["pack", "--pack-destination", directory], root);
  const archives = (await readdir(directory)).filter((f) => f.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const archive = join(directory, archives[0]);
  const entries = (await run("tar", ["-tzf", archive]))
    .split("\n")
    .filter(Boolean);
  assert.ok(entries.includes("package/" + manifest.bin.bk));
  assert.ok(
    !entries.some((p) => /\/(?:\.bk|node_modules|tests|evaluation)\//.test(p)),
  );
  await run("tar", ["-xzf", archive, "-C", directory]);
  const pkg = join(directory, "package"),
    entry = join(pkg, manifest.bin.bk);
  await symlink(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
  assert.equal(
    (await run(process.execPath, [entry, "--version"], directory)).trim(),
    manifest.version,
  );
  await run(
    process.execPath,
    [entry, "init", join(directory, "fixture")],
    directory,
  );
  assert.match(
    await readFile(join(directory, "fixture", "bk.yaml"), "utf8"),
    /version: 1/,
  );
  console.log(
    JSON.stringify({
      package: manifest.name,
      version: manifest.version,
      license: manifest.license,
      archive: archives[0],
      files: entries.length,
      packagedCliSmoke: "passed",
      dependencyResolution: "existing locked development dependencies",
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
