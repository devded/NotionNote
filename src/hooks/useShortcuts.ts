import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Global keyboard shortcuts. Cmd on macOS, Ctrl on Linux/Windows. */
export function useShortcuts(opts: {
  newNote: () => void;
  save: () => void;
  focusSearch: () => void;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        optsRef.current.newNote();
      } else if (key === "s") {
        e.preventDefault();
        optsRef.current.save();
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
