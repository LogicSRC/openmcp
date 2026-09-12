/**
 * The one-line installer: served by every catalog, named on every page, and
 * the three words on the command that read what it wrote.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/db.ts";
import { installDir, installLine, readManifest, uninstall, update, whereIsIt, type Io } from "../src/manage.ts";
import { createApp } from "../src/server.ts";

const script = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

function capture(env: NodeJS.ProcessEnv, exec?: Io["exec"]): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, env, exec, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

test("install.sh is POSIX sh, names the package, and defaults to the public catalog", () => {
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.match(script, /PKG="@logicsrc\/openmcp"/);
  assert.match(script, /SITE="\$\{OPENMCP_SITE:-https:\/\/openmcp\.logicsrc\.com\}"/);
  // Never root, never a system prefix: everything under $PREFIX, default ~/.local.
  assert.match(script, /PREFIX="\$\{OPENMCP_PREFIX:-\$HOME\/\.local\}"/);
  assert.doesNotMatch(script, /\bsudo\b/);
  // Node 24 is fetched from nodejs.org when the box has none, and checked against SHASUMS256.
  assert.match(script, /NODE_LINE="v24\.x"/);
  assert.match(script, /nodejs\.org\/dist\/latest-\$NODE_LINE\/SHASUMS256\.txt/);
  assert.match(script, /--strip-components=1/);
  // What it wrote, and how to undo it, both left behind.
  assert.match(script, /manifest\.json/);
  assert.match(script, /uninstall\.sh/);
});

test("every catalog serves the installer at /install.sh, pointing update back at itself", async () => {
  const store = new Catalog(":memory:");
  const app = createApp({ store, url: "https://catalog.example", fetch: (async () => new Response("no", { status: 502 })) as typeof fetch });
  const res = await app.request("https://catalog.example/install.sh");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/x-shellscript/);
  const body = await res.text();
  assert.ok(body.startsWith("#!/bin/sh\n"));
  assert.match(body, /SITE="\$\{OPENMCP_SITE:-https:\/\/catalog\.example\}"/);
  assert.doesNotMatch(body, /openmcp\.logicsrc\.com\}"/);
  store.close();
});

test("the directory and a relay page both carry the install line for this catalog", async () => {
  const store = new Catalog(":memory:");
  const app = createApp({ store, url: "https://catalog.example", fetch: (async () => new Response("no", { status: 502 })) as typeof fetch });
  const home = await (await app.request("https://catalog.example/", { headers: { accept: "text/html" } })).text();
  assert.ok(home.includes("curl -fsSL https://catalog.example/install.sh | sh"), "directory names the installer");
  assert.ok(home.includes("openmcp update"), "and the update word");
  store.close();
  assert.equal(installLine("https://catalog.example"), "curl -fsSL https://catalog.example/install.sh | sh");
  assert.equal(installLine(), "curl -fsSL https://openmcp.logicsrc.com/install.sh | sh");
});

test("update, uninstall and where read the manifest the installer wrote, and say so when there is none", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmcp-install-"));
  try {
    const env = { OPENMCP_HOME: join(root, "share") };
    assert.equal(installDir(env), join(root, "share"));
    assert.equal(installDir({ HOME: "/home/x" }), "/home/x/.local/share/openmcp");

    // Nothing installed by the installer: each word explains instead of guessing.
    const none = capture(env);
    assert.equal(await whereIsIt(none), 0);
    assert.match(none.lines.join("\n"), /Not installed by the installer/);
    assert.equal(await update(none), 1);
    assert.match(none.errors.join("\n"), /npm install -g @logicsrc\/openmcp@latest/);
    assert.equal(await uninstall(none, { yes: true }), 1);
    assert.equal(await readManifest(env), null);

    // What install.sh leaves behind.
    mkdirSync(env.OPENMCP_HOME, { recursive: true });
    const manifest = {
      package: "@logicsrc/openmcp",
      version: "0.3.0",
      installer: "https://catalog.example/install.sh",
      installedAt: "2026-09-12T18:00:00Z",
      prefix: root,
      node: "private",
      paths: [join(root, "bin", "openmcp"), env.OPENMCP_HOME],
    };
    writeFileSync(join(env.OPENMCP_HOME, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(env.OPENMCP_HOME, "uninstall.sh"), "#!/bin/sh\necho removed\n");

    const where = capture(env);
    assert.equal(await whereIsIt(where), 0);
    assert.equal(where.lines[0], "@logicsrc/openmcp 0.3.0");
    assert.ok(where.lines.some((line) => line.includes("node       private")));
    assert.ok(where.lines.some((line) => line.includes(`path       ${join(root, "bin", "openmcp")}`)));

    // A dry uninstall lists the paths and removes nothing.
    const dry = capture(env);
    assert.equal(await uninstall(dry, { yes: false }), 0);
    assert.ok(dry.lines.some((line) => line.includes("openmcp uninstall --yes")));
    assert.deepEqual(await readManifest(env), manifest);

    // The real one runs the script the installer wrote, and nothing else.
    const ran: Array<{ file: string; args: string[] }> = [];
    const exec: Io["exec"] = async (file, args) => {
      ran.push({ file, args });
      return { stdout: "removed\n", stderr: "" };
    };
    const real = capture(env, exec);
    assert.equal(await uninstall(real, { yes: true }), 0);
    assert.deepEqual(ran, [{ file: "sh", args: [join(env.OPENMCP_HOME, "uninstall.sh")] }]);
    assert.deepEqual(real.lines, ["removed"]);

    // Update re-runs the installer the manifest names, so it comes back to the same catalog.
    ran.length = 0;
    const upd = capture(env, exec);
    assert.equal(await update(upd), 0);
    assert.deepEqual(ran, [{ file: "sh", args: ["-c", "curl -fsSL https://catalog.example/install.sh | sh"] }]);
    assert.match(upd.lines[0] ?? "", /Updating @logicsrc\/openmcp \(0\.3\.0 installed\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
