/**
 * The fourth door and the hosted relay: sign-in by link, owned relays, the
 * HTML directory, and Obscura served by the catalog itself. No network: the
 * hosted relay's subdomain is routed back into the same app, and the browser
 * is a fake runner.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { Catalog } from "../src/db.ts";
import { createApp, ensureHosted, hostedOrigin } from "../src/server.ts";
import { obscuraRelay, acceptableUrl, type Runner } from "../src/hosted/obscura.ts";
import type { Mailer, Mail } from "../src/mail.ts";
import { SESSION_COOKIE } from "../src/auth.ts";

function fakeRelay(): Hono {
  const app = new Hono();
  app.get("/.well-known/openmcp.json", (c) => c.json({ openmcp: "0.1", mcp: "/mcp", name: "Fake board", description: "A board.", tags: ["jobs"] }));
  app.post("/mcp", async (c) => {
    const body = (await c.req.json()) as { id?: number; method: string };
    if (body.id === undefined) return c.body(null, 202);
    const reply = (value: unknown): Response => c.json({ jsonrpc: "2.0", id: body.id, result: value });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", serverInfo: { name: "fakeboard", version: "1" }, capabilities: {} });
    if (body.method === "tools/list") return reply({ tools: [{ name: "search", description: "Search jobs", inputSchema: { type: "object" } }] });
    return c.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  });
  return app;
}

/** Every fetch goes to the app registered for its host, with the Host header set the way a proxy would. */
function router(apps: Record<string, Hono>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const app = apps[url.host];
    if (!app) return new Response("no such host", { status: 502 });
    const headers = new Headers(request.headers);
    headers.set("host", url.host);
    return app.fetch(new Request(request, { headers }));
  }) as typeof fetch;
}

function outbox(): { mailer: Mailer; sent: Mail[] } {
  const sent: Mail[] = [];
  return { sent, mailer: { enabled: true, async send(mail) { sent.push(mail); return { ok: true }; } } };
}

const linkIn = (mail: Mail): string => (mail.text.match(/https?:\/\/\S+/) as RegExpMatchArray)[0];
const cookieOf = (response: Response): string => ((response.headers.get("set-cookie") ?? "").match(new RegExp(`${SESSION_COOKIE}=([^;]+)`)) as RegExpMatchArray)[1];

