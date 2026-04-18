# qbo-mcp

A production-ready QuickBooks Online MCP server with standard OAuth 2.0 and
Docker deploy. Forked from
[laf-rge/quickbooks-mcp](https://github.com/laf-rge/quickbooks-mcp) (MIT).

Gives Claude full read/write access to your QuickBooks books through natural
conversation — P&L, balance sheet, invoices, bills, expenses, journal entries,
customer/vendor lookup, etc. See [`docs/USER-GUIDE.md`](./docs/USER-GUIDE.md)
for the user-facing capability reference (what Claude can and can't do).

**Single-tenant by design.** One container, one QuickBooks company.

---

## Table of contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Register your Intuit Developer app](#register-your-intuit-developer-app)
- [Deploy](#deploy)
- [Connect to QuickBooks](#connect-to-quickbooks)
- [Connect from Claude](#connect-from-claude)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Environment variables](#environment-variables)
- [Phase 2b — claude.ai custom connector OAuth](#phase-2b--claudeai-custom-connector-oauth)
- [Blast radius & recovery](#blast-radius--recovery)
- [Development](#development)
- [Repository layout](#repository-layout)
- [License](#license)

---

## How it works

```
Claude Desktop / claude.ai           admin's browser
        │                                   │
        │  POST /mcp                        │  GET /qbo/connect?token=…
        │  (Streamable HTTP)                │  GET /qbo/callback?code=…
        ▼                                   ▼
┌───────────────────────────────────────────────────┐
│  Docker container: qbo-mcp                        │
│                                                   │
│  listens on :8080, behind TLS reverse proxy       │
│                                                   │
│  routes:                                          │
│    POST /mcp            → MCP tool dispatch       │
│    GET  /qbo/connect    → redirect to Intuit      │
│    GET  /qbo/callback   → exchange code → tokens  │
│    GET  /qbo/status     → "am I connected?"       │
│    GET  /healthz                                  │
└──────────────────┬────────────────────────────────┘
                   │ reads + writes
                   ▼
         /data/qbo-credentials.json       ← mounted host volume
                   │
                   │ OAuth 2.0 refresh_token grant
                   ▼
             Intuit QuickBooks Online API
```

**No OAuth Playground dance.** An admin visits `/qbo/connect` in their browser
once, clicks "Allow" in Intuit's UI, and the server stores the tokens. That's
it — the same flow you'd use to connect any normal SaaS integration.

---

## Quick start

Prerequisites: Docker, an Intuit Developer account, a public HTTPS URL (behind
whatever TLS-terminating reverse proxy you use — APISIX, nginx, Caddy, etc.).

```bash
# 1. Clone
git clone git@github.com:YOU/qbo-mcp.git && cd qbo-mcp

# 2. Configure
cp .env.example .env
# edit .env — see Environment variables below
# key values: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI, QBO_SETUP_TOKEN

# 3. Register QBO_REDIRECT_URI in your Intuit Developer app
# (developer.intuit.com → Keys & credentials → Production → Redirect URIs)

# 4. Run
docker compose up -d

# 5. Wire your reverse proxy to forward https://your-domain/ → 127.0.0.1:8420

# 6. Connect to QuickBooks (one-time, from any browser):
#    https://your-domain/qbo/connect?token=<QBO_SETUP_TOKEN>
#    → click "Allow" in Intuit's consent screen → done
```

After step 6, `GET /qbo/status` should return `{"configured":true, "company_id":"..."}`.

---

## Register your Intuit Developer app

You only do this once per deploy.

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in.
2. **Dashboard → Create an app → QuickBooks Online and Payments**.
3. Name it (e.g. `Claude MCP`) and create.
4. **Keys & credentials → Production tab** (not Sandbox unless you're
   explicitly testing against a sandbox company).
5. Copy **Client ID** and **Client Secret** — these go in `.env` as
   `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET`.
6. Under **Redirect URIs**, add your callback URL. It must end in
   `/qbo/callback` and match `QBO_REDIRECT_URI` exactly:
   ```
   https://qbo.example.com/qbo/callback
   ```
   Save.

That's the whole Intuit-side setup. No OAuth Playground, no URL copy-paste.

---

## Deploy

The container binds only to `127.0.0.1:8420` on the host — it expects a
reverse proxy in front of it for TLS and public routing. On a typical
Docker+APISIX host:

```bash
# On the Docker host
git clone git@github.com:YOU/qbo-mcp.git /opt/qbo-mcp
cd /opt/qbo-mcp
cp .env.example .env
# fill in .env...
docker compose up -d

# Check logs
docker compose logs -f qbo-mcp

# Smoke-test (from the host)
curl http://127.0.0.1:8420/healthz
# {"status":"ok"}
```

### Reverse-proxy snippet (APISIX)

```yaml
routes:
  - uri: /qbo/*
    host: qbo.example.com
    upstream:
      type: roundrobin
      nodes: { "127.0.0.1:8420": 1 }
  - uri: /mcp
    host: qbo.example.com
    upstream:
      type: roundrobin
      nodes: { "127.0.0.1:8420": 1 }
  - uri: /healthz
    host: qbo.example.com
    upstream:
      type: roundrobin
      nodes: { "127.0.0.1:8420": 1 }
```

### Reverse-proxy snippet (Caddy)

```caddy
qbo.example.com {
  reverse_proxy 127.0.0.1:8420
}
```

### Reverse-proxy snippet (nginx)

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

The `X-Forwarded-Proto` and `X-Forwarded-Host` headers matter — the server
uses them to build the callback URL it hands back to Intuit.

---

## Connect to QuickBooks

Once the container is running and reachable over HTTPS:

1. Open `https://qbo.example.com/qbo/connect?token=<QBO_SETUP_TOKEN>` in a
   browser. (You can leave `QBO_SETUP_TOKEN` empty for local-dev testing — it
   disables the gate. For anything you expose publicly, set it.)
2. The server 302s you to Intuit's authorize page.
3. Sign in with the Intuit account that owns your QBO company, pick the
   company, click **Connect**.
4. Intuit redirects back to `/qbo/callback?code=…&realmId=…&state=…`.
5. The server exchanges the code for access + refresh tokens and writes them
   to `/data/qbo-credentials.json` inside the container (= `./data/` on the
   host via the bind mount).
6. You see a green "QuickBooks connected" page showing your realm ID.

Verify:

```bash
curl https://qbo.example.com/qbo/status
# {"configured":true,"company_id":"9130350484847232","environment":"production"}
```

### When to re-connect

- **Intuit refresh tokens expire after 100 days of inactivity.** If no MCP
  tool call happens for 100+ days, the next one will fail with `invalid_grant`
  and you'll need to re-visit `/qbo/connect`. Normal use prevents this
  automatically.
- **After rotating the Intuit client secret.** Every existing token is
  invalidated — revisit `/qbo/connect` with the new secret in `.env`.
- **After disconnecting the app from QBO** (user-initiated revoke).

Re-connecting is just: visit `/qbo/connect`, click Allow, done. ~10 seconds.

---

## Connect from Claude

Three options, in order of ease:

### Claude Desktop (stdio bridge)

Use `mcp-remote` or a similar bridge to connect Claude Desktop to the
remote HTTP endpoint. In your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://qbo.example.com/mcp"
      ]
    }
  }
}
```

### claude.ai web (Phase 2b)

Not supported yet — requires the OAuth AS proxy
([see below](#phase-2b--claudeai-custom-connector-oauth)).

### Direct HTTP (any MCP client that speaks Streamable HTTP)

Point the client at `https://qbo.example.com/mcp`. No auth header required in
Phase 2a; the reverse proxy or your network perimeter is the gate.

---

## Operations

### Updating the server

```bash
cd /opt/qbo-mcp
git pull
docker compose build
docker compose up -d
# tokens persist via the mounted ./data volume
```

### Rotating the Intuit client secret

1. Rotate in the Intuit Developer dashboard (Keys & credentials → Production
   → Rotate client secret).
2. Update `QBO_CLIENT_SECRET` in `.env`.
3. `docker compose up -d` — picks up the new env.
4. Visit `/qbo/connect` to get new tokens (old ones are now invalid).

### Backing up tokens

The `./data/qbo-credentials.json` file is the source of truth. Back it up with
whatever you use for the rest of the host's persistent state. Encrypted at
rest is recommended — the file contains live access + refresh tokens.

### Viewing logs

```bash
docker compose logs -f qbo-mcp
```

---

## Troubleshooting

### `/qbo/connect` returns 403 forbidden

`QBO_SETUP_TOKEN` is set and `?token=` didn't match. Check `.env` and retry.

### `/qbo/connect` returns 500 misconfigured

Missing `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, or `QBO_REDIRECT_URI`. Check `.env`
and `docker compose exec qbo-mcp env | grep QBO_`.

### Intuit shows "redirect_uri mismatch"

The `QBO_REDIRECT_URI` env var doesn't match any Redirect URI registered in
your Intuit Developer app's Production tab. They must match exactly, including
trailing slashes and the path (`/qbo/callback`).

### `/qbo/callback` returns "Invalid state"

The OAuth state expired (>5 min between `/qbo/connect` and clicking Allow) or
the container restarted mid-flow (state is in-memory). Restart the flow at
`/qbo/connect`.

### `invalid_grant` from Intuit at token exchange

- The callback was replayed (auth code is single-use).
- The callback URL Intuit sent you differs from the one registered (check
  `X-Forwarded-Proto` / `X-Forwarded-Host` headers from your reverse proxy).
- The client secret was rotated and `.env` has the old one.

### MCP tool calls return `401` after weeks of working

Refresh token hit the 100-day inactivity expiry, or the user disconnected the
app on the Intuit side. Revisit `/qbo/connect`.

### Tools return data but writes silently do nothing

`QBO_INLINE_OUTPUT=true` should be the default (set in the Dockerfile and
docker-compose.yml). Without it, the server writes to `/tmp` files that don't
persist meaningfully.

### Container fails to start with "credentials file not found"

Normal on first run before you've connected. The server still starts and
serves `/qbo/connect`, `/qbo/callback`, `/qbo/status`, and `/healthz` — only
`/mcp` tool calls fail until tokens are saved. Visit `/qbo/connect` to
bootstrap.

---

## Environment variables

See [`.env.example`](./.env.example) for the annotated template.

### Required

| Variable | Purpose |
|---|---|
| `QBO_CLIENT_ID` | From your Intuit Developer app |
| `QBO_CLIENT_SECRET` | From your Intuit Developer app |
| `QBO_REDIRECT_URI` | Public callback URL ending in `/qbo/callback` |
| `QBO_SETUP_TOKEN` | Shared secret for `/qbo/connect` (leave empty only in local dev) |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `QBO_SANDBOX` | `false` | Use Intuit Sandbox endpoints |
| `QBO_CREDENTIAL_MODE` | `local` | Provider: `local` (file) or `aws` (upstream-only) |
| `QBO_CREDENTIAL_FILE` | `/data/qbo-credentials.json` | Token file path |
| `QBO_INLINE_OUTPUT` | `true` | Return tool output inline (required for container deploys) |

### Phase 2b (OAuth AS proxy, off by default)

| Variable | Purpose |
|---|---|
| `MCP_AUTH_ENABLED` | `true` to enable claude.ai OAuth DCR gate on `/mcp` |
| `MCP_AUTHORIZE_URL` | Upstream AS `/authorize` endpoint |
| `MCP_TOKEN_URL` | Upstream AS `/token` endpoint |
| `MCP_AUTH_ISSUER` | Expected `iss` claim |
| `MCP_AUTH_AUDIENCE` | Expected `aud` claim |
| `MCP_AUTH_SCOPE` | Required scope |

---

## Phase 2b — claude.ai custom connector OAuth

claude.ai's "Add custom connector" flow requires the MCP server itself to
speak OAuth 2.1 with DCR + PKCE at the transport layer. The OAuth AS proxy
machinery is already in `src/http-server.ts` but gated off by default.

When you're ready to enable claude.ai web access:

1. Stand up an OAuth AS somewhere (Auth0 free tier, Keycloak, or your own).
   Allowlist the Google identities / email domains that should be able to
   connect.
2. Set the `MCP_AUTH_*` env vars pointing at the AS.
3. Flip `MCP_AUTH_ENABLED=true` and restart.

claude.ai will then discover the OAuth endpoints via
`/.well-known/oauth-authorization-server`, do DCR + PKCE against your AS, and
present the bearer token on every `/mcp` call. The server validates the token
before dispatching MCP tools.

---

## Blast radius & recovery

### What the tokens grant

The `com.intuit.quickbooks.accounting` scope grants read + write access to:

**Read:** full P&L, balance sheet, GL, cash flow, trial balance, every
invoice, bill, expense, journal entry, deposit, transfer, customer list (with
emails + addresses + tax IDs), vendor list, bank balances.

**Write:** create / edit / delete invoices, bills, expenses, sales receipts,
deposits, journal entries, vendor credits, customers, vendors.

### What the tokens *cannot* do

- ❌ Move actual money (no Payments scope — no credit card charges, no ACH)
- ❌ Access payroll (Intuit API doesn't expose it)
- ❌ Connect/modify bank feeds
- ❌ File taxes
- ❌ Log into QuickBooks Online UI as a user

### Recovery — the hot path

If you suspect compromise of `./data/qbo-credentials.json`:

1. **Revoke from Intuit immediately** — either rotate the client secret at
   developer.intuit.com (invalidates all tokens in seconds) or disconnect the
   app from QBO (Gear → Apps → Connected apps → Disconnect).
2. Check the QBO audit log (Gear → Audit Log) for suspicious activity.
3. If the token file specifically was leaked (not the host): delete
   `./data/qbo-credentials.json`, update `QBO_CLIENT_SECRET` in `.env` if
   you also rotated the secret, `docker compose up -d`, revisit
   `/qbo/connect`.

---

## Development

### Local stdio mode (for running the OAuth dance via Claude Code)

Unchanged from upstream laf-rge:

```bash
export QBO_CLIENT_ID=… QBO_CLIENT_SECRET=… QBO_CREDENTIAL_MODE=local
npm install
npm run build
npm start     # stdio
```

### Local HTTP mode (simulate the container)

```bash
export QBO_CLIENT_ID=… QBO_CLIENT_SECRET=…
export QBO_REDIRECT_URI=http://localhost:8080/qbo/callback
export QBO_SETUP_TOKEN=dev-token
export QBO_CREDENTIAL_FILE=./dev-credentials.json
npm run build
npm run start:http
# then visit http://localhost:8080/qbo/connect?token=dev-token
```

Intuit *does* accept `http://localhost` redirect URIs for dev — register
`http://localhost:8080/qbo/callback` in your Intuit app's Redirect URIs.

### Building the container

```bash
docker compose build
docker compose up -d
```

---

## Repository layout

```
qbo-mcp/
├── README.md
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── .dockerignore
├── .gitignore
├── package.json
├── tsconfig.json
├── LICENSE                         — MIT
│
├── src/
│   ├── http-server.ts              — ⭐ HTTP entrypoint: /mcp + /qbo/connect + /qbo/callback
│   ├── index.ts                    — stdio entrypoint (upstream, for local OAuth dance)
│   ├── lambda.ts                   — AWS Lambda entrypoint (upstream, unused)
│   ├── server.ts                   — shared MCP Server setup
│   │
│   ├── credentials/
│   │   ├── aws-provider.ts         — upstream, unused
│   │   ├── local-provider.ts       — file-based; what we use in the container
│   │   ├── oauth-client.ts         — upstream intuit-oauth wrapper (stdio flow only)
│   │   ├── types.ts                — CredentialProvider interface + helpers
│   │   └── index.ts                — factory
│   │
│   ├── auth/token-validator.ts     — JWT validation for Phase 2b
│   ├── client/                     — node-quickbooks wrapper with retry
│   ├── query/                      — generic QBO query layer
│   ├── reports/                    — report formatters
│   ├── tools/                      — MCP tool definitions + handlers
│   ├── types/                      — TS type declarations
│   └── utils/                      — output mode, money formatting, etc.
│
└── docs/
    └── USER-GUIDE.md               — user-facing capability reference
```

`⭐` = material changes vs. upstream laf-rge.

---

## License

MIT. Inherits from [laf-rge/quickbooks-mcp](https://github.com/laf-rge/quickbooks-mcp).
