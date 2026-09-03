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

test("renderer window error handlers swallow log failures so a rejected log IPC cannot loop", () => {
  // The window "error" / "unhandledrejection" handlers forward to the
  // log:renderer IPC. If that IPC ever rejects, an unhandled rejection from
  // the handler's own log call would fire "unhandledrejection" again —
  // which calls log again — looping forever and spamming the main process.
  // Both handlers must catch the promise rejection to break the loop.
  const renderer = readSource("renderer.js");
  const errorHandler = renderer.slice(
    renderer.indexOf('window.addEventListener("error"'),
    renderer.indexOf('window.addEventListener("unhandledrejection"'),
  );
  assert.match(
    errorHandler,
    /\.catch\(\(\) => \{\}\)/,
    "the window error handler must catch log promise rejections",
  );
  const rejectionHandler = renderer.slice(
    renderer.indexOf('window.addEventListener("unhandledrejection"'),
    renderer.indexOf("function setStatus"),
  );
  assert.match(
    rejectionHandler,
    /\.catch\(\(\) => \{\}\)/,
    "the unhandledrejection handler must catch log promise rejections",
  );
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

test("connect reveals the API key input when the key itself was rejected", () => {
  // The key input is hidden whenever ANY key exists (saved, env, or
  // in-memory), so a saved key that gets revoked or expires leaves the input
  // invisible while the 401 message tells the user to "save it again" — with
  // no way to do it. The connect error path must reveal the input for the
  // key-rejection class (isApiKeyRejection), and only for that class: a
  // network, quota, or server failure must not make the user think the key is
  // at fault by suddenly showing the input.
  const renderer = readSource("renderer.js");
  const connectStart = renderer.indexOf("async function connectRealtime()");
  assert.ok(connectStart !== -1, "renderer.js must define connectRealtime");
  const connectBody = renderer.slice(connectStart, renderer.indexOf("async function disconnectRealtime()"));
  assert.match(
    connectBody,
    /if \(isApiKeyRejection\(error\)\) revealApiKeyField\(\)/,
    "connectRealtime must reveal the key input when the API key was rejected",
  );
  assert.ok(
    connectBody.indexOf("const message = humanizeError(error)") <
      connectBody.indexOf("isApiKeyRejection(error)"),
    "the key-rejection check must run alongside the humanized error, not before it",
  );
  // The reveal helper must exist and actually un-hide the field: the whole
  // point is that applyKeyStatus hid it while a key existed.
  assert.match(renderer, /function revealApiKeyField\(\)/);
  assert.match(renderer, /apiKeyField\.hidden = false/);
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
  assert.equal(typeof lib.sameMediaDeviceList, "function");
  assert.equal(typeof lib.createDebugLogBuffer, "function");
  assert.equal(typeof lib.captionDisplayText, "function");
  assert.equal(typeof lib.capErrorBody, "function");
  assert.equal(typeof lib.readCappedResponseText, "function");
  assert.equal(typeof lib.readCappedJson, "function");
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

test("executeAction pins the data channel so a stale output cannot leak into a reconnected session", () => {
  // A local action can outlive the session that approved it (a long Codex run
  // while the user disconnects and reconnects): when it finishes, its output
  // used to be sent through the GLOBAL actionDataChannel — which by then
  // belongs to the NEW session, leaking a function_call_output whose call_id
  // does not exist in the new conversation. executeAction must capture the
  // channel of the session that approved the action BEFORE the run starts and
  // deliver the output through that pinned channel (dropped when it is gone),
  // and sendFunctionOutput must accept that channel instead of always reading
  // the global.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("async function executeAction");
  assert.ok(fnStart !== -1, "renderer.js must define executeAction");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("const KNOWN_TOOLS"));
  assert.match(
    fnBody,
    /const channel = actionDataChannel;/,
    "executeAction must capture the session's data channel before the local action runs",
  );
  assert.match(
    fnBody,
    /sendFunctionOutput\(action\.callId, result, channel\)/,
    "executeAction must deliver the output through the captured channel, not the global",
  );
  const sendStart = renderer.indexOf("function sendFunctionOutput");
  assert.ok(sendStart !== -1, "renderer.js must define sendFunctionOutput");
  const sendBody = renderer.slice(sendStart, renderer.indexOf('connectButton.addEventListener("click", connectRealtime)'));
  assert.match(
    sendBody,
    /function sendFunctionOutput\(callId, output, channel = actionDataChannel\)/,
    "sendFunctionOutput must accept the caller's channel (defaulting to the global for non-action callers)",
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

test("captions are capped so a long session cannot grow the DOM without bound", () => {
  // The debug log, the codex output buffer, and the main-process output
  // buffers are all bounded, but the accumulated transcript captions used to
  // grow without limit: transcript delta events append to sourceCaption /
  // outputCaption forever, so a long session (or an unusually long turn)
  // grows the caption strings and the DOM without bound — the one unbounded
  // accumulator in the renderer. appendCaption must enforce a cap and keep
  // the newest text (the tail the user is reading) when truncating.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("function appendCaption");
  assert.ok(fnStart !== -1, "renderer.js must define appendCaption");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("function handleTranscriptEvent"));
  assert.match(
    fnBody,
    /MAX_CAPTION_CHARS/,
    "appendCaption must enforce a cap on the accumulated caption length",
  );
  assert.match(
    fnBody,
    /next\.slice\(-MAX_CAPTION_CHARS\)/,
    "appendCaption must keep the newest text (tail) when truncating an over-long caption",
  );
  assert.match(
    fnBody,
    /truncated \$\{next\.length - MAX_CAPTION_CHARS\} chars/,
    "appendCaption must mark the truncation so the cut is visible, not silent",
  );
  assert.match(
    fnBody,
    /bucket\.parts\.push\(text\)/,
    "appendCaption must accumulate deltas in a part list instead of copying the whole caption string on every event",
  );
  assert.match(
    fnBody,
    /bucket\.dirty = true/,
    "appendCaption must mark the changed bucket dirty so renderCaptions can skip the other join",
  );
});

test("connectPeerSession drops non-object Realtime events instead of throwing in the message handler", () => {
  // A well-formed JSON payload is not necessarily an object: "null", a bare
  // string, a number, or an array all parse successfully. The data-channel
  // message handler used to read event.type straight off the parsed value,
  // so a JSON null from the server threw a raw TypeError inside the async
  // handler — an unhandled rejection that skipped the transcript/tool
  // handling for the message entirely. Non-object events must be dropped
  // with a log (mirroring the malformed-JSON branch just above) before any
  // field access.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("async function connectPeerSession");
  assert.ok(fnStart !== -1, "renderer.js must define connectPeerSession");
  const fnBody = fnStart === -1 ? "" : renderer.slice(fnStart, renderer.indexOf("async function connectSingleRealtime"));
  assert.match(
    fnBody,
    /event === null \|\| typeof event !== "object"/,
    "the message handler must reject null and other non-object events before reading event.type",
  );
  assert.match(
    fnBody,
    /Array\.isArray\(event\)/,
    "the message handler must reject array events (a JSON array parses but is not a valid Realtime event)",
  );
  assert.ok(
    fnBody.indexOf("dropped non-object Realtime event") > fnBody.indexOf("JSON.parse(message.data)"),
    "the non-object drop must log a message, mirroring the malformed-JSON branch",
  );
});

test("connectPeerSession fetches the token inside the try so a failed fetch cannot leave the mic hot", () => {
  // connectPeerSession used to await createClientSecret BEFORE its try block.
  // If that fetch threw (bad key, network, quota), the catch that closes the
  // peer connection and stops inputStream tracks never ran — and since the
  // session is never pushed to activeSessions on that path, disconnectRealtime()
  // could not stop the microphone either. The mic stayed hot after a failed
  // connect. The token fetch must live inside the try so the cleanup path
  // always runs.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("async function connectPeerSession");
  assert.ok(fnStart !== -1, "renderer.js must define connectPeerSession");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("async function connectSingleRealtime"));
  const tryIndex = fnBody.indexOf("try {");
  const tokenFetch = fnBody.indexOf("createClientSecret");
  assert.ok(tryIndex !== -1, "connectPeerSession must have a try block");
  assert.ok(tokenFetch !== -1, "connectPeerSession must fetch a client secret");
  assert.ok(
    tryIndex < tokenFetch,
    "the client-secret fetch must be inside the try block so a failed fetch still runs the cleanup that stops the mic",
  );
  assert.match(
    fnBody,
    /inputStream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/,
    "the catch must stop the input stream tracks so the mic cannot stay hot after a failed connect",
  );
});

test("connectPeerSession caps failed Realtime HTTP bodies before they land on Error.message", () => {
  // A non-OK Realtime call (or a captive portal answering 401/403 with a
  // megabyte of HTML) used to embed the raw body in the thrown Error. That
  // string then survived into humanizeError's toLowerCase copy, the status
  // pill, and the debug log. Cap first; the status code stays on the Error
  // so isApiKeyRejection / humanizeError still match.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("async function connectPeerSession");
  assert.ok(fnStart !== -1, "renderer.js must define connectPeerSession");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("async function connectSingleRealtime"));
  assert.match(
    fnBody,
    /Realtime call failed: \$\{response\.status\} \$\{await readCappedResponseText\(response\)\}/,
    "a failed Realtime call must stream-cap the HTTP error body before throwing",
  );
  assert.match(
    fnBody,
    /readCappedResponseText\(response, 32768\)/,
    "a 2xx SDP answer must be stream-capped so a captive-portal HTML page cannot allocate a megabyte",
  );
  assert.match(
    fnBody,
    /sdp\.includes\("\\n\.\.\.\[truncated\]"\)/,
    "a truncated 2xx body must be rejected even if it happens to start with v=",
  );
});


test("setPendingAction caps the args shown in the pending panel (display-only truncation)", () => {
  // The pending panel previews what the model wants to run. The args blob
  // arrives from the Realtime API before the main process validates its
  // length (json_args is bounded at 200KB for run_cua_driver, the codex
  // prompt is bounded later too), so an oversized model-generated prompt or
  // args must not inflate the textarea and the DOM without limit — the log,
  // captions, and output buffers are all capped, and the panel was the one
  // unbounded sink. The truncation is display-only: the FULL args are still
  // sent for execution (setPendingAction never rewrites action.args), so the
  // model does not lose data it asked to run. A marker shows the cut.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("const MAX_PENDING_ARGS_CHARS");
  assert.ok(fnStart !== -1, "renderer.js must define MAX_PENDING_ARGS_CHARS");
  // Slice from the constant (defined just above setPendingAction) so the body
  // includes both the cap definition and the function that enforces it.
  const fnBody = renderer.slice(fnStart, renderer.indexOf("function clearPendingActionTimer"));
  assert.match(
    fnBody,
    /formatPendingArgs\(/,
    "setPendingAction must route both the codex prompt and the args JSON through the display cap",
  );
  assert.match(
    fnBody,
    /MAX_PENDING_ARGS_CHARS/,
    "setPendingAction must enforce a cap on the pending-panel display",
  );
  assert.match(
    fnBody,
    /typeof value === "string" && value\.length > MAX_PENDING_ARGS_CHARS/,
    "formatPendingArgs must cap large strings before JSON.stringify so a 200KB args blob cannot allocate a megabyte preview",
  );
  assert.match(
    fnBody,
    /truncated \$\{text\.length - MAX_PENDING_ARGS_CHARS\} chars/,
    "setPendingAction must mark the truncation so the cut is visible, not silent",
  );
  // The cap must never rewrite what is executed: pendingAction keeps the full
  // args object, only the textarea preview is truncated.
  assert.ok(
    !/pendingAction\.args\s*=/.test(fnBody),
    "setPendingAction must not rewrite the pending action args (display-only truncation)",
  );
});

test("log() serializes defensively so a non-serializable payload cannot loop the error handlers", () => {
  // log() runs inside the window error/unhandledrejection handlers. A
  // circular reason object, a throwing toJSON, or a BigInt would make
  // JSON.stringify throw *inside* the error handler — the new throw then
  // triggers the same handler again, and the renderer loops forever logging
  // a log failure. main.js writeLog already guards its own stringify for
  // exactly this reason; the renderer log must not be the one unguarded link.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("function log(message, data");
  assert.ok(fnStart !== -1, "renderer.js must define log()");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("function updateModeControls"));
  assert.match(
    fnBody,
    /try \{[\s\S]*?JSON\.stringify\(logData,[\s\S]*?\} catch \{[\s\S]*?serialized = String\(data\);/,
    "log() must fall back to String(data) when JSON.stringify throws",
  );
});

test("log() caps large payloads before pretty-printing and skips DOM writes while the debug panel is closed", () => {
  // A finished Codex result can carry up to 1MB of stdout. Pretty-printing
  // that into the <pre> (and sending it over IPC) spiked renderer memory on
  // every "Local action finished" line. Truncate before stringify, and do
  // not rewrite textContent while the user is not looking at the log.
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("function log(message, data");
  assert.ok(fnStart !== -1, "renderer.js must define log()");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("function updateModeControls"));
  assert.match(
    fnBody,
    /truncateOutput\(data, 8000\)/,
    "log() must cap object payloads (stdout/stderr) before serializing them",
  );
  assert.match(
    fnBody,
    /capErrorBody\(value, 16000\)/,
    "log() must cap non-stdout/stderr string fields in the stringify replacer so a Realtime error dump cannot allocate a megabyte pretty JSON",
  );
  assert.match(
    fnBody,
    /if \(typeof logData !== "string"\) \{[\s\S]*?JSON\.stringify\(logData/,
    "log() must not JSON.stringify streamed string chunks — the suffix already uses logData",
  );
  assert.match(
    fnBody,
    /paintDebugLog\(\)/,
    "log() must paint through paintDebugLog so a closed or hidden panel skips the 50KB join",
  );
  assert.match(
    renderer,
    /debugPanel\?\.addEventListener\("toggle"/,
    "opening the debug panel must catch up the deferred log buffer",
  );
});

test("closing the debug panel drops the joined log from the DOM", () => {
  // logLines already holds the capped newest-first text. After the user
  // collapses the <details>, keeping the joined 50KB in <pre> + logBuffer
  // is a duplicate the compositor still retains. Clear both; the toggle
  // open path rejoins from the line list.
  const renderer = readSource("renderer.js");
  const toggleStart = renderer.indexOf('debugPanel?.addEventListener("toggle"');
  assert.ok(toggleStart !== -1, "renderer.js must listen for debug panel toggle");
  const toggleBody = renderer.slice(toggleStart, renderer.indexOf("function syncWindowVisibility"));
  assert.match(
    toggleBody,
    /logEl\.textContent = ""/,
    "closing the debug panel must clear the <pre> so the joined copy is not retained",
  );
  assert.match(
    toggleBody,
    /logBuffer = ""/,
    "closing the debug panel must drop the joined logBuffer duplicate",
  );
  assert.ok(
    toggleBody.indexOf("logPaintDirty = true") !== -1 &&
      toggleBody.indexOf("logPaintDirty = true") < toggleBody.indexOf("paintDebugLog()"),
    "opening the debug panel must mark the log dirty so the cleared <pre> is rejoined",
  );
});

test("orb animation is paused while idle so the always-on-top window does not composite every frame", () => {
  const css = readSource("styles.css");
  assert.match(
    css,
    /animation-play-state:\s*paused/,
    "the orb must pause by default (idle and first paint)",
  );
  assert.match(
    css,
    /animation-play-state:\s*running/,
    "active states (listening/connecting/running/error) must resume the orb animation",
  );
});

test("orb animation is paused while the shortcut-hidden window is in the background", () => {
  // hide() leaves the renderer running. A Listening session would otherwise
  // keep the compositor scheduled behind a hidden always-on-top window.
  const css = readSource("styles.css");
  assert.match(
    css,
    /body\.is-background \.orb(?:,\s*body\.is-background \.orb::before)?\s*\{[^}]*animation-play-state:\s*paused/,
    "a hidden window must pause the orb even when data-state is listening/running",
  );
  const renderer = readSource("renderer.js");
  assert.match(
    renderer,
    /visibilitychange/,
    "the renderer must sync is-background from document visibility",
  );
  assert.match(
    renderer,
    /classList\.toggle\("is-background"/,
    "visibilitychange must toggle body.is-background",
  );
});

test("captions coalesce to one DOM write per frame", () => {
  const renderer = readSource("renderer.js");
  const fnStart = renderer.indexOf("function renderCaptions()");
  assert.ok(fnStart !== -1, "renderer.js must define renderCaptions");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("const MAX_CAPTION_CHARS"));
  assert.match(
    fnBody,
    /requestAnimationFrame/,
    "renderCaptions must coalesce transcript deltas onto animation frames",
  );
  assert.ok(
    fnBody.indexOf("document.hidden") !== -1 &&
      fnBody.indexOf("document.hidden") < fnBody.indexOf("requestAnimationFrame"),
    "renderCaptions must not schedule requestAnimationFrame while the window is hidden",
  );
  assert.match(
    fnBody,
    /captionDisplayText/,
    "renderCaptions must use captionDisplayText so a no-op trim does not copy 50KB per frame",
  );
  assert.ok(
    fnBody.indexOf("!sourceBucket.dirty && !outputBucket.dirty") !== -1 &&
      fnBody.indexOf("!sourceBucket.dirty && !outputBucket.dirty") < fnBody.indexOf("requestAnimationFrame"),
    "renderCaptions must not schedule a frame when neither caption bucket changed",
  );
  assert.ok(
    fnBody.indexOf("sourceBucket.dirty") !== -1 &&
      fnBody.indexOf("sourceBucket.dirty") < fnBody.indexOf("sourceBucket.parts.join"),
    "renderCaptions must skip the source join when that bucket is clean",
  );
  assert.ok(
    fnBody.indexOf("outputBucket.dirty") !== -1 &&
      fnBody.indexOf("outputBucket.dirty") < fnBody.indexOf("outputBucket.parts.join"),
    "renderCaptions must skip the output join when that bucket is clean",
  );
  assert.doesNotMatch(
    renderer,
    /^let sourceCaption/m,
    "renderer.js must not keep a live sourceCaption copy of the already-capped bucket",
  );
  const resetStart = renderer.indexOf("function resetCaptions()");
  assert.ok(resetStart !== -1, "renderer.js must define resetCaptions");
  const resetBody = renderer.slice(resetStart, renderer.indexOf("function renderCaptions()"));
  assert.match(
    resetBody,
    /sourceBucket\.dirty = true/,
    "resetCaptions must mark the source bucket dirty so the DOM clears on the next frame",
  );
  assert.match(
    resetBody,
    /outputBucket\.dirty = true/,
    "resetCaptions must mark the output bucket dirty so the DOM clears on the next frame",
  );
});

test("auto-run skips the pending-panel pretty-print that executeAction immediately discards", () => {
  // With auto-run checked, handleToolEvent paints the pending panel and then
  // executeAction hides it on the next line. formatPendingArgs pretty-prints
  // up to 200KB of model args for a textarea the human never sees — the same
  // class of wasted display work as joining captions while #captionPanel is
  // hidden. Supersede + pendingAction still run; only the DOM writes skip.
  const renderer = readSource("renderer.js");
  const toolStart = renderer.indexOf("async function handleToolEvent");
  assert.ok(toolStart !== -1, "renderer.js must define handleToolEvent");
  const toolBody = renderer.slice(toolStart, renderer.indexOf("function deviceConstraint"));
  assert.match(
    toolBody,
    /setPendingAction\(action, \{ skipDisplay: true \}\)/,
    "handleToolEvent must skip the pending-panel paint when auto-run will execute immediately",
  );
  const setStart = renderer.indexOf("function setPendingAction");
  assert.ok(setStart !== -1, "renderer.js must define setPendingAction");
  const setBody = renderer.slice(setStart, renderer.indexOf("function clearPendingActionTimer"));
  assert.match(
    setBody,
    /options\.skipDisplay/,
    "setPendingAction must honor skipDisplay so auto-run can skip formatPendingArgs",
  );
  assert.ok(
    setBody.indexOf("skipDisplay") !== -1 &&
      setBody.indexOf("skipDisplay") < setBody.indexOf("formatPendingArgs"),
    "skipDisplay must return before formatPendingArgs so auto-run cannot pretty-print a 200KB preview",
  );
});

test("enabling auto-run executes a pending action instead of letting its auto-reject timer fire", () => {
  // When a tool call arrives while auto-run is OFF, setPendingAction arms an
  // auto-reject timer. If the human then ticks the auto-run checkbox, the
  // pending action must run immediately — otherwise the still-armed timer
  // rejects it later even though the human just asked for automatic
  // execution. The change listener must mirror the model path (execute the
  // pending action when the checkbox is checked).
  const renderer = readSource("renderer.js");
  const listenerStart = renderer.indexOf('autoRunInput.addEventListener("change"');
  assert.ok(listenerStart !== -1, "renderer.js must wire a change listener on the auto-run checkbox");
  const listenerBody = renderer.slice(listenerStart, renderer.indexOf('navigator.mediaDevices?.addEventListener'));
  assert.match(
    listenerBody,
    /autoRunInput\.checked && pendingAction/,
    "the auto-run change listener must act on a pending action when the checkbox is checked",
  );
  assert.match(
    listenerBody,
    /executeAction\(pendingAction\)/,
    "the auto-run change listener must execute the pending action (which clears the auto-reject timer)",
  );
});

test("hidden caption panel skips transcript accumulation and DOM joins", () => {
  // Assistant mode hides #captionPanel. Transcript deltas still arrive on
  // the data channel; joining them into 50KB strings and writing the DOM
  // every frame is wasted work the user cannot see. Tools keep running —
  // only the live caption UI is skipped.
  const renderer = readSource("renderer.js");
  const eventStart = renderer.indexOf("function handleTranscriptEvent");
  assert.ok(eventStart !== -1, "renderer.js must define handleTranscriptEvent");
  const eventBody = renderer.slice(eventStart, renderer.indexOf("const MAX_PENDING_ARGS_CHARS"));
  assert.match(
    eventBody,
    /captionPanel\?\.hidden/,
    "handleTranscriptEvent must skip caption work while the panel is hidden",
  );
  const renderStart = renderer.indexOf("function renderCaptions()");
  const renderBody = renderer.slice(renderStart, renderer.indexOf("const MAX_CAPTION_CHARS"));
  assert.match(
    renderBody,
    /captionPanel\?\.hidden/,
    "renderCaptions must skip the join + textContent write while the panel is hidden",
  );
});

test("devicechange is ignored while the window is hidden and catches up on show", () => {
  // The global shortcut hide()s the window without destroying the renderer,
  // so macOS still delivers devicechange bursts. Enumerating while hidden is
  // wasted work; showing the window must refresh only if a change arrived
  // during the hide (or the list was never filled).
  const renderer = readSource("renderer.js");
  const listenerStart = renderer.indexOf("navigator.mediaDevices?.addEventListener");
  assert.ok(listenerStart !== -1, "renderer.js must listen for devicechange");
  const listenerBody = renderer.slice(listenerStart, listenerStart + 700);
  assert.match(
    listenerBody,
    /document\.hidden/,
    "devicechange must skip refreshMediaDevices while the window is hidden",
  );
  assert.match(
    listenerBody,
    /devicesChangedWhileHidden = true/,
    "devicechange while hidden must record a pending refresh instead of enumerating",
  );
  assert.match(
    renderer,
    /function syncWindowVisibility\(/,
    "renderer.js must define syncWindowVisibility",
  );
  const syncStart = renderer.indexOf("function syncWindowVisibility");
  const syncBody = renderer.slice(syncStart, renderer.indexOf("document.addEventListener(\"visibilitychange\""));
  assert.match(
    syncBody,
    /devicesChangedWhileHidden/,
    "becoming visible must consult the pending-devicechange flag before enumerating",
  );
  assert.match(
    syncBody,
    /refreshMediaDevices\(false\)/,
    "becoming visible must refresh the device list skipped while hidden",
  );
});

test("debug log uses a ring buffer instead of unshifting every line", () => {
  const renderer = readSource("renderer.js");
  assert.match(
    renderer,
    /createDebugLogBuffer/,
    "renderer.js must use createDebugLogBuffer for the capped debug log",
  );
  const pushStart = renderer.indexOf("function pushLogLine");
  assert.ok(pushStart !== -1, "renderer.js must define pushLogLine");
  const pushBody = renderer.slice(pushStart, renderer.indexOf("function log("));
  assert.doesNotMatch(
    pushBody,
    /unshift/,
    "pushLogLine must not Array.unshift (O(n) per log line)",
  );
});

test("refreshMediaDevices skips rebuilding selects when the device list is unchanged", () => {
  // devicechange fires often on macOS with an identical enumerateDevices()
  // result. Rebuilding four <select>s on every no-op enumeration is wasted
  // DOM work; a permission grant that fills in labels still differs and
  // rebuilds.
  const renderer = readSource("renderer.js");
  assert.match(
    renderer,
    /sameMediaDeviceList/,
    "renderer.js must compare device lists before rebuilding the dropdowns",
  );
  const refreshStart = renderer.indexOf("async function refreshMediaDevices");
  assert.ok(refreshStart !== -1, "renderer.js must define refreshMediaDevices");
  const refreshBody = renderer.slice(refreshStart, renderer.indexOf("async function getInterviewAudioStream"));
  assert.match(
    refreshBody,
    /sameMediaDeviceList\(lastMediaDevices, devices\)/,
    "refreshMediaDevices must compare the new enumeration to the last one",
  );
  assert.ok(
    refreshBody.indexOf("sameMediaDeviceList(lastMediaDevices, devices)") <
      refreshBody.indexOf("setSelectOptions"),
    "the unchanged-list check must run before any <select> rebuild",
  );
});

test("streamed Codex/CUA output skips the renderer-to-main log bounce", () => {
  // main sendCodexOutput already writes the renderer:ui payload to
  // bridge.log. Flushing those chunks through log() without skipIpc would
  // clone the same 4–16KB string back across IPC and duplicate the file line.
  const renderer = readSource("renderer.js");
  const logStart = renderer.indexOf("function log(message, data");
  assert.ok(logStart !== -1, "renderer.js must define log()");
  const logBody = renderer.slice(logStart, renderer.indexOf("function updateModeControls"));
  assert.match(
    logBody,
    /if \(!options\.skipIpc\)/,
    "log() must skip the renderer-to-main bounce when skipIpc is set",
  );
  assert.match(
    renderer,
    /onCodexOutput\(\(chunk\) => \{\s*log\("codex output", chunk, \{ skipIpc: true \}\)/,
    "each streamed chunk must go to the debug panel without bouncing back to main",
  );
  assert.doesNotMatch(
    renderer,
    /codexOutputBuffer/,
    "main already batches at 4KB; a second renderer buffer only copied each chunk again",
  );
});

test("debug log skips the 50KB join while the shortcut-hidden window is in the background", () => {
  // hide() does not destroy the renderer. An open debug <details> used to
  // joinNewestFirst + rewrite <pre> on every streamed chunk even though
  // the user cannot see it — the same wasted compositor work captions
  // already skip. Catch up once on show if the panel is still open.
  const renderer = readSource("renderer.js");
  const paintStart = renderer.indexOf("function paintDebugLog");
  assert.ok(paintStart !== -1, "renderer.js must define paintDebugLog");
  const paintBody = renderer.slice(paintStart, renderer.indexOf("function pushLogLine"));
  assert.match(
    paintBody,
    /if \(!debugPanel\?\.open \|\| document\.hidden\) return/,
    "paintDebugLog must skip the join while the panel is closed or the window is hidden",
  );
  assert.ok(
    paintBody.indexOf("!logPaintDirty") !== -1 &&
      paintBody.indexOf("!logPaintDirty") < paintBody.indexOf("joinLogLines()"),
    "paintDebugLog must skip the 50KB join when no line arrived since the last paint",
  );
  const pushStart = renderer.indexOf("function pushLogLine");
  const pushBody = renderer.slice(pushStart, renderer.indexOf("function log(message, data"));
  assert.match(
    pushBody,
    /logPaintDirty = true/,
    "pushLogLine must mark the debug log dirty so show() can catch up a hidden buffer",
  );
  const syncStart = renderer.indexOf("function syncWindowVisibility");
  const syncBody = renderer.slice(syncStart, renderer.indexOf("document.addEventListener(\"visibilitychange\""));
  assert.match(
    syncBody,
    /paintDebugLog\(\)/,
    "becoming visible must catch up the debug log skipped while hidden",
  );
  assert.ok(
    syncBody.indexOf("renderCaptions()") < syncBody.indexOf("paintDebugLog()"),
    "debug-log catch-up must run after the caption catch-up on show",
  );
});
