import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, Note, PersistedNotes, SyncStatus, ThemeMode } from "@/types/note";
import { ensureDatabase } from "@/services/notion/database";
import {
  fetchNotes,
  pushCreateNote,
  pushDeleteNote,
  pushUpdateNote,
} from "@/services/notion/notes";
import { parsePersistedNotes } from "@/lib/persistence";
import { mergeRemoteAndLocal, type PushResult } from "@/lib/sync-merge";

export type GlobalSyncState = "idle" | "syncing" | "offline" | "error";

interface NotesStore {
  ready: boolean;
  config: AppConfig;
  notes: Note[];
  selectedId: string | null;
  query: string;
  online: boolean;
  globalSync: GlobalSyncState;
  lastSyncAt: string | null;

  setQuery(q: string): void;
  select(id: string | null): void;

  createNote(): string;
  updateNote(id: string, patch: Partial<Pick<Note, "title" | "content">>): void;
  deleteNote(id: string): void;
  flushSave(): void;
  syncNow(): Promise<void>;

  /** Run the ensure-database flow and persist the result. */
  connect(apiKey: string, dbName: string): Promise<{ existed: boolean }>;
  disconnect(): Promise<void>;
  clearCache(): Promise<void>;
  testConnection(): Promise<void>;
  setTheme(theme: ThemeMode): void;
  theme: ThemeMode;
}

/** Delay before the next automatic retry: exponential backoff capped at 60s. */
function nextRetryDelay(failures: number): number {
  return Math.min(1200 * 2 ** failures, 60_000);
}

const Ctx = createContext<NotesStore | null>(null);

const emptyPersisted: PersistedNotes = {
  version: 1,
  notes: [],
  pendingDeletes: [],
};

const THEME_CLASSES: ThemeMode[] = ["light", "dark", "herdr"];

/** Apply a theme to the document and mirror it so startup can restore
 *  synchronously (before first paint) without waiting on async config I/O. */
function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove(...THEME_CLASSES);
  try {
    localStorage.setItem("monolog-theme", JSON.stringify(theme));
  } catch {
    /* private mode etc. — non-fatal */
  }
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.add(prefersDark ? "dark" : "light");
  } else {
    root.classList.add(theme);
  }
}

