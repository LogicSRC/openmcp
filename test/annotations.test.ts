/** Every tool carries a human title and explicit hint booleans, as the Claude and ChatGPT directories require. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS as CATALOG_TOOLS } from "../src/mcp/tools.ts";
import { TOOLS as OBSCURA_TOOLS } from "../src/hosted/obscura.ts";

for (const [label, tools] of [["catalog", CATALOG_TOOLS], ["obscura", OBSCURA_TOOLS]] as const) {
  test(`every ${label} tool has a title and readOnly/destructive/openWorld hints`, () => {
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.ok(tool.title && tool.title.trim(), `${tool.name} has no title`);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} lacks ${hint}`);
      }
      if (tool.annotations?.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is read-only but destructive`);
    }
  });
}