test("sign-in by link registers, sets a session, and the answer never says whether the address is known", async () => {
  const store = new Catalog();
  const { mailer, sent } = outbox();
  const app = createApp({ store, url: "https://catalog.test", name: "Test catalog", mailer, fetch: router({ "board.test": fakeRelay() }) });

  // A malformed address is the only thing refused.
  let response = await app.request("/v1/auth/magic", { method: "POST", body: JSON.stringify({ email: "nope" }), headers: { "content-type": "application/json" } });
  assert.equal(response.status, 400);

  // Unknown and known addresses get one answer.
  response = await app.request("/v1/auth/magic", { method: "POST", body: JSON.stringify({ email: "Ada@Example.com" }), headers: { "content-type": "application/json" } });
  assert.equal(response.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "ada@example.com");

  // The link signs in and makes the account.
  const link = linkIn(sent[0] as Mail);
  response = await app.request(new URL(link).pathname + new URL(link).search);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/me");
  const session = cookieOf(response);
  assert.ok(session);

  // Once only.
  response = await app.request(new URL(link).pathname + new URL(link).search);
  assert.equal(response.status, 400);

  // The session is a person.
  response = await app.request("/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
  assert.equal(response.status, 200);
  const me = (await response.json()) as { user: { email: string }; relays: unknown[] };
  assert.equal(me.user.email, "ada@example.com");
  assert.deepEqual(me.relays, []);

  // Five links an hour, then silence that still says "sent".
  for (let i = 0; i < 6; i++) await app.request("/v1/auth/magic", { method: "POST", body: JSON.stringify({ email: "ada@example.com" }), headers: { "content-type": "application/json" } });
  assert.equal(sent.length, 5);

  // Signing out ends the session.
  response = await app.request("/auth/sign-out", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session}`, "sec-fetch-site": "same-origin" } });
  assert.equal(response.status, 302);
  response = await app.request("/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
  assert.equal(response.status, 401);
});

test("a relay registered while signed in is owned: its owner can probe and remove it, nobody else can, admin still can", async () => {
  const store = new Catalog();
  const { mailer, sent } = outbox();
  const app = createApp({ store, url: "https://catalog.test", mailer, adminToken: "adm", fetch: router({ "board.test": fakeRelay() }) });
  const signIn = async (email: string): Promise<string> => {
    await app.request("/v1/auth/magic", { method: "POST", body: JSON.stringify({ email }), headers: { "content-type": "application/json" } });
    const link = linkIn(sent[sent.length - 1] as Mail);
    return cookieOf(await app.request(new URL(link).pathname + new URL(link).search));
  };
  const ada = await signIn("ada@example.com");
  const bob = await signIn("bob@example.com");

  // Ada registers through the form.
  let response = await app.request("/me/relays", { method: "POST", body: new URLSearchParams({ url: "https://board.test" }), headers: { cookie: `${SESSION_COOKIE}=${ada}`, "sec-fetch-site": "same-origin" } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Listed board\.test: online, 1 tools, verified/);
  assert.equal(store.relayOwner("board.test"), (await (await app.request("/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${ada}` } })).json() as { user: { id: string } }).user.id);

  // A form post from elsewhere is refused.
  response = await app.request("/me/relays", { method: "POST", body: new URLSearchParams({ url: "https://board.test" }), headers: { cookie: `${SESSION_COOKIE}=${ada}`, "sec-fetch-site": "cross-site" } });
  assert.equal(response.status, 403);

  // Bob registering the same relay does not take it over.
  response = await app.request("/v1/relays", { method: "POST", body: JSON.stringify({ url: "https://board.test" }), headers: { cookie: `${SESSION_COOKIE}=${bob}`, "content-type": "application/json" } });
  assert.equal(response.status, 200);
  response = await app.request("/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${bob}` } });
  assert.equal(((await response.json()) as { relays: unknown[] }).relays.length, 0);

  // Bob cannot remove it; anonymous cannot; Ada can; so can admin.
  response = await app.request("/v1/relays/board.test", { method: "DELETE", headers: { cookie: `${SESSION_COOKIE}=${bob}` } });
  assert.equal(response.status, 401);
  response = await app.request("/v1/relays/board.test", { method: "DELETE" });
  assert.equal(response.status, 401);
  response = await app.request("/me/relays/board.test/refresh", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${bob}`, "sec-fetch-site": "same-origin" } });
  assert.equal(response.status, 403);
  response = await app.request("/me/relays/board.test/refresh", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${ada}`, "sec-fetch-site": "same-origin" } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Probed board\.test: online/);
  response = await app.request("/v1/relays/board.test", { method: "DELETE", headers: { cookie: `${SESSION_COOKIE}=${ada}` } });
  assert.equal(response.status, 200);
  assert.equal(store.getRelay("board.test"), null);

  // Registered again anonymously: unowned, and admin removes it.
  await app.request("/v1/relays", { method: "POST", body: JSON.stringify({ url: "https://board.test" }), headers: { "content-type": "application/json" } });
  assert.equal(store.relayOwner("board.test"), null);
  response = await app.request("/v1/relays/board.test", { method: "DELETE", headers: { authorization: "Bearer adm" } });
  assert.equal(response.status, 200);
});

