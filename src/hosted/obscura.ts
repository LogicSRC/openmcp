/**
 * Obscura, hosted: a relay that fetches web pages through a stealth headless
 * browser, served by the catalog itself.
 *
 * Obscura (github.com/h4ckf0r0day/obscura) is a Rust headless browser with a
 * real V8, Chrome's TLS fingerprint and a tracker blocklist. One process per
 * fetch, no daemon: the relay spawns `obscura fetch <url> --dump <format>`
 * and hands back what came out. The binary is found at OBSCURA_BIN, else on
 * the PATH. A catalog without the binary still serves the descriptor, and the
 * one tool answers with an error that says so.
 *
 * The relay has no credential, so it has limits instead: a few fetches at a
 * time, a minute at most each, a megabyte of output, and public http(s)
 * origins only. Obscura itself refuses private networks.
 */
import { Hono } from "hono";
import { spawn } from "node:child_process";
import { PROTOCOL_VERSION, failure, isNotification, isRequest, result, text, toolError, INVALID_PARAMS, METHOD_NOT_FOUND, PARSE_ERROR, type ToolDefinition, type ToolResult } from "../mcp/protocol.ts";
import { OPENMCP_VERSION, type RelayDescriptor } from "../spec.ts";
import type { HostedRelay } from "../server.ts";

export const OBSCURA_VERSION = "0.2.2";
export const FORMATS = ["markdown", "text", "html", "links", "original"] as const;
export type Format = (typeof FORMATS)[number];

export interface FetchRequest {
  url: string;
  format: Format;
  stealth: boolean;
  timeoutSeconds: number;
}

export interface FetchOutcome {
  ok: boolean;
  output: string;
  error?: string;
  ms: number;
  truncated?: boolean;
}

export type Runner = (request: FetchRequest) => Promise<FetchOutcome>;

/** One megabyte of page is plenty for a model; the rest is cut and said so. */
export const MAX_OUTPUT_BYTES = 1_000_000;
export const MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_TIMEOUT_SECONDS = 30;
/** Fetches in flight at once. Rendering a heavy page peaks near 300 MB. */
export const MAX_CONCURRENT = 3;

/** Spawn the real binary. */
export function spawnRunner(binary = process.env.OBSCURA_BIN || "obscura"): Runner {
  return (request) =>
    new Promise((resolve) => {
      const started = Date.now();
      const args = [...(request.stealth ? ["--stealth"] : []), "fetch", request.url, "--dump", request.format, "--timeout", String(request.timeoutSeconds), "--quiet"];
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ ok: false, output: "", error: `could not start obscura: ${(error as Error).message}`, ms: Date.now() - started });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let stderr = "";
      const killer = setTimeout(() => child.kill("SIGKILL"), (request.timeoutSeconds + 10) * 1000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (bytes >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        const room = MAX_OUTPUT_BYTES - bytes;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        bytes += Math.min(chunk.length, room);
        if (chunk.length > room) truncated = true;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(killer);
        resolve({ ok: false, output: "", error: `could not start obscura: ${error.message}`, ms: Date.now() - started });
      });
      child.on("close", (code, signal) => {
        clearTimeout(killer);
        const output = Buffer.concat(chunks).toString("utf8");
        if (signal) resolve({ ok: false, output, error: `obscura gave up after ${request.timeoutSeconds}s`, ms: Date.now() - started, truncated });
        else if (code !== 0) resolve({ ok: false, output, error: `obscura exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300) || "no message"}`, ms: Date.now() - started, truncated });
        else resolve({ ok: true, output, ms: Date.now() - started, truncated });
      });
    });
}

