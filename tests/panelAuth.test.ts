import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authCookie,
  createPanelAuth,
  extractToken,
  isLoopbackHost,
  parseCookies,
  tokensMatch
} from "../src/panelAuth.js";

const TOKEN = "test-token-123";

describe("tokensMatch", () => {
  it("accepts only the exact token", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch("test-token-124", TOKEN)).toBe(false);
    expect(tokensMatch("test-token-1234", TOKEN)).toBe(false);
    expect(tokensMatch("", TOKEN)).toBe(false);
    expect(tokensMatch(null, TOKEN)).toBe(false);
  });

  it("never matches when no token is configured", () => {
    expect(tokensMatch("", "")).toBe(false);
  });
});

describe("extractToken", () => {
  it("reads bearer, x-ui-token and cookie", () => {
    expect(extractToken({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(extractToken({ "x-ui-token": TOKEN })).toBe(TOKEN);
    expect(extractToken({ cookie: `other=1; ui_token=${encodeURIComponent(TOKEN)}` })).toBe(TOKEN);
    expect(extractToken({})).toBeNull();
  });

  it("round-trips the cookie it sets", () => {
    const token = "a b;c=d%";
    const cookieValue = authCookie(token).split(";")[0];
    expect(parseCookies(cookieValue).ui_token).toBe(token);
  });
});

describe("isLoopbackHost", () => {
  it("classifies bind addresses", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("createPanelAuth", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const authenticate = createPanelAuth(TOKEN);
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!(await authenticate(request, response, url))) return;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("rejects API requests without a valid token", async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/status`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    // The query parameter is only a login shortcut for the page, not an API credential.
    expect((await fetch(`${base}/api/status?token=${TOKEN}`)).status).toBe(401);
  });

  it("accepts API requests with the token in a header or cookie", async () => {
    expect((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await fetch(`${base}/api/status`, { headers: { "x-ui-token": TOKEN } })).status).toBe(200);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: `ui_token=${TOKEN}` } })).status).toBe(200);
  });

  it("shows the login page instead of the dashboard", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('action="/login"');
    expect((await fetch(`${base}/app.js`)).status).toBe(401);
  });

  it("sets the cookie from the login form and from ?token=", async () => {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN}`,
      redirect: "manual"
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");

    const query = await fetch(`${base}/?token=${TOKEN}&x=1`, { redirect: "manual" });
    expect(query.status).toBe(303);
    expect(query.headers.get("location")).toBe("/?x=1");
    expect(query.headers.get("set-cookie")).toMatch(/^ui_token=/);

    const wrong = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=nope",
      redirect: "manual"
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("lets everything through when no token is configured", async () => {
    const open = createPanelAuth("");
    const result = await open({ headers: {}, method: "GET" } as never, {} as never, new URL("http://x/api/status"));
    expect(result).toBe(true);
  });
});
