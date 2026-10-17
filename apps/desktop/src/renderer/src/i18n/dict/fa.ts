import type { TKey } from "./en.js";
import { commonFa } from "./common.js";
import { browseFa } from "./browse.js";
import { downloadsFa } from "./downloads.js";
import { mediaFa } from "./media.js";
import { torrentsFa } from "./torrents.js";
import { schedulerFa } from "./scheduler.js";
import { proxyFa } from "./proxy.js";
import { libraryFa } from "./library.js";
import { settingsFa } from "./settings.js";
import { diagnosticsFa } from "./diagnostics.js";

/**
 * The composed Persian dictionary. The `Record<TKey, string>` annotation is the
 * compile-time completeness proof against the English key set; the runtime test
 * (`__tests__/i18n.test.ts`) re-checks the sets and placeholder parity.
 */

export const fa: Record<TKey, string> = Object.freeze({
  ...commonFa,
  ...browseFa,
  ...downloadsFa,
  ...mediaFa,
  ...torrentsFa,
  ...schedulerFa,
  ...proxyFa,
  ...libraryFa,
  ...settingsFa,
  ...diagnosticsFa,
});
