// Runtime package version, read from the package.json that ships next to dist/.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "qbo-mcp" && pkg.version) return pkg.version;
    } catch {
      // no package.json at this level
    }
    dir = dirname(dir);
  }
  return "unknown";
}

export const PACKAGE_VERSION = readVersion();
