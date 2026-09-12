/**
 * `openmcp`: the catalog from a terminal.
 *
 *   openmcp serve [--port 8790] [--db ./openmcp.db] [--url https://...]
 *   openmcp relays [q] [--tag t] [--online] [--json]
 *   openmcp add <url>                 register a relay (probe, then list what was found)
 *   openmcp show <id> | tools <id> | refresh <id> | rm <id>
 *   openmcp find <words>              search every relay's tools
 *   openmcp call <id> <tool> [json]   call a tool through the catalog (--relay-token for the relay's auth)
 *   openmcp webhook add <url> [--events a,b] [--relays x,y] [--secret s]
 *   openmcp webhook show <id> | rm <id>
 *   openmcp webhook verify --secret s --signature "sha256=..." < body.json
 *   openmcp peer list | add <url> | rm <url> | sync
 *   openmcp probe <url>               probe without a catalog
 *   openmcp descriptor <mcp url>      print a /.well-known/openmcp.json to serve
 *
 * The catalog is --catalog, else $OPENMCP_CATALOG, else http://127.0.0.1:8790.
 * --transport mcp talks to the catalog over its MCP endpoint instead of REST.
 * --json prints the payload and nothing else.
 */
import { readFileSync } from "node:fs";
import { OpenMcpClient, verifySignature } from "./client.ts";
import { INSTALL_SITE, installLine, uninstall, update, whereIsIt } from "./manage.ts";
import { Catalog } from "./db.ts";
import { descriptorTemplate, probeRelay } from "./probe.ts";
import { serve, VERSION } from "./server.ts";
import { obscuraRelay } from "./hosted/obscura.ts";
import { CATALOG_EVENTS, type CatalogEvent, type RelayRecord } from "./spec.ts";

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2);
    const name = (key as string).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (inline !== undefined) flags[name] = inline;
    else if (index + 1 < argv.length && !(argv[index + 1] as string).startsWith("--")) flags[name] = argv[++index] as string;
    else flags[name] = true;
  }
  return { positional, flags };
}

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

/** The client's catalog when none is named: the public one, which is what the one-line installer is for. `serve` still listens locally. */
export const DEFAULT_CATALOG = INSTALL_SITE;

const HELP = `openmcp ${VERSION}: an open catalog of MCP relays.

  serve [--port 8790] [--db openmcp.db] [--url https://catalog.example] [--admin-token t]
  relays [q] [--tag t] [--online]        the relays, and what each offers
  add <url>                              register a relay by any URL on its origin
  show <id> | tools <id> | refresh <id> | rm <id>
  find <words>                           search every relay's tools
  call <id> <tool> ['{"json":"args"}'] [--relay-token t]
  webhook add <url> [--events a,b] [--relays x,y] [--secret s]
  webhook show <id> | rm <id> | verify --secret s --signature sig < body
  peer list | add <url> | rm <url> | sync
  probe <url>                            what a catalog would find, without one
  descriptor <mcp url> [--name n]        a /.well-known/openmcp.json to serve
  update | uninstall [--yes] | where     this command itself, when the installer put it here

  --catalog <url>   the catalog (or $OPENMCP_CATALOG; default ${DEFAULT_CATALOG})
  --token <t>       the catalog's admin token (or $OPENMCP_TOKEN)
  --transport mcp   talk to the catalog over MCP instead of REST
  --json            print the payload and nothing else

Install: ${installLine()}
Spec: https://logicsrc.com/openmcp`;

