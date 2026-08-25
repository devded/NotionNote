import { useCallback, useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sidebar } from "@/components/Sidebar";
import { NoteEditor } from "@/components/NoteEditor";
import { DeleteNoteDialog } from "@/components/DeleteNoteDialog";
import { SettingsDialog } from "@/components/Settings";
import { Onboarding } from "@/components/Onboarding";
import { SyncButton } from "@/components/SyncStatus";
import { useNotes } from "@/store/notes";
import { useShortcuts } from "@/hooks/useShortcuts";
import type { Note } from "@/types/note";

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 400;

export default function App() {
  const store = useNotes();
  const [showSettings, setShowSettings] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Note | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(264);
  const draggingRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useShortcuts({
    newNote: () => store.createNote(),
    save: () => store.flushSave(),
    sync: () => {
      store.flushSave();
      void store.syncNow();
    },
    focusSearch: () => searchRef.current?.focus(),
  });

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!draggingRef.current) return;
    setSidebarWidth(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, e.clientX)));
  }, []);
  const onDragEnd = useCallback(() => {
    draggingRef.current = false;
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
    return () => {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
    };
  }, [onDragMove, onDragEnd]);

  if (!store.ready) {
    return <div className="h-screen bg-background" />;
  }

  if (!store.config.connected) {
    return <Onboarding onConnected={() => window.location.reload()} />;
  }

  const selected = store.notes.find((n) => n.id === store.selectedId) ?? null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-11 shrink-0 items-center justify-between border-b px-3">
          <div className="flex items-center gap-2">
            <img src="/monolog-logo.svg" alt="Monolog" className="size-4.5 rounded" />
            <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
              Monolog
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <SyncButton />
            <Button variant="ghost" size="sm" onClick={() => store.createNote()}>
              + New Note
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={() => setShowSettings(true)}
                >
                  <Settings className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div style={{ width: sidebarWidth }} className="h-full shrink-0">
          <Sidebar searchRef={searchRef} />
          </div>

          <div
            onMouseDown={() => {
              draggingRef.current = true;
              document.body.style.cursor = "col-resize";
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                setSidebarWidth((w) => Math.max(MIN_SIDEBAR, w - 16));
                e.preventDefault();
              } else if (e.key === "ArrowRight") {
                setSidebarWidth((w) => Math.min(MAX_SIDEBAR, w + 16));
                e.preventDefault();
              } else if (e.key === "Home") {
                setSidebarWidth(MIN_SIDEBAR);
                e.preventDefault();
              } else if (e.key === "End") {
                setSidebarWidth(MAX_SIDEBAR);
                e.preventDefault();
              }
            }}
            className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40 focus-visible:bg-primary focus-visible:outline-none"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={MIN_SIDEBAR}
            aria-valuemax={MAX_SIDEBAR}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
          />

          <main className="flex min-w-0 flex-1 flex-col">
            <NoteEditor
              key={selected?.id ?? "none"}
              note={selected}
              onDeleteRequest={setDeleteTarget}
            />
          </main>
        </div>
      </div>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />

      <DeleteNoteDialog
        note={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) store.deleteNote(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </TooltipProvider>
  );
}
