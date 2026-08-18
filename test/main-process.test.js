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

test("runCodex and runCuaDriver guard codex-output sends against a destroyed window", () => {
  // A run can outlive the window (Cmd+W while Codex/CUA output streams): the
  // mainWindow reference is only nulled on the "closed" event, so during the
  // close sequence webContents.send on a destroyed webContents throws "Object
  // has been destroyed" — an uncaught exception from inside the child output
  // handler. Every other mainWindow touch in main.js checks
  // !mainWindow.isDestroyed(); the onOutput callbacks must do the same.
  const main = readSource("main.js");
  for (const [label, fnStart, fnEnd] of [
    ["runCodex", "function runCodex", "function runCuaDriver"],
    ["runCuaDriver", "function runCuaDriver", "async function runMacAction"],
  ]) {
    const start = main.indexOf(fnStart);
    assert.ok(start !== -1, `main.js must define ${fnStart}`);
    const fnBody = main.slice(start, main.indexOf(fnEnd));
    assert.match(
      fnBody,
      /mainWindow && !mainWindow\.isDestroyed\(\)\) mainWindow\.webContents\.send\("codex-output", chunk\)/,
      `${label} must guard the codex-output send with !mainWindow.isDestroyed()`,
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
    /keyCombo\.length === 1 \? keyCombo\[0\] : ""/,
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
    /validateCuaDriverRequiredArgs\(toolName, normalizedArgs\)/,
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
