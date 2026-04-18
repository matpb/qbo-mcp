// HTTP entrypoint — designed to run as a Docker container behind a TLS
// reverse proxy (APISIX / nginx / Caddy). Listens on $PORT.
//
// Routes:
//   GET  /healthz                             liveness probe
//   POST /mcp                                 Streamable HTTP MCP transport
//   GET  /qbo/connect?token=$QBO_SETUP_TOKEN  begin Intuit OAuth (admin bootstrap)
//   GET  /qbo/callback?code=&realmId=&state=  Intuit redirect target — exchanges code
//   GET  /qbo/status                          is the server bound to a company?
//
// Phase 2b endpoints (gated on MCP_AUTH_ENABLED) — claude.ai custom-connector
// OAuth AS proxy. Off by default. See README.
//
// See README "Environment variables" for the full env-var reference.

import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import OAuthClient from "intuit-oauth";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { setOutputMode } from "./utils/output.js";
import { toolDefinitions, executeTool } from "./tools/index.js";
import { getAuthConfig, validateToken } from "./auth/token-validator.js";
import { getCredentialProvider } from "./credentials/index.js";
import type { QBCredentials } from "./credentials/index.js";

// Keep in sync with package.json. ESM + NodeNext JSON imports are fiddly —
// a two-line manual bump is cheaper than the build-config churn.
const SERVER_VERSION = "0.1.0";

setOutputMode("http");

const PORT = parseInt(process.env.PORT || "8080", 10);
const SETUP_TOKEN = process.env.QBO_SETUP_TOKEN || "";
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || "";
const QBO_SANDBOX = process.env.QBO_SANDBOX === "true";

const STDIO_ONLY_TOOLS = new Set(["qbo_authenticate"]);

type AuthConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  issuer: string;
  scope: string;
  tokenValidator: ReturnType<typeof getAuthConfig>;
};

function loadAuth(): AuthConfig | null {
  if (process.env.MCP_AUTH_ENABLED !== "true") return null;
  const scope =
    process.env.MCP_AUTH_AUDIENCE && process.env.MCP_AUTH_SCOPE
      ? `${process.env.MCP_AUTH_AUDIENCE}/${process.env.MCP_AUTH_SCOPE}`
      : "";
  return {
    authorizeUrl: process.env.MCP_AUTHORIZE_URL || "",
    tokenUrl: process.env.MCP_TOKEN_URL || "",
    issuer: process.env.MCP_AUTH_ISSUER || "",
    scope,
    tokenValidator: getAuthConfig(),
  };
}

const AUTH = loadAuth();

const remoteToolDefinitions = toolDefinitions.filter(
  (t) => !STDIO_ONLY_TOOLS.has(t.name)
);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function applyCors(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "quickbooks-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: remoteToolDefinitions,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return executeTool(name, args as Record<string, unknown>);
  });
  return server;
}

// --------------------------------------------------------------------------
// Request/response plumbing
// --------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function publicBase(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function publicUrl(req: IncomingMessage, overridePath?: string): string {
  return `${publicBase(req)}${overridePath ?? req.url ?? "/"}`;
}

function toWebRequest(req: IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return new Request(publicUrl(req), {
    method: req.method,
    headers,
    body: req.method && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
  });
}

async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  applyCors(res);
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.statusCode = webRes.status;
  res.end(await webRes.text());
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  applyCors(res);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  applyCors(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.statusCode = status;
  res.end(html);
}

// --------------------------------------------------------------------------
// /qbo/connect + /qbo/callback — user-initiated OAuth with Intuit
// --------------------------------------------------------------------------

// CSRF state store — maps random state tokens to a creation timestamp.
// In-memory only: single container deploy, and stale entries auto-prune.
const STATE_TTL_MS = 5 * 60 * 1000;
const pendingStates = new Map<string, number>();

function issueState(): string {
  pruneStates();
  const state = randomBytes(24).toString("hex");
  pendingStates.set(state, Date.now());
  return state;
}

function consumeState(state: string): boolean {
  pruneStates();
  const ts = pendingStates.get(state);
  if (!ts) return false;
  pendingStates.delete(state);
  return Date.now() - ts <= STATE_TTL_MS;
}

function pruneStates(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, ts] of pendingStates.entries()) {
    if (ts < cutoff) pendingStates.delete(state);
  }
}

function buildIntuitOAuthClient(): OAuthClient {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QBO_CLIENT_ID and QBO_CLIENT_SECRET env vars are required");
  }
  if (!QBO_REDIRECT_URI) {
    throw new Error("QBO_REDIRECT_URI env var is required (e.g. https://qbo.example.com/qbo/callback)");
  }
  return new OAuthClient({
    clientId,
    clientSecret,
    environment: QBO_SANDBOX ? "sandbox" : "production",
    redirectUri: QBO_REDIRECT_URI,
  });
}

