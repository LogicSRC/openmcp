/**
 * The directory, for people.
 *
 * Every page is one function returning a string: no templates, no framework,
 * no client script beyond a form. The same records the REST and MCP doors
 * serve, laid out to be read; a signed-in person also gets a page of their
 * own relays with the three things they can do to one: add, probe again,
 * remove.
 */
import type { RelayRecord } from "./spec.ts";
import type { SessionUser } from "./auth.ts";
import { installLine } from "./manage.ts";

export const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

const CSS = `
:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b6860; --line: #e2dfd7; --card: #ffffff; --accent: #7c5cfc; --ok: #1a8f4e; --warn: #b7791f; --bad: #c0392b; --chip: #efece5; }
@media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #ece9e2; --muted: #9b978e; --line: #2c2b28; --card: #1e1d1b; --chip: #2a2926; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
header { border-bottom: 1px solid var(--line); }
header .in { max-width: 1040px; margin: 0 auto; padding: 14px 20px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
header .brand { font-weight: 700; color: var(--fg); letter-spacing: .01em; }
header nav { display: flex; gap: 14px; margin-left: auto; align-items: center; flex-wrap: wrap; }
main { max-width: 1040px; margin: 0 auto; padding: 24px 20px 60px; }
h1 { font-size: 26px; margin: 0 0 6px; } h2 { font-size: 18px; margin: 28px 0 10px; }
p.lead { color: var(--muted); margin: 0 0 18px; max-width: 70ch; }
form.search { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 18px; }
input[type=text], input[type=email], input[type=url] { flex: 1 1 260px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); font: inherit; }
button, .btn { padding: 9px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
button.quiet { background: transparent; color: var(--fg); border-color: var(--line); }
button.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 18px; }
.chip { background: var(--chip); color: var(--fg); border-radius: 999px; padding: 2px 10px; font-size: 13px; }
.chip.on { background: var(--accent); color: #fff; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.card h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.card p { margin: 0; color: var(--muted); font-size: 14px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); align-items: center; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
.dot.on { background: var(--ok); }
.tools { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
pre { background: var(--chip); padding: 12px; border-radius: 8px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; } th { font-size: 13px; color: var(--muted); }
.flash { padding: 10px 14px; border-radius: 8px; background: var(--chip); margin: 0 0 18px; }
.flash.bad { border: 1px solid var(--bad); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.empty { color: var(--muted); padding: 30px 0; }
footer { max-width: 1040px; margin: 0 auto; padding: 20px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); }
.narrow { max-width: 460px; }
`;

export interface PageContext {
  siteName: string;
  url: string;
  user: SessionUser | null;
  counts: { relays: number; online: number };
}

export function layout(ctx: PageContext, title: string, body: string): string {
  const nav = ctx.user
    ? `<a href="/me">My relays</a><span class="meta">${esc(ctx.user.email)}</span><form method="post" action="/auth/sign-out" style="display:inline"><button class="quiet" type="submit">Sign out</button></form>`
    : `<a href="/sign-in">Sign in</a><a class="btn" href="/sign-up">Add your relay</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(ctx.siteName)}</title>
<meta name="description" content="A catalog of MCP relays: MCP servers you can reach over HTTP, verified against what they say about themselves.">
<link rel="alternate" type="application/json" href="/.well-known/openmcp.json">
<style>${CSS}</style></head>
<body><header><div class="in"><a class="brand" href="/">${esc(ctx.siteName)}</a><span class="meta">${ctx.counts.relays} relays · ${ctx.counts.online} online</span><nav><a href="/tags">Tags</a><a href="https://logicsrc.com/openmcp">Spec</a><a href="/.well-known/openmcp.json">JSON</a>${nav}</nav></div></header>
<main>${body}</main>
<footer>An <a href="https://logicsrc.com/openmcp">OpenMCP</a> catalog. Agents: <code>POST ${esc(ctx.url)}/mcp</code> or <code>GET ${esc(ctx.url)}/v1/relays</code>. From a terminal: <code>${esc(installLine(ctx.url))}</code>. Maintained by <a href="https://profullstack.com">Profullstack</a>.</footer>
</body></html>`;
}

