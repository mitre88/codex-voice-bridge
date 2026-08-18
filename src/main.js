import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  accumulateOutput,
  applyEnvOverrides,
  escapeAppleScript,
  extractFirstJsonObject,
  humanizeSpawnError,
  isPlausibleApiKey,
  isSafeAppIdentity,
  isSafeCuaLaunchArgs,
  isSafeCuaToolName,
  isSafeLaunchUrl,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTone,
  parseEnvFile,
  redactSecrets,
  requireMaxLength,
  requireNoNullBytes,
  requireNonEmptyString,
  requireTypeableLength,
  resolveOpenAppTarget,
  resolveWorkdir,
  rotateLogIfNeeded,
  toPositiveInt,
  typeDelayMs,
  validateCuaDriverRequiredArgs,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional .env support with zero dependencies: load <cwd>/.env — or the file
// pointed to by CODEX_VOICE_ENV_FILE — before any configuration constant is
// read. Variables already present in the environment are never overridden.
// This must run before DEFAULT_MODEL/DEFAULT_WORKDIR/... are evaluated.
function loadDotEnv() {
  const candidates = [process.env.CODEX_VOICE_ENV_FILE, path.join(process.cwd(), ".env")].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = parseEnvFile(fs.readFileSync(file, "utf8"));
      // Count what this file actually contributes: applyEnvOverrides returns
      // the whole env object, so counting its keys would report every
      // process variable (PATH, HOME, ...) instead of the file's vars.
      const applied = Object.keys(parsed).filter((key) => process.env[key] === undefined).length;
      applyEnvOverrides(parsed, process.env);
      console.log(`codex-voice-bridge: loaded ${applied} env override(s) from ${file}`);
    } catch {
      // An unreadable .env must never block startup.
    }
  }
}
loadDotEnv();

