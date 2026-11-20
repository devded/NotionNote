import { useDeferredValue, useMemo, useState } from "react";
import { Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { dateGroup, formatShort, snippet } from "@/lib/format";
import { stripImages } from "@/lib/images";
import { useNotes } from "@/store/notes";
import { NoteStatusIcon, SyncButton } from "./SyncStatus";
import type { Note } from "@/types/note";

interface SidebarProps {
  searchRef: React.RefObject<HTMLInputElement | null>;
  onOpenSettings: () => void;
}

export function Sidebar({ searchRef, onOpenSettings }: SidebarProps) {
  const { notes, select, selectedId, createNote } = useNotes();

  // Typing stays instant; React filters with the deferred value in the background.
  const [inputValue, setInputValue] = useState("");
  const query = useDeferredValue(inputValue);

  const groups = useMemo(() => {
    const filtered = notes.filter((n) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return n.title.toLowerCase().includes(q) || stripImages(n.content).toLowerCase().includes(q);
    });

    // Sort newest-first and group by date.
    const sorted = [...filtered].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    const result: { label: string; notes: Note[] }[] = [];
    for (const n of sorted) {
      const label = dateGroup(n.updated_at);
      const g = result.find((x) => x.label === label);
      if (g) g.notes.push(n);
      else result.push({ label, notes: [n] });
    }
    const groupOrder = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
    result.sort((a, b) => groupOrder.indexOf(a.label) - groupOrder.indexOf(b.label));
    return result;
  }, [notes, query]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-1 p-3 pb-2">
        <div className="relative min-w-0 flex-1" role="search">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Search notes…"
            aria-label="Search notes"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <SyncButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="New note" className="text-muted-foreground" onClick={() => createNote()}>
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New note (⌘N)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Settings" className="text-muted-foreground" onClick={onOpenSettings}>
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Settings</TooltipContent>
        </Tooltip>
      </div>

      <Separator />

      <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Note list">
        <div className="py-1 pr-2 pl-1">
          {groups.length === 0 && (
            <p className="px-3 py-6 text-xs text-muted-foreground">
              {query ? "No matching notes." : "No notes yet. Create your first one."}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <p className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {g.label}
              </p>
              {g.notes.map((n) => (
                <NoteItem
                  key={n.id}
                  note={n}
                  selected={n.id === selectedId}
                  onSelect={() => select(n.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NoteItem({
  note,
  selected,
  onSelect,
}: {
  note: Note;
  selected: boolean;
  onSelect: () => void;
}) {
  const preview = useMemo(() => snippet(stripImages(note.content)), [note.content]);
  return (
    <button
      onClick={onSelect}
      aria-current={selected || undefined}
      className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{note.title.trim() || "Untitled"}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{formatShort(note.updated_at)}</span>
        <NoteStatusIcon status={note.sync_status} />
      </span>
      {preview && <span className="truncate text-xs text-muted-foreground">{preview}</span>}
    </button>
  );
}
