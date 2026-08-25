import { notionRequest, richTextToPlain, plainToRichText } from "./client";
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
  const preview =
    note.content.length > CONTENT_PREVIEW_LIMIT
      ? note.content.slice(0, CONTENT_PREVIEW_LIMIT)
      : note.content;
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

export function blocksToText(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.archived || b.in_trash || !b.type) continue;
    const rt: any[] = b[b.type]?.rich_text ?? [];
    const text = rt
      .map((r) => r.plain_text ?? r.text?.content ?? "")
      .join("");
    switch (b.type) {
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
 * everything else becomes a paragraph. Blank lines are dropped.
 */
export function contentToBlocks(content: string): any[] {
  const blocks: any[] = [];
  const mk = (type: string, text: string) => ({
    object: "block",
    type,
    [type]: { rich_text: [{ type: "text", text: { content: text } }] },
  });
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.startsWith("### ")) blocks.push(mk("heading_3", line.slice(4)));
    else if (line.startsWith("## ")) blocks.push(mk("heading_2", line.slice(3)));
    else if (line.startsWith("# ")) blocks.push(mk("heading_1", line.slice(2)));
    else if (line.startsWith("- ")) blocks.push(mk("bulleted_list_item", line.slice(2)));
    else if (/^\d+\.\s/.test(line)) blocks.push(mk("numbered_list_item", line.replace(/^\d+\.\s/, "")));
    else if (line.startsWith("> ")) blocks.push(mk("quote", line.slice(2)));
    else blocks.push(mk("paragraph", line));
  }
  return blocks;
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
  // 1. Fetch old blocks — their IDs for deletion, and their text so we can
  //    detect that nothing actually changed.
  const oldBlockIds: string[] = [];
  const existingLines: string[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest(
      "GET",
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    const results: any[] = res?.results ?? [];
    const text = blocksToText(results);
    if (text) existingLines.push(text);
    for (const b of results) {
      if (!b.archived && !b.in_trash) {
        oldBlockIds.push(b.id);
      }
    }
    cursor = res?.has_more ? res?.next_cursor ?? undefined : undefined;
  } while (cursor);

  // 2. Skip the entire fetch-append-delete cycle when Notion already matches.
  //    This turns repeat updates of unchanged content into a single GET.
  const existingText = existingLines.join("\n");
  if (normalizeForCompare(content) === normalizeForCompare(existingText)) {
    return;
  }

  // 3. Append new blocks FIRST so the page is never empty mid-update.
  const blocks = contentToBlocks(content);
  if (blocks.length > 0) {
    for (let i = 0; i < blocks.length; i += 100) {
      await notionRequest("PATCH", `/blocks/${pageId}/children`, {
        children: blocks.slice(i, i + 100),
      });
    }
  }

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
  const page = await notionRequest<any>("POST", "/pages", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: noteProperties(note),
  });
  const blocks = contentToBlocks(note.content);
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
