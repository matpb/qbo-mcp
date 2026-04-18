// Credential provider factory and exports

export type { QBCredentials, CredentialProvider, CredentialMode } from "./types.js";
export { getCredentialMode, mergeEnvOverrides, DEFAULT_REDIRECT_URL } from "./types.js";
export { AWSCredentialProvider } from "./aws-provider.js";
export { LocalCredentialProvider } from "./local-provider.js";

import { getCredentialMode } from "./types.js";
import type { CredentialProvider } from "./types.js";
import { AWSCredentialProvider } from "./aws-provider.js";
import { LocalCredentialProvider } from "./local-provider.js";

// Singleton provider instance
let providerInstance: CredentialProvider | null = null;

/**
 * Get the credential provider based on QBO_CREDENTIAL_MODE environment variable
 * - "aws":   AWS Secrets Manager + SSM (for Lambda deploys — upstream-only)
 * - "local" (default): JSON file at $QBO_CREDENTIAL_FILE or
 *                      ~/.quickbooks-mcp/credentials.json. For Docker,
 *                      mount a host volume and point the env var at it.
 */
export function getCredentialProvider(): CredentialProvider {
  if (!providerInstance) {
    const mode = getCredentialMode();
    if (mode === "aws") {
      providerInstance = new AWSCredentialProvider();
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
