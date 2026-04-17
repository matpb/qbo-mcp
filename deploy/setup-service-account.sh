#!/usr/bin/env bash
# One-time: create the Cloud Run runtime service account and grant it access
# to the qbo-credentials secret.
#
# Usage:
#   export GCP_PROJECT=your-gcp-project-id
#   ./deploy/setup-service-account.sh

source "$(dirname "$0")/common.sh"

echo "Project: $GCP_PROJECT"
echo "SA:      $SA_EMAIL"
echo

if ! gcloud iam service-accounts describe "$SA_EMAIL" \
  --project="$GCP_PROJECT" >/dev/null 2>&1; then
  echo "Creating service account..."
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$GCP_PROJECT" \
    --display-name="qbo-mcp Cloud Run runtime" \
    --description="Runtime identity for the qbo-mcp Cloud Run service. Reads/writes the qbo-credentials secret; no other permissions."
else
  echo "Service account already exists."
fi

# Two sequential bindings — IAM policies have etags so parallel writes race.
# Deploy scripts run rarely enough that ~2s sequentially is fine.
echo "Granting secretAccessor + secretVersionAdder on $SECRET_NAME..."
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --project="$GCP_PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --project="$GCP_PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretVersionAdder"

echo
echo "Service account ready: $SA_EMAIL"
