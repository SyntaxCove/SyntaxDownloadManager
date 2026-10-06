# Phase 4 — Browser Engine (delivered)
**Plan**: one `WebContentsView` per tab (deprecated BrowserView never used); sandboxed,
context-isolated views with no preload on a dedicated `persist:browser` session; popups become
tabs (`setWindowOpenHandler`); explicit permission allow-list (fullscreen/pointerLock/media/
clipboard-sanitized-write/mediaKeySystem), deny-by-default; LRU activation fallback; overlay
geometry owned by the renderer layout which reports the viewport rect (`browser.setViewportBounds`,
additive contract entry) — zero-size hides the overlay when the shell shows another page; tab
state flows to the renderer only via `browser.tab.updated/closed` events; address bar normalizes
input (absolute URLs, host-like → https, localhost → http, anything else → DuckDuckGo search,
javascript:/data: rejected); Ctrl+T / Ctrl+W conventions.
**Electron 44 API verification**: `navigationHistory.canGoBack()` is a method (typings checked);
`contentView.addChildView/removeChildView`; `setWindowOpenHandler`; session-level permission
handler.
**Test**: 32 vitest cases total (8 new: URL normalization matrix incl. RTL/search/scheme policy,
title placeholders, viewport clamping). TabManager/window APIs need a live GUI — headless Linux
cannot spawn WebContentsView; runtime verification happens on the user's Windows device.
**Result**: commit `98abf40`.
