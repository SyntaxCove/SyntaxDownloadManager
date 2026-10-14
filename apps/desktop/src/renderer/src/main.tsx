import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import { AppShell } from "./app/AppShell.js";
import { subscribeSettingsChanged } from "./stores/settings.js";
import { subscribeBrowserEvents, createTab, closeTab, useBrowserStore } from "./stores/browser.js";
import { subscribeDownloadEvents } from "./stores/downloads.js";
import { subscribeToolkitProgress } from "./stores/toolkit.js";
import { subscribeMediaEvents } from "./stores/media.js";
import { subscribeTorrentEvents } from "./stores/torrent.js";
import { subscribeSchedulerEvents } from "./stores/scheduler.js";
import { subscribeStatusToasts } from "./app/toasts.js";

/**
 * Renderer bootstrap: the settings store must be loaded before first paint so the shell
 * renders with the persisted theme instead of flashing the default. The static splash in
 * index.html is removed after the React tree takes over.
 */

async function boot(): Promise<void> {
  subscribeSettingsChanged();
  subscribeBrowserEvents();
  subscribeDownloadEvents();
  subscribeToolkitProgress();
  subscribeMediaEvents();
  subscribeTorrentEvents();
  subscribeSchedulerEvents();
  // Phase 17: job-end + engine-interruption toasts ride the same validated events.
  subscribeStatusToasts();
  const root = createRoot(document.getElementById("app") ?? document.body);
  root.render(
    <StrictMode>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </StrictMode>,
  );
  document.getElementById("boot")?.remove();
  // First-run browser surface: a single new tab, matching desktop browser convention.
  void createTab();

  // Browser keyboard conventions (accelerator set grows with features).
  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === "t") {
      e.preventDefault();
      void createTab();
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && key === "w") {
      e.preventDefault();
      const id = useBrowserStore.getState().activeTabId;
      if (id) void closeTab(id);
    }
  });
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