const status = (r: RelayRecord): string =>
  `<span class="meta"><span class="dot${r.online ? " on" : ""}"></span>${r.online ? "online" : "offline"}${r.verified ? " · verified" : " · unverified"}${r.seenAt ? ` · seen ${esc(r.seenAt.slice(0, 10))}` : ""}</span>`;

function card(r: RelayRecord): string {
  const d = r.descriptor;
  const tags = (d.tags ?? []).slice(0, 6).map((t) => `<a class="chip" href="/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join("");
  const tools = r.tools.slice(0, 8).map((t) => `<code>${esc(t.name)}</code>`).join(" ");
  return `<article class="card"><h3><a href="/relays/${encodeURIComponent(r.id)}">${esc(d.name ?? r.id)}</a></h3>${status(r)}<p>${esc(d.description ?? "No description served.")}</p>${tools ? `<div class="tools">${tools}${r.tools.length > 8 ? ` +${r.tools.length - 8}` : ""}</div>` : ""}<div class="chips">${tags}</div></article>`;
}

export function directoryPage(ctx: PageContext, input: { relays: RelayRecord[]; q?: string; tag?: string; tags: Array<{ tag: string; count: number }> }): string {
  const chips = input.tags.slice(0, 24).map((t) => `<a class="chip${t.tag === input.tag ? " on" : ""}" href="/?tag=${encodeURIComponent(t.tag)}">${esc(t.tag)} <small>${t.count}</small></a>`).join("");
  const list = input.relays.length ? `<div class="grid">${input.relays.map(card).join("")}</div>` : `<p class="empty">Nothing listed matches. <a href="/sign-up">Add your relay</a> and it will be probed and listed.</p>`;
  return layout(
    ctx,
    input.q ? `Relays matching "${input.q}"` : input.tag ? `Relays tagged ${input.tag}` : "Relays",
    `<h1>MCP relays you can reach</h1><p class="lead">MCP servers over HTTP, listed by what they offer and verified against what they say about themselves. What is listed is what the probe found. Any agent that can reach this catalog can reach every relay in it.</p>
<form class="search" method="get" action="/"><input type="text" name="q" placeholder="Search names, descriptions, tags and tool names" value="${esc(input.q ?? "")}"><button type="submit">Search</button>${input.tag ? `<input type="hidden" name="tag" value="${esc(input.tag)}">` : ""}</form>
<div class="chips">${input.tag ? `<a class="chip" href="/">all</a>` : ""}${chips}</div>${list}
<h2>From a terminal</h2><pre>${esc(installLine(ctx.url))}
openmcp relays                       # what is listed here
openmcp find "fetch a page"          # search every relay's tools
openmcp add https://your.site        # register a relay you operate</pre><p class="meta">One line, under your home directory, no root; Node 24 is fetched if the box has none. <code>openmcp update</code> and <code>openmcp uninstall</code> do what they say.</p>`,
  );
}

export function tagsPage(ctx: PageContext, tags: Array<{ tag: string; count: number }>): string {
  const rows = tags.map((t) => `<tr><td><a href="/?tag=${encodeURIComponent(t.tag)}">${esc(t.tag)}</a></td><td>${t.count}</td></tr>`).join("");
  return layout(ctx, "Tags", `<h1>Tags</h1><p class="lead">Free-form and lowercase, as each relay serves them.</p><table><tr><th>Tag</th><th>Relays</th></tr>${rows || `<tr><td colspan="2" class="empty">No tags yet.</td></tr>`}</table>`);
}

