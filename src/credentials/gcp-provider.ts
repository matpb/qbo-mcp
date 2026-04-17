// GCP Secret Manager credential provider
//
// Stores QBO OAuth credentials (client_id, client_secret, access_token,
// refresh_token, company_id) as a JSON blob in a single Secret Manager secret.
// Every token refresh writes a new secret version. Old versions age out via
// Secret Manager lifecycle policy (configured at deploy time, not here).
//
// Env vars:
//   GCP_PROJECT_ID           — project hosting the secret (required)
//   QBO_SECRET_NAME          — secret name (default: "qbo-credentials")
//   GOOGLE_APPLICATION_CREDENTIALS — path to SA key JSON (not needed on Cloud Run)
//
// On Cloud Run the default service account credentials are used automatically.

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { CredentialProvider, QBCredentials } from "./types.js";

const PROJECT_ID = process.env.GCP_PROJECT_ID || "";
const SECRET_NAME = process.env.QBO_SECRET_NAME || "qbo-credentials";

/**
 * GCP-backed credential provider.
 * One secret holds the entire QBCredentials JSON. Each refresh adds a new version.
 */
export class GCPCredentialProvider implements CredentialProvider {
  private client: SecretManagerServiceClient;
  private cachedCredentials: QBCredentials | null = null;

  constructor() {
    if (!PROJECT_ID) {
      throw new Error(
        "GCP_PROJECT_ID env var is required when QBO_CREDENTIAL_MODE=gcp"
      );
    }
    this.client = new SecretManagerServiceClient();
  }

  private get secretPath(): string {
    return `projects/${PROJECT_ID}/secrets/${SECRET_NAME}`;
  }

  private get latestVersionPath(): string {
    return `${this.secretPath}/versions/latest`;
  }

  async getCredentials(): Promise<QBCredentials> {
    // Always refetch — we can't know from inside the container whether another
    // replica has rotated the token. Cache invalidates on saveCredentials.
    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }

    const [response] = await this.client.accessSecretVersion({
      name: this.latestVersionPath,
    });

    const payload = response.payload?.data?.toString();
    if (!payload) {
      throw new Error(
        `Secret ${SECRET_NAME} has no payload — run bootstrap-secret.sh`
      );
    }

    const stored = JSON.parse(payload) as QBCredentials;

    // Env vars can override client_id/secret (useful for rotation without
    // rewriting the secret); tokens always come from the secret.
    const credentials: QBCredentials = {
      client_id: process.env.QBO_CLIENT_ID || stored.client_id,
      client_secret: process.env.QBO_CLIENT_SECRET || stored.client_secret,
      redirect_url:
        stored.redirect_url ||
        "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl",
      access_token: stored.access_token,
      refresh_token: stored.refresh_token,
      company_id: stored.company_id,
    };

    this.cachedCredentials = credentials;
    return credentials;
  }

  async saveCredentials(credentials: QBCredentials): Promise<void> {
    // Add a new secret version with the updated token pair.
    await this.client.addSecretVersion({
      parent: this.secretPath,
      payload: {
        data: Buffer.from(JSON.stringify(credentials), "utf-8"),
      },
    });

    // Invalidate local cache so the next read sees the new version.
    this.cachedCredentials = null;
  }

  async getCompanyId(): Promise<string> {
    const credentials = await this.getCredentials();
    if (!credentials.company_id) {
      throw new Error(
        "Company ID not found in credentials — run bootstrap-secret.sh"
      );
    }
    return credentials.company_id;
  }

  async isConfigured(): Promise<boolean> {
    try {
      const credentials = await this.getCredentials();
      return !!(
        credentials.client_id &&
        credentials.client_secret &&
        credentials.access_token &&
        credentials.refresh_token &&
        credentials.company_id
      );
    } catch {
      return false;
    }
  }
}
