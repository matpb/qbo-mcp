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
    const raw = "```json\n" + JSON.stringify(data, null, 2) + "\n```";
    return {
      content: [
        { type: "text", text: `${summary}\n\nRaw data:\n${raw}` },
      ],
    };
  }

  const filepath = writeReport(reportType, data);
  return {
    content: [{ type: "text", text: `${summary}\n\nFull data: ${filepath}` }],
  };
}
