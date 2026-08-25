import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { NotesProvider } from "@/store/notes";
import { Toaster } from "@/components/ui/sonner";
import "@/index.css";

// Restore the user's theme synchronously, before first render/paint, so dark
// or themed users never see a flash of the default light UI. This reads the
// localStorage mirror written by the store; the async config load reconciles
// with the source of truth shortly after.
(function restoreThemeEarly() {
  const root = document.documentElement;
  root.classList.remove("light", "dark", "herdr");
  let theme = "system";
  try {
    theme = JSON.parse(localStorage.getItem("monolog-theme") ?? '"system"');
  } catch {
    /* fall through to system */
  }
  if (theme === "light" || theme === "dark" || theme === "herdr") {
    root.classList.add(theme);
  } else {
    root.classList.add(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NotesProvider>
      <App />
      <Toaster position="bottom-right" />
    </NotesProvider>
  </React.StrictMode>,
);
