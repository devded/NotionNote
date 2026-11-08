import { beforeEach, describe, expect, it, vi } from "vitest";

let page: any;
let body: any[];
const bodyReads: string[] = [];

vi.mock("../client", async (orig) => ({
  ...(await orig<typeof import("../client")>()),
  notionRequest: vi.fn(async (_method: string, path: string) => {
    if (path.endsWith("/query")) return { results: [page], has_more: false };
    if (path.startsWith("/blocks/")) {
      bodyReads.push(path);
      return { results: body, has_more: false };
    }
    return {};
  }),
  notionInvoke: vi.fn(),
}));

const { fetchNotes } = await import("../notes");

const para = (text: string) => ({ type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });

describe("fetchNotes body re-reads", () => {
  beforeEach(() => {
    bodyReads.length = 0;
    // Notion reports last_edited_time rounded down to the minute.
    page = {
      id: "p1",
      last_edited_time: "2026-11-08T10:05:00.000Z",
      properties: { Title: { title: [{ plain_text: "t" }] }, Content: { rich_text: [{ plain_text: "preview" }] } },
    };
    body = [para("edited in Notion")];
  });

  it("re-reads a page edited in the same minute as the last sync", async () => {
    // Synced at 10:05:30; the user then edits in Notion at 10:05:50 — the
    // page still says 10:05:00, so a strict "newer than" check misses it.
    const [n] = await fetchNotes("ds", new Map([["p1", "2026-11-08T10:05:30.000Z"]]));
    expect(bodyReads).toHaveLength(1);
    expect(n.content).toBe("edited in Notion");
  });

  it("skips the body read once the page's minute is well past the last sync", async () => {
    const [n] = await fetchNotes("ds", new Map([["p1", "2026-11-08T10:30:00.000Z"]]));
    expect(bodyReads).toHaveLength(0);
    // Not re-read: content must be left for the local copy, never the
    // truncated, image-less Content preview property.
    expect(n.content).toBeUndefined();
  });
});
