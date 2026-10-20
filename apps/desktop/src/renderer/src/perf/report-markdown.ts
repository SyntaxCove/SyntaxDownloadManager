import type { BudgetReport } from "@syntaxdm/contracts";

/**
 * Phase 29 — deterministic Markdown rendering of a budget report, the Copy-report
 * button's payload. Lives renderer-side because that is where the clipboard write
 * happens; main assembles and logs the typed report, it never needs the text form.
 * Pure and dependency-free so it is trivially snapshot-testable.
 */
export function budgetReportToMarkdown(report: BudgetReport): string {
  const lines: string[] = [
    "# Performance budget report",
    "",
    `- App: ${report.appVersion} (contracts ${report.contractVersion})`,
    `- Platform: ${report.platform} (${report.osRelease})`,
    `- Source: ${report.source}`,
    `- Generated: ${new Date(report.generatedAt).toISOString()}`,
    `- Verdict: **${report.verdict}** (${report.summary.passed} passed, ${report.summary.breached} breached, ${report.summary.skipped} skipped)`,
    "",
    "| Budget | Actual | Budget | Verdict |",
    "|---|---|---|---|",
  ];
  for (const m of report.measurements) {
    const actual = m.actual === null ? "—" : `${m.actual} ${m.unit}`;
    lines.push(`| ${m.id} | ${actual} | ${m.budget} ${m.unit} | ${m.verdict} |`);
  }
  lines.push(
    "",
    "Budgets live in apps/desktop/resources/perf-budgets.json. Skipped means the producer could not measure on this run — see the app's diagnostics log for details.",
  );
  return lines.join("\n");
}
