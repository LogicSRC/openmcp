/**
 * Talking to a relay: the client side of Streamable HTTP MCP.
 *
 * Small on purpose. Initialize once, then tools/list and tools/call. A
 * session id the server hands back is echoed; nothing else is remembered.
 * Fetch is injectable so the catalog's tests can stand up a fake relay.
 */
import { PROTOCOL_VERSION, payloadOf, type JsonRpcResponse, type ToolResult } from "./protocol.ts";

export type Fetcher = typeof fetch;

export interface McpClientOptions {
  url: string;
  token?: string;
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
  fetch?: Fetcher;
}

export interface McpServerInfo {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A tool answered with isError: the relay's own refusal, worth showing verbatim. */
export class McpToolError extends Error {
  readonly tool: string;
  constructor(tool: string, message: string) {
    super(message);
    this.name = "McpToolError";
    this.tool = tool;
  }
}

export class McpClient {
  private nextId = 1;
  private sessionId?: string;
  private ready?: Promise<McpServerInfo>;
  private readonly fetcher: Fetcher;
  private readonly options: McpClientOptions;

  constructor(options: McpClientOptions) {
    if (!options.url) throw new Error("An MCP client needs a URL.");
    this.options = options;
    this.fetcher = options.fetch ?? fetch;
  }

  get url(): string {
    return this.options.url;
  }

  initialize(): Promise<McpServerInfo> {
    this.ready ??= this.handshake();
    return this.ready;
  }

  private async handshake(): Promise<McpServerInfo> {
    const info = (await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.options.clientName ?? "openmcp", version: this.options.clientVersion ?? "0" },
    })) as McpServerInfo;
    await this.notify("notifications/initialized");
    return info;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.initialize();
    const out: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const reply = (await this.rpc("tools/list", cursor ? { cursor } : {})) as { tools?: McpToolDefinition[]; nextCursor?: string };
      out.push(...(reply?.tools ?? []));
      if (!reply?.nextCursor) break;
      cursor = reply.nextCursor;
    }
    return out;
  }

  /** Call one tool and hand back its payload, structured where the server gave one. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.initialize();
    const reply = (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
    if (reply?.isError) throw new McpToolError(name, (reply.content ?? []).map((block) => block.text).join("\n").trim() || `${name} failed.`);
    return payloadOf(reply) as T;
  }

  /** The raw result, for a relay that wants to forward it untouched. */
  async callRaw(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.initialize();
    return (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  private async post(body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    try {
      return await this.fetcher(this.options.url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new Error(`Timed out talking to ${this.options.url}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method }).catch(() => undefined);
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (response.status === 401 || response.status === 403) throw new Error(`${this.options.url} refused the credential (${response.status}).`);
    if (response.status === 404 || response.status === 405) throw new Error(`No MCP endpoint at ${this.options.url} (${response.status}).`);
    if (!response.ok) throw new Error(`${method}: ${this.options.url} answered ${response.status}.`);
    const message = parseMessage(await response.text(), response.headers.get("content-type") ?? "");
    if (!message) throw new Error(`${method}: ${this.options.url} sent no JSON-RPC response.`);
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }
}

/** One JSON-RPC message from a body that is JSON, or the first `data:` line of an SSE stream. */
export function parseMessage(body: string, contentType: string): JsonRpcResponse | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (!contentType.includes("text/event-stream")) {
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
      return Array.isArray(parsed) ? (parsed.find((item) => item.id !== undefined) ?? null) : parsed;
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
      if (parsed.id !== undefined) return parsed;
    } catch {
      // A keepalive or a notification; keep reading.
    }
  }
  return null;
}
