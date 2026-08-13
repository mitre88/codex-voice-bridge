// Pure helpers shared between the Electron main process and the renderer.
// No Node/Electron-specific APIs here so these stay unit-testable in a plain Node runtime.

import path from "node:path";

export const APP_BUNDLE_ALIASES = new Map([
  ["safari", "com.apple.Safari"],
  ["chrome", "com.google.Chrome"],
  ["google chrome", "com.google.Chrome"],
  ["finder", "com.apple.finder"],
  ["terminal", "com.apple.Terminal"],
  ["codex", "com.openai.codex"],
  ["xcode", "com.apple.dt.Xcode"],
  ["whatsapp", "net.whatsapp.WhatsApp"],
  ["obsidian", "md.obsidian"],
  ["notes", "com.apple.Notes"],
  ["textedit", "com.apple.TextEdit"],
  ["preview", "com.apple.Preview"],
]);

export function normalizeReasoningEffort(value, fallback = "low") {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value) ? value : fallback;
}

export function normalizeTone(value) {
  return (
    {
      calm: "calm, warm, focused, and concise",
      direct: "direct, practical, and concise",
      energetic: "upbeat, clear, and action-oriented",
    }[value] || "calm, warm, focused, and concise"
  );
}

// AppleScript string literals escape a quote by doubling it. A backslash is
// a literal, not an escape — JS-style \" closes the string and lets a
// model-controlled app_name inject `do shell script`.
export function escapeAppleScript(value = "") {
  return String(value).replace(/[^\u0020-\u007E]/g, "").replace(/"/g, '""');
}

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/;
const APP_NAME_RE = /^[\w .'+-]{1,100}$/;

export function isSafeAppIdentity(identity = {}) {
  if (identity.bundle_id) return BUNDLE_ID_RE.test(String(identity.bundle_id));
  if (identity.name) return APP_NAME_RE.test(String(identity.name));
  return false;
}

export function resolveAppIdentity(input = {}, aliases = APP_BUNDLE_ALIASES) {
  if (input.bundle_id) return { bundle_id: input.bundle_id };
  if (input.app_name) {
    const appName = String(input.app_name).toLowerCase();
    return aliases.has(appName) ? { bundle_id: aliases.get(appName) } : { name: input.app_name };
  }
  return {};
}

export function normalizeCuaArgs(toolName, jsonArgs = {}, fullInput = {}, aliases = APP_BUNDLE_ALIASES) {
  const args = jsonArgs && typeof jsonArgs === "object" ? { ...jsonArgs } : {};
  if (toolName === "launch_app" && !args.bundle_id && !args.name) {
    const text = JSON.stringify({ args, fullInput }).toLowerCase();
    for (const [alias, bundleId] of aliases.entries()) {
      if (text.includes(alias)) {
        args.bundle_id = bundleId;
        break;
      }
    }
  }
  return args;
}

// cua-driver tool names must be plain snake_case identifiers: anything else
// (e.g. "--version" or "call --help") would be parsed as CLI options.
export function isSafeCuaToolName(toolName) {
  return typeof toolName === "string" && /^[a-z][a-z0-9_]*$/i.test(toolName) && toolName.length <= 100;
}

// Only http/https URLs may be handed to launch_app: other schemes (file:,
// ssh:, x-apple-*, javascript:, custom handlers) could open local files,
// trigger shell handlers, or cause unintended side effects from a
// model-controlled URL. Requires a real hostname so "https://" alone fails.
export function isSafeLaunchUrl(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
}

// Validate a model tool-call argument that must be a non-empty string. Returns
// null when valid, or a short human-readable error message. Without this, a
// missing prompt would reach spawn() as the literal string "undefined" and a
// null IPC payload would throw a TypeError while destructuring.
export function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) return `${label} must be a non-empty string.`;
  return null;
}

// Cap a value that will be passed to a child process as a single argv entry.
// macOS limits one argument to MAX_ARG_STRLEN (~256 KiB) and the whole
// argv+env block to ARG_MAX (1 MiB), so an unbounded prompt or args blob
// would otherwise make spawn() fail with E2BIG. Returns null when valid, or a
// short human-readable error message. Non-strings pass through: type checks
// are the caller's job (see requireNonEmptyString).
export function requireMaxLength(value, label, maxChars = 200000) {
  if (typeof value === "string" && value.length > maxChars) {
    return `${label} exceeds the maximum length of ${maxChars} characters.`;
  }
  return null;
}

// OpenAI keys start with "sk-" and contain no whitespace or control characters.
// Be permissive about the payload (exotic-but-valid formats are not rejected),
// but refuse anything that is obviously not a key.
export function isPlausibleApiKey(value) {
  return typeof value === "string" && /^sk-\S+$/.test(value);
}

export function redactSecrets(value) {
  // Include "." in the charset: modern project keys (sk-proj-...) contain
  // dots, and a key split in two by the old regex would leak its tail.
  return String(value).replace(/sk-[A-Za-z0-9_.-]+/g, "[REDACTED_OPENAI_KEY]");
}

