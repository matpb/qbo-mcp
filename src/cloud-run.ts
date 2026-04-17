// Cloud Run HTTP entrypoint for QuickBooks MCP server.
//
// Speaks MCP Streamable HTTP on POST /mcp. Listens on $PORT (Cloud Run convention).
// Token storage is via GCP Secret Manager (src/credentials/gcp-provider.ts).
//
// Auth model (toggleable via MCP_AUTH_ENABLED):
//   false (default for first ship) — /mcp is unauthenticated. Relies on Cloud
//     Run's "require authentication" setting + IAM invoker role to gate access.
//     You'd grant specific Google identities roles/run.invoker on this service.
//   true — full OAuth 2.1 gate for claude.ai custom connectors. Exposes the
//     standard discovery endpoints (/.well-known/oauth-authorization-server,
//     /.well-known/oauth-protected-resource) and proxies /authorize + /token
//     to the upstream AS configured by MCP_AUTHORIZE_URL / MCP_TOKEN_URL.
//     Bearer tokens are validated by src/auth/token-validator.ts.
//
// Env vars summary:
//   PORT                      — Cloud Run provides this, default 8080
//   QBO_CREDENTIAL_MODE       — "gcp" for Cloud Run
//   GCP_PROJECT_ID            — secret's project
//   QBO_SECRET_NAME           — default "qbo-credentials"
//   MCP_AUTH_ENABLED          — "true" to enable OAuth gate (default false)
//   MCP_AUTHORIZE_URL         — upstream AS authorize endpoint
//   MCP_TOKEN_URL             — upstream AS token endpoint
//   MCP_AUTH_ISSUER           — token issuer claim to validate
//   MCP_AUTH_AUDIENCE         — expected audience claim
//   MCP_AUTH_SCOPE            — required scope

import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { setOutputMode } from "./utils/output.js";
import { toolDefinitions, executeTool } from "./tools/index.js";
import { getAuthConfig, validateToken } from "./auth/token-validator.js";

// HTTP output mode (fixtures inline in responses, not tmp files)
setOutputMode("http");

const PORT = parseInt(process.env.PORT || "8080", 10);
const AUTH_ENABLED = process.env.MCP_AUTH_ENABLED === "true";
const AUTHORIZE_URL = process.env.MCP_AUTHORIZE_URL || "";
const TOKEN_URL = process.env.MCP_TOKEN_URL || "";
const AUTH_ISSUER = process.env.MCP_AUTH_ISSUER || "";
const MCP_SCOPE =
  process.env.MCP_AUTH_AUDIENCE && process.env.MCP_AUTH_SCOPE
    ? `${process.env.MCP_AUTH_AUDIENCE}/${process.env.MCP_AUTH_SCOPE}`
    : "";

// qbo_authenticate is a stdio-only flow — irrelevant for a remote deploy where
// tokens are bootstrapped out-of-band into Secret Manager.
const remoteToolDefinitions = toolDefinitions.filter(
  (t) => t.name !== "qbo_authenticate"
);

