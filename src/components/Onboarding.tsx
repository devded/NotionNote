import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNotes } from "@/store/notes";
import { DEFAULT_DB_NAME } from "@/services/notion/database";

export function Onboarding({ onConnected }: { onConnected: () => void }) {
  const { connect } = useNotes();
  const [apiKey, setApiKey] = useState("");
  const [dbName, setDbName] = useState(DEFAULT_DB_NAME);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const name = dbName.trim() || DEFAULT_DB_NAME;

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setError(null);
    setConnecting(true);
    try {
      await connect(apiKey.trim(), name);
      setConnectedName(name);
    } catch (err: any) {
      setError(err?.message ?? "Unable to connect to Notion. Please check your API key.");
    } finally {
      setConnecting(false);
    }
  }

  if (connectedName) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm px-6 text-center">
          <p className="flex items-center justify-center gap-1.5 text-sm font-medium">
            <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
            Connected to {connectedName}
          </p>
          <Button className="mt-5 w-full" onClick={onConnected}>
            Start Taking Notes
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <form onSubmit={handleConnect} className="w-full max-w-sm px-6">
        <div className="mb-6 flex flex-col items-center justify-center">
          <img src="/monolog-logo.svg" alt="Monolog" className="mb-3 size-12" />
          <h1 className="text-center text-xl font-bold tracking-tight">Monolog</h1>
          <p className="mt-1 text-center text-sm text-muted-foreground">
            Connect your Notion workspace
          </p>
        </div>

        <label className="mb-1.5 block text-sm font-medium">Notion API Key</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="ntn_…"
          autoFocus
          autoComplete="off"
        />

        <label className="mt-4 mb-1.5 block text-sm font-medium">Database</label>
        <Input value={dbName} onChange={(e) => setDbName(e.target.value)} />

        <Button
          type="submit"
          className="mt-6 w-full"
          disabled={!apiKey.trim() || connecting}
        >
          Connect
        </Button>

        <div className="mt-6 min-h-28 text-sm">
          {connecting && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              Connecting to {name}…
            </p>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
              {error}
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
