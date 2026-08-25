import { describe, expect, it } from "vitest";
import { mergeRemoteAndLocal, type PushResult } from "../sync-merge";
import type { Note } from "@/types/note";

function makeNote(partial: Partial<Note> & { id: string }): Note {
  return {
    title: "",
    content: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    sync_status: "synced",
    notion_page_id: null,
    last_synced_at: null,
    ...partial,
  };
}

function pushInfo(
  snapshotTitle: string,
  snapshotContent: string,
  pageId?: string,
): PushResult {
  return {
    lastEditedTime: "2026-01-02T00:00:00Z",
    pageId,
    snapshot: { title: snapshotTitle, content: snapshotContent },
  };
}

describe("mergeRemoteAndLocal", () => {
  it("adds remote-only notes as new", () => {
    const remote = [makeNote({ id: "page-1", notion_page_id: "page-1" })];
    const { merged, hasMorePending } = mergeRemoteAndLocal({
      remote,
      localNotes: [],
      pushResults: new Map(),
      pendingDeleteIds: [],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("page-1");
    expect(hasMorePending).toBe(false);
  });

  it("does not resurrect pages with outstanding deletes", () => {
    const remote = [makeNote({ id: "doomed", notion_page_id: "doomed" })];
    const { merged } = mergeRemoteAndLocal({
      remote,
      localNotes: [],
      pushResults: new Map(),
      pendingDeleteIds: ["doomed"],
    });
    expect(merged).toHaveLength(0);
  });

  it("marks a note synced after a clean push (no typing during upload)", () => {
    const local = makeNote({ id: "n1", title: "T", content: "C", sync_status: "pending" });
    const { merged, hasMorePending } = mergeRemoteAndLocal({
      remote: [makeNote({ id: "p1", notion_page_id: "p1" })],
      localNotes: [{ ...local, notion_page_id: "p1" }],
      pushResults: new Map([["n1", pushInfo("T", "C")]]),
      pendingDeleteIds: [],
    });
    // Local note is matched to the remote entry via page id.
    const m = merged.find((n) => n.id === "p1" || n.id === "n1")!;
    expect(m.sync_status).toBe("synced");
    expect(m.last_synced_at).toBe("2026-01-02T00:00:00Z");
    expect(hasMorePending).toBe(false);
  });

  it("keeps local content when user typed during push and flags resync", () => {
    const local = makeNote({
      id: "n1",
      title: "Typed more",
      content: "new content",
      sync_status: "pending",
      notion_page_id: "p1",
    });
    const { merged, hasMorePending } = mergeRemoteAndLocal({
      remote: [makeNote({ id: "p1", notion_page_id: "p1", content: "old" })],
      localNotes: [local],
      pushResults: new Map([["n1", pushInfo("Old title", "old content")]]),
      pendingDeleteIds: [],
    });
    const m = merged.find((n) => n.id === "n1")!;
    expect(m.title).toBe("Typed more");
    expect(m.content).toBe("new content");
    expect(m.sync_status).toBe("pending");
    expect(hasMorePending).toBe(true);
  });

  it("retries errored notes (hasMorePending true)", () => {
    const local = makeNote({ id: "err", sync_status: "error" });
    const { hasMorePending, merged } = mergeRemoteAndLocal({
      remote: [],
      localNotes: [local],
      pushResults: new Map(),
      pendingDeleteIds: [],
    });
    expect(merged.find((n) => n.id === "err")).toBeDefined();
    expect(hasMorePending).toBe(true);
  });

  it("remote is authoritative for synced notes; empty remote content wins only if explicitly empty", () => {
    const local = makeNote({ id: "s", notion_page_id: "ps", content: "local", sync_status: "synced" });
    // Remote edited externally:
    const remote = [makeNote({ id: "ps", notion_page_id: "ps", content: "edited in Notion" })];
    const { merged } = mergeRemoteAndLocal({
      remote,
      localNotes: [local],
      pushResults: new Map(),
      pendingDeleteIds: [],
    });
    expect(merged[0].content).toBe("edited in Notion");
    expect(merged[0].sync_status).toBe("synced");

    // Remote explicitly cleared:
    const cleared = [
      makeNote({ id: "ps", notion_page_id: "ps", content: "" }),
    ];
    const out = mergeRemoteAndLocal({
      remote: cleared,
      localNotes: [local],
      pushResults: new Map(),
      pendingDeleteIds: [],
    });
    expect(out.merged[0].content).toBe("");
  });

  it("assigns new page ids from created pushes", () => {
    const local = makeNote({ id: "brand-new", title: "hello", sync_status: "pending" });
    const { merged } = mergeRemoteAndLocal({
      remote: [],
      localNotes: [local],
      pushResults: new Map([["brand-new", pushInfo("hello", "", "fresh-page")]]),
      pendingDeleteIds: [],
    });
    const m = merged[0];
    expect(m.notion_page_id).toBe("fresh-page");
    expect(m.sync_status).toBe("synced");
    expect(m.last_synced_at).toBe("2026-01-02T00:00:00Z");
  });

  it("sorts newest updated first", () => {
    const old = makeNote({ id: "old", updated_at: "2026-01-01T00:00:00Z" });
    const newer = makeNote({ id: "newer", updated_at: "2026-03-01T00:00:00Z" });
    const { merged } = mergeRemoteAndLocal({
      remote: [],
      localNotes: [old, newer],
      pushResults: new Map(),
      pendingDeleteIds: [],
    });
    expect(merged.map((n) => n.id)).toEqual(["newer", "old"]);
  });
});
