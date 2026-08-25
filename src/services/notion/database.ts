import { notionRequest, richTextToPlain, NotionError } from "./client";
import type { ConnectResult } from "@/types/note";

export const DEFAULT_DB_NAME = "random_notes_desktop";

export interface DataSourceRef {
  databaseId: string;
  dataSourceId: string;
}

/** Verify the API key by fetching the integration bot user. */
export async function verifyApiKey(): Promise<{ name: string }> {
  const me = await notionRequest<any>("GET", "/users/me");
  if (me?.type !== "bot" && !me?.bot) {
    throw new NotionError("unauthorized", "This key does not belong to a Notion integration.");
  }
  return { name: me.name ?? "Notion Integration" };
}

function dataSourceTitle(ds: any): string {
  return richTextToPlain(ds?.title);
}

async function searchDataSourceByName(name: string): Promise<any | null> {
  const res = await notionRequest<any>("POST", "/search", {
    query: name,
    filter: { property: "object", value: "data_source" },
  });
  for (const ds of res?.results ?? []) {
    if (ds.in_trash || ds.archived) continue;
    if (dataSourceTitle(ds).trim().toLowerCase() === name.trim().toLowerCase()) return ds;
  }
  return null;
}

const REQUIRED_PROPERTIES: Record<string, Record<string, any>> = {
  Title: { title: {} },
  Content: { rich_text: {} },
  "Created At": { date: {} },
  "Updated At": { date: {} },
};

/**
 * Check that the data source has the required properties with the right
 * types. Adds missing properties when possible; throws a clear error when a
 * property exists but has an incompatible type.
 */
export async function ensureProperties(dataSourceId: string): Promise<string[]> {
  const ds = await notionRequest<any>("GET", `/data_sources/${dataSourceId}`);
  const props: Record<string, any> = ds?.properties ?? {};

  const missing: Record<string, any> = {};
  for (const [name, schema] of Object.entries(REQUIRED_PROPERTIES)) {
    const existing = props[name];
    if (!existing) {
      missing[name] = schema;
      continue;
    }
    const expected = Object.keys(schema)[0];
    if (existing.type !== expected) {
      throw new NotionError(
        "invalid_properties",
        `The Notion property "${name}" has type "${existing.type}" but this app requires "${expected}". Please fix the database in Notion or choose another database.`,
      );
    }
  }

  if (Object.keys(missing).length > 0) {
    await notionRequest("PATCH", `/data_sources/${dataSourceId}`, { properties: missing });
  }
  return Object.keys(missing);
}

/** Find an accessible parent page, preferring one named "Notes". */
export async function findParentPage(): Promise<{ pageId: string; title: string }> {
  const res = await notionRequest<any>("POST", "/search", {
    filter: { property: "object", value: "page" },
    page_size: 100,
  });
  const pages: any[] = res?.results ?? [];
  if (pages.length === 0) {
    throw new NotionError(
      "no_parent_page",
      'No accessible parent page was found. In Notion, open the page that should contain the database (e.g. a page named "Notes"), click ••• → Connections, and connect this integration. Then try again.',
    );
  }
  let fallback = pages[0];
  for (const page of pages) {
    const title =
      richTextToPlain(page?.properties?.title?.title ?? page?.properties?.Title?.title ?? []) ||
      richTextToPlain(
        Object.values(page?.properties ?? {})
          .filter((p: any) => p?.type === "title")
          .flatMap((p: any) => p?.title ?? []),
      );
    if (title.trim().toLowerCase() === "notes") return { pageId: page.id, title };
    if (!fallback.title) {
      fallback = { ...page, title };
    }
  }
  return { pageId: fallback.id, title: fallback.title || "Untitled" };
}

/** Create the database with its initial data source and required properties. */
export async function createDatabase(name: string): Promise<DataSourceRef> {
  const parent = await findParentPage();
  const db = await notionRequest<any>("POST", "/databases", {
    parent: { type: "page_id", page_id: parent.pageId },
    title: [{ type: "text", text: { content: name } }],
    initial_data_source: { properties: REQUIRED_PROPERTIES },
  });
  const dsId = db?.data_sources?.[0]?.id;
  if (!db?.id || !dsId) {
    throw new NotionError("create_failed", "Notion created the database but did not return its ID.");
  }
  return { databaseId: db.id, dataSourceId: dsId };
}

/**
 * Full connection flow:
 * 1. If we already stored IDs, verify them.
 * 2. Otherwise search by name; reuse if found (never create duplicates).
 * 3. Otherwise create the database under an accessible parent page.
 * 4. Ensure required properties exist.
 */
export async function ensureDatabase(
  name: string,
  stored?: { databaseId: string | null; dataSourceId: string | null },
): Promise<ConnectResult> {
  // 1. Verify previously stored IDs.
  if (stored?.dataSourceId) {
    try {
      const ds = await notionRequest<any>("GET", `/data_sources/${stored.dataSourceId}`);
      if (ds?.id && !ds.in_trash && !ds.archived) {
        await ensureProperties(stored.dataSourceId);
        return {
          databaseId: ds.parent?.database_id ?? stored.databaseId!,
          dataSourceId: stored.dataSourceId,
          existed: true,
        };
      }
    } catch {
      console.debug("[notion] stored data source invalid, searching again");
    }
  }

  // 2. Search by name.
  const existing = await searchDataSourceByName(name);
  if (existing) {
    await ensureProperties(existing.id);
    return {
      databaseId: existing.parent?.database_id ?? existing.id,
      dataSourceId: existing.id,
      existed: true,
    };
  }

  // 3. Create it.
  const created = await createDatabase(name);
  await ensureProperties(created.dataSourceId);
  return { ...created, existed: false };
}
