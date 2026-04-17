#!/usr/bin/env bash
# One-time: create the Cloud Run runtime service account and grant it access
# to the qbo-credentials secret.

set -euo pipefail

PROJECT="${GCP_PROJECT:-arctic-eider-414}"
SA_NAME="${SA_NAME:-qbo-mcp-runtime}"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRET_NAME="${SECRET_NAME:-qbo-credentials}"

echo "Project: $PROJECT"
echo "SA:      $SA_EMAIL"
echo

# Create SA if needed
if ! gcloud iam service-accounts describe "$SA_EMAIL" \
  --project="$PROJECT" >/dev/null 2>&1; then
  echo "Creating service account..."
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" \
    --display-name="qbo-mcp Cloud Run runtime" \
    --description="Runtime identity for the qbo-mcp Cloud Run service. Reads/writes the qbo-credentials secret; no other permissions."
else
  echo "Service account already exists."
fi

# Grant access to the specific secret (least privilege — not project-wide)
echo "Granting secretAccessor + secretVersionAdder on $SECRET_NAME..."
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --project="$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"

# The runtime also needs to add new versions when tokens rotate
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --project="$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretVersionAdder"

echo
echo "Service account ready: $SA_EMAIL"
