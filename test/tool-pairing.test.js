// Regression guard for the assistant tool-name pairing.
//
// The renderer dispatches tool calls against a hand-maintained KNOWN_TOOLS
// list (renderer.js) that must mirror the tools declared in assistantTools()
// (main.js). A tool added to assistantTools() but forgotten in KNOWN_TOOLS
// would make the renderer answer every call to it with "Unknown tool:
// <name>" — the model cannot self-correct from that, so the tool silently
// stops working. A tool removed from assistantTools() but left in
// KNOWN_TOOLS would pass the renderer gate and then be rejected by the main
// process. Pure-Node `npm test` cannot exercise the real Realtime dispatch,
// so this statically enforces the exact set match.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url);

function readSource(name) {
  return readFileSync(new URL(name, SRC), "utf8");
}

test("renderer KNOWN_TOOLS exactly matches the tools declared in assistantTools()", () => {
  const main = readSource("main.js");
  const fnStart = main.indexOf("function assistantTools");
  assert.ok(fnStart !== -1, "main.js must define assistantTools");
  // The function body runs until the next top-level statement; the comment
  // right after it is a stable boundary.
  const fnBody = main.slice(fnStart, main.indexOf("// Keep the model inside"));
  const declared = [...fnBody.matchAll(/name: "([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(declared.length > 0, "assistantTools must declare at least one tool");

  const renderer = readSource("renderer.js");
  const knownMatch = renderer.match(/const KNOWN_TOOLS = \[([^\]]+)\]/);
  assert.ok(knownMatch, "renderer.js must define the KNOWN_TOOLS array literal");
  const known = [...knownMatch[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(known.length > 0, "KNOWN_TOOLS must list at least one tool");

  assert.deepEqual(
    [...declared].sort(),
    [...known].sort(),
    "KNOWN_TOOLS must contain exactly the tools declared in assistantTools(): a tool declared without a KNOWN_TOOLS entry would be answered with 'Unknown tool' and silently stop working",
  );
});
