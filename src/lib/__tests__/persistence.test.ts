import { describe, expect, it } from "vitest";
import { parsePersistedNotes } from "../persistence";

const note = (id: string) => ({
  id,
  title: "t",
  content: "c",
  created_at: "2026-11-08T00:00:00Z",
  updated_at: "2026-11-08T00:00:00Z",
  sync_status: "synced",
  notion_page_id: null,
  last_synced_at: null,
});

describe("parsePersistedNotes", () => {
  it("drops only the malformed note, keeping the valid ones", () => {
    const raw = { version: 1, notes: [note("a"), { title: "no id" }, note("b")], pendingDeletes: [] };
    expect(parsePersistedNotes(raw).notes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("returns an empty store for garbage input", () => {
    expect(parsePersistedNotes("nonsense").notes).toEqual([]);
  });
});
