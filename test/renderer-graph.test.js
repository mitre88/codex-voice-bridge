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
    connectBody.indexOf("new AbortController()") >
      connectBody.indexOf("disconnectButton.disabled = false"),
    "Disconnect must be enabled before the abort controller is created so the cancel path is reachable",
  );
});

test("a stale connect's catch cannot abort or overwrite a newer connect", () => {
  // The connect flow's abort checks and error path used to read the GLOBAL
  // connectAbortController. After a fast Disconnect → Connect, the first
  // (stale) connect's catch could see the NEW connect's controller: instead
  // of taking the quiet Idle path for its own cancelled connect it would
  // call disconnectRealtime({silent:true}) — aborting the new connect's
  // controller and flipping the UI to Error over a healthy connect (and a
  // stale connect that failed on its own would do the same). Each connect
  // must capture its controller locally; the error path must bail out when
  // the global no longer belongs to this connect, and the cancel check must
  // use the captured controller.
  const renderer = readSource("renderer.js");
  const connectStart = renderer.indexOf("async function connectRealtime()");
  assert.ok(connectStart !== -1, "renderer.js must define connectRealtime");
  const connectBody = renderer.slice(connectStart, renderer.indexOf("async function disconnectRealtime()"));
  assert.match(
    connectBody,
    /const controller = new AbortController\(\)/,
    "connectRealtime must capture the abort controller in a local before assigning the global",
  );
  assert.match(
    connectBody,
    /if \(connectAbortController !== controller\) return;/,
    "a stale connect must bail out of its error path instead of touching the UI or aborting a newer connect",
  );
  assert.match(
    connectBody,
    /if \(controller\.signal\.aborted\)/,
    "the cancel check must use the locally captured controller, not the global",
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

test("connect passes the abort signal to getUserMedia so Disconnect cancels a pending permission prompt", () => {
  // Disconnect mid-"Connecting" aborts the SDP fetch, but a connect stuck on
  // the microphone permission prompt would otherwise keep waiting on the OS
  // dialog after the UI went Idle; granting it would then start a pointless
  // token fetch + peer connection for a session the user cancelled. getUserMedia
  // must receive the connect abort signal (the controller captured at connect
  // start and threaded through, never the global — see the stale-connect test
  // below), and each stream acquisition must re-check the signal so a
  // cancelled connect stops the mic immediately.
  const renderer = readSource("renderer.js");
  const singleStart = renderer.indexOf("async function connectSingleRealtime");
  assert.ok(singleStart !== -1, "renderer.js must define connectSingleRealtime");
  const singleBody = renderer.slice(singleStart, renderer.indexOf("async function connectInterviewRealtime"));
  assert.match(
    singleBody,
    /signal: controller\?\.signal/,
    "connectSingleRealtime must pass the connect abort signal to getUserMedia",
  );
  assert.match(
    singleBody,
    /controller\?\.signal\.aborted/,
    "connectSingleRealtime must re-check the abort signal after acquiring the mic stream",
  );
  const interviewStart = renderer.indexOf("async function connectInterviewRealtime");
  assert.ok(interviewStart !== -1, "renderer.js must define connectInterviewRealtime");
  const interviewBody = renderer.slice(interviewStart, renderer.indexOf("async function connectRealtime"));
  assert.match(
    interviewBody,
    /signal: controller\?\.signal/,
    "connectInterviewRealtime must pass the connect abort signal to getUserMedia",
  );
  assert.ok(
    (interviewBody.match(/controller\?\.signal\.aborted/g) || []).length >= 2,
    "connectInterviewRealtime must re-check the abort signal after each stream acquisition",
  );
});

test("executeAction does not flip the status to Listening after a disconnect", () => {
  // A local action (e.g. a long Codex run) keeps running in the main process
  // after the user presses Disconnect; when it finishes, executeAction used to
  // setStatus("Listening") unconditionally, flipping the pill to "Listening"
  // over a session that is already gone (mic stopped, sessions closed) while
  // the Disconnect button stays disabled — the UI lied about the state. The
  // status must only be restored while a session is still active.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("async function executeAction");
  assert.ok(fnStart !== -1, "renderer.js must define executeAction");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("const KNOWN_TOOLS"));
  assert.match(
    fnBody,
    /if \(activeSessions\.length > 0\) setStatus\("Listening"\)/,
    "executeAction must only restore the Listening status while a session is still active",
  );
});

test("mac actions dispatch on the declared tool name, never on a model-supplied args.action", () => {
  // runMacAction switches on input.action, so the action field must be pinned
  // to the declared tool name. A model-supplied "action" key inside the args
  // would otherwise override it (spread-after-shadowing): a call declared as
  // open_app with a hallucinated args.action could silently execute a
  // different mac action than the one the model declared — and the one the
  // human approves in the pending panel. The declared name must always win.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("async function handleToolEvent");
  assert.ok(fnStart !== -1, "renderer.js must define handleToolEvent");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("function deviceConstraint"));
  assert.match(
    fnBody,
    /\{ \.\.\.args, action: functionCall\.name \}/,
    "the mac-action args must spread the model args BEFORE pinning action to the declared tool name",
  );
  assert.doesNotMatch(
    fnBody,
    /\{ action: functionCall\.name, \.\.\.args \}/,
    "action must not be set before the spread: a model-supplied args.action would override the declared tool name",
  );
});

test("tool calls with non-object args get a clean error instead of a raw TypeError", () => {
  // A well-formed JSON payload is not necessarily an object: "null", a bare
  // string, a number, or an array all parse successfully. The codex path
  // would then read action.args.prompt off null and throw a raw TypeError
  // inside executeAction — caught, but surfaced to the model as an opaque
  // "Cannot read properties of null" message — and an array/string would
  // reach the main process, where validation rejects it with a misleading
  // message. handleToolEvent must reject non-object args with a clean error
  // so the model can self-correct from the message.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("async function handleToolEvent");
  assert.ok(fnStart !== -1, "renderer.js must define handleToolEvent");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("function deviceConstraint"));
  assert.match(
    fnBody,
    /args === null \|\| typeof args !== "object"/,
    "handleToolEvent must reject null and other non-object args before they reach action.args.prompt",
  );
  assert.match(
    fnBody,
    /Array\.isArray\(args\)/,
    "handleToolEvent must reject array args (a JSON array parses but is not a valid tool-args object)",
  );
});

