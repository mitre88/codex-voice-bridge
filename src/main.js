import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  escapeAppleScript,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTone,
  redactSecrets,
  resolveAppIdentity,
  resolveWorkdir,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_VOICE_TIMEOUT_MS || 120000);
const CUA_TIMEOUT_MS = Number(process.env.CODEX_VOICE_CUA_TIMEOUT_MS || 60000);
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
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      // First run or file missing: nothing to rotate.
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    // Avoid crashing the main process if the disk/log file misbehaves.
    logStream.on("error", () => {});
  }
  return logStream;
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
      resolve(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      options.onOutput?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      options.onOutput?.(chunk.toString());
    });
    child.on("close", (code) => finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (error) => finish({ ok: false, code: -1, stdout: stdout.trim(), stderr: error.message }));
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
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else {
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
  return runProcess("codex", ["exec", "--cd", workdir, "--sandbox", "read-only", "--skip-git-repo-check", prompt], {
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

// Only accept IPC from our own renderer (defense in depth).
function isTrustedSender(event) {
  try {
    const url = new URL(event.senderFrame?.url || "");
    return url.protocol === "file:" && url.pathname.endsWith(path.join("src", "renderer.html"));
  } catch {
    return false;
  }
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

app.whenReady().then(() => {
  createWindow();
  const registered = globalShortcut.register(SHORTCUT, toggleWindow);
  if (!registered) writeLog("globalShortcut register failed", { shortcut: SHORTCUT });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => globalShortcut.unregisterAll());

ipcMain.handle("realtime:create-client-secret", guard((_event, options) => createRealtimeClientSecret(options)));
ipcMain.handle("realtime:set-api-key", guard(async (_event, apiKey) => {
  runtimeApiKey = String(apiKey || "").trim();
  if (!runtimeApiKey.startsWith("sk-")) return { ok: false };
  const saved = await saveKeychainApiKey(runtimeApiKey);
  return { ok: saved.ok, saved: saved.ok, error: saved.stderr };
}));
ipcMain.handle("realtime:key-status", guard(async () => ({
  hasEnvKey: Boolean(process.env.OPENAI_API_KEY),
  hasSavedKey: Boolean(await readKeychainApiKey()),
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
