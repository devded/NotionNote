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
  notes: z.array(z.unknown()).catch([]),
  pendingDeletes: z.array(z.string()).catch([]),
});

export function parsePersistedNotes(raw: unknown): PersistedNotes {
  const result = PersistedNotesSchema.safeParse(raw ?? {});
  if (!result.success) {
    console.debug("[persistence] notes cache unreadable, starting fresh:", result.error.message);
    return { version: 1, notes: [], pendingDeletes: [] };
  }
  // Each note is checked on its own so one bad entry can't drop the rest.
  const notes = result.data.notes.flatMap((n) => {
    const r = NoteSchema.safeParse(n);
    return r.success ? [r.data] : [];
  });
  const dropped = result.data.notes.length - notes.length;
  if (dropped > 0) console.debug(`[persistence] dropped ${dropped} malformed note(s)`);
  return {
    version: 1,
    notes,
    pendingDeletes: [...new Set(result.data.pendingDeletes)],
  };
}
