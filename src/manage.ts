/**
 * Installing, updating and removing the command itself.
 *
 * These live on the command rather than in a second script, because a person
 * who installed with one line should not have to find a different URL to get
 * rid of it. install.sh writes a manifest listing every path it created and
 * an uninstall.sh beside it; `uninstall` runs that script, so removal is
 * exact and needs no network. `update` re-runs the installer named in the
 * manifest, which is the thing that knows about the shim, the private Node
 * and the manifest, and rewrites all three.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const INSTALL_SITE = "https://openmcp.logicsrc.com";

export interface Manifest {
  package: string;
  version: string;
  installer: string;
  installedAt: string;
  prefix: string;
  /** "system" when the shim runs `node` from PATH, "private" when the installer fetched one. */
  node?: string;
  paths: string[];
}

/** Where the installer put things. The shim it writes sets OPENMCP_HOME, so a normal invocation knows without searching. */
export function installDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENMCP_HOME ?? join(env.HOME ?? homedir(), ".local", "share", "openmcp");
}

export async function readManifest(env: NodeJS.ProcessEnv = process.env): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(installDir(env), "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** The line a person can paste, used in more than one message. */
export function installLine(site = INSTALL_SITE): string {
  return `curl -fsSL ${site}/install.sh | sh`;
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Runs a shell script or command; swapped out in tests. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

const defaultExec = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => run(file, args, { maxBuffer: 8 * 1024 * 1024 });

export async function update(io: Io): Promise<number> {
  const manifest = await readManifest(io.env);
  if (manifest === null) {
    // Not installed by the installer. Saying which situation this is beats
    // running npm against a tree this command does not own.
    io.err("This copy was not put here by the installer, so there is nothing for it to update.");
    io.err("");
    io.err("  installed with npm:  npm install -g @logicsrc/openmcp@latest");
    io.err(`  otherwise:           ${installLine()}`);
    return 1;
  }
  io.out(`Updating ${manifest.package} (${manifest.version} installed)...`);
  try {
    const { stdout, stderr } = await (io.exec ?? defaultExec)("sh", ["-c", `curl -fsSL ${manifest.installer} | sh`]);
    if (stdout) io.out(stdout.replace(/\n$/, ""));
    if (stderr.trim() !== "") io.err(stderr.replace(/\n$/, ""));
    return 0;
  } catch (error) {
    io.err(`The update failed: ${error instanceof Error ? error.message : String(error)}`);
    io.err(`Run it by hand:  ${installLine()}`);
    return 1;
  }
}

export async function uninstall(io: Io, options: { yes: boolean }): Promise<number> {
  const manifest = await readManifest(io.env);
  if (manifest === null) {
    io.err("This copy was not put here by the installer, so there is no manifest saying what to remove.");
    io.err("");
    io.err("  installed with npm:  npm uninstall -g @logicsrc/openmcp");
    return 1;
  }
  if (!options.yes) {
    io.out(`This will remove openmcp ${manifest.version}:`);
    io.out("");
    for (const path of manifest.paths) io.out(`  ${path}`);
    io.out("");
    io.out("Run it for real with:  openmcp uninstall --yes");
    return 0;
  }
  const script = join(installDir(io.env), "uninstall.sh");
  try {
    const { stdout } = await (io.exec ?? defaultExec)("sh", [script]);
    if (stdout) io.out(stdout.replace(/\n$/, ""));
    return 0;
  } catch (error) {
    io.err(`Could not run ${script}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function whereIsIt(io: Io): Promise<number> {
  const manifest = await readManifest(io.env);
  if (manifest === null) {
    io.out("Not installed by the installer.");
    io.out(`  ${installLine()}`);
    return 0;
  }
  io.out(`${manifest.package} ${manifest.version}`);
  io.out(`  installed  ${manifest.installedAt}`);
  io.out(`  prefix     ${manifest.prefix}`);
  if (manifest.node) io.out(`  node       ${manifest.node}`);
  for (const path of manifest.paths) io.out(`  path       ${path}`);
  return 0;
}