test("the config line displays the Codex workdir", () => {
  // app:config returns workdir (CODEX_VOICE_WORKDIR or the launch cwd — the
  // directory Codex operates on), but the config line used to render only
  // version/models/shortcut, silently dropping it: the user could not verify
  // which directory a voice coding-agent request would touch without opening
  // the debug log. The config line template must include config.workdir.
  const renderer = readSource("renderer.js");
  const assign = renderer.match(/baseConfigText = `([^`]*)`/);
  assert.ok(assign, "renderer.js must build baseConfigText from a template literal");
  assert.match(assign[1], /config\.workdir/, "the config line template must include config.workdir");
});

test("lib.js re-exports the renderer helpers for a single import surface", async () => {
  const lib = await import("../src/lib.js");
  assert.equal(typeof lib.humanizeError, "function");
  assert.equal(typeof lib.truncateOutput, "function");
  assert.equal(typeof lib.hasVirtualAudioDevice, "function");
  assert.ok(lib.VIRTUAL_AUDIO_LABEL instanceof RegExp);
});

test("sendFunctionOutput drops the pending send on timeout instead of sending it late", () => {
  // A function output deferred to a not-yet-open data channel used to keep its
  // once-listener alive after the 5s drop timeout: when the channel finally
  // opened, the "dropped" output was sent anyway — contradicting the log and
  // leaking a stale function_call_output (old callId from a dead session) into
  // whatever channel was open by then. The timeout must remove the listener so
  // a dropped output stays dropped, and the deferred send must target the
  // captured channel rather than the global (which may belong to a new
  // session after a reconnect).
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("function sendFunctionOutput");
  assert.ok(fnStart !== -1, "renderer.js must define sendFunctionOutput");
  const fnBody = renderer.slice(fnStart, renderer.indexOf('connectButton.addEventListener("click", connectRealtime)'));
  assert.match(
    fnBody,
    /channel\.removeEventListener\("open", onOpen\)/,
    "the drop timeout must remove the pending open listener so the output cannot be sent late",
  );
  assert.match(
    fnBody,
    /send\(channel\)/,
    "the deferred send must target the captured channel, not the global, so a stale output cannot leak into a later session",
  );
});

test("refreshMediaDevices survives a denied permission prompt so the list still refreshes", () => {
  // Switching to interview mode calls refreshMediaDevices(true), which asks
  // for microphone permission via getUserMedia to obtain device labels. If the
  // user denies (or dismisses) the prompt, getUserMedia rejects — and the old
  // code let that rejection abort the whole refresh before enumerateDevices
  // ran, leaving the dropdowns stale and logging a raw "Permission denied" on
  // every switch. The permission request must sit in its own try/catch so the
  // enumeration (and the list refresh) still runs with empty labels.
  const renderer = readSource("renderer.js");
  const refreshStart = renderer.indexOf("async function refreshMediaDevices");
  assert.ok(refreshStart !== -1, "renderer.js must define refreshMediaDevices");
  const refreshBody = renderer.slice(refreshStart, renderer.indexOf("async function getInterviewAudioStream"));
  const permissionRequest = refreshBody.indexOf("getUserMedia({ audio: true })");
  const enumeration = refreshBody.indexOf("enumerateDevices()");
  const catchIndex = refreshBody.indexOf("catch", permissionRequest);
  assert.ok(permissionRequest !== -1, "refreshMediaDevices must request mic permission when labels are wanted");
  assert.ok(enumeration !== -1, "refreshMediaDevices must enumerate devices");
  assert.ok(
    catchIndex !== -1 && permissionRequest < catchIndex && catchIndex < enumeration,
    "the getUserMedia permission request must be isolated in its own try/catch before enumerateDevices so a denied prompt cannot abort the refresh",
  );
});
