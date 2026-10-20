import React, { useState, type ReactNode } from "react";
import {
  Text,
  Button,
  Link,
  makeStyles,
  tokens,
  Tooltip,
} from "@fluentui/react-components";
import { SettingsRegular, GlobeRegular, ArrowDownloadRegular, ShieldTaskRegular, VideoClipMultipleRegular, ArrowSquareDownRegular, LibraryRegular, ClockRegular, PulseRegular, QuestionCircleRegular } from "@fluentui/react-icons";
import { SettingsPage } from "../pages/SettingsPage.js";
import { BrowsePage } from "../pages/BrowsePage.js";
import { DownloadsPage } from "../pages/DownloadsPage.js";
import { ProxyPage } from "../pages/ProxyPage.js";
import { MediaPage } from "../pages/MediaPage.js";
import { TorrentsPage } from "../pages/TorrentsPage.js";
import { SchedulerPage } from "../pages/SchedulerPage.js";
import { LibraryPage } from "../pages/LibraryPage.js";
import { DiagnosticsPage } from "../pages/DiagnosticsPage.js";
import { HelpPage } from "../pages/HelpPage.js";
import { ToastHost } from "./ToastHost.js";
import { useI18n } from "../i18n/context.js";

/**
 * App shell: drag-region title bar (Windows 11 overlay) + left navigation + content.
 * Navigation gains entries as domains ship: Settings (Phase 3), Browse (Phase 4),
 * Downloads (Phase 5). Only implemented destinations appear — no dead links.
 * Phase 21: localized labels, a skip-to-content link (revealed on focus), and a
 * focusable main landmark as its target.
 */

const useStyles = makeStyles({
  // Post-1.0 layout fix: `width: 100%` — as a flex item of a row-flex parent the shell
  // shrinks to content width and leaves the rest of the window empty; explicit width
  // pins the fill regardless of how the parent wrapper is configured.
  root: { display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "hidden" },
  titlebar: {
    height: "40px",
    minHeight: "40px",
    display: "flex",
    alignItems: "center",
    paddingInlineStart: "16px",
    backgroundColor: tokens.colorNeutralBackground3,
    // Windows titleBarOverlay insets the native controls to the right automatically.
  },
  titleText: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  skipLink: {
    // Visually hidden until keyboard-focused — the classic skip-link pattern.
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    ":focus": { position: "static", width: "auto", height: "auto", clipPath: "none", padding: "6px" },
  },
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

type View = "browse" | "downloads" | "media" | "torrents" | "scheduler" | "library" | "proxy" | "settings" | "diagnostics" | "help";

// Drag regions are vendor-specific CSS; Griffel has no typed shorthand, so they are applied
// as inline styles with an explicit cast.
const dragStyle = { WebkitAppRegion: "drag" } as unknown as React.CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as unknown as React.CSSProperties;

const NAV: ReadonlyArray<{ id: View; key: string; icon: React.ReactElement }> = [
  { id: "browse", key: "nav.browse", icon: <GlobeRegular /> },
  { id: "downloads", key: "nav.downloads", icon: <ArrowDownloadRegular /> },
  { id: "media", key: "nav.media", icon: <VideoClipMultipleRegular /> },
  { id: "torrents", key: "nav.torrents", icon: <ArrowSquareDownRegular /> },
  { id: "scheduler", key: "nav.scheduler", icon: <ClockRegular /> },
  { id: "library", key: "nav.library", icon: <LibraryRegular /> },
  { id: "proxy", key: "nav.proxy", icon: <ShieldTaskRegular /> },
  { id: "diagnostics", key: "nav.diagnostics", icon: <PulseRegular /> },
  { id: "help", key: "nav.help", icon: <QuestionCircleRegular /> },
  { id: "settings", key: "nav.settings", icon: <SettingsRegular /> },
];

export function AppShell(): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const [view, setView] = useState<View>("settings");

  return (
    <div className={styles.root}>
      <Link
        className={styles.skipLink}
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        {t("shell.skipToContent")}
      </Link>
      <div className={styles.titlebar} style={dragStyle}>
        <Text className={styles.titleText}>{t("shell.title")}</Text>
      </div>
      <div className={styles.body}>
        <nav className={styles.nav} aria-label={t("nav.primary")} style={noDragStyle}>
          {NAV.map((item) => (
            <Tooltip key={item.id} content={t(item.key)} relationship="label">
              <Button
                className={styles.navButton}
                icon={item.icon}
                appearance={view === item.id ? "primary" : "subtle"}
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => setView(item.id)}
              >
                {t(item.key)}
              </Button>
            </Tooltip>
          ))}
        </nav>
        <main
          id="main-content"
          className={styles.content}
          style={noDragStyle}
          tabIndex={-1}
          aria-label={t("shell.mainRegion")}
        >
          {view === "browse" ? <BrowsePage /> : null}
          {view === "downloads" ? <DownloadsPage /> : null}
          {view === "media" ? <MediaPage /> : null}
          {view === "torrents" ? <TorrentsPage /> : null}
          {view === "scheduler" ? <SchedulerPage /> : null}
          {view === "library" ? <LibraryPage /> : null}
          {view === "proxy" ? <ProxyPage /> : null}
          {view === "diagnostics" ? <DiagnosticsPage /> : null}
          {view === "help" ? <HelpPage onOpenDiagnostics={() => setView("diagnostics")} /> : null}
          {view === "settings" ? <SettingsPage /> : null}
        </main>
      </div>
      {/* Phase 17: in-app toasts (job ends + engine interruptions) live above everything. */}
      <ToastHost />
    </div>
  );
}
