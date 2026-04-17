// GCP Secret Manager credential provider
//
// Stores QBO OAuth credentials as a JSON blob in a single Secret Manager
// secret. Every token refresh writes a new secret version. Old versions age
// out via lifecycle policy (configured at deploy time, not here).
//
// Env vars:
//   GCP_PROJECT_ID           — project hosting the secret (required)
//   QBO_SECRET_NAME          — secret name (default: "qbo-credentials")
//   GOOGLE_APPLICATION_CREDENTIALS — path to SA key JSON (not needed on Cloud Run)

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { CredentialProvider, QBCredentials } from "./types.js";
import { mergeEnvOverrides } from "./types.js";

const PROJECT_ID = process.env.GCP_PROJECT_ID || "";
const SECRET_NAME = process.env.QBO_SECRET_NAME || "qbo-credentials";

export class GCPCredentialProvider implements CredentialProvider {
  private client: SecretManagerServiceClient;
  // Process-local cache. A peer replica's rotation is picked up when this
  // container's tokens 401 and the caller re-runs getCredentials; there is no
  // cross-replica invalidation by design.
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

    const credentials = mergeEnvOverrides(JSON.parse(payload));
    this.cachedCredentials = credentials;
    return credentials;
  }

  async saveCredentials(credentials: QBCredentials): Promise<void> {
    await this.client.addSecretVersion({
      parent: this.secretPath,
      payload: {
        data: Buffer.from(JSON.stringify(credentials), "utf-8"),
      },
    });
    // We just wrote this payload — this replica's cache is authoritative until
    // we ourselves rotate again.
    this.cachedCredentials = credentials;
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
      const c = await this.getCredentials();
      return !!(c.client_id && c.client_secret && c.access_token && c.refresh_token && c.company_id);
    } catch {
      return false;
    }
  }
}