/** Only public web origins. Obscura refuses private networks itself; this refuses the obviously wrong before spawning anything. */
export function acceptableUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "url is required." };
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, error: "url is not a URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "url must be http or https." };
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || /^\[?(::1|fe80:|fc|fd)/.test(host)) return { ok: false, error: "url must be a public host." };
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return { ok: false, error: "url must be a public host." };
  if (parsed.username || parsed.password) return { ok: false, error: "url must not carry credentials." };
  return { ok: true, url: parsed.toString() };
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "fetch_page",
    title: "Fetch a web page",
    description:
      "Fetch a public web page through Obscura, a stealth headless browser that renders JavaScript and presents Chrome's TLS fingerprint, so pages that answer curl with 403 usually answer this. Returns the page as markdown (default), plain text, its links, the rendered HTML, or the original bytes. No credential needed.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page, http or https, on a public host." },
        format: { type: "string", enum: [...FORMATS], description: "markdown (default) for reading; text for a plain dump; links for every href; html for the rendered DOM (large); original for the raw response body, best for feeds and XML." },
        stealth: { type: "boolean", description: "Chrome 145 TLS fingerprint and tracker blocking. Default true." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `Navigation timeout. Default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}.` },
        max_chars: { type: "integer", minimum: 1000, description: "Cut the answer to this many characters. Default 200000." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export interface ObscuraOptions {
  runner?: Runner;
  operator?: string;
  log?: (line: string) => void;
  maxConcurrent?: number;
}

export function descriptorFor(base: string, catalogUrl: string, operator?: string): RelayDescriptor {
  return {
    openmcp: OPENMCP_VERSION,
    mcp: `${base}/mcp`,
    name: "Obscura",
    description:
      "Fetch any public web page as markdown, text, links or HTML through Obscura, a stealth headless browser that renders JavaScript and passes bot walls plain HTTP clients cannot. Keyless; a few fetches at a time.",
    url: base,
    auth: { kind: "none", open: ["fetch_page"] },
    tags: ["browser", "fetch", "scrape", "stealth", "web", "hosted"],
    ...(operator ? { operator } : {}),
    tools: TOOLS.map((tool) => tool.name),
    catalogs: [catalogUrl],
  };
}

/** The relay, ready to be mounted by the catalog at a subdomain and under /hosted/obscura. */
export function obscuraRelay(options: ObscuraOptions = {}): HostedRelay {
  const runner = options.runner ?? spawnRunner();
  const log = options.log ?? (() => {});
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT;
  let inFlight = 0;

  async function fetchPage(args: Record<string, unknown>): Promise<ToolResult> {
    const target = acceptableUrl(args.url);
    if (!target.ok) return toolError(target.error);
    const format = FORMATS.includes(args.format as Format) ? (args.format as Format) : "markdown";
    const stealth = args.stealth === undefined ? true : Boolean(args.stealth);
    const timeoutSeconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Number(args.timeout_seconds) || DEFAULT_TIMEOUT_SECONDS));
    const maxChars = Math.max(1000, Number(args.max_chars) || 200_000);
    if (inFlight >= maxConcurrent) return toolError(`Busy: ${inFlight} fetches in flight. Try again in a few seconds.`);
    inFlight++;
    try {
      const outcome = await runner({ url: target.url, format, stealth, timeoutSeconds });
      log(`obscura ${format} ${target.url}: ${outcome.ok ? `${outcome.output.length} chars` : outcome.error} in ${outcome.ms}ms`);
      if (!outcome.ok) return toolError(`Could not fetch ${target.url}: ${outcome.error}`);
      const cut = outcome.output.length > maxChars;
      const body = cut ? outcome.output.slice(0, maxChars) : outcome.output;
      const truncated = Boolean(outcome.truncated) || cut;
      return text(truncated ? `${body}\n\n[truncated at ${body.length} characters]` : body, { url: target.url, format, stealth, chars: body.length, truncated, ms: outcome.ms });
    } finally {
      inFlight--;
    }
  }

  return {
    slug: "obscura",
    app(base, catalogUrl) {
      const app = new Hono();
      const descriptor = descriptorFor(base, catalogUrl, options.operator);
      app.get("/", (c) => c.json({ name: "Obscura", hosted: true, obscura: OBSCURA_VERSION, descriptor: `${base}/.well-known/openmcp.json`, mcp: `${base}/mcp`, tools: TOOLS.map((tool) => tool.name), catalog: catalogUrl }));
      app.get("/.well-known/openmcp.json", (c) => c.json(descriptor));
      app.get("/healthz", (c) => c.json({ ok: true, inFlight }));
      app.get("/mcp", (c) => c.json({ ok: false, note: "POST JSON-RPC 2.0 here. No credential needed.", tools: TOOLS.map((tool) => tool.name) }, 405));
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
                serverInfo: { name: "obscura", version: OBSCURA_VERSION },
                instructions: "fetch_page gets a public web page through a stealth headless browser. Ask for markdown to read it, links to navigate, original for feeds.",
              }),
            );
          case "ping":
            return c.json(result(id, {}));
          case "tools/list":
            return c.json(result(id, { tools: TOOLS }));
          case "tools/call": {
            const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
            if (params.name !== "fetch_page") return c.json(failure(id, INVALID_PARAMS, `No such tool: ${params.name ?? ""}`));
            return c.json(result(id, await fetchPage(params.arguments ?? {})));
          }
          default:
            return c.json(failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`));
        }
      });
      return app;
    },
  };
}
