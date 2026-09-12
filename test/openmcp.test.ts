/**
 * The catalog end to end, against a fake relay and a fake webhook receiver,
 * with no network: every fetch is routed to an in-process Hono app.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { Catalog } from "../src/db.ts";
import { createApp, refreshAll, syncPeers } from "../src/server.ts";
import { OpenMcpClient, verifySignature } from "../src/client.ts";
import { McpClient } from "../src/mcp/client.ts";
import { probeRelay } from "../src/probe.ts";
import { parseDescriptor, relayId } from "../src/spec.ts";
import { sign } from "../src/webhooks.ts";

/** A relay: a descriptor at its well-known path and an MCP endpoint with two tools. */
function fakeRelay(options: { descriptor?: boolean; down?: boolean; auth?: string } = {}): Hono {
  const app = new Hono();
  if (options.descriptor !== false) {
    app.get("/.well-known/openmcp.json", (c) =>
      c.json({ openmcp: "0.1", mcp: "/api/mcp", name: "Fake board", description: "A board.", tags: ["Jobs", "boards"], auth: { kind: options.auth ? "bearer" : "none", open: ["search"] }, operator: "https://ada.example/.well-known/openprofile.md" }),
    );
  }
  app.post("/api/mcp", async (c) => {
    if (options.down) return c.text("gone", 503);
    const body = (await c.req.json()) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (body.id === undefined) return c.body(null, 202);
    // Like a real board: the handshake and the list are open, a call needs the credential.
    if (options.auth && body.method === "tools/call" && c.req.header("authorization") !== `Bearer ${options.auth}`) return c.json({ error: "no" }, 401);
    const reply = (result: unknown): Response => c.json({ jsonrpc: "2.0", id: body.id, result });
    switch (body.method) {
      case "initialize":
        return reply({ protocolVersion: "2025-06-18", serverInfo: { name: "fakeboard", version: "9.9" }, capabilities: {} });
      case "tools/list":
        return reply({ tools: [{ name: "search", description: "Search jobs", inputSchema: { type: "object" } }, { name: "post_update", description: "Post an update", inputSchema: { type: "object" } }] });
      case "tools/call":
        if (body.params?.name === "search") return reply({ content: [{ type: "text", text: "2 jobs" }], structuredContent: { jobs: ["a", "b"], q: body.params.arguments?.q } });
        return reply({ content: [{ type: "text", text: "Five a day already." }], isError: true });
      default:
        return c.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    }
  });
  return app;
}

/** Route fetch by host to in-process apps. */
function router(apps: Record<string, Hono>, captured: Array<{ url: string; headers: Headers; body: string }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const app = apps[url.host];
    if (!app) return new Response("no such host", { status: 502 });
    const headers = new Headers(init?.headers as Record<string, string>);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.host === "hooks.example") captured.push({ url: url.toString(), headers, body });
    return app.request(url.toString(), { method: init?.method ?? "GET", headers, body: init?.body ?? undefined });
  }) as typeof fetch;
}

test("a descriptor parses with relative mcp, lowercased tags, and a bad one is null", () => {
  const parsed = parseDescriptor({ mcp: "/api/mcp", tags: ["Jobs", " Boards "], auth: { kind: "bearer", open: ["a", 1] } }, "https://x.example/.well-known/openmcp.json");
  assert.deepEqual(parsed, { openmcp: "0.1", mcp: "https://x.example/api/mcp", auth: { kind: "bearer", open: ["a"] }, tags: ["jobs", "boards"] });
  assert.equal(parseDescriptor({ name: "no mcp" }, "https://x.example/"), null);
  assert.equal(parseDescriptor({ mcp: "ftp://x" }, "https://x.example/"), null);
  assert.equal(relayId("https://www.Board.Example/api/mcp"), "board.example");
  assert.equal(relayId("https://x.example/teams/acme/mcp"), "x.example-teams-acme");
});

