import { AlertTriangle, Check, CircleX, RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SyncStatus } from "@/types/note";
import { useNotes } from "@/store/notes";
import { formatRelative } from "@/lib/format";

export function NoteStatusIcon({ status }: { status: SyncStatus }) {
  if (status === "pending")
    return (
      <span
        title="Waiting to sync"
        className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400"
      />
    );
  if (status === "error")
    return <CircleX className="size-3.5 shrink-0 text-destructive" />;
  return null; // synced: no icon keeps the list quiet
}

export function SyncStatusBar() {
  const { globalSync, online, lastSyncAt, flushSave, notes } = useNotes();

  const pendingCount = notes.filter((n) => n.sync_status !== "synced").length;

  let label = lastSyncAt ? `Synced ${formatRelative(lastSyncAt)}` : "Synced";
  let icon = <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />;

  if (!online || globalSync === "offline") {
    label = pendingCount > 0 ? `Saved locally · ${pendingCount} waiting` : "Offline";
    icon = <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />;
  } else if (globalSync === "syncing") {
    label = "Syncing…";
    icon = <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />;
  } else if (globalSync === "error") {
    label = pendingCount > 0 ? "Sync failed — retrying" : "Sync error";
    icon = <CircleX className="size-3.5 text-destructive" />;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={flushSave}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {icon}
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">Last sync: {lastSyncAt ? formatRelative(lastSyncAt) : "never"}</TooltipContent>
    </Tooltip>
  );
}
