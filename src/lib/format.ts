const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.round((then - Date.now()) / 1000);
  if (Math.abs(sec) < 60) return "just now";
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return rtf.format(min, "minute");
  const hours = Math.round(min / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Group label for the sidebar list. */
export function dateGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (d >= startOfToday) return "Today";
  if (d >= new Date(startOfToday.getTime() - 86400000)) return "Yesterday";
  if (d >= new Date(startOfToday.getTime() - 7 * 86400000)) return "Previous 7 days";
  if (d >= new Date(startOfToday.getTime() - 30 * 86400000)) return "Previous 30 days";
  return "Older";
}

/** Compact list timestamp: time today, weekday this week, else "Oct 3". */
export function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const group = dateGroup(iso);
  if (group === "Today") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (group === "Yesterday" || group === "Previous 7 days") return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Strip markdown markers from one line: list bullets, checkboxes, headings, quotes, emphasis. */
const plain = (line: string) =>
  line
    .replace(/^\s*(?:[-+*]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^#{1,6}\s+|^>\s?/, "")
    .replace(/[*_`~]/g, "")
    .trim();

/** One-line plain-text preview of a note body (images already stripped). */
export function snippet(content: string, max = 120): string {
  return content.split("\n").map(plain).filter(Boolean).join(" ").slice(0, max);
}

/** ATX headings (levels 1-3) outside fenced code, with 1-based line numbers. */
export function headingsOf(text: string): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = [];
  let fenced = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const m = !fenced && /^(#{1,3})\s+(.+)$/.exec(l);
    if (m) out.push({ level: m[1].length, text: plain(m[2]), line: i + 1 });
  });
  return out;
}