const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const DEFAULT_TRANSLATE_MODEL = process.env.OPENAI_REALTIME_TRANSLATE_MODEL || "gpt-realtime-translate";
const DEFAULT_TRANSCRIBE_MODEL = process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-realtime-whisper";
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
// Normalize the .env value at the source: a typo like "banana" would
// otherwise surface in the UI select (no matching option) and reach the API
// (forcing the reasoning-400 retry on every connect) instead of falling back
// to a valid effort. normalizeReasoningEffort falls back to "low" for any
// value outside minimal/low/medium/high/xhigh.
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.OPENAI_REALTIME_REASONING_EFFORT || "low");
const DEFAULT_TARGET_LANGUAGE = process.env.OPENAI_REALTIME_TARGET_LANGUAGE || "es";
// Fall back to the home directory when launched from Finder/Dock (cwd === "/").
const processCwd = process.cwd();
const DEFAULT_WORKDIR = path.resolve(
  process.env.CODEX_VOICE_WORKDIR || (processCwd === path.parse(processCwd).root ? os.homedir() : processCwd),
);
const CODEX_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_TIMEOUT_MS, 120000);
const CUA_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_CUA_TIMEOUT_MS, 60000);
const OPENAI_REQUEST_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_OPENAI_TIMEOUT_MS, 60000);
// How long a pending local action may wait for the human to approve/reject it
// before the renderer auto-rejects it so the model never hangs forever.
const ACTION_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_ACTION_TIMEOUT_MS, 120000);
// Bound how much stdout/stderr a child process can accumulate in memory before
// we drop the excess; a runaway command must not grow the main process forever.
const MAX_PROCESS_OUTPUT_CHARS = 1024 * 1024;
const KEYCHAIN_SERVICE = "codex-voice-bridge.openai-api-key";
const KEYCHAIN_ACCOUNT = process.env.USER || "local";
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "codex-voice-bridge");
const LOG_FILE = path.join(LOG_DIR, "bridge.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const SAFETY_ID = crypto.createHash("sha256").update(`${process.env.USER || "local"}:codex-voice-bridge`).digest("hex");
const SHORTCUT = process.env.CODEX_VOICE_SHORTCUT || "CommandOrControl+Shift+Space";

// Read the version for the UI config line and support/debug reports. Never
// block startup if package.json is missing or unreadable.
function readAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const APP_VERSION = readAppVersion();

const CUA_BLOCKED_TOOLS = new Set(["hotkey", "move_cursor", "replay_trajectory", "set_recording"]);

let mainWindow;
let runtimeApiKey = "";
let logStream = null;
// Live child processes (codex, cua-driver, osascript, security). They are
// spawned detached in their own process group; tracking them lets us terminate
// any still-running group on quit so a long Codex run cannot outlive the app.
const runningChildren = new Set();

function getLogStream() {
  if (!logStream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Rotate an oversized log on startup so bridge.log cannot grow without bound.
    rotateLogFile();
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    // Avoid crashing the main process if the disk/log file misbehaves.
    logStream.on("error", () => {});
  }
  return logStream;
}

// Long-running sessions never restart, so also rotate while running: once the
// current stream has written LOG_MAX_BYTES, close it, move the file aside, and
// start a fresh one. If the rename fails (file locked), the next write retries.
function rotateLogFile() {
  rotateLogIfNeeded(fs, LOG_FILE, LOG_MAX_BYTES);
}

function writeLog(message, data) {
  try {
    let payload;
    try {
      payload = JSON.stringify({
        ts: new Date().toISOString(),
        message,
        data: data === undefined ? undefined : redactSecrets(JSON.stringify(data)),
      });
    } catch {
      // Never let a non-serializable payload take down the logging path (or the
      // uncaughtException handler that calls it).
      payload = JSON.stringify({ ts: new Date().toISOString(), message, data: String(data) });
    }
    if (logStream && logStream.bytesWritten >= LOG_MAX_BYTES) {
      logStream.end();
      logStream = null;
      rotateLogFile();
    }
    getLogStream().write(`${payload}\n`);
  } catch {
    // Logging is best-effort and must never throw: writeLog runs inside the
    // uncaughtException/unhandledRejection handlers and the log:renderer IPC
    // handler, and a throw here (e.g. the log directory cannot be created)
    // would crash the app or make the error handlers loop forever — each
    // failed log call triggering another error event that logs again.
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || DEFAULT_WORKDIR,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so we can kill descendants too
    });
    runningChildren.add(child);
    // A child that exits before reading stdin (e.g. `security` failing early
    // on a locked keychain, or a command that never reads stdin at all)
    // breaks the pipe: the end() below then emits EPIPE on the stdin stream,
    // and without a listener that surfaces as an uncaught 'error' event —
    // caught only by the app-level handler and logged as a scary stack trace,
    // or crashing the main process if that handler is ever removed. Swallow
    // it: the child is gone and the write is pointless.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin || "");

    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    let stderrCapped = false;
    let settled = false;
    // Decode UTF-8 incrementally: chunk.toString() alone would garble any
    // multi-byte character split across two chunks (common with streaming
    // Codex output, e.g. accented Spanish) into U+FFFD replacement chars.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    function killProcessGroup(signal) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Process group already gone.
      }
    }

    // Armed when the timeout fires: force-kills the group 3s after SIGTERM if
    // it is still alive. Cancelled once the child actually exits so a dead
    // group is never SIGKILLed later — a recycled pid could otherwise hit an
    // unrelated process group.
    let hardKill = null;
    function cancelHardKill() {
      if (hardKill) {
        clearTimeout(hardKill);
        hardKill = null;
      }
    }

    const timeout = setTimeout(() => {
      killProcessGroup("SIGTERM");
      // Give children a moment to exit, then force-kill the whole group.
      hardKill = setTimeout(() => killProcessGroup("SIGKILL"), 3000);
      hardKill.unref();
      // Flush any partial UTF-8 sequence still held by the decoders, same as
      // the close handler does, so timed-out output is not missing its tail.
      const tailOut = stdoutDecoder.end();
      const tailErr = stderrDecoder.end();
      if (tailOut) stdout = accumulateOutput(stdout, tailOut, MAX_PROCESS_OUTPUT_CHARS).text;
      if (tailErr) stderr = accumulateOutput(stderr, tailErr, MAX_PROCESS_OUTPUT_CHARS).text;
      finish({
        ok: false,
        code: -2,
        stdout: stdout.trim(),
        stderr: `${command} timed out after ${Math.round((options.timeoutMs || 60000) / 1000)} seconds.`,
      });
    }, options.timeoutMs || 60000);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      let out = result.stdout;
      let err = result.stderr;
      // The captured buffer keeps the TAIL (see accumulateOutput), so the
      // marker goes at the FRONT, before the kept tail — appending it at the
      // end would put the announcement after the very lines the model needs
      // (final result, error summary), the same convention truncateOutput uses.
      if (stdoutCapped && typeof out === "string") out = "...[stdout truncated at 1MB]\n" + out;
      if (stderrCapped && typeof err === "string") err = "...[stderr truncated at 1MB]\n" + err;
      resolve({ ...result, stdout: String(out ?? "").trim(), stderr: String(err ?? "").trim() });
    }

    child.stdout.on("data", (chunk) => {
      const text = stdoutDecoder.write(chunk);
      const result = accumulateOutput(stdout, text, MAX_PROCESS_OUTPUT_CHARS);
      stdout = result.text;
      stdoutCapped = stdoutCapped || result.capped;
      // Only stream while the run is still live: once the timeout has settled
      // the promise, the child may keep emitting until the group is killed
      // (up to 3s later), and forwarding those late chunks would make the
      // renderer flush a dead run's tail into the next run's debug log.
      if (!settled) options.onOutput?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = stderrDecoder.write(chunk);
      const result = accumulateOutput(stderr, text, MAX_PROCESS_OUTPUT_CHARS);
      stderr = result.text;
      stderrCapped = stderrCapped || result.capped;
      if (!settled) options.onOutput?.(text);
    });
    child.on("close", (code) => {
      runningChildren.delete(child);
      cancelHardKill();
      // Flush any trailing partial UTF-8 sequence held by the decoders so the
      // final captured output is never missing its last character.
      const tailOut = stdoutDecoder.end();
      const tailErr = stderrDecoder.end();
      if (tailOut) stdout = accumulateOutput(stdout, tailOut, MAX_PROCESS_OUTPUT_CHARS).text;
      if (tailErr) stderr = accumulateOutput(stderr, tailErr, MAX_PROCESS_OUTPUT_CHARS).text;
      finish({ ok: code === 0, code, stdout, stderr });
    });
    child.on("error", (error) => {
      // A failed spawn never emits "close", so drop the tracking entry here.
      runningChildren.delete(child);
      cancelHardKill();
      // spawn() reports a nonexistent cwd as ENOENT with the command in
      // error.path — the same code a missing binary produces — and runCodex
      // hands a model-controlled cwd to spawn, so a working directory that
      // does not exist would otherwise surface as the misleading "codex was
      // not found on PATH" and make the model (and the user relaying it)
      // blame the install instead of the path. Check the cwd this spawn
      // actually used: if it is gone, that is the failure to report. A
      // missing binary (ENOENT) or a non-executable one (EACCES) stays the
      // most common first-run failure and keeps its actionable message so
      // the user knows the command is not installed instead of guessing from
      // "spawn codex ENOENT".
      if (error?.code === "ENOENT" && !fs.existsSync(options.cwd || DEFAULT_WORKDIR)) {
        finish({
          ok: false,
          code: -1,
          stdout,
          stderr: `The working directory does not exist: ${options.cwd || DEFAULT_WORKDIR}`,
        });
        return;
      }
      finish({ ok: false, code: -1, stdout, stderr: humanizeSpawnError(command, error) });
    });
  });
}

