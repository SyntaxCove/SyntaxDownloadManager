/**
 * Phase 21 dictionary — common actions, shell chrome, primary navigation, toast titles
 * and core-state toasts. Each section file co-locates the English and Persian fragments
 * so the two halves of every string are reviewed together; `en.ts` / `fa.ts` compose them.
 * Persian copy uses ZWNJ (U+200C) per standard orthography.
 */

export const commonEn = {
  // ---- shared actions ----
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.edit": "Edit",
  "common.apply": "Apply",
  "common.add": "Add",
  "common.browse": "Browse…",
  "common.test": "Test",
  "common.retry": "Retry",
  "common.refresh": "Refresh",
  "common.loading": "Loading…",
  "common.open": "Open",
  "common.direct": "Direct",
  "common.directNoProxy": "Direct (no proxy)",
  "common.appDefault": "App default",
  "common.proxy": "Proxy",
  "common.unavailable": "unavailable",
  "common.saving": "Saving to {path}",

  // ---- shell chrome + primary navigation ----
  "shell.title": "Syntax Download Manager",
  "shell.skipToContent": "Skip to main content",
  "shell.mainRegion": "Main content",
  "nav.browse": "Browse",
  "nav.downloads": "Downloads",
  "nav.media": "Media",
  "nav.torrents": "Torrents",
  "nav.scheduler": "Scheduler",
  "nav.library": "Library",
  "nav.proxy": "Proxy",
  "nav.diagnostics": "Diagnostics",
  "nav.settings": "Settings",
  "nav.primary": "Primary",

  // ---- job-end toast titles (renderer bus; main mirrors these via describeTransition) ----
  "toast.completed.download": "Download completed",
  "toast.completed.media": "Media ready",
  "toast.completed.torrent": "Torrent finished",
  "toast.failed.download": "Download failed",
  "toast.failed.media": "Media job failed",
  "toast.failed.torrent": "Torrent failed",

  // ---- core lifecycle toasts (the decision stays in contracts; only the copy is here) ----
  "coreToast.restarting.title": "Download engine restarting",
  "coreToast.restarting.body": "Active downloads pause briefly and resume automatically.",
  "coreToast.unavailable.title": "Download engine unavailable",
  "coreToast.unavailable.body":
    "Downloads are paused. The app keeps retrying — your jobs and bytes are safe.",
};

export const commonFa: Record<keyof typeof commonEn, string> = {
  "common.cancel": "انصراف",
  "common.close": "بستن",
  "common.save": "ذخیره",
  "common.delete": "حذف",
  "common.remove": "حذف",
  "common.edit": "ویرایش",
  "common.apply": "اعمال",
  "common.add": "افزودن",
  "common.browse": "مرور…",
  "common.test": "آزمایش",
  "common.retry": "تلاش دوباره",
  "common.refresh": "بازخوانی",
  "common.loading": "در حال بارگذاری…",
  "common.open": "باز کردن",
  "common.direct": "مستقیم",
  "common.directNoProxy": "مستقیم (بدون پروکسی)",
  "common.appDefault": "پیش‌فرض برنامه",
  "common.proxy": "پروکسی",
  "common.unavailable": "در دسترس نیست",
  "common.saving": "ذخیره در {path}",

  "shell.title": "Syntax Download Manager",
  "shell.skipToContent": "پرش به محتوای اصلی",
  "shell.mainRegion": "محتوای اصلی",
  "nav.browse": "مرور",
  "nav.downloads": "دریافت‌ها",
  "nav.media": "رسانه",
  "nav.torrents": "تورنت‌ها",
  "nav.scheduler": "زمان‌بند",
  "nav.library": "کتابخانه",
  "nav.proxy": "پروکسی",
  "nav.diagnostics": "عیب‌یابی",
  "nav.settings": "تنظیمات",
  "nav.primary": "ناوبری اصلی",

  "toast.completed.download": "دریافت کامل شد",
  "toast.completed.media": "رسانه آماده شد",
  "toast.completed.torrent": "تورنت تمام شد",
  "toast.failed.download": "دریافت ناموفق بود",
  "toast.failed.media": "کار رسانه ناموفق بود",
  "toast.failed.torrent": "تورنت ناموفق بود",

  "coreToast.restarting.title": "موتور دریافت در حال راه‌اندازی مجدد است",
  "coreToast.restarting.body": "دریافت‌های فعال موقتاً متوقف می‌شوند و به‌طور خودکار از سر گرفته می‌شوند.",
  "coreToast.unavailable.title": "موتور دریافت در دسترس نیست",
  "coreToast.unavailable.body": "دریافت‌ها متوقف شدند. برنامه به تلاش ادامه می‌دهد — کارها و بایت‌های شما در امان هستند.",
};
