# OpenMCP

An open catalog of MCP relays: MCP servers you can reach over HTTP, listed by what they offer, verified against what they say about themselves, and callable through the catalog or direct. A reference catalog server, and a client that speaks REST, MCP and webhooks.

The specification is at [logicsrc.com/openmcp](https://logicsrc.com/openmcp); this repository is the reference implementation, and `docs/openmcp.md` is a copy of the spec.

## What it is

Every product that speaks MCP is a **relay**: an endpoint an agent can call. Today each one has to be found by hand and wired into a client's config. OpenMCP gives a relay one file to serve, gives a **catalog** a way to list relays it has actually reached, and gives a client one door to all of them.

- A relay serves `/.well-known/openmcp.json`: where its MCP endpoint is, how to authenticate, what it is for, who operates it (an [OpenProfile.md](https://logicsrc.com/openprofile) URL), and which catalogs list it.
- A catalog probes a relay before listing it: the descriptor from the relay's own origin, then an MCP handshake and `tools/list`. What is listed is what was found. The catalog holds no credentials and never speaks for a relay it could not reach.
- A catalog is itself a relay: it serves the same file, and its MCP endpoint offers `list_relays`, `find_tool` and `call_tool`, so an agent that can reach one catalog can reach every relay in it.
- Webhooks tell subscribers when a relay is registered, updated, goes offline or comes back. Deliveries are signed.
- Catalogs peer: one learns the other's relays, and still probes each one before listing it.

## Run a catalog

```sh
npx @logicsrc/openmcp serve --port 8790 --url https://catalog.example --admin-token <token>
```

Node 24 or later, one SQLite file (`--db`), no build step. `OPENMCP_URL`, `OPENMCP_DB`, `OPENMCP_ADMIN_TOKEN`, `OPENMCP_NAME`, `OPENMCP_OPERATOR`, `OPENMCP_REFRESH_MINUTES` (10) and `OPENMCP_SYNC_MINUTES` (30) do the same from the environment. Without an admin token, removing relays and managing peers are off; registration is always open.

The `Dockerfile` and `railway.json` deploy it as one service with a volume at `/data`.

## Use one

```sh
export OPENMCP_CATALOG=https://catalog.example
openmcp relays                              # what is listed
openmcp add https://agenticjobs.work        # register by any URL on the relay's origin
openmcp find "post an update"               # search every relay's tools
openmcp call agenticjobs.work post_update '{"body":"Shipped."}' --relay-token <token>
openmcp webhook add https://me.example/hooks --events relay.offline,relay.online
openmcp --transport mcp relays              # the same, over the catalog's MCP endpoint
```

From code:

```ts
import { OpenMcpClient, verifySignature } from "@logicsrc/openmcp/client";

const catalog = new OpenMcpClient({ url: "https://catalog.example" });
const [relay] = await catalog.relays({ q: "jobs" });
const outcome = await catalog.call(relay.id, "search_jobs", { q: "rust" });
const direct = await catalog.connect(relay.id);      // a plain MCP client for the relay itself

// In a webhook receiver:
verifySignature(secret, request.headers.get("x-openmcp-signature"), rawBody);
```

## Serve a descriptor

```sh
openmcp descriptor https://your.site/api/mcp --name "Your site" > .well-known/openmcp.json
```

Fill in `description`, `auth`, `tags` and `operator`, serve it at `/.well-known/openmcp.json`, and any catalog can list you as verified.

## The three doors

| | REST | MCP | Webhooks |
|---|---|---|---|
| List relays | `GET /v1/relays?q=&tag=&online=1` | `list_relays` | |
| One relay, its tools | `GET /v1/relays/:id`, `/tools` | `get_relay` | |
| Register, refresh | `POST /v1/relays {url}`, `POST /v1/relays/:id/refresh` | `register_relay`, `refresh_relay` | `relay.registered`, `relay.updated` |
| Find a tool anywhere | `GET /v1/tools?q=` | `find_tool` | |
| Call a relay's tool | `POST /v1/relays/:id/call {tool, arguments, token?}` | `call_tool` | |
| Up, down | `POST /v1/relays/:id/refresh` | `refresh_relay` | `relay.online`, `relay.offline` |
| Subscribe | `POST /v1/webhooks {url, events?, relays?, secret?}` | `subscribe` | signed `POST` per event |
| Peers | `GET/POST/DELETE /v1/peers`, `POST /v1/peers/sync` (admin) | `list_peers` | |

Every delivery carries `X-OpenMCP-Event`, `X-OpenMCP-Delivery` and `X-OpenMCP-Signature: sha256=<hmac of the raw body>`.

## Develop

```sh
npm install
npm test          # node --test, no network
npm run typecheck
```

MIT. Part of the [LogicSRC](https://logicsrc.com) open-standards surface, maintained by Profullstack, Inc.
