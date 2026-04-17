#!/usr/bin/env bash
# One-time bootstrap: create the GCP Secret Manager secret for QBO OAuth
# credentials, seeded from a local credentials.json produced by laf-rge's
# stdio OAuth flow (qbo_authenticate).
#
# Usage:
#   export GCP_PROJECT=your-gcp-project-id
#   export QBO_CREDENTIALS_FILE=~/.quickbooks-mcp/credentials.json   # optional
#   ./deploy/bootstrap-secret.sh

source "$(dirname "$0")/common.sh"

CREDS_FILE="${QBO_CREDENTIALS_FILE:-$HOME/.quickbooks-mcp/credentials.json}"

if [[ ! -f "$CREDS_FILE" ]]; then
  echo "ERROR: credentials file not found at $CREDS_FILE" >&2
  echo "Run the laf-rge OAuth Playground flow first to produce this file." >&2
  echo "See README §'Step 2 — Do the QBO OAuth Playground dance'." >&2
  exit 1
fi

REQUIRED_KEYS=(client_id client_secret access_token refresh_token company_id)
for k in "${REQUIRED_KEYS[@]}"; do
  if ! jq -e ".$k" "$CREDS_FILE" >/dev/null 2>&1; then
    echo "ERROR: credentials file missing key: $k" >&2
    exit 1
  fi
done

echo "Project: $GCP_PROJECT"
echo "Secret:  $SECRET_NAME"
echo "Source:  $CREDS_FILE"
echo

if gcloud secrets describe "$SECRET_NAME" --project="$GCP_PROJECT" >/dev/null 2>&1; then
  echo "Secret $SECRET_NAME already exists — adding a new version."
else
  echo "Creating secret $SECRET_NAME..."
  gcloud secrets create "$SECRET_NAME" \
    --project="$GCP_PROJECT" \
    --replication-policy=automatic \
    --labels="app=qbo-mcp,managed-by=qbo-mcp-deploy"
fi

gcloud secrets versions add "$SECRET_NAME" \
  --project="$GCP_PROJECT" \
  --data-file="$CREDS_FILE"

echo
echo "Done. Verify with:"
echo "  gcloud secrets versions access latest --secret=$SECRET_NAME --project=$GCP_PROJECT | jq ."