function handleQboConnect(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", publicBase(req));
  const providedToken = url.searchParams.get("token") || "";

  // Gate: if QBO_SETUP_TOKEN is set, require a matching ?token=. If unset, the
  // route is open (useful for local dev; not recommended in production).
  if (SETUP_TOKEN && providedToken !== SETUP_TOKEN) {
    return sendJson(res, 403, {
      error: "forbidden",
      error_description: "Invalid or missing setup token",
    });
  }

  let authUri: string;
  try {
    const client = buildIntuitOAuthClient();
    authUri = client.authorizeUri({
      scope: [OAuthClient.scopes.Accounting],
      state: issueState(),
    });
  } catch (err) {
    return sendJson(res, 500, {
      error: "misconfigured",
      error_description: err instanceof Error ? err.message : String(err),
    });
  }

  res.statusCode = 302;
  res.setHeader("Location", authUri);
  res.end();
}

async function handleQboCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", publicBase(req));
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return sendHtml(
      res,
      400,
      renderErrorPage(
        "Intuit returned an error",
        `${error} — ${url.searchParams.get("error_description") || "(no description)"}`
      )
    );
  }
  if (!code || !realmId || !state) {
    return sendHtml(res, 400, renderErrorPage("Missing parameters", "code, realmId, and state are all required"));
  }
  if (!consumeState(state)) {
    return sendHtml(res, 400, renderErrorPage("Invalid state", "Your OAuth session expired or state was forged. Restart at /qbo/connect."));
  }

  try {
    const client = buildIntuitOAuthClient();
    const authResponse = await client.createToken(req.url!);
    const token = authResponse.getToken();

    const credentials: QBCredentials = {
      client_id: process.env.QBO_CLIENT_ID!,
      client_secret: process.env.QBO_CLIENT_SECRET!,
      redirect_url: QBO_REDIRECT_URI,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      company_id: realmId,
    };

    await getCredentialProvider().saveCredentials(credentials);

    sendHtml(
      res,
      200,
      renderSuccessPage(realmId, QBO_SANDBOX ? "sandbox" : "production")
    );
  } catch (err) {
    sendHtml(
      res,
      500,
      renderErrorPage(
        "Token exchange failed",
        err instanceof Error ? err.message : String(err)
      )
    );
  }
}

