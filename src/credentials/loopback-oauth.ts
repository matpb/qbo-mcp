// Loopback OAuth flow: open the user's browser, catch Intuit's callback on an
// ephemeral 127.0.0.1 listener via the GitHub Pages bounce page, exchange the
// code for tokens. The bounce page parses state="<nonce>.<port>" and does a
// client-side redirect back to this listener.

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import {
  generateAuthorizationUrl,
  exchangeCodeForTokens,
  type TokenExchangeResult,
} from "./oauth-client.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface BeginLoopbackOptions {
  timeoutMs?: number;
  openBrowser?: boolean;
}

export interface LoopbackHandle {
  /** URL the user must visit. Already opened in default browser unless disabled. */
  authUrl: string;
  /** Resolves with tokens once Intuit's callback is received and exchanged. */
  result: Promise<TokenExchangeResult>;
}

/**
 * Bind an ephemeral loopback listener, construct the authorize URL with a
 * state tying the port to a random nonce, and (unless disabled) open it in
 * the user's default browser. Returns the URL and a pending result promise.
 */
export async function beginLoopbackOAuth(
  clientId: string,
  clientSecret: string,
  opts: BeginLoopbackOptions = {}
): Promise<LoopbackHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shouldOpenBrowser = opts.openBrowser ?? true;
  const nonce = crypto.randomBytes(16).toString("hex");

  const { server, port } = await new Promise<{ server: http.Server; port: number }>((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      resolve({ server: s, port: p });
    });
  });

  const state = `${nonce}.${port}`;
  const authUrl = generateAuthorizationUrl(clientId, clientSecret, state);

  const result = new Promise<TokenExchangeResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error(`Loopback OAuth timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const close = () => {
      clearTimeout(timeout);
      setImmediate(() => server.close());
    };

    server.on("request", (req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/cb") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = reqUrl.searchParams.get("code");
      const realmId = reqUrl.searchParams.get("realmId");
      const returnedState = reqUrl.searchParams.get("state");
      const error = reqUrl.searchParams.get("error");

      const respond = (body: string, status = 200) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(body);
      };

      if (error) {
        respond(`<h1>Connection failed</h1><p>Intuit returned: ${escapeHtml(error)}</p>`, 400);
        close();
        reject(new Error(`Intuit OAuth error: ${error}`));
        return;
      }
      if (!code || !realmId || !returnedState) {
        respond(`<h1>Connection failed</h1><p>Missing code, realmId, or state.</p>`, 400);
        close();
        reject(new Error("Callback missing code/realmId/state"));
        return;
      }
      if (returnedState !== state) {
        respond(`<h1>Connection failed</h1><p>State mismatch.</p>`, 400);
        close();
        reject(new Error("State mismatch — possible CSRF"));
        return;
      }

      respond(`<!doctype html><html><body style="font-family: sans-serif; max-width: 540px; margin: 4rem auto; padding: 0 1rem;">
<h1 style="color:#2a6;">Connected to QuickBooks</h1>
<p>You can close this tab and return to Claude.</p>
</body></html>`);

      exchangeCodeForTokens(clientId, clientSecret, code, realmId)
        .then((r) => { close(); resolve(r); })
        .catch((e) => { close(); reject(e); });
    });
  });

  if (shouldOpenBrowser) openBrowser(authUrl);

  return { authUrl, result };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // Avoid cmd.exe / `start` — they shell-interpret `&` in query strings and
      // truncate OAuth URLs at the first &, which makes Intuit reject the
      // request with "scope query parameter is missing". FileProtocolHandler
      // passes the URL straight to the registered https handler.
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Non-fatal: caller still has the URL to print.
  }
}
