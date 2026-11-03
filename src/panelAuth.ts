import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

export const AUTH_COOKIE = "ui_token";
export const AUTH_QUERY_PARAM = "token";

/** Constant-time comparison. Both sides are hashed first so lengths never leak through timing. */
export function tokensMatch(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** Token from `Authorization: Bearer <token>`, the `x-ui-token` header, or the `ui_token` cookie. */
export function extractToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  const headerToken = headers["x-ui-token"];
  if (typeof headerToken === "string" && headerToken) return headerToken;

  return parseCookies(headers.cookie)[AUTH_COOKIE] ?? null;
}

export function isAuthorized(headers: IncomingHttpHeaders, expected: string): boolean {
  return tokensMatch(extractToken(headers), expected);
}

export function authCookie(token: string, maxAgeSeconds = 30 * 24 * 60 * 60): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(normalized) ||
    /^::ffff:127(\.\d{1,3}){3}$/.test(normalized)
  );
}

export function loginPageHtml(failed: boolean): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Meteora DLMM Bot - Sign in</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
      form { display: grid; gap: 12px; width: min(320px, 90vw); padding: 24px; border: 1px solid #30363d; border-radius: 10px; background: #161b22; }
      h1 { margin: 0 0 4px; font-size: 1.1rem; }
      input, button { font: inherit; padding: 8px 10px; border-radius: 6px; border: 1px solid #30363d; }
      input { background: #0d1117; color: inherit; }
      button { background: #238636; color: #fff; border-color: #238636; cursor: pointer; }
      .error { margin: 0; color: #f85149; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <form method="post" action="/login">
      <h1>Control panel token</h1>
      ${failed ? '<p class="error">Invalid token.</p>' : ""}
      <input type="password" name="token" autocomplete="current-password" placeholder="UI_TOKEN" required autofocus />
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>`;
}

async function readFormToken(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4096) break;
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get(AUTH_QUERY_PARAM) ?? "";
}

function sendLoginPage(response: ServerResponse, failed: boolean) {
  response.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(loginPageHtml(failed));
}

function sendUnauthorized(response: ServerResponse) {
  response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Unauthorized" }));
}

/**
 * Returns a request guard for the control panel. With an empty token every request passes.
 * Otherwise the token must arrive as `Authorization: Bearer`, `x-ui-token`, or the `ui_token`
 * cookie, which is set by the login form (POST /login) or by opening any page once with
 * `?token=<UI_TOKEN>` (the token is then removed from the URL by a redirect).
 * The guard returns true when the request may proceed; otherwise it has already responded.
 */
export function createPanelAuth(token: string) {
  const redirectWithCookie = (response: ServerResponse, location: string) => {
    response.writeHead(303, { location, "set-cookie": authCookie(token), "cache-control": "no-store" });
    response.end();
  };

  return async function authenticate(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!token) return true;

    const isApi = url.pathname.startsWith("/api/");

    if (url.pathname === "/login" && request.method === "POST") {
      if (tokensMatch(await readFormToken(request), token)) {
        redirectWithCookie(response, "/");
      } else {
        sendLoginPage(response, true);
      }
      return false;
    }

    const queryToken = url.searchParams.get(AUTH_QUERY_PARAM);
    if (!isApi && queryToken !== null) {
      if (!tokensMatch(queryToken, token)) {
        sendLoginPage(response, true);
        return false;
      }
      url.searchParams.delete(AUTH_QUERY_PARAM);
      redirectWithCookie(response, `${url.pathname}${url.search}`);
      return false;
    }

    if (isAuthorized(request.headers, token)) return true;

    if (!isApi && (url.pathname === "/" || url.pathname === "/login" || url.pathname.endsWith(".html"))) {
      sendLoginPage(response, false);
    } else {
      sendUnauthorized(response);
    }
    return false;
  };
}
