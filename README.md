# qbo-mcp

QuickBooks Online MCP server, deployed to Google Cloud Run in AES's
`arctic-eider-414` project. Forked from
[laf-rge/quickbooks-mcp](https://github.com/laf-rge/quickbooks-mcp) with:

- `src/credentials/gcp-provider.ts` — GCP Secret Manager token storage
  (token rotation writes a new secret version)
- `src/cloud-run.ts` — native Node HTTP entrypoint speaking MCP Streamable HTTP
  on `POST /mcp`, listening on `$PORT`
- `Dockerfile` — multi-stage Node 20-alpine build, non-root runtime
- `deploy/` — gcloud automation

The stdio entrypoint (`src/index.ts`), AWS Lambda entrypoint (`src/lambda.ts`),
and the rich tool suite (30+ tools across accounts, reports, invoices, bills,
expenses, journal entries, deposits, etc.) are unchanged from upstream.

## Architecture

```
claude.ai / Claude Desktop
        │
        ▼  HTTPS
┌───────────────────────────────────┐
│  Cloud Run service: qbo-mcp       │
│  - POST /mcp (Streamable HTTP)    │
│  - runtime SA: qbo-mcp-runtime    │
└──────────────┬────────────────────┘
               │ reads+writes secret
               ▼
     GCP Secret Manager
       qbo-credentials
       (client_id, client_secret,
        access_token, refresh_token,
        company_id)
               │
               │ OAuth 2.0 refresh
               ▼
          Intuit / QBO API
```

Every token refresh writes a new secret version; old versions age out via
lifecycle policy. The runtime service account has
`secretmanager.secretAccessor` and `secretmanager.secretVersionAdder` **only on
this one secret** (not project-wide).

## First-time deploy

Everything runs in `arctic-eider-414` (AES prod GCP project).

### 1. Bootstrap OAuth credentials into Secret Manager

First, get a working set of tokens via the stdio flow (one time, anywhere):

```bash
cd ~/Documents/quickbooks-mcp
# ... register Intuit app, set .env, ask Claude "authenticate with QuickBooks" ...
# this writes ~/.quickbooks-mcp/credentials.json
```

Then push that JSON into Secret Manager:

```bash
cd ~/Documents/qbo-mcp
export GCP_PROJECT=arctic-eider-414
./deploy/bootstrap-secret.sh
```

### 2. Create the runtime service account

```bash
./deploy/setup-service-account.sh
```

### 3. Build + deploy

```bash
./deploy/deploy.sh
```

The service deploys as `qbo-mcp` in `us-central1` with
`--no-allow-unauthenticated`. No one can hit it without an IAM grant.

### 4. Grant users

```bash
gcloud run services add-iam-policy-binding qbo-mcp \
  --project=arctic-eider-414 --region=us-central1 \
  --member=user:joel@arcticeider.com --role=roles/run.invoker
```

## Updating

Subsequent deploys: just `./deploy/deploy.sh`.

## Env vars

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port (Cloud Run sets this) | `8080` |
| `QBO_CREDENTIAL_MODE` | `gcp`, `aws`, or `local` | `local` |
| `GCP_PROJECT_ID` | Project holding the secret | — |
| `QBO_SECRET_NAME` | Secret name | `qbo-credentials` |
| `QBO_CLIENT_ID` | Overrides client_id in the secret | — |
| `QBO_CLIENT_SECRET` | Overrides client_secret in the secret | — |
| `QBO_INLINE_OUTPUT` | Return data inline rather than tmp files | `true` |
| `MCP_AUTH_ENABLED` | Enable OAuth gate for claude.ai DCR flow | `false` |
| `MCP_AUTHORIZE_URL` | Upstream AS authorize endpoint | — |
| `MCP_TOKEN_URL` | Upstream AS token endpoint | — |
| `MCP_AUTH_ISSUER` | Expected token issuer claim | — |
| `MCP_AUTH_AUDIENCE` | Expected token audience claim | — |
| `MCP_AUTH_SCOPE` | Required scope | — |

## Auth modes

**Phase 2a (current):** `MCP_AUTH_ENABLED=false` + Cloud Run
`--no-allow-unauthenticated`. Gate is **Google IAM** — invokers must present a
Google identity token (either via `gcloud auth print-identity-token` or in
Claude Desktop, the ID token from a service account key). Works for the Claude
Desktop + local MCP wrapper path.

**Phase 2b (future):** `MCP_AUTH_ENABLED=true` + Cloud Run
`--allow-unauthenticated` + upstream OAuth AS pointing at HiveMind's AS (or
Auth0). This is what claude.ai's custom-connector DCR+PKCE flow requires.

## Blast radius

If the Cloud Run service or the runtime SA is compromised, the attacker can:

- Read + write AES's QuickBooks data (accounting scope, no Payments scope —
  cannot move actual money)
- Rotate the QBO refresh token (writes a new secret version, but attacker
  needs the client secret which lives in the same secret so this is moot)

Recovery: rotate the Intuit app client secret at developer.intuit.com, re-run
bootstrap-secret.sh. This invalidates every existing QBO token instantly.
