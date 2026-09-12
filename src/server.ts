/**
 * The reference catalog server.
 *
 * Three doors to the same catalog: REST under /v1, MCP at /mcp, and webhooks
 * out. Plus the two things every OpenMCP host serves: /.well-known/openmcp.json,
 * because a catalog is a relay too, and /healthz.
 *
 * Registration is open: anyone can add a relay by URL, and what gets listed is
 * what the probe found, never what the registrant typed. Removing a relay or
 * changing peers needs the admin token. A webhook subscription is managed by
 * its own id, which is unguessable and shown once.
 */
import { Hono } from "hono";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { Catalog } from "./db.ts";
import { probeRelay } from "./probe.ts";
import { deliver } from "./webhooks.ts";
import { McpClient, McpToolError, type Fetcher } from "./mcp/client.ts";
import { TOOLS, callTool } from "./mcp/tools.ts";
import { PROTOCOL_VERSION, failure, isNotification, isRequest, result, INVALID_PARAMS, METHOD_NOT_FOUND, PARSE_ERROR, INTERNAL_ERROR } from "./mcp/protocol.ts";
import { CATALOG_EVENTS, OPENMCP_VERSION, relayId, type CatalogDescriptor, type CatalogEvent } from "./spec.ts";

export const VERSION = "0.1.1";

export interface ServerOptions {
  store: Catalog;
  /** The catalog's public origin, no trailing slash. */
  url: string;
  name?: string;
  description?: string;
  /** Bearer token for removing relays and managing peers. Absent means those routes are off. */
  adminToken?: string;
  operator?: string;
  fetch?: Fetcher;
  log?: (line: string) => void;
}

const sameToken = (a: string, b: string): boolean => {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
};