const authConfig = AUTH_ENABLED ? getAuthConfig() : null;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function createMcpServer(): Server {
  const server = new Server(
    { name: "quickbooks-mcp", version: "1.0.0" },
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
// Request/response plumbing — convert Node HTTP primitives to Web Standard
// --------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function publicUrl(req: IncomingMessage, overridePath?: string): string {
  // Behind Cloud Run's HTTPS load balancer, trust x-forwarded-proto if set.
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  const path = overridePath ?? req.url ?? "/";
  return `${proto}://${host}${path}`;
}

function toWebRequest(req: IncomingMessage, body: string): Request {
  const url = publicUrl(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return new Request(url, {
    method: req.method,
    headers,
    body: req.method && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
  });
}

async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.statusCode = webRes.status;
  const text = await webRes.text();
  res.end(text);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

// --------------------------------------------------------------------------
// OAuth discovery and proxy endpoints (only served when AUTH_ENABLED)
// --------------------------------------------------------------------------

function handleAuthServerMetadata(req: IncomingMessage, res: ServerResponse): void {
  const base = publicUrl(req, "");
  sendJson(res, 200, {
    issuer: AUTH_ISSUER || base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: MCP_SCOPE ? [MCP_SCOPE, "offline_access"] : [],
  });
}

function handleResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
  const resourceUrl = publicUrl(req);
  sendJson(res, 200, {
    resource: resourceUrl,
    authorization_servers: [publicUrl(req, "")],
    scopes_supported: MCP_SCOPE ? [MCP_SCOPE, "offline_access"] : [],
    bearer_methods_supported: ["header"],
    resource_name: process.env.MCP_RESOURCE_NAME || "QuickBooks MCP Server",
  });
}

function handleAuthorize(req: IncomingMessage, res: ServerResponse): void {
  if (!AUTHORIZE_URL) {
    sendJson(res, 500, { error: "authorize_not_configured" });
    return;
  }
  const url = new URL(req.url ?? "/", publicUrl(req, ""));
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "scope") {
      const requested = value.split(" ");
      const hasOffline = requested.includes("offline_access");
      const scope = MCP_SCOPE
        ? hasOffline
          ? `${MCP_SCOPE} offline_access`
          : MCP_SCOPE
        : value;
      params.set("scope", scope);
    } else if (key === "prompt" && value === "consent") {
      // Some upstream AS tenants disallow consent prompts for unverified clients
      params.set("prompt", "select_account");
    } else {
      params.set(key, value);
    }
  }
  if (!params.has("scope") && MCP_SCOPE) {
    params.set("scope", `${MCP_SCOPE} offline_access`);
  }
  const redirect = `${AUTHORIZE_URL}?${params.toString()}`;
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  res.statusCode = 302;
  res.setHeader("Location", redirect);
  res.end();
}

async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  body: string
): Promise<void> {
  if (!TOKEN_URL) {
    sendJson(res, 500, { error: "token_not_configured" });
    return;
  }
  const params = new URLSearchParams(body);
  if (MCP_SCOPE) {
    const current = params.get("scope") || "";
    const hasOffline = current.split(" ").includes("offline_access");
    params.set("scope", hasOffline ? `${MCP_SCOPE} offline_access` : MCP_SCOPE);
  }
  const upstream = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
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
  const match = Array.isArray(auth) ? auth[0].match(/^Bearer\s+(.+)$/i) : auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// --------------------------------------------------------------------------
// Main router
// --------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method || "GET";
  const urlPath = (req.url || "/").split("?")[0];

  if (method === "OPTIONS") {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === "GET" && urlPath === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Discovery endpoints
  if (AUTH_ENABLED && method === "GET" && urlPath === "/.well-known/oauth-authorization-server") {
    handleAuthServerMetadata(req, res);
    return;
  }
  if (AUTH_ENABLED && method === "GET" && urlPath === "/.well-known/oauth-protected-resource") {
    handleResourceMetadata(req, res);
    return;
  }

  // OAuth proxy endpoints
  if (AUTH_ENABLED && method === "GET" && urlPath === "/authorize") {
    handleAuthorize(req, res);
    return;
  }
  if (AUTH_ENABLED && method === "POST" && urlPath === "/token") {
    const body = await readBody(req);
    await handleToken(req, res, body);
    return;
  }

  // MCP endpoint
  if (urlPath === "/mcp" || urlPath === "/") {
    if (method === "GET") {
      if (AUTH_ENABLED) {
        handleResourceMetadata(req, res);
        return;
      }
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (method === "POST") {
      if (AUTH_ENABLED && authConfig) {
        const token = extractBearerToken(req);
        if (!token) {
          unauthorized(req, res, "Bearer token required");
          return;
        }
        const result = await validateToken(token, authConfig);
        if (!result.valid) {
          unauthorized(req, res, result.error);
          return;
        }
      }

      const body = await readBody(req);
      const mcpServer = createMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await mcpServer.connect(transport);
      try {
        const webRequest = toWebRequest(req, body);
        const webResponse = await transport.handleRequest(webRequest);
        await sendWebResponse(res, webResponse);
      } finally {
        await transport.close();
        await mcpServer.close();
      }
      return;
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
      `(auth=${AUTH_ENABLED ? "enabled" : "disabled"}, ` +
      `mode=${process.env.QBO_CREDENTIAL_MODE || "local"})`
  );
});
