// Credential provider factory and exports

export type { QBCredentials, CredentialProvider, CredentialMode } from "./types.js";
export { getCredentialMode } from "./types.js";
export { AWSCredentialProvider } from "./aws-provider.js";
export { LocalCredentialProvider } from "./local-provider.js";
export { GCPCredentialProvider } from "./gcp-provider.js";

import { getCredentialMode } from "./types.js";
import type { CredentialProvider } from "./types.js";
import { AWSCredentialProvider } from "./aws-provider.js";
import { LocalCredentialProvider } from "./local-provider.js";
import { GCPCredentialProvider } from "./gcp-provider.js";

// Singleton provider instance
let providerInstance: CredentialProvider | null = null;

/**
 * Get the credential provider based on QBO_CREDENTIAL_MODE environment variable
 * - "gcp":   GCP Secret Manager (Cloud Run deploys)
 * - "aws":   AWS Secrets Manager + SSM (Lambda deploys)
 * - "local" (default): ~/.quickbooks-mcp/credentials.json
 */
export function getCredentialProvider(): CredentialProvider {
  if (!providerInstance) {
    const mode = getCredentialMode();
    if (mode === "aws") {
      providerInstance = new AWSCredentialProvider();
    } else if (mode === "gcp") {
      providerInstance = new GCPCredentialProvider();
    } else {
      providerInstance = new LocalCredentialProvider();
    }
  }
  return providerInstance;
}

/**
 * Clear the cached provider instance (for testing or credential mode changes)
 */
export function clearProviderCache(): void {
  providerInstance = null;
}

export function isLocalMode(): boolean {
  return getCredentialMode() === "local";
}

export function isAWSMode(): boolean {
  return getCredentialMode() === "aws";
}

export function isGCPMode(): boolean {
  return getCredentialMode() === "gcp";
}
