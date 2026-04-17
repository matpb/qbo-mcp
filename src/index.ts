#!/usr/bin/env node
// QuickBooks MCP Server - Entry Point
// Load .env file from the package directory (workaround for Claude Code env var bug)
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";
import { setOutputMode } from "./utils/output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Look for .env in the package root (one level up from dist/)
config({ path: join(__dirname, "..", ".env"), quiet: true });

if (process.env.QBO_INLINE_OUTPUT === "true") {
  setOutputMode("http");
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("QuickBooks MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
