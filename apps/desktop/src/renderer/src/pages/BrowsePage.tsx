import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Input,
  Text,
  makeStyles,
  tokens,
  Spinner,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowLeftRegular,
  ArrowRightRegular,
  DismissRegular,
  ArrowClockwiseRegular,
} from "@fluentui/react-icons";
import { useBrowserStore } from "../stores/browser.js";
import {
  activateTab, closeTab, createTab, goBack, goForward, navigateActiveTab,
  pushViewportBounds, reloadTab,
} from "../stores/browser.js";

/**
 * Browse page: tab strip + navigation bar + the transparent viewport "hole".
 * The hole's geometry is reported to main via browser.setViewportBounds — the active
 * WebContentsView renders exactly there, above this renderer (true overlay compositing).
 */

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", height: "100%", gap: "4px" },
  tabStrip: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    maxWidth: "220px",
    padding: "4px 8px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: "pointer",
  },
  tabActive: { backgroundColor: tokens.colorNeutralBackground5, fontWeight: tokens.fontWeightSemibold },
  tabTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  navbar: { display: "flex", gap: "6px", alignItems: "center" },
  viewport: {
    flex: 1,
    minHeight: "80px",
    borderRadius: tokens.borderRadiusMedium,
    // Visual affordance only — the actual page renders in the WebContentsView overlay above it.
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
});

export function BrowsePage(): ReactNode {
  const styles = useStyles();
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [urlDraft, setUrlDraft] = useState("");

  useEffect(() => {
    setUrlDraft(active?.url ?? "");
  }, [active?.id, active?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Geometry sync: report on every layout change and on page show/hide.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const report = () => {
      const rect = el.getBoundingClientRect();
      void pushViewportBounds({
        x: Math.max(0, Math.floor(rect.left)),
        y: Math.max(0, Math.floor(rect.top)),
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      ro.disconnect();
      void pushViewportBounds({ x: 0, y: 0, width: 0, height: 0 }); // hide overlay on unmount
    };
  }, [tabs.length, activeTabId]);

  const submitUrl = (): void => {
    if (urlDraft.trim().length > 0) void navigateActiveTab(urlDraft);
  };

  return (
    <div className={styles.root}>
      <div className={styles.tabStrip} role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ""}`}
            onClick={() => void activateTab(tab.id)}
          >
            <Text className={styles.tabTitle} title={tab.url}>
              {tab.title || tab.url}
              {tab.isLoading ? " …" : ""}
            </Text>
            <Button
              appearance="subtle"
              size="small"
              icon={<DismissRegular />}
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
            />
          </div>
        ))}
        <Button
          appearance="subtle"
          icon={<AddRegular />}
          aria-label="New tab"
          onClick={() => void createTab()}
        />
      </div>

      <div className={styles.navbar}>
        <Button appearance="subtle" icon={<ArrowLeftRegular />} disabled={!active?.canGoBack} onClick={() => void goBack()} aria-label="Back" />
        <Button appearance="subtle" icon={<ArrowRightRegular />} disabled={!active?.canGoForward} onClick={() => void goForward()} aria-label="Forward" />
        <Button appearance="subtle" icon={<ArrowClockwiseRegular />} onClick={() => void reloadTab()} aria-label="Reload" />
        <Input
          value={urlDraft}
          onChange={(_, data) => setUrlDraft(data.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitUrl();
          }}
          placeholder="Search or enter address"
          style={{ flex: 1 }}
          aria-label="Address bar"
        />
        {active?.isLoading ? <Spinner size="tiny" /> : null}
      </div>

      <div className={styles.viewport} ref={viewportRef} aria-hidden="true" />
    </div>
  );
}
