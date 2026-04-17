#!/usr/bin/env bash
# Build and deploy qbo-mcp to Cloud Run.
#
# Prereqs (one-time):
#   1. Run ./deploy/bootstrap-secret.sh to create the qbo-credentials secret
#   2. Run ./deploy/setup-service-account.sh to create the runtime SA
#
# Usage:
#   export GCP_PROJECT=your-gcp-project-id
#   ./deploy/deploy.sh

source "$(dirname "$0")/common.sh"

IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT}/${REPO}/${SERVICE}:$(date -u +%Y%m%d-%H%M%S)"

echo "Project:    $GCP_PROJECT"
echo "Region:     $REGION"
echo "Service:    $SERVICE"
echo "Image:      $IMAGE"
echo "SA:         $SA_EMAIL"
echo

# 1. Ensure Artifact Registry repo exists
if ! gcloud artifacts repositories describe "$REPO" \
  --project="$GCP_PROJECT" --location="$REGION" >/dev/null 2>&1; then
  echo "Creating Artifact Registry repo $REPO..."
  gcloud artifacts repositories create "$REPO" \
    --project="$GCP_PROJECT" \
    --repository-format=docker \
    --location="$REGION" \
    --description="qbo-mcp container images"
fi

# 2. Build with Cloud Build (faster + no local Docker required)
echo "Building image via Cloud Build..."
gcloud builds submit \
  --project="$GCP_PROJECT" \
  --tag="$IMAGE" \
  --timeout=600s \
  .

# 3. Deploy to Cloud Run.
#
#    --no-allow-unauthenticated: only callers with roles/run.invoker can hit it.
#    Secret Manager reads happen via the runtime SA using the Secret Manager
#    client library — no env-var injection, so rotation doesn't need a redeploy.
#
#    --update-env-vars (not --set-env-vars): only modifies the listed keys.
#    That way manually-set values (e.g. MCP_AUTH_ENABLED=true flipped via
#    `gcloud run services update` when enabling Phase 2b) survive redeploys.
#
#    Sizing rationale: single-user tool → --max-instances=3 is enough
#    headroom for bursts; 512Mi holds node + SDKs + transient MCP objects;
#    60s timeout is way more than any QBO API call needs.
echo "Deploying to Cloud Run..."
gcloud run deploy "$SERVICE" \
  --project="$GCP_PROJECT" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$SA_EMAIL" \
  --no-allow-unauthenticated \
  --ingress=all \
  --min-instances=0 \
  --max-instances=3 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=60s \
  --update-env-vars="QBO_CREDENTIAL_MODE=gcp,GCP_PROJECT_ID=${GCP_PROJECT},QBO_SECRET_NAME=${SECRET_NAME},QBO_INLINE_OUTPUT=true"

URL=$(gcloud run services describe "$SERVICE" \
  --project="$GCP_PROJECT" --region="$REGION" --format="value(status.url)")

echo
echo "Deployed: $URL"
echo
echo "Grant a user access:"
echo "  gcloud run services add-iam-policy-binding $SERVICE \\"
echo "    --project=$GCP_PROJECT --region=$REGION \\"
echo "    --member=user:USER@example.com --role=roles/run.invoker"
echo
echo "Smoke-test (using your own identity):"
echo "  TOKEN=\$(gcloud auth print-identity-token)"
echo "  curl -H \"Authorization: Bearer \$TOKEN\" $URL/healthz"
