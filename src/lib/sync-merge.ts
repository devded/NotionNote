import type { Note } from "@/types/note";

/**
 * Pure merge engine extracted from the NotesProvider sync loop so it can be
 * unit tested. Given the remote state of Notion, the local notes, the results
 * of pushes performed this cycle, and still-outstanding deletes, produce the
 * next local note list.
 */

export interface PushResult {
  lastEditedTime: string;
  /** Set when a new page was created in Notion during this cycle. */
  pageId?: string;
  /** Content snapshot taken before the push, to detect typing during upload. */
  snapshot: { title: string; content: string };
}

export interface MergeInput {
  /** Freshly fetched notes from Notion (already excludes trashed pages). */
  remote: Note[];
  /** Current local notes (freshest at time of merge). */
  localNotes: Note[];
  /** note.id -> push outcome for pushes made during this sync cycle. */
  pushResults: Map<string, PushResult>;
  /** Page ids whose deletion failed or is queued — must not be resurrected. */
  pendingDeleteIds: string[];
}

export interface MergeOutput {
  merged: Note[];
  /** True when another sync pass should be scheduled immediately. */
  hasMorePending: boolean;
}

function typedDuringPush(local: Note, info: PushResult): boolean {
  return (
    local.title !== info.snapshot.title || local.content !== info.snapshot.content
  );
}

export function mergeRemoteAndLocal(input: MergeInput): MergeOutput {
  const { remote, localNotes, pushResults, pendingDeleteIds } = input;

  const merged: Note[] = [];
  let hasMorePending = false;

  for (const r of remote) {
    // Skip pages whose deletion is still queued/failed — otherwise they
    // would be resurrected as "newly created" notes.
    if (pendingDeleteIds.includes(r.id)) continue;

    const local = localNotes.find(
      (n) => (n.notion_page_id && n.notion_page_id === r.id) || n.id === r.id,
    );

    if (!local) {
      // Newly created on Notion.
      merged.push(r);
      continue;
    }

    const pushInfo = pushResults.get(local.id);
    if (pushInfo) {
      // Check if user continued typing while push was running.
      const userTypedDuringPush = typedDuringPush(local, pushInfo);
      const pageId = pushInfo.pageId ?? local.notion_page_id;

      if (userTypedDuringPush) {
        hasMorePending = true;
        merged.push({ ...local, notion_page_id: pageId, sync_status: "pending" });
      } else {
        merged.push({
          ...local,
          notion_page_id: pageId,
          sync_status: "synced",
          last_synced_at: pushInfo.lastEditedTime,
          updated_at: pushInfo.lastEditedTime,
        });
      }
    } else if (local.sync_status !== "synced") {
      // Local note was modified locally after snapshots were taken, or
      // previously errored and will be retried by the next pass.
      hasMorePending = true;
      merged.push(local);
    } else {
      // Local was synced; remote is authoritative.
      const content =
        r.content !== undefined && r.content !== null && r.content !== ""
          ? r.content
          : r.content === ""
            ? ""
            : local.content;
      merged.push({
        ...local,
        ...r,
        content,
        sync_status: "synced",
      });
    }
  }

  // Include any newly created local notes not yet present in the remote query.
  for (const local of localNotes) {
    const alreadyMerged = merged.some(
      (m) =>
        m.id === local.id ||
        (m.notion_page_id && m.notion_page_id === local.notion_page_id),
    );
    if (!alreadyMerged) {
      const pushInfo = pushResults.get(local.id);
      if (pushInfo) {
        const userTypedDuringPush = typedDuringPush(local, pushInfo);
        if (userTypedDuringPush) hasMorePending = true;
        merged.unshift({
          ...local,
          notion_page_id: pushInfo.pageId ?? local.notion_page_id,
          sync_status: userTypedDuringPush ? "pending" : "synced",
          last_synced_at: pushInfo.lastEditedTime,
          updated_at: pushInfo.lastEditedTime,
        });
      } else {
        if (local.sync_status !== "synced") hasMorePending = true;
        merged.unshift(local);
      }
    }
  }

  // Sort newest updated first.
  merged.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  return { merged, hasMorePending };
}
