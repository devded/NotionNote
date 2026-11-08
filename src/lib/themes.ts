export const THEME_OPTIONS = [
  { id: "system", label: "System", dark: false },
  { id: "light", label: "Light", dark: false },
  { id: "dark", label: "Dark", dark: true },
  { id: "herdr", label: "Herdr (Paper Light)", dark: false },
  { id: "nord", label: "Nord", dark: true },
  { id: "dracula", label: "Dracula", dark: true },
  { id: "gruvbox", label: "Gruvbox", dark: true },
  { id: "catppuccin", label: "Catppuccin Mocha", dark: true },
  { id: "solarized", label: "Solarized Light", dark: false },
] as const;

export type ThemeMode = (typeof THEME_OPTIONS)[number]["id"];

export const isTheme = (t: unknown): t is ThemeMode => THEME_OPTIONS.some((o) => o.id === t);

/** Apply a theme to the document and mirror it so startup can restore
 *  synchronously (before first paint) without waiting on async config I/O.
 *  Dark palettes also get `.dark` so Tailwind `dark:` variants apply. */
export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove(...THEME_OPTIONS.map((o) => o.id));
  try {
    localStorage.setItem("monolog-theme", JSON.stringify(theme));
  } catch {
    /* private mode etc. — non-fatal */
  }
  if (theme === "system") {
    root.classList.add(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    return;
  }
  root.classList.add(theme);
  if (THEME_OPTIONS.find((o) => o.id === theme)?.dark) root.classList.add("dark");
}