async function readKeychainApiKey() {
  const result = await runProcess("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  return result.ok ? result.stdout.trim() : "";
}

// Pass the key via stdin so it never shows up in `ps` output.
function saveKeychainApiKey(apiKey) {
  return runProcess(
    "security",
    ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", "-U"],
    { stdin: apiKey },
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 720,
    show: true,
    alwaysOnTop: true,
    title: "Codex Voice Bridge",
    backgroundColor: "#090a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Drop the reference when the window is closed (Cmd+W on macOS) so shortcut
  // handlers never touch a destroyed BrowserWindow.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // Defense in depth: the renderer never opens windows or navigates away from
  // its own HTML, so deny both. This complements the exact-URL IPC sender check.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== RENDERER_URL) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  else {
    // A hidden-but-minimized window would otherwise stay in the Dock and only
    // show a restored-but-unfocused window.
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

async function createRealtimeClientSecret(options = {}) {
  const apiKey = runtimeApiKey || (await readKeychainApiKey()) || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Add an OpenAI API key in the app or set OPENAI_API_KEY before starting.");

  const mode = ["assistant", "translate", "transcribe"].includes(options.mode) ? options.mode : "assistant";
  if (mode === "translate") return createTranslationClientSecret(apiKey, options);
  if (mode === "transcribe") return createTranscriptionClientSecret(apiKey, options);
  return createAssistantClientSecret(apiKey, options);
}

async function createAssistantClientSecret(apiKey, options = {}) {
  const body = {
    session: {
      type: "realtime",
      model: DEFAULT_MODEL,
      reasoning: { effort: normalizeReasoningEffort(options.reasoningEffort, DEFAULT_REASONING_EFFORT) },
      instructions: [
        "You are Samantha for Codex, a concise Spanish voice interface for a local macOS coding agent.",
        `Speak naturally and briefly. Tone: ${normalizeTone(options.tone)}.`,
        "Use short audible preambles before work.",
        "Use run_codex for local project inspection or coding-agent requests.",
        "Use open_app for visible macOS app control.",
        "Use run_cua_driver for macOS UI inspection and operation through CUA Driver.",
        "Never request secrets. Never perform destructive actions without explicit user confirmation.",
      ].join(" "),
      audio: {
        input: {
          transcription: { model: DEFAULT_TRANSCRIBE_MODEL },
          noise_reduction: { type: "near_field" },
        },
        output: { voice: DEFAULT_VOICE },
      },
      tools: assistantTools(),
      tool_choice: "auto",
    },
  };

  let response = await postOpenAIJson(apiKey, "https://api.openai.com/v1/realtime/client_secrets", body);
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 400 && message.toLowerCase().includes("reasoning")) {
      delete body.session.reasoning;
      response = await postOpenAIJson(apiKey, "https://api.openai.com/v1/realtime/client_secrets", body);
    } else {
      throw new Error(`OpenAI Realtime token failed: ${response.status} ${message}`);
    }
  }
  if (!response.ok) throw new Error(`OpenAI Realtime token failed: ${response.status} ${await response.text()}`);

  return normalizeRealtimeToken(await response.json(), {
    mode: "assistant",
    callEndpoint: "https://api.openai.com/v1/realtime/calls",
    model: DEFAULT_MODEL,
  });
}

async function createTranslationClientSecret(apiKey, options = {}) {
  const targetLanguage = options.targetLanguage || DEFAULT_TARGET_LANGUAGE;
  const body = {
    session: {
      model: DEFAULT_TRANSLATE_MODEL,
      audio: {
        input: {
          transcription: { model: DEFAULT_TRANSCRIBE_MODEL },
          noise_reduction: { type: "near_field" },
        },
        output: { language: targetLanguage },
      },
    },
  };
  const response = await postOpenAIJson(apiKey, "https://api.openai.com/v1/realtime/translations/client_secrets", body);
  if (!response.ok) {
    throw new Error(`OpenAI Realtime translation token failed: ${response.status} ${await response.text()}`);
  }
  return normalizeRealtimeToken(await response.json(), {
    mode: "translate",
    callEndpoint: "https://api.openai.com/v1/realtime/translations/calls",
    model: DEFAULT_TRANSLATE_MODEL,
    targetLanguage,
  });
}

async function createTranscriptionClientSecret(apiKey, options = {}) {
  const transcription = {
    model: DEFAULT_TRANSCRIBE_MODEL,
    prompt: "Codex, CUA Driver, OpenAI Realtime, macOS app control, Spanish and English technical vocabulary.",
  };
  if (options.sourceLanguage) transcription.language = options.sourceLanguage;

  const body = {
    session: {
      type: "transcription",
      audio: {
        input: {
          transcription,
          noise_reduction: { type: "near_field" },
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 350 },
        },
      },
    },
  };
  const response = await postOpenAIJson(apiKey, "https://api.openai.com/v1/realtime/client_secrets", body);
  if (!response.ok) {
    throw new Error(`OpenAI Realtime transcription token failed: ${response.status} ${await response.text()}`);
  }
  return normalizeRealtimeToken(await response.json(), {
    mode: "transcribe",
    callEndpoint: "https://api.openai.com/v1/realtime/calls",
    model: DEFAULT_TRANSCRIBE_MODEL,
  });
}

function postOpenAIJson(apiKey, url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": SAFETY_ID,
    },
    body: JSON.stringify(body),
    // Never let a hung network call leave the Connect flow (and the IPC
    // handler behind it) pending forever.
    signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
  }).catch((error) => {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_REQUEST_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw error;
  });
}

