import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Global keyboard shortcuts. Cmd on macOS, Ctrl on Linux/Windows. */
export function useShortcuts(opts: {
  newNote: () => void;
  save: () => void;
  focusSearch: () => void;
  sync: () => void;
}) {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const o = optsRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const action =
        e.key === "F5"
          ? o.sync
          : mod
            ? {
                n: o.newNote,
                s: o.save,
                r: o.sync,
                f: o.focusSearch,
                w: () => void getCurrentWindow().close(),
              }[e.key.toLowerCase()]
            : undefined;
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