test("probe: verified and online with a descriptor; online but unverified without; offline keeps the descriptor and counts failures", async () => {
  const withDescriptor = await probeRelay("https://board.example/", { fetch: router({ "board.example": fakeRelay() }) });
  assert.equal(withDescriptor.id, "board.example");
  assert.equal(withDescriptor.verified, true);
  assert.equal(withDescriptor.online, true);
  assert.deepEqual(withDescriptor.tools.map((tool) => tool.name), ["search", "post_update"]);
  assert.equal(withDescriptor.server?.name, "fakeboard");
  assert.equal(withDescriptor.descriptor.operator, "https://ada.example/.well-known/openprofile.md");

  const bare = await probeRelay("https://bare.example/api/mcp", { fetch: router({ "bare.example": fakeRelay({ descriptor: false }) }) });
  assert.equal(bare.verified, false);
  assert.equal(bare.online, true);
  assert.equal(bare.descriptor.mcp, "https://bare.example/api/mcp");

  // Only the site: the usual endpoint paths are tried and the one that answers is kept.
  const guessed = await probeRelay("https://bare.example", { fetch: router({ "bare.example": fakeRelay({ descriptor: false }) }) });
  assert.equal(guessed.online, true);
  assert.equal(guessed.descriptor.mcp, "https://bare.example/api/mcp");
  assert.equal(guessed.id, "bare.example");

  const down = await probeRelay("https://board.example/", { fetch: router({ "board.example": fakeRelay({ down: true }) }), previous: withDescriptor });
  assert.equal(down.online, false);
  assert.equal(down.failures, 1);
  assert.equal(down.descriptor.name, "Fake board");
  assert.deepEqual(down.tools.map((tool) => tool.name), ["search", "post_update"], "the last known tools are kept, marked by online=false");
  assert.equal(down.seenAt, withDescriptor.seenAt);
});