export function relayPage(ctx: PageContext, r: RelayRecord, mine: boolean): string {
  const d = r.descriptor;
  const tools = r.tools.length
    ? `<table><tr><th>Tool</th><th>Description</th></tr>${r.tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.description ?? "")}${t.inputSchema ? `<details><summary class="meta">schema</summary><pre>${esc(JSON.stringify(t.inputSchema, null, 2))}</pre></details>` : ""}</td></tr>`).join("")}</table>`
    : `<p class="empty">No tools reported${r.online ? "" : "; the relay was offline at the last probe"}.</p>`;
  const auth = d.auth ? `${esc(d.auth.kind)}${d.auth.url ? ` (<a href="${esc(d.auth.url)}">get a credential</a>)` : ""}${d.auth.open?.length ? `; open without one: ${d.auth.open.map((t) => `<code>${esc(t)}</code>`).join(", ")}` : ""}` : "unstated";
  const actions = mine
    ? `<div class="row"><form method="post" action="/me/relays/${encodeURIComponent(r.id)}/refresh"><button class="quiet" type="submit">Probe again</button></form><form method="post" action="/me/relays/${encodeURIComponent(r.id)}/remove" onsubmit="return confirm('Remove this relay from the catalog?')"><button class="danger" type="submit">Remove</button></form></div>`
    : "";
  return layout(
    ctx,
    d.name ?? r.id,
    `<h1>${esc(d.name ?? r.id)}</h1>${status(r)}<p class="lead">${esc(d.description ?? "No description served.")}</p>${actions}
<table>
<tr><th>MCP endpoint</th><td><code>${esc(d.mcp)}</code></td></tr>
${d.url ? `<tr><th>Site</th><td><a href="${esc(d.url)}">${esc(d.url)}</a></td></tr>` : ""}
<tr><th>Auth</th><td>${auth}</td></tr>
<tr><th>Operator</th><td>${d.operator ? `<a href="${esc(d.operator)}">${esc(d.operator)}</a>` : "unstated"}</td></tr>
<tr><th>Tags</th><td>${(d.tags ?? []).map((t) => `<a class="chip" href="/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join(" ") || "none"}</td></tr>
${r.server?.name ? `<tr><th>Server</th><td>${esc(r.server.name)} ${esc(r.server.version ?? "")} · protocol ${esc(r.server.protocolVersion ?? "?")}</td></tr>` : ""}
<tr><th>Record</th><td>id <code>${esc(r.id)}</code> · first seen ${esc(r.firstSeenAt.slice(0, 10))}${r.failures ? ` · ${r.failures} failed probes` : ""}${r.lastError ? ` · last error: ${esc(r.lastError)}` : ""}${r.via ? ` · learned from ${esc(r.via)}` : ""}</td></tr>
<tr><th>Descriptor</th><td><a href="${esc(r.source)}">${esc(r.source)}</a></td></tr>
</table>
<h2>Tools</h2>${tools}
<h2>Use it</h2><pre>${esc(installLine(ctx.url))}   # once: the openmcp command, no root
openmcp call ${esc(r.id)} ${esc(r.tools[0]?.name ?? "<tool>")} '{}' --catalog ${esc(ctx.url)}
curl -X POST ${esc(ctx.url)}/v1/relays/${esc(r.id)}/call -H 'content-type: application/json' -d '{"tool":"${esc(r.tools[0]?.name ?? "<tool>")}","arguments":{}}'</pre>
<p class="meta"><a href="/v1/relays/${encodeURIComponent(r.id)}">This record as JSON</a></p>`,
  );
}

export function signInPage(ctx: PageContext, mode: "sign-in" | "sign-up", error?: string): string {
  const signUp = mode === "sign-up";
  return layout(
    ctx,
    signUp ? "Add your relay" : "Sign in",
    `<div class="narrow"><h1>${signUp ? "Add your relay" : "Sign in"}</h1><p class="lead">${signUp ? "Register relays you operate, probe them again whenever you like, and remove them. " : ""}Enter your email and we send a link. It works once and expires in 20 minutes. No password, ever.</p>
${error ? `<p class="flash bad">${esc(error)}</p>` : ""}
<form method="post" action="/${mode}" class="search"><input type="email" name="email" placeholder="you@example.com" required autocomplete="email"><button type="submit">Email me a link</button></form>
<p class="meta">${signUp ? `Already have relays here? <a href="/sign-in">Sign in</a>.` : `New here? <a href="/sign-up">Add your relay</a>.`}</p></div>`,
  );
}

export function linkSentPage(ctx: PageContext): string {
  return layout(ctx, "Check your email", `<div class="narrow"><h1>Check your email</h1><p class="lead">If that address can receive mail, a sign-in link is on its way. Open it on this device to be signed in here.</p></div>`);
}

