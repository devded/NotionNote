import { notionInvoke, notionRequest, richTextToPlain, plainToRichText } from "./client";
import {
  LOCAL_PREFIX,
  imageLine,
  imageRefs,
  parseImageLine,
  stripImages,
  type ImageInfo,
} from "@/lib/images";
import type { Note } from "@/types/note";

function pageToNote(page: any): Note {
  const props = page.properties ?? {};
  const created =
    props["Created At"]?.date?.start ?? page.created_time ?? new Date().toISOString();
  // page.last_edited_time is Notion's true system timestamp of the most recent change.
  const updated =
    page.last_edited_time ?? props["Updated At"]?.date?.start ?? created;
  const title =
    richTextToPlain(props.Title?.title) ||
    richTextToPlain(props.title?.title) ||
    richTextToPlain(props.Name?.title) ||
    "";
  return {
    id: page.id,
    title,
    // Property holds only a truncated preview; authoritative content lives in
    // the page body blocks and replaces this whenever it is re-read.
    content: richTextToPlain(props.Content?.rich_text),
    created_at: created,
    updated_at: updated,
    sync_status: "synced",
    notion_page_id: page.id,
    last_synced_at: page.last_edited_time ?? new Date().toISOString(),
  };
}

/**
 * The Content property is a display/search preview only. Notion caps rich_text
 * values (~2000 chars/item, limited items per property), so keep well under.
 */
const CONTENT_PREVIEW_LIMIT = 1500;

function noteProperties(note: {
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}) {
  // Image lines are noise in Notion's table view; the body holds them.
  const preview = stripImages(note.content).slice(0, CONTENT_PREVIEW_LIMIT);
  return {
    Title: { title: [{ type: "text", text: { content: note.title || "Untitled" } }] },
    Content: { rich_text: preview ? plainToRichText(preview) : [] },
    "Created At": { date: note.created_at ? { start: note.created_at } : null },
    "Updated At": { date: note.updated_at ? { start: note.updated_at } : null },
  };
}

/** Fetch all non-trashed notes from the data source. */
export async function fetchNotes(
  dataSourceId: string,
  /** pageId -> last synced ISO time; pages edited after it get their body re-read. */
  knownSynced?: Map<string, string | null>,
): Promise<Note[]> {
  const notes: Note[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest("POST", `/data_sources/${dataSourceId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of res?.results ?? []) {
      if (page.archived || page.in_trash) continue;
      const note = pageToNote(page);
      const syncedAt = knownSynced?.get(page.id);
      const pageEditedTime = page.last_edited_time
        ? new Date(page.last_edited_time).getTime()
        : 0;
      const syncedTime = syncedAt ? new Date(syncedAt).getTime() : 0;
      const editedExternally = !syncedAt || pageEditedTime > syncedTime;

      if (editedExternally) {
        try {
          const body = await fetchPageContent(page.id);
          if (body && body.trim().length > 0) {
            note.content = body;
          }
        } catch (e) {
          console.debug("[notion] failed to read page body, using property fallback", e);
        }
      }
      notes.push(note);
    }
    cursor = res?.has_more ? res?.next_cursor ?? undefined : undefined;
  } while (cursor);
  return notes;
}

/**
 * Images we upload carry `<local name>|<width>` as their Notion caption (both
 * parts optional) so they round-trip to the same text line. The name format
 * mirrors the Rust-side validation in `image_path`.
 */
const CAPTION = /^([A-Za-z0-9-]+\.(?:png|jpg|gif|webp))?(?:\|(\d+))?$/;

function parseCaption(b: any): { name?: string; width?: number } {
  const m = richTextToPlain(b.image?.caption).match(CAPTION);
  return { name: m?.[1], width: m?.[2] ? Number(m[2]) : undefined };
}

/** Local image name; images added in Notion get one derived from the block id. */
function notionImageName(b: any): string {
  const name = parseCaption(b).name;
  if (name) return name;
  const ext = (b.image?.file?.url ?? "").split("?")[0].match(/\.(png|jpg|gif|webp)$/i)?.[1];
  return `${b.id}.${ext?.toLowerCase() ?? "png"}`;
}

function imageBlockLine(b: any): string | null {
  const { width } = parseCaption(b);
  if (b.image?.type === "external") {
    return b.image.external?.url ? imageLine(b.image.external.url, width) : null;
  }
  return b.image?.file?.url ? imageLine(LOCAL_PREFIX + notionImageName(b), width) : null;
}

/** Pull Notion-hosted images we don't have yet into the local store. */
async function downloadImages(blocks: any[]): Promise<void> {
  for (const b of blocks) {
    if (b.type !== "image" || b.image?.type !== "file" || !b.image.file?.url) continue;
    try {
      await notionInvoke("download_image", { name: notionImageName(b), url: b.image.file.url });
    } catch (e) {
      console.debug("[notion] failed to download image", b.id, e);
    }
  }
}

/** Upload every local image referenced in content; name -> file_upload id. */
async function uploadImages(content: string): Promise<Map<string, string>> {
  const uploads = new Map<string, string>();
  // ponytail: every body rewrite re-uploads all of the note's images (blocks
  // are replaced wholesale); diff blocks in place if notes get image-heavy.
  for (const ref of imageRefs(content)) {
    const name = ref.slice(LOCAL_PREFIX.length);
    if (!ref.startsWith(LOCAL_PREFIX) || uploads.has(name)) continue;
    uploads.set(name, await notionInvoke<string>("notion_upload_image", { name }));
  }
  return uploads;
}

export function blocksToText(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.archived || b.in_trash || !b.type) continue;
    const rt: any[] = b[b.type]?.rich_text ?? [];
    const text = rt
      .map((r) => r.plain_text ?? r.text?.content ?? "")
      .join("");
    switch (b.type) {
      case "image": {
        const line = imageBlockLine(b);
        if (line) lines.push(line);
        break;
      }
      case "heading_1":
        lines.push(`# ${text}`);
        break;
      case "heading_2":
        lines.push(`## ${text}`);
        break;
      case "heading_3":
        lines.push(`### ${text}`);
        break;
      case "bulleted_list_item":
        lines.push(`- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${text}`);
        break;
      case "quote":
        lines.push(`> ${text}`);
        break;
      default:
        lines.push(text);
    }
  }
  return lines.join("\n");
}

