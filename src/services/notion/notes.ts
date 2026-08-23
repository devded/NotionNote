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
    // Property value holds complete text content as atomic fallback
    content: richTextToPlain(props.Content?.rich_text),
    created_at: created,
    updated_at: updated,
    sync_status: "synced",
    notion_page_id: page.id,
    last_synced_at: page.last_edited_time ?? new Date().toISOString(),
  };
}

function noteProperties(note: {
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    Title: { title: [{ type: "text", text: { content: note.title || "Untitled" } }] },
    Content: { rich_text: plainToRichText(note.content) },
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

function blocksToText(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.archived || b.in_trash || !b.type) continue;
    const rt: any[] = b[b.type]?.rich_text ?? [];
    const text = rt.map((r) => r.plain_text ?? "").join("");
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

async function syncPageBlocks(pageId: string, content: string) {
  // 1. Fetch old block IDs
  const oldBlockIds: string[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notionRequest(
      "GET",
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    for (const b of res?.results ?? []) {
      if (!b.archived && !b.in_trash) {
        oldBlockIds.push(b.id);
      }
    }
    cursor = res?.has_more ? res?.next_cursor ?? undefined : undefined;
  } while (cursor);

  // 2. Append new blocks FIRST so the page is never empty
  const blocks = contentToBlocks(content);
  if (blocks.length > 0) {
    for (let i = 0; i < blocks.length; i += 100) {
      await notionRequest("PATCH", `/blocks/${pageId}/children`, {
        children: blocks.slice(i, i + 100),
      });
    }
  }

  // 3. Delete old blocks cleanly
  for (const oldId of oldBlockIds) {
    try {
      await notionRequest("DELETE", `/blocks/${oldId}`);
    } catch {
      // Ignore if block was already deleted
    }
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
    try {
      await syncPageBlocks(note.notion_page_id, note.content);
    } catch (e) {
      console.debug("[notion] error syncing page blocks:", e);
    }
  }
  return {
    lastEditedTime: page?.last_edited_time ?? new Date().toISOString(),
  };
}

/** Archive (soft delete) a Notion page. */
export async function pushDeleteNote(pageId: string): Promise<void> {
  await notionRequest("PATCH", `/pages/${pageId}`, { archived: true });
}
