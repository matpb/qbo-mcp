// Report summary extraction utilities

import { QBReport } from "../types/index.js";

export function extractReportSummary(report: QBReport, reportType: string): string {
  const header = report.Header || {};
  const columns = report.Columns?.Column || [];
  const rows = report.Rows?.Row || [];

  const lines: string[] = [];

  // Report title and period
  lines.push(`${header.ReportName || reportType}`);
  if (header.StartPeriod && header.EndPeriod) {
    lines.push(`Period: ${header.StartPeriod} to ${header.EndPeriod}`);
  } else if (header.EndPeriod) {
    lines.push(`As of: ${header.EndPeriod}`);
  }
  if (header.ReportBasis) {
    lines.push(`Basis: ${header.ReportBasis}`);
  }

  // Column headers (departments if summarized)
  const colTitles = columns.map(c => c.ColTitle).filter(Boolean);
  if (colTitles.length > 2) {
    lines.push(`Columns: ${colTitles.slice(1).join(", ")}`);
  }

  // Extract summaries by group field
  const groupOrder = reportType.includes("Balance")
    ? ["TotalAssets", "TotalLiabilitiesAndEquity"]
    : ["Income", "COGS", "GrossProfit", "Expenses", "NetOperatingIncome", "NetIncome"];

  const groupLabels: Record<string, string> = {
    Income: "Total Income",
    COGS: "Total Cost of Goods Sold",
    GrossProfit: "Gross Profit",
    Expenses: "Total Expenses",
    NetOperatingIncome: "Net Operating Income",
    OtherExpenses: "Total Other Expenses",
    NetOtherIncome: "Net Other Income",
    NetIncome: "Net Income",
    TotalAssets: "Total Assets",
    TotalLiabilitiesAndEquity: "Total Liabilities and Equity",
  };

  for (const groupName of groupOrder) {
    const row = rows.find(r => r.type === "Section" && r.group === groupName);
    if (row?.Summary?.ColData) {
      const values = row.Summary.ColData.slice(1).map(c => c.value || "0");
      const value = colTitles.length > 2 ? values[values.length - 1] : values[0];
      const label = groupLabels[groupName] || groupName;
      lines.push(`${label}: ${value}`);
    }
  }

  return lines.join("\n");
}
