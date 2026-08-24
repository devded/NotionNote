import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { NotesProvider } from "@/store/notes";
import { Toaster } from "@/components/ui/sonner";
import "@/index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NotesProvider>
      <App />
      <Toaster position="bottom-right" />
    </NotesProvider>
  </React.StrictMode>,
);
