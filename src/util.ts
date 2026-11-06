import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  rename,
  open,
  unlink,
  readFile,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
const execute = promisify(execFile);
export async function run(command: string, args: string[], cwd?: string) {
  const { stdout } = await execute(command, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    },
  });
  return stdout;
}
export const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex");
export async function atomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}
export function safePath(root: string, path: string) {
  const target = resolve(root, path),
    rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Unsafe path: ${path}`);
  return target;
}
export const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
export async function lock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = await open(path, "wx", 0o600);
      await fd.writeFile(String(process.pid));
      await fd.close();
      return async () => {
        await unlink(path).catch(() => {});
      };
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error(`Invalid lock: ${path}; inspect it manually`);
      try {
        process.kill(pid, 0);
        throw new Error(`Already running (PID ${pid})`);
      } catch (err: any) {
        if (err.code !== "ESRCH") throw err;
      }
      await unlink(path).catch(() => {});
    }
  }
  throw new Error(`Could not acquire ${path}`);
}
export function redact(s: string) {
  return s
    .replace(/(Bearer\s+)[\w.\-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:password|token|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}
export async function safeOutput(root: string, path: string) {
  const target = safePath(root, path);
  const { lstat } = await import("node:fs/promises");
  let cursor = resolve(root);
  for (const part of relative(root, target).split("/")) {
    cursor = resolve(cursor, part);
    const stat = await lstat(cursor).catch((e: any) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (stat?.isSymbolicLink())
      throw new Error(`Output symlink forbidden: ${path}`);
  }
  return target;
}
