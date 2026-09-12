/** Bulk registration: a pasted list probed in the background, listed as the registrant's, the rest reported. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { Catalog } from "../src/db.ts";
import { createApp } from "../src/server.ts";

function relay(name: string): Hono {
  const app = new Hono();
  app.get("/.well-known/openmcp.json", (c) => c.json({ openmcp: "0.1", mcp: "/mcp", name }));
  app.post("/mcp", async (c) => {
    const body = (await c.req.json()) as { id?: number; method: string };
    if (body.id === undefined) return c.body(null, 202);
    if (body.method === "initialize") return c.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name, version: "1" }, capabilities: {} } });
    if (body.method === "tools/list") return c.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] } });
    return c.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
  });
  return app;
}

test("POST /v1/relays/bulk probes a list in the background and the job fills in", async () => {
  const hosts: Record<string, Hono> = { "a.example": relay("A"), "b.example": relay("B") };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const app = hosts[u.host];
    if (!app) return new Response("nope", { status: 502 });
    return app.request(u.toString(), { method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ?? undefined });
  }) as typeof fetch;
  const store = new Catalog();
  const catalog = createApp({ store, url: "https://cat.example", fetch: fetcher });
  const started = await catalog.request("https://cat.example/v1/relays/bulk", { method: "POST", headers: { "content-type": "text/plain" }, body: "a.example\nhttps://b.example/mcp, www.a.example\nnowhere.example\n" });
  assert.equal(started.status, 202);
  const { job } = (await started.json()) as { job: { id: string; total: number } };
  assert.equal(job.total, 3);
  let done: { finishedAt: string | null; results: Array<{ url: string; ok: boolean; id?: string; error?: string }> } = { finishedAt: null, results: [] };
  for (let i = 0; i < 100 && !done.finishedAt; i++) {
    await new Promise((r) => setTimeout(r, 25));
    done = ((await (await catalog.request(`https://cat.example/v1/relays/bulk/${job.id}`)).json()) as { job: typeof done }).job;
  }
  assert.ok(done.finishedAt, "the job finished");
  assert.deepEqual(done.results.filter((r) => r.ok).map((r) => r.id).sort(), ["a.example", "b.example"]);
  assert.match(done.results.find((r) => !r.ok)?.error ?? "", /nowhere.example/);
  assert.equal(store.counts().relays, 2);
  const html = await (await catalog.request(`https://cat.example/bulk/${job.id}`, { headers: { accept: "text/html" } })).text();
  assert.match(html, /2 listed, 1 did not answer/);
  assert.equal((await catalog.request("https://cat.example/v1/relays/bulk/nope")).status, 404);
  assert.equal((await catalog.request("https://cat.example/v1/relays/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
});