function normalizeRealtimeToken(payload, meta) {
  const value = payload?.value || payload?.client_secret?.value;
  if (!value) throw new Error("Realtime token response did not include a usable client secret value.");
  return { ...meta, value };
}

function assistantTools() {
  return [
    {
      type: "function",
      name: "run_codex",
      description: "Run a local Codex CLI request in read-only mode.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "run_cua_driver",
      description: "Run a local cua-driver tool to inspect or operate macOS apps.",
      parameters: {
        type: "object",
        properties: {
          tool_name: { type: "string" },
          json_args: { type: "object" },
          reason: { type: "string" },
        },
        required: ["tool_name", "json_args"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "open_app",
      description:
        "Open or focus a macOS app visibly, or open an http/https URL in the default browser (url alone is enough).",
      parameters: {
        type: "object",
        properties: {
          app_name: { type: "string" },
          bundle_id: { type: "string" },
          url: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "type_text_in_front_app",
      description: "Type text into the currently frontmost macOS app using CUA Driver.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "press_key_in_front_app",
      description: "Press a key in the currently frontmost macOS app using CUA Driver.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          modifiers: { type: "array", items: { type: "string" } },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  ];
}

// Keep the model inside the configured workspace (see resolveWorkdir in lib.js).

function runCodex(input) {
  // The model may omit the required prompt field (or send a non-string). A
  // missing prompt would otherwise reach spawn() as the literal string
  // "undefined" and trigger a pointless Codex run, so refuse it cleanly and
  // let the model self-correct from the error message.
  const promptError = requireNonEmptyString(input?.prompt, "prompt");
  if (promptError) return Promise.resolve({ ok: false, code: -5, stdout: "", stderr: promptError });
  // A single argv entry on macOS is capped (~256 KiB); an unbounded prompt
  // would make spawn() fail with E2BIG, so reject oversized prompts cleanly.
  const lengthError = requireMaxLength(input?.prompt, "prompt");
  if (lengthError) return Promise.resolve({ ok: false, code: -6, stdout: "", stderr: lengthError });
  // A prompt containing a null byte (JSON args can encode "\u0000") would
  // make spawn() throw a synchronous TypeError ("must be a string without
  // null bytes") instead of settling with a clean error, so reject it like
  // the length guard above. The prompt becomes a direct argv entry after
  // "--", so the same argv constraints apply.
  const promptNullError = requireNoNullBytes(input?.prompt, "prompt");
  if (promptNullError) return Promise.resolve({ ok: false, code: -6, stdout: "", stderr: promptNullError });
  // cwd is interpolated into the codex argv as "--cd <workdir>" — the same
  // single-argv-entry cap applies, so a model-controlled megabyte path would
  // otherwise make spawn() fail with E2BIG. 4096 bytes covers any real path.
  const cwdLengthError = requireMaxLength(input?.cwd, "cwd", 4096);
  if (cwdLengthError) return Promise.resolve({ ok: false, code: -6, stdout: "", stderr: cwdLengthError });
  // A null byte in cwd would make spawn() throw on BOTH the "--cd <workdir>"
  // argv entry and the cwd option ("options.cwd must be a string ... without
  // null bytes") instead of settling with a clean error — same guard as the
  // prompt above, before resolveWorkdir normalizes the path.
  const cwdNullError = requireNoNullBytes(input?.cwd, "cwd");
  if (cwdNullError) return Promise.resolve({ ok: false, code: -6, stdout: "", stderr: cwdNullError });
  const { prompt, cwd } = input;
  const workdir = resolveWorkdir(cwd, DEFAULT_WORKDIR);
  // "--" terminates option parsing so a prompt that starts with "-" (e.g. a
  // model-generated flag) can never be interpreted as a codex CLI option and
  // escape the read-only sandbox.
  return runProcess("codex", ["exec", "--cd", workdir, "--sandbox", "read-only", "--skip-git-repo-check", "--", prompt], {
    cwd: workdir,
    timeoutMs: CODEX_TIMEOUT_MS,
    // A run can outlive the window (Cmd+W while Codex streams output): sending
    // to a destroyed webContents throws "Object has been destroyed", so guard
    // the same way toggleWindow/second-instance/activate do instead of relying
    // on the optional chain alone (mainWindow is only nulled on "closed").
    onOutput: (chunk) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("codex-output", chunk);
    },
  });
}

function runCuaDriver(input = {}) {
  // Same optional chaining as runCodex: a null IPC payload must settle with
  // the clean "Missing cua-driver tool_name." error below instead of throwing
  // a TypeError that bypasses the model-facing error path entirely.
  // cua-driver's tool registry is lowercase snake_case, and the model very
  // plausibly emits a capitalized or whitespace-padded variant ("Launch_App",
  // "List_Apps", " press_key ") from natural-language reasoning — the same
  // cosmetic noise the press_key key/modifiers normalization already handles.
  // Normalize once at the source so the canonical lowercase name flows
  // through the blocked-tool set, the launch_app safety gates, and the driver
  // call identically; an unnormalized name would otherwise pass the
  // (case-insensitive) gate and reach the driver, failing with an opaque
  // error the model cannot self-correct from — and a capitalized
  // "Launch_App" would skip the launch_app safety checks entirely. The
  // original value is kept for error messages so the model sees what it sent.
  const rawToolName = input?.tool_name;
  const toolName = typeof rawToolName === "string" ? rawToolName.trim().toLowerCase() : rawToolName;
  if (!toolName || typeof toolName !== "string") {
    return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: "Missing cua-driver tool_name." });
  }
  // Only accept plain snake_case identifiers: a tool_name like "--version" or
  // "call --help" would otherwise be parsed as a cua-driver CLI option.
  if (!isSafeCuaToolName(toolName)) {
    return Promise.resolve({ ok: false, code: -4, stdout: "", stderr: `Invalid cua-driver tool_name: ${rawToolName}.` });
  }
  if (CUA_BLOCKED_TOOLS.has(toolName)) {
    return Promise.resolve({ ok: false, code: -3, stdout: "", stderr: `Blocked cua-driver tool for safety: ${toolName}.` });
  }
  // The serialized args blob becomes a single argv entry (~256 KiB cap on
  // macOS, ARG_MAX 1 MiB for the whole block), so an unbounded json_args from
  // the model would make spawn() fail with E2BIG — reject it cleanly like the
  // prompt/text guards do.
  const normalizedArgs = normalizeCuaArgs(toolName, input.json_args, input);
  // press_key/type_text_chars need key/text, and the run_cua_driver schema
  // only requires tool_name+json_args: a model call with the field missing
  // would otherwise reach cua-driver and fail with an opaque error the model
  // cannot self-correct from — the same class of failure the dedicated
  // type_text_in_front_app/press_key_in_front_app guards prevent. Runs on
  // the NORMALIZED args so a whitespace-only key that trims to "" fails here.
  // The typing budget must track the configured driver timeout, not the 48s
  // default: with a shorter CODEX_VOICE_CUA_TIMEOUT_MS, the default budget
  // would let a text through that cannot fit the actual timeout and fail
  // with a driver timeout — the exact failure the guard exists to prevent
  // (same headroom math as typeTextInFrontApp).
  const requiredArgsError = validateCuaDriverRequiredArgs(toolName, normalizedArgs, Math.floor(CUA_TIMEOUT_MS * 0.8));
  if (requiredArgsError) {
    return Promise.resolve({ ok: false, code: -5, stdout: "", stderr: requiredArgsError });
  }
  // launch_app reaches the same local-app machinery as the open_app path, so
  // it must obey the same gates: a model-supplied file:// or custom-scheme URL
  // (or an unsafe app identity) must not slip past the checks open_app applies.
  if (toolName === "launch_app" && !isSafeCuaLaunchArgs(normalizedArgs)) {
    return Promise.resolve({
      ok: false,
      code: -9,
      stdout: "",
      stderr: "Rejected unsafe launch_app arguments (only http/https URLs and a safe app identity may be used).",
    });
  }
  const argsBlob = JSON.stringify(normalizedArgs);
  const argsLengthError = requireMaxLength(argsBlob, "json_args");
  if (argsLengthError) return Promise.resolve({ ok: false, code: -7, stdout: "", stderr: argsLengthError });
  const args = ["call", toolName, argsBlob, "--compact"];
  return runProcess("cua-driver", args, {
    timeoutMs: CUA_TIMEOUT_MS,
    // Same destroyed-window guard as runCodex: a cua-driver call streaming
    // output while the window is closing must not throw on webContents.send.
    onOutput: (chunk) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("codex-output", chunk);
    },
  });
}

async function runMacAction(input = {}) {
  // Same optional chaining as runCodex/runCuaDriver: a null IPC payload must
  // settle with the "Unknown mac action" error below instead of throwing a
  // TypeError inside the ipcMain.handle guard.
  if (input?.action === "open_app") return openAppVisible(input);
  if (input?.action === "type_text_in_front_app") return typeTextInFrontApp(input);
  if (input?.action === "press_key_in_front_app") return pressKeyInFrontApp(input);
  return { ok: false, code: -1, stdout: "", stderr: `Unknown mac action: ${input?.action}` };
}

async function openAppVisible(input = {}) {
  const target = resolveOpenAppTarget(input);
  if (target.kind === "error") {
    return { ok: false, code: target.code, stdout: "", stderr: target.message };
  }
  if (target.kind === "url") {
    // URL-only opens go to the default browser. The URL is validated to be
    // http/https with a real hostname and passed as a single argv entry via
    // spawn (no shell), so it cannot smuggle options or extra commands.
    return runProcess("open", [target.url], { timeoutMs: 15000 });
  }
  const resolved = target.identity;
  if (!isSafeAppIdentity(resolved)) {
    return { ok: false, code: -8, stdout: "", stderr: "Rejected unsafe app_name or bundle_id." };
  }

  const launchArgs = {};
  if (resolved.bundle_id) launchArgs.bundle_id = resolved.bundle_id;
  else launchArgs.name = resolved.name;
  if (input.url) {
    // Normalize the URL once at the source, exactly like the URL-only path
    // (resolveOpenAppTarget trims before opening) and normalizeCuaArgs do:
    // isSafeLaunchUrl validates the trimmed form, so the raw value must not
    // be the one handed to cua-driver. The launch currently works only
    // because runCuaDriver re-trims urls downstream — the string that passed
    // validation should be the string that is launched, never a
    // whitespace-padded variant of it.
    const url = String(input.url).trim();
    // Same argv-bound cap as resolveOpenAppTarget's URL-only path: the url
    // travels inside launchArgs.urls to cua-driver as a single argv entry,
    // so a model-controlled megabyte URL must be rejected here with a clear
    // message instead of failing downstream with an opaque E2BIG.
    const urlLengthError = requireMaxLength(url, "url", 8192);
    if (urlLengthError) return { ok: false, code: -9, stdout: "", stderr: urlLengthError };
    // Same argv-entry constraint as the cap above: a URL containing a null
    // byte (JSON args can encode "\u0000") would make spawn() throw a
    // synchronous TypeError somewhere downstream instead of settling with a
    // clean error. (cua-driver receives the URL JSON-escaped, so the raw
    // value can only reach a spawn here; reject it at the source like
    // resolveOpenAppTarget does for the URL-only path.)
    const urlNullError = requireNoNullBytes(url, "url");
    if (urlNullError) return { ok: false, code: -9, stdout: "", stderr: urlNullError };
    // Only http/https URLs may be opened: a model-controlled file:// or custom
    // scheme URL could open local files or trigger unintended handlers.
    if (!isSafeLaunchUrl(url)) {
      return { ok: false, code: -9, stdout: "", stderr: "Rejected unsafe url (only http/https URLs may be opened)." };
    }
    launchArgs.urls = [url];
  }

  const cuaResult = await runCuaDriver({ tool_name: "launch_app", json_args: launchArgs, reason: input.reason || "Open app visibly." });
  const activateResult = await activateApp(resolved);
  return {
    ok: cuaResult.ok && activateResult.ok,
    code: cuaResult.ok && activateResult.ok ? 0 : 1,
    // The launch (cua-driver) and the activation (osascript) are independent
    // steps, and the aggregate ok flag does not say which one failed — or
    // whether the launch even happened. Report both outcomes (plus the
    // driver's own launch output, e.g. the resolved pid) so the model can
    // self-correct from the specific failure instead of guessing.
    stdout: JSON.stringify({
      app: resolved,
      launched: cuaResult.ok,
      activated: activateResult.ok,
      launchOutput: cuaResult.stdout,
    }),
    stderr: [cuaResult.stderr, activateResult.stderr].filter(Boolean).join("\n"),
  };
}

async function typeTextInFrontApp(input = {}) {
  const textError = requireNonEmptyString(input.text, "text");
  if (textError) return { ok: false, code: -5, stdout: "", stderr: textError };
  const textLengthError = requireMaxLength(input.text, "text");
  if (textLengthError) return { ok: false, code: -6, stdout: "", stderr: textLengthError };
  // The typing budget must track the configured driver timeout, not the 60s
  // default: with a shorter CODEX_VOICE_CUA_TIMEOUT_MS, the hardcoded 48s
  // budget would let a text through that cannot fit the actual timeout and
  // fail with a driver timeout — the exact failure this guard exists to
  // prevent. Keep ~80% of the timeout as typing budget, same headroom the
  // previous hardcoded value reserved for driver startup and the app lookup.
  const typingBudgetMs = Math.floor(CUA_TIMEOUT_MS * 0.8);
  // At 1ms/char (the typeDelayMs floor) a text longer than the typing budget
  // can never finish inside the driver timeout — the byte cap above does not
  // catch it (100k ASCII chars fit well under 200KB), so reject it cleanly up
  // front and let the model split the text instead of waiting out a doomed
  // run that fails with a timeout.
  const typeableError = requireTypeableLength(input.text.length, typingBudgetMs);
  if (typeableError) return { ok: false, code: -10, stdout: "", stderr: typeableError };
  const active = await getActiveAppFromCua();
  if (!active?.pid) {
    return { ok: false, code: -1, stdout: "", stderr: active?.error || "No active app pid found." };
  }
  // Scale the per-character delay to the text length so long texts fit inside
  // the driver timeout instead of failing mid-way (see typeDelayMs).
  return runCuaDriver({
    tool_name: "type_text_chars",
    json_args: { pid: active.pid, text: input.text, delay_ms: typeDelayMs(input.text.length, 20, typingBudgetMs) },
  });
}

async function pressKeyInFrontApp(input = {}) {
  const keyError = requireNonEmptyString(input.key, "key");
  if (keyError) return { ok: false, code: -5, stdout: "", stderr: keyError };
  // Model-generated JSON often wraps values in stray whitespace or a trailing
  // newline (e.g. a template literal) — the same cosmetic noise the modifiers
  // normalization below and the app_name/url trims in lib.js already handle.
  // An untrimmed key like "return " or "esc\n" would reach cua-driver as-is
  // and fail with an opaque error the model cannot self-correct from, so trim
  // once at the source: the string that passes the gates is the string that
  // is pressed. Trimming cannot weaken the gates — the trimmed value is still
  // re-validated by requireMaxLength below, and a whitespace-only key already
  // failed requireNonEmptyString above.
  // Lowercase for the same reason the modifiers are lowercased below:
  // cua-driver's press_key expects lowercase key names ("return", "escape",
  // "cmd", ...), and a model describing the action in natural language very
  // plausibly sends "Return", "ESC", or "Enter" — a capitalized key would
  // make the driver fail with an opaque error the model cannot self-correct
  // from. Key names are never case-distinct (single letters are the same
  // physical key; capitalization is expressed via the shift modifier), so
  // lowercasing cannot change which key is pressed.
  const key = String(input.key).trim().toLowerCase();
  // A model describing a shortcut in natural language very plausibly puts the
  // whole combo in the key ("cmd+shift+p") instead of a single key plus a
  // modifiers array. cua-driver's press_key expects a single key name, so
  // such a key would reach the driver raw and fail with an opaque error the
  // model cannot self-correct from — the same class of cosmetic noise the
  // modifiers split below already handles. Key names never contain "+", so
  // the split is unambiguous: the last part is the pressed key and the
  // preceding parts join the modifiers pipeline below (trimmed, lowercased,
  // deduped like every other entry). Single keys are untouched. The length
  // gate still runs on the original key — always at least as long as the
  // pressed key — so the split cannot bypass it.
  const keyCombo = key.split("+").map((part) => part.trim()).filter((part) => part.length > 0);
  // "+" is a real key name — the plus key, e.g. Cmd+Plus to zoom in — but
  // the combo split above treats "+" as the separator, so a model wanting
  // the plus key ("cmd++", "cmd + +") would otherwise split to a single
  // "cmd" part and silently degrade to a bare Cmd press (reported as
  // success, wrong action). Only a SECOND "+" marks a real plus key: the
  // string is exactly "+", or the final "+" is preceded by a non-"+",
  // non-space character. A single trailing "+" ("cmd+", "+p") stays stray
  // cosmetic noise — that part IS the key — and all-plus strings ("++")
  // keep normalizing to "" so the required-arg guard rejects them with a
  // clean message (mirrors normalizeCuaArgs). When the plus key is
  // detected, the final "+" IS the key: re-split the prefix so the
  // preceding parts join the modifiers pipeline ("cmd+" -> "cmd").
  const compactKey = key.replace(/\s+/g, "");
  const isPlusKey =
    compactKey === "+" ||
    (compactKey.length >= 3 && compactKey.endsWith("++") && compactKey[compactKey.length - 3] !== "+");
  const pressedKey = isPlusKey
    ? "+"
    : keyCombo.length > 1
      ? keyCombo[keyCombo.length - 1]
      : keyCombo.length === 1
        ? keyCombo[0]
        : "";
  const comboModifiers = isPlusKey
    ? key.slice(0, -1).split("+").map((part) => part.trim()).filter((part) => part.length > 0)
    : keyCombo.slice(0, -1);
  const keyLengthError = requireMaxLength(key, "key", 100);
  if (keyLengthError) return { ok: false, code: -6, stdout: "", stderr: keyLengthError };
  const active = await getActiveAppFromCua();
  if (!active?.pid) {
    return { ok: false, code: -1, stdout: "", stderr: active?.error || "No active app pid found." };
  }
  // cua-driver expects an array of lowercase modifier strings ("cmd", "ctrl",
  // "alt", "shift", ...). Anything else — non-string entries like [42], or a
  // bare string like "cmd" (a very plausible model output) — would be
  // misparsed and make the driver fail with an opaque error, so normalize
  // defensively. A bare string must NOT silently become []: that would press
  // the key WITHOUT the modifier the model asked for (Cmd+X becomes plain X,
  // a different action in the front app). A string therefore becomes a
  // one-element array, every entry is trimmed and lowercased ("CMD",
  // " Command ") so the driver receives the exact form it expects, and
  // non-string entries are dropped.
  const rawModifiers = [
    ...comboModifiers,
    ...(Array.isArray(input.modifiers)
      ? input.modifiers
      : typeof input.modifiers === "string"
        ? [input.modifiers]
        : []),
  ];
  const modifiers = rawModifiers
    .filter((modifier) => typeof modifier === "string")
    .map((modifier) => modifier.trim().toLowerCase())
    // A model describing a shortcut in natural language very plausibly emits
    // a combined modifier entry ("cmd+shift", "CMD + Shift") or a bare combo
    // string ("cmd+shift") instead of the array of individual modifier names
    // cua-driver's press_key expects. Such an entry would reach the driver as
    // one bogus modifier name and fail with an opaque error the model cannot
    // self-correct from. Modifier names never contain "+" (cmd/ctrl/alt/
    // shift/option/...), so splitting every entry on "+" is unambiguous: it
    // can only expand one modifier into the several the model named, never
    // invent one that was not asked for. Parts are trimmed so "CMD + Shift"
    // normalizes like "cmd+shift".
    .flatMap((modifier) => modifier.split("+").map((part) => part.trim()))
    // A whitespace-only entry ("  ", " \n") trims to "" — an empty modifier
    // string would reach cua-driver and fail with an opaque error just like
    // the non-string entries filtered above. Drop it so the driver only ever
    // sees real modifier names.
    .filter((modifier) => modifier.length > 0)
    // A duplicated modifier ("cmd+cmd") is never a meaningful instruction —
    // pressing the same modifier twice is just pressing it once — and a
    // duplicate would be a new shape the driver never sees today, so collapse
    // exact duplicates while keeping the original order.
    .filter((modifier, index, all) => all.indexOf(modifier) === index);
  return runCuaDriver({ tool_name: "press_key", json_args: { pid: active.pid, key: pressedKey, modifiers } });
}

async function getActiveAppFromCua() {
  const result = await runCuaDriver({ tool_name: "list_apps", json_args: {} });
  if (!result.ok) {
    // Surface the real driver failure (e.g. cua-driver not installed) instead
    // of collapsing it into a misleading "no active app" message: the model
    // can self-correct from "cua-driver was not found on PATH" but not from
    // "No active app pid found."
    return { pid: null, error: result.stderr || `cua-driver list_apps failed (code ${result.code}).` };
  }
  // cua-driver may prefix its JSON payload with log lines; a strict parse of
  // the whole stdout would fail and make type/press tools report "No active
  // app" for a valid response.
  try {
    const parsed = extractFirstJsonObject(result.stdout);
    // The driver responded but the payload is not the expected shape (a
    // crash mid-print, a version mismatch, an empty stdout, a proxied
    // response): collapsing that into the generic "No active app pid found."
    // would hide a real driver problem and leave the model unable to
    // self-correct — the same misleading-collapse class the list_apps
    // failure branch above exists to prevent. Only a valid apps array with
    // no active entry means "no active app": that one still returns null so
    // callers report the accurate generic message.
    if (!parsed || !Array.isArray(parsed.apps)) {
      return { pid: null, error: "cua-driver list_apps returned an unexpected payload (no apps list)." };
    }
    // Guard each entry too: a malformed apps array (a null or non-object
    // entry) would otherwise throw inside .find and collapse into the same
    // misleading generic message via the catch below.
    return parsed.apps.find((appInfo) => appInfo && typeof appInfo === "object" && appInfo.active) || null;
  } catch {
    return { pid: null, error: "cua-driver list_apps returned an unreadable payload." };
  }
}

function activateApp(appIdentity) {
  if (!isSafeAppIdentity(appIdentity)) {
    return Promise.resolve({ ok: false, code: -8, stdout: "", stderr: "Rejected unsafe app identity." });
  }
  const escaped = escapeAppleScript(appIdentity.bundle_id || appIdentity.name);
  return appIdentity.bundle_id
    ? runProcess("osascript", ["-e", `tell application id "${escaped}" to activate`])
    : runProcess("osascript", ["-e", `tell application "${escaped}" to activate`]);
}

// Only accept IPC from our own renderer (defense in depth). Exact URL match:
// a suffix check would let any file named src/renderer.html elsewhere on disk
// (e.g. /tmp/src/renderer.html) masquerade as the trusted renderer.
const RENDERER_URL = pathToFileURL(path.join(__dirname, "renderer.html")).href;
function isTrustedSender(event) {
  return event.senderFrame?.url === RENDERER_URL;
}

function guard(handler) {
  return (event, ...args) => {
    if (!isTrustedSender(event)) {
      writeLog("blocked IPC call from untrusted sender", { url: event.senderFrame?.url });
      return { ok: false, error: "Untrusted IPC sender." };
    }
    return handler(event, ...args);
  };
}

process.on("uncaughtException", (error) => writeLog("main uncaughtException", { message: error.message, stack: error.stack }));
process.on("unhandledRejection", (reason) => writeLog("main unhandledRejection", { reason: String(reason), stack: reason?.stack }));

// A second launch would create a second window fighting over the same global
// shortcut and Keychain entries, so keep a single instance and focus it instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // The interview mode's "Capture meeting audio" option calls
    // navigator.mediaDevices.getDisplayMedia() in the renderer; Electron
    // denies that request unless the main process registers a display-media
    // handler, which made the whole interview connect fail with a permission
    // error. Prefer the native system picker (macOS 15+/Windows 11) when the
    // OS provides it — the handler then never runs. On older macOS the handler
    // runs: grant the first screen source with loopback audio (the renderer
    // drops the video track and keeps only the meeting audio), and only for
    // our own renderer frame.
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        if (request.frame?.url !== RENDERER_URL) {
          writeLog("blocked display media request from untrusted frame", { url: request.frame?.url });
          callback({});
          return;
        }
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            // No thumbnails or window icons: cheaper and avoids capturing
            // screen content we never display.
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          });
          const screen = sources.find((source) => source.id.startsWith("screen:")) || sources[0];
          if (!screen) {
            writeLog("display media request denied: no capture sources");
            callback({});
            return;
          }
          callback({ video: screen, audio: "loopback" });
        } catch (error) {
          writeLog("display media handler failed", { error: String(error) });
          callback({});
        }
      },
      { useSystemPicker: true },
    );
    createWindow();
    const registered = globalShortcut.register(SHORTCUT, toggleWindow);
    if (!registered) writeLog("globalShortcut register failed", { shortcut: SHORTCUT });
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // Terminate any still-running child process groups (e.g. a long Codex run)
  // so nothing keeps executing after the app exits.
  for (const child of runningChildren) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Process group already gone.
    }
  }
});

