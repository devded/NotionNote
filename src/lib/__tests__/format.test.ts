import { describe, expect, it } from "vitest";
import { dateGroup, formatRelative } from "../format";

describe("formatRelative", () => {
  it('returns "just now" within a minute', () => {
    const now = new Date().toISOString();
    expect(formatRelative(now)).toBe("just now");
  });

  it("returns empty string for invalid input", () => {
    expect(formatRelative("not-a-date")).toBe("");
  });

  it("formats minutes and hours", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatRelative(tenMinAgo)).toBe("10 minutes ago");
    expect(formatRelative(twoHoursAgo)).toBe("2 hours ago");
  });
});

describe("dateGroup", () => {
  it("buckets timestamps into the documented labels", () => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString();

    expect(dateGroup(iso(now))).toBe("Today");
    expect(
      dateGroup(iso(new Date(now.getTime() - 12 * 3_600_000))),
    ).toBe("Yesterday");
    expect(
      dateGroup(iso(new Date(now.getTime() - 5 * 86_400_000))),
    ).toBe("Previous 7 days");
    expect(
      dateGroup(iso(new Date(now.getTime() - 20 * 86_400_000))),
    ).toBe("Previous 30 days");
    expect(
      dateGroup(iso(new Date(now.getTime() - 90 * 86_400_000))),
    ).toBe("Older");
  });

  it("puts the exact boundary of midnight at Today/Yesterday correctly", () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    expect(dateGroup(startOfToday.toISOString())).toBe("Today");

    const lastNight = new Date(startOfToday.getTime() - 60_000);
    expect(dateGroup(lastNight.toISOString())).toBe("Yesterday");
  });
});
