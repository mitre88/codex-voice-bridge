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
import { fixture, deferred } from "./helpers/session-fixture.js";
import { TailBuffer } from "../src/tail-buffer.js";

const SRC = new URL("../src/", import.meta.url);

function readSource(name) {
  return readFileSync(new URL(name, SRC), "utf8");
}

test("renderer.js imports only browser-safe modules (no node: builtins)", () => {
  const visited = new Set();
  function inspect(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const match of readSource(name).matchAll(/^\s*import\s[^;]+?from\s+"([^"]+)"/gm)) {
      assert.ok(match[1].startsWith("./"), `Browser import must be relative: ${match[1]}`);
      inspect(match[1].slice(2));
    }
  }
  inspect("renderer.js");
  assert.ok(visited.has("session-controller.js"));
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
  assert.match(errorHandler, /\.catch\(\(\) => \{\}\)/, "the window error handler must catch log promise rejections");
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

test("renderer.js enables Disconnect at connect start so mid-connect cancel works", async () => {
  const source = readSource("renderer.js");
  const connect = source.slice(
    source.indexOf("async function connectRealtime()"),
    source.indexOf("function disconnectRealtime("),
  );
  assert.ok(connect.indexOf("disconnectButton.disabled = false") < connect.indexOf("await owner.wait"));
  const token = deferred();
  const f = fixture({ createToken: () => token.promise });
  const pending = f.c.start([f.route()]);
  await new Promise((r) => setImmediate(r));
  f.c.dispose();
  await assert.rejects(pending, /cancel/i);
  assert.equal(f.tracks[0].stops, 1);
  token.resolve({ value: "late" });
});

test("a stale connect's catch cannot abort or overwrite a newer connect", async () => {
  const token = deferred(),
    old = fixture({ createToken: () => token.promise }),
    next = fixture();
  const pending = old.c.start([old.route()]);
  await new Promise((r) => setImmediate(r));
  old.c.dispose();
  await assert.rejects(pending, /cancel/i);
  await next.c.start([next.route()]);
  token.reject(new Error("late failure"));
  await new Promise((r) => setImmediate(r));
  assert.equal(next.c.ready, true);
  next.c.dispose();
  assert.match(readSource("renderer.js"), /if \(currentSession !== owner\) return;/);
});

test("connect failures surface humanized recovery in a separate accessible banner", () => {
  const renderer = readSource("renderer.js"),
    html = readSource("renderer.html");
  assert.match(renderer, /showError\(message\)/);
  assert.match(renderer, /setStatus\("Not connected", "error"\)/);
  assert.match(html, /id="errorMessage" role="alert"/);
  // Runtime visibility, Retry and mic disposal are exercised by test/ui/voice.spec.js.
  assert.match(readFileSync(new URL("../test/ui/voice.spec.js", SRC), "utf8"), /separate recovery banner/);
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
    connectBody.indexOf("const message = humanizeError(error)") < connectBody.indexOf("isApiKeyRejection(error)"),
    "the key-rejection check must run alongside the humanized error, not before it",
  );
  // The reveal helper must exist and actually un-hide the field: the whole
  // point is that applyKeyStatus hid it while a key existed.
  assert.match(renderer, /function revealApiKeyField\(\)/);
  assert.match(renderer, /apiKeyField\.hidden = false/);
});

test("cancel stops late media grants without claiming unsupported getUserMedia signal cancellation", async () => {
  const media = deferred(),
    f = fixture();
  const pending = f.c.start([{ label: "Voice", acquire: () => media.promise }]);
  await new Promise((r) => setImmediate(r));
  f.c.dispose();
  await assert.rejects(pending, /cancel/i);
  media.resolve(f.stream());
  await new Promise((r) => setImmediate(r));
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.peers.length, 0);
  assert.doesNotMatch(readSource("renderer.js"), /getUserMedia\(\{[^}]*signal:/);
});

