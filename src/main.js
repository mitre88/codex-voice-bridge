import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session, safeStorage, systemPreferences } from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postOpenAIJson as requestOpenAIJson } from "./openai-request.js";
import { createCredentialStore } from "./credentials.js";
import { createOperationRegistry } from "./operations.js";
import { createProcessRunner } from "./process-runner.js";
import { createBoundedLogger } from "./logger.js";
import { capabilitySnapshot, resolveExecutable, TRUSTED_BIN_DIRS } from "./capabilities.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyEnvOverrides,
  escapeAppleScript,
  extractFirstJsonObject,
  isSafeAppIdentity,
  isSafeCuaLaunchArgs,
  isSafeCuaToolName,
  isSafeLaunchUrl,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTargetLanguage,
  normalizeTone,
  normalizeToneKey,
  normalizeVoice,
  parseEnvFile,
  redactSecrets,
  requireMaxLength,
  requireNoNullBytes,
  requireNonEmptyString,
  requireTypeableLength,
  resolveOpenAppTarget,
  resolveWorkdir,
  toPositiveInt,
  typeDelayMs,
  validateCuaDriverRequiredArgs,
  validateCuaRegistry,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional .env support with zero dependencies: load <cwd>/.env — or the file
// pointed to by CODEX_VOICE_ENV_FILE — before any configuration constant is
// read. Variables already present in the environment are never overridden.
// This must run before DEFAULT_MODEL/DEFAULT_WORKDIR/... are evaluated.
function loadDotEnv() {
  // Trim CODEX_VOICE_ENV_FILE at the source: a whitespace-padded value (a
  // shell export with a trailing space, a launchd plist string with stray
  // whitespace) would otherwise make existsSync fail and the custom .env be
  // silently skipped — the user's overrides never load, with no error — the
  // same cosmetic-noise class of failure the WORKDIR/SHORTCUT trims prevent.
  // A whitespace-only value trims to "" and falls back to <cwd>/.env exactly
  // like an unset variable (the empty string is dropped by filter(Boolean)).
  const candidates = [process.env.CODEX_VOICE_ENV_FILE?.trim(), path.join(process.cwd(), ".env")].filter(Boolean);
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

// Trim the model/voice env values at the source: a whitespace-padded value (a
// shell export with a trailing space, a launchd plist string with stray
// whitespace) would otherwise be sent to the OpenAI API as-is and rejected
// with a 400 on every connect — the same cosmetic-noise class of failure the
// WORKDIR/SHORTCUT/API-key trims prevent. A whitespace-only value trims to ""
// and falls back to the default exactly like an unset variable.
const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2";
const DEFAULT_TRANSLATE_MODEL = process.env.OPENAI_REALTIME_TRANSLATE_MODEL?.trim() || "gpt-realtime-translate";
const DEFAULT_TRANSCRIBE_MODEL = process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL?.trim() || "gpt-realtime-whisper";
const DEFAULT_VOICE = normalizeVoice(process.env.OPENAI_REALTIME_VOICE);
// Normalize the .env value at the source: a typo like "banana" would
// otherwise surface in the UI select (no matching option) and reach the API
// (forcing the reasoning-400 retry on every connect) instead of falling back
// to a valid effort. normalizeReasoningEffort is case- and whitespace-
// insensitive ("HIGH" and " High " both normalize to "high") and falls back
// to "low" for any value outside minimal/low/medium/high/xhigh.
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.OPENAI_REALTIME_REASONING_EFFORT || "low");
// Mirror the reasoning-effort env var: the tone dropdown always defaulted to
// "calm", so a user who configured OPENAI_REALTIME_TONE in .env (or exported
// it for a launchd run) had to re-pick the tone in the UI on every launch —
// or silently got calm. normalizeToneKey is case- and whitespace-insensitive
// and falls back to "calm" for any invalid value, exactly like the reasoning
// effort fallback, so a padded or mistyped value can never produce an
// unknown tone key in the UI.
const DEFAULT_TONE = normalizeToneKey(process.env.OPENAI_REALTIME_TONE || "calm");
// Mirror the reasoning-effort/tone env vars: the target-language select
// always defaulted to "es", so a user who configured
// OPENAI_REALTIME_TARGET_LANGUAGE in .env (or exported it for a launchd run)
// with an uppercase or padded value ("ES", " Es ") had it sent to the API
// raw — an unknown language 400s every translate-mode connect and shows no
// matching option in the UI select. normalizeTargetLanguage is case- and
// whitespace-insensitive and falls back to "es" for any value outside the
// renderer's language list, exactly like the tone/effort fallbacks, so a
// padded or mistyped value can never produce an unknown language in the UI
// or at the API.
const DEFAULT_TARGET_LANGUAGE = normalizeTargetLanguage(process.env.OPENAI_REALTIME_TARGET_LANGUAGE || "es");
// Fall back to the home directory when launched from Finder/Dock (cwd === "/").
const processCwd = process.cwd();
// Trim CODEX_VOICE_WORKDIR at the source: a whitespace-padded value (a shell
// export with a trailing space, a launchd plist string with stray whitespace)
// would otherwise keep the padding through path.resolve and make every codex
// run fail with "The working directory does not exist" for a perfectly valid
// directory — the same cosmetic-noise class of failure the resolved API key
// trim prevents. A whitespace-only value trims to "" and falls back to the
// launch cwd/home exactly like an unset variable.
const DEFAULT_WORKDIR = path.resolve(
  process.env.CODEX_VOICE_WORKDIR?.trim() || (processCwd === path.parse(processCwd).root ? os.homedir() : processCwd),
);
const CODEX_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_TIMEOUT_MS, 120000);
const CUA_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_CUA_TIMEOUT_MS, 60000);
const OPENAI_REQUEST_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_OPENAI_TIMEOUT_MS, 60000);
// How long a pending local action may wait for the human to approve/reject it
// before the renderer auto-rejects it so the model never hangs forever.
const ACTION_TIMEOUT_MS = toPositiveInt(process.env.CODEX_VOICE_ACTION_TIMEOUT_MS, 120000);
// Bound how much stdout/stderr a child process can accumulate in memory before
// we drop the excess; a runaway command must not grow the main process forever.
const KEYCHAIN_SERVICE = "codex-voice-bridge.openai-api-key";
// Trim USER at the source, same as the WORKDIR/SHORTCUT/ALWAYS_ON_TOP/ENV_FILE
// trims: a whitespace-padded value (a launchd plist string with stray
// whitespace, a shell export with a trailing space) would otherwise flow into
// the Keychain account name and the safety identifier. The account is what
// saveApiKey() writes and readApiKey() looks up — a padded account saved from
// one launch context (Terminal) would not match the account read from another
// (launchd), so the stored key would silently stop resolving. A
// whitespace-only value trims to "" and falls back to "local" exactly like an
// unset variable.
const USER = process.env.USER?.trim() || "local";
const KEYCHAIN_ACCOUNT = USER;
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "codex-voice-bridge");
const LOG_FILE = path.join(LOG_DIR, app.isPackaged ? "bridge.log" : "bridge-dev.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const SAFETY_ID = crypto.createHash("sha256").update(`${USER}:codex-voice-bridge`).digest("hex");
// Trim CODEX_VOICE_SHORTCUT at the source: a whitespace-padded value (a shell
// export with a trailing space, a launchd plist string with stray whitespace)
// would otherwise make globalShortcut.register fail — reported only as a log
// line, so the user silently loses the toggle shortcut — and the same padded
// string would show in the UI config line. A whitespace-only value trims to ""
// and falls back to the default exactly like an unset variable, the same
// cosmetic-noise class of failure the WORKDIR/ALWAYS_ON_TOP trims prevent.
const SHORTCUT = process.env.CODEX_VOICE_SHORTCUT?.trim() || "CommandOrControl+Shift+Space";
// Whether the bridge window floats above every other window. Always-on-top
// keeps the bridge visible while voice commands drive another app, but the
// window then covers whatever the user is reading during idle stretches;
// CODEX_VOICE_ALWAYS_ON_TOP=0 opts out without changing the default. Trim at
// the source: a whitespace-padded value (shell export with a trailing space,
// launchd plist string with stray whitespace) would otherwise silently keep
// always-on-top enabled — the opposite of the opt-out the user asked for —
// the same cosmetic-noise class of failure the WORKDIR trim prevents.
const ALWAYS_ON_TOP = process.env.CODEX_VOICE_ALWAYS_ON_TOP?.trim() !== "0";

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
const operations = createOperationRegistry();
const operationContext = new AsyncLocalStorage();
const processRunner = createProcessRunner();
let credentials;
const executablePaths = {
  codex: resolveExecutable("codex", process.env.CODEX_VOICE_CODEX_PATH),
  "cua-driver": resolveExecutable("cua-driver", process.env.CODEX_VOICE_CUA_DRIVER_PATH),
  open: "/usr/bin/open", osascript: "/usr/bin/osascript",
};
const childEnvironment = { ...process.env, PATH: TRUSTED_BIN_DIRS.join(path.delimiter) };
delete childEnvironment.OPENAI_API_KEY;
const logger = createBoundedLogger({
  maxFileBytes: LOG_MAX_BYTES,
  async open() {
    await fs.promises.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
    const size = await fs.promises.stat(LOG_FILE).then(stat => stat.size, () => 0);
    return { stream: fs.createWriteStream(LOG_FILE, { flags: "a", mode: 0o600 }), size };
  },
  async rotate() { await fs.promises.rename(LOG_FILE, `${LOG_FILE}.1`).catch(error => { if (error.code !== "ENOENT") throw error; }); },
});

function writeLog(message, data) {
  try {
    let serialized;
    try { serialized = JSON.stringify(data); } catch { serialized = "[unserializable log data]"; }
    logger.write(redactSecrets(JSON.stringify({ ts: new Date().toISOString(), message: String(message).slice(0, 1000), data: serialized?.slice(0, 50000) })));
  } catch {
    // Logging is best-effort and cannot become an error-handler loop.
  }
}

function runProcess(command, args, options = {}) {
  const context = operationContext.getStore();
  if (context?.signal.aborted) return Promise.resolve({ ok: false, code: -95, stdout: "", stderr: "Session cancelled." });
  const executable = executablePaths[command];
  if (!executable) return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: `${command} was not found in trusted executable locations. Set an explicit absolute path in configuration; standalone voice still works.` });
  return processRunner.run(executable, args, { cwd: DEFAULT_WORKDIR, ...options, env: childEnvironment, signal: context?.signal, onOutput: context ? chunk => context.output(redactSecrets(chunk)) : undefined });
}

