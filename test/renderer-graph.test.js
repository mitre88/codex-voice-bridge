// Regression guard for the sandboxed-renderer import contract.
//
// The renderer runs with sandbox:true and nodeIntegration:false, so its
// <script type="module"> uses Chromium's ESM loader, which cannot resolve
// node: builtins (e.g. "node:path") — the whole module graph fails to load.
// This test statically enforces that the renderer only imports browser-safe
// modules and that renderer-utils.js (the module it imports) has zero
// imports. Pure-Node `npm test` would otherwise never catch a regression
// like renderer.js importing lib.js (which imports node:path).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url);

function readSource(name) {
  return readFileSync(new URL(name, SRC), "utf8");
}

test("renderer.js imports only browser-safe modules (no node: builtins)", () => {
  const renderer = readSource("renderer.js");
  const specifiers = [...renderer.matchAll(/^\s*import\s[^;]+?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, "renderer.js should have at least one import");
  for (const specifier of specifiers) {
    assert.ok(
      !specifier.startsWith("node:"),
      `renderer.js must not import a node builtin ("${specifier}"): the sandboxed renderer cannot resolve it`,
    );
    assert.equal(
      specifier,
      "./renderer-utils.js",
      `renderer.js may only import ./renderer-utils.js (got "${specifier}")`,
    );
  }
});

test("renderer-utils.js has zero imports (loadable in a sandboxed renderer)", () => {
  const utils = readSource("renderer-utils.js");
  assert.ok(!/^\s*import\b/m.test(utils), "renderer-utils.js must not import anything");
  assert.ok(!utils.includes('from "node:'), 'renderer-utils.js must not reference "node:" specifiers');
});

test("renderer.js enables Disconnect at connect start so mid-connect cancel works", () => {
  // A connect can take tens of seconds (token fetch + SDP exchange). The
  // Disconnect button must be clickable while "Connecting" so the abort
  // controller can cancel the in-flight connect; if it is only enabled after
  // the session comes up, the user is stuck waiting out the full timeout.
  const renderer = readSource("renderer.js");
  const connectStart = renderer.indexOf("async function connectRealtime()");
  assert.ok(connectStart !== -1, "renderer.js must define connectRealtime");
  const connectBody = renderer.slice(connectStart, renderer.indexOf("async function disconnectRealtime()"));
  assert.match(
    connectBody,
    /disconnectButton\.disabled = false/,
    "connectRealtime must enable the Disconnect button before the connect begins",
  );
  assert.ok(
    connectBody.indexOf("connectAbortController = new AbortController()") >
      connectBody.indexOf("disconnectButton.disabled = false"),
    "Disconnect must be enabled before the abort controller is created so the cancel path is reachable",
  );
});

test("connect failures surface the humanized error in the status, not just the debug log", () => {
  // A failed connect (bad key, no network, quota, ...) used to leave the
  // status pill at a bare "Error" while the actionable humanized message went
  // only to the collapsible debug log — the user had to know to expand it to
  // learn why the connect failed. The status must carry the message itself,
  // with an explicit "error" state so the error styling (dimmed orb) still
  // applies to the longer text.
  const renderer = readSource("renderer.js");
  const connectStart = renderer.indexOf("async function connectRealtime()");
  assert.ok(connectStart !== -1, "renderer.js must define connectRealtime");
  const connectBody = renderer.slice(connectStart, renderer.indexOf("async function disconnectRealtime()"));
  assert.match(
    connectBody,
    /setStatus\(`Error: \$\{message\}`, "error"\)/,
    "connectRealtime must show the humanized error in the status pill with the error state",
  );
  assert.ok(
    connectBody.indexOf("const message = humanizeError(error)") <
      connectBody.indexOf("setStatus(`Error: ${message}`"),
    "the status must use the humanized error message, not the raw error",
  );
});

test("lib.js re-exports the renderer helpers for a single import surface", async () => {
  const lib = await import("../src/lib.js");
  assert.equal(typeof lib.humanizeError, "function");
  assert.equal(typeof lib.truncateOutput, "function");
  assert.equal(typeof lib.hasVirtualAudioDevice, "function");
  assert.ok(lib.VIRTUAL_AUDIO_LABEL instanceof RegExp);
});