test("executeAction does not flip the status to Listening after a disconnect", () => {
  const source = readSource("renderer.js");
  const action = source.slice(source.indexOf("async function executeAction"), source.indexOf("const KNOWN_TOOLS"));
  assert.ok(
    action.indexOf("currentSession !== owner || owner.signal.aborted") <
      action.indexOf("sendFunctionOutput(action.callId, result, channel)"),
  );
  assert.match(action, /currentSession === owner && owner.ready/);
  // operations.test.js behaviorally covers a late completion after replacement.
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

test("sendFunctionOutput never queues a stale output on a channel that is not open", () => {
  const source = readSource("renderer.js");
  const send = source.slice(
    source.indexOf("function sendFunctionOutput"),
    source.indexOf("connectButton.addEventListener"),
  );
  assert.match(send, /readyState !== "open"/);
  assert.doesNotMatch(send, /addEventListener|setTimeout/);
  // No pending send is needed: controller.start now requires open channels.
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
  const sendBody = renderer.slice(
    sendStart,
    renderer.indexOf('connectButton.addEventListener("click", connectRealtime)'),
  );
  assert.match(
    sendBody,
    /function sendFunctionOutput\(callId, output, channel = actionDataChannel\)/,
    "sendFunctionOutput must accept the caller's channel (defaulting to the global for non-action callers)",
  );
});

test("refreshMediaDevices never prompts for microphone labels and preserves vanished selections", () => {
  const source = readSource("renderer.js");
  const refresh = source.slice(
    source.indexOf("async function refreshMediaDevices"),
    source.indexOf("async function getInterviewAudioStream"),
  );
  assert.match(refresh, /enumerateDevices/);
  assert.doesNotMatch(refresh, /getUserMedia/);
  assert.match(source, /missing.dataset.missing = "true"/);
  // test/ui/voice.spec.js covers live vanished-device refresh with no fallback.
});

test("captions are capped so a long session cannot grow the DOM without bound", () => {
  const buffer = new TailBuffer(50000);
  for (let i = 0; i < 6000; i++) buffer.append("caption fragment ");
  assert.ok(buffer.display().length <= 50000);
  assert.ok(buffer.dropped > 0);
  assert.match(readSource("renderer.js"), /new TailBuffer\(50000\)/);
});

test("connectPeerSession drops non-object Realtime events instead of throwing in the message handler", async () => {
  let events = 0;
  const f = fixture({ onEvent: () => events++ });
  await f.c.start([f.route()]);
  for (const data of ["null", "[]", "42", '"string"', "bad-json"])
    f.peers[0].channel.dispatchEvent(new MessageEvent("message", { data }));
  await new Promise((r) => setImmediate(r));
  assert.equal(events, 0);
  assert.equal(f.c.ready, true);
  f.c.dispose();
});

test("session controller releases media and peers after a token failure", async () => {
  const f = fixture({
    createToken: async () => {
      throw new Error("token rejected");
    },
  });
  await assert.rejects(f.c.start([f.route()]), /token rejected/);
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.peers[0].closed, 1);
  assert.equal(f.c.resources.size, 0);
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
  assert.match(fnBody, /MAX_PENDING_ARGS_CHARS/, "setPendingAction must enforce a cap on the pending-panel display");
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
  const fnStart = renderer.indexOf("function log(message, data)");
  assert.ok(fnStart !== -1, "renderer.js must define log()");
  const fnBody = renderer.slice(fnStart, renderer.indexOf("function updateModeControls"));
  assert.match(
    fnBody,
    /try \{[\s\S]*?JSON\.stringify\(data, null, 2\)[\s\S]*?\} catch \{[\s\S]*?serialized = String\(data\);/,
    "log() must fall back to String(data) when JSON.stringify throws",
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
  const listenerBody = renderer.slice(listenerStart, renderer.indexOf("navigator.mediaDevices?.addEventListener"));
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
