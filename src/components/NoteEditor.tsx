import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import { LOCAL_PREFIX, fromSegments, localImageUrl, pasteClipboardImage, saveImage, toSegments } from "@/lib/images";
import type { Note } from "@/types/note";

interface NoteEditorProps {
  note: Note | null;
  onDeleteRequest: (note: Note) => void;
}

export function NoteEditor({ note, onDeleteRequest }: NoteEditorProps) {
  const { updateNote } = useNotes();
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");

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

  const segments = useMemo(() => toSegments(content), [content]);
  // Latest content for async paste handlers; refs are synced after render.
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  });
  const textRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const commit = (id: string, next: string) => {
    contentRef.current = next;
    setContent(next);
    queueUpdate(id, { content: next });
  };

  const focusAt = (index: number, caret: number) =>
    requestAnimationFrame(() => {
      const el = textRefs.current[index];
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });

  /** Remove image segment k, merging the text around it. */
  const removeImage = (id: string, k: number) => {
    const segs = toSegments(contentRef.current);
    const prev = segs[k - 1];
    const next = segs[k + 1];
    if (segs[k]?.kind !== "image" || prev?.kind !== "text" || next?.kind !== "text") return;
    const merged = prev.text && next.text ? `${prev.text}\n${next.text}` : prev.text + next.text;
    commit(id, fromSegments([...segs.slice(0, k - 1), { kind: "text", text: merged }, ...segs.slice(k + 2)]));
    focusAt(k - 1, prev.text.length);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>, index: number) => {
    if (!note) return;
    const id = note.id;
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    // Text pastes go through untouched; an "empty" paste may be an image the
    // webview couldn't see, so ask the native clipboard.
    if (files.length === 0 && e.clipboardData.getData("text/plain")) return;
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end } = e.currentTarget;
    let lines: string[];
    try {
      if (files.length > 0) {
        lines = await Promise.all(files.map(saveImage));
      } else {
        const line = await pasteClipboardImage();
        if (!line) return;
        lines = [line];
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not paste image: ${err}`);
      return;
    }
    // Editor is keyed per note: a null ref means the user switched away.
    if (!textRefs.current[index]) return;
    const segs = toSegments(contentRef.current);
    const seg = segs[index];
    if (seg?.kind !== "text") return;
    const text = `${seg.text.slice(0, start)}\n${lines.join("\n")}\n${seg.text.slice(end)}`;
    commit(id, fromSegments(segs.map((s, j) => (j === index ? { kind: "text", text } : s))));
    // Caret goes to the start of the text right after the last pasted image.
    focusAt(index + 2 * lines.length, 0);
  };

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
        <div className="flex items-center justify-between gap-4 px-8 pt-6">
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
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground/75 select-none">
              Updated {formatRelative(note.updated_at)}
            </span>
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
        </div>

        <Separator className="mx-8 mt-3 w-[calc(100%-4rem)]" />

        <div
          className="flex min-h-0 flex-1 flex-col px-8 py-4 cursor-text"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              textRefs.current[segments.length - 1]?.focus();
            }
          }}
        >
          {segments.map((seg, i) =>
            seg.kind === "image" ? (
              <NoteImage key={`${i}-image`} src={seg.ref} onRemove={() => removeImage(note.id, i)} />
            ) : (
              <Textarea
                key={`${i}-text`}
                ref={(el) => {
                  textRefs.current[i] = el;
                }}
                value={seg.text}
                placeholder={segments.length === 1 ? "Write your note here…" : undefined}
                onChange={(e) => {
                  const text = e.target.value;
                  commit(note.id, fromSegments(segments.map((s, j) => (j === i ? { kind: "text", text } : s))));
                }}
                onKeyDown={(e) => {
                  // Backspace at the very start of text deletes the image above it.
                  const el = e.currentTarget;
                  if (e.key === "Backspace" && i > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
                    e.preventDefault();
                    removeImage(note.id, i - 1);
                  }
                }}
                onPaste={(e) => handlePaste(e, i)}
                className={cn(
                  "min-h-0 w-full resize-none border-none bg-transparent p-0 text-[15.5px] font-normal leading-[1.75] tracking-[-0.005em] text-foreground/90 placeholder:text-muted-foreground/50 shadow-none focus-visible:ring-0",
                  i === segments.length - 1 && "min-h-24 flex-1",
                )}
              />
            ),
          )}
        </div>

        <div className="flex items-center justify-end px-8 pt-2 pb-4">
          <EditorStatus note={note} />
        </div>
      </div>
    </div>
  );
}

function NoteImage({ src, onRemove }: { src: string; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(src.startsWith(LOCAL_PREFIX) ? null : src);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src.startsWith(LOCAL_PREFIX)) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    localImageUrl(src.slice(LOCAL_PREFIX.length))
      .then((u) => {
        objectUrl = u;
        if (cancelled) URL.revokeObjectURL(u);
        else setUrl(u);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  return (
    <div className="group relative my-2 self-start rounded-lg border bg-muted/40 p-1">
      {failed ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">Image unavailable</div>
      ) : url ? (
        <img
          src={url}
          alt=""
          onError={() => setFailed(true)}
          className="block max-h-[28rem] max-w-full rounded-md object-contain"
        />
      ) : (
        <div className="size-24" />
      )}
      <Button
        variant="secondary"
        size="icon"
        aria-label="Remove image"
        onClick={onRemove}
        className="absolute top-2 right-2 size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-4" />
      </Button>
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
