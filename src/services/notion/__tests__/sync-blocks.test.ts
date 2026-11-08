import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types/note";

const calls: { method: string; path: string; body?: any }[] = [];
let pageBlocks: any[] = [];
/** Children returned for GET /blocks/<id>/children of a nested block. */
let childrenOf: Record<string, any[]> = {};

vi.mock("../client", async (orig) => ({
  ...(await orig<typeof import("../client")>()),
  notionRequest: vi.fn(async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (method === "GET") {
      const id = path.split("/")[2];
      return { results: childrenOf[id] ?? pageBlocks, has_more: false };
    }
    return { last_edited_time: "2026-01-01T00:00:00.000Z" };
  }),
  notionInvoke: vi.fn(async () => "upload-id"),
}));

const { pushUpdateNote } = await import("../notes");

const para = (id: string, text: string) => ({
  id,
  type: "paragraph",
  paragraph: { rich_text: [{ plain_text: text }] },
});
const note = (content: string) => ({ notion_page_id: "page", title: "t", content }) as Note;
const bodyCalls = () => calls.filter((c) => c.path.startsWith("/blocks"));

describe("pushUpdateNote block diffing", () => {
  beforeEach(() => {
    calls.length = 0;
    pageBlocks = [para("b1", "a"), para("blank", ""), para("b2", "b"), para("b3", "c")];
  });

  it("does nothing beyond the read when content matches (blank blocks ignored)", async () => {
    await pushUpdateNote(note("a\nb\nc"));
    expect(bodyCalls().map((c) => c.method)).toEqual(["GET"]);
  });

  it("only replaces blocks after the unchanged prefix", async () => {
    await pushUpdateNote(note("a\nb\nC!\nd"));
    const writes = bodyCalls().filter((c) => c.method !== "GET");
    expect(writes[0].body.children.map((b: any) => b.paragraph.rich_text[0].text.content)).toEqual(["C!", "d"]);
    expect(writes.slice(1).map((c) => c.path)).toEqual(["/blocks/b3"]);
  });

  it("deletes trailing blocks when content shrinks", async () => {
    await pushUpdateNote(note("a"));
    const writes = bodyCalls().filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /blocks/b2", "DELETE /blocks/b3"]);
  });
});

describe("pushUpdateNote with nested blocks", () => {
  const bullet = (id: string, text: string, has_children = false) => ({
    id,
    type: "bulleted_list_item",
    has_children,
    bulleted_list_item: { rich_text: [{ plain_text: text }] },
  });

  beforeEach(() => {
    calls.length = 0;
    pageBlocks = [bullet("b1", "a", true), para("z", "z")];
    childrenOf = { b1: [bullet("b1c", "b")] };
  });

  it("treats an unchanged nested item as unchanged", async () => {
    await pushUpdateNote(note("- a\n  - b\nz"));
    expect(bodyCalls().filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("rewrites a top-level block when one of its children changed", async () => {
    await pushUpdateNote(note("- a\n  - B!\nz"));
    const append = bodyCalls().find((c) => c.method === "PATCH")!;
    expect(append.body.children[0].bulleted_list_item.children[0].bulleted_list_item.rich_text[0].text.content).toBe("B!");
    expect(bodyCalls().filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/blocks/b1", "/blocks/z"]);
  });
});

