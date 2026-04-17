// Cloud Run HTTP entrypoint for QuickBooks MCP server.
//
// Speaks MCP Streamable HTTP on POST /mcp. Listens on $PORT (Cloud Run
// convention). Token storage is via GCP Secret Manager (see gcp-provider.ts).
//
// Auth model (toggleable via MCP_AUTH_ENABLED):
//   false (default for first ship) — /mcp is unauthenticated at the app
//     layer. Relies on Cloud Run's "require authentication" setting + IAM
//     invoker role to gate access at the network layer.
//   true — full OAuth 2.1 gate for claude.ai custom connectors. Exposes the
//     standard discovery endpoints and proxies /authorize + /token to the
//     upstream AS configured by MCP_AUTHORIZE_URL / MCP_TOKEN_URL. Bearer
//     tokens are validated by auth/token-validator.ts.
//
// See README "Environment variables" for the full env-var reference.

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

// Keep in sync with package.json version. (ESM + NodeNext JSON imports add
// build-time friction; a two-line manual bump on release is cheaper.)
const SERVER_VERSION = "0.1.0";

setOutputMode("http");

const PORT = parseInt(process.env.PORT || "8080", 10);

// Tools that only make sense in the stdio (local dev) transport — their
// semantics assume a human operating Claude Code through the OAuth Playground
// flow. Filter them out before exposing the tool list over HTTP.
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

/** Host+proto of this request, without a path. */
function publicBase(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

/** Full public URL for the current request (or an explicit override path). */
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

// --------------------------------------------------------------------------
// OAuth discovery and proxy endpoints (only served when AUTH is loaded)
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
    sendJson(res, 500, { error: "authorize_not_configured" });
    return;
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
      // Some upstream AS tenants disallow consent prompts for unverified clients
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

async function handleToken(
  res: ServerResponse,
  body: string,
  auth: AuthConfig
): Promise<void> {
  if (!auth.tokenUrl) {
    sendJson(res, 500, { error: "token_not_configured" });
    return;
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
// Main router
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
      return handleToken(res, await readBody(req), AUTH);
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
      `(auth=${AUTH ? "enabled" : "disabled"}, mode=${process.env.QBO_CREDENTIAL_MODE || "local"})`
  );
});
