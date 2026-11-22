/**
 * robots.txt and sitemap.xml: each origin (the catalog, a hosted relay's own
 * subdomain) lists only its own URLs and points robots at its own sitemap.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../src/db.ts";
import { createApp } from "../src/server.ts";
import { obscuraRelay } from "../src/hosted/obscura.ts";

const quietMailer = { enabled: false, async send() { return { ok: true }; } };

test("catalog and hosted relay each serve their own robots.txt and sitemap.xml", async () => {
  const store = new Catalog();
  const hosted = [obscuraRelay({ runner: async () => ({ ok: true, output: "", ms: 1 }) })];
  const app = createApp({ store, url: "https://catalog.test", mailer: quietMailer, hosted, fetch: (async () => new Response("", { status: 502 })) as typeof fetch });

  let response = await app.request("/sitemap.xml", { headers: { host: "catalog.test" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/xml/);
  let xml = await response.text();
  assert.match(xml, /<urlset /);
  assert.match(xml, /<loc>https:\/\/catalog\.test\/relays<\/loc>/);
  for (const loc of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) assert.ok(loc[1].startsWith("https://catalog.test/"), loc[1]);

  response = await app.request("/robots.txt", { headers: { host: "catalog.test" } });
  assert.equal(response.status, 200);
  let robots = await response.text();
  assert.match(robots, /^Sitemap: https:\/\/catalog\.test\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /Disallow: \/sitemap/);

  response = await app.request("/sitemap.xml", { headers: { host: "obscura.catalog.test" } });
  assert.equal(response.status, 200);
  xml = await response.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, ["https://obscura.catalog.test/"]);

  response = await app.request("/robots.txt", { headers: { host: "obscura.catalog.test" } });
  robots = await response.text();
  assert.match(robots, /^Sitemap: https:\/\/obscura\.catalog\.test\/sitemap\.xml$/m);
});
