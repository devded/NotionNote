import { invoke } from "@tauri-apps/api/core";

/**
 * Images live in note content as their own line: `![image](local:<name>)` for
 * files in the app's image store, or `![image](https://…)` for external URLs.
 * An optional display width uses Obsidian's syntax: `![image|400](…)`.
 */
const IMAGE_LINE = /^!\[([^\]]*)\]\((\S+)\)$/;
export const LOCAL_PREFIX = "local:";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ImageInfo {
  ref: string;
  width?: number;
}

export function parseImageLine(line: string): ImageInfo | null {
  const m = line.trim().match(IMAGE_LINE);
  if (!m) return null;
  const width = Number(m[1].match(/\|(\d+)$/)?.[1]);
  return width > 0 ? { ref: m[2], width } : { ref: m[2] };
}

export function imageLine(ref: string, width?: number): string {
  return `![image${width ? `|${width}` : ""}](${ref})`;
}

/** Content without its image lines, for search and text previews. */
export function stripImages(content: string): string {
  return content
    .split("\n")
    .filter((l) => !parseImageLine(l))
    .join("\n");
}

export function imageRefs(content: string): string[] {
  return content
    .split("\n")
    .map((l) => parseImageLine(l)?.ref)
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
  return imageLine(LOCAL_PREFIX + name);
}

/**
 * Fallback for platforms whose webview hides clipboard images from paste
 * events (WebKitGTK on Linux). Returns null when the clipboard has no image.
 */
export async function pasteClipboardImage(): Promise<string | null> {
  const name = `${crypto.randomUUID()}.png`;
  const found = await invoke<boolean>("paste_clipboard_image", { name });
  return found ? imageLine(LOCAL_PREFIX + name) : null;
}

/** Object URL for a local image; caller revokes it. */
export async function localImageUrl(name: string): Promise<string> {
  const buf = await invoke<ArrayBuffer>("read_image", { name });
  return URL.createObjectURL(new Blob([buf]));
}

export type Segment =
  | { kind: "text"; text: string }
  | ({ kind: "image"; line: string } & ImageInfo);

/**
 * Split content into alternating text/image segments for inline display.
 * Always starts and ends with text so there is somewhere to type around
 * every image. `fromSegments(toSegments(x))` is stable after one pass.
 */
export function toSegments(content: string): Segment[] {
  const segs: Segment[] = [];
  let buf: string[] = [];
  for (const line of content.split("\n")) {
    const image = parseImageLine(line);
    if (!image) {
      buf.push(line);
      continue;
    }
    segs.push({ kind: "text", text: buf.join("\n") }, { kind: "image", line: line.trim(), ...image });
    buf = [];
  }
  segs.push({ kind: "text", text: buf.join("\n") });
  return segs;
}

export function fromSegments(segs: Segment[]): string {
  return segs.map((s) => (s.kind === "text" ? s.text : `\n${s.line}\n`)).join("");
}