ipcMain.handle("realtime:create-client-secret", guard((_event, options) => createRealtimeClientSecret(options)));
ipcMain.handle("realtime:set-api-key", guard(async (_event, apiKey) => {
  runtimeApiKey = String(apiKey || "").trim();
  // Require the sk- prefix and no whitespace/control characters; be permissive
  // about the payload so exotic-but-valid key formats are not rejected.
  if (!isPlausibleApiKey(runtimeApiKey)) {
    runtimeApiKey = "";
    return { ok: false, error: "The API key format does not look valid." };
  }
  const saved = await saveKeychainApiKey(runtimeApiKey);
  // The key still works for this session even if the Keychain write failed
  // (e.g. locked keychain); report the save status but do not block use.
  if (!saved.ok) writeLog("keychain save failed", { error: saved.stderr });
  return { ok: true, saved: saved.ok, error: saved.stderr };
}));
ipcMain.handle("realtime:key-status", guard(async () => ({
  hasEnvKey: Boolean(process.env.OPENAI_API_KEY),
  hasSavedKey: Boolean(await readKeychainApiKey()),
  hasRuntimeKey: Boolean(runtimeApiKey),
})));
ipcMain.handle("codex:run", guard((_event, input) => runCodex(input)));
ipcMain.handle("cua:run", guard((_event, input) => runCuaDriver(input)));
ipcMain.handle("mac:run", guard((_event, input) => runMacAction(input)));
ipcMain.handle("log:renderer", guard((_event, message, data) => {
  writeLog(`renderer:${message}`, data);
  return { ok: true };
}));
ipcMain.handle("log:path", guard(() => LOG_FILE));
ipcMain.handle("app:config", guard(() => ({
  version: APP_VERSION,
  model: DEFAULT_MODEL,
  translateModel: DEFAULT_TRANSLATE_MODEL,
  transcribeModel: DEFAULT_TRANSCRIBE_MODEL,
  voice: DEFAULT_VOICE,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  // Resolve the workdir exactly like runCodex does: the raw env value may be
  // a relative path, a symlink, or a path that does not exist yet, and
  // resolveWorkdir normalizes all three (realpath, mkdir, containment
  // fallback). Showing the raw value here would let the UI claim a directory
  // that Codex never operates on (e.g. "~/codex" while Codex uses
  // "/Users/you/codex" after ~ expansion).
  workdir: resolveWorkdir(undefined, DEFAULT_WORKDIR),
  shortcut: SHORTCUT,
  actionTimeoutMs: ACTION_TIMEOUT_MS,
  // The renderer's SDP exchange is the second OpenAI HTTP hop of a connect
  // (token fetch here, then the offer/answer call there); expose the same
  // configured timeout so CODEX_VOICE_OPENAI_TIMEOUT_MS governs both instead
  // of the renderer falling back to a hardcoded 60s.
  openaiTimeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
})));
