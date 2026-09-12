/**
 * Checking a relay is what it says it is.
 *
 * Two questions, asked in order. Does its origin serve a descriptor at
 * /.well-known/openmcp.json? Then the descriptor is the relay's own word and
 * the record is verified. Does the MCP endpoint answer initialize and
 * tools/list? Then the relay is online and the tools are what it really
 * offers, whatever the descriptor claimed.
 *
 * A URL handed to a catalog can be either the descriptor, the MCP endpoint,
 * or just the site. All three are tried from what was given.
 */
import { McpClient, type Fetcher, type McpServerInfo } from "./mcp/client.ts";
import { parseDescriptor, relayId, WELL_KNOWN_PATH, OPENMCP_VERSION, type RelayDescriptor, type RelayRecord, type RelayTool } from "./spec.ts";

export interface ProbeOptions {
  fetch?: Fetcher;
  timeoutMs?: number;
  /** A previous record, so first-seen and failure counts carry over. */
  previous?: RelayRecord | null;
  /** The catalog a record was learned from, when it was not registered here. */
  via?: string | null;
  now?: () => Date;
}

const MAX_TOOLS = 200;

/** Where an MCP endpoint usually is, when only the site is known. */
export const COMMON_PATHS = ["/mcp", "/api/mcp", "/api/v1/mcp", "/v1/mcp"];

/** The first endpoint that completes the handshake, or the last error. */
async function firstAnswering(candidates: string[], fetcher: Fetcher, timeoutMs: number): Promise<{ client: McpClient; endpoint: string; info: McpServerInfo }> {
  let lastError: unknown = new Error("no endpoint to try");
  for (const endpoint of candidates) {
    const client = new McpClient({ url: endpoint, fetch: fetcher, timeoutMs, clientName: "openmcp-catalog" });
    try {
      const info = await client.initialize();
      return { client, endpoint, info };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readJson(fetcher: Fetcher, url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" }, signal: controller.signal, redirect: "follow" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Where a relay's descriptor would be, from any URL on its origin. */
export function wellKnownFor(url: string): string {
  return new URL(WELL_KNOWN_PATH, url).toString();
}

/**
 * Build a record from a URL. The record is online only if the MCP endpoint
 * answered; it is verified only if the origin served its own descriptor.
 */
export async function probeRelay(input: string, options: ProbeOptions = {}): Promise<RelayRecord> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const previous = options.previous ?? null;
  const given = new URL(input).toString();

  // The descriptor, from the origin of whatever was given.
  const wellKnown = wellKnownFor(given);
  const served = await readJson(fetcher, wellKnown, timeoutMs);
  let descriptor = served ? parseDescriptor(served, wellKnown) : null;
  let verified = descriptor !== null;
  let source = descriptor ? wellKnown : given;

  // No descriptor: the given URL is taken as the MCP endpoint itself, or a
  // previous record's descriptor is kept, so a relay that stopped serving its
  // descriptor does not lose its name. A bare site URL is tried at the paths
  // MCP servers usually live at, so `openmcp add https://board.example` works
  // for a board that has not served a descriptor yet.
  let candidates: string[] = [];
  if (!descriptor) {
    if (previous?.descriptor) {
      descriptor = previous.descriptor;
    } else {
      const bare = new URL(given);
      candidates = bare.pathname === "/" || bare.pathname === "" ? COMMON_PATHS.map((path) => new URL(path, bare).toString()) : [given];
      descriptor = { openmcp: OPENMCP_VERSION, mcp: candidates[0] as string };
    }
    verified = previous?.verified ?? false;
    source = previous?.source ?? given;
  }

  try {
    const { client, endpoint, info } = await firstAnswering(candidates.length ? candidates : [descriptor.mcp], fetcher, timeoutMs);
    if (endpoint !== descriptor.mcp) descriptor = { ...descriptor, mcp: endpoint };
    const id = previous?.id ?? relayId(descriptor.mcp);
    const tools = (await client.listTools()).slice(0, MAX_TOOLS).map(
      (tool): RelayTool => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      }),
    );
    return {
      id,
      source,
      descriptor,
      tools,
      server: {
        ...(info.serverInfo?.name ? { name: info.serverInfo.name } : {}),
        ...(info.serverInfo?.version ? { version: info.serverInfo.version } : {}),
        ...(info.protocolVersion ? { protocolVersion: info.protocolVersion } : {}),
      },
      verified,
      online: true,
      seenAt: now,
      firstSeenAt: previous?.firstSeenAt ?? now,
      failures: 0,
      lastError: null,
      via: options.via ?? previous?.via ?? null,
    };
  } catch (error) {
    // The relay names its tools in the descriptor; that is the best a catalog
    // can say about an endpoint it could not reach, and it is marked so.
    const claimed: RelayTool[] = previous?.tools.length ? previous.tools : (descriptor.tools ?? []).map((name) => ({ name }));
    const id = previous?.id ?? relayId(descriptor.mcp);
    return {
      id,
      source,
      descriptor,
      tools: claimed,
      ...(previous?.server ? { server: previous.server } : {}),
      verified,
      online: false,
      seenAt: previous?.seenAt ?? null,
      firstSeenAt: previous?.firstSeenAt ?? now,
      failures: (previous?.failures ?? 0) + 1,
      lastError: (error as Error).message,
      via: options.via ?? previous?.via ?? null,
    };
  }
}

/** A descriptor for a relay that has none yet, as a starting point to serve. */
export function descriptorTemplate(mcp: string, name?: string): RelayDescriptor {
  return {
    openmcp: OPENMCP_VERSION,
    mcp,
    name: name ?? new URL(mcp).hostname,
    description: "One line about what this relay is for.",
    url: new URL("/", mcp).toString(),
    auth: { kind: "none" },
    tags: [],
    operator: "https://example.com/.well-known/openprofile.md",
  };
}
