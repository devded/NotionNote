export type SyncStatus = "synced" | "pending" | "error";

export interface Note {
  /** Local id (uuid). */
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  sync_status: SyncStatus;
  /** Notion page id once the note exists in Notion. */
  notion_page_id: string | null;
  /** ISO timestamp of the last successful sync of this note. */
  last_synced_at: string | null;
}

export interface PersistedNotes {
  version: 1;
  notes: Note[];
  /** Notion page ids waiting to be archived (deleted while offline). */
  pendingDeletes: string[];
}

export type ThemeMode = "system" | "light" | "dark";

export interface AppConfig {
  database_name: string;
  database_id: string | null;
  data_source_id: string | null;
  connected: boolean;
}

/** Result of the connect/ensure-database flow shown during onboarding. */
export interface ConnectResult {
  databaseId: string;
  dataSourceId: string;
  existed: boolean;
}
