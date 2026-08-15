// Regression guard for runProcess streaming semantics.
//
// When a child process times out, the runProcess promise settles immediately
// with a timeout error, but the child keeps running (up to 3s until the
// SIGKILL) and can keep emitting stdout/stderr. If those late chunks were
// still forwarded via options.onOutput, the renderer would batch a dead run's
// tail into codexOutputBuffer and flush it into the NEXT run's debug log —
// misattributing output. The data handlers must stop streaming once the run
// has settled, so everything the renderer receives belongs to the run it is
// currently displaying. Pure-Node `npm test` cannot exercise the real child
// process machinery, so this statically enforces the guard.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url);

function readSource(name) {
  return readFileSync(new URL(name, SRC), "utf8");
}

test("openAppVisible reports the cua-driver launch result to the model, not just activation", () => {
  // openAppVisible combines two independent steps (cua-driver launch_app +
  // osascript activate) into one ok flag, but its stdout used to report only
  // the activation: a launch that failed (app not installed, cua-driver
  // missing) while activation still succeeded — or vice versa — left the model
  // with no hint which step failed, and hid the driver's own launch output
  // (e.g. the resolved pid). The stdout must carry both outcomes plus the
  // launch output so the model can self-correct from the specific failure.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function openAppVisible");
  assert.ok(fnStart !== -1, "main.js must define openAppVisible");
  const fnBody = main.slice(fnStart, main.indexOf("async function typeTextInFrontApp"));
  assert.match(
    fnBody,
    /launched: cuaResult\.ok/,
    "openAppVisible stdout must report whether the cua-driver launch succeeded",
  );
  assert.match(
    fnBody,
    /activated: activateResult\.ok/,
    "openAppVisible stdout must keep reporting the activation result",
  );
  assert.match(
    fnBody,
    /launchOutput: cuaResult\.stdout/,
    "openAppVisible stdout must include the driver's own launch output",
  );
});

test("runProcess stops streaming child output to the renderer once the run has settled", () => {
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runProcess");
  assert.ok(fnStart !== -1, "main.js must define runProcess");
  const fnBody = main.slice(fnStart, main.indexOf("async function readKeychainApiKey"));
  // Both the stdout and stderr data handlers must gate options.onOutput on
  // the settled flag so a timed-out run's late chunks cannot reach the
  // renderer and be flushed into a later run's debug log.
  const guardedCalls = fnBody.match(/if \(!settled\) options\.onOutput\?\.\(text\)/g) || [];
  assert.ok(
    guardedCalls.length >= 2,
    "both stdout and stderr data handlers must guard options.onOutput with !settled",
  );
  // The settled flag must be declared before the data handlers are attached so
  // the guard refers to the same flag finish() flips.
  assert.ok(
    fnBody.indexOf("let settled = false") < fnBody.indexOf('child.stdout.on("data"'),
    "settled must be declared before the stdout data handler",
  );
});
