/**
 * The client: one object, three ways in.
 *
 * REST is the default. MCP goes through the catalog's own endpoint, for a
 * process that already speaks MCP and nothing else; every method maps to a
 * catalog tool. Webhooks come out: `verifySignature` is what a receiver calls
 * with the header and the raw body. And `relay()` hands back a plain MCP
 * client for any relay in the catalog, so a caller can go direct once it
 * knows where.
 */
import { McpClient, type Fetcher } from "./mcp/client.ts";
import type { CatalogDescriptor, CatalogEvent, RelayRecord, RelayTool, WebhookSubscription } from "./spec.ts";
import type { ToolResult } from "./mcp/protocol.ts";
export { verifySignature, sign, SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER } from "./webhooks.ts";
export { McpClient, McpToolError } from "./mcp/client.ts";

export type Transport = "rest" | "mcp";

export interface ClientOptions {
  /** The catalog's origin. */
  url: string;
  transport?: Transport;
  /** The catalog's admin token, for remove and peers. */
  token?: string;
  fetch?: Fetcher;
  timeoutMs?: number;
}

export interface RelayQuery {
  q?: string;
  tag?: string;
  online?: boolean;
  limit?: number;
}

export interface CallOutcome {
  ok: boolean;
  relay: string;
  tool: string;
  result?: ToolResult;
  error?: string;
}

type Reply<T> = ({ ok: true } & T) | { ok: false; error?: string };