async function handleQboStatus(res: ServerResponse): Promise<void> {
  try {
    const configured = await getCredentialProvider().isConfigured();
    const companyId = configured ? await getCredentialProvider().getCompanyId() : null;
    sendJson(res, 200, {
      configured,
      company_id: companyId,
      environment: QBO_SANDBOX ? "sandbox" : "production",
    });
  } catch (err) {
    sendJson(res, 200, {
      configured: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function renderSuccessPage(realmId: string, env: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>QuickBooks connected</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:0 1rem;color:#222}
  .ok{color:#1b7f3a}.mono{font-family:ui-monospace,Menlo,monospace;background:#f4f4f4;padding:2px 6px;border-radius:3px}
  h1{margin-bottom:.2rem}
</style></head><body>
<h1 class="ok">✓ QuickBooks connected</h1>
<p>Tokens have been saved. This server can now talk to QuickBooks on behalf of the company below.</p>
<ul>
  <li>Company (realm) ID: <span class="mono">${escapeHtml(realmId)}</span></li>
  <li>Environment: <span class="mono">${escapeHtml(env)}</span></li>
</ul>
<p>You can close this tab. Point your MCP client at <span class="mono">/mcp</span> on this host to start using the tools.</p>
</body></html>`;
}

function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>QBO connect failed</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:0 1rem;color:#222}
  .err{color:#b00020}.mono{font-family:ui-monospace,Menlo,monospace;background:#f4f4f4;padding:2px 6px;border-radius:3px}
  pre{background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto}
</style></head><body>
<h1 class="err">✗ ${escapeHtml(title)}</h1>
<pre>${escapeHtml(detail)}</pre>
<p>Restart the flow at <span class="mono">/qbo/connect</span>.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

// --------------------------------------------------------------------------
// Phase 2b OAuth AS proxy (for claude.ai DCR+PKCE connectors — off by default)
// --------------------------------------------------------------------------

function handleAuthServerMetadata(req: IncomingMessage, res: ServerResponse, auth: AuthConfig): void {
  const base = publicBase(req);
  sendJson(res, 200, {
    issuer: auth.issuer || base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: auth.scope ? [auth.scope, "offline_access"] : [],
  });
}

function handleResourceMetadata(req: IncomingMessage, res: ServerResponse, auth: AuthConfig): void {
  sendJson(res, 200, {
    resource: publicUrl(req),
    authorization_servers: [publicBase(req)],
    scopes_supported: auth.scope ? [auth.scope, "offline_access"] : [],
    bearer_methods_supported: ["header"],
    resource_name: process.env.MCP_RESOURCE_NAME || "QuickBooks MCP Server",
  });
}

function handleAuthorize(req: IncomingMessage, res: ServerResponse, auth: AuthConfig): void {
  if (!auth.authorizeUrl) {
    return sendJson(res, 500, { error: "authorize_not_configured" });
  }
  const url = new URL(req.url ?? "/", publicBase(req));
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "scope") {
      const hasOffline = value.split(" ").includes("offline_access");
      params.set("scope", auth.scope
        ? hasOffline ? `${auth.scope} offline_access` : auth.scope
        : value);
    } else if (key === "prompt" && value === "consent") {
      params.set("prompt", "select_account");
    } else {
      params.set(key, value);
    }
  }
  if (!params.has("scope") && auth.scope) {
    params.set("scope", `${auth.scope} offline_access`);
  }
  applyCors(res);
  res.statusCode = 302;
  res.setHeader("Location", `${auth.authorizeUrl}?${params.toString()}`);
  res.end();
}

async function handleTokenProxy(
  res: ServerResponse,
  body: string,
  auth: AuthConfig
): Promise<void> {
  if (!auth.tokenUrl) {
    return sendJson(res, 500, { error: "token_not_configured" });
  }
  const params = new URLSearchParams(body);
  if (auth.scope) {
    const hasOffline = (params.get("scope") || "").split(" ").includes("offline_access");
    params.set("scope", hasOffline ? `${auth.scope} offline_access` : auth.scope);
  }
  const upstream = await fetch(auth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  applyCors(res);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  res.statusCode = upstream.status;
  res.end(await upstream.text());
}

function unauthorized(req: IncomingMessage, res: ServerResponse, description: string): void {
  const resourceUrl = publicUrl(req);
  sendJson(
    res,
    401,
    { error: "unauthorized", error_description: description, resource_metadata: resourceUrl },
    { "WWW-Authenticate": `Bearer resource_metadata="${resourceUrl}"` }
  );
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const value = Array.isArray(auth) ? auth[0] : auth;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// --------------------------------------------------------------------------
// MCP tool endpoint
// --------------------------------------------------------------------------

async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (AUTH && AUTH.tokenValidator) {
    const token = extractBearerToken(req);
    if (!token) return unauthorized(req, res, "Bearer token required");
    const result = await validateToken(token, AUTH.tokenValidator);
    if (!result.valid) return unauthorized(req, res, result.error);
  }

  const body = await readBody(req);
  const mcpServer = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);
  try {
    const webResponse = await transport.handleRequest(toWebRequest(req, body));
    await sendWebResponse(res, webResponse);
  } finally {
    await transport.close();
    await mcpServer.close();
  }
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method || "GET";
  const urlPath = (req.url || "/").split("?")[0];

  if (method === "OPTIONS") {
    applyCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === "GET" && urlPath === "/healthz") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (method === "GET" && urlPath === "/qbo/connect") {
    return handleQboConnect(req, res);
  }
  if (method === "GET" && urlPath === "/qbo/callback") {
    return handleQboCallback(req, res);
  }
  if (method === "GET" && urlPath === "/qbo/status") {
    return handleQboStatus(res);
  }

  if (AUTH) {
    if (method === "GET" && urlPath === "/.well-known/oauth-authorization-server") {
      return handleAuthServerMetadata(req, res, AUTH);
    }
    if (method === "GET" && urlPath === "/.well-known/oauth-protected-resource") {
      return handleResourceMetadata(req, res, AUTH);
    }
    if (method === "GET" && urlPath === "/authorize") {
      return handleAuthorize(req, res, AUTH);
    }
    if (method === "POST" && urlPath === "/token") {
      return handleTokenProxy(res, await readBody(req), AUTH);
    }
  }

  if (urlPath === "/mcp") {
    if (method === "GET") {
      if (AUTH) return handleResourceMetadata(req, res, AUTH);
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    if (method === "POST") {
      return handleMcpPost(req, res);
    }
  }

  sendJson(res, 404, { error: "not_found", path: urlPath });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: "internal_error",
        error_description: err instanceof Error ? err.message : String(err),
      });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, () => {
  console.log(
    `QuickBooks MCP server listening on :${PORT} ` +
      `(auth=${AUTH ? "enabled" : "disabled"}, mode=${process.env.QBO_CREDENTIAL_MODE || "local"}, setup-gate=${SETUP_TOKEN ? "on" : "off"})`
  );
});
