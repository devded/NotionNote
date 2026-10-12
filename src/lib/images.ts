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

/**
 * Fallback for platforms whose webview hides clipboard images from paste
 * events (WebKitGTK on Linux). Returns null when the clipboard has no image.
 */
export async function pasteClipboardImage(): Promise<string | null> {
  const name = `${crypto.randomUUID()}.png`;
  const found = await invoke<boolean>("paste_clipboard_image", { name });
  return found ? `![image](${LOCAL_PREFIX}${name})` : null;
}

/** Object URL for a local image; caller revokes it. */
export async function localImageUrl(name: string): Promise<string> {
  const buf = await invoke<ArrayBuffer>("read_image", { name });
  return URL.createObjectURL(new Blob([buf]));
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "image"; line: string; ref: string };

/**
 * Split content into alternating text/image segments for inline display.
 * Always starts and ends with text so there is somewhere to type around
 * every image. `fromSegments(toSegments(x))` is stable after one pass.
 */
export function toSegments(content: string): Segment[] {
  const segs: Segment[] = [];
  let buf: string[] = [];
  for (const line of content.split("\n")) {
    const ref = line.trim().match(IMAGE_LINE)?.[1];
    if (!ref) {
      buf.push(line);
      continue;
    }
    segs.push({ kind: "text", text: buf.join("\n") }, { kind: "image", line: line.trim(), ref });
    buf = [];
  }
  segs.push({ kind: "text", text: buf.join("\n") });
  return segs;
}

export function fromSegments(segs: Segment[]): string {
  return segs.map((s) => (s.kind === "text" ? s.text : `\n${s.line}\n`)).join("");
}
