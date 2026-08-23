export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24 && new Date(iso).toDateString() === new Date().toDateString()) {
    return `today at ${new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return new Date(iso).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
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
