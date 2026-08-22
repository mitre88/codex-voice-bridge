// Regression guard for the interview "Capture meeting audio" mode.
//
// The renderer calls navigator.mediaDevices.getDisplayMedia() to capture the
// meeting's audio (renderer.js). Electron denies getDisplayMedia in the
// renderer unless the main process registers
// session.setDisplayMediaRequestHandler; if that registration is ever
// removed, renamed, or paired with the wrong session, the interview connect
// fails with a permission error at runtime. Pure-Node `npm test` would
// otherwise never catch the regression, so this statically enforces the
// main/renderer pairing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url);

function readSource(name) {
  return readFileSync(new URL(name, SRC), "utf8");
}

test("main.js registers a display media handler (interview screen capture needs it)", () => {
  const main = readSource("main.js");
  assert.match(main, /setDisplayMediaRequestHandler/, "main.js must register a display media request handler");
  assert.match(main, /desktopCapturer\.getSources/, "the handler must resolve capture sources");
  assert.match(main, /types: \["screen"\]/, "the fallback picker must enumerate screens only — window lists are unused and expensive");
  assert.doesNotMatch(
    main,
    /types: \["screen", "window"\]/,
    "do not enumerate every window just to pick a screen source",
  );
  assert.match(main, /useSystemPicker/, "the handler should prefer the native system picker when available");
  assert.match(
    main,
    /getDisplayMedia/,
    "main.js should reference the renderer API it enables (keeps the pairing visible)",
  );
});

test("renderer.js requests display media only via getDisplayMedia", () => {
  const renderer = readSource("renderer.js");
  assert.match(renderer, /getDisplayMedia/, "renderer.js must call getDisplayMedia for meeting audio capture");
});
