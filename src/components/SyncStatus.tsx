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
    if (await syncNow()) {
      toast.success("Notion sync complete", { id: "sync-action" });
    } else {
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
  let label = isSyncing ? "Syncing…" : "Sync now";

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
        {/* span keeps the tooltip working while the button is disabled */}
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={!online || isSyncing}
            onClick={handleSync}
          >
            {icon}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} ·{" "}
        {lastSyncAt
          ? `Last synced ${formatRelative(lastSyncAt)} (⌘R / F5)`
          : "Sync all notes with Notion (⌘R / F5)"}
      </TooltipContent>
    </Tooltip>
  );
}
