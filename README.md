# qbo-mcp

A production-ready QuickBooks Online MCP server, deployed to Google Cloud Run
with credentials in Secret Manager. Forked from
[laf-rge/quickbooks-mcp](https://github.com/laf-rge/quickbooks-mcp) (MIT) with
GCP-native token storage, a Cloud Run HTTP entrypoint, and deploy automation.

Gives Claude full read/write access to your QuickBooks books through natural
conversation — P&L, balance sheet, invoices, bills, expenses, journal entries,
customer/vendor lookup, etc. See [`docs/USER-GUIDE.md`](./docs/USER-GUIDE.md)
for the user-facing capability reference (what Claude can and can't do).

**Single-tenant by design.** One Cloud Run service, one QuickBooks company.
Multi-tenant deployments are out of scope for this repo.

---

## Table of contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Step 1 — Register an Intuit Developer app](#step-1--register-an-intuit-developer-app)
- [Step 2 — Do the QBO OAuth Playground dance](#step-2--do-the-qbo-oauth-playground-dance)
- [Step 3 — Bootstrap Secret Manager](#step-3--bootstrap-secret-manager)
- [Step 4 — Create the runtime service account](#step-4--create-the-runtime-service-account)
- [Step 5 — Deploy to Cloud Run](#step-5--deploy-to-cloud-run)
- [Step 6 — Grant users access](#step-6--grant-users-access)
- [Step 7 — Connect from Claude](#step-7--connect-from-claude)
- [Updating](#updating)
- [Re-authenticating after 100 days](#re-authenticating-after-100-days)
- [Troubleshooting](#troubleshooting)
- [Environment variables](#environment-variables)
- [Auth modes — 2a (now) vs 2b (future)](#auth-modes--2a-now-vs-2b-future)
- [Blast radius & recovery](#blast-radius--recovery)
- [Development](#development)
- [Repository layout](#repository-layout)
- [License](#license)

---

## Quick start

Once you've completed Steps 1 and 2 (Intuit app + OAuth Playground dance) and
have `~/.quickbooks-mcp/credentials.json` on disk, the full deploy is three
commands:

```bash
export GCP_PROJECT=your-gcp-project-id

./deploy/bootstrap-secret.sh        # seeds Secret Manager from local creds.json
./deploy/setup-service-account.sh   # creates qbo-mcp-runtime SA with scoped IAM
./deploy/deploy.sh                  # Cloud Build + Cloud Run deploy
```

Then grant at least one user access:

```bash
gcloud run services add-iam-policy-binding qbo-mcp \
  --project=$GCP_PROJECT --region=us-central1 \
  --member=user:you@example.com --role=roles/run.invoker
```

If anything fails, skip to [Troubleshooting](#troubleshooting). First time
setting this up? Keep reading — the OAuth dance in Step 2 is the painful part.

---

## Architecture

```
Claude Desktop / claude.ai
        │
        │  HTTPS (signed Google ID token in Authorization header)
        ▼
┌────────────────────────────────────────┐
│  Cloud Run service: qbo-mcp            │
│  region: us-central1 (configurable)    │
│  ingress: all                          │
│  auth:    --no-allow-unauthenticated   │
│  runtime SA: qbo-mcp-runtime           │
│                                        │
│  POST /mcp   → Streamable HTTP (MCP)   │
│  GET  /healthz                         │
└──────────────────┬─────────────────────┘
                   │ reads + writes secret versions
                   ▼
         ┌────────────────────────┐
         │  GCP Secret Manager    │
         │  qbo-credentials       │
         │  {                     │
         │    client_id,          │
         │    client_secret,      │
         │    access_token,       │
         │    refresh_token,      │
         │    company_id          │
         │  }                     │
         └───────────┬────────────┘
                     │ OAuth 2.0 refresh_token grant
                     ▼
             Intuit QuickBooks Online API
```

### Why Secret Manager instead of a mounted file

The QBO refresh token **rotates on every refresh** (typically every hour when
the server is active). Env vars and Docker secrets are read-only from inside a
container — the running process can't write the new refresh token back. A
mounted file would work on a stateful VM, but Cloud Run's filesystem is
ephemeral. Secret Manager's "add new version" model is a perfect fit: every
rotation adds a version, the runtime reads `versions/latest`, old versions age
out by policy.

### Why Cloud Run (not a shared VM)

Cloud Run runs this service in its own container-per-request, no SSH, no
shared kernel with anything else, and the runtime service account has
`secretmanager.secretAccessor` **only on the one `qbo-credentials` secret** —
not project-wide. See [Blast radius](#blast-radius--recovery) for the full
threat model.

---

## Prerequisites

| Tool | Why | How |
|---|---|---|
| `gcloud` CLI | Deploy to Cloud Run + manage secrets | [install](https://cloud.google.com/sdk/docs/install) |
| `jq` | Validates credentials JSON shape in bootstrap script | `apt install jq` / `brew install jq` |
| `node` 20+ | Build the TypeScript locally (Cloud Build handles it server-side) | [install](https://nodejs.org) |
| Intuit Developer account | Owns the OAuth client credentials | [developer.intuit.com](https://developer.intuit.com) |
| QuickBooks Online (Simple Start+) | The actual books — **Solopreneur/Self-Employed has no API access** | subscribe via QBO |
| A Google Cloud project | Hosts the Cloud Run service + Secret Manager secret | [console.cloud.google.com](https://console.cloud.google.com) |

You'll need these IAM roles on the GCP project:

- Cloud Run Admin (`roles/run.admin`)
- Secret Manager Admin (`roles/secretmanager.admin`)
- Service Account Admin (`roles/iam.serviceAccountAdmin`)
- Artifact Registry Admin (`roles/artifactregistry.admin`)
- Cloud Build Editor (`roles/cloudbuild.builds.editor`)

Verify your gcloud context before anything:

```bash
export GCP_PROJECT=your-gcp-project-id
gcloud config set project $GCP_PROJECT
gcloud auth list                          # confirm logged-in account
gcloud projects describe $GCP_PROJECT     # confirm you have access
```

Enable the required APIs (one-time, per project):

```bash
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project=$GCP_PROJECT
```

---

## Step 1 — Register an Intuit Developer app

This gives you the `client_id` + `client_secret` needed to start any OAuth flow
with Intuit.

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in with
   the Intuit account that owns your QuickBooks company.
2. Click **Dashboard → Create an app**.
3. Choose **QuickBooks Online and Payments**.
4. Name the app (e.g. `Claude MCP`).
5. Once created, go to **Keys & credentials**.
6. **Switch to the Production tab** (not Sandbox — unless you're explicitly
   integrating with a Sandbox company). Sandbox tokens won't work against
   production QBO.
7. Copy the **Client ID** and **Client Secret**. Store in a password manager.

### Add the Redirect URI (critical!)

Under **Redirect URIs**, add this exact URL — OAuth will fail without it:

```
https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl
```

We use Intuit's own OAuth Playground as the redirect target. Save the changes.

---

## Step 2 — Do the QBO OAuth Playground dance

This is the hardest, fiddliest part of the whole process. Go slowly. Get a
fresh coffee.

### Why this dance exists

Intuit's OAuth flow requires a registered redirect URI. For a production app
deployed at a public HTTPS URL you'd use something like
`https://your-service.example.com/oauth/callback`. But for this
"dev does a one-time bootstrap and pastes tokens into Secret Manager" flow,
we need a redirect URL that:

1. Is already registered against our Intuit app (the one we added in Step 1)
2. Shows us the auth code + realmId clearly so we can copy them

Intuit's **OAuth Playground**
(`https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`) is the
canonical way to do this. It's a hosted page whose job is literally "show the
user the auth code and realmId that Intuit just redirected with".

### Prep

Check out the upstream laf-rge repo *somewhere* — we only use it to drive the
`qbo_authenticate` stdio tool locally:

```bash
git clone https://github.com/laf-rge/quickbooks-mcp.git
cd quickbooks-mcp
npm install
npm run build
```

Create `.env` in the laf-rge repo root:

```bash
cat > .env <<EOF
QBO_CLIENT_ID=<paste Production Client ID from Step 1>
QBO_CLIENT_SECRET=<paste Production Client Secret from Step 1>
QBO_CREDENTIAL_MODE=local
QBO_SANDBOX=false
QBO_INLINE_OUTPUT=true
EOF
```

**Do not commit this `.env`.** The laf-rge `.gitignore` already excludes it.

### Register laf-rge as an MCP server in Claude Code

In the laf-rge project directory, create `.mcp.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/quickbooks-mcp",
      "env": {}
    }
  }
}
```

Replace `/absolute/path/to/quickbooks-mcp` with the actual absolute path.
Restart Claude Code (or `/mcp` to reconnect) so it picks up the new server.

### Step 2a — Kick off the auth flow

In Claude Code, in that project directory, ask:

> "Authenticate with QuickBooks"

Claude will call the `qbo_authenticate` tool and return an **authorization
URL**. It looks like:

```
https://appcenter.intuit.com/connect/oauth2?client_id=AB...&scope=com.intuit.quickbooks.accounting&redirect_uri=https%3A%2F%2Fdeveloper.intuit.com%2Fv2%2FOAuth2Playground%2FRedirectUrl&response_type=code&state=...
```

**Copy it.** Open it in a browser.

### Step 2b — Authorize in the browser

1. Sign in with the Intuit account that owns your QBO company.
2. Select the company to connect.
3. Click **Connect**.

Intuit redirects you to the OAuth Playground. The URL bar will look like:

```
https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl?code=XAB11701234567890abcdef&realmId=9130350484847232&state=...
```

### Step 2c — Extract `code` and `realmId`

From the URL bar (or the Playground page's display):

- **Authorization code** → the `code` parameter. Example: `XAB11701234567890abcdef`
- **Realm ID** → the `realmId` parameter. Example: `9130350484847232`

### ⚠️ The three gotchas that will eat your afternoon

1. **The code starts with `X`. Do NOT strip it.** The `X` is part of the code.
   If you paste `AB11701234567890abcdef`, auth will fail with `invalid_grant`.
   Always `XAB11...`.

2. **The code expires in ~2 minutes.** Intuit's auth code window is tight. If
   you stop for lunch between copying the code and completing Step 2d, you'll
   get `invalid_grant`. Just redo Step 2a → 2b → 2c. It's fast the second
   time.

3. **Production vs Sandbox mismatch.** If your `.env` says `QBO_SANDBOX=false`
   but the Client ID/Secret are from the Sandbox tab of the Intuit app, every
   step "works" but you'll silently be authorizing against a Sandbox company
   that doesn't exist. Double-check that `QBO_SANDBOX=false` AND the keys came
   from the **Production** tab of the Intuit app's Keys & credentials page.

### Step 2d — Complete authentication

Paste both values back to Claude, e.g.:

> "Authorization code is `XAB11701234567890abcdef` and realm ID is `9130350484847232`"

Claude will call `qbo_authenticate` again with the code and realmId, exchange
them for tokens via Intuit's `/oauth2/v1/tokens/bearer` endpoint, and write
the result to `~/.quickbooks-mcp/credentials.json`.

### Step 2e — Verify

Ask Claude:

> "Get the company info from QuickBooks"

If it returns your company's name, address, fiscal year start, etc. — 🎉
you're done with the dance. The credentials file is populated and you can
close Claude Code.

Inspect the file to confirm:

```bash
cat ~/.quickbooks-mcp/credentials.json | jq 'keys'
# Expected:
# [
#   "access_token",
#   "client_id",
#   "client_secret",
#   "company_id",
#   "redirect_url",
#   "refresh_token"
# ]
```

---

## Step 3 — Bootstrap Secret Manager

Now push the credentials JSON you just produced into GCP Secret Manager so
the Cloud Run service can read it:

```bash
cd /path/to/qbo-mcp
export GCP_PROJECT=your-gcp-project-id
./deploy/bootstrap-secret.sh
```

This script:

1. Validates `~/.quickbooks-mcp/credentials.json` has all required keys via `jq`
2. Creates the secret `qbo-credentials` if it doesn't exist
   (replication: automatic; labels: `app=qbo-mcp`)
3. Adds a new secret version containing the JSON blob

Confirm it worked:

```bash
gcloud secrets versions access latest \
  --secret=qbo-credentials \
  --project=$GCP_PROJECT \
  | jq '{company_id, has_access_token: (.access_token | length > 0)}'
```

### Env var overrides

| Variable | Default |
|---|---|
| `GCP_PROJECT` | **required** |
| `SECRET_NAME` | `qbo-credentials` |
| `QBO_CREDENTIALS_FILE` | `~/.quickbooks-mcp/credentials.json` |

---

## Step 4 — Create the runtime service account

```bash
./deploy/setup-service-account.sh
```

This creates `qbo-mcp-runtime@$GCP_PROJECT.iam.gserviceaccount.com` and grants
it two roles **scoped to the one secret only** (not project-wide):

- `roles/secretmanager.secretAccessor` — read the latest version
- `roles/secretmanager.secretVersionAdder` — write new versions on rotation

The SA has **no other permissions** anywhere in the project. Compromise of the
SA gives an attacker access to the QBO tokens and nothing else.

---

## Step 5 — Deploy to Cloud Run

```bash
./deploy/deploy.sh
```

This:

1. Creates the Artifact Registry repo `qbo-mcp` in your region (if needed)
2. Builds the Docker image via Cloud Build (no local Docker required)
3. Pushes to `<region>-docker.pkg.dev/$GCP_PROJECT/qbo-mcp/qbo-mcp:<timestamp>`
4. Deploys to Cloud Run with:
   - `--no-allow-unauthenticated` (Google IAM is the gate)
   - `--service-account=qbo-mcp-runtime@...`
   - `--min-instances=0` (scale to zero when idle)
   - `--max-instances=3` (tune via env var if you expect higher concurrency)
   - `--cpu=1 --memory=512Mi`
   - `--timeout=60s` (Intuit API is rarely slow, 60s is plenty)
   - Env: `QBO_CREDENTIAL_MODE=gcp`, `GCP_PROJECT_ID=$GCP_PROJECT`,
     `MCP_AUTH_ENABLED=false`

At the end it prints the service URL, e.g.:

```
Deployed: https://qbo-mcp-ab12cd34-uc.a.run.app
```

### Smoke test with your own identity

```bash
TOKEN=$(gcloud auth print-identity-token)
curl -H "Authorization: Bearer $TOKEN" https://qbo-mcp-xxx.run.app/healthz
# {"status":"ok"}
```

If you get `401 Unauthorized`, your identity doesn't have `roles/run.invoker`
on the service yet. Grant yourself:

```bash
gcloud run services add-iam-policy-binding qbo-mcp \
  --project=$GCP_PROJECT --region=us-central1 \
  --member=user:$(gcloud config get-value account) \
  --role=roles/run.invoker
```

---

## Step 6 — Grant users access

```bash
gcloud run services add-iam-policy-binding qbo-mcp \
  --project=$GCP_PROJECT --region=us-central1 \
  --member=user:user@example.com \
  --role=roles/run.invoker
```

To list who currently has access:

```bash
gcloud run services get-iam-policy qbo-mcp \
  --project=$GCP_PROJECT --region=us-central1
```

To revoke:

```bash
gcloud run services remove-iam-policy-binding qbo-mcp \
  --project=$GCP_PROJECT --region=us-central1 \
  --member=user:former.user@example.com \
  --role=roles/run.invoker
```

---

## Step 7 — Connect from Claude

### Claude Desktop (Phase 2a)

Phase 2a uses Google IAM for access control. Claude Desktop talks to the Cloud
Run service via a small local bridge that signs each request with a Google ID
token.

Two options:

**Option 1 — `gcloud auth print-identity-token` pattern**

1. The user runs `gcloud auth login` on their machine once.
2. Point Claude Desktop at a local `mcp-remote` proxy configured to inject
   `Authorization: Bearer $(gcloud auth print-identity-token)` per request.

**Option 2 — Wait for Phase 2b** ([see below](#auth-modes--2a-now-vs-2b-future))

Phase 2b enables claude.ai's native OAuth DCR+PKCE flow. The user pastes
`https://qbo-mcp-xxx.run.app/mcp` into claude.ai's "Add custom connector",
signs in via the consent screen, and is connected. No terminal, no gcloud.

### claude.ai web

Not supported in Phase 2a — claude.ai custom connectors speak OAuth DCR+PKCE
and expect a public (unauthenticated at the network layer) MCP endpoint with
OAuth gating at the app layer. Phase 2b flips `MCP_AUTH_ENABLED=true` and
`--allow-unauthenticated` on the service.

---

## Updating

### Deploying new code

Just re-run:

```bash
./deploy/deploy.sh
```

Cloud Run does a zero-downtime rollout. The new revision gets 100% of traffic
once it passes its startup probe. Previous revision stays around so you can
rollback with:

```bash
gcloud run services update-traffic qbo-mcp --to-revisions=<prev>=100
```

### Rotating the Intuit Client Secret

Do this any time you think the client secret might be compromised, or on a
regular schedule (quarterly is sensible).

1. Go to [developer.intuit.com](https://developer.intuit.com) → your app →
   **Keys & credentials** → **Production** tab.
2. Click **Rotate client secret** (or similar). Copy the new secret.
3. Do the OAuth Playground dance again (Step 2) — you need new tokens because
   rotating the client secret invalidates the existing `access_token` and
   `refresh_token`.
4. Re-run `./deploy/bootstrap-secret.sh` to push the new credentials.
5. No redeploy needed — the running container will pick up the new secret
   version on its next read (cache is per-request).

### Rotating the qbo-credentials secret without re-OAuth

If you just want to forcibly add a new secret version (not typical, but
possible):

```bash
./deploy/bootstrap-secret.sh   # points at the same ~/.quickbooks-mcp/credentials.json
```

---

## Re-authenticating after 100 days

**Intuit's refresh token expires after 100 days of inactivity.** If the server
hasn't been used in 100+ days, the refresh flow will return `invalid_grant` on
the next request and nobody can talk to QBO until you re-auth.

Mitigations:

- **Active use prevents this.** Normal Claude usage refreshes the access token
  every ~1h, which rotates the refresh token too, which resets the 100-day
  clock.
- **If it does expire:** just redo Step 2 (OAuth Playground dance) and Step 3
  (bootstrap-secret.sh). Takes ~5 minutes.

To monitor for impending expiry, you could add a weekly Cloud Scheduler job
that hits `/mcp` with a cheap tool call. Not included in this repo.

---

## Troubleshooting

### `invalid_grant` when exchanging the auth code

- **Auth code expired** (>2 minutes old). Redo Step 2a → 2c with a fresh code.
- **The `X` prefix was stripped.** The code starts with `X` — it's part of the code.
- **Client ID/Secret mismatch.** Check your `.env` keys match the **Production**
  tab of the Intuit app, and `QBO_SANDBOX=false`.

### `redirect_uri is invalid`

The URL `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl` is not
registered in the Intuit app's **Keys & credentials → Redirect URIs**. Add it
exactly as shown and save.

### `401 Unauthorized` from Cloud Run

Your identity doesn't have `roles/run.invoker` on the service. See
[Step 6](#step-6--grant-users-access).

### `Secret qbo-credentials has no payload`

Secret exists but has no versions. Re-run `./deploy/bootstrap-secret.sh`.

### `SecretManagerServiceClient: PERMISSION_DENIED`

The runtime SA can't read the secret. Check:

```bash
gcloud secrets get-iam-policy qbo-credentials --project=$GCP_PROJECT
```

Should include `serviceAccount:qbo-mcp-runtime@...` with roles
`secretmanager.secretAccessor` AND `secretmanager.secretVersionAdder`. If not,
re-run `./deploy/setup-service-account.sh`.

### `GCP_PROJECT_ID env var is required when QBO_CREDENTIAL_MODE=gcp`

The Cloud Run deploy didn't set `GCP_PROJECT_ID`. Check the deploy.sh output
or:

```bash
gcloud run services describe qbo-mcp \
  --project=$GCP_PROJECT --region=us-central1 \
  --format="value(spec.template.spec.containers[0].env)"
```

Re-run `./deploy/deploy.sh` — the script sets this automatically.

### Request failed with `401` after the service ran for weeks

Access token refresh failed. Two likely causes:

1. **100-day refresh token expiry.** See
   [Re-authenticating](#re-authenticating-after-100-days).
2. **Client secret was rotated** at developer.intuit.com but `qbo-credentials`
   still has the old one. Re-do Step 2 with the new client secret, then Step
   3.

### Deploy script fails with `Build timeout`

Default Cloud Build timeout is 600s. Bump it in `deploy/deploy.sh`:

```bash
gcloud builds submit --timeout=1200s ...
```

### Deploy succeeds but health check fails

Check the Cloud Run logs:

```bash
gcloud run services logs read qbo-mcp \
  --project=$GCP_PROJECT --region=us-central1 --limit=50
```

Most common culprit: Secret Manager permissions not yet propagated. IAM can
take ~60s to propagate globally. Wait a minute, re-deploy.

### MCP tools return data but write operations silently do nothing

`QBO_INLINE_OUTPUT=true` should be set (it's the default in the Dockerfile).
Without it, the server writes output to `/tmp` files that Cloud Run's
ephemeral filesystem loses on cold start.

---

## Environment variables

See [`.env.example`](./.env.example) for a complete, annotated template.

### Required in production

| Variable | Purpose |
|---|---|
| `QBO_CREDENTIAL_MODE=gcp` | Selects the GCP Secret Manager provider |
| `GCP_PROJECT_ID` | Project hosting the secret |

### Optional (good defaults)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Cloud Run injects this automatically |
| `QBO_SECRET_NAME` | `qbo-credentials` | Secret Manager secret name |
| `QBO_INLINE_OUTPUT` | `true` | Return tool output inline (required for Cloud Run) |
| `QBO_SANDBOX` | `false` | Use Intuit Sandbox API endpoints |
| `MCP_RESOURCE_NAME` | `QuickBooks MCP Server` | Label in OAuth discovery metadata |

### Client credential override

By default `client_id` and `client_secret` are read from the Secret Manager
payload. Env vars override them — useful during a client-secret rotation:

| Variable |
|---|
| `QBO_CLIENT_ID` |
| `QBO_CLIENT_SECRET` |

### Phase 2b (OAuth AS proxy, not yet live)

| Variable | Purpose |
|---|---|
| `MCP_AUTH_ENABLED` | `true` to enable OAuth gate for claude.ai DCR |
| `MCP_AUTHORIZE_URL` | Upstream AS `/authorize` endpoint |
| `MCP_TOKEN_URL` | Upstream AS `/token` endpoint |
| `MCP_AUTH_ISSUER` | Expected `iss` claim in bearer tokens |
| `MCP_AUTH_AUDIENCE` | Expected `aud` claim |
| `MCP_AUTH_SCOPE` | Required scope |

---

## Auth modes — 2a (now) vs 2b (future)

### Phase 2a — Google IAM (current)

- Cloud Run: `--no-allow-unauthenticated`
- `MCP_AUTH_ENABLED=false`
- Access control: `roles/run.invoker` on specific Google identities
- Client: Claude Desktop with a local bridge that injects
  `gcloud auth print-identity-token`
- **Pro:** no OAuth AS to build. IAM policy is one command per user.
- **Con:** doesn't work with claude.ai web (can't inject Google ID tokens).

### Phase 2b — OAuth DCR+PKCE (target UX for end users)

- Cloud Run: `--allow-unauthenticated` (network-open)
- `MCP_AUTH_ENABLED=true`
- Endpoints exposed: `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `/authorize`, `/token`
- Upstream AS: Auth0, Keycloak, WorkOS, or your own OAuth server
- Access control: allowlist at the AS layer (usually via email domain or
  explicit user allow-list)
- Client: claude.ai "Add custom connector" with the URL — it does DCR, PKCE,
  and the consent screen automatically
- **Pro:** users just paste a URL, sign in, done. Works in claude.ai web.
- **Con:** one-time setup of the upstream AS to trust this resource.

The OAuth proxy machinery is already in [`src/cloud-run.ts`](./src/cloud-run.ts)
— gated on `MCP_AUTH_ENABLED`. Enabling 2b is: set env vars, flip the
allow-unauthenticated flag, done.

---

## Blast radius & recovery

### What the credentials grant

The `com.intuit.quickbooks.accounting` scope grants read + write access to:

**Read:** full P&L, balance sheet, GL, cash flow, trial balance, every
invoice, bill, expense, journal entry, deposit, transfer, customer list (with
emails + addresses + tax IDs), vendor list, bank balances, bank transaction
activity.

**Write:** create / edit / delete invoices, bills, expenses, sales receipts,
deposits, journal entries, vendor credits, customers, vendors.

### What the credentials *cannot* do

- ❌ Move actual money (no Payments scope — no credit card charges, no ACH)
- ❌ Access payroll (Intuit API doesn't expose it)
- ❌ Connect/modify bank feeds
- ❌ File taxes
- ❌ Log into QuickBooks Online UI as a user (tokens are API-only)

### Compromise scenarios

| Scenario | Impact | Recovery |
|---|---|---|
| Runtime SA key leaked | Secret reads (+ writes new versions) | Rotate SA, re-run setup-service-account.sh |
| Entire Secret Manager secret leaked | Full QBO access for life of tokens | Rotate Intuit client secret (instantly invalidates all tokens) |
| Intuit Client Secret leaked | New OAuth flows could be initiated | Rotate Intuit client secret + redo OAuth dance |
| Cloud Run service hijacked | Attacker has whatever the runtime SA has | Rollback revision; rotate SA; rotate client secret |

### Recovery playbook (hot path)

If you suspect compromise:

```bash
# 1. Kill outbound QBO access immediately.
#    At developer.intuit.com → your app → Keys & credentials → rotate secret.
#    This instantly invalidates every access_token and refresh_token.

# 2. Also revoke the app from the QBO side:
#    QBO → Apps → Connected apps → Disconnect "Claude MCP"

# 3. Check the QBO audit log for anything suspicious in the window:
#    QBO → Gear → Audit Log → filter by user + date

# 4. Re-do OAuth dance (Step 2) with the new client secret.
# 5. Re-run bootstrap-secret.sh to push new tokens.
# 6. If Cloud Run itself was compromised: redeploy from known-good commit.
./deploy/deploy.sh
```

---

## Development

### Local run (stdio mode, just like laf-rge upstream)

```bash
export QBO_CLIENT_ID=... QBO_CLIENT_SECRET=... QBO_CREDENTIAL_MODE=local
npm install
npm run build
npm start                          # dist/index.js, stdio
```

### Local run (cloud-run HTTP mode)

```bash
export QBO_CLIENT_ID=... QBO_CLIENT_SECRET=... QBO_CREDENTIAL_MODE=local
npm run build
PORT=8099 node dist/cloud-run.js
# in another shell:
curl http://localhost:8099/healthz
```

### Local run (cloud-run HTTP mode, reading from real Secret Manager)

```bash
gcloud auth application-default login
export QBO_CREDENTIAL_MODE=gcp
export GCP_PROJECT_ID=$GCP_PROJECT
npm run build
PORT=8099 node dist/cloud-run.js
```

### Cutting a new deploy

Any commit on `main` can be deployed via `./deploy/deploy.sh`. The image tag
includes a UTC timestamp so every deploy is a fresh revision.

---

## Repository layout

```
qbo-mcp/
├── README.md                       — this file
├── .env.example                    — annotated env var reference
├── Dockerfile                      — multi-stage Node 20-alpine
├── .dockerignore
├── .gitignore
├── package.json
├── tsconfig.json
├── LICENSE                         — MIT (inherited from laf-rge)
│
├── deploy/
│   ├── bootstrap-secret.sh         — seed Secret Manager from local creds.json
│   ├── setup-service-account.sh    — create qbo-mcp-runtime SA + scoped IAM
│   └── deploy.sh                   — Cloud Build + Cloud Run deploy
│
├── src/
│   ├── cloud-run.ts                — ⭐ HTTP entrypoint for Cloud Run (new)
│   ├── index.ts                    — stdio entrypoint (upstream, for local dev)
│   ├── lambda.ts                   — AWS Lambda entrypoint (upstream, unused)
│   ├── server.ts                   — shared MCP Server setup
│   │
│   ├── credentials/
│   │   ├── gcp-provider.ts         — ⭐ Secret Manager provider (new)
│   │   ├── aws-provider.ts         — upstream, unused
│   │   ├── local-provider.ts       — upstream, used for the OAuth dance
│   │   ├── oauth-client.ts         — intuit-oauth wrapper
│   │   ├── types.ts                — CredentialProvider interface (+gcp mode)
│   │   └── index.ts                — factory
│   │
│   ├── auth/
│   │   └── token-validator.ts      — JWT validation for Phase 2b
│   │
│   ├── client/                     — node-quickbooks wrapper with retry
│   ├── query/                      — generic QBO query layer
│   ├── reports/                    — report formatters
│   ├── tools/                      — MCP tool definitions + handlers
│   │   ├── definitions.ts
│   │   ├── handlers/               — one file per tool (authenticate, bill,
│   │   │                             company, expense, invoice, etc.)
│   │   └── index.ts
│   ├── types/                      — TS type declarations
│   └── utils/                      — output mode, money formatting, etc.
│
└── docs/
    └── USER-GUIDE.md               — user-facing capability reference
```

`⭐` = changes vs. upstream laf-rge. Everything else is unmodified.

---

## License

MIT. Inherits from [laf-rge/quickbooks-mcp](https://github.com/laf-rge/quickbooks-mcp).
