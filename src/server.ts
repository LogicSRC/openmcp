/**
 * The reference catalog server.
 *
 * Three doors to the same catalog: REST under /v1, MCP at /mcp, and webhooks
 * out. Plus the two things every OpenMCP host serves: /.well-known/openmcp.json,
 * because a catalog is a relay too, and /healthz. And a fourth door for
 * people: the same records as HTML, with a sign-in by emailed link for
 * anyone who wants to register relays of their own and manage them.
 *
 * Registration is open: anyone can add a relay by URL, and what gets listed is
 * what the probe found, never what the registrant typed. A relay registered
 * while signed in belongs to that person, who can probe it again or remove
 * it. Removing anyone's relay or changing peers needs the admin token. A
 * webhook subscription is managed by its own id, which is unguessable and
 * shown once.
 *
 * A catalog can also host relays itself: a hosted relay is a small MCP
 * server that lives inside this process, served at its own subdomain (so it
 * can be verified like any other relay) and, as a fallback, under /hosted.
 */
import { Hono } from "hono";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Catalog } from "./db.ts";
import { probeRelay } from "./probe.ts";
import { deliver } from "./webhooks.ts";
import { McpClient, McpToolError, type Fetcher } from "./mcp/client.ts";
import { TOOLS, callTool } from "./mcp/tools.ts";
import { PROTOCOL_VERSION, failure, isNotification, isRequest, result, INVALID_PARAMS, METHOD_NOT_FOUND, PARSE_ERROR, INTERNAL_ERROR } from "./mcp/protocol.ts";
import { CATALOG_EVENTS, OPENMCP_VERSION, relayId, type CatalogDescriptor, type CatalogEvent } from "./spec.ts";
import { createMailer, type Mailer } from "./mail.ts";
import { clearedSessionCookie, consumeSignInLink, cookieValue, endSession, requestSignInLink, sessionCookie, userForSession, SESSION_COOKIE, type AuthContext, type SessionUser } from "./auth.ts";
import { directoryPage, linkFailedPage, linkSentPage, mePage, bulkPage, relayPage, signInPage, tagsPage, type PageContext } from "./pages.ts";

export const VERSION = "0.4.0";

/**
 * The installer, served from the package itself so the line on every page,
 * `curl -fsSL <catalog>/install.sh | sh`, installs exactly the release the
 * catalog runs. Read once; it lives at the package root next to bin/ and
 * dist/, which is one directory up from src/ and from dist/ alike.
 */
const INSTALL_SCRIPT = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

/** An MCP relay that lives inside the catalog process. */
export interface HostedRelay {
  /** The subdomain label and the path segment under /hosted. */
  slug: string;
  /** The relay as a Hono app rooted at `base`: it serves /.well-known/openmcp.json and /mcp. */
  app(base: string, catalogUrl: string): Hono;
}

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
  /** Sends the sign-in links. Absent means one is made from RESEND_API_KEY and MAIL_FROM. */
  mailer?: Mailer;
  /** Relays served by this process, each at <slug>.<catalog host> and /hosted/<slug>. */
  hosted?: HostedRelay[];
  now?: () => Date;
}

const sameToken = (a: string, b: string): boolean => {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
};

/**
 * Where a hosted relay is reachable on its own: a subdomain of the catalog.
 * Null when the catalog has no name to put a subdomain under (an IP address,
 * localhost), in which case the relay is served under /hosted only and is
 * not listed, because a relay's descriptor must come from its own origin.
 */
export function hostedOrigin(catalogUrl: string, slug: string): string | null {
  const base = new URL(catalogUrl);
  if (base.hostname === "localhost" || /^[\d.]+$/.test(base.hostname) || base.hostname.startsWith("[")) return null;
  try {
    return new URL(`${base.protocol}//${slug}.${base.host}`).origin;
  } catch {
    return null;
  }
}

