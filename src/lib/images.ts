import { invoke } from "@tauri-apps/api/core";

/**
 * Images live in note content as their own line: `![image](local:<name>)` for
 * files in the app's image store, or `![image](https://…)` for external URLs.
 */
export const IMAGE_LINE = /^!\[[^\]]*\]\((\S+)\)$/;
export const LOCAL_PREFIX = "local:";
/** Mirrors the Rust-side validation in `image_path`. */
export const IMAGE_NAME = /^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function imageRefs(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim().match(IMAGE_LINE)?.[1])
    .filter((r): r is string => !!r);
}

/** Save a pasted image to the local store; returns the markdown line for it. */
export async function saveImage(file: File): Promise<string> {
  const ext = EXT_BY_MIME[file.type];
  if (!ext) throw new Error(`Unsupported image type: ${file.type || "unknown"}`);
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Image is larger than 20 MB");
  const name = `${crypto.randomUUID()}.${ext}`;
  await invoke("save_image", new Uint8Array(await file.arrayBuffer()), {
    headers: { "x-name": name },
  });
  return `![image](${LOCAL_PREFIX}${name})`;
}

/** Object URL for a local image; caller revokes it. */
export async function localImageUrl(name: string): Promise<string> {
  const buf = await invoke<ArrayBuffer>("read_image", { name });
  return URL.createObjectURL(new Blob([buf]));
}
