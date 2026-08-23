import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNotes } from "@/store/notes";
import { formatRelative } from "@/lib/format";
import type { Note } from "@/types/note";

interface NoteEditorProps {
  note: Note | null;
  onDeleteRequest: (note: Note) => void;
}

export function NoteEditor({ note, onDeleteRequest }: NoteEditorProps) {
  const { updateNote } = useNotes();
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");

  // Update editor view when remote sync from Notion brings external updates
  // (Only when note is in synced state, never interrupting local in-progress typing)
  useEffect(() => {
    if (note && note.sync_status === "synced") {
      setTitle(note.title ?? "");
      setContent(note.content ?? "");
    }
  }, [note?.updated_at, note?.sync_status]);

  if (!note) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a note or press ⌘N to create one.
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-4 px-8 pt-6">
        <Input
          value={title}
          placeholder="Untitled"
          onChange={(e) => {
            const next = e.target.value;
            setTitle(next);
            updateNote(note.id, { title: next });
          }}
          className="note-title h-auto border-none bg-transparent px-0 text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onDeleteRequest(note)}
            >
              <Trash2 className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete note</TooltipContent>
        </Tooltip>
      </div>

      <p className="px-8 pt-1 text-xs text-muted-foreground">
        Updated {formatRelative(note.updated_at)}
      </p>

      <Separator className="mx-8 mt-4 w-[calc(100%-4rem)]" />

      <Textarea
        value={content}
        placeholder="Write your note here…"
        onChange={(e) => {
          const next = e.target.value;
          setContent(next);
          updateNote(note.id, { content: next });
        }}
        className="min-h-0 flex-1 resize-none border-none bg-transparent px-8 py-4 text-[15px] leading-relaxed shadow-none focus-visible:ring-0"
      />

      <div className="flex items-center justify-end px-8 pb-3">
        <EditorStatus note={note} />
      </div>
    </div>
  );
}

function EditorStatus({ note }: { note: Note }) {
  const { online, globalSync } = useNotes();
  const [savedFlash, setSavedFlash] = useState(false);
  const prevUpdated = useRef(note.updated_at);

  useEffect(() => {
    if (prevUpdated.current !== note.updated_at) {
      prevUpdated.current = note.updated_at;
      setSavedFlash(true);
      const t = setTimeout(() => setSavedFlash(false), 1200);
      return () => clearTimeout(t);
    }
  }, [note.updated_at]);

  const label = useMemo(() => {
    if (!online) return "Saved locally · waiting to sync";
    if (note.sync_status === "synced") return savedFlash ? "Saved" : "✓ Synced";
    if (note.sync_status === "error") return "Sync failed — will retry";
    if (globalSync === "syncing") return "↻ Syncing…";
    return savedFlash ? "Saved" : "⚠ Waiting to sync";
  }, [online, note.sync_status, globalSync, savedFlash]);

  return <span className="text-xs text-muted-foreground">{label}</span>;
}
