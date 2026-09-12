/**
 * The catalog's own tools, for an agent that speaks MCP and nothing else.
 *
 * Everything the REST API does, one tool each, and one more: call_tool,
 * which forwards a call to a relay so an agent that can reach the catalog
 * can reach every relay the catalog lists. The caller's own credential for
 * the relay travels in the arguments and is never stored.
 */
import type { Catalog } from "../db.ts";
import { McpClient, McpToolError, type Fetcher } from "./client.ts";
import { text, toolError, type ToolDefinition, type ToolResult } from "./protocol.ts";
import { probeRelay } from "../probe.ts";
import { deliver } from "../webhooks.ts";
import { CATALOG_EVENTS, type CatalogEvent } from "../spec.ts";
import { randomBytes, randomUUID } from "node:crypto";

export interface ToolContext {
  store: Catalog;
  catalogUrl: string;
  fetch?: Fetcher;
  log?: (line: string) => void;
}

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = (description: string): Record<string, unknown> => ({ type: "string", description });

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_relays",
    title: "List relays",
    description: "The relays this catalog knows: MCP servers reachable over HTTP, with what each offers. Filter by a word, a tag, or online only.",
    inputSchema: object({
      q: string("A word to match against names, descriptions, tags and tool names."),
      tag: string("Only relays carrying this tag."),
      online: { type: "boolean", description: "Only relays that answered the last probe." },
      limit: { type: "integer", description: "At most this many. Default 50." },
    }),
  },
  {
    name: "get_relay",
    title: "Get a relay",
    description: "One relay in full: its descriptor, its tools with their schemas, and whether it is online and verified.",
    inputSchema: object({ id: string("The relay id, from list_relays.") }, ["id"]),
  },
  {
    name: "find_tool",
    title: "Find a tool",
    description: "Search every online relay's tools by name or description. Answers with the relay each one lives on, for call_tool.",
    inputSchema: object({ q: string("What the tool should do, or part of its name."), limit: { type: "integer" } }, ["q"]),
  },
  {
    name: "call_tool",
    title: "Call a relay's tool",
    description:
      "Call a tool on a relay through this catalog. The relay's answer comes back as-is. If the relay needs a credential, pass it as token; it is sent to the relay and never kept.",
    inputSchema: object(
      {
        relay: string("The relay id, from list_relays or find_tool."),
        tool: string("The tool name on that relay."),
        arguments: { type: "object", description: "The tool's arguments, as its schema says.", additionalProperties: true },
        token: string("A bearer token for the relay, when its auth is not none."),
      },
      ["relay", "tool"],
    ),
  },
  {
    name: "register_relay",
    title: "Register a relay",
    description:
      "Add an MCP server to the catalog by URL: its /.well-known/openmcp.json, its MCP endpoint, or its site. The catalog probes it and lists what it found; nothing is taken on trust.",
    inputSchema: object({ url: string("Any URL on the relay's origin.") }, ["url"]),
  },
  {
    name: "refresh_relay",
    title: "Refresh a relay",
    description: "Probe a relay again now and update its record.",
    inputSchema: object({ id: string("The relay id.") }, ["id"]),
  },
  {
    name: "subscribe",
    title: "Subscribe to catalog events",
    description:
      "Get a POST when relays change: relay.registered, relay.updated, relay.online, relay.offline, relay.removed. Deliveries are signed with the secret (X-OpenMCP-Signature: sha256=hmac of the body). The id that comes back is the only way to manage the subscription; keep it.",
    inputSchema: object(
      {
        url: string("Where to POST. HTTPS."),
        events: { type: "array", items: { type: "string" }, description: `Which events. Default all of: ${CATALOG_EVENTS.join(", ")}.` },
        relays: { type: "array", items: { type: "string" }, description: "Only these relay ids. Default all." },
        secret: string("Your signing secret. One is made for you when absent, and shown once."),
      },
      ["url"],
    ),
  },
  {
    name: "unsubscribe",
    title: "Unsubscribe",
    description: "Remove a webhook subscription by id.",
    inputSchema: object({ id: string("The subscription id.") }, ["id"]),
  },
  {
    name: "list_peers",
    title: "List peer catalogs",
    description: "Other catalogs this one syncs relays from.",
    inputSchema: object({}),
  },
];

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { store } = ctx;
  switch (name) {
    case "list_relays": {
      const relays = store.listRelays({
        q: str(args.q) || undefined,
        tag: str(args.tag) || undefined,
        online: args.online === true,
        limit: typeof args.limit === "number" ? args.limit : 50,
      });
      const brief = relays.map((relay) => ({
        id: relay.id,
        name: relay.descriptor.name ?? relay.id,
        description: relay.descriptor.description,
        mcp: relay.descriptor.mcp,
        auth: relay.descriptor.auth?.kind ?? "unknown",
        tags: relay.descriptor.tags ?? [],
        tools: relay.tools.map((tool) => tool.name),
        online: relay.online,
        verified: relay.verified,
      }));
      return text(`${brief.length} relay${brief.length === 1 ? "" : "s"}.`, { relays: brief });
    }
    case "get_relay": {
      const relay = store.getRelay(str(args.id));
      if (!relay) return toolError(`No relay ${str(args.id)}. list_relays shows the ids.`);
      return text(`${relay.descriptor.name ?? relay.id}: ${relay.online ? "online" : "offline"}, ${relay.tools.length} tools.`, { relay });
    }
    case "find_tool": {
      const q = str(args.q);
      if (!q) return toolError("Say what the tool should do.");
      const found = store.findTools(q, typeof args.limit === "number" ? args.limit : 50);
      return text(found.length ? `${found.length} tool${found.length === 1 ? "" : "s"} match.` : "Nothing matches.", { tools: found });
    }
    case "call_tool": {
      const relay = store.getRelay(str(args.relay));
      if (!relay) return toolError(`No relay ${str(args.relay)}.`);
      const tool = str(args.tool);
      if (!tool) return toolError("Name the tool.");
      const client = new McpClient({ url: relay.descriptor.mcp, token: str(args.token) || undefined, fetch: ctx.fetch, clientName: "openmcp-catalog" });
      try {
        const raw = await client.callRaw(tool, (args.arguments as Record<string, unknown>) ?? {});
        // The relay's own result, untouched: content, isError, structuredContent.
        return raw;
      } catch (error) {
        if (error instanceof McpToolError) return toolError(error.message);
        return toolError(`${relay.id} could not be called: ${(error as Error).message}`);
      }
    }
    case "register_relay": {
      const url = str(args.url);
      if (!/^https?:\/\//i.test(url)) return toolError("Give a URL, https://...");
      const previous = safeId(url) ? store.getRelay(safeId(url) as string) : null;
      const record = await probeRelay(url, { fetch: ctx.fetch, previous: previous ?? store.getRelay(relayIdSafe(url)) });
      if (!record.online && !record.verified) return toolError(`${url} answered no descriptor and no MCP handshake: ${record.lastError ?? "unreachable"}.`);
      const change = store.putRelay(record);
      if (change.event) void deliver(store, change.event, record, { catalog: ctx.catalogUrl, fetch: ctx.fetch, log: ctx.log });
      return text(`${change.previous ? "Updated" : "Registered"} ${record.id}: ${record.online ? "online" : "offline"}, ${record.tools.length} tools${record.verified ? ", verified" : ", not verified (no /.well-known/openmcp.json)"}.`, { relay: record });
    }
    case "refresh_relay": {
      const previous = store.getRelay(str(args.id));
      if (!previous) return toolError(`No relay ${str(args.id)}.`);
      const record = await probeRelay(previous.source, { fetch: ctx.fetch, previous });
      const change = store.putRelay(record);
      if (change.event) void deliver(store, change.event, record, { catalog: ctx.catalogUrl, fetch: ctx.fetch, log: ctx.log });
      return text(`${record.id}: ${record.online ? "online" : `offline (${record.lastError})`}, ${record.tools.length} tools.`, { relay: record, changed: change.event });
    }
    case "subscribe": {
      const url = str(args.url);
      if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) return toolError("The webhook URL must be https.");
      const events = Array.isArray(args.events) ? (args.events as unknown[]).filter((e): e is CatalogEvent => CATALOG_EVENTS.includes(e as CatalogEvent)) : [];
      const relays = Array.isArray(args.relays) ? (args.relays as unknown[]).filter((r): r is string => typeof r === "string") : [];
      const secret = str(args.secret) || randomBytes(24).toString("hex");
      const hook = store.addWebhook({ id: randomUUID(), url, secret, events: events.length ? events : CATALOG_EVENTS, relays });
      return text(`Subscribed ${hook.id}. Keep the id and the secret; neither is shown again.`, { webhook: hook, secret });
    }
    case "unsubscribe": {
      return store.removeWebhook(str(args.id)) ? text(`Removed ${str(args.id)}.`, { removed: true }) : toolError(`No subscription ${str(args.id)}.`);
    }
    case "list_peers":
      return text(`${store.listPeers().length} peers.`, { peers: store.listPeers() });
    default:
      return toolError(`Unknown tool ${name}.`);
  }
}

import { relayId } from "../spec.ts";
function relayIdSafe(url: string): string {
  try {
    return relayId(url);
  } catch {
    return "";
  }
}
function safeId(url: string): string | null {
  const id = relayIdSafe(url);
  return id || null;
}