export function NotesProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AppConfig>({
    database_name: "random_notes_desktop",
    database_id: null,
    data_source_id: null,
    connected: false,
  });
  const [persisted, setPersisted] = useState<PersistedNotes>(emptyPersisted);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQueryState] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [globalSync, setGlobalSync] = useState<GlobalSyncState>("idle");
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemeMode>("system");

  // Mutable mirror so the sync engine always sees fresh data.
  const storeRef = useRef<PersistedNotes>(emptyPersisted);
  const syncingRef = useRef(false);
  const syncTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  /** Consecutive sync failures — drives exponential backoff between attempts. */
  const syncFailures = useRef(0);

  const applyPersisted = useCallback((p: PersistedNotes) => {
    storeRef.current = p;
    setPersisted(p);
  }, []);

  const persistNow = useCallback(async () => {
    await invoke("save_notes", { notes: storeRef.current });
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void persistNow();
    }, 400);
  }, [persistNow]);

  // Indirection so scheduleSync can fire the sync engine regardless of
  // declaration order (runSync is defined below); assigned in an effect.
  const syncFnRef = useRef<(() => Promise<void>) | null>(null);

  const scheduleSync = useCallback((delay = 1200) => {
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = null;
      void syncFnRef.current?.();
    }, delay);
  }, []);

  const mutate = useCallback(
    (fn: (p: PersistedNotes) => PersistedNotes) => {
      const next = fn(storeRef.current);
      applyPersisted(next);
      scheduleSave();
      scheduleSync(1200);
    },
    [applyPersisted, scheduleSave, scheduleSync],
  );

  // ------------------------------------------------------------------ sync

  const runSync = useCallback(async () => {
    if (syncingRef.current) return;
    if (!navigator.onLine || !configRef.current.connected) return;
    const cfg = configRef.current;
    if (!cfg.data_source_id) return;

    syncingRef.current = true;
    setGlobalSync("syncing");
    let hadError = false;

    // Anything not yet confirmed synced needs a push — this includes notes
    // previously marked "error" so failures are retried automatically.
    const needsPush = (n: Note): boolean => n.sync_status !== "synced";
    try {
      // 1. Process pending deletes in Notion.
      // A single failed delete must not abort the others.
      const remainingPendingDeletes: string[] = [];
      for (const pageId of storeRef.current.pendingDeletes) {
        try {
          await pushDeleteNote(pageId);
        } catch (e: any) {
          if (e?.code === "http_404" || e?.code === "not_found") continue; // already gone
          remainingPendingDeletes.push(pageId);
        }
      }

      // 2. Snapshot pending notes before network calls to detect subsequent typing
      const pendingSnapshots = new Map<
        string,
        { title: string; content: string }
      >();
      for (const n of storeRef.current.notes) {
        if (needsPush(n)) {
          pendingSnapshots.set(n.id, { title: n.title, content: n.content });
        }
      }

      // 3. Fetch remote notes from Notion
      const known = new Map(
        storeRef.current.notes
          .filter((n) => n.notion_page_id && n.sync_status !== "pending")
          .map((n) => [n.notion_page_id!, n.last_synced_at] as const),
      );
      const remote = await fetchNotes(cfg.data_source_id, known);

      // 4. Push pending notes to Notion
      const pushResults = new Map<string, PushResult>();

      for (const [noteId, snapshot] of pendingSnapshots.entries()) {
        const currentLocal = storeRef.current.notes.find((n) => n.id === noteId);
        if (!currentLocal) continue;

        if (!currentLocal.notion_page_id) {
          const res = await pushCreateNote(cfg.data_source_id, currentLocal);
          pushResults.set(noteId, {
            lastEditedTime: res.lastEditedTime,
            pageId: res.pageId,
            snapshot,
          });
        } else {
          const res = await pushUpdateNote(currentLocal);
          pushResults.set(noteId, {
            lastEditedTime: res.lastEditedTime,
            pageId: currentLocal.notion_page_id,
            snapshot,
          });
        }
      }

      // 5. Merge remote notes with freshest storeRef.current (pure, tested)
      const fresh = storeRef.current;
      const { merged, hasMorePending } = mergeRemoteAndLocal({
        remote,
        localNotes: fresh.notes,
        pushResults,
        pendingDeleteIds: remainingPendingDeletes,
      });

      applyPersisted({
        version: 1,
        notes: merged,
        pendingDeletes: remainingPendingDeletes,
      });
      await persistNow();
      setLastSyncAt(new Date().toISOString());
      syncFailures.current = 0;

      if (hasMorePending) {
        scheduleSync(nextRetryDelay(syncFailures.current));
      }
    } catch (e: any) {
      console.debug("[sync] failed:", e?.message ?? e);
      hadError = true;
      syncFailures.current += 1;
      if (e?.code !== "network_error") markFailed();
    } finally {
      syncingRef.current = false;
      setGlobalSync(hadError ? "error" : navigator.onLine ? "idle" : "offline");
    }

    function markFailed() {
      applyPersisted({
        ...storeRef.current,
        notes: storeRef.current.notes.map((n) =>
          n.sync_status === "pending" ? { ...n, sync_status: "error" as SyncStatus } : n,
        ),
      });
    }
  }, [applyPersisted, persistNow, scheduleSync]);

  // Keep refs in sync with state for use inside async engine.
  const configRef = useRef(config);

  // Ref mirrors are updated in effects, never during render.
  useEffect(() => {
    configRef.current = { ...config };
    syncFnRef.current = runSync;
  });

  // ------------------------------------------------------------------ init

  useEffect(() => {
    (async () => {
      try {
        const cfg = (await invoke("load_config")) as AppConfig;
        setConfig({ ...cfg });
        configRef.current = { ...cfg };
        const savedTheme = cfg.theme;
        if (
          savedTheme === "light" ||
          savedTheme === "dark" ||
          savedTheme === "system" ||
          savedTheme === "herdr"
        ) {
          // "kami" was removed; old configs fall back to "system".
          setThemeState(savedTheme as ThemeMode);
          applyTheme(savedTheme as ThemeMode);
        } else {
          applyTheme("system");
        }
        const saved = parsePersistedNotes(await invoke("load_notes"));
        applyPersisted({
          version: 1,
          notes: saved?.notes ?? [],
          pendingDeletes: saved?.pendingDeletes ?? [],
        });
        if (saved?.notes?.length > 0) setSelectedId(saved.notes[0].id);
        if (cfg.connected) scheduleSync(300);
      } finally {
        setReady(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync theme changes to document root
  useEffect(() => {
    applyTheme(theme);
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const listener = () => applyTheme("system");
      mq.addEventListener("change", listener);
      return () => mq.removeEventListener("change", listener);
    }
  }, [theme]);

  // Connectivity, window focus & periodic sync events.
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      scheduleSync(100);
    };
    const goOffline = () => setOnline(false);
    const onFocus = () => {
      if (navigator.onLine && configRef.current.connected) {
        scheduleSync(100);
      }
    };
    const onVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        navigator.onLine &&
        configRef.current.connected
      ) {
        scheduleSync(100);
      }
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Periodic sync polling to detect Notion edits in background.
    // Skipped while hidden — returning to the app re-triggers a sync via
    // focus/visibilitychange, so nothing is missed.
    const iv = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        navigator.onLine &&
        configRef.current.connected
      ) {
        void runSync();
      }
    }, 15000);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(iv);
    };
  }, [runSync, scheduleSync]);

  // ------------------------------------------------------------------ api

  const createNote = useCallback((): string => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const note: Note = {
      id,
      title: "",
      content: "",
      created_at: now,
      updated_at: now,
      sync_status: "pending",
      notion_page_id: null,
      last_synced_at: null,
    };
    mutate((p) => ({ ...p, notes: [note, ...p.notes] }));
    setSelectedId(id);
    return id;
  }, [mutate]);

  const updateNote = useCallback(
    (id: string, patch: Partial<Pick<Note, "title" | "content">>) => {
      mutate((p) => ({
        ...p,
        notes: p.notes.map((n) =>
          n.id === id
            ? {
                ...n,
                ...patch,
                updated_at: new Date().toISOString(),
                sync_status: "pending",
              }
            : n,
        ),
      }));
    },
    [mutate],
  );

  const deleteNote = useCallback(
    (id: string) => {
      let pageId: string | null = null;
      mutate((p) => {
        const target = p.notes.find((n) => n.id === id);
        pageId = target?.notion_page_id ?? null;
        return {
          ...p,
          notes: p.notes.filter((n) => n.id !== id),
          pendingDeletes:
            pageId != null ? [...new Set([...p.pendingDeletes, pageId])] : p.pendingDeletes,
        };
      });
      setSelectedId((cur) => {
        if (cur !== id) return cur;
        const rest = storeRef.current.notes.filter((n) => n.id !== id);
        return rest[0]?.id ?? null;
      });
    },
    [mutate],
  );

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void persistNow();
  }, [persistNow]);

  // Flush pending writes before the window closes or reloads so the 400ms
  // save debounce can never swallow the user's last keystrokes.
  useEffect(() => {
    const win = getCurrentWindow();
    let closing = false;
    const unlisten = win.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      try {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        await persistNow();
      } catch (e) {
        console.debug("[exit] final save failed:", e);
      } finally {
        void win.destroy();
      }
    });
    // Covers reloads (Cmd+R / devtools refresh), which bypass onCloseRequested.
    const onPageHide = () => void persistNow().catch(() => {});
    window.addEventListener("pagehide", onPageHide);
    return () => {
      void unlisten.then((fn) => fn());
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [persistNow]);

  const connect = useCallback(
    async (apiKey: string, dbName: string) => {
      await invoke("set_api_key", { key: apiKey });
      const result = await ensureDatabase(dbName, {
        databaseId: configRef.current.database_id,
        dataSourceId: configRef.current.data_source_id,
      });
      const next: AppConfig = {
        database_name: dbName,
        database_id: result.databaseId,
        data_source_id: result.dataSourceId,
        connected: true,
      };
      setConfig(next);
      configRef.current = { ...next };
      await invoke("save_config", { config: { ...next, theme } });
      // First pull from Notion
      const remote = await fetchNotes(result.dataSourceId);
      const existing = storeRef.current.notes;
      const byPageId = new Map(existing.map((n) => [n.notion_page_id ?? n.id, n]));
      const merged = [...remote];
      for (const n of existing) {
        if (n.sync_status === "pending" || !byPageId.has(n.notion_page_id ?? "")) {
          if (!merged.some((m) => m.id === n.id)) merged.unshift(n);
        }
      }
      applyPersisted({ version: 1, notes: merged, pendingDeletes: [] });
      await persistNow();
      setSelectedId((cur) => cur ?? merged[0]?.id ?? null);
      return { existed: result.existed };
    },
    [applyPersisted, persistNow, theme],
  );

  const disconnect = useCallback(async () => {
    await invoke("delete_api_key");
    const next: AppConfig = {
      database_name: configRef.current.database_name || "random_notes_desktop",
      database_id: null,
      data_source_id: null,
      connected: false,
    };
    setConfig(next);
    configRef.current = next;
    await invoke("save_config", { config: { ...next, theme } });
  }, [theme]);

  const clearCache = useCallback(async () => {
    await invoke("clear_local_cache");
    applyPersisted(emptyPersisted);
    setSelectedId(null);
  }, [applyPersisted]);

  const testConnection = useCallback(async () => {
    // Verifies the stored key still works and that the database still exists;
    // refreshes cached ids if Notion reassigned them.
    const result = await ensureDatabase(configRef.current.database_name, {
      databaseId: configRef.current.database_id,
      dataSourceId: configRef.current.data_source_id,
    });
    if (
      result.dataSourceId !== configRef.current.data_source_id ||
      result.databaseId !== configRef.current.database_id
    ) {
      const next: AppConfig = {
        ...configRef.current,
        database_id: result.databaseId,
        data_source_id: result.dataSourceId,
      };
      setConfig(next);
      configRef.current = { ...next };
      await invoke("save_config", { config: { ...next, theme } });
    }
  }, [theme]);

  const setTheme = useCallback(
    (t: ThemeMode) => {
      setThemeState(t);
      applyTheme(t);
      void invoke("save_config", {
        config: { ...configRef.current, theme: t },
      }).catch(console.debug);
    },
    [],
  );

  const value = useMemo<NotesStore>(
    () => ({
      ready,
      config,
      notes: persisted.notes,
      selectedId,
      query,
      online,
      globalSync,
      lastSyncAt,
      theme,
      setQuery: setQueryState,
      select: setSelectedId,
      createNote,
      updateNote,
      deleteNote,
      flushSave,
      syncNow: runSync,
      connect,
      disconnect,
      clearCache,
      testConnection,
      setTheme,
    }),
    [
      ready,
      config,
      persisted.notes,
      selectedId,
      query,
      online,
      globalSync,
      lastSyncAt,
      theme,
      createNote,
      updateNote,
      deleteNote,
      flushSave,
      runSync,
      connect,
      disconnect,
      clearCache,
      testConnection,
      setTheme,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotes(): NotesStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotes must be used within NotesProvider");
  return ctx;
}