export function createApp(options: ServerOptions): Hono {
  const { store } = options;
  const url = options.url.replace(/\/+$/, "");
  const log = options.log ?? (() => {});
  const secure = url.startsWith("https://");
  const siteName = options.name ?? "OpenMCP catalog";
  const mailer = options.mailer ?? createMailer({ resendKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM, log });
  const auth: AuthContext = { store, mailer, url, name: siteName, log, now: options.now };
  const app = new Hono();
  const ctx = { store, catalogUrl: url, fetch: options.fetch, log };

  const bearer = (header: string | undefined): string => (header?.startsWith("Bearer ") ? header.slice(7) : "");
  const isAdmin = (header: string | undefined): boolean => Boolean(options.adminToken) && sameToken(bearer(header), options.adminToken as string);
  const who = (c: { req: { header(name: string): string | undefined } }): SessionUser | null => userForSession(auth, cookieValue(c.req.header("cookie"), SESSION_COOKIE));
  const page = (c: { req: { header(name: string): string | undefined } }): PageContext => ({ siteName, url, user: who(c), counts: store.counts() });
  const wantsHtml = (c: { req: { header(name: string): string | undefined } }): boolean => {
    const accept = c.req.header("accept") ?? "";
    return accept.includes("text/html") && !accept.includes("application/json");
  };
  /** A form post is only honoured from this site: the cookie is SameSite=Lax and the browser says where the request came from. */
  const sameSite = (c: { req: { header(name: string): string | undefined } }): boolean => {
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = c.req.header("origin");
    if (origin && origin !== url && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) return false;
    return true;
  };

  const descriptor = (): CatalogDescriptor => {
    const counts = store.counts();
    return {
      openmcp: OPENMCP_VERSION,
      mcp: `${url}/mcp`,
      name: siteName,
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

  // --- hosted relays ------------------------------------------------------------------
  // Each one answers at its own subdomain, so a probe finds the descriptor on
  // the relay's own origin and the record is verified; and under /hosted/<slug>
  // on the catalog's origin, for a reader without the DNS.
  const byHost = new Map<string, Hono>();
  for (const hosted of options.hosted ?? []) {
    const origin = hostedOrigin(url, hosted.slug);
    if (origin) byHost.set(new URL(origin).host.toLowerCase(), hosted.app(origin, url));
    app.route(`/hosted/${hosted.slug}`, hosted.app(`${url}/hosted/${hosted.slug}`, url));
  }
  if (byHost.size) {
    app.use("*", async (c, next) => {
      const host = (c.req.header("host") ?? "").toLowerCase();
      const hit = byHost.get(host);
      if (hit) return hit.fetch(c.req.raw);
      await next();
    });
  }

  app.get("/", (c) => {
    if (wantsHtml(c)) {
      const q = c.req.query("q") || undefined;
      const tag = c.req.query("tag") || undefined;
      return c.html(directoryPage(page(c), { relays: store.listRelays({ q, tag, limit: 200 }), q, tag, tags: store.tags() }));
    }
    return c.json({
      name: siteName,
      version: VERSION,
      openmcp: OPENMCP_VERSION,
      spec: "https://logicsrc.com/openmcp",
      descriptor: `${url}/.well-known/openmcp.json`,
      directory: `${url}/relays`,
      endpoints: [
        "GET  /v1/relays?q=&tag=&online=1",
        "POST /v1/relays {url}",
        "GET  /v1/relays/:id",
        "POST /v1/relays/:id/refresh",
        "DELETE /v1/relays/:id (owner or admin)",
        "GET  /v1/relays/:id/tools",
        "POST /v1/relays/:id/call {tool, arguments, token?}",
        "GET  /v1/tools?q=",
        "POST /v1/auth/magic {email}",
        "GET  /v1/me (session cookie)",
        "POST /v1/webhooks {url, events?, relays?, secret?}",
        "GET  /v1/webhooks/:id",
        "DELETE /v1/webhooks/:id",
        "GET  /v1/peers",
        "POST /v1/peers {url} (admin)",
        "DELETE /v1/peers?url= (admin)",
        "POST /v1/peers/sync (admin)",
        "POST /mcp",
      ],
      hosted: (options.hosted ?? []).map((hosted) => hostedOrigin(url, hosted.slug) ?? `${url}/hosted/${hosted.slug}`),
      mcp: { endpoint: `${url}/mcp`, transport: "streamable-http", tools: TOOLS.length },
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION, ...store.counts() }));
  // `curl -fsSL <catalog>/install.sh | sh`. The script defaults OPENMCP_SITE to
  // the public catalog; served from here it names this catalog instead, so
  // `openmcp update` comes back to the same place.
  app.get("/install.sh", (c) =>
    c.body(INSTALL_SCRIPT.replace('SITE="${OPENMCP_SITE:-https://openmcp.logicsrc.com}"', `SITE="\${OPENMCP_SITE:-${url}}"`), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=300",
    }),
  );
  app.get("/.well-known/openmcp.json", (c) => c.json(descriptor()));

  // --- pages ------------------------------------------------------------------

  app.get("/relays", (c) => {
    const q = c.req.query("q") || undefined;
    const tag = c.req.query("tag") || undefined;
    return c.html(directoryPage(page(c), { relays: store.listRelays({ q, tag, limit: 200 }), q, tag, tags: store.tags() }));
  });
  app.get("/tags", (c) => c.html(tagsPage(page(c), store.tags())));
  app.get("/relays/:id", (c) => {
    const relay = store.getRelay(c.req.param("id"));
    const p = page(c);
    if (!relay) return c.html(directoryPage(p, { relays: [], tags: store.tags() }), 404);
    const mine = Boolean(p.user && store.relayOwner(relay.id) === p.user.id);
    return c.html(relayPage(p, relay, mine));
  });

  for (const mode of ["sign-in", "sign-up"] as const) {
    app.get(`/${mode}`, (c) => (who(c) ? c.redirect("/me") : c.html(signInPage(page(c), mode))));
    app.post(`/${mode}`, async (c) => {
      if (!sameSite(c)) return c.text("Forbidden", 403);
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const outcome = await requestSignInLink(auth, form.email);
      if (!outcome.ok && outcome.error === "invalid-email") return c.html(signInPage(page(c), mode, "That does not look like an email address."), 400);
      if (!outcome.ok) return c.html(signInPage(page(c), mode, "Mail is not working right now. Try again in a while."), 503);
      return c.html(linkSentPage(page(c)));
    });
  }

  app.get("/auth/magic", (c) => {
    const outcome = consumeSignInLink(auth, c.req.query("t"));
    if (!outcome.ok) return c.html(linkFailedPage(page(c)), 400);
    c.header("set-cookie", sessionCookie(outcome.session, secure));
    log(`${outcome.created ? "new account" : "signed in"}: ${outcome.email}`);
    return c.redirect("/me");
  });

  app.post("/auth/sign-out", (c) => {
    if (!sameSite(c)) return c.text("Forbidden", 403);
    endSession(auth, cookieValue(c.req.header("cookie"), SESSION_COOKIE));
    c.header("set-cookie", clearedSessionCookie(secure));
    return c.redirect("/");
  });

  app.get("/me", (c) => {
    const p = page(c);
    if (!p.user) return c.redirect("/sign-in");
    return c.html(mePage(p, store.listRelaysByOwner(p.user.id)));
  });

  app.post("/me/relays", async (c) => {
    const p = page(c);
    if (!p.user) return c.redirect("/sign-in");
    if (!sameSite(c)) return c.text("Forbidden", 403);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const outcome = await register(typeof form.url === "string" ? form.url : "", p.user);
    return c.html(mePage(p, store.listRelaysByOwner(p.user.id), { text: outcome.message, bad: !outcome.ok }), outcome.ok ? 200 : 422);
  });

  app.post("/me/relays/:id/refresh", async (c) => {
    const p = page(c);
    if (!p.user) return c.redirect("/sign-in");
    if (!sameSite(c)) return c.text("Forbidden", 403);
    const id = c.req.param("id");
    if (store.relayOwner(id) !== p.user.id) return c.html(mePage(p, store.listRelaysByOwner(p.user.id), { text: "That relay is not yours.", bad: true }), 403);
    const record = await refresh(id);
    return c.html(mePage(p, store.listRelaysByOwner(p.user.id), { text: record ? `Probed ${record.id}: ${record.online ? `online, ${record.tools.length} tools` : `offline (${record.lastError})`}.` : "No such relay.", bad: !record?.online }));
  });

  app.post("/me/relays/:id/remove", (c) => {
    const p = page(c);
    if (!p.user) return c.redirect("/sign-in");
    if (!sameSite(c)) return c.text("Forbidden", 403);
    const id = c.req.param("id");
    if (store.relayOwner(id) !== p.user.id) return c.html(mePage(p, store.listRelaysByOwner(p.user.id), { text: "That relay is not yours.", bad: true }), 403);
    remove(id);
    return c.html(mePage(p, store.listRelaysByOwner(p.user.id), { text: `Removed ${id}.` }));
  });

  // --- the operations the doors share ------------------------------------------------------------------

  /** Probe and list. A signed-in registrant owns the record unless somebody else already does. */
  async function register(given: string, user: SessionUser | null): Promise<{ ok: boolean; status: number; message: string; record?: import("./spec.ts").RelayRecord; event?: CatalogEvent | null; created?: boolean }> {
    if (!/^https?:\/\//i.test(given.trim())) return { ok: false, status: 400, message: "Send {url}: the relay's /.well-known/openmcp.json, its MCP endpoint, or its site." };
    let previous = null;
    try {
      previous = store.getRelay(relayId(given.trim()));
    } catch {
      return { ok: false, status: 400, message: "That is not a URL." };
    }
    const record = await probeRelay(given.trim(), { fetch: options.fetch, previous });
    if (!record.online && !record.verified) {
      return { ok: false, status: 422, message: `Nothing at ${given.trim()} answered as a relay: ${record.lastError ?? "no descriptor and no MCP handshake"}.` };
    }
    const change = store.putRelay(record);
    if (user) {
      const owner = store.relayOwner(record.id);
      if (!owner) store.setRelayOwner(record.id, user.id);
    }
    if (change.event) void deliver(store, change.event, record, { catalog: url, fetch: options.fetch, log });
    log(`${change.previous ? "updated" : "registered"} ${record.id} (${record.online ? "online" : "offline"}, ${record.tools.length} tools)${user ? ` by ${user.email}` : ""}`);
    return {
      ok: true,
      status: change.previous ? 200 : 201,
      message: `${change.previous ? "Updated" : "Listed"} ${record.id}: ${record.online ? `online, ${record.tools.length} tools` : `offline (${record.lastError})`}${record.verified ? ", verified" : ", not verified: serve /.well-known/openmcp.json to be"}.`,
      record,
      event: change.event,
      created: !change.previous,
    };
  }

  async function refresh(id: string): Promise<import("./spec.ts").RelayRecord | null> {
    const previous = store.getRelay(id);
    if (!previous) return null;
    const record = await probeRelay(previous.source, { fetch: options.fetch, previous });
    const change = store.putRelay(record);
    if (change.event) void deliver(store, change.event, record, { catalog: url, fetch: options.fetch, log });
    return record;
  }

  function remove(id: string): boolean {
    if (!store.removeRelay(id)) return false;
    void deliver(store, "relay.removed", { id }, { catalog: url, fetch: options.fetch, log });
    return true;
  }

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

  /** Up to a thousand at once: {urls: [...]} or a text/plain list. Answers a job to poll; each URL is registered exactly as a single one would be. */
  const BULK_LIMIT = 1000;
  const BULK_CONCURRENCY = 16;
  const parseBulk = (text: string): { urls: string[]; rejected: string[] } => {
    const seen = new Set<string>();
    const urls: string[] = [];
    const rejected: string[] = [];
    for (const raw of text.split(/[\s,]+/)) {
      const line = raw.trim();
      if (!line) continue;
      const candidate = /^https?:\/\//i.test(line) ? line : `https://${line}`;
      try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (!host.includes(".") || seen.has(host)) continue;
        seen.add(host);
        urls.push(parsed.toString());
      } catch {
        rejected.push(line);
      }
      if (urls.length >= BULK_LIMIT) break;
    }
    return { urls, rejected };
  };
  const bulkRegister = (urls: string[], user: SessionUser | null): import("./db.ts").ProbeJob => {
    const job = store.createJob(`job_${randomBytes(8).toString("hex")}`, urls.length);
    const queue = [...urls];
    const worker = async (): Promise<void> => {
      for (;;) {
        const given = queue.shift();
        if (!given) return;
        let result: import("./db.ts").ProbeResult;
        try {
          const outcome = await register(given, user);
          result = outcome.ok && outcome.record ? { url: given, ok: true, id: outcome.record.id, online: outcome.record.online, verified: outcome.record.verified, name: outcome.record.descriptor.name, tools: outcome.record.tools.length } : { url: given, ok: false, error: outcome.message };
        } catch (error) {
          result = { url: given, ok: false, error: (error as Error).message };
        }
        job.results.push(result);
        job.done++;
        if (job.done === job.total) job.finishedAt = new Date().toISOString();
        store.updateJob(job);
      }
    };
    void Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, urls.length) }, worker)).then(() => log(`bulk ${job.id}: ${job.results.filter((r) => r.ok).length}/${job.total} listed`));
    return job;
  };

  app.post("/v1/relays/bulk", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let text = "";
    if (type.includes("application/json")) {
      const body = (await c.req.json().catch(() => ({}))) as { urls?: unknown; text?: unknown };
      text = Array.isArray(body.urls) ? body.urls.filter((u): u is string => typeof u === "string").join("\n") : typeof body.text === "string" ? body.text : "";
    } else text = await c.req.text();
    const parsed = parseBulk(text);
    if (!parsed.urls.length) return c.json({ ok: false, error: "Send {urls: [...]} or a text list, one relay URL or domain per line, up to 1000." }, 400);
    const job = bulkRegister(parsed.urls, who(c));
    return c.json({ ok: true, job, rejected: parsed.rejected, poll: `${url}/v1/relays/bulk/${job.id}`, page: `${url}/bulk/${job.id}` }, 202);
  });

  app.get("/v1/relays/bulk/:job", (c) => {
    const job = store.getJob(c.req.param("job"));
    return job ? c.json({ ok: true, job }) : c.json({ ok: false, error: "No such job." }, 404);
  });

  app.post("/me/relays/bulk", async (c) => {
    const p = page(c);
    if (!p.user) return c.redirect("/sign-in");
    if (!sameSite(c)) return c.text("Forbidden", 403);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const parsed = parseBulk(typeof form.urls === "string" ? form.urls : "");
    if (!parsed.urls.length) return c.html(mePage(p, store.listRelaysByOwner(p.user.id), { text: "Paste at least one relay URL or domain.", bad: true }), 422);
    const job = bulkRegister(parsed.urls, p.user);
    return c.redirect(`/bulk/${job.id}`);
  });

  app.get("/bulk/:job", (c) => {
    const job = store.getJob(c.req.param("job"));
    return job ? c.html(bulkPage(page(c), job)) : c.notFound();
  });

  app.post("/v1/relays", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string };
    const outcome = await register(typeof body.url === "string" ? body.url : "", who(c));
    if (!outcome.ok) return c.json({ ok: false, error: outcome.message }, outcome.status as 400 | 422);
    return c.json({ ok: true, relay: outcome.record, event: outcome.event }, outcome.status as 200 | 201);
  });

  app.get("/v1/relays/:id", (c) => {
    const relay = store.getRelay(c.req.param("id"));
    return relay ? c.json({ ok: true, relay, owned: store.relayOwner(relay.id) !== null }) : c.json({ ok: false, error: "No such relay." }, 404);
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
    const id = c.req.param("id");
    const user = who(c);
    const owner = store.relayOwner(id);
    const allowed = isAdmin(c.req.header("authorization")) || (user !== null && owner === user.id);
    if (!allowed) return c.json({ ok: false, error: "Removing a relay needs the admin token, or a session that registered it." }, 401);
    if (!remove(id)) return c.json({ ok: false, error: "No such relay." }, 404);
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

  // --- accounts ------------------------------------------------------------------

  app.post("/v1/auth/magic", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    const outcome = await requestSignInLink(auth, body.email);
    if (!outcome.ok && outcome.error === "invalid-email") return c.json({ ok: false, error: "Send {email}." }, 400);
    if (!outcome.ok) return c.json({ ok: false, error: "Mail is not configured on this catalog." }, 503);
    return c.json({ ok: true, note: "If that address can receive mail, a sign-in link is on its way. Opening it sets a session cookie." }, 202);
  });

  app.get("/v1/me", (c) => {
    const user = who(c);
    if (!user) return c.json({ ok: false, error: "Not signed in. POST /v1/auth/magic {email} and open the link." }, 401);
    return c.json({ ok: true, user, relays: store.listRelaysByOwner(user.id) });
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

  app.notFound((c) => (wantsHtml(c) ? c.html(directoryPage(page(c), { relays: [], tags: store.tags() }), 404) : c.json({ ok: false, error: "Not found" }, 404)));
  return app;
}

/** List the relays this process hosts, by probing them the way any relay is probed. Nothing is listed that did not answer. */
export async function ensureHosted(options: ServerOptions): Promise<{ listed: string[] }> {
  const { store } = options;
  const url = options.url.replace(/\/+$/, "");
  const listed: string[] = [];
  for (const hosted of options.hosted ?? []) {
    const origin = hostedOrigin(url, hosted.slug);
    if (!origin) {
      options.log?.(`hosted ${hosted.slug}: served under ${url}/hosted/${hosted.slug} only; a catalog at an IP or localhost has no subdomain to list it at`);
      continue;
    }
    let previous = null;
    try {
      previous = store.getRelay(relayId(`${origin}/mcp`));
    } catch {
      continue;
    }
    const record = await probeRelay(`${origin}/.well-known/openmcp.json`, { fetch: options.fetch, previous });
    if (!record.online && !record.verified) {
      options.log?.(`hosted ${hosted.slug}: not listed, ${record.lastError ?? "no answer"} at ${origin}`);
      continue;
    }
    const change = store.putRelay(record);
    if (change.event) await deliver(store, change.event, record, { catalog: url, fetch: options.fetch, log: options.log });
    listed.push(record.id);
  }
  return { listed };
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
  await ensureHosted(options);
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
  // The hosted relays list themselves once the listener is up; DNS may not be, so the refresh job tries again.
  if (options.hosted?.length) timers.push(setTimeout(() => void ensureHosted(options).then((r) => options.log?.(`hosted: listed ${r.listed.join(", ") || "none"}`)), 3_000));
  return {
    app,
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
      server.close();
    },
  };
}

import { serve as nodeServe } from "@hono/node-server";
function Bun_or_node_serve(app: Hono, port: number): { close(): void } {
  const server = nodeServe({ fetch: app.fetch, port });
  return { close: () => server.close() };
}