async function readKeychainApiKey() {
  // Legacy READ ONLY, once per store load. Never use the generic output/log
  // channel and never put the API key in argv. No record is deleted or updated.
  const result = await processRunner.run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], { timeoutMs: 5000, env: childEnvironment });
  return result.ok ? result.stdout.trim() : "";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    minWidth: 420,
    minHeight: 540,
    height: 720,
    show: true,
    alwaysOnTop: ALWAYS_ON_TOP,
    title: "Codex Voice Bridge",
    backgroundColor: "#090a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // Hiding the panel must not pause active audio/transport.
    },
  });
  // Drop the reference when the window is closed (Cmd+W on macOS) so shortcut
  // handlers never touch a destroyed BrowserWindow.
  const contents = mainWindow.webContents;
  contents.once("destroyed", () => operations.destroy(contents));
  mainWindow.on("hide", () => contents.send("app:visibility", false));
  mainWindow.on("show", () => contents.send("app:visibility", true));
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
  const apiKey = await credentials.resolveKey();
  operationContext.getStore()?.signal.throwIfAborted();
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
        output: { voice: normalizeVoice(options.voice, DEFAULT_VOICE) },
      },
      tools: assistantTools(),
      tool_choice: "auto",
    },
  };

  let response = await postOpenAIJson(apiKey, "https://api.openai.com/v1/realtime/client_secrets", body);
  if (!response.ok) {
    const message = redactSecrets(await response.text());
    if (response.status === 400 && message.toLowerCase().includes("reasoning")) {
      delete body.session.reasoning;
      response = await postOpenAIJson(apiKey, "https://api.openai.com/v1/realtime/client_secrets", body);
    } else {
      throw new Error(`OpenAI Realtime token failed: ${response.status} ${message}`);
    }
  }
  if (!response.ok) throw new Error(`OpenAI Realtime token failed: ${response.status} ${redactSecrets(await response.text())}`);

  return normalizeRealtimeToken(await response.json(), {
    mode: "assistant",
    callEndpoint: "https://api.openai.com/v1/realtime/calls",
    model: DEFAULT_MODEL,
  });
}

