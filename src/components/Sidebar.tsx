import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { dateGroup } from "@/lib/format";
import { useNotes } from "@/store/notes";
import { NoteStatusIcon } from "./SyncStatus";
import type { Note } from "@/types/note";

interface SidebarProps {
  searchRef: React.RefObject<HTMLInputElement | null>;
}

export const Sidebar = forwardRef<HTMLDivElement, SidebarProps>(function Sidebar(
  { searchRef },
  ref,
) {
  const { notes, query, setQuery, select, selectedId } = useNotes();

  // Local input state keeps typing instant; the (expensive) store-wide query
  // update that drives filtering is debounced.
  const [inputValue, setInputValue] = useState(query);
  const debounceRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
  }, []);
  const onSearchChange = (value: string) => {
    setInputValue(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setQuery(value), 150);
  };

  const groups = useMemo(() => {
    const filtered = notes.filter((n) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q);
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
    <div ref={ref} className="flex h-full min-w-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="p-3 pb-2">
        <div className="relative" role="search">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={inputValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search notes…"
            aria-label="Search notes"
            className="h-8 pl-8 text-sm"
          />
        </div>
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
});

function NoteItem({
  note,
  selected,
  onSelect,
}: {
  note: Note;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{note.title.trim() || "Untitled"}</span>
      <NoteStatusIcon status={note.sync_status} />
    </button>
  );
}