export class OpenMcpClient {
  readonly url: string;
  readonly transport: Transport;
  private readonly fetcher: Fetcher;
  private mcp?: McpClient;
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    this.url = options.url.replace(/\/+$/, "");
    this.transport = options.transport ?? "rest";
    this.fetcher = options.fetch ?? fetch;
  }

  private catalogMcp(): McpClient {
    this.mcp ??= new McpClient({ url: `${this.url}/mcp`, fetch: this.fetcher, clientName: "openmcp-client", timeoutMs: this.options.timeoutMs });
    return this.mcp;
  }

  private async rest<T>(method: string, path: string, body?: unknown, admin = false): Promise<T> {
    const response = await this.fetcher(`${this.url}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(admin && this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await response.json().catch(() => ({ ok: false, error: `${this.url}${path} answered ${response.status} with no JSON.` }))) as Reply<T>;
    if (!parsed.ok) throw new Error(parsed.error ?? `${method} ${path} failed (${response.status}).`);
    return parsed;
  }

  /** The catalog's own descriptor. */
  descriptor(): Promise<CatalogDescriptor> {
    return this.fetcher(`${this.url}/.well-known/openmcp.json`).then((response) => response.json() as Promise<CatalogDescriptor>);
  }

  async relays(query: RelayQuery = {}): Promise<RelayRecord[]> {
    if (this.transport === "mcp") {
      const reply = await this.catalogMcp().call<{ relays: RelayRecord[] }>("list_relays", { ...query });
      return reply.relays;
    }
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.tag) params.set("tag", query.tag);
    if (query.online) params.set("online", "1");
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.toString() ? `?${params}` : "";
    return (await this.rest<{ relays: RelayRecord[] }>("GET", `/v1/relays${suffix}`)).relays;
  }

  async relay(id: string): Promise<RelayRecord> {
    if (this.transport === "mcp") return (await this.catalogMcp().call<{ relay: RelayRecord }>("get_relay", { id })).relay;
    return (await this.rest<{ relay: RelayRecord }>("GET", `/v1/relays/${encodeURIComponent(id)}`)).relay;
  }

  /** Register many at once. Answers a job; poll bulkJob until finishedAt is set. */
  async registerMany(urls: string[]): Promise<{ job: { id: string; total: number; done: number; finishedAt: string | null; results: Array<{ url: string; ok: boolean; id?: string; online?: boolean; verified?: boolean; name?: string; tools?: number; error?: string }> }; rejected: string[]; page: string }> {
    const response = await this.fetcher(`${this.url}/v1/relays/bulk`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) }, body: JSON.stringify({ urls }) });
    const body = (await response.json()) as { ok: boolean; error?: string; job: never; rejected: string[]; page: string };
    if (!body.ok) throw new Error(body.error ?? `bulk answered ${response.status}`);
    return body;
  }
  async bulkJob(id: string): Promise<{ id: string; total: number; done: number; finishedAt: string | null; results: Array<{ url: string; ok: boolean; id?: string; online?: boolean; verified?: boolean; name?: string; tools?: number; error?: string }> }> {
    const response = await this.fetcher(`${this.url}/v1/relays/bulk/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
    const body = (await response.json()) as { ok: boolean; error?: string; job: never };
    if (!body.ok) throw new Error(body.error ?? `job answered ${response.status}`);
    return body.job;
  }

  async register(url: string): Promise<RelayRecord> {
    if (this.transport === "mcp") return (await this.catalogMcp().call<{ relay: RelayRecord }>("register_relay", { url })).relay;
    return (await this.rest<{ relay: RelayRecord }>("POST", "/v1/relays", { url })).relay;
  }

  async refresh(id: string): Promise<RelayRecord> {
    if (this.transport === "mcp") return (await this.catalogMcp().call<{ relay: RelayRecord }>("refresh_relay", { id })).relay;
    return (await this.rest<{ relay: RelayRecord }>("POST", `/v1/relays/${encodeURIComponent(id)}/refresh`)).relay;
  }

  /** Admin. */
  async remove(id: string): Promise<void> {
    await this.rest("DELETE", `/v1/relays/${encodeURIComponent(id)}`, undefined, true);
  }

  async tools(id: string): Promise<RelayTool[]> {
    if (this.transport === "mcp") return (await this.relay(id)).tools;
    return (await this.rest<{ tools: RelayTool[] }>("GET", `/v1/relays/${encodeURIComponent(id)}/tools`)).tools;
  }

  async findTool(q: string, limit = 50): Promise<Array<{ relay: string; name: string; description?: string }>> {
    if (this.transport === "mcp") return (await this.catalogMcp().call<{ tools: Array<{ relay: string; name: string; description?: string }> }>("find_tool", { q, limit })).tools;
    return (await this.rest<{ tools: Array<{ relay: string; name: string; description?: string }> }>("GET", `/v1/tools?q=${encodeURIComponent(q)}&limit=${limit}`)).tools;
  }

  /** Call a relay's tool through the catalog. `relayToken` is the caller's credential for that relay. */
  async call(id: string, tool: string, args: Record<string, unknown> = {}, relayToken?: string): Promise<CallOutcome> {
    if (this.transport === "mcp") {
      const raw = await this.catalogMcp().callRaw("call_tool", { relay: id, tool, arguments: args, ...(relayToken ? { token: relayToken } : {}) });
      return { ok: !raw.isError, relay: id, tool, result: raw, ...(raw.isError ? { error: raw.content.map((block) => block.text).join("\n") } : {}) };
    }
    const response = await this.fetcher(`${this.url}/v1/relays/${encodeURIComponent(id)}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ tool, arguments: args, ...(relayToken ? { token: relayToken } : {}) }),
    });
    return (await response.json()) as CallOutcome;
  }

  /** A plain MCP client for one relay, to go direct. */
  async connect(id: string, relayToken?: string): Promise<McpClient> {
    const record = await this.relay(id);
    return new McpClient({ url: record.descriptor.mcp, token: relayToken, fetch: this.fetcher, clientName: "openmcp-client", timeoutMs: this.options.timeoutMs });
  }

  async subscribe(input: { url: string; events?: CatalogEvent[]; relays?: string[]; secret?: string }): Promise<{ webhook: WebhookSubscription; secret: string }> {
    if (this.transport === "mcp") return this.catalogMcp().call<{ webhook: WebhookSubscription; secret: string }>("subscribe", { ...input });
    return this.rest<{ webhook: WebhookSubscription; secret: string }>("POST", "/v1/webhooks", input);
  }

  async webhook(id: string): Promise<{ webhook: WebhookSubscription; deliveries: unknown[] }> {
    return this.rest<{ webhook: WebhookSubscription; deliveries: unknown[] }>("GET", `/v1/webhooks/${encodeURIComponent(id)}`);
  }

  async unsubscribe(id: string): Promise<void> {
    if (this.transport === "mcp") {
      await this.catalogMcp().call("unsubscribe", { id });
      return;
    }
    await this.rest("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`);
  }

  async peers(): Promise<Array<{ url: string; syncedAt: string | null; lastError: string | null }>> {
    if (this.transport === "mcp") return (await this.catalogMcp().call<{ peers: Array<{ url: string; syncedAt: string | null; lastError: string | null }> }>("list_peers")).peers;
    return (await this.rest<{ peers: Array<{ url: string; syncedAt: string | null; lastError: string | null }> }>("GET", "/v1/peers")).peers;
  }

  /** Admin. */
  async addPeer(url: string): Promise<void> {
    await this.rest("POST", "/v1/peers", { url }, true);
  }

  /** Admin. */
  async sync(): Promise<{ peers: number; learned: number }> {
    return this.rest<{ peers: number; learned: number }>("POST", "/v1/peers/sync", {}, true);
  }
}
