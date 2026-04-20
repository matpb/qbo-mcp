// OAuth client wrapper for QuickBooks authentication

import OAuthClient from "intuit-oauth";
import type { QBCredentials } from "./types.js";
import { DEFAULT_REDIRECT_URL } from "./types.js";

const REQUIRED_SCOPES = [OAuthClient.scopes.Accounting];

function getEnvironment(): "sandbox" | "production" {
  return process.env.QBO_SANDBOX === "true" ? "sandbox" : "production";
}

export function getRedirectUrl(): string {
  return process.env.QBO_REDIRECT_URL || DEFAULT_REDIRECT_URL;
}

export function createOAuthClient(clientId: string, clientSecret: string): OAuthClient {
  return new OAuthClient({
    clientId,
    clientSecret,
    environment: getEnvironment(),
    redirectUri: getRedirectUrl(),
  });
}

export function generateAuthorizationUrl(
  clientId: string,
  clientSecret: string,
  state?: string
): string {
  const oauthClient = createOAuthClient(clientId, clientSecret);
  return oauthClient.authorizeUri({
    scope: REQUIRED_SCOPES,
    ...(state ? { state } : {}),
  });
}

export interface TokenExchangeResult {
  credentials: QBCredentials;
  companyId: string;
}

export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  authorizationCode: string,
  realmId: string
): Promise<TokenExchangeResult> {
  const oauthClient = createOAuthClient(clientId, clientSecret);
  const redirectUri = getRedirectUrl();

  const callbackUrl = `${redirectUri}?code=${encodeURIComponent(authorizationCode)}&realmId=${encodeURIComponent(realmId)}`;

  const authResponse = await oauthClient.createToken(callbackUrl);
  const token = authResponse.getToken();

  const credentials: QBCredentials = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_url: redirectUri,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    company_id: realmId,
  };

  return {
    credentials,
    companyId: realmId,
  };
}

export async function refreshAccessToken(credentials: QBCredentials): Promise<QBCredentials> {
  const oauthClient = createOAuthClient(credentials.client_id, credentials.client_secret);

  oauthClient.setToken({
    refresh_token: credentials.refresh_token,
    access_token: credentials.access_token,
  });

  const authResponse = await oauthClient.refresh();
  const token = authResponse.getToken();

  return {
    ...credentials,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  };
}

export function getManualOAuthInstructions(authUrl: string): string {
  const environment = getEnvironment();
  return `
## Manual QuickBooks OAuth Setup

**Environment:** ${environment}

Use this flow only if the automatic browser flow is unavailable (e.g. headless shell).

### Step 1: Authorize

Open this URL in your browser:

${authUrl}

Sign in, pick the company, and click Connect.

### Step 2: Capture code + realmId

After authorizing, Intuit redirects to the bounce page, which will try to
redirect to your local machine. If the local listener isn't running, stop
at the bounce page and copy the ?code=… and ?realmId=… values from the
URL bar.

### Step 3: Submit

Call \`qbo_authenticate\` again with:

\`\`\`json
{
  "authorization_code": "<code>",
  "realm_id": "<realmId>"
}
\`\`\`
`.trim();
}
