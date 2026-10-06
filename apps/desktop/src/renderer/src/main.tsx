import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import { AppShell } from "./app/AppShell.js";
import { subscribeSettingsChanged } from "./stores/settings.js";

/**
 * Renderer bootstrap: the settings store must be loaded before first paint so the shell
 * renders with the persisted theme instead of flashing the default. The static splash in
 * index.html is removed after the React tree takes over.
 */

async function boot(): Promise<void> {
  subscribeSettingsChanged();
  const root = createRoot(document.getElementById("app") ?? document.body);
  root.render(
    <StrictMode>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </StrictMode>,
  );
  document.getElementById("boot")?.remove();
  const appRoot = document.getElementById("app");
  if (appRoot) {
    appRoot.style.height = "100%";
    appRoot.style.display = "flex";
    appRoot.style.flexDirection = "column";
  }
}

// index.html gains the mount node the first time this module runs (keeps splash markup intact).
if (!document.getElementById("app")) {
  const mount = document.createElement("div");
  mount.id = "app";
  document.body.appendChild(mount);
}

void boot();