function relayLine(relay: RelayRecord): string {
  return `${relay.online ? "on " : "off"}  ${relay.verified ? "✓" : " "}  ${relay.id.padEnd(40)}  ${relay.tools.length.toString().padStart(3)} tools  ${relay.descriptor.name ?? ""}`;
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv);
  const [command, ...rest] = positional;
  const json = flags.json === true;
  const print = (value: unknown, lines: () => void): void => (json ? out(JSON.stringify(value, null, 2)) : lines());

  if (!command || command === "help" || flags.help === true) {
    out(HELP);
    return 0;
  }

  if (command === "serve") {
    const port = Number(flags.port ?? process.env.PORT ?? 8790);
    const url = String(flags.url ?? process.env.OPENMCP_URL ?? `http://127.0.0.1:${port}`);
    const store = new Catalog(String(flags.db ?? process.env.OPENMCP_DB ?? "openmcp.db"));
    const adminToken = typeof flags.adminToken === "string" ? flags.adminToken : process.env.OPENMCP_ADMIN_TOKEN;
    const log = (line: string): void => out(`${new Date().toISOString()}  ${line}`);
    // OPENMCP_HOSTED names the relays this process serves itself, comma separated. Today: obscura.
    const hostedNames = String(flags.hosted ?? process.env.OPENMCP_HOSTED ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const hosted = hostedNames.map((name) => {
      if (name === "obscura") return obscuraRelay({ operator: process.env.OPENMCP_OPERATOR, log });
      throw new Error(`Unknown hosted relay "${name}". Known: obscura.`);
    });
    const running = serve({
      store,
      url,
      port,
      adminToken,
      name: process.env.OPENMCP_NAME,
      operator: process.env.OPENMCP_OPERATOR,
      hosted,
      log,
      refreshEveryMs: Number(process.env.OPENMCP_REFRESH_MINUTES ?? 10) * 60_000,
      syncEveryMs: Number(process.env.OPENMCP_SYNC_MINUTES ?? 30) * 60_000,
    });
    log(`openmcp catalog ${VERSION} on :${port} as ${url} (${store.counts().relays} relays${adminToken ? "" : ", no admin token: remove and peers are off"})`);
    const stop = (): void => {
      running.stop();
      store.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
    return 0;
  }

  if (command === "probe") {
    const url = rest[0];
    if (!url) throw new Error("Usage: openmcp probe <url>");
    const record = await probeRelay(url);
    print(record, () => {
      out(relayLine(record));
      if (record.lastError) out(`  ${record.lastError}`);
      for (const tool of record.tools) out(`  ${tool.name.padEnd(28)} ${tool.description?.split("\n")[0]?.slice(0, 80) ?? ""}`);
    });
    return record.online ? 0 : 1;
  }

  if (command === "descriptor") {
    const mcp = rest[0];
    if (!mcp) throw new Error("Usage: openmcp descriptor <mcp url> [--name n]");
    out(JSON.stringify(descriptorTemplate(mcp, typeof flags.name === "string" ? flags.name : undefined), null, 2));
    return 0;
  }

  // The command itself. These read the manifest install.sh wrote; a copy npm
  // put somewhere has none, and they say so rather than guess.
  const io = { out, err: (line: string): void => void process.stderr.write(`${line}\n`) };
  if (command === "update") return update(io);
  if (command === "uninstall") return uninstall(io, { yes: flags.yes === true });
  if (command === "where") return whereIsIt(io);

  const client = new OpenMcpClient({
    url: String(flags.catalog ?? process.env.OPENMCP_CATALOG ?? DEFAULT_CATALOG),
    transport: flags.transport === "mcp" ? "mcp" : "rest",
    token: typeof flags.token === "string" ? flags.token : process.env.OPENMCP_TOKEN,
  });

  switch (command) {
    case "relays": {
      const relays = await client.relays({ q: rest.join(" ") || undefined, tag: typeof flags.tag === "string" ? flags.tag : undefined, online: flags.online === true });
      print(relays, () => {
        if (!relays.length) out("No relays. openmcp add <url> registers one.");
        for (const relay of relays) out(relayLine(relay));
      });
      return 0;
    }
    case "add": {
      if (!rest[0]) throw new Error("Usage: openmcp add <url>");
      const relay = await client.register(rest[0]);
      print(relay, () => {
        out(`${relay.id}: ${relay.online ? "online" : `offline (${relay.lastError})`}, ${relay.tools.length} tools, ${relay.verified ? "verified" : "not verified: serve /.well-known/openmcp.json to be"}.`);
      });
      return 0;
    }
    case "show": {
      if (!rest[0]) throw new Error("Usage: openmcp show <id>");
      const relay = await client.relay(rest[0]);
      print(relay, () => {
        out(relayLine(relay));
        out(`  mcp: ${relay.descriptor.mcp}   auth: ${relay.descriptor.auth?.kind ?? "unstated"}   tags: ${(relay.descriptor.tags ?? []).join(", ") || "none"}`);
        if (relay.descriptor.description) out(`  ${relay.descriptor.description}`);
        if (relay.descriptor.operator) out(`  operator: ${relay.descriptor.operator}`);
        if (relay.lastError) out(`  last error: ${relay.lastError}`);
        for (const tool of relay.tools) out(`  ${tool.name.padEnd(28)} ${tool.description?.split("\n")[0]?.slice(0, 80) ?? ""}`);
      });
      return 0;
    }
    case "tools": {
      if (!rest[0]) throw new Error("Usage: openmcp tools <id>");
      const tools = await client.tools(rest[0]);
      print(tools, () => {
        for (const tool of tools) out(`${tool.name.padEnd(28)} ${tool.description?.split("\n")[0]?.slice(0, 90) ?? ""}`);
      });
      return 0;
    }
    case "refresh": {
      if (!rest[0]) throw new Error("Usage: openmcp refresh <id>");
      const relay = await client.refresh(rest[0]);
      print(relay, () => out(relayLine(relay)));
      return 0;
    }
    case "rm": {
      if (!rest[0]) throw new Error("Usage: openmcp rm <id> --token <admin token>");
      await client.remove(rest[0]);
      out(`Removed ${rest[0]}.`);
      return 0;
    }
    case "find": {
      const q = rest.join(" ");
      if (!q) throw new Error("Usage: openmcp find <words>");
      const found = await client.findTool(q);
      print(found, () => {
        if (!found.length) out("Nothing matches.");
        for (const tool of found) out(`${tool.relay.padEnd(36)} ${tool.name.padEnd(28)} ${tool.description?.split("\n")[0]?.slice(0, 70) ?? ""}`);
      });
      return 0;
    }
    case "call": {
      const [id, tool, raw] = rest;
      if (!id || !tool) throw new Error("Usage: openmcp call <id> <tool> ['{\"json\":\"args\"}'] [--relay-token t]");
      const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const outcome = await client.call(id, tool, args, typeof flags.relayToken === "string" ? flags.relayToken : undefined);
      print(outcome, () => {
        if (!outcome.ok) out(`${id} ${tool}: ${outcome.error ?? "failed"}`);
        else {
          const structured = outcome.result?.structuredContent;
          if (structured !== undefined) out(JSON.stringify(structured, null, 2));
          else out(outcome.result?.content.map((block) => block.text).join("\n") ?? "");
        }
      });
      return outcome.ok ? 0 : 1;
    }
    case "webhook": {
      const [sub, ...args] = rest;
      switch (sub) {
        case "add": {
          if (!args[0]) throw new Error("Usage: openmcp webhook add <url> [--events a,b] [--relays x,y] [--secret s]");
          const events = typeof flags.events === "string" ? (flags.events.split(",").map((e) => e.trim()).filter((e) => CATALOG_EVENTS.includes(e as CatalogEvent)) as CatalogEvent[]) : undefined;
          const relays = typeof flags.relays === "string" ? flags.relays.split(",").map((r) => r.trim()).filter(Boolean) : undefined;
          const made = await client.subscribe({ url: args[0], events, relays, secret: typeof flags.secret === "string" ? flags.secret : undefined });
          print(made, () => {
            out(`Subscribed ${made.webhook.id} to ${made.webhook.events.join(", ")}.`);
            out(`Secret: ${made.secret}`);
            out("Verify each delivery: openmcp webhook verify --secret <secret> --signature <X-OpenMCP-Signature> < body");
          });
          return 0;
        }
        case "show": {
          if (!args[0]) throw new Error("Usage: openmcp webhook show <id>");
          const info = await client.webhook(args[0]);
          print(info, () => {
            out(`${info.webhook.id}  ${info.webhook.url}  ${info.webhook.active ? "active" : "inactive"}  events: ${info.webhook.events.join(", ")}`);
            for (const delivery of info.deliveries as Array<{ at: string; event: string; relay: string; status: number | null; error: string | null }>) {
              out(`  ${delivery.at.slice(0, 19)}  ${delivery.event.padEnd(16)}  ${delivery.relay.padEnd(30)}  ${delivery.status ?? "no answer"}${delivery.error ? `  ${delivery.error}` : ""}`);
            }
          });
          return 0;
        }
        case "rm": {
          if (!args[0]) throw new Error("Usage: openmcp webhook rm <id>");
          await client.unsubscribe(args[0]);
          out(`Removed ${args[0]}.`);
          return 0;
        }
        case "verify": {
          const secret = typeof flags.secret === "string" ? flags.secret : "";
          const signature = typeof flags.signature === "string" ? flags.signature : "";
          if (!secret || !signature) throw new Error("Usage: openmcp webhook verify --secret s --signature sig < body");
          const body = readFileSync(0, "utf8");
          const good = verifySignature(secret, signature, body);
          out(good ? "Signature matches." : "Signature does NOT match.");
          return good ? 0 : 1;
        }
        default:
          throw new Error("Usage: openmcp webhook add|show|rm|verify");
      }
    }
    case "peer": {
      const [sub, ...args] = rest;
      switch (sub ?? "list") {
        case "list": {
          const peers = await client.peers();
          print(peers, () => {
            if (!peers.length) out("No peers.");
            for (const peer of peers) out(`${peer.url}  ${peer.syncedAt ? `synced ${peer.syncedAt.slice(0, 19)}` : "never synced"}${peer.lastError ? `  ${peer.lastError}` : ""}`);
          });
          return 0;
        }
        case "add":
          if (!args[0]) throw new Error("Usage: openmcp peer add <url> --token <admin token>");
          await client.addPeer(args[0]);
          out(`Added ${args[0]}.`);
          return 0;
        case "sync": {
          const done = await client.sync();
          print(done, () => out(`${done.peers} peers, ${done.learned} relays learned.`));
          return 0;
        }
        default:
          throw new Error("Usage: openmcp peer list|add|sync");
      }
    }
    default:
      out(HELP);
      return 1;
  }
}
