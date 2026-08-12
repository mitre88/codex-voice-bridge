import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  accumulateOutput,
  applyEnvOverrides,
  escapeAppleScript,
  isPlausibleApiKey,
  isSafeCuaToolName,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTone,
  parseEnvFile,
  redactSecrets,
  resolveAppIdentity,
  resolveWorkdir,
  toPositiveInt,
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
      const loaded = applyEnvOverrides(parseEnvFile(fs.readFileSync(file, "utf8")), process.env);
      console.log(`codex-voice-bridge: loaded env overrides from ${file} (${Object.keys(loaded).length} vars present)`);
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
const DEFAULT_REASONING_EFFORT = process.env.OPENAI_REALTIME_REASONING_EFFORT || "low";
const DEFAULT_TARGET_LANGUAGE = process.env.OPENAI_REALTIME_TARGET_LANGUAGE || "es";
// Fall back to the home directory when launched from Finder/Dock (cwd === "/").
const processCwd = process.cwd();
const DEFAULT_WORKDIR = path.resolve(
  process.env.CODEX_VOICE_WORKDIR || (processCwd === path.parse(processCwd).root ? os.homedir() : processCwd),
);
const CODEX_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_TIMEOUT_MS, 120000);
const CUA_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_CUA_TIMEOUT_MS, 60000);
const OPENAI_REQUEST_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_OPENAI_TIMEOUT_MS, 60000);
// Bound how much stdout/stderr a child process can accumulate in memory before
// we drop the excess; a runaway command must not grow the main process forever.
const MAX_PROCESS_OUTPUT_CHARS = 1024 * 1024;
const KEYCHAIN_SERVICE = "codex-voice-bridge.openai-api-key";
const KEYCHAIN_ACCOUNT = process.env.USER || "local";
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "codex-voice-bridge");
const LOG_FILE = path.join(LOG_DIR, "bridge.log");
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const SAFETY_ID = crypto.createHash("sha256").update(`${process.env.USER || "local"}:codex-voice-bridge`).digest("hex");
const SHORTCUT = process.env.CODEX_VOICE_SHORTCUT || "CommandOrControl+Shift+Space";

const CUA_BLOCKED_TOOLS = new Set(["hotkey", "move_cursor", "replay_trajectory", "set_recording"]);

let mainWindow;
let runtimeApiKey = "";
let logStream = null;

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
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // First run or file missing: nothing to rotate.
  }
}

function writeLog(message, data) {
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
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || DEFAULT_WORKDIR,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so we can kill descendants too
    });
    child.stdin.end(options.stdin || "");

    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    let stderrCapped = false;
    let settled = false;

    function killProcessGroup(signal) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Process group already gone.
      }
    }

    const timeout = setTimeout(() => {
      killProcessGroup("SIGTERM");
      // Give children a moment to exit, then force-kill the whole group.
      const hardKill = setTimeout(() => killProcessGroup("SIGKILL"), 3000);
      hardKill.unref();
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
      if (stdoutCapped && typeof out === "string") out += "\n...[stdout truncated at 1MB]";
      if (stderrCapped && typeof err === "string") err += "\n...[stderr truncated at 1MB]";
      resolve({ ...result, stdout: String(out ?? "").trim(), stderr: String(err ?? "").trim() });
    }

    child.stdout.on("data", (chunk) => {
      const result = accumulateOutput(stdout, chunk, MAX_PROCESS_OUTPUT_CHARS);
      stdout = result.text;
      stdoutCapped = stdoutCapped || result.capped;
      options.onOutput?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      const result = accumulateOutput(stderr, chunk, MAX_PROCESS_OUTPUT_CHARS);
      stderr = result.text;
      stderrCapped = stderrCapped || result.capped;
      options.onOutput?.(chunk.toString());
    });
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr }));
    child.on("error", (error) => finish({ ok: false, code: -1, stdout, stderr: error.message }));
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
      description: "Open or focus a macOS app visibly.",
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

function runCodex({ prompt, cwd }) {
  const workdir = resolveWorkdir(cwd, DEFAULT_WORKDIR);
  // "--" terminates option parsing so a prompt that starts with "-" (e.g. a
  // model-generated flag) can never be interpreted as a codex CLI option and
  // escape the read-only sandbox.
  return runProcess("codex", ["exec", "--cd", workdir, "--sandbox", "read-only", "--skip-git-repo-check", "--", prompt], {
    cwd: workdir,
    timeoutMs: CODEX_TIMEOUT_MS,
    onOutput: (chunk) => mainWindow?.webContents.send("codex-output", chunk),
  });
}

