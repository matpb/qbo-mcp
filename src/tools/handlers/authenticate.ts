// Handler for qbo_authenticate tool — OAuth flow for local credential mode.
//
// Default flow is automatic: opens the user's browser, spins up a loopback
// listener, waits for Intuit to redirect back via the public bounce page at
// https://qbo-mcp.matpb.com/callback.html. If the caller can't run a browser
// (headless shell, remote tmux, etc.) they can pass { manual: true } to get
// the URL without opening a browser, and/or submit { authorization_code,
// realm_id } after capturing them from the bounce page URL bar.

import { isLocalMode, getCredentialMode } from "../../credentials/index.js";
import { LocalCredentialProvider } from "../../credentials/local-provider.js";
import {
  exchangeCodeForTokens,
  generateAuthorizationUrl,
  getManualOAuthInstructions,
} from "../../credentials/oauth-client.js";
import { beginLoopbackOAuth } from "../../credentials/loopback-oauth.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

interface AuthenticateArgs {
  authorization_code?: string;
  realm_id?: string;
  manual?: boolean;
}

export async function handleAuthenticate(args: AuthenticateArgs): Promise<ToolResult> {
  if (!isLocalMode()) {
    return {
      content: [{
        type: "text",
        text: `The qbo_authenticate tool only works in local credential mode.\n\n` +
          `Current mode: ${getCredentialMode()}\n\n` +
          `Set QBO_CREDENTIAL_MODE=local (or leave it unset — local is the default).`,
      }],
      isError: true,
    };
  }

  const localProvider = new LocalCredentialProvider();
  const clientCreds = await localProvider.getClientCredentials();

  if (!clientCreds) {
    return {
      content: [{
        type: "text",
        text: missingClientCredsMessage(),
      }],
      isError: true,
    };
  }

  const { clientId, clientSecret } = clientCreds;

  // Manual path: caller has code + realmId from the bounce page URL.
  if (args.authorization_code) {
    if (!args.realm_id) {
      return {
        content: [{
          type: "text",
          text: `Missing realm_id. When providing authorization_code, also pass the realm_id ` +
            `(the "realmId" query parameter from the callback URL).`,
        }],
        isError: true,
      };
    }
    try {
      const result = await exchangeCodeForTokens(
        clientId,
        clientSecret,
        args.authorization_code,
        args.realm_id
      );
      await localProvider.saveCredentials(result.credentials);
      return { content: [{ type: "text", text: successMessage(result.companyId) }] };
    } catch (error) {
      return { content: [{ type: "text", text: exchangeErrorMessage(error) }], isError: true };
    }
  }

  // Manual-URL-only path: return the URL but don't open a browser or listen.
  if (args.manual) {
    const authUrl = generateAuthorizationUrl(clientId, clientSecret);
    return { content: [{ type: "text", text: getManualOAuthInstructions(authUrl) }] };
  }

  // Default: automatic loopback flow.
  try {
    const { authUrl, result } = await beginLoopbackOAuth(clientId, clientSecret);
    const exchange = await result;
    await localProvider.saveCredentials(exchange.credentials);
    return {
      content: [{
        type: "text",
        text: `## Connected to QuickBooks\n\n` +
          `Company: **${exchange.companyId}**\n\n` +
          `Credentials saved. You can now use any QuickBooks tool.\n\n` +
          `(Authorization URL used: ${authUrl})`,
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: `## Automatic OAuth failed\n\n` +
          `\`\`\`\n${message}\n\`\`\`\n\n` +
          `Fall back by calling \`qbo_authenticate\` with \`{"manual": true}\` to get ` +
          `a plain URL, complete the flow in a browser, then call again with ` +
          `\`{"authorization_code": "...", "realm_id": "..."}\`.`,
      }],
      isError: true,
    };
  }
}

function missingClientCredsMessage(): string {
  return `## Missing Client Credentials\n\n` +
    `Provide your Intuit app's Client ID and Client Secret.\n\n` +
    `### From Claude Desktop (.mcpb install)\n\n` +
    `Open the QuickBooks extension settings and fill in Intuit Client ID and ` +
    `Intuit Client Secret, then restart the extension.\n\n` +
    `### From a manual install\n\n` +
    `Set environment variables:\n` +
    `\`\`\`\nQBO_CLIENT_ID=your_client_id\nQBO_CLIENT_SECRET=your_client_secret\n\`\`\`\n\n` +
    `Or create \`~/.quickbooks-mcp/credentials.json\`:\n` +
    `\`\`\`json\n{\n  "client_id": "your_client_id",\n  "client_secret": "your_client_secret"\n}\n\`\`\`\n\n` +
    `### Getting them\n\n` +
    `1. Go to https://developer.intuit.com/\n` +
    `2. Select your app → Keys & credentials\n` +
    `3. Copy Client ID and Client Secret\n` +
    `4. Under Redirect URIs, add: \`https://qbo-mcp.matpb.com/callback.html\``;
}

function successMessage(companyId: string): string {
  return `## Connected to QuickBooks\n\n` +
    `Company: **${companyId}**\n\n` +
    `Credentials saved. Try:\n` +
    `- \`get_company_info\` to verify the connection\n` +
    `- \`list_accounts\` to see your chart of accounts\n` +
    `- \`query\` for custom SQL-like queries`;
}

function exchangeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `## Authentication Failed\n\n` +
    `\`\`\`\n${message}\n\`\`\`\n\n` +
    `### Common causes\n` +
    `- Authorization code expired (valid for a few minutes)\n` +
    `- Wrong realm_id — verify it matches the company you authorized\n` +
    `- Code already used — each code works once\n\n` +
    `Run \`qbo_authenticate\` without arguments to start a fresh flow.`;
}
