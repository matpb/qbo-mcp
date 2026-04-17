# Shared setup sourced by the other deploy/*.sh scripts.
# Keeps strict-mode flags, env-var validation, and common defaults in one place.

set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT env var is required (e.g. export GCP_PROJECT=your-project-id)}"

SECRET_NAME="${SECRET_NAME:-qbo-credentials}"
SA_NAME="${SA_NAME:-qbo-mcp-runtime}"
SA_EMAIL="${SA_EMAIL:-${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-qbo-mcp}"
REPO="${REPO:-qbo-mcp}"
