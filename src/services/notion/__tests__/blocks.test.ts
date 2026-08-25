import { describe, expect, it } from "vitest";
import { blocksToText, contentToBlocks, normalizeForCompare } from "../notes";

describe("contentToBlocks", () => {
  it("maps markdown-lite constructs to Notion block types", () => {
    const blocks = contentToBlocks("# Title\n- item\n1. first\n> quote\npara");
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "bulleted_list_item",
      "numbered_list_item",
      "quote",
      "paragraph",
    ]);
    expect(blocks[0].heading_1.rich_text[0].text.content).toBe("Title");
  });

  it("drops blank lines and trailing whitespace", () => {
    const blocks = contentToBlocks("a\n\n   \nb  ");
    expect(blocks.map((b) => b.paragraph.rich_text[0].text.content)).toEqual(["a", "b"]);
  });

  it("returns empty array for empty/blank content", () => {
    expect(contentToBlocks("")).toEqual([]);
    expect(contentToBlocks("\n \n")).toEqual([]);
  });
});

describe("blocksToText round-trip", () => {
  it("round-trips content through blocks and back", () => {
    const original = "# Heading\nsome paragraph\n- bullet\n> quoted";
    const roundTripped = blocksToText(contentToBlocks(original));
    expect(normalizeForCompare(roundTripped)).toBe(normalizeForCompare(original));
  });

  it("skips archived/trashed blocks", () => {
    const blocks = contentToBlocks("kept").concat([
      { archived: true, type: "paragraph", paragraph: { rich_text: [{ plain_text: "gone" }] } },
    ]);
    expect(blocksToText(blocks)).toBe("kept");
  });

  it("joins multiple rich_text fragments per block", () => {
    const text = blocksToText([
      {
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "foo" }, { plain_text: "bar" }] },
      },
    ]);
    expect(text).toBe("foobar");
  });
});

describe("normalizeForCompare", () => {
  it("ignores trailing whitespace and blank lines", () => {
    expect(normalizeForCompare("a  \n\nb")).toBe(normalizeForCompare("a\nb"));
  });

  it("is case/content sensitive otherwise", () => {
    expect(normalizeForCompare("a")).not.toBe(normalizeForCompare("A"));
  });
});
