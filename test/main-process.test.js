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

test("openAppVisible trims the url before validating and launching it", () => {
  // The app+url path used to validate the TRIMMED url (isSafeLaunchUrl trims
  // internally) but hand the RAW value to cua-driver via launchArgs.urls —
  // the launch only worked because runCuaDriver happens to re-trim urls
  // downstream. The string that passes validation must be the string that is
  // launched, so openAppVisible must normalize input.url once at the source
  // (same as resolveOpenAppTarget's URL-only path) and use the normalized
  // value for both the safety gate and launchArgs.urls.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function openAppVisible");
  assert.ok(fnStart !== -1, "main.js must define openAppVisible");
  const fnBody = main.slice(fnStart, main.indexOf("async function typeTextInFrontApp"));
  assert.match(
    fnBody,
    /const url = String\(input\.url\)\.trim\(\)/,
    "openAppVisible must normalize input.url (trim) once at the source",
  );
  assert.match(
    fnBody,
    /isSafeLaunchUrl\(url\)/,
    "openAppVisible must validate the normalized url, not the raw input.url",
  );
  assert.match(
    fnBody,
    /launchArgs\.urls = \[url\]/,
    "openAppVisible must launch the normalized url, not the raw input.url",
  );
  assert.doesNotMatch(
    fnBody,
    /launchArgs\.urls = \[input\.url\]/,
    "openAppVisible must not pass the raw input.url to cua-driver",
  );
});

