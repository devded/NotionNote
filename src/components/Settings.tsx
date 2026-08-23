import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
    disconnect,
    clearCache,
    testConnection,
    flushSave,
  } = useNotes();

  const [apiKey, setApiKey] = useState("");
  const [dbName, setDbName] = useState(config.database_name);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);

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
      if (apiKey.trim()) {
        await disconnect();
        await connect(apiKey.trim(), dbName.trim());
        toast.success(`Connected to ${dbName.trim()}.`);
      } else {
        await testConnection();
        toast.success("Connection verified.");
      }
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Reconnect failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleClearCache() {
    try {
      flushSave();
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
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Synchronization</p>
              <p className="text-xs text-muted-foreground">{statusText}</p>
            </div>
            <Button variant="destructive" size="sm" onClick={handleClearCache}>
              Clear Local Cache
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