export function createApp(options: ServerOptions): Hono {
  const { store } = options;
  const url = options.url.replace(/\/+$/, "");
  const log = options.log ?? (() => {});
  const app = new Hono();
  const ctx = { store, catalogUrl: url, fetch: options.fetch, log };

  const bearer = (header: string | undefined): string => (header?.startsWith("Bearer ") ? header.slice(7) : "");
  const isAdmin = (header: string | undefined): boolean => Boolean(options.adminToken) && sameToken(bearer(header), options.adminToken as string);

  const descriptor = (): CatalogDescriptor => {
    const counts = store.counts();
    return {
      openmcp: OPENMCP_VERSION,
      mcp: `${url}/mcp`,
      name: options.name ?? "OpenMCP catalog",
      description: options.description ?? "A catalog of MCP relays. List them, find a tool, call it through here.",
      url,
      auth: { kind: "none" },
      tags: ["catalog", "openmcp"],
      ...(options.operator ? { operator: options.operator } : {}),
      webhooks: `${url}/v1/webhooks`,
      tools: TOOLS.map((tool) => tool.name),
      catalog: { relays: counts.relays, online: counts.online, api: `${url}/v1`, peers: store.listPeers().map((peer) => peer.url) },
    };
  };

  app.get("/", (c) =>
    c.json({
      name: options.name ?? "OpenMCP catalog",
      version: VERSION,
      openmcp: OPENMCP_VERSION,
      spec: "https://logicsrc.com/openmcp",
      descriptor: `${url}/.well-known/openmcp.json`,
      endpoints: [
        "GET  /v1/relays?q=&tag=&online=1",
        "POST /v1/relays {url}",
        "GET  /v1/relays/:id",
        "POST /v1/relays/:id/refresh",
        "DELETE /v1/relays/:id (admin)",
        "GET  /v1/relays/:id/tools",
        "POST /v1/relays/:id/call {tool, arguments, token?}",
        "GET  /v1/tools?q=",
        "POST /v1/webhooks {url, events?, relays?, secret?}",
        "GET  /v1/webhooks/:id",
        "DELETE /v1/webhooks/:id",
        "GET  /v1/peers",
        "POST /v1/peers {url} (admin)",
        "DELETE /v1/peers?url= (admin)",
        "POST /v1/peers/sync (admin)",
        "POST /mcp",
      ],
      mcp: { endpoint: `${url}/mcp`, transport: "streamable-http", tools: TOOLS.length },
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION, ...store.counts() }));
  app.get("/.well-known/openmcp.json", (c) => c.json(descriptor()));

  // --- relays ------------------------------------------------------------------

  app.get("/v1/relays", (c) => {
    const relays = store.listRelays({
      q: c.req.query("q") || undefined,
      tag: c.req.query("tag") || undefined,
      online: c.req.query("online") === "1" || c.req.query("online") === "true",
      limit: Number(c.req.query("limit") ?? 100),
    });
    return c.json({ ok: true, relays, total: relays.length });
  });

  app.post("/v1/relays", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string };
    const given = typeof body.url === "string" ? body.url.trim() : "";
    if (!/^https?:\/\//i.test(given)) return c.json({ ok: false, error: "Send {url}: the relay's /.well-known/openmcp.json, its MCP endpoint, or its site." }, 400);
    let previous = null;
    try {
      previous = store.getRelay(relayId(given));
    } catch {
      return c.json({ ok: false, error: "That is not a URL." }, 400);
    }
    const record = await probeRelay(given, { fetch: options.fetch, previous });
    if (!record.online && !record.verified) {
      return c.json({ ok: false, error: `Nothing at ${given} answered as a relay: ${record.lastError ?? "no descriptor and no MCP handshake"}.` }, 422);
    }
    const change = store.putRelay(record);
    if (change.event) void deliver(store, change.event, record, { catalog: url, fetch: options.fetch, log });
    log(`${change.previous ? "updated" : "registered"} ${record.id} (${record.online ? "online" : "offline"}, ${record.tools.length} tools)`);
    return c.json({ ok: true, relay: record, event: change.event }, change.previous ? 200 : 201);
  });

  app.get("/v1/relays/:id", (c) => {
    const relay = store.getRelay(c.req.param("id"));
    return relay ? c.json({ ok: true, relay }) : c.json({ ok: false, error: "No such relay." }, 404);
  });

  app.get("/v1/relays/:id/tools", (c) => {
    const relay = store.getRelay(c.req.param("id"));
    return relay ? c.json({ ok: true, relay: relay.id, online: relay.online, tools: relay.tools }) : c.json({ ok: false, error: "No such relay." }, 404);
  });

  app.post("/v1/relays/:id/refresh", async (c) => {
    const previous = store.getRelay(c.req.param("id"));
    if (!previous) return c.json({ ok: false, error: "No such relay." }, 404);
    const record = await probeRelay(previous.source, { fetch: options.fetch, previous });
    const change = store.putRelay(record);
    if (change.event) void deliver(store, change.event, record, { catalog: url, fetch: options.fetch, log });
    return c.json({ ok: true, relay: record, event: change.event });
  });

  app.delete("/v1/relays/:id", (c) => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ ok: false, error: "Removing a relay needs the admin token." }, 401);
    const id = c.req.param("id");
    if (!store.removeRelay(id)) return c.json({ ok: false, error: "No such relay." }, 404);
    void deliver(store, "relay.removed", { id }, { catalog: url, fetch: options.fetch, log });
    return c.json({ ok: true, removed: id });
  });

  /** Forward one tool call to a relay. The caller's relay credential rides in the body or a header and is not kept. */
  app.post("/v1/relays/:id/call", async (c) => {
    const relay = store.getRelay(c.req.param("id"));
    if (!relay) return c.json({ ok: false, error: "No such relay." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { tool?: string; arguments?: Record<string, unknown>; token?: string };
    if (!body.tool) return c.json({ ok: false, error: "Send {tool, arguments}." }, 400);
    const token = body.token ?? bearer(c.req.header("x-relay-authorization"));
    const client = new McpClient({ url: relay.descriptor.mcp, token: token || undefined, fetch: options.fetch, clientName: "openmcp-catalog" });
    try {
      const raw = await client.callRaw(body.tool, body.arguments ?? {});
      return c.json({ ok: !raw.isError, relay: relay.id, tool: body.tool, result: raw });
    } catch (error) {
      if (error instanceof McpToolError) return c.json({ ok: false, relay: relay.id, tool: body.tool, error: error.message }, 422);
      return c.json({ ok: false, relay: relay.id, tool: body.tool, error: (error as Error).message }, 502);
    }
  });

  app.get("/v1/tools", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json({ ok: true, tools: store.findTools(q, Number(c.req.query("limit") ?? 50)) });
  });

  // --- webhooks ------------------------------------------------------------------

  app.post("/v1/webhooks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; events?: unknown; relays?: unknown; secret?: string };
    const target = typeof body.url === "string" ? body.url.trim() : "";
    if (!/^https:\/\//i.test(target) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(target)) return c.json({ ok: false, error: "The webhook URL must be https." }, 400);
    const events = Array.isArray(body.events) ? body.events.filter((e): e is CatalogEvent => CATALOG_EVENTS.includes(e as CatalogEvent)) : [];
    const relays = Array.isArray(body.relays) ? body.relays.filter((r): r is string => typeof r === "string") : [];
    const secret = typeof body.secret === "string" && body.secret.trim() ? body.secret.trim() : randomBytes(24).toString("hex");
    const hook = store.addWebhook({ id: randomUUID(), url: target, secret, events: events.length ? events : CATALOG_EVENTS, relays });
    return c.json({ ok: true, webhook: hook, secret, note: "Keep the id and the secret. Neither is shown again." }, 201);
  });

  app.get("/v1/webhooks/:id", (c) => {
    const hook = store.listWebhooks().find((row) => row.id === c.req.param("id"));
    if (!hook) return c.json({ ok: false, error: "No such subscription." }, 404);
    const { secret: _secret, ...rest } = hook;
    return c.json({ ok: true, webhook: rest, deliveries: store.listDeliveries(hook.id) });
  });

  app.delete("/v1/webhooks/:id", (c) => (store.removeWebhook(c.req.param("id")) ? c.json({ ok: true }) : c.json({ ok: false, error: "No such subscription." }, 404)));

  // --- peers ------------------------------------------------------------------

  app.get("/v1/peers", (c) => c.json({ ok: true, peers: store.listPeers() }));

  app.post("/v1/peers", async (c) => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ ok: false, error: "Adding a peer needs the admin token." }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { url?: string };
    const peer = typeof body.url === "string" ? body.url.trim().replace(/\/+$/, "") : "";
    if (!/^https?:\/\//i.test(peer)) return c.json({ ok: false, error: "Send {url}." }, 400);
    return c.json({ ok: true, added: store.addPeer(peer), peers: store.listPeers() }, 201);
  });

  app.delete("/v1/peers", (c) => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ ok: false, error: "Removing a peer needs the admin token." }, 401);
    const peer = (c.req.query("url") ?? "").replace(/\/+$/, "");
    return c.json({ ok: store.removePeer(peer) });
  });

  app.post("/v1/peers/sync", async (c) => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ ok: false, error: "Syncing needs the admin token." }, 401);
    return c.json({ ok: true, ...(await syncPeers(options)) });
  });

  // --- MCP ------------------------------------------------------------------

  app.get("/mcp", (c) => c.json({ ok: false, note: "POST JSON-RPC 2.0 here. No credential needed; the catalog is public.", tools: TOOLS.map((tool) => tool.name) }, 405));

  app.post("/mcp", async (c) => {
    let message: unknown;
    try {
      message = await c.req.json();
    } catch {
      return c.json(failure(null, PARSE_ERROR, "Parse error"), 400);
    }
    if (!isRequest(message)) return c.json(failure(null, -32600, "Invalid request"), 400);
    if (isNotification(message)) return c.body(null, 202);
    const id = message.id ?? null;
    switch (message.method) {
      case "initialize":
        return c.json(
          result(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name ?? "openmcp-catalog", version: VERSION },
            instructions: `An OpenMCP catalog of ${store.counts().relays} relays. list_relays to see them, find_tool to search their tools, call_tool to use one through here.`,
          }),
        );
      case "ping":
        return c.json(result(id, {}));
      case "tools/list":
        return c.json(result(id, { tools: TOOLS }));
      case "tools/call": {
        const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!params.name) return c.json(failure(id, INVALID_PARAMS, "tools/call needs a name."));
        try {
          return c.json(result(id, await callTool(params.name, params.arguments ?? {}, ctx)));
        } catch (error) {
          return c.json(failure(id, INTERNAL_ERROR, (error as Error).message));
        }
      }
      default:
        return c.json(failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`));
    }
  });

  app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));
  return app;
}

/** Probe every relay again. What the daemon does on its schedule. */
export async function refreshAll(options: ServerOptions): Promise<{ probed: number; changed: number }> {
  const { store } = options;
  const url = options.url.replace(/\/+$/, "");
  let changed = 0;
  const relays = store.listRelays({ limit: 500 });
  for (const previous of relays) {
    const record = await probeRelay(previous.source, { fetch: options.fetch, previous });
    const change = store.putRelay(record);
    if (change.event) {
      changed++;
      await deliver(store, change.event, record, { catalog: url, fetch: options.fetch, log: options.log });
    }
  }
  return { probed: relays.length, changed };
}

/** Learn relays from peer catalogs. A relay learned this way is still probed here before it is listed. */
export async function syncPeers(options: ServerOptions): Promise<{ peers: number; learned: number }> {
  const { store } = options;
  const fetcher = options.fetch ?? fetch;
  let learned = 0;
  const peers = store.listPeers();
  for (const peer of peers) {
    try {
      const response = await fetcher(`${peer.url}/v1/relays?online=1&limit=500`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      const body = (await response.json()) as { relays?: Array<{ source?: string; descriptor?: { mcp?: string } }> };
      for (const remote of body.relays ?? []) {
        const source = remote.source ?? remote.descriptor?.mcp;
        if (!source) continue;
        let previous = null;
        try {
          previous = store.getRelay(relayId(remote.descriptor?.mcp ?? source));
        } catch {
          continue;
        }
        if (previous && !previous.via) continue; // registered here directly; the peer does not get to change it
        const record = await probeRelay(source, { fetch: options.fetch, previous, via: peer.url });
        if (!record.online && !record.verified) continue;
        const change = store.putRelay(record);
        if (change.event) {
          learned++;
          await deliver(store, change.event, record, { catalog: options.url, fetch: options.fetch, log: options.log });
        }
      }
      store.markPeer(peer.url, null);
    } catch (error) {
      store.markPeer(peer.url, (error as Error).message);
    }
  }
  return { peers: peers.length, learned };
}

export interface ServeOptions extends ServerOptions {
  port: number;
  /** Re-probe every relay this often. 0 turns the job off. */
  refreshEveryMs?: number;
  syncEveryMs?: number;
}

/** Start listening, with the refresh and sync jobs on their timers. Returns a stop function. */
export function serve(options: ServeOptions): { app: Hono; stop: () => void } {
  const app = createApp(options);
  const server = Bun_or_node_serve(app, options.port);
  const timers: NodeJS.Timeout[] = [];
  if (options.refreshEveryMs) timers.push(setInterval(() => void refreshAll(options).then((r) => options.log?.(`refresh: ${r.probed} probed, ${r.changed} changed`)), options.refreshEveryMs));
  if (options.syncEveryMs) timers.push(setInterval(() => void syncPeers(options).then((r) => options.log?.(`sync: ${r.peers} peers, ${r.learned} learned`)), options.syncEveryMs));
  return {
    app,
    stop: () => {
      for (const timer of timers) clearInterval(timer);
      server.close();
    },
  };
}

import { serve as nodeServe } from "@hono/node-server";
function Bun_or_node_serve(app: Hono, port: number): { close(): void } {
  const server = nodeServe({ fetch: app.fetch, port });
  return { close: () => server.close() };
}
