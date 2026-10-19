/**
 * Phase 27: help / FAQ / troubleshooting strings.
 *
 * Structure lives in `pages/help/content.ts` (typed arrays of i18n KEYS); this file
 * holds the actual text in both languages. Key parity, non-empty values and
 * placeholder parity are enforced by `__tests__/i18n.test.ts`; the help-specific
 * structure invariants are locked by `__tests__/help.test.ts`.
 *
 * Persian copy follows the Phase 21 style: ZWNJ (U+200C) orthography, formal but
 * plain tone, Latin product/error-code names kept as-is (source_gone, FFmpeg…).
 */

export const helpEn = {
  "help.page.title": "Help",
  "help.page.intro":
    "Short guides, frequently asked questions and step-by-step troubleshooting for Syntax Download Manager.",
  "help.search.placeholder": "Search help…",
  "help.search.noResults": "No results. Try a shorter keyword.",
  "help.tab.topics": "Topics",
  "help.tab.faq": "FAQ",
  "help.tab.trouble": "Troubleshooting",
  "help.openDiagnostics": "Open diagnostics",
  "help.about.title": "About",
  "help.about.version": "App version",
  "help.about.contract": "IPC contract",
  "help.trouble.causes": "Likely causes",
  "help.trouble.steps": "Steps",

  // Topics — getting started
  "help.topic.getting-started.title": "Getting started",
  "help.topic.getting-started.p1":
    "On first launch the app creates a local database and fetches the bundled media toolkit (FFmpeg, yt-dlp, Deno) once from a versioned manifest — nothing else needs to be installed on your system.",
  "help.topic.getting-started.p2":
    "Choose the interface language (English or فارسی) in Settings; the switch is immediate and includes right-to-left layout and Persian dates for فارسی.",
  "help.topic.getting-started.p3":
    "Start a download by pasting a link into the address bar or the downloads page; the engine segments the file and transfers several connections in parallel, so large files finish sooner.",
  "help.topic.getting-started.p4":
    "Everything stays on your machine: jobs, history, bookmarks, settings and proxy secrets live in a local SQLite database and the operating system keychain.",

  // Topics — downloads
  "help.topic.downloads.title": "Downloads",
  "help.topic.downloads.p1":
    "Downloads are segmented and transferred over multiple connections. Pause and resume at any time — across app restarts and reboots — without losing progress.",
  "help.topic.downloads.p2":
    "Integrity is enforced end to end: segments are hash-checked and a finished download is verified before it is marked complete.",
  "help.topic.downloads.p3":
    "If a link expires or changes mid-flight, the job records a typed error (like source_gone) and keeps your partial data; you can retry or rebind the job to a fresh link.",
  "help.topic.downloads.p4":
    "Bandwidth can be capped globally in Settings; jobs can be reordered or removed — removing a job never deletes a verified file.",

  // Topics — browser
  "help.topic.browser.title": "Unified browser",
  "help.topic.browser.p1":
    "The browser is a real Chromium tab strip with bookmarks and history, and anything you download from a page goes through the same engine and checks as a manual link.",
  "help.topic.browser.p2":
    "Each tab can be routed through a different proxy profile; routing is fail-closed — if the proxy is unavailable the tab pauses instead of leaking traffic directly.",
  "help.topic.browser.p3":
    "The address bar rejects javascript: and data: links and control characters, keeping browsing and downloads on plain web origins.",

  // Topics — proxies
  "help.topic.proxies.title": "Proxies",
  "help.topic.proxies.p1":
    "Create proxy profiles (HTTP, HTTPS, SOCKS) and attach them to browser tabs, downloads or the update feed.",
  "help.topic.proxies.p2":
    "Credentials are stored in the OS keychain — never in the database, never in logs.",
  "help.topic.proxies.p3":
    "Fail-closed by design: when a required proxy is unreachable, affected traffic pauses with a typed reason instead of silently falling back to a direct connection.",

  // Topics — media
  "help.topic.media.title": "Media toolkit",
  "help.topic.media.p1":
    "Pinned builds of FFmpeg, yt-dlp and Deno ship inside the app; they are fetched once from the versioned manifest and stored in the app data folder.",
  "help.topic.media.p2":
    "The media inspector reads a page or a direct media URL and lists available streams; pick video, audio and subtitle tracks and the pipeline muxes them with FFmpeg.",
  "help.topic.media.p3":
    "The app never attempts to defeat content protection; use media tools with content you have legitimate access to.",

  // Topics — torrents
  "help.topic.torrents.title": "Torrents",
  "help.topic.torrents.p1":
    "A native BitTorrent stack is built in — there is no separate torrent client to install.",
  "help.topic.torrents.p2":
    "Add jobs by magnet link or .torrent file; progress, peers and pieces are shown per job.",
  "help.topic.torrents.p3":
    "Torrent data honors the same storage, pause and integrity rules as HTTP downloads.",

  // Topics — scheduler
  "help.topic.scheduler.title": "Scheduler",
  "help.topic.scheduler.p1":
    "Schedule jobs with recurrence windows — daily, weekly or custom minute windows, including windows that span midnight.",
  "help.topic.scheduler.p2":
    "Missed windows are handled by catch-up semantics when a job is set to auto-start; manual runs are never rescheduled behind your back.",

  // Topics — library
  "help.topic.library.title": "Library & data",
  "help.topic.library.p1":
    "Downloads, browser history and bookmarks live in one searchable, locally stored library.",
  "help.topic.library.p2":
    "Search and filter freely; deleting a row never touches the underlying file unless you explicitly ask for it.",

  // Topics — updates
  "help.topic.updates.title": "Updates",
  "help.topic.updates.p1":
    "The app only checks the pinned release feed for updates and never installs anything on its own schedule.",
  "help.topic.updates.p2":
    "The feed is fail-closed: an unreachable or unverifiable feed results in “no update” — never a downgrade or a surprise install.",
  "help.topic.updates.p3":
    "Every release ships SHA-256 checksum sidecars; verify your download before running it.",

  // Topics — privacy
  "help.topic.privacy.title": "Privacy & security",
  "help.topic.privacy.p1":
    "No AI and no telemetry: nothing in the pipeline calls model or analytics services; everything is local and deterministic.",
  "help.topic.privacy.p2":
    "Hardened by default: sandboxed renderer, strict CSP, validated typed IPC on every boundary and deny-by-default permission checks.",
  "help.topic.privacy.p3":
    "No DRM circumvention: the app works with content you have legitimate access to and never attempts to defeat content protection.",

  // FAQ
  "help.faq.data-storage.q": "Where is my data stored?",
  "help.faq.data-storage.a":
    "Everything is local: a SQLite database (jobs, history, bookmarks, settings) inside the app data folder, plus proxy secrets in the OS keychain. Uninstalling the app never deletes your download database.",
  "help.faq.need-tools.q": "Do I need to install FFmpeg, yt-dlp or Deno?",
  "help.faq.need-tools.a":
    "No. All three ship inside the app as pinned builds, fetched once from the versioned manifest. Nothing else to install or maintain.",
  "help.faq.auto-pause.q": "Why did my download pause by itself?",
  "help.faq.auto-pause.a":
    "If the job’s proxy profile is unreachable, the engine pauses the job instead of leaking traffic directly — the fail-closed rule. Check the profile on the Proxy page, then resume.",
  "help.faq.proxy-scope.q": "Do proxies apply to my whole system?",
  "help.faq.proxy-scope.a":
    "No. Profiles route only browser tabs and downloads inside this app; your system-wide or other-app traffic is untouched.",
  "help.faq.ai.q": "Does the app use AI or cloud services?",
  "help.faq.ai.a":
    "No. There are no AI features and no telemetry; every operation is local and deterministic.",
  "help.faq.drm.q": "Can it download DRM-protected streaming media?",
  "help.faq.drm.a":
    "No. The app never attempts to circumvent content protection. Use it for media you have legitimate access to.",
  "help.faq.smartscreen.q": "Why does Windows show a SmartScreen warning?",
  "help.faq.smartscreen.a":
    "The published binaries are not code-signed yet (no certificate). If the SHA-256 checksum matches the release notes, choose “More info → Run anyway”. Code signing is planned — see the phase 19 report for the upgrade path.",
  "help.faq.verify-checksum.q": "How do I verify my downloaded file?",
  "help.faq.verify-checksum.a":
    "Every release attaches a .sha256 sidecar per binary and a checksum table in the notes. On Linux/macOS run sha256sum -c <file>.sha256; in PowerShell run Get-FileHash <file> and compare with the table.",
  "help.faq.core-restart.q": "Why did “core unavailable” appear?",
  "help.faq.core-restart.a":
    "The Rust core is a supervised process: a crash restarts it with exponential backoff, and a persistent crash loop stops with a typed “unavailable” state instead of spinning forever. See Diagnostics for the last exit reason; your database is safe (WAL with full synchronous writes).",
  "help.faq.export-logs.q": "How do I report a bug?",
  "help.faq.export-logs.a":
    "Open Diagnostics → export logs: a zip with structured logs and the health report is written where you choose. Attach it to your issue — proxy credentials are never included.",

  // Troubleshooting
  "help.trouble.download-failed.symptom": "A download failed with a typed error code.",
  "help.trouble.download-failed.cause1":
    "The source moved, expired, requires authorization, or the network/proxy path failed.",
  "help.trouble.download-failed.step1":
    "Read the hint on the job row — the engine records codes like source_gone, source_forbidden, source_changed, network_error and http_error.",
  "help.trouble.download-failed.step2":
    "source_gone means the URL expired: re-add the job with a fresh link; your partial data is kept.",
  "help.trouble.download-failed.step3":
    "source_changed means the file at the URL no longer matches: verify the file is the one you want, then rebind the job to the new URL from the row menu.",
  "help.trouble.download-failed.step4":
    "network_error and http_error: check connectivity or the proxy profile, then resume — completed segments are reused.",
  "help.trouble.download-failed.step5":
    "Still failing? Export logs from Diagnostics and look at the core-raw lines for the exact HTTP status.",
  "help.trouble.download-stuck.symptom": "A download is very slow or appears frozen.",
  "help.trouble.download-stuck.cause1":
    "A global bandwidth cap, a saturated link, or a server refusing parallel connections.",
  "help.trouble.download-stuck.step1":
    "Check the global bandwidth cap in Settings — the cap applies to all active jobs together.",
  "help.trouble.download-stuck.step2":
    "Open the job details: active segments and per-connection progress show whether bytes are actually moving.",
  "help.trouble.download-stuck.step3":
    "Pause and resume the job — the engine revalidates segments against the durable cursor and continues byte-exactly.",
  "help.trouble.download-stuck.step4":
    "If one server stalls every connection, re-add the job from a mirror or reduce connection pressure from the row menu.",
  "help.trouble.proxy-fail.symptom": "Tabs or downloads pause with a proxy reason.",
  "help.trouble.proxy-fail.cause1":
    "The profile is unreachable, its credentials changed, or its protocol does not match the target.",
  "help.trouble.proxy-fail.step1":
    "Open the Proxy page and test the profile the job is bound to.",
  "help.trouble.proxy-fail.step2":
    "Remember the rule: fail-closed — the app prefers pausing over leaking traffic; it never falls back to a direct connection silently.",
  "help.trouble.proxy-fail.step3":
    "Fix or detach the profile, then resume. Credentials live in the OS keychain, so re-enter them only if they actually changed.",
  "help.trouble.core-unavailable.symptom": "The banner says the core is restarting or unavailable.",
  "help.trouble.core-unavailable.cause1":
    "The core process crashed repeatedly and supervision gave up after the backoff budget.",
  "help.trouble.core-unavailable.step1":
    "Open Diagnostics: the core card shows the supervision state, restart count and the last exit reason.",
  "help.trouble.core-unavailable.step2":
    "A crash loop stops on purpose (never a silent spin); start the core again from the banner action once the cause is addressed.",
  "help.trouble.core-unavailable.step3":
    "If the database quick check reports problems, stop and export logs — do not delete the data folder.",
  "help.trouble.toolkit-error.symptom": "A media tool (FFmpeg, yt-dlp, Deno) shows an error state.",
  "help.trouble.toolkit-error.cause1":
    "The tool was not fetched, the fetch failed, or the pinned binary is damaged on disk.",
  "help.trouble.toolkit-error.step1":
    "Open Settings → media toolkit: each tool shows its pinned version and current state.",
  "help.trouble.toolkit-error.step2":
    "Use the repair action to re-fetch that tool from the pinned manifest.",
  "help.trouble.toolkit-error.step3":
    "Check free disk space in the app data folder — the bundle is stored locally after one fetch.",
  "help.trouble.toolkit-error.step4":
    "Persisting errors? Export logs — fetches record typed error codes.",
  "help.trouble.page-not-loading.symptom": "A web page will not load in a browser tab.",
  "help.trouble.page-not-loading.cause1":
    "A bound proxy is down (fail-closed pause) or the site blocks the request.",
  "help.trouble.page-not-loading.step1":
    "If the tab is routed through a proxy profile, check the profile first — the pause may be the fail-closed rule doing its job.",
  "help.trouble.page-not-loading.step2":
    "Reload the tab. Renderer crashes recover automatically — up to three reloads per minute, then it stops to avoid a loop.",
  "help.trouble.page-not-loading.step3":
    "Compare with a direct (no-profile) tab to tell a site-side block from a proxy problem.",
  "help.trouble.app-crash.symptom": "The window closed or reloaded unexpectedly.",
  "help.trouble.app-crash.cause1":
    "A renderer crash (recovered automatically) or a full app exit.",
  "help.trouble.app-crash.step1":
    "Renderer crashes auto-reload with backoff; the crash budget prevents reload loops — recent render-reload events are visible in diagnostics.",
  "help.trouble.app-crash.step2":
    "After a restart, downloads resume from their durable cursors; no file is left half-written.",
  "help.trouble.app-crash.step3":
    "Repeated crashes: export logs and include the recent main-process lines in your report.",
  "help.trouble.update-fail.symptom": "The update check fails or finds nothing unexpectedly.",
  "help.trouble.update-fail.cause1":
    "The release feed is unreachable, or an unverifiable feed is rejected by design.",
  "help.trouble.update-fail.step1":
    "The feed is fail-closed: unreachable or unverifiable means “no update” — never a downgrade or a surprise install.",
  "help.trouble.update-fail.step2":
    "Check the configured channel in Settings → updates.",
  "help.trouble.update-fail.step3":
    "Some networks block the release host; route the feed through a proxy profile or try again later.",
  "help.trouble.torrent-stall.symptom": "A torrent shows no progress or no peers.",
  "help.trouble.torrent-stall.cause1":
    "No healthy seeds, tracker issues, or NAT/firewall blocking incoming peers.",
  "help.trouble.torrent-stall.step1":
    "Check the trackers on the job details; private trackers need their own credentials.",
  "help.trouble.torrent-stall.step2":
    "NAT/firewall: allow incoming connections for the app or enable UPnP on your router.",
  "help.trouble.torrent-stall.step3":
    "Old torrents may simply have no seeds — compare peers and seeds on the details panel.",
  "help.trouble.torrent-stall.step4":
    "Paused by proxy? Torrents honor the same fail-closed proxy rules as everything else.",
} as const;

