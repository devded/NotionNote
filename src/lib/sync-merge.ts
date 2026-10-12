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
  /** Current time in ms; injectable for tests. */
  now?: number;
}

/**
 * A synced note missing from the remote query was deleted in Notion. Pages
 * synced very recently are kept anyway in case the query lags behind.
 */
const REMOTE_DELETE_GRACE_MS = 2 * 60_000;

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
  const { remote, localNotes, pushResults, pendingDeleteIds, now = Date.now() } = input;

  const merged: Note[] = [];
  let hasMorePending = false;

  // Index lookups once instead of scanning arrays per note (was O(n²)).
  // First match in array order wins, mirroring the original `find`.
  const localByKey = new Map<string, Note>();
  for (const n of localNotes) {
    for (const key of [n.notion_page_id, n.id]) {
      if (key && !localByKey.has(key)) localByKey.set(key, n);
    }
  }
  const pendingDeletes = new Set(pendingDeleteIds);
  const mergedIds = new Set<string>();
  const mergedPages = new Set<string>();
  const add = (n: Note, front = false) => {
    if (front) merged.unshift(n);
    else merged.push(n);
    mergedIds.add(n.id);
    if (n.notion_page_id) mergedPages.add(n.notion_page_id);
  };

  for (const r of remote) {
    // Skip pages whose deletion is still queued/failed — otherwise they
    // would be resurrected as "newly created" notes.
    if (pendingDeletes.has(r.id)) continue;

    const local = localByKey.get(r.id);

    if (!local) {
      // Newly created on Notion.
      add(r);
      continue;
    }

    const pushInfo = pushResults.get(local.id);
    if (pushInfo) {
      // Check if user continued typing while push was running.
      const userTypedDuringPush = typedDuringPush(local, pushInfo);
      const pageId = pushInfo.pageId ?? local.notion_page_id;

      if (userTypedDuringPush) {
        hasMorePending = true;
        add({ ...local, notion_page_id: pageId, sync_status: "pending" });
      } else {
        add({
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
      add(local);
    } else {
      // Local was synced; remote is authoritative.
      add({
        ...local,
        ...r,
        content: r.content ?? local.content,
        sync_status: "synced",
      });
    }
  }

  // Include any newly created local notes not yet present in the remote query.
  for (const local of localNotes) {
    const alreadyMerged =
      mergedIds.has(local.id) ||
      (!!local.notion_page_id && mergedPages.has(local.notion_page_id));
    if (!alreadyMerged) {
      const pushInfo = pushResults.get(local.id);
      if (pushInfo) {
        const userTypedDuringPush = typedDuringPush(local, pushInfo);
        if (userTypedDuringPush) hasMorePending = true;
        add({
          ...local,
          notion_page_id: pushInfo.pageId ?? local.notion_page_id,
          sync_status: userTypedDuringPush ? "pending" : "synced",
          last_synced_at: pushInfo.lastEditedTime,
          updated_at: pushInfo.lastEditedTime,
        }, true);
      } else if (
        local.sync_status === "synced" &&
        local.notion_page_id &&
        now - new Date(local.last_synced_at ?? 0).getTime() > REMOTE_DELETE_GRACE_MS
      ) {
        // Deleted in Notion: drop the local copy too.
        continue;
      } else {
        if (local.sync_status !== "synced") hasMorePending = true;
        add(local, true);
      }
    }
  }

  // Sort newest updated first.
  merged.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  return { merged, hasMorePending };
}
