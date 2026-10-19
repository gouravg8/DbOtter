import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useApp } from "./lib/store";
import { applyTheme, resolveTheme } from "./lib/themes";
import "./styles.css";

// before the first paint, so a dark theme doesn't flash white
const { settings } = useApp.getState();
applyTheme(resolveTheme(settings.themeId, settings.customThemes, window.matchMedia("(prefers-color-scheme: dark)").matches));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
