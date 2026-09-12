# OpenMCP

An open catalog of MCP relays: MCP servers you can reach over HTTP, listed by what they offer, verified against what they say about themselves, and callable through the catalog or direct. A reference catalog server, and a client that speaks REST, MCP and webhooks.

The specification is at [logicsrc.com/openmcp](https://logicsrc.com/openmcp); this repository is the reference implementation, and `docs/openmcp.md` is a copy of the spec.

## What it is

Every product that speaks MCP is a **relay**: an endpoint an agent can call. Today each one has to be found by hand and wired into a client's config. OpenMCP gives a relay one file to serve, gives a **catalog** a way to list relays it has actually reached, and gives a client one door to all of them.

- A relay serves `/.well-known/openmcp.json`: where its MCP endpoint is, how to authenticate, what it is for, who operates it (an [OpenProfile.md](https://logicsrc.com/openprofile) URL), and which catalogs list it.
- A catalog probes a relay before listing it: the descriptor from the relay's own origin, then an MCP handshake and `tools/list`. What is listed is what was found. The catalog holds no credentials and never speaks for a relay it could not reach.
- A catalog is itself a relay: it serves the same file, and its MCP endpoint offers `list_relays`, `find_tool` and `call_tool`, so an agent that can reach one catalog can reach every relay in it.
- Webhooks tell subscribers when a relay is registered, updated, goes offline or comes back. Deliveries are signed.
- The same records are a directory for people: browse, search, filter by tag, read a relay's tools and schemas. Sign in by emailed link (no passwords) to register relays of your own, probe them again and remove them.
- A catalog can host relays itself. This one hosts **Obscura**, a stealth headless browser: `fetch_page` returns any public web page as markdown, text, links or HTML, including pages that answer plain HTTP clients with 403.
- Catalogs peer: one learns the other's relays, and still probes each one before listing it.

## Run a catalog

```sh
npx @logicsrc/openmcp serve --port 8790 --url https://catalog.example --admin-token <token>
```

Node 24 or later, one SQLite file (`--db`), no build step. `OPENMCP_URL`, `OPENMCP_DB`, `OPENMCP_ADMIN_TOKEN`, `OPENMCP_NAME`, `OPENMCP_OPERATOR`, `OPENMCP_REFRESH_MINUTES` (10) and `OPENMCP_SYNC_MINUTES` (30) do the same from the environment. Without an admin token, removing other people's relays and managing peers are off; registration is always open.

Sign-in links go out through [Resend](https://resend.com): set `RESEND_API_KEY` and `MAIL_FROM` (`Name <address>` on a domain Resend has verified). Without a key, mail is off and the link is printed to the log instead, which is enough for a local run.

`OPENMCP_HOSTED=obscura` serves the Obscura relay from the same process, at `obscura.<catalog host>` (point that name at the same service, so the probe finds the descriptor on the relay's own origin and lists it verified) and under `/hosted/obscura` on the catalog's own origin. It needs the `obscura` binary on the `PATH` or at `OBSCURA_BIN`; the `Dockerfile` bundles release 0.2.2 from [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura) on Debian, because the binary wants glibc 2.35. Three fetches at a time, a minute each at most, a megabyte of output, public hosts only.

The `Dockerfile` builds the image; `.github/workflows/image.yml` builds it on every push and publishes `ghcr.io/logicsrc/openmcp` (tagged by commit, by branch, `latest` from main, and by version from a `v*` tag). Production pulls that image, so what ships is what was built and tested, and no hosted builder is in the path. `railway.json` describes the one service, with a volume at `/data`. The live catalog is [openmcp.logicsrc.com](https://openmcp.logicsrc.com), with Obscura at [obscura.openmcp.logicsrc.com](https://obscura.openmcp.logicsrc.com).

## For people

`GET /` with a browser's `Accept` header is the directory; with anything else it is the JSON index, so agents see no change. `/relays` is always the directory, `/relays/:id` one relay with its tools and schemas, `/tags` every tag in use.

`/sign-up` and `/sign-in` are one form: an email address, and a link arrives that signs you in and, the first time, makes the account. The answer is the same whether or not the address is known, five links an hour, twenty minutes each, once only. `/me` is your relays: add one by any URL on its origin, probe it again, remove it. A relay you register while signed in is yours; one already registered by somebody else stays theirs, and one registered anonymously belongs to nobody until its next registration by a signed-in person. Form posts are accepted from this site only.

The same over REST: `POST /v1/auth/magic {email}`, then the link sets the `openmcp_session` cookie; `GET /v1/me` is you and your relays; `DELETE /v1/relays/:id` works with that cookie for your own relays as well as with the admin token for any.

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
| Remove | `DELETE /v1/relays/:id` (owner's session, or admin) | | `relay.removed` |
| Sign in | `POST /v1/auth/magic {email}`, `GET /v1/me` | | |
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
