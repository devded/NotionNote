import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Local typing is instant; store updates are batched so every keystroke
  // doesn't re-render the whole app through context.
  const pendingRef = useRef<{ id: string; title?: string; content?: string } | null>(null);
  const debounceRef = useRef<number | null>(null);

  const flushPending = useCallback(() => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) updateNote(p.id, { ...(p.title !== undefined && { title: p.title }), ...(p.content !== undefined && { content: p.content }) });
  }, [updateNote]);

  const queueUpdate = useCallback(
    (id: string, patch: Partial<Pick<Note, "title" | "content">>) => {
      pendingRef.current = { ...(pendingRef.current ?? { id }), id, ...patch };
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        flushPending();
      }, 300);
    },
    [flushPending],
  );

  // Flush unsaved keystrokes when switching notes or unmounting.
  useEffect(() => {
    return () => flushPending();
  }, [flushPending]);

  // Update editor view when remote sync from Notion brings external updates
  // (Only when note is in synced state, never interrupting local in-progress typing)
  useEffect(() => {
    if (note && note.sync_status === "synced") {
      // Deliberate prop-to-state reconciliation on remote updates; narrowing
      // deps is intentional so only real content changes reset the fields.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(note.title ?? "");
      setContent(note.content ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.updated_at, note?.sync_status]);

  if (!note) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a note or press ⌘N to create one.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-full flex-1 flex-col">
        <div className="flex items-start justify-between gap-4 px-8 pt-6">
          <Input
            value={title}
            placeholder="Untitled"
            onChange={(e) => {
              const next = e.target.value;
              setTitle(next);
              queueUpdate(note.id, { title: next });
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

        <div
          className="flex min-h-0 flex-1 flex-col px-8 py-4 cursor-text"
          onClick={(e) => {
            if (e.target === e.currentTarget && textareaRef.current) {
              textareaRef.current.focus();
            }
          }}
        >
          <Textarea
            ref={textareaRef}
            value={content}
            placeholder="Write your note here…"
            onChange={(e) => {
              const next = e.target.value;
              setContent(next);
              queueUpdate(note.id, { content: next });
            }}
            className="min-h-48 w-full flex-1 resize-none border-none bg-transparent p-0 text-[15.5px] font-normal leading-[1.75] tracking-[-0.005em] text-foreground/90 placeholder:text-muted-foreground/50 shadow-none focus-visible:ring-0"
          />
        </div>

        <div className="flex items-center justify-end px-8 pt-2 pb-4">
          <EditorStatus note={note} />
        </div>
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
