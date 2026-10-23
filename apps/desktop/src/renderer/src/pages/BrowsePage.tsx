import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Button,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  Tooltip,
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
  ArrowDownloadRegular,
  ArrowSyncRegular,
  GlobeShieldRegular,
  StarFilled,
  StarRegular,
  VideoRegular,
} from "@fluentui/react-icons";
import { useBrowserStore } from "../stores/browser.js";
import { useProxyStore } from "../stores/proxy.js";
import { useBrowserDataStore } from "../stores/browser-data.js";
import { useBrowserMediaStore } from "../stores/browser-media.js";
import {
  activateTab, closeTab, createTab, goBack, goForward, navigateActiveTab,
  pushViewportBounds, reloadTab,
} from "../stores/browser.js";
import { useI18n } from "../i18n/context.js";
import { formatBytes } from "../i18n/format.js";

/**
 * Browse page: tab strip + navigation bar + the transparent viewport "hole".
 * The hole's geometry is reported to main via browser.setViewportBounds — the active
 * WebContentsView renders exactly there, above this renderer (true overlay compositing).
 * Phase 21: localized strings; the tab strip is keyboard-operable (roving tabIndex +
 * Enter/Space activation); Back/Forward mirror their arrows in RTL layouts.
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
    ":focus-visible": { outline: `2px solid ${tokens.colorBrandStroke1}` },
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
  // Phase 33: detected-media panel — a layout sibling of the viewport hole, so the
  // WebContentsView overlay auto-shrinks through the existing geometry sync.
  mediaPanel: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    height: "200px",
    flexShrink: 0,
    padding: "6px 8px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: "hidden",
  },
  mediaPanelHeader: { display: "flex", gap: "4px", alignItems: "center" },
  mediaList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  mediaRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    padding: "3px 4px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  mediaName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    maxWidth: "46%",
    fontWeight: tokens.fontWeightSemibold,
  },
  mediaMeta: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    color: tokens.colorNeutralForeground3,
  },
  mediaCount: {
    minWidth: "18px",
    padding: "0 5px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: "11px",
    lineHeight: "18px",
    textAlign: "center",
  },
});

/** Phase 33: item kind → its localized label key (closed set from the contracts enum). */
const MEDIA_KIND_LABEL: Record<string, "browse.mediaKindVideo" | "browse.mediaKindAudio" | "browse.mediaKindManifest" | "browse.mediaKindSegment"> = {
  video: "browse.mediaKindVideo",
  audio: "browse.mediaKindAudio",
  manifest: "browse.mediaKindManifest",
  segment: "browse.mediaKindSegment",
};

