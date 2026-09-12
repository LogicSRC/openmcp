/**
 * OpenMCP, the records.
 *
 * A relay is an MCP server somebody can reach over HTTP. A catalog is a
 * server that keeps relay records, checks they are what they say, and serves
 * them for discovery. Everything in this file is the shape of what crosses
 * the wire; the normative text is docs/openmcp.md.
 *
 * The one rule that shapes all of it: a relay describes itself, at its own
 * origin, and a catalog repeats what it found there. A catalog never holds a
 * relay's credentials and never speaks for a relay it could not reach.
 */

export const OPENMCP_VERSION = "0.1";

/** Where a relay describes itself. */
export const WELL_KNOWN_PATH = "/.well-known/openmcp.json";

export type AuthKind = "none" | "bearer" | "oauth" | "api-key";

/**
 * What a relay says about itself, served at /.well-known/openmcp.json on its
 * own origin. Everything optional degrades: a descriptor with `mcp` alone is
 * a valid descriptor.
 */
export interface RelayDescriptor {
  /** The spec version this descriptor follows. */
  openmcp: string;
  /** The MCP endpoint, absolute. Streamable HTTP. */
  mcp: string;
  /** One line, for a listing. */
  name?: string;
  description?: string;
  /** The product or site behind the relay. */
  url?: string;
  /** How a caller authenticates. `none` means the read tools need nothing. */
  auth?: {
    kind: AuthKind;
    /** Where a person gets a credential: a settings page, an OAuth authorization server. */
    url?: string;
    /** Which tools work with no credential at all, by name. */
    open?: string[];
  };
  /** Free-form, lowercase. How a catalog groups relays. */
  tags?: string[];
  /** The person or organisation answerable for the relay: an OpenProfile.md URL. */
  operator?: string;
  /** Where a caller can subscribe to this relay's own events, if it has any. */
  webhooks?: string;
  /** Tool names, so a catalog can index without a handshake. The handshake wins when both exist. */
  tools?: string[];
  /** Other catalogs this relay is listed in, so a reader can find more. */
  catalogs?: string[];
}

/** One tool, as tools/list reports it, kept whole so a caller can read the schema. */
export interface RelayTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A relay as a catalog holds it. */
export interface RelayRecord {
  /** The catalog's own id for the relay: a slug from its host. */
  id: string;
  /** The descriptor URL the record was built from, or the MCP URL when there was no descriptor. */
  source: string;
  descriptor: RelayDescriptor;
  /** What tools/list said, at the last successful probe. */
  tools: RelayTool[];
  /** What initialize said the server calls itself. */
  server?: { name?: string; version?: string; protocolVersion?: string };
  /** True when the descriptor came from the relay's own origin, not from whoever registered it. */
  verified: boolean;
  online: boolean;
  /** Last successful probe. */
  seenAt: string | null;
  firstSeenAt: string;
  /** Consecutive failed probes. Any success resets it. */
  failures: number;
  lastError: string | null;
  /** Another catalog this record was learned from, when it was not registered here. */
  via: string | null;
}

export type CatalogEvent = "relay.registered" | "relay.updated" | "relay.online" | "relay.offline" | "relay.removed";

export const CATALOG_EVENTS: CatalogEvent[] = ["relay.registered", "relay.updated", "relay.online", "relay.offline", "relay.removed"];

export interface WebhookSubscription {
  id: string;
  url: string;
  events: CatalogEvent[];
  /** Relays it cares about, by id; empty means all. */
  relays: string[];
  createdAt: string;
  /** Consecutive failed deliveries. */
  failures: number;
  active: boolean;
}

export interface WebhookDelivery {
  id: string;
  event: CatalogEvent;
  /** ISO time the event happened. */
  at: string;
  catalog: string;
  relay: RelayRecord | { id: string };
}

/** What a catalog says about itself at /.well-known/openmcp.json: it is a relay too. */
export interface CatalogDescriptor extends RelayDescriptor {
  catalog: {
    relays: number;
    online: number;
    /** REST base. */
    api: string;
    /** Catalogs this one syncs from. */
    peers: string[];
  };
}

/** A slug from a relay's host and path, stable across probes. */
export function relayId(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // The endpoint's own name is not identity: /mcp, /api/mcp and /v1/mcp all fall off the end.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(api\/|v1\/)?mcp$/, "");
  return `${host}${path}`
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** Read a descriptor out of whatever a relay served. Never throws; a bad one is null. */
export function parseDescriptor(value: unknown, base: string): RelayDescriptor | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const mcp = typeof record.mcp === "string" ? absolute(record.mcp, base) : null;
  if (!mcp) return null;
  const strings = (key: string): string[] | undefined =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 100) : undefined;
  const auth = typeof record.auth === "object" && record.auth !== null ? (record.auth as Record<string, unknown>) : null;
  const kind = auth && typeof auth.kind === "string" && ["none", "bearer", "oauth", "api-key"].includes(auth.kind) ? (auth.kind as AuthKind) : null;
  const site = typeof record.url === "string" ? absolute(record.url, base) : null;
  const tags = strings("tags");
  return {
    openmcp: typeof record.openmcp === "string" ? record.openmcp : OPENMCP_VERSION,
    mcp,
    ...(typeof record.name === "string" ? { name: record.name.slice(0, 120) } : {}),
    ...(typeof record.description === "string" ? { description: record.description.slice(0, 1000) } : {}),
    ...(site ? { url: site } : {}),
    ...(kind
      ? {
          auth: {
            kind,
            ...(typeof auth?.url === "string" ? { url: auth.url } : {}),
            ...(Array.isArray(auth?.open) ? { open: (auth.open as unknown[]).filter((item): item is string => typeof item === "string") } : {}),
          },
        }
      : {}),
    ...(tags ? { tags: tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean) } : {}),
    ...(typeof record.operator === "string" ? { operator: record.operator } : {}),
    ...(typeof record.webhooks === "string" ? { webhooks: record.webhooks } : {}),
    ...(strings("tools") ? { tools: strings("tools") } : {}),
    ...(strings("catalogs") ? { catalogs: strings("catalogs") } : {}),
  };
}

function absolute(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
