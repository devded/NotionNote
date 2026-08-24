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