async function createTranslationClientSecret(apiKey, options = {}) {
  const targetLanguage = normalizeTargetLanguage(options.targetLanguage, DEFAULT_TARGET_LANGUAGE);
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
    throw new Error(`OpenAI Realtime translation token failed: ${response.status} ${redactSecrets(await response.text())}`);
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
  const sourceLanguage = normalizeTargetLanguage(options.sourceLanguage, "");
  if (sourceLanguage) transcription.language = sourceLanguage;

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
    throw new Error(`OpenAI Realtime transcription token failed: ${response.status} ${redactSecrets(await response.text())}`);
  }
  return normalizeRealtimeToken(await response.json(), {
    mode: "transcribe",
    callEndpoint: "https://api.openai.com/v1/realtime/calls",
    model: DEFAULT_TRANSCRIBE_MODEL,
  });
}

function postOpenAIJson(apiKey, url, body) {
  return requestOpenAIJson({ apiKey, url, body, safetyId: SAFETY_ID, timeoutMs: OPENAI_REQUEST_TIMEOUT_MS, signal: operationContext.getStore()?.signal });
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
  const registryError = validateCuaRegistry(toolName, input?.json_args);
  if (registryError) return Promise.resolve({ ok: false, code: -4, stdout: "", stderr: registryError });
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
  // type_text_chars reaches the same cua-driver machinery as the dedicated
  // type_text_in_front_app tool, so it must get the same per-character delay
  // scaling: the model can call run_cua_driver directly with tool_name
  // "type_text_chars", and without a delay_ms the driver types at its default
  // pace — a text that passes the typeability guard above (e.g. 30k chars,
  // well under the typing budget) would then take minutes and blow the driver
  // timeout with an opaque error the model cannot distinguish from a real
  // hang. The guard already guarantees the text fits at the 1ms/char floor,
  // so injecting the same scaled delay typeTextInFrontApp computes makes the
  // run finish inside the timeout. A model-supplied delay_ms is respected
  // as-is (the model may deliberately want a slower pace); only a missing or
  // non-numeric value gets the scaled default. The budget tracks the
  // configured driver timeout like every other typing guard in this file.
  if (toolName === "type_text_chars" && !(Number.isFinite(normalizedArgs.delay_ms) && normalizedArgs.delay_ms > 0)) {
    normalizedArgs.delay_ms = typeDelayMs(normalizedArgs.text.length, 20, Math.floor(CUA_TIMEOUT_MS * 0.8));
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
  return event.senderFrame?.url === RENDERER_URL && event.senderFrame === event.sender.mainFrame;
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
    credentials = createCredentialStore({ userData: app.getPath("userData"), safeStorage, readLegacy: readKeychainApiKey, envKey: process.env.OPENAI_API_KEY, development: !app.isPackaged, platform: process.platform });
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
    // globalShortcut.register THROWS (it does not return false) when the
    // accelerator string does not parse — e.g. CODEX_VOICE_SHORTCUT with a
    // trailing "+" or a stray token from a copy-paste — and an uncaught throw
    // inside whenReady would abort the startup handler, leaving the app
    // running with no toggle shortcut and no visible error. Catch it, log the
    // offending value, and keep going: the window still opens and every other
    // feature still works.
    try {
      const registered = globalShortcut.register(SHORTCUT, toggleWindow);
      if (!registered) writeLog("globalShortcut register failed", { shortcut: SHORTCUT });
    } catch (error) {
      writeLog("globalShortcut register threw", { shortcut: SHORTCUT, error: String(error) });
    }
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let shutdownStarted = false;
let shutdownFinished = false;
app.on("before-quit", event => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  operations.dispose();
  globalShortcut.unregisterAll();
  // A native Keychain prompt may remain unanswered. Wait for owned process
  // cleanup, but never hold app shutdown indefinitely on a credential write.
  const finishShutdown = () => { if (shutdownFinished) return; shutdownFinished = true; app.quit(); };
  const shutdownDeadline = setTimeout(finishShutdown, 5000);
  Promise.allSettled([processRunner.close(), logger.close(), credentials?.settled()]).then(() => {
    clearTimeout(shutdownDeadline);
    finishShutdown();
  });
});

const scoped = (handler, queued = false) => guard((event, input) => operations.run(event.sender, input, context => operationContext.run(context, () => handler(input)), { queued }));
ipcMain.handle("session:begin", guard((event, input) => operations.begin(event.sender, input?.sessionId)));
ipcMain.handle("session:cancel", guard((event, input) => operations.cancel(event.sender, input?.sessionId)));
ipcMain.handle("app:capabilities", guard(() => capabilitySnapshot({ systemPreferences, codex: executablePaths.codex, cua: executablePaths["cua-driver"] })));
ipcMain.handle("realtime:create-client-secret", scoped(options => createRealtimeClientSecret(options)));
ipcMain.handle("realtime:set-api-key", guard((_event, apiKey) => credentials.setKey(apiKey)));
ipcMain.handle("realtime:key-status", guard(() => credentials.status()));
ipcMain.handle("codex:run", scoped(input => runCodex(input), true));
ipcMain.handle("cua:run", scoped(input => runCuaDriver(input), true));
ipcMain.handle("mac:run", scoped(input => runMacAction(input), true));
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
  tone: DEFAULT_TONE,
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
