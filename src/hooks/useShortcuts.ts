import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Global keyboard shortcuts. Cmd on macOS, Ctrl on Linux/Windows. */
export function useShortcuts(opts: {
  newNote: () => void;
  save: () => void;
  focusSearch: () => void;
  sync?: () => void;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F5") {
        e.preventDefault();
        optsRef.current.sync?.();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        optsRef.current.newNote();
      } else if (key === "s") {
        e.preventDefault();
        optsRef.current.save();
      } else if (key === "r") {
        e.preventDefault();
        optsRef.current.sync?.();
      } else if (key === "f") {
        e.preventDefault();
        optsRef.current.focusSearch();
      } else if (key === "w") {
        e.preventDefault();
        void getCurrentWindow().close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
