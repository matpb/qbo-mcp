# qbo-mcp

Local-first QuickBooks Online MCP server. Ships as a one-click Claude Desktop
extension (`.mcpb`) so non-engineer users can connect their books to Claude in
about two minutes.

Tokens stay on the user's machine at `~/.quickbooks-mcp/credentials.json`. No
server to run, no Docker, no reverse proxy.

> See [`docs/USER-GUIDE.md`](./docs/USER-GUIDE.md) for what Claude can do once
> connected — reports, queries, creating/editing transactions, and the
> operations that aren't supported.

---

## Install

### 1. Download the extension

Grab the latest `qbo-mcp.mcpb` from the
[releases page](https://github.com/matpb/qbo-mcp/releases).

### 2. Register an Intuit Developer app

You need your own Intuit app to authorize access to your books. Claude never
sees your Intuit password — the app is just how Intuit knows who's asking.

1. Sign in at [developer.intuit.com](https://developer.intuit.com).
2. **Dashboard → Create an app → QuickBooks Online and Payments**.
3. Name it (e.g. `Claude MCP`) and create.
4. **Keys & credentials → Production** (or Sandbox if you're testing).
5. Under **Redirect URIs**, add:
   ```
   https://qbo-mcp.matpb.com/callback.html
   ```
   Save. This is the static bounce page that hands the OAuth code back to
   your local machine. It holds nothing — the tokens never leave your laptop.
6. Copy the **Client ID** and **Client Secret** from this page; you'll need
   them in the next step.

### 3. Install into Claude Desktop

Double-click `qbo-mcp.mcpb`. Claude Desktop opens an install prompt asking for:

- **Intuit Client ID** — from step 2.
- **Intuit Client Secret** — from step 2.
- **Use Intuit Sandbox** — leave off for real books; turn on for sandbox data.

Install. The QuickBooks extension is now live.

### 4. Authorize

In a Claude Desktop chat, run:

> Connect me to QuickBooks.

Claude calls the `qbo_authenticate` tool, which:

1. Opens your browser to Intuit's consent page.
2. You sign in and pick which company to connect.
3. Intuit redirects through `qbo-mcp.matpb.com/callback.html`, which bounces
   the code back to a temporary `127.0.0.1` listener in the extension.
4. The extension exchanges the code for access + refresh tokens and saves
   them to `~/.quickbooks-mcp/credentials.json`.

Claude confirms with the company ID. Done.

---

## Day-to-day use

Just ask Claude. It'll call the right QBO tools.

Examples:

- *"Pull the P&L for Q1 2026."*
- *"Show me customer 58's outstanding invoices."*
- *"Create a journal entry debiting Rent $2,000 and crediting Bank $2,000."*

Every write tool defaults to `draft=true` and returns a preview first — you
confirm with `draft=false` before it touches the books.

See [`docs/USER-GUIDE.md`](./docs/USER-GUIDE.md) for the full capability list.

---

## When to re-authorize

- **Refresh tokens expire after 100 days of inactivity.** If nobody asks
  Claude anything QBO-related for 100+ days, the next call fails with
  `invalid_grant`. Just re-run the authorize step.
- **After rotating the Intuit Client Secret.** All tokens are invalidated —
  update the secret in the extension settings, restart the extension, and
  re-authorize.
- **After disconnecting the app from QBO** (QBO → Gear → Apps → Connected
  apps → Disconnect).

---

## Configuration

The `.mcpb` install surfaces three fields in Claude Desktop's extension
settings:

| Field | Required | Notes |
|---|---|---|
| Intuit Client ID | yes | From your Intuit Developer app |
| Intuit Client Secret | yes | From your Intuit Developer app |
| Use Intuit Sandbox | no | Connect to sandbox test data instead of real books |

Credentials file: `~/.quickbooks-mcp/credentials.json` (on macOS/Linux) or
`%USERPROFILE%\.quickbooks-mcp\credentials.json` (on Windows). Delete it to
force a clean re-authorize.

---

## Troubleshooting

### Intuit shows "redirect_uri mismatch" during authorize

The redirect URI registered in your Intuit Developer app doesn't exactly
match `https://qbo-mcp.matpb.com/callback.html`. Check for trailing slashes
or typos. Must be in the **Production** tab (unless you enabled Sandbox in
the extension settings, in which case it must be under Sandbox keys).

### "Loopback OAuth timed out after 300s"

You closed the browser tab, took too long, or another process is hogging
ephemeral ports. Re-run authorize.

### MCP tool calls return `401` after weeks of working

Refresh token hit the 100-day inactivity expiry, or the app was disconnected
on the Intuit side. Re-run authorize.

### "Missing Client Credentials"

The extension can't find the client ID / secret. In Claude Desktop, open
the QuickBooks extension settings, confirm both fields are filled, and
restart the extension.

### Intuit error responses look generic

Any QBO-side error (400 / validation fault / etc.) surfaces Intuit's
`Fault.Error[]` message and code through the MCP tool result. One known
Intuit quirk: quote-escaping inside `query` with SQL-style doubled quotes
(`''`) returns a bare 400 with no body — use a backslash-escape (`\'`) in
string literals instead.

---

## Advanced: self-hosted HTTP / Docker

The server also runs as a long-lived HTTP service for shared or server-side
deployments — multiple Claude clients hitting one tenant, unattended agent
use, etc.

```bash
git clone https://github.com/matpb/qbo-mcp && cd qbo-mcp
cp .env.example .env
# fill QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI (your https
# callback), QBO_SETUP_TOKEN (random string)
docker compose up -d
# listens on 127.0.0.1:8420 — front it with your own TLS reverse proxy
# and register the /qbo/callback URL in the Intuit app.
```

Reverse proxy (nginx example):

```nginx
server {
  listen 443 ssl http2;
  server_name qbo.example.com;
  ssl_certificate     /etc/letsencrypt/live/qbo.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/qbo.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:8420;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $host;
  }
}
```

Once live, visit `https://qbo.example.com/qbo/connect?token=<QBO_SETUP_TOKEN>`
once from any browser to complete OAuth. Point your MCP client at
`https://qbo.example.com/mcp`. Claude Desktop users can bridge via
`mcp-remote`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://qbo.example.com/mcp"]
    }
  }
}
```

A claude.ai custom-connector path (OAuth AS proxy with DCR + PKCE) exists in
`src/http-server.ts` but is gated off. Flip `MCP_AUTH_ENABLED=true` and set
the `MCP_AUTH_*` env vars to enable it.

---

## Blast radius & recovery

The `com.intuit.quickbooks.accounting` scope grants read + write access to:

- **Read:** full P&L, balance sheet, GL, cash flow, trial balance, every
  transaction, customer list (with emails + addresses + tax IDs), vendor
  list, bank balances.
- **Write:** create / edit / delete invoices, bills, expenses, sales
  receipts, deposits, journal entries, vendor credits, customers, vendors.

The scope does **not** grant: moving money (no Payments scope), payroll,
bank feeds, tax filing, or UI login.

If you suspect `~/.quickbooks-mcp/credentials.json` is compromised:

1. In the Intuit Developer dashboard, rotate the Client Secret (invalidates
   all tokens in seconds) or disconnect the app from QBO (Gear → Apps →
   Connected apps → Disconnect).
2. Check the QBO audit log for suspicious activity.
3. Delete `~/.quickbooks-mcp/credentials.json`, update the secret in the
   extension settings, restart, re-authorize.

---

## Development

Clone, install, build, pack:

```bash
git clone https://github.com/matpb/qbo-mcp && cd qbo-mcp
npm install
npm run build
npx -y @anthropic-ai/mcpb pack    # produces qbo-mcp.mcpb
```

Run in stdio mode (Claude Code, local shell):

```bash
export QBO_CLIENT_ID=... QBO_CLIENT_SECRET=...
npm start
```

Run in HTTP mode (simulates the container):

```bash
export QBO_CLIENT_ID=... QBO_CLIENT_SECRET=...
export QBO_REDIRECT_URI=http://localhost:8080/qbo/callback
export QBO_SETUP_TOKEN=dev-token
export QBO_CREDENTIAL_FILE=./dev-credentials.json
npm run start:http
# http://localhost:8080/qbo/connect?token=dev-token
```

Intuit does accept `http://localhost` redirect URIs — register
`http://localhost:8080/qbo/callback` in your Intuit app during dev.

---

## Repository layout

```
qbo-mcp/
├── manifest.json                  — MCPB bundle manifest (Claude Desktop)
├── src/
│   ├── index.ts                   — stdio entrypoint (default for .mcpb)
│   ├── http-server.ts             — HTTP entrypoint for self-hosted deploys
│   ├── server.ts                  — shared MCP server setup
│   ├── credentials/               — OAuth client, loopback flow, credential storage
│   ├── client/                    — node-quickbooks wrapper + caches + promisify
│   ├── tools/                     — MCP tool definitions + handlers
│   ├── reports/                   — report summary formatters
│   ├── query/                     — generic QBO query layer
│   ├── utils/                     — output mode, money, file utils
│   └── types/                     — shared TS types
├── docs/
│   ├── USER-GUIDE.md              — capability reference for end users
│   ├── callback.html              — OAuth bounce page (GitHub Pages)
│   └── CNAME                      — qbo-mcp.matpb.com
├── docker-compose.yml             — self-hosted HTTP deploy
├── Dockerfile
└── .env.example
```

---

## License

MIT. Forked from
[laf-rge/quickbooks-mcp](https://github.com/laf-rge/quickbooks-mcp) — the
upstream is the origin of the underlying QBO tool surface.