function runCuaDriver(input = {}) {
  const toolName = input.tool_name;
  if (!toolName || typeof toolName !== "string") {
    return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: "Missing cua-driver tool_name." });
  }
  // Only accept plain snake_case identifiers: a tool_name like "--version" or
  // "call --help" would otherwise be parsed as a cua-driver CLI option.
  if (!isSafeCuaToolName(toolName)) {
    return Promise.resolve({ ok: false, code: -4, stdout: "", stderr: `Invalid cua-driver tool_name: ${toolName}.` });
  }
  if (CUA_BLOCKED_TOOLS.has(toolName)) {
    return Promise.resolve({ ok: false, code: -3, stdout: "", stderr: `Blocked cua-driver tool for safety: ${toolName}.` });
  }
  const args = ["call", toolName, JSON.stringify(normalizeCuaArgs(toolName, input.json_args, input)), "--compact"];
  return runProcess("cua-driver", args, {
    timeoutMs: CUA_TIMEOUT_MS,
    onOutput: (chunk) => mainWindow?.webContents.send("codex-output", chunk),
  });
}

async function runMacAction(input = {}) {
  if (input.action === "open_app") return openAppVisible(input);
  if (input.action === "type_text_in_front_app") return typeTextInFrontApp(input);
  if (input.action === "press_key_in_front_app") return pressKeyInFrontApp(input);
  return { ok: false, code: -1, stdout: "", stderr: `Unknown mac action: ${input.action}` };
}

async function openAppVisible(input = {}) {
  const resolved = resolveAppIdentity(input);
  if (!resolved.bundle_id && !resolved.name) return { ok: false, code: -1, stdout: "", stderr: "Missing app_name or bundle_id." };

  const launchArgs = {};
  if (resolved.bundle_id) launchArgs.bundle_id = resolved.bundle_id;
  else launchArgs.name = resolved.name;
  if (input.url) launchArgs.urls = [input.url];

  const cuaResult = await runCuaDriver({ tool_name: "launch_app", json_args: launchArgs, reason: input.reason || "Open app visibly." });
  const activateResult = await activateApp(resolved);
  return {
    ok: cuaResult.ok && activateResult.ok,
    code: cuaResult.ok && activateResult.ok ? 0 : 1,
    stdout: JSON.stringify({ app: resolved, activated: activateResult.ok }),
    stderr: [cuaResult.stderr, activateResult.stderr].filter(Boolean).join("\n"),
  };
}

async function typeTextInFrontApp(input = {}) {
  if (!input.text) return { ok: false, code: -1, stdout: "", stderr: "Missing text." };
  const active = await getActiveAppFromCua();
  if (!active?.pid) return { ok: false, code: -1, stdout: "", stderr: "No active app pid found." };
  return runCuaDriver({ tool_name: "type_text_chars", json_args: { pid: active.pid, text: input.text, delay_ms: 20 } });
}

async function pressKeyInFrontApp(input = {}) {
  if (!input.key) return { ok: false, code: -1, stdout: "", stderr: "Missing key." };
  const active = await getActiveAppFromCua();
  if (!active?.pid) return { ok: false, code: -1, stdout: "", stderr: "No active app pid found." };
  return runCuaDriver({ tool_name: "press_key", json_args: { pid: active.pid, key: input.key, modifiers: input.modifiers || [] } });
}

async function getActiveAppFromCua() {
  const result = await runCuaDriver({ tool_name: "list_apps", json_args: {} });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout)?.apps?.find((appInfo) => appInfo.active) || null;
  } catch {
    return null;
  }
}

function activateApp(appIdentity) {
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

app.on("will-quit", () => globalShortcut.unregisterAll());

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
  model: DEFAULT_MODEL,
  translateModel: DEFAULT_TRANSLATE_MODEL,
  transcribeModel: DEFAULT_TRANSCRIBE_MODEL,
  voice: DEFAULT_VOICE,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  workdir: DEFAULT_WORKDIR,
  shortcut: SHORTCUT,
})));
