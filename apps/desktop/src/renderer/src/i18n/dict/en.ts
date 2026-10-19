import { commonEn } from "./common.js";
import { browseEn } from "./browse.js";
import { downloadsEn } from "./downloads.js";
import { mediaEn } from "./media.js";
import { torrentsEn } from "./torrents.js";
import { schedulerEn } from "./scheduler.js";
import { proxyEn } from "./proxy.js";
import { libraryEn } from "./library.js";
import { settingsEn } from "./settings.js";
import { diagnosticsEn } from "./diagnostics.js";
import { helpEn } from "./help.js";

/**
 * The composed English dictionary — the single source of truth for the i18n key set.
 * `TKey` is its literal key union; the Persian dictionary is typed `Record<TKey, string>`,
 * so a missing or extra key on either side is a compile error (and a runtime test
 * re-verifies the sets anyway).
 */

export const en = Object.freeze({
  ...commonEn,
  ...browseEn,
  ...downloadsEn,
  ...mediaEn,
  ...torrentsEn,
  ...schedulerEn,
  ...proxyEn,
  ...libraryEn,
  ...settingsEn,
  ...diagnosticsEn,
  ...helpEn,
});

export type TKey = keyof typeof en;
