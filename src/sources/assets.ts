import type { APIRequestContext } from "playwright";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { allowed, type WebSource } from "../browser/index.js";
export interface ImageAsset {
  url: string;
  hash: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
}
export async function collectImage(
  root: string,
  request: APIRequestContext,
  source: WebSource,
  url: string,
  maxBytes: number,
): Promise<ImageAsset> {
  let current = new URL(url).href;
  for (let i = 0; i < 4; i++) {
    allowed(current, source);
    const response = await request.get(current, {
      maxRedirects: 0,
      timeout: source.crawl.timeout_ms,
    });
    try {
      const headers = response.headers();
      if (response.status() >= 300 && response.status() < 400) {
        if (!headers.location)
          throw new Error("Image redirect missing location");
        current = new URL(headers.location, current).href;
        continue;
      }
      if (!response.ok()) throw new Error(`Image HTTP ${response.status()}`);
      const mime = headers["content-type"]?.split(";")[0];
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
        throw new Error("Unsupported image type");
      if (Number(headers["content-length"] ?? 0) > maxBytes)
        throw new Error("Image byte budget exceeded");
      const data = await response.body();
      if (data.length > maxBytes) throw new Error("Image byte budget exceeded");
      const signature = data.subarray(0, 12);
      if (
        (mime === "image/png" &&
          !signature
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (mime === "image/jpeg" &&
          !(signature[0] === 255 && signature[1] === 216)) ||
        (mime === "image/webp" &&
          !(
            signature.toString("ascii", 0, 4) === "RIFF" &&
            signature.toString("ascii", 8, 12) === "WEBP"
          ))
      )
        throw new Error("Image signature mismatch");
      const hash = createHash("sha256").update(data).digest("hex"),
        directory = join(root, ".bk/assets");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, hash),
        temp = path + `.${process.pid}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, path);
      return {
        url: new URL(url).href,
        hash,
        mime: mime as ImageAsset["mime"],
        bytes: data.length,
      };
    } finally {
      await response.dispose();
    }
  }
  throw new Error("Image redirect limit exceeded");
}
export async function readImage(
  root: string,
  image: ImageAsset,
  maxBytes: number,
) {
  if (!/^[a-f0-9]{64}$/.test(image.hash)) throw new Error("Invalid image hash");
  const data = await readFile(join(root, ".bk/assets", image.hash));
  if (
    data.length > maxBytes ||
    createHash("sha256").update(data).digest("hex") !== image.hash
  )
    throw new Error("Cached image corrupt or over budget");
  return data.toString("base64");
}
