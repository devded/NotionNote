import { useEffect } from "react";
import { useTheme } from "next-themes";
import { useNotes } from "@/store/notes";

/** Applies the persisted theme preference to next-themes. */
export function ThemeBridge() {
  const { theme } = useNotes();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (["system", "light", "dark", "kami", "herdr"].includes(theme)) {
      setTheme(theme);
    }
  }, [theme, setTheme]);

  return null;
}
