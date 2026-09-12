#!/usr/bin/env node
// The compiled CLI. `npm run build` writes dist/ from src/; a checkout runs
// `node --experimental-strip-types src/cli.ts` just as well, but a package
// under node_modules cannot be type-stripped, so what ships is JavaScript.
import { main } from "../dist/cli.js";
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
