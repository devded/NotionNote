import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNotes } from "@/store/notes";
import { DEFAULT_DB_NAME } from "@/services/notion/database";

interface Progress {
  done: string[];
  active: string | null;
}

export function Onboarding({ onConnected }: { onConnected: () => void }) {
  const { connect } = useNotes();
  const [apiKey, setApiKey] = useState("");
  const [dbName, setDbName] = useState(DEFAULT_DB_NAME);
  const [progress, setProgress] = useState<Progress>({ done: [], active: null });
  const [error, setError] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);

  function setActive(label: string | null) {
    setProgress((p) => ({
      done: label === null ? p.done : [...p.done, ...(p.active ? [p.active] : [])],
      active: label,
    }));
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setError(null);
    try {
      setActive("Verifying API key…");
      await tick();
      setActive(`Searching for ${dbName}…`);
      await tick(150);
      const result = await connect(apiKey.trim(), dbName.trim() || DEFAULT_DB_NAME);
      setActive("Loading notes…");
      await tick(result.existed ? 200 : 500);
      setActive(null);
      setConnectedName(dbName.trim() || DEFAULT_DB_NAME);
    } catch (err: any) {
      setError(err?.message ?? "Unable to connect to Notion. Please check your API key.");
      setProgress({ done: [], active: null });
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
        <h1 className="text-center text-lg font-semibold tracking-tight">Notes</h1>
        <p className="mt-1 mb-8 text-center text-sm text-muted-foreground">
          Connect your Notion workspace
        </p>

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
          disabled={!apiKey.trim() || progress.active !== null}
        >
          Connect
        </Button>

        <div className="mt-6 min-h-28 text-sm">
          {(progress.active || progress.done.length > 0) && (
            <ul className="space-y-1.5 text-muted-foreground">
              {progress.done.map((m) => (
                <li key={m} className="flex items-center gap-2">
                  <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  {m}
                </li>
              ))}
              {progress.active && (
                <li className="flex items-center gap-2">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  {progress.active}
                </li>
              )}
            </ul>
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

function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
