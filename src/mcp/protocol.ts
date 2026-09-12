/**
 * The little of JSON-RPC and MCP a catalog needs.
 *
 * Streamable HTTP: one POST per message, JSON back. No SSE, no sessions kept
 * server side; a catalog's tools are all one shot.
 */
export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export const result = (id: string | number | null, value: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result: value });

export const failure = (id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === "2.0" && typeof record.method === "string";
}

export const isNotification = (request: JsonRpcRequest): boolean => request.id === undefined || request.id === null;

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

export const text = (value: string, structured?: unknown): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
});

/** Reported as a tool result, not a JSON-RPC error: the model reads it and tries something else. */
export const toolError = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Read the payload out of a tool result the way a client should: structured first, then JSON in a text block, then the prose. */
export function payloadOf(value: ToolResult | undefined): unknown {
  if (!value) return undefined;
  if (value.structuredContent !== undefined) return value.structuredContent;
  const joined = (value.content ?? []).map((block) => block.text ?? "").join("\n").trim();
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}