export const helpFa = {
  "help.page.title": "راهنما",
  "help.page.intro":
    "راهنمای کوتاه، پرسش‌های پرتکرار و گام‌به‌گام رفع اشکال برای Syntax Download Manager.",
  "help.search.placeholder": "جست‌وجو در راهنما…",
  "help.search.noResults": "نتیجه‌ای یافت نشد. عبارت کوتاه‌تری را بیازمایید.",
  "help.tab.topics": "موضوعات",
  "help.tab.faq": "پرسش‌های پرتکرار",
  "help.tab.trouble": "رفع اشکال",
  "help.openDiagnostics": "گشودن عیب‌یابی",
  "help.about.title": "درباره",
  "help.about.version": "نسخهٔ برنامه",
  "help.about.contract": "قرارداد IPC",
  "help.trouble.causes": "علت‌های محتمل",
  "help.trouble.steps": "گام‌ها",

  // موضوعات — شروع به کار
  "help.topic.getting-started.title": "شروع به کار",
  "help.topic.getting-started.p1":
    "در نخستین اجرا، برنامه یک پایگاه‌دادهٔ محلی می‌سازد و جعبه‌ابزار رسانه (FFmpeg، yt-dlp، Deno) را یک‌بار از مانیفست نسخه‌بندی‌شده دریافت می‌کند — به هیچ نصب اضافه‌ای روی سیستم نیاز نیست.",
  "help.topic.getting-started.p2":
    "زبان رابط (English یا فارسی) را در تنظیمات برگزینید؛ تغییر بلافاصله اعمال می‌شود و برای فارسی چیدمان راست‌به‌چپ و تاریخ‌های شمسی را نیز در بر می‌گیرد.",
  "help.topic.getting-started.p3":
    "برای شروع دریافت، پیوند را در نوار نشانی یا صفحهٔ دریافت‌ها بچسبانید؛ موتور فایل را قطعه‌بندی می‌کند و چند اتصال را موازی منتقل می‌کند تا فایل‌های بزرگ زودتر تمام شوند.",
  "help.topic.getting-started.p4":
    "همه‌چیز روی دستگاه شما می‌ماند: وظایف، تاریخچه، نشانک‌ها، تنظیمات و رمزهای پروکسی در پایگاه‌دادهٔ SQLite محلی و زنجیره‌کلید سیستم‌عامل نگهداری می‌شوند.",

  // موضوعات — دریافت‌ها
  "help.topic.downloads.title": "دریافت‌ها",
  "help.topic.downloads.p1":
    "دریافت‌ها قطعه‌بندی و از چندین اتصال منتقل می‌شوند. توقف و ادامه در هر زمان — حتی پس از بستن برنامه یا راه‌اندازی دوبارهٔ سیستم — بدون از دست دادن پیشرفت.",
  "help.topic.downloads.p2":
    "یکپارچگی داده از ابتدا تا انتها تضمین می‌شود: هر قطعه با هش بررسی و دریافتِ کامل‌شده پیش از علامت‌گذاری به‌عنوان کامل، راستی‌آزمایی می‌شود.",
  "help.topic.downloads.p3":
    "اگر پیوندی در میانهٔ کار منقضی یا تغییر کند، وظیفه یک خطای نوع‌دار (مانند source_gone) ثبت می‌کند و داده‌های جزئی شما محفوظ می‌ماند؛ می‌توانید وظیفه را دوباره بیازمایید یا به پیوند تازه‌ای قید کنید.",
  "help.topic.downloads.p4":
    "مصرف پهنای‌باند را می‌توان در تنظیمات به‌صورت سراسری محدود کرد؛ وظایف قابل جابه‌جایی یا حذف‌اند — حذف وظیفه هرگز فایل راستی‌آزمایی‌شده را پاک نمی‌کند.",

  // موضوعات — مرورگر یکپارچه
  "help.topic.browser.title": "مرورگر یکپارچه",
  "help.topic.browser.p1":
    "مرورگر یک نوار زبانهٔ واقعی کرومیوم با نشانک‌ها و تاریخچه است و هر دانلودی از صفحه، از همان موتور و همان بررسی‌های یک پیوند دستی می‌گذرد.",
  "help.topic.browser.p2":
    "هر زبانه می‌تواند از پروفایل پروکسی متفاوتی عبور کند؛ مسیریابی «بسته-در-خطا» است — اگر پروکسی در دسترس نباشد، زبانه متوقف می‌شود و ترافیک مستقیم درز نمی‌کند.",
  "help.topic.browser.p3":
    "نوار نشانی، پیوندهای javascript: و data: و نویسه‌های کنترلی را رد می‌کند تا مرور و دریافت‌ها فقط روی مبدأهای وب عادی بمانند.",

  // موضوعات — پروکسی‌ها
  "help.topic.proxies.title": "پروکسی‌ها",
  "help.topic.proxies.p1":
    "پروفایل‌های پروکسی (HTTP، HTTPS، SOCKS) بسازید و به زبانه‌های مرورگر، دریافت‌ها یا فید به‌روزرسانی وصل کنید.",
  "help.topic.proxies.p2":
    "اعتبارنامه‌ها در زنجیره‌کلید سیستم‌عامل ذخیره می‌شوند — نه در پایگاه‌داده و نه در گزارش‌ها.",
  "help.topic.proxies.p3":
    "طراحی «بسته-در-خطا»: وقتی پروکسیِ لازم در دسترس نباشد، ترافیکِ مربوط با یک دلیل نوع‌دار متوقف می‌شود و هرگز بی‌سروصدا به اتصال مستقیم برنمی‌گردد.",

  // موضوعات — جعبه‌ابزار رسانه
  "help.topic.media.title": "جعبه‌ابزار رسانه",
  "help.topic.media.p1":
    "نسخه‌های قفل‌شدهٔ FFmpeg، yt-dlp و Deno داخل برنامه هستند؛ یک‌بار از مانیفست نسخه‌بندی‌شده دریافت و در پوشهٔ دادهٔ برنامه ذخیره می‌شوند.",
  "help.topic.media.p2":
    "بازرس رسانه یک صفحه یا نشانی رسانه را می‌خواند و جریان‌های موجود را فهرست می‌کند؛ ویدیو، صدا و زیرنویس‌ها را برگزینید تا خط تولید آن‌ها را با FFmpeg ادغام کند.",
  "help.topic.media.p3":
    "برنامه هرگز تلاش نمی‌کند از حفاظت محتوا عبور کند؛ ابزارهای رسانه را با محتوایی به کار ببرید که دسترسی مشروع به آن دارید.",

  // موضوعات — تورنت‌ها
  "help.topic.torrents.title": "تورنت‌ها",
  "help.topic.torrents.p1":
    "یک پشتهٔ بیت‌تورنت بومی درون برنامه وجود دارد — نیازی به نصب کلاینت تورنت جداگانه نیست.",
  "help.topic.torrents.p2":
    "وظایف را با لینک مگنت یا فایل ‎.torrent اضافه کنید؛ پیشرفت، همتاها و قطعه‌ها برای هر وظیفه نمایش داده می‌شود.",
  "help.topic.torrents.p3":
    "داده‌های تورنت از همان قواعد ذخیره‌سازی، توقف و یکپارچگی دریافت‌های HTTP پیروی می‌کنند.",

  // موضوعات — زمان‌بند
  "help.topic.scheduler.title": "زمان‌بند",
  "help.topic.scheduler.p1":
    "وظایف را با بازه‌های تکرار زمان‌بندی کنید — روزانه، هفتگی یا بازه‌های دقیقه‌ای دلخواه، حتی بازه‌هایی که از نیمه‌شب می‌گذرند.",
  "help.topic.scheduler.p2":
    "بازه‌های ازدست‌رفته با رفتار جبران مدیریت می‌شوند، مشروط بر اینکه وظیفه برای شروع خودکار تنظیم شده باشد؛ اجراهای دستی هرگز پشت سر شما باززمان‌بندی نمی‌شوند.",

  // موضوعات — کتابخانه و داده‌ها
  "help.topic.library.title": "کتابخانه و داده‌ها",
  "help.topic.library.p1":
    "دریافت‌ها، تاریخچهٔ مرور و نشانک‌ها در یک کتابخانهٔ قابل جست‌وجو و کاملاً محلی نگهداری می‌شوند.",
  "help.topic.library.p2":
    "با آسودگی جست‌وجو و پالایش کنید؛ پاک کردن یک ردیف هرگز فایلِ زیرین را دستکاری نمی‌کند مگر آنکه صریحاً بخواهید.",

  // موضوعات — به‌روزرسانی
  "help.topic.updates.title": "به‌روزرسانی",
  "help.topic.updates.p1":
    "برنامه فقط فید منتشرشدهٔ قفل‌شده را برای به‌روزرسانی بررسی می‌کند و هرگز به‌صورت خودکار چیزی نصب نمی‌کند.",
  "help.topic.updates.p2":
    "فید «بسته-در-خطا» است: فید در دسترس‌نیافته یا راستی‌آزمایی‌ناشده یعنی «به‌روزرسانی نیست» — هرگز تنزل نسخه یا نصب غافلگیرانه رخ نمی‌دهد.",
  "help.topic.updates.p3":
    "هر منتشرشده سایدکارهای SHA-256 دارد؛ پیش از اجرا، فایل دریافتی خود را راستی‌آزمایی کنید.",

  // موضوعات — حریم خصوصی و امنیت
  "help.topic.privacy.title": "حریم خصوصی و امنیت",
  "help.topic.privacy.p1":
    "بدون هوش مصنوعی و بدون تلمتری: هیچ بخشی از خط تولید به سرویس‌های مدل یا آمارسنجی متصل نمی‌شود؛ همه‌چیز محلی و قطعی است.",
  "help.topic.privacy.p2":
    "امنیتِ پیش‌فرض: رندرکنندهٔ سندباکس‌شده، CSP سخت‌گیرانه، IPC نوع‌دار و اعتبارسنجی‌شده در همهٔ مرزها و مجوزهای «پیش‌فرض-رد».",
  "help.topic.privacy.p3":
    "بدون دورزدن DRM: برنامه با محتوایی کار می‌کند که دسترسی مشروع به آن دارید و هرگز تلاش نمی‌کند حفاظت محتوا را دور بزند.",

  // پرسش‌های پرتکرار
  "help.faq.data-storage.q": "داده‌های من کجا ذخیره می‌شوند؟",
  "help.faq.data-storage.a":
    "همه‌چیز محلی است: یک پایگاه‌دادهٔ SQLite (وظایف، تاریخچه، نشانک‌ها، تنظیمات) در پوشهٔ دادهٔ برنامه، به‌همراه رمزهای پروکسی در زنجیره‌کلید سیستم‌عامل. حذف نصب برنامه هرگز پایگاه‌دادهٔ دریافت‌ها را پاک نمی‌کند.",
  "help.faq.need-tools.q": "آیا باید FFmpeg، yt-dlp یا Deno را نصب کنم؟",
  "help.faq.need-tools.a":
    "نه. هر سه به‌صورت نسخهٔ قفل‌شده داخل برنامه هستند و یک‌بار از مانیفست نسخه‌بندی‌شده دریافت می‌شوند. چیزی برای نصب یا نگهداری اضافه نیست.",
  "help.faq.auto-pause.q": "چرا دریافت من خودبه‌خود متوقف شد؟",
  "help.faq.auto-pause.a":
    "اگر پروفایل پروکسی وظیفه در دسترس نباشد، موتور وظیفه را متوقف می‌کند و اجازه نمی‌دهد ترافیک مستقیم درز کند — قاعدهٔ «بسته-در-خطا». پروفایل را در صفحهٔ پروکسی بررسی و سپس دریافت را ادامه دهید.",
  "help.faq.proxy-scope.q": "آیا پروکسی‌ها روی کل سیستم اعمال می‌شوند؟",
  "help.faq.proxy-scope.a":
    "نه. پروفایل‌ها فقط زبانه‌های مرورگر و دریافت‌های داخل همین برنامه را مسیریابی می‌کنند؛ ترافیک کل سیستم یا برنامه‌های دیگر دست‌نخورده می‌ماند.",
  "help.faq.ai.q": "آیا برنامه از هوش مصنوعی یا سرویس‌های ابری استفاده می‌کند؟",
  "help.faq.ai.a":
    "نه. هیچ قابلیت هوش مصنوعی و هیچ تلمتری وجود ندارد؛ همهٔ عملیات محلی و قطعی است.",
  "help.faq.drm.q": "آیا می‌تواند رسانه‌های پخش محافظت‌شده با DRM را دانلود کند؟",
  "help.faq.drm.a":
    "نه. برنامه هرگز تلاش نمی‌کند حفاظت محتوا را دور بزند. آن را برای رسانه‌هایی به کار ببرید که دسترسی مشروع به آن‌ها دارید.",
  "help.faq.smartscreen.q": "چرا ویندوز هشدار SmartScreen نشان می‌دهد؟",
  "help.faq.smartscreen.a":
    "باینری‌های منتشرشده هنوز کد-امضا نشده‌اند (گواهی وجود ندارد). اگر جمع SHA-256 با جدول یادداشت انتشار مطابقت دارد، گزینهٔ «More info → Run anyway» را برگزینید. کد-امضا در نقشهٔ راه است — مسیر ارتقا در گزارش فاز ۱۹ آمده است.",
  "help.faq.verify-checksum.q": "فایل دریافتی‌ام را چگونه راستی‌آزمایی کنم؟",
  "help.faq.verify-checksum.a":
    "هر منتشرشده به‌ازای هر باینری یک سایدکار ‎.sha256 و در یادداشت‌ها جدول جمع‌های کنترلی دارد. در لینوکس/macOS دستور sha256sum -c <file>.sha256 و در PowerShell دستور Get-FileHash <file> را اجرا و با جدول مقایسه کنید.",
  "help.faq.core-restart.q": "چرا پیام «هسته در دسترس نیست» ظاهر شد؟",
  "help.faq.core-restart.a":
    "هستهٔ Rust یک فرایند تحت سرپرستی است: خرابی با عقب‌نشینی نمایانگر دوباره راه‌اندازی می‌شود و حلقهٔ خرابیِ پایدار با حالت نوع‌دار «در دسترس نیست» متوقف می‌شود، نه چرخش بی‌پایان. دلیل آخرین خروجی را در عیب‌یابی ببینید؛ پایگاه‌دادهٔ شما ایمن است (WAL با نوشتن همگام کامل).",
  "help.faq.export-logs.q": "اشکال را چگونه گزارش کنم؟",
  "help.faq.export-logs.a":
    "در عیب‌یابی، «برون‌بری گزارش‌ها» را بزنید: یک zip شامل گزارش‌های ساخت‌یافته و گزارش سلامت در مسیر انتخابی شما نوشته می‌شود. آن را به گزارش‌تان پیوست کنید — اعتبارنامه‌های پروکسی هرگز در آن قرار نمی‌گیرند.",

  // رفع اشکال
  "help.trouble.download-failed.symptom": "یک دریافت با کد خطای نوع‌دار شکست خورده است.",
  "help.trouble.download-failed.cause1":
    "منبع جابه‌جا یا منقضی شده، به مجوز نیاز دارد، یا مسیر شبکه/پروکسی شکست خورده است.",
  "help.trouble.download-failed.step1":
    "راهنمای ردیف وظیفه را بخوانید — موتور کدهایی مانند source_gone، source_forbidden، source_changed، network_error و http_error ثبت می‌کند.",
  "help.trouble.download-failed.step2":
    "source_gone یعنی نشانی منقضی شده: وظیفه را با پیوند تازه دوباره اضافه کنید؛ داده‌های جزئی حفظ می‌شوند.",
  "help.trouble.download-failed.step3":
    "source_changed یعنی فایلِ موجود در نشانی دیگر مطابقت ندارد: مطمئن شوید فایل همان است که می‌خواهید، سپس از منوی ردیف، وظیفه را به نشانی تازه قید کنید.",
  "help.trouble.download-failed.step4":
    "network_error و http_error: اتصال یا پروفایل پروکسی را بررسی و دریافت را ادامه دهید — قطعه‌های کامل‌شده دوباره استفاده می‌شوند.",
  "help.trouble.download-failed.step5":
    "باز هم شکست خورد؟ از عیب‌یابی گزارش‌ها را برون‌بری کنید و در خطوط core-raw وضعیت دقیق HTTP را ببینید.",
  "help.trouble.download-stuck.symptom": "دریافتی بسیار کند است یا به نظر انگل کرده.",
  "help.trouble.download-stuck.cause1":
    "سقف سراسری پهنای‌باند، اشباع لینک، یا سروری که اتصال‌های موازی را نمی‌پذیرد.",
  "help.trouble.download-stuck.step1":
    "سقف پهنای‌باند سراسری را در تنظیمات بررسی کنید — این سقف بر همهٔ وظایف فعال با هم اعمال می‌شود.",
  "help.trouble.download-stuck.step2":
    "جزئیات وظیفه را بگشایید: قطعه‌های فعال و پیشرفت هر اتصال نشان می‌دهند که آیا واقعاً بایت‌ها جابه‌جا می‌شوند.",
  "help.trouble.download-stuck.step3":
    "وظیفه را متوقف و ادامه دهید — موتور قطعه‌ها را با نشانگر پایدار بازاعتبارسنجی و دقیقاً بایت‌به‌بایت ادامه می‌دهد.",
  "help.trouble.download-stuck.step4":
    "اگر یک سرور همهٔ اتصال‌ها را می‌خواباند، وظیفه را از آینه‌ای دیگر اضافه کنید یا فشار اتصال را از منوی ردیف کم کنید.",
  "help.trouble.proxy-fail.symptom": "زبانه‌ها یا دریافت‌ها با دلیل پروکسی متوقف می‌شوند.",
  "help.trouble.proxy-fail.cause1":
    "پروفایل در دسترس نیست، اعتبارنامه‌اش عوض شده، یا قراردادش با مقصد نمی‌خواند.",
  "help.trouble.proxy-fail.step1":
    "صفحهٔ پروکسی را باز کنید و پروفایلی که وظیفه به آن قید شده را بیازمایید.",
  "help.trouble.proxy-fail.step2":
    "قاعده را به یاد داشته باشید: «بسته-در-خطا» — برنامه توقف را به درزکردن ترافیک ترجیح می‌دهد و هرگز بی‌سروصدا به اتصال مستقیم برنمی‌گردد.",
  "help.trouble.proxy-fail.step3":
    "پروفایل را درست کنید یا از وظیفه جدا کنید و ادامه دهید. اعتبارنامه‌ها در زنجیره‌کلید سیستم‌عامل‌اند؛ فقط اگر واقعاً عوض شده‌اند دوباره واردشان کنید.",
  "help.trouble.core-unavailable.symptom": "بنر می‌گوید هسته در حال راه‌اندازی مجدد یا در دسترس نیست.",
  "help.trouble.core-unavailable.cause1":
    "فرایند هسته پی‌درپی فروریخته و سرپرستی پس از سهمیهٔ عقب‌نشینی دست از تلاش برداشته است.",
  "help.trouble.core-unavailable.step1":
    "عیب‌یابی را باز کنید: کارت هسته وضعیت سرپرستی، شمار راه‌اندازی‌های مجدد و آخرین دلیل خروج را نشان می‌دهد.",
  "help.trouble.core-unavailable.step2":
    "حلقهٔ خرابی به‌عمد متوقف می‌شود (هرگز بی‌سروصدا نمی‌چرخد)؛ پس از رفع علت، از کنش بنر هسته را دوباره راه بیندازید.",
  "help.trouble.core-unavailable.step3":
    "اگر بررسی سریع پایگاه‌داده مشکل گزارش کند، دست نگه دارید و فقط گزارش‌ها را برون‌بری کنید — پوشهٔ داده را پاک نکنید.",
  "help.trouble.toolkit-error.symptom": "یکی از ابزارهای رسانه (FFmpeg، yt-dlp، Deno) حالت خطا نشان می‌دهد.",
  "help.trouble.toolkit-error.cause1":
    "ابزار دریافت نشده، دریافت شکست خورده، یا باینری قفل‌شده روی دیسک آسیب دیده است.",
  "help.trouble.toolkit-error.step1":
    "تنظیمات ← جعبه‌ابزار رسانه را باز کنید: هر ابزار نسخهٔ قفل‌شده و وضعیت کنونی‌اش را نشان می‌دهد.",
  "help.trouble.toolkit-error.step2":
    "از کنش تعمیر برای دریافت دوبارهٔ همان ابزار از مانیفست قفل‌شده استفاده کنید.",
  "help.trouble.toolkit-error.step3":
    "فضای آزاد پوشهٔ دادهٔ برنامه را بررسی کنید — بسته پس از یک دریافت، محلی ذخیره می‌شود.",
  "help.trouble.toolkit-error.step4":
    "خطا پابرجاست؟ گزارش‌ها را برون‌بری کنید — دریافت‌ها کد خطای نوع‌دار ثبت می‌کنند.",
  "help.trouble.page-not-loading.symptom": "صفحه‌ای وب در زبانهٔ مرورگر باز نمی‌شود.",
  "help.trouble.page-not-loading.cause1":
    "پروکسیِ متصل از کار افتاده (توقف بسته-در-خطا) یا سایت درخواست را مسدود می‌کند.",
  "help.trouble.page-not-loading.step1":
    "اگر زبانه از پروفایلی پروکسی می‌گذرد، اول پروفایل را بررسی کنید — توقف ممکن است همان قاعدهٔ «بسته-در-خطا» در حال کار باشد.",
  "help.trouble.page-not-loading.step2":
    "زبانه را دوباره بارگذاری کنید. فروریختن‌های رندرکننده خودکار ترمیم می‌شوند — حداکثر سه بار در دقیقه، سپس برای پرهیز از حلقه متوقف می‌شود.",
  "help.trouble.page-not-loading.step3":
    "با یک زبانهٔ مستقیم (بدون پروفایل) مقایسه کنید تا مسدودی سمت سایت را از مشکل پروکسی جدا کنید.",
  "help.trouble.app-crash.symptom": "پنجره ناگهانی بسته شد یا دوباره بارگذاری شد.",
  "help.trouble.app-crash.cause1":
    "فروریختن رندرکننده (خودکار ترمیم می‌شود) یا خروج کامل برنامه.",
  "help.trouble.app-crash.step1":
    "فروریختن‌های رندرکننده با عقب‌نشینی زمانی خودکار دوباره بارگذاری می‌شوند؛ سهمیهٔ خرابی مانع حلقهٔ بارگذاری می‌شود — رویدادهای اخیر در عیب‌یابی دیده می‌شوند.",
  "help.trouble.app-crash.step2":
    "پس از راه‌اندازی دوباره، دریافت‌ها از نشانگرهای پایدار ادامه می‌یابند؛ هیچ فایلی نیمه‌کاره رها نمی‌شود.",
  "help.trouble.app-crash.step3":
    "خرابی‌های مکرر: گزارش‌ها را برون‌بری کنید و خطوط اخیر فرایند اصلی را به گزارش‌تان ضمیمه کنید.",
  "help.trouble.update-fail.symptom": "بررسی به‌روزرسانی شکست می‌خورد یا غیرمنتظره چیزی نمی‌یابد.",
  "help.trouble.update-fail.cause1":
    "فید انتشار در دسترس نیست، یا فیدِ راستی‌آزمایی‌ناشده طبق طراحی رد می‌شود.",
  "help.trouble.update-fail.step1":
    "فید «بسته-در-خطا» است: در دسترس نبودن یا راستی‌آزمایی‌نشدن یعنی «به‌روزرسانی نیست» — هرگز تنزل نسخه یا نصب غافلگیرانه رخ نمی‌دهد.",
  "help.trouble.update-fail.step2":
    "کانال پیکربندی‌شده را در تنظیمات ← به‌روزرسانی بررسی کنید.",
  "help.trouble.update-fail.step3":
    "برخی شبکه‌ها میزبان انتشار را مسدود می‌کنند؛ فید را از پروفایلی پروکسی عبور دهید یا بعداً دوباره بکوشید.",
  "help.trouble.torrent-stall.symptom": "تورنتی پیشرفت یا همتایی نشان نمی‌دهد.",
  "help.trouble.torrent-stall.cause1":
    "بذور سالم نیستند، ردیاب مشکل دارد، یا NAT/فایروال همتاهای ورودی را می‌بندد.",
  "help.trouble.torrent-stall.step1":
    "ردیاب‌ها را در جزئیات وظیفه بررسی کنید؛ ردیاب‌های خصوصی اعتبارنامهٔ خودشان را می‌خواهند.",
  "help.trouble.torrent-stall.step2":
    "NAT/فایروال: اتصال‌های ورودی را برای برنامه باز کنید یا UPnP روتر را روشن کنید.",
  "help.trouble.torrent-stall.step3":
    "تورنت‌های قدیمی گاهی اصلاً بذور ندارند — همتا و بذور را در پنل جزئیات مقایسه کنید.",
  "help.trouble.torrent-stall.step4":
    "با پروکسی متوقف شده؟ تورنت‌ها همان قواعد «بسته-در-خطا»ی بقیه را رعایت می‌کنند.",
} as const;

