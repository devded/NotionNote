import { notionInvoke, notionRequest, richTextToPlain, plainToRichText } from "./client";
import {
  LOCAL_PREFIX,
  imageLine,
  imageRefs,
  parseImageLine,
  stripImages,
  type ImageInfo,
} from "@/lib/images";
import type { Note, RemoteNote } from "@/types/note";

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

/**
 * Notion rounds last_edited_time down to the minute, so an edit made in the
 * same minute as a sync leaves it unchanged. Bodies are re-read until the
 * page's minute (plus clock-skew margin) is safely older than the last sync.
 */
const NOTION_TIME_SLOP_MS = 2 * 60_000;

/** Fetch all non-trashed notes from the data source. */
export async function fetchNotes(
  dataSourceId: string,
  /** pageId -> local time its body was last pushed or read; see NOTION_TIME_SLOP_MS. */
  knownSynced?: Map<string, string | null>,
): Promise<RemoteNote[]> {
  const notes: RemoteNote[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest("POST", `/data_sources/${dataSourceId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of res?.results ?? []) {
      if (page.archived || page.in_trash) continue;
      const note: RemoteNote = pageToNote(page);
      const syncedAt = knownSynced?.get(page.id);
      const pageEditedTime = page.last_edited_time
        ? new Date(page.last_edited_time).getTime()
        : 0;
      const syncedTime = syncedAt ? new Date(syncedAt).getTime() : 0;
      const maybeEdited = !syncedAt || pageEditedTime > syncedTime - NOTION_TIME_SLOP_MS;

      // `content: undefined` keeps the local body: the Content property is
      // only a truncated, image-less preview.
      const keepLocal = () => {
        note.content = undefined;
        note.last_synced_at = syncedAt!;
      };
      if (!maybeEdited) {
        keepLocal();
      } else {
        try {
          const body = await fetchPageContent(page.id);
          if (body.trim()) note.content = body;
          note.last_synced_at = new Date().toISOString();
        } catch (e) {
          console.debug("[notion] failed to read page body", e);
          // Known page: retry next pass. New page: the preview beats nothing.
          if (syncedAt) keepLocal();
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
    if (b.children) await downloadImages(b.children);
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
  for (const ref of imageRefs(content)) {
    const name = ref.slice(LOCAL_PREFIX.length);
    if (!ref.startsWith(LOCAL_PREFIX) || uploads.has(name)) continue;
    uploads.set(name, await notionInvoke<string>("notion_upload_image", { name }));
  }
  return uploads;
}

/** Children of a block: fetched ones (`b.children`) or ones we built for a push. */
const childrenOf = (b: any): any[] => b.children ?? b[b.type]?.children ?? [];

export function blocksToText(blocks: any[], depth = 0): string {
  const lines: string[] = [];
  const pad = "  ".repeat(Math.min(depth, MAX_DEPTH));
  for (const b of blocks) {
    if (b.archived || b.in_trash || !b.type) continue;
    const before = lines.length;
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
      case "to_do":
        lines.push(`- [${b.to_do?.checked ? "x" : " "}] ${text}`);
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
    if (pad && lines.length > before) lines[lines.length - 1] = pad + lines[lines.length - 1];
    const kids = childrenOf(b);
    if (kids.length) lines.push(blocksToText(kids, depth + 1));
  }
  return lines.filter(Boolean).join("\n");
}

/** All live top-level blocks of a page. */
async function listChildren(pageId: string, depth = 0): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest(
      "GET",
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    for (const b of res?.results ?? []) {
      if (!b.archived && !b.in_trash) blocks.push(b);
    }
    cursor = res?.has_more ? res?.next_cursor ?? undefined : undefined;
  } while (cursor);
  // Child pages/databases also report has_children; only list items nest.
  if (depth < MAX_DEPTH) {
    for (const b of blocks) {
      if (b.has_children && CAN_NEST.has(b.type)) b.children = await listChildren(b.id, depth + 1);
    }
  }
  return blocks;
}

/** Append blocks in chunks of 100 (Notion's per-request limit). */
async function appendBlocks(pageId: string, blocks: any[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += 100) {
    await notionRequest("PATCH", `/blocks/${pageId}/children`, {
      children: blocks.slice(i, i + 100),
    });
  }
}

async function fetchPageContent(pageId: string): Promise<string> {
  const blocks = await listChildren(pageId);
  await downloadImages(blocks);
  return blocksToText(blocks);
}

/**
 * Convert plain-text/markdown-lite content into Notion blocks.
 * Supported: # ## ### headings, - [ ] / - [x] tasks, - bullets, 1. numbered items, > quotes,
 * `![](…)` image lines, everything else becomes a paragraph. Blank lines are
 * dropped. Local images need their file_upload id in `uploads`.
 */
/** `- [ ] text` / `- [x] text`, the task syntax the editor renders as a checkbox. */
const TASK = /^- \[([ xX])\] (.*)$/;

/**
 * A block's text line for diffing against local content. A bullet whose text
 * looks like a task reads back identically to the task line, so it is marked
 * stale; otherwise pages synced before to_do support would never convert.
 */
export function blockSyncKey(b: any): string {
  const line = blocksToText([b]).replace(/\s+$/, "");
  const first = line.split("\n")[0];
  return b.type === "bulleted_list_item" && TASK.test(first) ? `${line}\u0000bullet` : line;
}

/** Block types Notion lets us nest children under. */
const CAN_NEST = new Set(["paragraph", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "toggle"]);
/** Notion accepts two levels of nested children per append request. */
const MAX_DEPTH = 2;

interface LineNode {
  text: string;
  children: LineNode[];
}

/** Block type a (trimmed) line maps to, ignoring image uploads. */
function lineType(text: string): string {
  if (parseImageLine(text)) return "image";
  if (/^#{1,3} /.test(text)) return "heading";
  if (TASK.test(text)) return "to_do";
  if (text.startsWith("- ")) return "bulleted_list_item";
  if (/^\d+\.\s/.test(text)) return "numbered_list_item";
  if (text.startsWith("> ")) return "quote";
  return "paragraph";
}

/**
 * Parse content into a tree by indentation (2 spaces or a tab per level, as
 * Tab inserts in the editor). Depth jumps are clamped to one level deeper,
 * capped at MAX_DEPTH, and nothing nests under headings or images. Lines
 * inside ``` fences stay top-level with their indentation intact.
 */
function parseTree(content: string): LineNode[] {
  const roots: LineNode[] = [];
  const stack: LineNode[] = []; // ancestors of the next line, by depth
  let inFence = false;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const fence = line.trimStart().startsWith("```");
    if (inFence || fence) {
      // Code keeps its indentation as text; it never nests.
      if (fence) inFence = !inFence;
      roots.push({ text: line, children: [] });
      stack.length = 0;
      continue;
    }
    const indent = line.match(/^[ \t]*/)![0].replace(/\t/g, "  ").length;
    const text = line.trimStart();
    stack.length = Math.min(stack.length, Math.floor(indent / 2), MAX_DEPTH);
    while (stack.length && !CAN_NEST.has(lineType(stack[stack.length - 1].text))) stack.pop();
    const node: LineNode = { text, children: [] };
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** Text that parses back into exactly these nodes. */
function treeToText(nodes: LineNode[], depth = 0): string {
  return nodes
    .map((n) => ["  ".repeat(depth) + n.text, treeToText(n.children, depth + 1)].filter(Boolean).join("\n"))
    .join("\n");
}

function lineToBlock(text: string, uploads?: Map<string, string>): any {
  const mk = (type: string, t: string) => ({
    object: "block",
    type,
    [type]: { rich_text: plainToRichText(t) },
  });
  const image = imageBlock(parseImageLine(text), uploads);
  if (image) return image;
  if (text.startsWith("### ")) return mk("heading_3", text.slice(4));
  if (text.startsWith("## ")) return mk("heading_2", text.slice(3));
  if (text.startsWith("# ")) return mk("heading_1", text.slice(2));
  const task = text.match(TASK);
  if (task) {
    return { object: "block", type: "to_do", to_do: { rich_text: plainToRichText(task[2]), checked: task[1] !== " " } };
  }
  if (text.startsWith("- ")) return mk("bulleted_list_item", text.slice(2));
  if (/^\d+\.\s/.test(text)) return mk("numbered_list_item", text.replace(/^\d+\.\s/, ""));
  if (text.startsWith("> ")) return mk("quote", text.slice(2));
  return mk("paragraph", text);
}

function nodesToBlocks(nodes: LineNode[], uploads?: Map<string, string>): any[] {
  return nodes.map((n) => {
    const block = lineToBlock(n.text, uploads);
    if (n.children.length && CAN_NEST.has(block.type)) {
      block[block.type].children = nodesToBlocks(n.children, uploads);
    }
    return block;
  });
}

export function contentToBlocks(content: string, uploads?: Map<string, string>): any[] {
  return nodesToBlocks(parseTree(content), uploads);
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
 * Text as Notion would store it (blank lines dropped, indentation normalized)
 * so remote page bodies can be compared with local content cheaply.
 */
export function normalizeForCompare(text: string): string {
  return blocksToText(contentToBlocks(text));
}

/** Number of block deletions sent concurrently (Notion averages ~3 req/s). */
const DELETE_CONCURRENCY = 3;

async function syncPageBlocks(pageId: string, content: string) {
  // 1. Fetch old top-level blocks (children included): ids for deletion,
  //    text for diffing. Deleting a block also deletes its children.
  const old = (await listChildren(pageId)).map((b) => ({
    id: b.id,
    line: blockSyncKey(b),
  }));

  // 2. Keep the longest unchanged prefix of blocks. Typing usually happens
  //    near the end, so this turns "rewrite every block" into a handful of
  //    requests, and images above the edit are never re-uploaded. Blank
  //    Notion blocks have no local counterpart and are skipped over.
  // ponytail: prefix only; an edit near the top still rewrites everything
  // below it. Add suffix matching via Notion's `position` insert if needed.
  const units = parseTree(content);
  const keys = units.map((u) => normalizeForCompare(treeToText([u])));
  let o = 0;
  let n = 0;
  while (o < old.length) {
    if (!old[o].line.trim()) o++;
    else if (n < keys.length && old[o].line === keys[n]) {
      o++;
      n++;
    } else break;
  }
  if (o === old.length && n === keys.length) return;

  // 3. Append the new tail FIRST so the page is never missing content.
  const tail = treeToText(units.slice(n));
  await appendBlocks(pageId, contentToBlocks(tail, await uploadImages(tail)));
  const oldBlockIds = old.slice(o).map((b) => b.id);

  // 4. Delete old blocks in small concurrent batches.
  let failedDeletes = 0;
  for (let i = 0; i < oldBlockIds.length; i += DELETE_CONCURRENCY) {
    const batch = oldBlockIds.slice(i, i + DELETE_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((id) => notionRequest("DELETE", `/blocks/${id}`)),
    );
    settled.forEach((r, j) => {
      if (r.status === "fulfilled") return;
      // 404 just means the block was already gone — not a real failure.
      const err: any = r.reason;
      if (err?.code === "http_404" || err?.code === "not_found") return;
      failedDeletes++;
      console.debug("[notion] failed to delete old block:", batch[j], err?.message ?? err);
    });
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
  await appendBlocks(page.id, contentToBlocks(note.content, uploads));
  return {
    pageId: page.id,
    lastEditedTime: page.last_edited_time ?? new Date().toISOString(),
  };
}

/** Update an existing Notion page (properties + rewritten body). */
export async function pushUpdateNote(
  note: Note,
): Promise<{ lastEditedTime: string }> {
  const pageId = note.notion_page_id!;
  const page = await notionRequest<any>("PATCH", `/pages/${pageId}`, {
    properties: noteProperties(note),
  });
  // Deliberately NOT swallowed: if block sync fails, the local note must
  // stay unsynced so the merge engine retries it instead of silently
  // leaving duplicated/stale blocks behind forever.
  await syncPageBlocks(pageId, note.content);
  return {
    lastEditedTime: page?.last_edited_time ?? new Date().toISOString(),
  };
}

/** Archive (soft delete) a Notion page. */
export async function pushDeleteNote(pageId: string): Promise<void> {
  await notionRequest("PATCH", `/pages/${pageId}`, { archived: true });
}