// Turn common failure modes into short, actionable messages for the UI.
// Pure so it stays unit-testable; anything unrecognized passes through as-is.
export function humanizeError(error) {
  const name = error?.name;
  const message = error?.message || String(error);
  if (name === "NotAllowedError") {
    return "Microphone or screen access was denied. Allow microphone permission for Codex Voice Bridge in System Settings > Privacy & Security, then retry.";
  }
  if (name === "NotFoundError") {
    return "No audio input device was found. Check that a microphone is connected and enabled.";
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return "The request timed out. Check your network connection and try again.";
  }
  const lower = message.toLowerCase();
  // Network-level failures (DNS lookup, connection refused/reset, offline)
  // surface as TypeError "fetch failed" in the main process or "NetworkError"
  // in the renderer; a raw pass-through leaves the user guessing whether the
  // problem is the key, the server, or their connection.
  if (
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("eai_again") ||
    lower.includes("getaddrinfo") ||
    lower.includes("socket hang up") ||
    lower.includes("network is unreachable")
  ) {
    return "Could not reach the OpenAI API. Check your internet connection and firewall, then retry.";
  }
  if (lower.includes("insufficient_quota") || lower.includes("exceeded your current quota")) {
    return "OpenAI rejected the Realtime call: insufficient_quota. Check billing, project limits, and that the key belongs to the funded organization.";
  }
  if (lower.includes("rate_limit_exceeded") || lower.includes("rate limit")) {
    return "OpenAI rate limit reached (429). Wait a moment and retry, or check your plan's requests-per-minute (RPM) and tokens-per-minute (TPM) limits.";
  }
  if (lower.includes("invalid_api_key") || lower.includes("incorrect api key")) {
    return "OpenAI rejected the API key (401). Check that the key is valid, has Realtime access, and belongs to the funded organization, then save it again.";
  }
  // 403 permission errors ("insufficient_permissions", "You do not have access
  // to the realtime API") usually mean the key/project lacks the Realtime
  // entitlement or the model is not enabled for it; a raw pass-through leaves
  // the user guessing whether the problem is the key, the project, or the model.
  if (lower.includes("insufficient_permissions") || lower.includes("do not have access to the realtime")) {
    return "OpenAI rejected the request with insufficient permissions (403). Check that the API key belongs to a project with the Realtime API enabled and that the requested model is available to it.";
  }
  // 404 model errors ("The model 'x' does not exist or you do not have access
  // to it.") are usually a typo in the .env model names or a model the account
  // cannot use; a raw pass-through leaves the user guessing which one.
  if (lower.includes("model_not_found") || (lower.includes("does not exist") && lower.includes("model"))) {
    return "OpenAI could not find the requested Realtime model (404). Check the model names in .env (OPENAI_REALTIME_MODEL, OPENAI_REALTIME_TRANSLATE_MODEL, OPENAI_REALTIME_TRANSCRIBE_MODEL) for typos, or confirm the model is available to your account.";
  }
  return message;
}

// Append a chunk to a growing process-output buffer, capping the total length
// so a runaway command cannot accumulate unbounded memory in the main process.
// Returns { text, capped } where capped reports whether this chunk pushed the
// buffer over the limit (the excess is dropped, not queued for later).
export function accumulateOutput(buffer, chunk, maxChars = 1024 * 1024) {
  if (buffer.length >= maxChars) return { text: buffer, capped: true };
  const next = buffer + String(chunk);
  if (next.length > maxChars) return { text: next.slice(0, maxChars), capped: true };
  return { text: next, capped: false };
}

export function truncateOutput(output, maxChars = 30000) {
  const out = { ...output };
  for (const key of ["stdout", "stderr"]) {
    if (typeof out[key] === "string" && out[key].length > maxChars) {
      const original = out[key].length;
      out[key] = `${out[key].slice(0, maxChars)}\n...[truncated ${original - maxChars} chars]`;
    }
  }
  return out;
}

// Parse a dotenv-style file (KEY=VALUE lines, # comments, optional quotes)
// into a plain object. Never throws: blank lines, comments, and malformed
// lines are skipped. Inline comments (" # ...") are stripped from unquoted
// values, matching common dotenv behavior.
export function parseEnvFile(contents) {
  const result = {};
  if (typeof contents !== "string") return result;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no key or no separator
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// Merge parsed .env variables into an environment object, never overriding
// variables that are already set (same default behavior as dotenv): an
// explicit environment always wins over a .env file.
export function applyEnvOverrides(parsed, env) {
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

// Env-var style numeric parsing for timeouts: refuse NaN, zero, negative, and
// fractional values so a misconfigured variable can never produce a
// setTimeout of 0 (which would fire immediately) or a negative delay.
export function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Keep the model inside the configured workspace: the model may suggest any
// absolute path, and Codex runs read-only, but we still honor least privilege.
export function resolveWorkdir(requested, baseWorkdir) {
  const raw = typeof requested === "string" && requested.trim() ? requested.trim() : baseWorkdir;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(baseWorkdir, raw);
  const normalized = path.normalize(resolved);
  if (normalized !== baseWorkdir && !normalized.startsWith(baseWorkdir + path.sep)) return baseWorkdir;
  return normalized;
}

export const VIRTUAL_AUDIO_LABEL = /blackhole|loopback|virtual/i;

export function hasVirtualAudioDevice(devices = []) {
  return devices.some((device) => VIRTUAL_AUDIO_LABEL.test(device?.label || ""));
}

export const LOG_MAX_BYTES = 2 * 1024 * 1024;

export function rotateLogIfNeeded(fsLike, logFile, maxBytes = LOG_MAX_BYTES) {
  try {
    if (fsLike.statSync(logFile).size > maxBytes) {
      fsLike.renameSync(logFile, `${logFile}.1`);
      return true;
    }
  } catch {
    // First run or file missing: nothing to rotate.
  }
  return false;
}