test("REST: register, list, search, tools, call through, webhooks signed, admin gating", async () => {
  const store = new Catalog();
  const captured: Array<{ url: string; headers: Headers; body: string }> = [];
  const hooks = new Hono();
  hooks.post("/in", (c) => c.json({ ok: true }));
  const fetcher = router({ "board.example": fakeRelay(), "hooks.example": hooks }, captured);
  const app = createApp({ store, url: "https://catalog.example", adminToken: "adm", fetch: fetcher });
  const api = async (method: string, path: string, body?: unknown, token?: string) =>
    app.request(`https://catalog.example${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  // A subscription first, so the registration is delivered.
  const subscribed = await (await api("POST", "/v1/webhooks", { url: "https://hooks.example/in", events: ["relay.registered", "relay.offline"] })).json();
  assert.equal(subscribed.ok, true);
  const secret = subscribed.secret as string;

  const created = await api("POST", "/v1/relays", { url: "https://board.example" });
  assert.equal(created.status, 201);
  const relay = (await created.json()).relay;
  assert.equal(relay.id, "board.example");
  assert.equal(relay.verified, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(captured.length, 1, "one delivery for relay.registered");
  const delivery = captured[0]!;
  assert.equal(delivery.headers.get("x-openmcp-event"), "relay.registered");
  assert.equal(verifySignature(secret, delivery.headers.get("x-openmcp-signature"), delivery.body), true);
  assert.equal(verifySignature("wrong", delivery.headers.get("x-openmcp-signature"), delivery.body), false);
  assert.equal(JSON.parse(delivery.body).relay.id, "board.example");

  const listed = await (await api("GET", "/v1/relays?tag=jobs")).json();
  assert.equal(listed.relays.length, 1);
  assert.equal((await (await api("GET", "/v1/relays?q=nothing-here")).json()).relays.length, 0);
  const tools = await (await api("GET", "/v1/tools?q=update")).json();
  assert.deepEqual(tools.tools, [{ relay: "board.example", name: "post_update", description: "Post an update" }]);

  const called = await (await api("POST", "/v1/relays/board.example/call", { tool: "search", arguments: { q: "rust" } })).json();
  assert.equal(called.ok, true);
  assert.deepEqual(called.result.structuredContent, { jobs: ["a", "b"], q: "rust" });
  const refused = await api("POST", "/v1/relays/board.example/call", { tool: "post_update", arguments: {} });
  assert.equal(refused.status, 200);
  assert.equal((await refused.json()).ok, false, "the relay's own refusal is passed through as the tool result");

  assert.equal((await api("DELETE", "/v1/relays/board.example")).status, 401);
  assert.equal((await api("DELETE", "/v1/relays/board.example", undefined, "adm")).status, 200);
  assert.equal((await api("GET", "/v1/relays/board.example")).status, 404);

  const bogus = await api("POST", "/v1/relays", { url: "https://nowhere.example" });
  assert.equal(bogus.status, 422);

  const hook = await (await api("GET", `/v1/webhooks/${subscribed.webhook.id}`)).json();
  assert.equal(hook.webhook.secret, undefined, "the secret is shown once, at creation");
  assert.equal(hook.deliveries.length, 1);
  assert.equal(hook.deliveries[0].status, 200);
  store.close();
});

test("MCP: the catalog is a relay; list, find, call_tool forwards with the caller's token", async () => {
  const store = new Catalog();
  const fetcher = router({ "board.example": fakeRelay({ auth: "sekrit" }) });
  const app = createApp({ store, url: "https://catalog.example", fetch: fetcher });
  const viaCatalog = router({ "catalog.example": app, "board.example": fakeRelay({ auth: "sekrit" }) });

  const descriptor = await (await app.request("https://catalog.example/.well-known/openmcp.json")).json();
  assert.equal(descriptor.mcp, "https://catalog.example/mcp");
  assert.equal(descriptor.catalog.relays, 0);

  const client = new McpClient({ url: "https://catalog.example/mcp", fetch: viaCatalog });
  const info = await client.initialize();
  assert.equal(info.serverInfo?.name, "openmcp-catalog");
  assert.ok((await client.listTools()).some((tool) => tool.name === "call_tool"));

  const registered = await client.call<{ relay: { id: string; verified: boolean } }>("register_relay", { url: "https://board.example/.well-known/openmcp.json" });
  assert.equal(registered.relay.id, "board.example");
  const found = await client.call<{ tools: Array<{ relay: string; name: string }> }>("find_tool", { q: "search" });
  assert.deepEqual(found.tools.map((tool) => tool.name), ["search"]);

  const forwarded = await client.call<{ jobs: string[] }>("call_tool", { relay: "board.example", tool: "search", arguments: { q: "x" }, token: "sekrit" });
  assert.deepEqual(forwarded.jobs, ["a", "b"]);
  await assert.rejects(client.call("call_tool", { relay: "board.example", tool: "search" }), /refused the credential/);
  store.close();
});

test("the client speaks REST and MCP alike, and goes direct with connect", async () => {
  const store = new Catalog();
  const app = createApp({ store, url: "https://catalog.example", adminToken: "adm", fetch: router({ "board.example": fakeRelay() }) });
  const fetcher = router({ "catalog.example": app, "board.example": fakeRelay() });

  for (const transport of ["rest", "mcp"] as const) {
    const client = new OpenMcpClient({ url: "https://catalog.example", transport, token: "adm", fetch: fetcher });
    const relay = await client.register("https://board.example");
    assert.equal(relay.id, "board.example");
    assert.equal((await client.relays({ q: "board" })).length, 1);
    assert.equal((await client.relay("board.example")).tools.length, 2);
    assert.equal((await client.findTool("update"))[0]?.name, "post_update");
    const outcome = await client.call("board.example", "search", { q: "go" });
    assert.equal(outcome.ok, true);
    const direct = await client.connect("board.example");
    assert.deepEqual(await direct.call("search", { q: "direct" }), { jobs: ["a", "b"], q: "direct" });
    const sub = await client.subscribe({ url: "https://hooks.example/in", events: ["relay.updated"] });
    assert.ok(sub.secret.length >= 32);
    await client.unsubscribe(sub.webhook.id);
    await client.remove("board.example");
    assert.equal((await client.relays()).length, 0);
  }
  store.close();
});

test("refreshAll notices a relay going down and back up; a peer's relays are learned but probed here", async () => {
  const store = new Catalog();
  let down = false;
  const relayApp = new Hono();
  relayApp.all("*", (c) => (down ? c.text("down", 503) : fakeRelay().fetch(c.req.raw)));
  const options = { store, url: "https://catalog.example", fetch: router({ "board.example": relayApp }) };
  const app = createApp(options);
  await app.request("https://catalog.example/v1/relays", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://board.example" }) });

  down = true;
  assert.deepEqual(await refreshAll(options), { probed: 1, changed: 1 });
  assert.equal(store.getRelay("board.example")?.online, false);
  down = false;
  assert.deepEqual(await refreshAll(options), { probed: 1, changed: 1 });
  assert.equal(store.getRelay("board.example")?.online, true);
  assert.deepEqual(await refreshAll(options), { probed: 1, changed: 0 });

  // A second catalog that lists the first as a peer.
  const other = new Catalog();
  const otherOptions = { store: other, url: "https://other.example", fetch: router({ "catalog.example": app, "board.example": relayApp }) };
  other.addPeer("https://catalog.example");
  assert.deepEqual(await syncPeers(otherOptions), { peers: 1, learned: 1 });
  assert.equal(other.getRelay("board.example")?.via, "https://catalog.example");
  assert.equal(other.getRelay("board.example")?.online, true);
  store.close();
  other.close();
});

test("a signature is over the raw body", () => {
  const body = JSON.stringify({ a: 1 });
  assert.equal(sign("s", body), `sha256=${sign("s", body).slice(7)}`);
  assert.equal(verifySignature("s", sign("s", body), body), true);
  assert.equal(verifySignature("s", sign("s", body), `${body} `), false);
});
