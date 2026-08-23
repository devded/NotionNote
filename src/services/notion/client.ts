import { invoke } from "@tauri-apps/api/core";

/**
 * Error thrown by the Notion service layer. Carries a user-friendly message;
 * technical details are logged locally only.
 */
export class NotionError extends Error {
  code: string;
  status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "NotionError";
  }
}

function friendlyError(payload: any): NotionError {
  const rawCode: string = payload?.code ?? "unknown_error";
  const status: number | undefined = payload?.status;
  let detail = "";
  try {
    const body = typeof payload?.message === "string" && payload.message.startsWith("{")
      ? JSON.parse(payload.message)
      : payload?.message;
    if (typeof body === "string") detail = body;
    else if (body?.message) detail = body.message;
  } catch {
    detail = String(payload?.message ?? "");
  }
  console.debug("[notion] request failed:", rawCode, status);

  switch (rawCode) {
    case "unauthorized":
      return new NotionError(rawCode,
        "Your Notion API key was rejected. Please check the key in Settings.", status);
    case "network_error":
      return new NotionError(rawCode,
        "You appear to be offline. Notes are saved locally and will sync when you reconnect.", status);
    case "http_401":
    case "http_403":
      return new NotionError("unauthorized",
        "Unable to access Notion. Please check your API key and make sure the database is shared with your integration.", status);
    case "http_404":
      return new NotionError("not_found",
        "The Notion database could not be found. It may have been deleted or is no longer shared with your integration.", status);
    case "http_429":
      return new NotionError("rate_limited",
        "Notion is rate limiting requests. Retrying automatically…", status);
    case "http_400":
    case "http_409":
      return new NotionError(rawCode,
        `Notion rejected the request: ${detail || "invalid data."}`, status);
    default:
      if (rawCode.startsWith("http_5")) {
        return new NotionError("server_error",
          "Notion is having server issues. Your notes are safe locally; we will retry.", status);
      }
      return new NotionError(rawCode, `Unable to reach Notion. ${detail}`.trim(), status);
  }
}

/** Perform an authenticated Notion API request through the Tauri backend. */
export async function notionRequest<T = any>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    return await invoke<Value>("notion_request", {
      method,
      path,
      body: body ? JSON.parse(JSON.stringify(body)) : null,
    }) as T;
  } catch (e) {
    let payload: any = null;
    try {
      payload = JSON.parse(String(e));
    } catch {
      payload = { code: "unknown_error", message: String(e) };
    }
    throw friendlyError(payload);
  }
}

type Value = unknown;

// Shared helpers -----------------------------------------------------------

export function richTextToPlain(rt: any[] | undefined | null): string {
  return (rt ?? []).map((r) => r.plain_text ?? "").join("");
}

/** Split plain text into Notion rich_text objects (2000 char/item limit). */
export function plainToRichText(text: string): any[] {
  const chunks: any[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  }
  return chunks.length > 0 ? chunks : [];
}
