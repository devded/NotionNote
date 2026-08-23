import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "./App";
import { NotesProvider } from "@/store/notes";
import { Toaster } from "@/components/ui/sonner";
import { ThemeBridge } from "@/components/ThemeBridge";
import "@/index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem themes={["system", "light", "dark", "kami"]}>
      <NotesProvider>
        <App />
        <ThemeBridge />
        <Toaster position="bottom-right" />
      </NotesProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
