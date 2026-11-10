# qbo-mcp: QuickBooks Online MCP server, shipped as a Claude Desktop extension (.mcpb) for people who keep real books

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.

<!-- Keep under 120 lines. Every command below was run and exited 0 when this file was written. -->

## Ground rules
- Users point this at live company books. Every write tool previews with `draft=true` by default; keep that default on any new write tool.
- Never change `author` in `manifest.json`: Claude Desktop derives the extension id from it, so a change installs a second extension instead of updating the first.
- A QBO behavior claim needs the sandbox smoke test, not reasoning: Intuit's update semantics are inconsistent and only an API call settles them.
- A release bumps the version in `package.json`, `package-lock.json` and `manifest.json` together, plus a `CHANGELOG.md` entry. The runtime version comes from `package.json`.
- Tool schemas stay strict: `additionalProperties: false` in the definition and `assertKnownKeys` in the handler, so a misspelled key errors instead of silently doing nothing.

## Commands
- Build: `npm run build` (tsc into `dist/`; the scripts below import from `dist/`, so build first)
- Typecheck only: `npx tsc --noEmit`
- Offline unit checks (GL parsing, report summaries): `npm run test:unit`
- End-to-end against the Intuit sandbox: `node scripts/smoke-test.mjs`. Needs a prior sandbox sign-in saved in `~/.quickbooks-mcp/credentials.json`; ends with `Result: N passed, M failed`. Set `SMOKE_VERBOSE=1` for server logs. No single-test filter: it always runs the whole suite.
- Run stdio server: `npm start` (needs `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`, or keys saved by an earlier sign-in)
- Packaging a release: see `scripts/release.sh` (needs the `mcpb` CLI).

## Layout worth knowing
- Shipped entry points: `src/index.ts` (stdio, what the .mcpb runs) and `src/http-server.ts` (self-hosted Docker). `src/lambda.ts` is not wired to any npm script, the manifest or the Dockerfile.
- A new tool touches three places: the schema in `src/tools/definitions.ts`, a handler in `src/tools/handlers/` exported from its `index.ts`, and a `toolHandlers.set` line in `src/tools/index.ts`.
- `docs/` is gitignored, yet `USER-GUIDE.md`, `callback.html`, `CNAME` and `.nojekyll` are tracked: a new file there needs `git add -f`.
- `docs/` is the GitHub Pages site. `callback.html` is the OAuth redirect URI every user registered in their Intuit app: never move or rename it.
- `.mcpbignore` decides what goes into the bundle, separately from `.gitignore`.

## Conventions
- Release commits: `type: summary (x.y.z)`, for example `fix: ... (0.4.12)`.
- `CHANGELOG.md` is written for the end user (a bookkeeper), not for engineers: what they can now do, in plain words.
- QBO query strings: escape a quote as `\'`. The SQL-style `''` returns a bare 400 with no body.
- Intuit query language: only AND; no OR, IN, parentheses or JOIN, and some transaction fields are not filterable.

## Landmines
- Clearing a line ref on edit: bill, expense, vendor credit and sales receipt need an explicit JSON `null` (omitting the key keeps the old value; `{value:"0"}` returns 400). Deposit lines are the opposite: only `{value:"0"}` clears, `null` and omission are ignored.
- Strip `Line.ProjectRef` on every full-update round trip, or QBO silently rejects a line's customer change. Writing `ProjectRef` directly is always rejected.
- Full updates preserve `GlobalTaxCalculation` and `TxnTaxDetail`, or QBO flips the tax model to NotApplicable. But drop `TxnTaxDetail` when a line tax code changes or tax calc is overridden, or manual-tax companies get `[3060] Invalid Tax Rate`.
- Payroll paychecks are not readable through entity queries; they only come from General Ledger rows (`src/query/gl-postings.ts`). Type labels vary by locale: match Paycheck and Paycheque, Check and Cheque.
- Find the GL amount column by its column key, never by position or title: multicurrency books title it differently, and some return no amount column at all (the code falls back to a second call with default columns).
- node-quickbooks `reportCriteria` forwards unknown options as raw query params; a typo becomes a silent API parameter.
- `.mcpbignore` must keep excluding root `*.mcpb` and `*.zip`, or each release bundles the previous ones and the file balloons to hundreds of MB.
- On Windows the OAuth browser launch uses `rundll32`: `cmd /c start` mangles the `&` in the consent URL.
- Auth errors retry once after clearing the credential cache (`executeTool`); an `invalid_grant` that survives the retry means the user must sign in again.

## Deeper context
- Install, OAuth flow, HTTP/Docker deploy, troubleshooting: `README.md`
- What users can do and the documented limitations: `docs/USER-GUIDE.md`
- Env vars for HTTP mode: `.env.example`
- Raw Reports API response shapes: `scripts/reports-v2-dump.mjs`
- Per-version behavior changes: `CHANGELOG.md`
