// Credential provider types for QuickBooks OAuth management

/**
 * QuickBooks OAuth credentials structure
 */
export interface QBCredentials {
  client_id: string;
  client_secret: string;
  redirect_url: string;
  access_token: string;
  refresh_token: string;
  company_id?: string; // Stored in credentials for local mode
}

/**
 * Abstract credential provider interface
 * Implemented by AWS and Local providers
 */
export interface CredentialProvider {
  /**
   * Get current OAuth credentials
   */
  getCredentials(): Promise<QBCredentials>;

  /**
   * Save updated credentials (e.g., after token refresh)
   */
  saveCredentials(credentials: QBCredentials): Promise<void>;

  /**
   * Get the QuickBooks company/realm ID
   */
  getCompanyId(): Promise<string>;

  /**
   * Check if credentials are configured and available
   */
  isConfigured(): Promise<boolean>;
}

/**
 * Credential mode - determines which provider to use
 */
export type CredentialMode = "local" | "aws";

/**
 * Get credential mode from environment
 * Defaults to "local" if not specified
 */
export function getCredentialMode(): CredentialMode {
  const mode = process.env.QBO_CREDENTIAL_MODE?.toLowerCase();
  if (mode === "aws") return "aws";
  return "local";
}

export const DEFAULT_REDIRECT_URL =
  "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";

/**
 * Merge stored credentials with env-var overrides. QBO_CLIENT_ID and
 * QBO_CLIENT_SECRET take precedence over stored values — useful during an
 * Intuit client-secret rotation when the new secret hasn't been pushed to
 * storage yet. Tokens always come from storage.
 */
export function mergeEnvOverrides(stored: Partial<QBCredentials>): QBCredentials {
  return {
    client_id: process.env.QBO_CLIENT_ID || stored.client_id || "",
    client_secret: process.env.QBO_CLIENT_SECRET || stored.client_secret || "",
    redirect_url: stored.redirect_url || DEFAULT_REDIRECT_URL,
    access_token: stored.access_token || "",
    refresh_token: stored.refresh_token || "",
    company_id: stored.company_id,
  };
}