export function linkFailedPage(ctx: PageContext): string {
  return layout(ctx, "That link did not work", `<div class="narrow"><h1>That link did not work</h1><p class="lead">It may have expired, or been used already. <a href="/sign-in">Ask for a new one</a>.</p></div>`);
}

export function mePage(ctx: PageContext, relays: RelayRecord[], flash?: { text: string; bad?: boolean }): string {
  const rows = relays.length
    ? relays
        .map(
          (r) => `<tr><td><a href="/relays/${encodeURIComponent(r.id)}">${esc(r.descriptor.name ?? r.id)}</a><br>${status(r)}</td><td><code>${esc(r.descriptor.mcp)}</code><br><span class="meta">${r.tools.length} tools</span></td><td><div class="row"><form method="post" action="/me/relays/${encodeURIComponent(r.id)}/refresh"><button class="quiet" type="submit">Probe again</button></form><form method="post" action="/me/relays/${encodeURIComponent(r.id)}/remove" onsubmit="return confirm('Remove this relay from the catalog?')"><button class="danger" type="submit">Remove</button></form></div></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="empty">You have not registered a relay yet.</td></tr>`;
  return layout(
    ctx,
    "My relays",
    `<h1>My relays</h1><p class="lead">Signed in as ${esc(ctx.user?.email ?? "")}. A relay you register while signed in is yours to probe again or remove. What gets listed is what the probe finds at the relay, never what you type.</p>
${flash ? `<p class="flash${flash.bad ? " bad" : ""}">${esc(flash.text)}</p>` : ""}
<h2>Add a relay</h2><form method="post" action="/me/relays" class="search"><input type="url" name="url" placeholder="https://your.site (its /.well-known/openmcp.json, its MCP endpoint, or just the site)" required><button type="submit">Probe and list</button></form>
<p class="meta">No descriptor yet? <code>npx @logicsrc/openmcp descriptor https://your.site/mcp</code> prints one to serve at <code>/.well-known/openmcp.json</code>, and the listing becomes verified.</p>
<details><summary>Add many at once (up to 1,000)</summary><form method="post" action="/me/relays/bulk"><textarea name="urls" rows="8" style="width:100%;font:13px ui-monospace,monospace" placeholder="one relay URL or domain per line, or comma-separated"></textarea><p class="meta">Each is probed like a single registration: descriptor from its origin, then the MCP handshake. Those that answer are listed as yours; the rest are reported and nothing else happens.</p><button type="submit">Probe and list them all</button></form></details>
<h2>Registered by you</h2><table><tr><th>Relay</th><th>Endpoint</th><th></th></tr>${rows}</table>`,
  );
}

export function bulkPage(ctx: PageContext, job: { id: string; total: number; done: number; finishedAt: string | null; results: Array<{ url: string; ok: boolean; id?: string; online?: boolean; verified?: boolean; name?: string; tools?: number; error?: string }> }): string {
  const listed = job.results.filter((r) => r.ok);
  const failed = job.results.filter((r) => !r.ok);
  const rows = [...listed, ...failed]
    .map((r) => `<tr><td>${r.ok ? `<a href="/relays/${encodeURIComponent(r.id ?? "")}">${esc(r.name ?? r.id)}</a>` : esc(r.url)}</td><td>${r.ok ? `${r.online ? "online" : "offline"}${r.verified ? ", verified" : ""}, ${r.tools ?? 0} tools` : "not listed"}</td><td class="meta">${esc(r.error ?? r.url)}</td></tr>`)
    .join("");
  return layout(
    ctx,
    "Bulk registration",
    `${job.finishedAt ? "" : '<meta http-equiv="refresh" content="3">'}<h1>Bulk registration</h1><p class="lead">Job <code>${esc(job.id)}</code>: ${job.done} of ${job.total} probed${job.finishedAt ? "" : ", refreshing"}. ${listed.length} listed, ${failed.length} did not answer as a relay.</p>
<table><tr><th>Relay</th><th>Result</th><th>Detail</th></tr>${rows || '<tr><td colspan="3" class="empty">Probing.</td></tr>'}</table>
<p class="meta"><a href="/me">My relays</a> · <a href="/v1/relays/bulk/${esc(job.id)}">JSON</a></p>`,
  );
}
