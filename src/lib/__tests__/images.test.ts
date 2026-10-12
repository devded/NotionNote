import { describe, expect, it } from "vitest";
import { fromSegments, parseImageLine, toSegments } from "../images";

const img = "![image](local:a.png)";

describe("toSegments", () => {
  it("alternates text and images, starting and ending with text", () => {
    expect(toSegments(`a\n${img}\n${img}\nb`).map((s) => s.kind)).toEqual([
      "text", "image", "text", "image", "text",
    ]);
  });

  it("round-trips content around images", () => {
    expect(fromSegments(toSegments(`a\n${img}\nb`))).toBe(`a\n${img}\nb`);
  });

  it("is stable after one normalization pass", () => {
    for (const c of [img, `a\n\n${img}`, `${img}\n${img}`, "", "plain\ntext"]) {
      const once = fromSegments(toSegments(c));
      expect(fromSegments(toSegments(once))).toBe(once);
    }
  });
});

describe("parseImageLine", () => {
  it("reads Obsidian-style widths", () => {
    expect(parseImageLine("![image|320](local:a.png)")).toEqual({ ref: "local:a.png", width: 320 });
    expect(parseImageLine("![image](local:a.png)")).toEqual({ ref: "local:a.png" });
    expect(parseImageLine("not an image")).toBeNull();
  });
});