test("the directory is HTML for a browser and JSON for everything else", async () => {
  const store = new Catalog();
  const app = createApp({ store, url: "https://catalog.test", name: "Test catalog", mailer: outbox().mailer, fetch: router({ "board.test": fakeRelay() }) });
  await app.request("/v1/relays", { method: "POST", body: JSON.stringify({ url: "https://board.test" }), headers: { "content-type": "application/json" } });

  let response = await app.request("/", { headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(response.headers.get("content-type")?.split(";")[0], "text/html");
  let html = await response.text();
  assert.match(html, /Fake board/);
  assert.match(html, /1 relays · 1 online/);

  response = await app.request("/", { headers: { accept: "application/json" } });
  assert.equal(response.headers.get("content-type")?.split(";")[0], "application/json");
  response = await app.request("/");
  assert.equal(response.headers.get("content-type")?.split(";")[0], "application/json");

  response = await app.request("/relays/board.test");
  html = await response.text();
  assert.match(html, /<code>search<\/code>/);
  assert.match(html, /verified/);
  response = await app.request("/?q=nothing-matches", { headers: { accept: "text/html" } });
  assert.match(await response.text(), /Nothing listed matches/);
  response = await app.request("/?tag=jobs", { headers: { accept: "text/html" } });
  assert.match(await response.text(), /Fake board/);
  response = await app.request("/sign-up");
  assert.match(await response.text(), /Email me a link/);
  response = await app.request("/me");
  assert.equal(response.status, 302);
});

test("Obscura is served at its own subdomain and under /hosted, and lists itself as a verified relay", async () => {
  const store = new Catalog();
  const calls: Array<{ url: string; format: string; stealth: boolean }> = [];
  const runner: Runner = async (request) => {
    calls.push(request);
    if (request.url.includes("fail")) return { ok: false, output: "", error: "obscura exited 1: boom", ms: 3 };
    return { ok: true, output: `# Page\n\n${"x".repeat(5000)}`, ms: 12 };
  };
  const hosted = [obscuraRelay({ runner, operator: "https://logicsrc.com/.well-known/openprofile.md" })];
  const apps: Record<string, Hono> = {};
  const app = createApp({ store, url: "https://catalog.test", mailer: outbox().mailer, hosted, fetch: router(apps) });
  apps["catalog.test"] = app;
  apps["obscura.catalog.test"] = app;

  assert.equal(hostedOrigin("https://catalog.test", "obscura"), "https://obscura.catalog.test");
  assert.equal(hostedOrigin("http://127.0.0.1:8790", "obscura"), null);
  assert.equal(hostedOrigin("http://localhost:8790", "obscura"), null);

  // The subdomain serves the descriptor at its own origin.
  let response = await app.request("/.well-known/openmcp.json", { headers: { host: "obscura.catalog.test" } });
  let descriptor = (await response.json()) as { name: string; mcp: string; catalogs: string[] };
  assert.equal(descriptor.name, "Obscura");
  assert.equal(descriptor.mcp, "https://obscura.catalog.test/mcp");
  assert.deepEqual(descriptor.catalogs, ["https://catalog.test"]);

  // The path mount serves the same relay from the catalog's origin.
  response = await app.request("/hosted/obscura/.well-known/openmcp.json", { headers: { host: "catalog.test" } });
  descriptor = (await response.json()) as { name: string; mcp: string; catalogs: string[] };
  assert.equal(descriptor.mcp, "https://catalog.test/hosted/obscura/mcp");

  // The catalog's own descriptor is untouched.
  response = await app.request("/.well-known/openmcp.json", { headers: { host: "catalog.test" } });
  assert.equal(((await response.json()) as { name: string }).name, "OpenMCP catalog");

  // A tool call, through the relay's MCP endpoint.
  response = await app.request("/mcp", { method: "POST", headers: { host: "obscura.catalog.test", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch_page", arguments: { url: "https://www.cdc.gov/han/", max_chars: 1000 } } }) });
  let rpc = (await response.json()) as { result: { isError?: boolean; content: { text: string }[]; structuredContent: { truncated: boolean; chars: number; format: string; stealth: boolean } } };
  assert.equal(rpc.result.isError, undefined);
  assert.equal(rpc.result.structuredContent.format, "markdown");
  assert.equal(rpc.result.structuredContent.stealth, true);
  assert.equal(rpc.result.structuredContent.truncated, true);
  assert.equal(rpc.result.structuredContent.chars, 1000);
  assert.match(rpc.result.content[0]?.text ?? "", /\[truncated at 1000 characters\]/);
  assert.deepEqual(calls[0], { url: "https://www.cdc.gov/han/", format: "markdown", stealth: true, timeoutSeconds: 30 });

  // A failure is a tool error, not a JSON-RPC error; a private URL never reaches the browser.
  response = await app.request("/mcp", { method: "POST", headers: { host: "obscura.catalog.test", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch_page", arguments: { url: "https://fail.example", format: "text" } } }) });
  rpc = (await response.json()) as typeof rpc;
  assert.equal(rpc.result.isError, true);
  assert.match(rpc.result.content[0]?.text ?? "", /boom/);
  response = await app.request("/mcp", { method: "POST", headers: { host: "obscura.catalog.test", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fetch_page", arguments: { url: "http://10.0.0.1/admin" } } }) });
  rpc = (await response.json()) as typeof rpc;
  assert.equal(rpc.result.isError, true);
  assert.equal(calls.length, 2);

  // The catalog probes its own hosted relay like any other and lists it verified and online.
  const listed = await ensureHosted({ store, url: "https://catalog.test", hosted, fetch: router(apps) });
  assert.deepEqual(listed.listed, ["obscura.catalog.test"]);
  const record = store.getRelay("obscura.catalog.test");
  assert.ok(record);
  assert.equal(record.verified, true);
  assert.equal(record.online, true);
  assert.deepEqual(record.tools.map((tool) => tool.name), ["fetch_page"]);

  // And a call through the catalog reaches it.
  response = await app.request("/v1/relays/obscura.catalog.test/call", { method: "POST", headers: { host: "catalog.test", "content-type": "application/json" }, body: JSON.stringify({ tool: "fetch_page", arguments: { url: "https://example.com", format: "text" } }) });
  const forwarded = (await response.json()) as { ok: boolean; result: { structuredContent: { format: string } } };
  assert.equal(forwarded.ok, true);
  assert.equal(forwarded.result.structuredContent.format, "text");
});

test("acceptableUrl keeps the browser on the public web", () => {
  assert.equal(acceptableUrl("https://example.com/a?b=1").ok, true);
  for (const bad of ["", "ftp://x", "http://localhost/", "http://127.0.0.1/", "http://192.168.1.1/", "http://172.20.0.1/", "http://[::1]/", "http://user:pw@example.com/", "http://box.internal/", "not a url"]) {
    assert.equal(acceptableUrl(bad).ok, false, bad);
  }
});
