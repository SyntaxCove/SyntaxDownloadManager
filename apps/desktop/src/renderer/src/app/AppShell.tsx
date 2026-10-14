import React, { useState, type ReactNode } from "react";
import {
  Text,
  Button,
  makeStyles,
  tokens,
  Tooltip,
} from "@fluentui/react-components";
import { SettingsRegular, GlobeRegular, ArrowDownloadRegular, ShieldTaskRegular, VideoClipMultipleRegular, ArrowSquareDownRegular, LibraryRegular, ClockRegular } from "@fluentui/react-icons";
import { SettingsPage } from "../pages/SettingsPage.js";
import { BrowsePage } from "../pages/BrowsePage.js";
import { DownloadsPage } from "../pages/DownloadsPage.js";
import { ProxyPage } from "../pages/ProxyPage.js";
import { MediaPage } from "../pages/MediaPage.js";
import { TorrentsPage } from "../pages/TorrentsPage.js";
import { SchedulerPage } from "../pages/SchedulerPage.js";
import { LibraryPage } from "../pages/LibraryPage.js";
import { ToastHost } from "./ToastHost.js";

/**
 * App shell: drag-region title bar (Windows 11 overlay) + left navigation + content.
 * Navigation gains entries as domains ship: Settings (Phase 3), Browse (Phase 4),
 * Downloads (Phase 5). Only implemented destinations appear — no dead links.
 */

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  titlebar: {
    height: "40px",
    minHeight: "40px",
    display: "flex",
    alignItems: "center",
    paddingLeft: "16px",
    backgroundColor: tokens.colorNeutralBackground3,
    // Windows titleBarOverlay insets the native controls to the right automatically.
  },
  titleText: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  body: { display: "flex", flex: 1, minHeight: 0 },
  nav: {
    width: "200px",
    minHeight: "0",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  navButton: { justifyContent: "flex-start", width: "100%" },
  content: { flex: 1, minHeight: 0, overflow: "auto", padding: "16px" },
});

type View = "browse" | "downloads" | "media" | "torrents" | "scheduler" | "library" | "proxy" | "settings";

// Drag regions are vendor-specific CSS; Griffel has no typed shorthand, so they are applied
// as inline styles with an explicit cast.
const dragStyle = { WebkitAppRegion: "drag" } as unknown as React.CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as unknown as React.CSSProperties;

const NAV: ReadonlyArray<{ id: View; label: string; icon: React.ReactElement }> = [
  { id: "browse", label: "Browse", icon: <GlobeRegular /> },
  { id: "downloads", label: "Downloads", icon: <ArrowDownloadRegular /> },
  { id: "media", label: "Media", icon: <VideoClipMultipleRegular /> },
  { id: "torrents", label: "Torrents", icon: <ArrowSquareDownRegular /> },
  { id: "scheduler", label: "Scheduler", icon: <ClockRegular /> },
  { id: "library", label: "Library", icon: <LibraryRegular /> },
  { id: "proxy", label: "Proxy", icon: <ShieldTaskRegular /> },
  { id: "settings", label: "Settings", icon: <SettingsRegular /> },
];

export function AppShell(): ReactNode {
  const styles = useStyles();
  const [view, setView] = useState<View>("settings");

  return (
    <div className={styles.root}>
      <div className={styles.titlebar} style={dragStyle}>
        <Text className={styles.titleText}>UniDM</Text>
      </div>
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Primary" style={noDragStyle}>
          {NAV.map((item) => (
            <Tooltip key={item.id} content={item.label} relationship="label">
              <Button
                className={styles.navButton}
                icon={item.icon}
                appearance={view === item.id ? "primary" : "subtle"}
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </Button>
            </Tooltip>
          ))}
        </nav>
        <main className={styles.content} style={noDragStyle}>
          {view === "browse" ? <BrowsePage /> : null}
          {view === "downloads" ? <DownloadsPage /> : null}
          {view === "media" ? <MediaPage /> : null}
          {view === "torrents" ? <TorrentsPage /> : null}
          {view === "scheduler" ? <SchedulerPage /> : null}
          {view === "library" ? <LibraryPage /> : null}
          {view === "proxy" ? <ProxyPage /> : null}
          {view === "settings" ? <SettingsPage /> : null}
        </main>
      </div>
      {/* Phase 17: in-app toasts (job ends + engine interruptions) live above everything. */}
      <ToastHost />
    </div>
  );
}