export function BrowsePage(): ReactNode {
  const styles = useStyles();
  const { t, dir } = useI18n();
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const proxyProfiles = useProxyStore((s) => s.profiles);
  const proxyLoaded = useProxyStore((s) => s.loaded);
  const loadProxies = useProxyStore((s) => s.load);

  useEffect(() => {
    if (!proxyLoaded) void loadProxies().catch(() => undefined);
  }, [proxyLoaded, loadProxies]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [bookmarked, setBookmarked] = useState(false);
  const toggleStarFromStore = useBrowserDataStore((s) => s.toggleStar);
  const isBookmarkedFromStore = useBrowserDataStore((s) => s.isBookmarked);

  // Phase 33: detected-media panel state (lives in the store — survives page switches).
  const mediaByTab = useBrowserMediaStore((s) => s.byTab);
  const mediaPanelOpen = useBrowserMediaStore((s) => s.panelOpen);
  const mediaPending = useBrowserMediaStore((s) => s.pending);
  const setMediaPanelOpen = useBrowserMediaStore((s) => s.setPanelOpen);
  const scanMedia = useBrowserMediaStore((s) => s.scan);
  const clearMedia = useBrowserMediaStore((s) => s.clear);
  const downloadMedia = useBrowserMediaStore((s) => s.download);
  const mediaItems = activeTabId ? (mediaByTab[activeTabId] ?? []) : [];

  // Star state follows the active URL (no cache — the core is the source of truth).
  const activeUrl = active?.url ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!activeUrl || !/^https?:\/\//.test(activeUrl)) {
      setBookmarked(false);
      return;
    }
    void isBookmarkedFromStore(activeUrl)
      .then((v) => {
        if (!cancelled) setBookmarked(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeUrl, isBookmarkedFromStore]);

  const toggleStar = async (url: string, title: string): Promise<void> => {
    const nowBookmarked = await toggleStarFromStore(url, title);
    setBookmarked(nowBookmarked);
  };

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

  // Keyboard operability for the custom tab strip (WAI-ARIA tabs pattern, minimal form):
  // each tab is focusable, Enter/Space activates, ArrowLeft/ArrowRight move focus in
  // reading order (arrow semantics follow the visual direction, so RTL is handled by
  // swapping which neighbor "previous" is).
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number): void => {
    const nextIndex =
      e.key === (dir === "rtl" ? "ArrowLeft" : "ArrowRight")
        ? (index + 1) % tabs.length
        : e.key === (dir === "rtl" ? "ArrowRight" : "ArrowLeft")
          ? (index - 1 + tabs.length) % tabs.length
          : undefined;
    if (nextIndex !== undefined) {
      e.preventDefault();
      const next = tabs[nextIndex];
      if (!next) return;
      document.getElementById(`tab-${next.id}`)?.focus();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const current = tabs[index];
      if (current) void activateTab(current.id);
    }
  };

  // Reading-order arrows: in RTL the visual back arrow points right.
  const BackIcon = dir === "rtl" ? ArrowRightRegular : ArrowLeftRegular;
  const ForwardIcon = dir === "rtl" ? ArrowLeftRegular : ArrowRightRegular;

  return (
    <div className={styles.root}>
      <div className={styles.tabStrip} role="tablist" aria-label={t("browse.tabList")}>
        {tabs.map((tab, index) => {
          const proxyName = tab.proxyProfileId
            ? (proxyProfiles.find((p) => p.id === tab.proxyProfileId)?.name ?? t("common.unavailable"))
            : null;
          return (
            <div
              key={tab.id}
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={tab.id === activeTabId}
              tabIndex={0}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ""}`}
              onClick={() => void activateTab(tab.id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
            >
              {proxyName ? (
                <Tooltip content={t("browse.proxyTooltip", { name: proxyName })} relationship="label">
                  <GlobeShieldRegular
                    fontSize={14}
                    style={{ color: tokens.colorPaletteBerryForeground1, flexShrink: 0 }}
                    aria-label={t("browse.proxyAria", { name: proxyName })}
                  />
                </Tooltip>
              ) : null}
              <Text className={styles.tabTitle} title={tab.url}>
                {tab.title || tab.url}
                {tab.isLoading ? " …" : ""}
              </Text>
              <Button
                appearance="subtle"
                size="small"
                icon={<DismissRegular />}
                aria-label={t("browse.closeTab", { title: tab.title || tab.url })}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.id);
                }}
              />
            </div>
          );
        })}
        <Button
          appearance="subtle"
          icon={<AddRegular />}
          aria-label={t("browse.newTab")}
          onClick={() => void createTab()}
        />
        {proxyProfiles.length > 0 ? (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                appearance="subtle"
                icon={<GlobeShieldRegular />}
                aria-label={t("browse.newProxiedTab")}
                title={t("browse.newProxiedTabHint")}
              />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {proxyProfiles.map((p) => (
                  <MenuItem
                    key={p.id}
                    onClick={() => void createTab(undefined, p.id).catch(() => undefined)}
                  >
                    {t("browse.newTabVia", { name: p.name })}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        ) : null}
      </div>

      <div className={styles.navbar}>
        <Button appearance="subtle" icon={<BackIcon />} disabled={!active?.canGoBack} onClick={() => void goBack()} aria-label={t("browse.back")} />
        <Button appearance="subtle" icon={<ForwardIcon />} disabled={!active?.canGoForward} onClick={() => void goForward()} aria-label={t("browse.forward")} />
        <Button appearance="subtle" icon={<ArrowClockwiseRegular />} onClick={() => void reloadTab()} aria-label={t("browse.reload")} />
        <Input
          value={urlDraft}
          onChange={(_, data) => setUrlDraft(data.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitUrl();
          }}
          placeholder={t("browse.addressPlaceholder")}
          style={{ flex: 1 }}
          aria-label={t("browse.addressAria")}
        />
        {/* Phase 14: bookmark star for the active http(s) page. */}
        {active && /^https?:\/\//.test(active.url) ? (
          <Tooltip
            content={bookmarked ? t("browse.bookmarkRemove") : t("browse.bookmarkAdd")}
            relationship="label"
          >
            <Button
              appearance="subtle"
              icon={bookmarked ? <StarFilled style={{ color: tokens.colorPaletteMarigoldForeground1 }} /> : <StarRegular />}
              aria-label={bookmarked ? t("browse.bookmarkRemove") : t("browse.bookmarkAdd")}
              aria-pressed={bookmarked}
              onClick={() =>
                void toggleStar(active.url, active.title || active.url)
                  .catch(() => undefined)
              }
            />
          </Tooltip>
        ) : null}
        {active?.isLoading ? <Spinner size="tiny" /> : null}
        {/* Phase 33: detected-media panel toggle — count badge shows live findings. */}
        {active ? (
          <Tooltip content={t("browse.mediaPanelToggle")} relationship="label">
            <Button
              appearance="subtle"
              aria-label={t("browse.mediaPanelToggle")}
              aria-pressed={mediaPanelOpen}
              onClick={() => setMediaPanelOpen(!mediaPanelOpen)}
              icon={<VideoRegular />}
            >
              {mediaItems.length > 0 ? <span className={styles.mediaCount}>{mediaItems.length}</span> : null}
            </Button>
          </Tooltip>
        ) : null}
      </div>

      <div className={styles.viewport} ref={viewportRef} aria-hidden="true" />

      {/* Phase 33: detected-media panel — a sibling of the viewport hole, so the browser
          view shrinks while it is open and the user can one-click-download any finding. */}
      {mediaPanelOpen && active ? (
        <div className={styles.mediaPanel} role="region" aria-label={t("browse.mediaPanelTitle")}>
          <div className={styles.mediaPanelHeader}>
            <Text weight="semibold">{t("browse.mediaPanelTitle")}</Text>
            <div style={{ flex: 1 }} />
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowSyncRegular />}
              aria-label={t("browse.mediaScanAgain")}
              title={t("browse.mediaScanAgain")}
              onClick={() => void scanMedia(active.id).catch(() => undefined)}
            />
            <Button
              size="small"
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label={t("browse.mediaClear")}
              title={t("browse.mediaClear")}
              onClick={() => void clearMedia(active.id).catch(() => undefined)}
            />
          </div>
          {mediaItems.length === 0 ? (
            <Text size={200}>{t("browse.mediaPanelEmpty")}</Text>
          ) : (
            <ul className={styles.mediaList}>
              {mediaItems.map((item) => {
                const kindLabel = MEDIA_KIND_LABEL[item.kind] ?? "browse.mediaKindVideo";
                const meta = [
                  t(kindLabel),
                  item.byteSize !== null ? formatBytes(item.byteSize, t.lang) : null,
                  item.origin === "dom" ? t("browse.mediaOriginDom") : t("browse.mediaOriginNetwork"),
                ]
                  .filter((part): part is string => part !== null)
                  .join(" · ");
                return (
                  <li key={item.id} className={styles.mediaRow}>
                    <Text className={styles.mediaName} title={item.url}>
                      {item.filename}
                    </Text>
                    <Text size={200} className={styles.mediaMeta} title={item.url}>
                      {meta}
                    </Text>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<ArrowDownloadRegular />}
                      disabled={mediaPending[item.id] === true}
                      aria-label={t("browse.mediaDownloadAria", { name: item.filename })}
                      onClick={() =>
                        void downloadMedia(active.id, item).catch(() => undefined)
                      }
                    >
                      {t("browse.mediaDownload")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
