import { AlertTriangle, CircleX, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
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

export function SyncButton() {
  const { globalSync, online, lastSyncAt, flushSave, syncNow, notes } = useNotes();

  const isSyncing = globalSync === "syncing";
  const pendingCount = notes.filter((n) => n.sync_status !== "synced").length;

  const handleSync = async () => {
    if (!online || isSyncing) return;
    flushSave();
    toast.loading("Syncing with Notion…", { id: "sync-action" });
    try {
      await syncNow();
      toast.success("Notion sync complete", { id: "sync-action" });
    } catch {
      toast.error("Sync failed. Check your connection or API key.", { id: "sync-action" });
    }
  };

  let icon = (
    <RefreshCw
      className={`size-3.5 ${
        isSyncing ? "animate-spin text-primary" : "text-muted-foreground"
      }`}
    />
  );
  let label = isSyncing ? "Syncing…" : "Sync";

  if (!online || globalSync === "offline") {
    icon = <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />;
    label = pendingCount > 0 ? `${pendingCount} waiting` : "Offline";
  } else if (globalSync === "error") {
    icon = <CircleX className="size-3.5 text-destructive" />;
    label = "Retry Sync";
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={!online || isSyncing}
          onClick={handleSync}
          className="h-7 gap-1.5 px-2.5 text-xs font-medium"
        >
          {icon}
          <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {lastSyncAt
          ? `Last synced: ${formatRelative(lastSyncAt)} · Click to sync (⌘R / F5)`
          : "Sync all notes with Notion (⌘R / F5)"}
      </TooltipContent>
    </Tooltip>
  );
}
