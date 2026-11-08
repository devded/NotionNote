import { describe, expect, it } from "vitest";
import { blockSyncKey, blocksToText, contentToBlocks, normalizeForCompare } from "../notes";

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

  it("splits lines longer than Notion's 2000-char rich_text limit", () => {
    const [block] = contentToBlocks("x".repeat(4500));
    expect(block.paragraph.rich_text.map((r: any) => r.text.content.length)).toEqual([2000, 2000, 500]);
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

describe("image blocks", () => {
  const line = "![image](local:abc-123.png)";

  it("maps local images to uploaded image blocks captioned with their name", () => {
    const [b] = contentToBlocks(line, new Map([["abc-123.png", "upload-1"]]));
    expect(b.type).toBe("image");
    expect(b.image.file_upload.id).toBe("upload-1");
    expect(b.image.caption[0].text.content).toBe("abc-123.png");
  });

  it("falls back to a paragraph when a local image was not uploaded", () => {
    expect(contentToBlocks(line)[0].type).toBe("paragraph");
  });

  it("round-trips an uploaded image as Notion returns it", () => {
    const fromNotion = {
      id: "blk",
      type: "image",
      image: {
        type: "file",
        file: { url: "https://s3.example/x/abc-123.png?sig=1" },
        caption: [{ plain_text: "abc-123.png" }],
      },
    };
    expect(blocksToText([fromNotion])).toBe(line);
  });

  it("names Notion-native images by block id and keeps external URLs", () => {
    const native = { id: "blk-1", type: "image", image: { type: "file", file: { url: "https://s3.example/a.JPG?x" }, caption: [] } };
    const external = { id: "blk-2", type: "image", image: { type: "external", external: { url: "https://e.com/i.png" } } };
    expect(blocksToText([native, external])).toBe("![image](local:blk-1.jpg)\n![image](https://e.com/i.png)");
    expect(contentToBlocks("![image](https://e.com/i.png)")[0].image.external.url).toBe("https://e.com/i.png");
  });
});

describe("image widths", () => {
  it("stores width in the caption and reads it back", () => {
    const [b] = contentToBlocks("![image|400](local:abc.png)", new Map([["abc.png", "u"]]));
    expect(b.image.caption[0].text.content).toBe("abc.png|400");
    const fromNotion = {
      id: "blk",
      type: "image",
      image: { type: "file", file: { url: "https://s3.example/abc.png" }, caption: [{ plain_text: "abc.png|400" }] },
    };
    expect(blocksToText([fromNotion])).toBe("![image|400](local:abc.png)");
  });
});

describe("task lists", () => {
  it("maps - [ ] / - [x] to Notion to_do blocks", () => {
    const blocks = contentToBlocks("- [ ] todo\n- [x] done\n- [X] Done\n- plain");
    expect(blocks.map((b) => b.type)).toEqual(["to_do", "to_do", "to_do", "bulleted_list_item"]);
    expect(blocks.slice(0, 3).map((b) => b.to_do.checked)).toEqual([false, true, true]);
    expect(blocks[0].to_do.rich_text[0].text.content).toBe("todo");
  });

  it("round-trips tasks through blocks and back", () => {
    const original = "- [ ] todo\n- [x] done\n- plain";
    expect(blocksToText(contentToBlocks(original))).toBe(original);
  });

  it("reads to_do blocks created in Notion", () => {
    const fromNotion = { type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "ship it" }] } };
    expect(blocksToText([fromNotion])).toBe("- [x] ship it");
  });

  it("treats an old bullet holding '[x] …' text as stale so sync rewrites it", () => {
    const oldBullet = { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "[x] Test" }] } };
    expect(blockSyncKey(oldBullet)).not.toBe("- [x] Test");
    expect(blockSyncKey(contentToBlocks("- [x] Test")[0])).toBe("- [x] Test");
  });
});
