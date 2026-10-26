/**
 * The Profullstack network footer: off by default (someone else's catalog is
 * not in that network), server-rendered with both badges and the ring when on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../src/db.ts";
import { createApp } from "../src/server.ts";
import { obscuraRelay } from "../src/hosted/obscura.ts";
import { ringFooter, ringFooterEnabled } from "../src/ring-footer.ts";

process.env.PROFULLSTACK_FOOTER_OFFLINE = "1";
const mailer = { send: async () => {} } as never;
const html = { accept: "text/html,application/xhtml+xml" };

test("off unless PROFULLSTACK_FOOTER is set", async () => {
  delete process.env.PROFULLSTACK_FOOTER;
  assert.equal(ringFooterEnabled(), false);
  assert.equal(ringFooter("https://catalog.test/"), "");
  const app = createApp({ store: new Catalog(":memory:"), url: "https://catalog.test", mailer });
  const page = await (await app.request("/", { headers: html })).text();
  assert.ok(!page.includes("data-pfs-footer"));
  assert.equal((await app.request("/.well-known/openwebring.json")).status, 404);
});

test("on: the catalog and a hosted relay's page carry the ring and both badges", async () => {
  process.env.PROFULLSTACK_FOOTER = "1";
  try {
    const app = createApp({ store: new Catalog(":memory:"), url: "https://catalog.test", mailer, hosted: [obscuraRelay({ runner: async () => ({ ok: true, output: "", ms: 1 }) })] });
    const page = await (await app.request("/", { headers: html })).text();
    assert.match(page, /rssamplifier\.com\/ring\/profullstack/);
    assert.match(page, /built\.indie\.pit\.world\/for\.svg\?site=https%3A%2F%2Fcatalog\.test%2F|built\.indie\.pit\.world\/for\.svg\?site=https:\/\/catalog\.test\//);
    assert.match(page, /pwamart\.com\/for\.svg/);
    const ring = await (await app.request("/.well-known/openwebring.json")).json();
    assert.ok(JSON.stringify(ring).includes("profullstack"));

    const relay = await (await app.request("https://obscura.catalog.test/", { headers: { ...html, host: "obscura.catalog.test" } })).text();
    assert.match(relay, /<h1>Obscura<\/h1>/);
    assert.match(relay, /pwamart\.com\/for\.svg/);
    assert.match(relay, /obscura\.catalog\.test/);
    const json = await (await app.request("https://obscura.catalog.test/", { headers: { host: "obscura.catalog.test" } })).json();
    assert.equal((json as { name: string }).name, "Obscura");
  } finally {
    delete process.env.PROFULLSTACK_FOOTER;
  }
});
