import { join } from "node:path";
import type { BudgetReportSource } from "@syntaxdm/contracts";

/**
 * Phase 29 — small pure helpers mapping process facts onto the budget-report's
 * environment fields. Exported so main.ts stays lean and unit tests pin the mapping.
 */

/** The shipped app reports "packaged-app"; a dev checkout reports "dev". */
export function budgetReportSourceLabel(isPackaged: boolean): BudgetReportSource {
  return isPackaged ? "packaged-app" : "dev";
}

/**
 * The renderer bundle's assets directory under the app root — the SAME relative path in
 * dev (apps/desktop/dist/renderer/assets) and packaged (resourcesPath/dist/renderer/assets,
 * per the electron-builder extraResources mapping). Electron's asar-patched fs reads it
 * transparently in both layouts; a missing dir is the report's signal to skip, not crash.
 */
export function rendererAssetsDirUnder(appRoot: string): string {
  return join(appRoot, "dist", "renderer", "assets");
}
