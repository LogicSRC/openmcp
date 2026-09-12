#!/usr/bin/env node
// Node 24 strips the types itself; nothing here is compiled.
import { main } from "../src/cli.ts";
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
