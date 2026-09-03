// Regression guard for runProcess streaming semantics.
//
// When a child process times out, the runProcess promise settles immediately
// with a timeout error, but the child keeps running (up to 3s until the
// SIGKILL) and can keep emitting stdout/stderr. If those late chunks were
// still forwarded via options.onOutput, the renderer would batch a dead run's
// tail into the debug log of the NEXT run —
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

test("runCodex and runCuaDriver guard codex-output sends against a destroyed window", () => {
  // A run can outlive the window (Cmd+W while Codex/CUA output streams): the
  // mainWindow reference is only nulled on the "closed" event, so during the
  // close sequence webContents.send on a destroyed webContents throws "Object
  // has been destroyed" — an uncaught exception from inside the child output
  // handler. Every other mainWindow touch in main.js checks
  // !mainWindow.isDestroyed(); sendCodexOutput must do the same.
  const main = readSource("main.js");
  const helperStart = main.indexOf("function sendCodexOutput");
  assert.ok(helperStart !== -1, "main.js must define sendCodexOutput");
  const helper = main.slice(helperStart, main.indexOf("function runCodex"));
  assert.match(
    helper,
    /writeLog\("renderer:ui", \{ message: "codex output", data: String\(chunk\) \}\)/,
    "sendCodexOutput must write the same renderer:ui payload the debug log used to bounce",
  );
  assert.match(
    helper,
    /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) return;/,
    "sendCodexOutput must skip webContents.send when the window is gone",
  );
  assert.match(
    helper,
    /mainWindow\.webContents\.send\("codex-output", chunk\)/,
    "sendCodexOutput must still stream the chunk to the renderer debug panel",
  );
  assert.ok(
    helper.indexOf('writeLog("renderer:ui"') < helper.indexOf("isDestroyed"),
    "bridge.log must be written before the destroyed-window send guard so a run that outlives Cmd+W is still recorded",
  );
  for (const [label, fnStart, fnEnd] of [
    ["runCodex", "function runCodex", "function runCuaDriver"],
    ["runCuaDriver", "function runCuaDriver", "async function runMacAction"],
  ]) {
    const start = main.indexOf(fnStart);
    assert.ok(start !== -1, `main.js must define ${fnStart}`);
    const fnBody = main.slice(start, main.indexOf(fnEnd));
    assert.match(
      fnBody,
      /sendCodexOutput/,
      `${label} must stream through sendCodexOutput`,
    );
  }
});

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
    /truncateOutput\(cuaResult\)/,
    "openAppVisible must cap launch stdout before JSON.stringify so a 1MB dump cannot drop launched/activated",
  );
  assert.match(
    fnBody,
    /launchOutput: launch\.stdout/,
    "openAppVisible stdout must include the driver's own (capped) launch output",
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

test("writeLog caps log payloads so a 1MB Codex result cannot be stringified whole", () => {
  const main = readSource("main.js");
  assert.match(
    main,
    /function serializeLogData\(data\)/,
    "writeLog must serialize through a bounded helper",
  );
  const fnStart = main.indexOf("function serializeLogData");
  const fnBody = main.slice(fnStart, main.indexOf("function writeLog"));
  assert.match(
    fnBody,
    /truncateOutput\(data, 16000\)/,
    "object log payloads with stdout/stderr must be truncated before stringify",
  );
  assert.match(
    fnBody,
    /capErrorBody\(value, MAX_LOG_PAYLOAD_CHARS\)/,
    "serializeLogData must cap other large string fields in the stringify replacer, not only stdout/stderr",
  );
  assert.match(
    fnBody,
    /MAX_LOG_PAYLOAD_CHARS/,
    "the serialized log line itself must be length-capped",
  );
});

test("log rotation tracks on-disk size, not WriteStream.bytesWritten", () => {
  const main = readSource("main.js");
  assert.match(
    main,
    /logBytesWritten = fs\.statSync\(LOG_FILE\)\.size/,
    "opening the log stream must seed the byte counter from the existing file size",
  );
  const fnStart = main.indexOf("function writeLog");
  const fnBody = main.slice(fnStart, main.indexOf("function runProcess"));
  assert.match(
    fnBody,
    /logBytesWritten >= LOG_MAX_BYTES/,
    "rotation must use the on-disk counter, not stream.bytesWritten",
  );
  assert.doesNotMatch(
    fnBody,
    /logStream\.bytesWritten/,
    "stream.bytesWritten undercounts an appended existing log file",
  );
});

test("renderer log IPC is fire-and-forget (send), not a round-trip invoke", () => {
  const main = readSource("main.js");
  assert.match(
    main,
    /ipcMain\.on\("log:renderer"/,
    "log:renderer must be a one-way ipcMain.on handler",
  );
  assert.doesNotMatch(
    main,
    /ipcMain\.handle\("log:renderer"/,
    "log:renderer must not use invoke/handle (that waits for a reply on every UI log line)",
  );
  const preload = readSource("preload.cjs");
  assert.match(
    preload,
    /ipcRenderer\.send\("log:renderer"/,
    "the preload log bridge must send, not invoke",
  );
  assert.match(
    preload,
    /return Promise\.resolve\(\{ ok: true \}\)/,
    "preload log() must still return a thenable so window error handlers can .catch()",
  );
});

test("onCodexOutput replaces the previous listener instead of stacking them", () => {
  const preload = readSource("preload.cjs");
  const fnStart = preload.indexOf("onCodexOutput:");
  assert.ok(fnStart !== -1, "preload must expose onCodexOutput");
  const fnBody = preload.slice(fnStart, preload.indexOf("});", fnStart));
  assert.match(
    fnBody,
    /removeAllListeners\("codex-output"\)/,
    "onCodexOutput must drop any prior codex-output listener before adding a new one",
  );
  assert.ok(
    fnBody.indexOf('removeAllListeners("codex-output")') < fnBody.indexOf('ipcRenderer.on("codex-output"'),
    "the previous listener must be removed before the new one is added",
  );
});

test("runProcess batches streamed output IPC and flushes before settling", () => {
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runProcess");
  const fnBody = main.slice(fnStart, main.indexOf("async function readKeychainApiKey"));
  assert.match(
    fnBody,
    /createOutputAccumulator\(MAX_PROCESS_OUTPUT_CHARS\)/,
    "runProcess must accumulate stdout/stderr with the chunked cap helper",
  );
  assert.match(
    fnBody,
    /OUTPUT_IPC_BATCH_CHARS = 4000/,
    "streamed IPC must batch instead of sending every tiny stdout chunk",
  );
  assert.match(
    fnBody,
    /OUTPUT_IPC_MAX_CHARS = 16000/,
    "streamed IPC must cap a single dump at the renderer log string budget",
  );
  assert.match(
    fnBody,
    /payload\.slice\(-OUTPUT_IPC_MAX_CHARS\)/,
    "an oversized debug-log payload must keep the tail, not the head",
  );
  assert.match(
    fnBody,
    /if \(text\.length >= OUTPUT_IPC_MAX_CHARS\)/,
    "a megabyte stdout chunk must not be concatenated into pendingOutput before the cap",
  );
  assert.match(
    fnBody,
    /trimSettledOutput = options\.trimOutput !== false/,
    "runProcess must allow callers to skip trim() of a megabyte settled tail",
  );
  assert.match(
    fnBody,
    /settleProcessOutput\(value, trimSettledOutput\)/,
    "settled stdout/stderr must only trim when trimOutput is not disabled",
  );
  assert.ok(
    fnBody.indexOf("flushPendingOutput()") < fnBody.indexOf("resolve({"),
    "the leftover IPC batch must flush before the runProcess promise resolves",
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

test("runProcess distinguishes a missing cwd from a missing binary on ENOENT", () => {
  // spawn() reports a nonexistent cwd as ENOENT with the command in
  // error.path — the same code a missing binary produces — and runCodex
  // hands a model-controlled cwd to spawn, so a working directory that does
  // not exist would otherwise surface as the misleading "codex was not found
  // on PATH" and make the model blame the install instead of the path. The
  // error handler must check the cwd it actually used and report the missing
  // directory, falling back to humanizeSpawnError only when the cwd exists.
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runProcess");
  assert.ok(fnStart !== -1, "main.js must define runProcess");
  const fnBody = main.slice(fnStart, main.indexOf("async function readKeychainApiKey"));
  assert.match(
    fnBody,
    /error\?\.code === "ENOENT" && !fs\.existsSync\(options\.cwd \|\| DEFAULT_WORKDIR\)/,
    "runProcess must detect a missing cwd on ENOENT before blaming the binary",
  );
  assert.match(
    fnBody,
    /The working directory does not exist: \$\{options\.cwd \|\| DEFAULT_WORKDIR\}/,
    "runProcess must report the missing working directory explicitly",
  );
  assert.ok(
    fnBody.indexOf("fs.existsSync(options.cwd") < fnBody.indexOf("humanizeSpawnError(command, error)"),
    "the cwd check must run before the missing-binary message",
  );
});

test("runProcess stops streaming child output to the renderer once the run has settled", () => {
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runProcess");
  assert.ok(fnStart !== -1, "main.js must define runProcess");
  const fnBody = main.slice(fnStart, main.indexOf("async function readKeychainApiKey"));
  // Both the stdout and stderr data handlers must forward through a helper
  // that gates on the settled flag so a timed-out run's late chunks cannot
  // reach the renderer and be flushed into a later run's debug log.
  const forwarded = fnBody.match(/forwardOutput\(text\)/g) || [];
  assert.ok(
    forwarded.length >= 2,
    "both stdout and stderr data handlers must forward output through forwardOutput",
  );
  assert.match(
    fnBody,
    /if \(!text \|\| settled \|\| !options\.onOutput\) return/,
    "forwardOutput must drop chunks once the run has settled",
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

test("getActiveAppFromCua distinguishes a malformed list_apps payload from a genuine no-active-app result", () => {
  // A parseable-but-wrong list_apps payload (no apps array, non-array apps,
  // empty stdout) used to collapse into the generic "No active app pid
  // found." — hiding a real driver problem (crash mid-print, version
  // mismatch) so the model could not self-correct, the same misleading
  // collapse the list_apps-failure branch avoids. Only a valid apps array
  // with no active entry may mean "no active app"; everything else must
  // carry the driver problem through as an error, and malformed entries
  // must be skipped instead of throwing inside find.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function getActiveAppFromCua");
  assert.ok(fnStart !== -1, "main.js must define getActiveAppFromCua");
  const fnBody = main.slice(fnStart, main.indexOf("function activateApp"));
  assert.match(
    fnBody,
    /extractActiveAppFromListApps\(result\.stdout\)/,
    "getActiveAppFromCua must extract the active app without JSON.parse of the whole list_apps forest",
  );
  assert.match(
    fnBody,
    /pid: null, error: "[^"]*unexpected payload/,
    "getActiveAppFromCua must surface an unexpected-payload error instead of collapsing to the generic message",
  );
  assert.match(
    fnBody,
    /extracted\.error/,
    "getActiveAppFromCua must treat a missing apps list as unexpected, not as no active app",
  );
  assert.match(
    fnBody,
    /pid: null, error: "[^"]*unreadable payload/,
    "getActiveAppFromCua must surface an unreadable-payload error instead of returning bare null",
  );
});

test("getActiveAppFromCua does not stream list_apps into the debug-log IPC", () => {
  // type/press look up the frontmost pid via list_apps. That dump (even the
  // 16KB tail cap) used to cross IPC on every keystroke for a debug line
  // the model never sees. The lookup must pass quiet so runCuaDriver
  // skips onOutput; a model-facing cua:run still streams.
  const main = readSource("main.js");
  const lookup = main.slice(
    main.indexOf("async function getActiveAppFromCua"),
    main.indexOf("function activateApp"),
  );
  assert.match(
    lookup,
    /runCuaDriver\(\{ tool_name: "list_apps", json_args: \{\} \}, \{ quiet: true \}\)/,
    "the internal list_apps lookup must be quiet so type/press do not clone the dump into the renderer log",
  );
  const cua = main.slice(main.indexOf("function runCuaDriver"), main.indexOf("async function runMacAction"));
  assert.match(
    cua,
    /function runCuaDriver\(input = \{\}, options = \{\}\)/,
    "quiet must be a second argument so a model-supplied json_args.quiet cannot silence cua:run",
  );
  assert.match(
    cua,
    /onOutput: options\.quiet\s*\? undefined/,
    "runCuaDriver must skip streamed IPC when quiet",
  );
  assert.match(
    cua,
    /trimOutput: !options\.quiet/,
    "quiet list_apps must not trim() a 1MB dump — extractActiveAppFromListApps accepts the trailing newline",
  );
});

test("pressKeyInFrontApp normalizes modifiers so a bare string is never silently dropped", () => {
  // cua-driver's press_key expects a modifiers array of strings; a malformed
  // model call carrying non-string entries (e.g. modifiers: ["cmd", 42] or
  // [["cmd"]]) would serialize garbage into json_args and make the driver
  // fail with an opaque error the model cannot self-correct from. The tool
  // must keep only string entries. A bare string like "cmd" — a very
  // plausible model output — must NOT silently normalize to []: that would
  // press the key WITHOUT the modifier the model asked for (Cmd+X becomes
  // plain X, a different action in the front app). A string becomes a
  // one-element array, and entries are trimmed + lowercased so "CMD" /
  // " Command " reach the driver in the exact lowercase form it expects.
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
  assert.match(
    fnBody,
    /typeof input\.modifiers === "string"\s*\? \[input\.modifiers\]/,
    "pressKeyInFrontApp must treat a bare-string modifiers as a one-element array instead of dropping it",
  );
  assert.match(
    fnBody,
    /\.map\(\(modifier\) => modifier\.trim\(\)\.toLowerCase\(\)\)/,
    "pressKeyInFrontApp must trim and lowercase each modifier so the driver receives the exact form it expects",
  );
  assert.match(
    fnBody,
    /\.filter\(\(modifier\) => modifier\.length > 0\)/,
    "pressKeyInFrontApp must drop whitespace-only modifiers (they trim to '')",
  );
});

test("pressKeyInFrontApp trims and lowercases the key so wrapped whitespace or capitalization cannot reach the driver", () => {
  // cua-driver's press_key expects a clean lowercase key name; model-generated
  // JSON often wraps values in stray whitespace or a trailing newline (e.g. a
  // template literal) — the same cosmetic noise the modifiers normalization
  // and the app_name/url trims already handle. An untrimmed key like
  // "return " or "esc\n" would make the driver fail with an opaque error the
  // model cannot self-correct from, so the tool must trim the key once at the
  // source and feed the trimmed value to the length gate and the driver call.
  // It must also lowercase it: the driver expects lowercase key names
  // ("return", "escape", ...) and a model describing the action in natural
  // language plausibly sends "Return" or "ESC" — the same normalization the
  // modifiers already get. Key names are never case-distinct (single letters
  // are the same physical key; capitalization is expressed via the shift
  // modifier), so lowercasing cannot change which key is pressed.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function pressKeyInFrontApp");
  assert.ok(fnStart !== -1, "main.js must define pressKeyInFrontApp");
  const fnBody = main.slice(fnStart, main.indexOf("async function getActiveAppFromCua"));
  assert.match(
    fnBody,
    /const key = String\(input\.key\)\.trim\(\)\.toLowerCase\(\)/,
    "pressKeyInFrontApp must normalize the key (trim + lowercase) once at the source",
  );
  assert.match(
    fnBody,
    /requireMaxLength\(key, "key", 100\)/,
    "pressKeyInFrontApp must apply the length gate to the normalized key",
  );
  assert.doesNotMatch(
    fnBody,
    /json_args: \{ pid: active\.pid, key: input\.key/,
    "pressKeyInFrontApp must not pass the raw input.key to cua-driver",
  );
});

test("pressKeyInFrontApp splits '+'-joined modifier entries into individual modifiers", () => {
  // A model describing a shortcut in natural language very plausibly emits a
  // combined modifier entry ("cmd+shift", "CMD + Shift") or a bare combo
  // string ("cmd+shift") instead of the array of individual modifier names
  // cua-driver's press_key expects. Without normalization such an entry
  // reaches the driver as one bogus modifier name and fails with an opaque
  // error the model cannot self-correct from. Modifier names never contain
  // "+" (cmd/ctrl/alt/shift/option/...), so splitting every entry on "+" is
  // unambiguous: it expands one entry into the several modifiers the model
  // named, never inventing one that was not asked for — and it must keep the
  // existing string/trim/lowercase handling intact.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function pressKeyInFrontApp");
  assert.ok(fnStart !== -1, "main.js must define pressKeyInFrontApp");
  const fnBody = main.slice(fnStart, main.indexOf("async function getActiveAppFromCua"));
  assert.match(
    fnBody,
    /\.flatMap\(\(modifier\) => modifier\.split\("\+"\)\.map\(\(part\) => part\.trim\(\)\)\)/,
    "pressKeyInFrontApp must split each modifier entry on '+' and trim the parts",
  );
  assert.match(
    fnBody,
    /\.filter\(\(modifier, index, all\) => all\.indexOf\(modifier\) === index\)/,
    "pressKeyInFrontApp must collapse duplicate modifiers after the split",
  );
});

test("pressKeyInFrontApp splits a '+'-joined combo out of the key field", () => {
  // The modifiers split handles "+"-joined modifier entries, but a model
  // describing a shortcut in natural language can just as plausibly put the
  // WHOLE combo in the key ("cmd+shift+p") with no modifiers at all. Such a
  // key reaches cua-driver's press_key as one bogus key name and fails with
  // an opaque error the model cannot self-correct from. Key names never
  // contain "+", so splitting the key on "+" is unambiguous: the last part
  // is the pressed key and the preceding parts join the modifiers pipeline.
  // The length gate must still run on the original key so the split cannot
  // bypass it, and the driver call must use the pressed key, never the raw
  // combo.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function pressKeyInFrontApp");
  assert.ok(fnStart !== -1, "main.js must define pressKeyInFrontApp");
  const fnBody = main.slice(fnStart, main.indexOf("async function getActiveAppFromCua"));
  assert.match(
    fnBody,
    /const keyCombo = key\.split\("\+"\)\.map\(\(part\) => part\.trim\(\)\)\.filter\(\(part\) => part\.length > 0\)/,
    "pressKeyInFrontApp must split a '+'-joined key into its parts",
  );
  assert.match(
    fnBody,
    /keyCombo\[keyCombo\.length - 1\]/,
    "pressKeyInFrontApp must use the last combo part as the pressed key",
  );
  assert.match(
    fnBody,
    /keyCombo\.length === 1\s*\?\s*keyCombo\[0\]\s*:\s*""/,
    "pressKeyInFrontApp must normalize a stray leading/trailing '+' out of the key",
  );
  assert.match(
    fnBody,
    /keyCombo\.slice\(0, -1\)/,
    "pressKeyInFrontApp must feed the preceding combo parts into the modifiers",
  );
  assert.match(
    fnBody,
    /requireMaxLength\(key, "key", 100\)/,
    "pressKeyInFrontApp must keep the length gate on the original key so the split cannot bypass it",
  );
  assert.match(
    fnBody,
    /compactKey === "\+"\s*\|\|\s*\(compactKey\.length >= 3 && compactKey\.endsWith\("\+\+"\)/,
    "pressKeyInFrontApp must treat a lone '+' / 'cmd++' as the plus key instead of degrading the combo to a bare modifier press",
  );
  assert.doesNotMatch(
    fnBody,
    /json_args: \{ pid: active\.pid, key: key \}/,
    "pressKeyInFrontApp must not pass the unsplit key to cua-driver",
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

test("runCodex and the url paths reject null bytes before spawn can throw", () => {
  // Every model-controlled value that becomes a direct argv entry (prompt,
  // cwd) or spawn cwd (cwd) makes Node's spawn() throw a synchronous
  // TypeError when it contains a null byte — JSON args can encode "\u0000",
  // so a model-supplied prompt/cwd/url with one would surface as an opaque
  // Node error instead of a clean, self-correctable message. The same three
  // places that cap argv-bound values must reject null bytes at the source.
  const main = readSource("main.js");
  const codexFn = main.slice(main.indexOf("function runCodex"), main.indexOf("function runCuaDriver"));
  assert.match(
    codexFn,
    /requireNoNullBytes\(input\?\.prompt, "prompt"\)/,
    "runCodex must reject a null byte in the prompt before spawn",
  );
  assert.match(
    codexFn,
    /requireNoNullBytes\(input\?\.cwd, "cwd"\)/,
    "runCodex must reject a null byte in cwd before spawn (argv entry and cwd option)",
  );
  const openFn = main.slice(main.indexOf("async function openAppVisible"), main.indexOf("async function typeTextInFrontApp"));
  assert.match(
    openFn,
    /requireNoNullBytes\(url, "url"\)/,
    "openAppVisible must reject a null byte in the url before launching",
  );
  const lib = readSource("lib.js");
  assert.match(
    lib,
    /requireNoNullBytes\(input\.url, "url"\)/,
    "resolveOpenAppTarget must reject a null byte in the url-only path",
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

test("runCuaDriver and runMacAction guard a null IPC payload like runCodex does", () => {
  // runCodex dereferences input with optional chaining (input?.prompt) so a
  // null IPC payload settles with a clean error, but runCuaDriver and
  // runMacAction used to dereference input.tool_name / input.action directly:
  // a null payload would throw a TypeError inside the ipcMain.handle guard
  // instead of returning the clean "Missing tool_name" / "Unknown mac action"
  // error the model can self-correct from. The renderer validates args before
  // dispatch (code -101), but defense in depth is the pattern here — the
  // requireNonEmptyString guard exists precisely because "a null IPC payload
  // would throw a TypeError while destructuring".
  const main = readSource("main.js");
  const cuaStart = main.indexOf("function runCuaDriver");
  assert.ok(cuaStart !== -1, "main.js must define runCuaDriver");
  const cuaBody = main.slice(cuaStart, main.indexOf("async function runMacAction"));
  assert.match(
    cuaBody,
    /input\?\.tool_name/,
    "runCuaDriver must read tool_name with optional chaining so null settles cleanly",
  );

  const macStart = main.indexOf("async function runMacAction");
  assert.ok(macStart !== -1, "main.js must define runMacAction");
  const macBody = main.slice(macStart, main.indexOf("async function openAppVisible"));
  assert.match(
    macBody,
    /input\?\.action/,
    "runMacAction must read action with optional chaining so null settles cleanly",
  );
});

test("runCuaDriver validates required press_key/type_text_chars args before spawning", () => {
  // The run_cua_driver schema only requires tool_name+json_args, so the model
  // can call press_key (no key) or type_text_chars (no text) directly — a
  // shape cua-driver rejects with an opaque error the model cannot
  // self-correct from, the same class of failure the dedicated tools'
  // requireNonEmptyString guards prevent. runCuaDriver must run the
  // validation on the NORMALIZED args (so a whitespace-only key that trims to
  // "" fails too) and settle with a clean error before spawning the driver.
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runCuaDriver");
  assert.ok(fnStart !== -1, "main.js must define runCuaDriver");
  const fnBody = main.slice(fnStart, main.indexOf("async function runMacAction"));
  assert.match(
    fnBody,
    /validateCuaDriverRequiredArgs\(toolName, normalizedArgs(?:, Math\.floor\(CUA_TIMEOUT_MS \* 0\.8\))?\)/,
    "runCuaDriver must validate press_key/type_text_chars required args on the normalized args",
  );
  assert.match(
    fnBody,
    /requiredArgsError\) \{\n    return Promise\.resolve\(\{ ok: false, code: -5/,
    "runCuaDriver must settle with a clean error when the required args are missing",
  );
  assert.ok(
    fnBody.indexOf("validateCuaDriverRequiredArgs(toolName, normalizedArgs)") < fnBody.indexOf("runProcess(\"cua-driver\""),
    "the required-args guard must run before spawning cua-driver",
  );
});

test("runCuaDriver scales delay_ms for direct type_text_chars calls like the dedicated tool", () => {
  // The dedicated type_text_in_front_app tool computes a per-character delay
  // scaled to the text length (typeDelayMs) so long texts finish inside the
  // driver timeout; a direct run_cua_driver call with tool_name
  // "type_text_chars" reaches the same cua-driver machinery but, without the
  // injection, types at the driver's default pace — a text that passes the
  // typeability guard (e.g. 30k chars, well under the typing budget) would
  // then take minutes and blow the timeout with an opaque error the model
  // cannot distinguish from a real hang. The delay must be injected on the
  // normalized args with the same budget math (CUA_TIMEOUT_MS * 0.8), only
  // when the model did not supply a usable delay_ms.
  const main = readSource("main.js");
  const fnStart = main.indexOf("function runCuaDriver");
  assert.ok(fnStart !== -1, "main.js must define runCuaDriver");
  const fnBody = main.slice(fnStart, main.indexOf("async function runMacAction"));
  assert.match(
    fnBody,
    /toolName === "type_text_chars" && !\(Number\.isFinite\(normalizedArgs\.delay_ms\) && normalizedArgs\.delay_ms > 0\)/,
    "runCuaDriver must inject delay_ms for type_text_chars only when the model did not supply a usable one",
  );
  assert.match(
    fnBody,
    /normalizedArgs\.delay_ms = typeDelayMs\(normalizedArgs\.text\.length, 20, Math\.floor\(CUA_TIMEOUT_MS \* 0\.8\)\)/,
    "runCuaDriver must scale delay_ms with the same budget math as typeTextInFrontApp",
  );
  assert.ok(
    fnBody.indexOf("normalizedArgs.delay_ms = typeDelayMs") < fnBody.indexOf("runProcess(\"cua-driver\""),
    "the delay injection must happen before spawning cua-driver",
  );
});

test("app:config reports the resolved workdir, not the raw env value", () => {
  // The UI shows this path, so it must be the same directory Codex actually
  // operates on. The raw DEFAULT_WORKDIR may be relative, a symlink, or not
  // exist yet — resolveWorkdir normalizes all three (realpath, mkdir,
  // containment fallback) and runCodex uses it. Exposing the raw value lets
  // the UI claim a path Codex never uses (e.g. "~/codex" while Codex runs in
  // "/Users/you/codex" after ~ expansion).
  const main = readSource("main.js");
  const configStart = main.indexOf('ipcMain.handle("app:config"');
  assert.ok(configStart !== -1, "main.js must define app:config");
  // app:config is the last ipcMain.handle registration; slice to the end of
  // the file (there is no later handler to bound it).
  const configBody = main.slice(configStart);
  assert.match(
    configBody,
    /workdir: resolveWorkdir\(undefined, DEFAULT_WORKDIR\)/,
    "app:config must report the resolved workdir",
  );
});

test("DEFAULT_WORKDIR trims CODEX_VOICE_WORKDIR so a whitespace-padded value cannot break every codex run", () => {
  // The resolved API key is trimmed at its source for the same reason, but
  // CODEX_VOICE_WORKDIR was used raw: a shell export with a trailing space
  // (e.g. `export CODEX_VOICE_WORKDIR="/path/to/ws "` from a copy-paste, or
  // a launchd plist string with stray whitespace) keeps the padding through
  // path.resolve, so spawn("codex", ..., { cwd }) fails with ENOENT and the
  // run surfaces the misleading "The working directory does not exist" for a
  // perfectly valid directory — the exact failure the ENOENT handler exists
  // to diagnose, triggered by cosmetic noise instead of a real missing path.
  // The trim must keep the cwd/home fallback for a whitespace-only value so
  // it behaves exactly like an unset variable.
  const main = readSource("main.js");
  const workdirStart = main.indexOf("const DEFAULT_WORKDIR = path.resolve(");
  assert.ok(workdirStart !== -1, "main.js must define DEFAULT_WORKDIR");
  const workdirBody = main.slice(workdirStart, main.indexOf("const CODEX_TIMEOUT_MS"));
  assert.match(
    workdirBody,
    /process\.env\.CODEX_VOICE_WORKDIR\?\.trim\(\) \|\| \(processCwd === path\.parse\(processCwd\)\.root \? os\.homedir\(\) : processCwd\)/,
    "DEFAULT_WORKDIR must trim CODEX_VOICE_WORKDIR and fall back for a whitespace-only value",
  );
});

test("ALWAYS_ON_TOP trims CODEX_VOICE_ALWAYS_ON_TOP so a whitespace-padded 0 cannot keep the window floating", () => {
  // The WORKDIR/API-key trims normalize whitespace-padded env values at their
  // sources, but the always-on-top opt-out compared the raw value: a shell
  // export with a trailing space (e.g. `export CODEX_VOICE_ALWAYS_ON_TOP="0 "`
  // from a copy-paste, or a launchd plist string with stray whitespace) makes
  // the raw value !== "0", so the window silently stays always-on-top — the
  // opposite of the opt-out the user asked for. The comparison must trim so a
  // whitespace-only or padded value behaves exactly like the bare "0".
  const main = readSource("main.js");
  const topStart = main.indexOf("const ALWAYS_ON_TOP = ");
  assert.ok(topStart !== -1, "main.js must define ALWAYS_ON_TOP");
  const topBody = main.slice(topStart, main.indexOf("// Read the version"));
  assert.match(
    topBody,
    /process\.env\.CODEX_VOICE_ALWAYS_ON_TOP\?\.trim\(\) !== "0"/,
    "ALWAYS_ON_TOP must trim CODEX_VOICE_ALWAYS_ON_TOP before comparing to \"0\"",
  );
});

test("SHORTCUT trims CODEX_VOICE_SHORTCUT so a whitespace-padded value cannot silently kill the toggle shortcut", () => {
  // The WORKDIR/ALWAYS_ON_TOP/API-key trims normalize whitespace-padded env
  // values at their sources, but the toggle shortcut used the raw value: a
  // shell export with a trailing space (e.g. `export
  // CODEX_VOICE_SHORTCUT="CommandOrControl+Shift+Space "` from a copy-paste,
  // or a launchd plist string with stray whitespace) would make
  // globalShortcut.register fail — reported only as a log line, so the user
  // silently loses the toggle shortcut — and the padded string would also
  // show in the UI config line. The value must be trimmed so a padded or
  // whitespace-only value behaves exactly like the default.
  const main = readSource("main.js");
  const shortcutStart = main.indexOf("const SHORTCUT = ");
  assert.ok(shortcutStart !== -1, "main.js must define SHORTCUT");
  const shortcutBody = main.slice(shortcutStart, main.indexOf("// Whether the bridge window floats"));
  assert.match(
    shortcutBody,
    /process\.env\.CODEX_VOICE_SHORTCUT\?\.trim\(\) \|\| "CommandOrControl\+Shift\+Space"/,
    "SHORTCUT must trim CODEX_VOICE_SHORTCUT and fall back to the default for a whitespace-only value",
  );
});

test("globalShortcut.register is guarded so an invalid CODEX_VOICE_SHORTCUT cannot abort startup", () => {
  // The trim guards make a whitespace-padded shortcut behave like the
  // default, but globalShortcut.register THROWS (it does not return false)
  // for a syntactically invalid accelerator — e.g. a trailing "+" or a stray
  // token from a copy-paste (`export CODEX_VOICE_SHORTCUT="Space+"`). That
  // throw happens inside app.whenReady().then(...), so uncaught it would
  // abort the startup handler: the window opens, but the toggle shortcut is
  // silently dead and only the unhandledRejection log shows why. The register
  // call must be wrapped in try/catch so a bad value degrades to a log line
  // and the rest of startup continues.
  const main = readSource("main.js");
  const registerStart = main.indexOf("globalShortcut.register(SHORTCUT, toggleWindow)");
  assert.ok(registerStart !== -1, "main.js must call globalShortcut.register(SHORTCUT, toggleWindow)");
  const before = main.slice(Math.max(0, registerStart - 400), registerStart);
  assert.match(before, /try\s*{/, "globalShortcut.register must be inside a try block");
  const after = main.slice(registerStart, registerStart + 400);
  assert.match(after, /catch\s*\(error\)/, "globalShortcut.register must be followed by a catch");
  assert.match(
    after,
    /writeLog\("globalShortcut register threw"/,
    "the catch must log the invalid shortcut so the failure is diagnosable",
  );
});

test("createRealtimeClientSecret trims the resolved API key so a whitespace-padded OPENAI_API_KEY cannot 401", () => {
  // The runtime key and the Keychain value are trimmed at their sources
  // (set-api-key trims, security -w output is trimmed), but an OPENAI_API_KEY
  // set in the shell very plausibly carries stray whitespace (a trailing
  // newline from `export OPENAI_API_KEY=$(cat key.txt)`, a copy-paste with a
  // surrounding blank line). Handed raw to the Authorization header, that
  // whitespace makes OpenAI reject a perfectly good key with a confusing 401
  // — and a whitespace-only env key would slip past the truthiness check and
  // fail later with that same 401 instead of the clean "Add an OpenAI API
  // key..." message. The resolved key must be trimmed once at the source.
  const main = readSource("main.js");
  const fnStart = main.indexOf("async function createRealtimeClientSecret");
  assert.ok(fnStart !== -1, "main.js must define createRealtimeClientSecret");
  const fnBody = main.slice(fnStart, main.indexOf("async function createAssistantClientSecret"));
  assert.match(
    fnBody,
    /\(runtimeApiKey \|\| \(await readKeychainApiKey\(\)\) \|\| process\.env\.OPENAI_API_KEY \|\| ""\)\.trim\(\)/,
    "createRealtimeClientSecret must trim the resolved API key so whitespace-padded env keys are normalized",
  );
});

test("OpenAI token error bodies are capped before they land on Error.message", () => {
  // A failed client_secrets fetch can return a megabyte of captive-portal
  // HTML. Putting that raw body on Error.message copies it again in
  // humanizeError (toLowerCase) and into the status pill. Cap first; the
  // "reasoning" retry still sees the head of a real OpenAI JSON error.
  const main = readSource("main.js");
  assert.match(
    main,
    /const message = await readCappedResponseText\(response\)/,
    "the assistant token path must stream-cap the error body before the reasoning check and the throw",
  );
  assert.match(
    main,
    /readCappedResponseText\(response\)/,
    "token / translation / transcription failures must stream-cap the HTTP error body",
  );
  assert.equal(
    (main.match(/readCappedResponseText\(response\)/g) || []).length,
    4,
    "assistant retry, assistant fallback, translation, and transcription must all stream-cap error bodies",
  );
});

test("OpenAI token success bodies are stream-capped before JSON.parse", () => {
  // A 2xx captive-portal dump used to hit response.json(), which buffers the
  // entire body before throwing. The three client_secrets success paths must
  // parse through readCappedJson so the peak stays at the 64KB budget.
  const main = readSource("main.js");
  assert.match(
    main,
    /normalizeRealtimeToken\(await readCappedJson\(response\)/,
    "token / translation / transcription success paths must stream-cap before JSON.parse",
  );
  assert.equal(
    (main.match(/readCappedJson\(response\)/g) || []).length,
    3,
    "assistant, translation, and transcription token success paths must all use readCappedJson",
  );
  assert.equal(
    (main.match(/await response\.json\(\)/g) || []).length,
    0,
    "main.js must not buffer an entire HTTP body with await response.json()",
  );
});

test("key-status does not report a whitespace-only OPENAI_API_KEY as a usable key", () => {
  // hasEnvKey hides the API key input field: a whitespace-only env var (the
  // same stray-whitespace class the trim fix addresses) would otherwise keep
  // the field hidden behind an env key that can never authenticate — the user
  // would see "Add an OpenAI API key" with no way to add one.
  const main = readSource("main.js");
  const fnStart = main.indexOf('ipcMain.handle("realtime:key-status"');
  assert.ok(fnStart !== -1, "main.js must define the realtime:key-status handler");
  const fnBody = main.slice(fnStart, main.indexOf('ipcMain.handle("codex:run"'));
  assert.match(
    fnBody,
    /hasEnvKey: Boolean\(process\.env\.OPENAI_API_KEY\?\.trim\(\)\)/,
    "key-status must not count a whitespace-only OPENAI_API_KEY as a usable key",
  );
});

test("model/voice/language defaults trim their env values so padded strings cannot 400 on every connect", () => {
  // The WORKDIR/SHORTCUT/ALWAYS_ON_TOP/API-key trims normalize whitespace-
  // padded env values at their sources, but the Realtime model, translate/
  // transcribe models, voice, and target language were used raw: a shell
  // export with a trailing space (e.g. `export OPENAI_REALTIME_VOICE="marin "`
  // from a copy-paste, or a launchd plist string with stray whitespace) is
  // sent to the OpenAI API exactly as-is, so every connect fails with a 400
  // (unknown model/voice) that the user cannot diagnose from the .env they
  // wrote. Each default must trim so a padded or whitespace-only value
  // behaves exactly like the bare value or the built-in default.
  const main = readSource("main.js");
  const defaultsStart = main.indexOf("const DEFAULT_MODEL = ");
  assert.ok(defaultsStart !== -1, "main.js must define DEFAULT_MODEL");
  const defaultsBody = main.slice(defaultsStart, main.indexOf("const DEFAULT_REASONING_EFFORT"));
  for (const [envVar, pattern] of [
    ["OPENAI_REALTIME_MODEL", /process\.env\.OPENAI_REALTIME_MODEL\?\.trim\(\) \|\| "gpt-realtime-2"/],
    ["OPENAI_REALTIME_TRANSLATE_MODEL", /process\.env\.OPENAI_REALTIME_TRANSLATE_MODEL\?\.trim\(\) \|\| "gpt-realtime-translate"/],
    ["OPENAI_REALTIME_TRANSCRIBE_MODEL", /process\.env\.OPENAI_REALTIME_TRANSCRIBE_MODEL\?\.trim\(\) \|\| "gpt-realtime-whisper"/],
    ["OPENAI_REALTIME_VOICE", /process\.env\.OPENAI_REALTIME_VOICE\?\.trim\(\) \|\| "marin"/],
  ]) {
    assert.match(defaultsBody, pattern, `DEFAULT_* must trim ${envVar} and fall back for a whitespace-only value`);
  }
  const langStart = main.indexOf("const DEFAULT_TARGET_LANGUAGE = ");
  assert.ok(langStart !== -1, "main.js must define DEFAULT_TARGET_LANGUAGE");
  const langBody = main.slice(langStart, main.indexOf("// Fall back to the home directory"));
  assert.match(
    langBody,
    /normalizeTargetLanguage\(process\.env\.OPENAI_REALTIME_TARGET_LANGUAGE \|\| "es"\)/,
    "DEFAULT_TARGET_LANGUAGE must normalize OPENAI_REALTIME_TARGET_LANGUAGE and fall back for an invalid/whitespace-only value",
  );
});

test("loadDotEnv trims CODEX_VOICE_ENV_FILE so a whitespace-padded path cannot silently skip the custom .env", () => {
  // The WORKDIR/SHORTCUT/ALWAYS_ON_TOP/API-key trims normalize whitespace-
  // padded env values at their sources, but the custom .env path was used
  // raw: a shell export with a trailing space (e.g. `export
  // CODEX_VOICE_ENV_FILE="/path/to/.env "` from a copy-paste, or a launchd
  // plist string with stray whitespace) would make fs.existsSync fail and the
  // file be silently skipped — the user's overrides never load, with no
  // error, and the app falls back to <cwd>/.env. The value must be trimmed so
  // a padded path loads the intended file and a whitespace-only value falls
  // back to <cwd>/.env exactly like an unset variable (the trimmed empty
  // string is dropped by filter(Boolean)).
  const main = readSource("main.js");
  const fnStart = main.indexOf("function loadDotEnv()");
  assert.ok(fnStart !== -1, "main.js must define loadDotEnv");
  const fnBody = main.slice(fnStart, main.indexOf("loadDotEnv();"));
  assert.match(
    fnBody,
    /process\.env\.CODEX_VOICE_ENV_FILE\?\.trim\(\)/,
    "loadDotEnv must trim CODEX_VOICE_ENV_FILE so a whitespace-padded path cannot silently skip the custom .env",
  );
});

test("codex and cua IPC returns are truncated before the structured clone into the renderer", () => {
  // runProcess keeps up to 1MB of child output so a long run cannot grow
  // without bound. Cloning that whole tail into the renderer on every
  // finished invoke (then pretty-printing it) spiked renderer memory; the
  // model already received truncateOutput's 30KB tail. The invoke handlers
  // must truncate before the clone. Streamed debug output still uses the
  // batched codex-output channel inside runCodex/runCuaDriver.
  const main = readSource("main.js");
  assert.match(
    main,
    /ipcMain\.handle\("codex:run", guard\(async \(_event, input\) => truncateOutput\(await runCodex\(input\)\)\)\)/,
    "codex:run must truncate the invoke return before sending it to the renderer",
  );
  assert.match(
    main,
    /ipcMain\.handle\("cua:run", guard\(async \(_event, input\) => truncateOutput\(await runCuaDriver\(input\)\)\)\)/,
    "cua:run must truncate the invoke return before sending it to the renderer",
  );
  assert.match(
    main,
    /ipcMain\.handle\("mac:run", guard\(async \(_event, input\) => truncateOutput\(await runMacAction\(input\)\)\)\)/,
    "mac:run must truncate type/press (and open_app) returns before the renderer clone",
  );
});
