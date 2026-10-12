import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useNotes } from "@/store/notes";
import { formatRelative } from "@/lib/format";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const {
    config,
    theme,
    setTheme,
    lastSyncAt,
    globalSync,
    online,
    connect,
    clearCache,
    testConnection,
    flushSave,
    syncNow,
    notes,
  } = useNotes();

  const [apiKey, setApiKey] = useState("");
  const [dbName, setDbName] = useState(config.database_name);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const unsyncedCount = notes.filter((n) => n.sync_status !== "synced").length;

  async function handleTest() {
    setTesting(true);
    try {
      await testConnection();
      toast.success("Connected to Notion successfully.");
    } catch (e: any) {
      toast.error(e?.message ?? "Connection failed.");
    } finally {
      setTesting(false);
    }
  }

  async function handleReconnect() {
    if (!dbName.trim()) {
      toast.error("Database name cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      // connect() verifies the key before replacing the stored one, so a
      // failed reconnect leaves the working connection untouched.
      await connect(apiKey.trim(), dbName.trim());
      toast.success(`Connected to ${dbName.trim()}.`);
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Reconnect failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleClearCache() {
    try {
      // Push what we can first so as little as possible is lost.
      flushSave();
      if (online) await syncNow();
      await clearCache();
      toast.success("Local cache cleared. Notes will be pulled from Notion.");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to clear cache.");
    }
  }

  const statusText = !online
    ? "Offline"
    : globalSync === "syncing"
      ? "Syncing…"
      : globalSync === "error"
        ? "Sync error"
        : lastSyncAt
          ? `Last synced ${formatRelative(lastSyncAt)}`
          : "Not synced yet";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Connection, appearance and storage.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Notion API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Stored securely in your system keychain"
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium">Database</label>
            <Input value={dbName} onChange={(e) => setDbName(e.target.value)} />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
              {testing && <Loader2 className="size-3.5 animate-spin" />}
              Test Connection
            </Button>
            <Button size="sm" onClick={handleReconnect} disabled={busy || !apiKey.trim()}>
              Reconnect
            </Button>
          </div>

          <Separator />

          <div className="grid gap-2">
            <label className="text-sm font-medium">Theme</label>
            <Select value={theme} onValueChange={(v) => setTheme(v as any)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="herdr">Herdr (Paper Light)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Synchronization</p>
              <p className="text-xs text-muted-foreground">{statusText}</p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setConfirmClear(true)}>
              Clear Local Cache
            </Button>
          </div>
        </div>
      </DialogContent>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear local cache?</AlertDialogTitle>
            <AlertDialogDescription>
              Local notes and images are removed and pulled again from Notion.
              {unsyncedCount > 0 &&
                ` ${unsyncedCount} note${unsyncedCount === 1 ? " has" : "s have"} changes not yet in Notion. A sync is attempted first; anything that still fails to sync will be lost.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void handleClearCache()}
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