async function fetchPageContent(pageId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest(
      "GET",
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    await downloadImages(res?.results ?? []);
    const chunk = blocksToText(res?.results ?? []);
    if (chunk.length > 0) {
      lines.push(chunk);
    }
    cursor = res?.has_more ? res?.next_cursor ?? undefined : undefined;
  } while (cursor);
  return lines.join("\n");
}

/**
 * Convert plain-text/markdown-lite content into Notion blocks.
 * Supported: # ## ### headings, - bullets, 1. numbered items, > quotes,
 * `![](…)` image lines, everything else becomes a paragraph. Blank lines are
 * dropped. Local images need their file_upload id in `uploads`.
 */
export function contentToBlocks(content: string, uploads?: Map<string, string>): any[] {
  const blocks: any[] = [];
  const mk = (type: string, text: string) => ({
    object: "block",
    type,
    [type]: { rich_text: [{ type: "text", text: { content: text } }] },
  });
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const image = imageBlock(parseImageLine(line), uploads);
    if (image) blocks.push(image);
    else if (line.startsWith("### ")) blocks.push(mk("heading_3", line.slice(4)));
    else if (line.startsWith("## ")) blocks.push(mk("heading_2", line.slice(3)));
    else if (line.startsWith("# ")) blocks.push(mk("heading_1", line.slice(2)));
    else if (line.startsWith("- ")) blocks.push(mk("bulleted_list_item", line.slice(2)));
    else if (/^\d+\.\s/.test(line)) blocks.push(mk("numbered_list_item", line.replace(/^\d+\.\s/, "")));
    else if (line.startsWith("> ")) blocks.push(mk("quote", line.slice(2)));
    else blocks.push(mk("paragraph", line));
  }
  return blocks;
}

function imageBlock(image: ImageInfo | null, uploads?: Map<string, string>): any {
  if (!image) return null;
  const { ref, width } = image;
  const caption = (text: string) => (text ? [{ type: "text", text: { content: text } }] : []);
  const suffix = width ? `|${width}` : "";
  if (/^https?:\/\//.test(ref)) {
    return {
      object: "block",
      type: "image",
      image: { type: "external", external: { url: ref }, caption: caption(suffix) },
    };
  }
  const name = ref.slice(LOCAL_PREFIX.length);
  const id = ref.startsWith(LOCAL_PREFIX) ? uploads?.get(name) : undefined;
  if (!id) return null;
  return {
    object: "block",
    type: "image",
    image: { type: "file_upload", file_upload: { id }, caption: caption(name + suffix) },
  };
}

/**
 * Normalize text exactly the way contentToBlocks does (trailing whitespace
 * trimmed, blank lines dropped) so remote page bodies can be compared with
 * local content to detect "nothing changed" cheaply.
 */
