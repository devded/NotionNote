import { z } from "zod";
import type { PersistedNotes } from "@/types/note";

/**
 * Runtime validation for locally-persisted notes. A corrupted or
 * hand-edited notes.json must degrade gracefully, never crash the app.
 * Individual malformed notes are dropped; valid ones survive.
 */
const NoteSchema = z.object({
  id: z.string().min(1),
  title: z.string().catch(""),
  content: z.string().catch(""),
  created_at: z.string().catch(() => new Date().toISOString()),
  updated_at: z.string().catch(() => new Date().toISOString()),
  sync_status: z.enum(["synced", "pending", "error"]).catch("pending"),
  notion_page_id: z.string().nullable().catch(null),
  last_synced_at: z.string().nullable().catch(null),
});

const PersistedNotesSchema = z.object({
  version: z.number(),
  notes: z.array(NoteSchema).catch([]),
  pendingDeletes: z.array(z.string()).catch([]),
});

/** Future migrations hook here; currently only v1 exists. */
function migrate(raw: unknown): unknown {
  // e.g. if ((raw as any)?.version === 1) return upgradeV1toV2(raw);
  return raw;
}

export function parsePersistedNotes(raw: unknown): PersistedNotes {
  const migrated = migrate(raw ?? {});
  const result = PersistedNotesSchema.safeParse(migrated);
  if (!result.success) {
    console.debug("[persistence] notes cache unreadable, starting fresh:", result.error.message);
    return { version: 1, notes: [], pendingDeletes: [] };
  }
  const parsed = result.data;
  if (parsed.notes.length > 0 && Array.isArray((raw as any)?.notes)) {
    const dropped = ((raw as any).notes as unknown[]).length - parsed.notes.length;
    if (dropped > 0) {
      console.debug(`[persistence] dropped ${dropped} malformed note(s)`);
    }
  }
  return {
    version: 1,
    notes: parsed.notes,
    pendingDeletes: [...new Set(parsed.pendingDeletes)],
  };
}
