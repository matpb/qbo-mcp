// Output mode utilities for stdio vs HTTP transport
// In stdio mode: write full data to temp files, return filepath reference
// In HTTP mode: return data inline (no filesystem access in Lambda)

import { writeReport } from "./files.js";

export type OutputMode = "stdio" | "http";

let currentOutputMode: OutputMode = "stdio";

export function setOutputMode(mode: OutputMode): void {
  currentOutputMode = mode;
}

export function isHttpMode(): boolean {
  return currentOutputMode === "http";
}

type ToolResult = { content: Array<{ type: string; text: string }> };

/**
 * Return report data in the appropriate format for the current transport.
 * - stdio: writes to temp file, appends filepath to summary
 * - http: returns summary + inline JSON data
 */
export function outputReport(reportType: string, data: unknown, summary: string): ToolResult {
  if (isHttpMode()) {
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(data) },
      ],
    };
  }

  const filepath = writeReport(reportType, data);
  return {
    content: [{ type: "text", text: `${summary}\n\nFull data: ${filepath}` }],
  };
}
