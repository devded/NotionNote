import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
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
import { SettingsDialog } from "@/components/SettingsDialog";
import { Onboarding } from "@/components/Onboarding";
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const toggleSidebar = () => setSidebarOpen((o) => !o);
  const draggingRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useShortcuts({
    newNote: () => store.createNote(),
    save: () => store.flushSave(),
    sync: () => {
      store.flushSave();
      void store.syncNow();
    },
    focusSearch: () => {
      setSidebarOpen(true);
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    toggleSidebar,
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
        <div className="flex min-h-0 flex-1">
          {/* Hidden, not unmounted, so the search text and scroll position survive. */}
          <div className={sidebarOpen ? "contents" : "hidden"}>
          <div style={{ width: sidebarWidth }} className="h-full shrink-0">
            <Sidebar searchRef={searchRef} onOpenSettings={() => setShowSettings(true)} />
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
          </div>

          <main className="group/main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
                  aria-pressed={sidebarOpen}
                  onClick={toggleSidebar}
                  className={`absolute top-2 left-2 z-10 text-muted-foreground transition-opacity focus-visible:opacity-100 ${
                    sidebarOpen ? "opacity-0 group-hover/main:opacity-100" : ""
                  }`}
                >
                  <PanelLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{sidebarOpen ? "Hide sidebar" : "Show sidebar"} (Ctrl+\)</TooltipContent>
            </Tooltip>
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