test("writeLog swallows logging-path failures so error handlers cannot crash or loop", () => {
  // writeLog is called from the uncaughtException / unhandledRejection
  // handlers and from the log:renderer IPC handler. If the logging path
  // itself throws (e.g. the log directory cannot be created, mkdirSync
  // EACCES), the main-process error handlers would loop forever — each
  // failed log call raising another error that logs again — and the IPC
  // handler would reject, firing unhandledrejection in the renderer. The
  // whole body must be wrapped so every failure inside the logging path is
  // swallowed.
  const main = readSource("main.js");
  const fnStart = main.indexOf("function writeLog");
  assert.ok(fnStart !== -1, "main.js must define writeLog");
  const fnBody = main.slice(fnStart, main.indexOf("function runProcess"));
  assert.match(
    fnBody,
    /function writeLog\(message, data\) \{\n  try \{/,
    "writeLog must wrap its body in an outer try/catch",
  );
  assert.ok(
    fnBody.indexOf("try {") < fnBody.indexOf("getLogStream().write("),
    "the try must cover the log-stream write so a stream failure cannot throw",
  );
  assert.match(
    fnBody,
    /\n  \} catch \{\n    \/\/ Logging is best-effort/,
    "writeLog must swallow logging failures silently",
  );
});

test("runProcess swallows EPIPE on child stdin so an early-exiting child cannot raise an uncaught error", () => {
  // runProcess always ends child.stdin (empty, or the API key for the
  // keychain save). A child that exits without reading stdin — e.g. the
  // `security` command failing early on a locked keychain — breaks the pipe,
  // and the end()/write then emits EPIPE on the stdin stream. Without an
  // error listener that becomes an uncaught 'error' event (caught only by
  // the app-level handler, logged as a scary stack trace, or crashing the
  // main process if that handler is ever removed). The listener must be
  // attached before end() so the EPIPE from the write is already covered.
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runProcess");
  assert.ok(fnStart !== -1, "main.js must define runProcess");
  const fnBody = main.slice(fnStart, main.indexOf("async function readKeychainApiKey"));
  assert.match(
    fnBody,
    /child\.stdin\.on\("error"/,
    "runProcess must attach an error listener to child.stdin so a child that exits without reading stdin cannot raise an uncaught EPIPE",
  );
  assert.ok(
    fnBody.indexOf('child.stdin.on("error"') < fnBody.indexOf("child.stdin.end("),
    "the stdin error listener must be attached before end() so the EPIPE from the write is caught",
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

test("type/press tools surface the cua-driver failure instead of a generic no-active-app message", () => {
  // When list_apps itself fails (cua-driver missing, driver crash), the
  // type_text_in_front_app / press_key_in_front_app tools used to answer
  // "No active app pid found." — hiding the real driver error (e.g. ENOENT)
  // so the model could not self-correct. getActiveAppFromCua must carry the
  // driver's stderr through and both callers must prefer it over the generic
  // fallback when present.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function getActiveAppFromCua");
  assert.ok(fnStart !== -1, "main.js must define getActiveAppFromCua");
  const fnBody = main.slice(fnStart, main.indexOf("async function runCodex"));
  assert.match(
    fnBody,
    /error: result\.stderr/,
    "getActiveAppFromCua must return the driver stderr when list_apps fails",
  );
  const typeFn = main.slice(main.indexOf("async function typeTextInFrontApp"), main.indexOf("async function pressKeyInFrontApp"));
  const pressFn = main.slice(main.indexOf("async function pressKeyInFrontApp"), main.indexOf("async function getActiveAppFromCua"));
  for (const [label, fn] of [["typeTextInFrontApp", typeFn], ["pressKeyInFrontApp", pressFn]]) {
    assert.match(
      fn,
      /stderr: active\?\.error \|\| "No active app pid found\."/,
      `${label} must surface the driver error when getActiveAppFromCua provides one`,
    );
  }
});

test("pressKeyInFrontApp drops non-string modifier entries before calling cua-driver", () => {
  // cua-driver's press_key expects a modifiers array of strings; a malformed
  // model call carrying non-string entries (e.g. modifiers: ["cmd", 42] or
  // [["cmd"]]) would serialize garbage into json_args and make the driver
  // fail with an opaque error the model cannot self-correct from. The tool
  // must keep only string entries — a bare-string or non-array modifiers
  // already normalizes to [].
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function pressKeyInFrontApp");
  assert.ok(fnStart !== -1, "main.js must define pressKeyInFrontApp");
  const fnBody = main.slice(fnStart, main.indexOf("async function getActiveAppFromCua"));
  assert.match(
    fnBody,
    /\.filter\(\(modifier\) => typeof modifier === "string"\)/,
    "pressKeyInFrontApp must filter modifiers to strings",
  );
  assert.match(
    fnBody,
    /Array\.isArray\(input\.modifiers\)/,
    "pressKeyInFrontApp must keep the array-shape normalization",
  );
});

test("runCodex and openAppVisible cap argv-bound values like the prompt guard does", () => {
  // Every model-controlled value that becomes a single argv entry (prompt,
  // text, json_args, and now cwd + url) must go through the same
  // requireMaxLength gate: an unbounded value would otherwise make spawn()
  // fail with E2BIG (macOS ARG_MAX) and surface as an opaque spawn error
  // instead of a clean, self-correctable message. cwd is interpolated into
  // "--cd <workdir>" and url travels inside launchArgs.urls / the `open`
  // argv, so both must be capped at the source.
  const main = readSource("main.js");
  const codexFn = main.slice(main.indexOf("function runCodex"), main.indexOf("function runCuaDriver"));
  assert.match(
    codexFn,
    /requireMaxLength\(input\?\.cwd, "cwd", 4096\)/,
    "runCodex must cap the cwd argv entry",
  );
  const openFn = main.slice(main.indexOf("async function openAppVisible"), main.indexOf("async function typeTextInFrontApp"));
  assert.match(
    openFn,
    /requireMaxLength\(url, "url", 8192\)/,
    "openAppVisible must cap the url argv entry before launching",
  );
  // resolveOpenAppTarget (lib.js) applies the same cap to the URL-only path;
  // the app+url path must not be the only one capped.
  const lib = readSource("lib.js");
  assert.match(
    lib,
    /requireMaxLength\(input\.url, "url", 8192\)/,
    "resolveOpenAppTarget must cap the url-only path",
  );
});

test("runCuaDriver rejects unsafe launch_app args with a settled promise", () => {
  // Every rejection branch in runCuaDriver returns Promise.resolve(...) so
  // callers can await uniformly; the unsafe-launch_app branch must do the
  // same instead of returning a bare object.
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runCuaDriver");
  assert.ok(fnStart !== -1, "main.js must define runCuaDriver");
  const fnBody = main.slice(fnStart, main.indexOf("async function runMacAction"));
  assert.match(
    fnBody,
    /Promise\.resolve\(\{[\s\S]*?Rejected unsafe launch_app arguments/,
    "unsafe launch_app args must return a settled promise",
  );
});