export function normalizeForCompare(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .join("\n");
}

/** Number of block deletions sent concurrently (Notion averages ~3 req/s). */
const DELETE_CONCURRENCY = 3;

async function syncPageBlocks(pageId: string, content: string) {
  // 1. Fetch old blocks: their ids (for deletion) and text (for diffing).
  const old: { id: string; line: string }[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest(
      "GET",
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    for (const b of res?.results ?? []) {
      if (!b.archived && !b.in_trash) {
        old.push({ id: b.id, line: blocksToText([b]).replace(/\s+$/, "") });
      }
    }
    cursor = res?.has_more ? res?.next_cursor ?? undefined : undefined;
  } while (cursor);

  // 2. Keep the longest unchanged prefix of blocks. Typing usually happens
  //    near the end, so this turns "rewrite every block" into a handful of
  //    requests, and images above the edit are never re-uploaded. Blank
  //    Notion blocks have no local counterpart and are skipped over.
  // ponytail: prefix only; an edit near the top still rewrites everything
  // below it. Add suffix matching via Notion's `position` insert if needed.
  const lines = normalizeForCompare(content).split("\n").filter(Boolean);
  let o = 0;
  let n = 0;
  while (o < old.length) {
    if (!old[o].line.trim()) o++;
    else if (n < lines.length && old[o].line === lines[n]) {
      o++;
      n++;
    } else break;
  }
  if (o === old.length && n === lines.length) return;

  // 3. Append the new tail FIRST so the page is never missing content.
  const tail = lines.slice(n).join("\n");
  const blocks = contentToBlocks(tail, await uploadImages(tail));
  for (let i = 0; i < blocks.length; i += 100) {
    await notionRequest("PATCH", `/blocks/${pageId}/children`, {
      children: blocks.slice(i, i + 100),
    });
  }
  const oldBlockIds = old.slice(o).map((b) => b.id);

  // 4. Delete old blocks in small concurrent batches.
  let failedDeletes = 0;
  for (let i = 0; i < oldBlockIds.length; i += DELETE_CONCURRENCY) {
    const batch = oldBlockIds.slice(i, i + DELETE_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((id) => notionRequest("DELETE", `/blocks/${id}`)),
    );
    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === "fulfilled") continue;
      failedDeletes++;
      // 404 just means the block was already gone — not a real failure.
      const err: any = (settled[j] as PromiseRejectedResult).reason;
      if (err?.code !== "http_404" && err?.code !== "not_found") {
        console.debug("[notion] failed to delete old block:", batch[j], err?.message ?? err);
      } else {
        failedDeletes--;
      }
    }
  }
  if (failedDeletes > 0) {
    // Surface the duplication risk instead of silently leaving duplicates.
    throw new Error(`${failedDeletes} old block(s) could not be deleted; will retry`);
  }
}

/** Create a Notion page (properties + body blocks) for a local note. */
export async function pushCreateNote(
  dataSourceId: string,
  note: Note,
): Promise<{ pageId: string; lastEditedTime: string }> {
  // Upload first: a failed upload must not leave a half-created page behind.
  const uploads = await uploadImages(note.content);
  const page = await notionRequest<any>("POST", "/pages", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: noteProperties(note),
  });
  const blocks = contentToBlocks(note.content, uploads);
  if (blocks.length > 0) {
    for (let i = 0; i < blocks.length; i += 100) {
      await notionRequest("PATCH", `/blocks/${page.id}/children`, {
        children: blocks.slice(i, i + 100),
      });
    }
  }
  return {
    pageId: page.id,
    lastEditedTime: page.last_edited_time ?? new Date().toISOString(),
  };
}

/** Update an existing Notion page (properties + rewritten body). */
export async function pushUpdateNote(
  note: Note,
): Promise<{ lastEditedTime: string }> {
  // Atomic page property update ensures Title, Content, and Updated At are saved immediately
  const page = await notionRequest<any>("PATCH", `/pages/${note.notion_page_id}`, {
    properties: noteProperties(note),
  });
  if (note.notion_page_id) {
    // Deliberately NOT swallowed: if block sync fails, the local note must
    // stay unsynced so the merge engine retries it instead of silently
    // leaving duplicated/stale blocks behind forever.
    await syncPageBlocks(note.notion_page_id, note.content);
  }
  return {
    lastEditedTime: page?.last_edited_time ?? new Date().toISOString(),
  };
}

/** Archive (soft delete) a Notion page. */
export async function pushDeleteNote(pageId: string): Promise<void> {
  await notionRequest("PATCH", `/pages/${pageId}`, { archived: true });
}
