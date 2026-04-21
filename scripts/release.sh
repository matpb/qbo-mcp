#!/bin/sh
# Build a distributable qbo-mcp-<version>.mcpb and wrap it in a .zip for email.
# Invoked via `npm run release`. Runs on Mat's Linux/Mac machines; Joel never
# needs this.
set -e

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT="qbo-mcp-${VERSION}"

echo "==> Cleaning previous artifacts"
rm -rf dist "${OUT}.mcpb" "${OUT}.zip"

echo "==> Installing full deps (for tsc)"
npm install --no-audit --no-fund >/dev/null

echo "==> Building TypeScript"
npm run build

echo "==> Pruning devDeps for a lean bundle"
# --ignore-scripts skips the `prepare` hook (which would try to re-run tsc
# after it's been pruned).
npm prune --omit=dev --ignore-scripts >/dev/null

echo "==> Packing .mcpb"
mcpb pack . "${OUT}.mcpb"

echo "==> Zipping for email-friendly delivery"
zip -q "${OUT}.zip" "${OUT}.mcpb"

echo "==> Restoring full deps for dev"
npm install --no-audit --no-fund >/dev/null

SIZE_MCPB=$(du -h "${OUT}.mcpb" | cut -f1)
SIZE_ZIP=$(du -h "${OUT}.zip" | cut -f1)

echo ""
echo "Built:"
echo "  ${OUT}.mcpb  (${SIZE_MCPB})"
echo "  ${OUT}.zip   (${SIZE_ZIP})  <- send this to the user"
