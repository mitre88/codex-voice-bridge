// Pure helpers shared between the Electron main process and the renderer.
// No Node/Electron-specific APIs here so these stay unit-testable in a plain Node runtime.

import path from "node:path";

// The sandboxed renderer (Chromium ESM loader) cannot import node: builtins,
// so the helpers it needs live in renderer-utils.js (zero imports). Re-export
// them here so the main process and tests keep a single import surface.
export { hasVirtualAudioDevice, humanizeError, truncateOutput, VIRTUAL_AUDIO_LABEL } from "./renderer-utils.js";

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
// model-controlled app_name inject `do shell script`. Only control characters
// (C0, DEL, C1) are stripped so a model-controlled name cannot smuggle a
// newline or other terminator; printable non-ASCII characters (e.g. accented
// Spanish app names like "Música" or "Números") are kept — inside a quoted
// AppleScript string they are plain data, and stripping them would make
// osascript fail to find the app.
export function escapeAppleScript(value = "") {
  let out = "";
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    // Strip control characters (C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F) so a
    // model-controlled name cannot smuggle a newline or other terminator.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += char === '"' ? '""' : char;
  }
  return out;
}

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/;
// Printable Unicode letters/digits (so accented app names like "Música" or
// "Números" pass, matching escapeAppleScript which preserves them) plus
// ASCII-safe punctuation. Control characters, quotes, backslashes, and shell
// metacharacters stay excluded: escapeAppleScript is the real injection
// defense, this is only the coarse gate.
const APP_NAME_RE = /^[\p{L}\p{N}_ .'+-]{1,100}$/u;

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
  // Only guess an app from context when the call carries neither an explicit
  // identity nor a URL. A url/urls field is an explicit "open in the default
  // browser" intent, so a keyword in the reason text (e.g. "open the chrome
  // docs") must not silently redirect that URL to a guessed app.
  if (toolName === "launch_app" && !args.bundle_id && !args.name && !args.urls && !args.url) {
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

// cua-driver's launch_app must honor the same safety rules as open_app: the
// model can call run_cua_driver directly with tool_name "launch_app", so an
// unvalidated file:// or custom-scheme URL (or an unsafe app identity) would
// otherwise bypass the http/https gate that the open_app path enforces. Returns
// true only when the args carry a safe app identity and only http/https URLs
// (a urls array, or the singular url form some callers use). Nothing unsafe is
// rejected beyond that: missing identities/URLs are cua-driver's problem.
export function isSafeCuaLaunchArgs(args = {}) {
  const identity = args.bundle_id ? { bundle_id: args.bundle_id } : args.name ? { name: args.name } : null;
  if (identity && !isSafeAppIdentity(identity)) return false;
  const hasUrls = args.urls !== undefined || args.url !== undefined;
  if (!hasUrls) return true;
  const urls = args.urls !== undefined ? args.urls : [args.url];
  return Array.isArray(urls) && urls.every((url) => isSafeLaunchUrl(url));
}

// Decide what open_app should launch. An app identity (bundle_id/name) wins;
// with none, a plain http/https URL opens in the default browser. Returns:
//   { kind: "app", identity }        -> launch the app (cua-driver + activate)
//   { kind: "url", url }             -> open the URL in the default browser
//   { kind: "error", code, message } -> refuse; caller returns this verbatim
export function resolveOpenAppTarget(input = {}, aliases = APP_BUNDLE_ALIASES) {
  const identity = resolveAppIdentity(input, aliases);
  if (identity.bundle_id || identity.name) return { kind: "app", identity };
  if (input.url != null && input.url !== "") {
    if (isSafeLaunchUrl(input.url)) return { kind: "url", url: input.url };
    return { kind: "error", code: -9, message: "Rejected unsafe url (only http/https URLs may be opened)." };
  }
  return { kind: "error", code: -1, message: "Missing app_name, bundle_id, or url." };
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
  // Model-generated JSON often wraps values in stray whitespace or a trailing
  // newline (e.g. a template literal); trim before parsing so a perfectly
  // safe URL is not rejected for cosmetic reasons. Trimming cannot weaken the
  // checks below: it only strips ASCII whitespace at both ends, and the
  // scheme/hostname gates still apply to the trimmed value.
  const trimmed = value.trim();
  if (!trimmed) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
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
    // Allow the shell-style "export KEY=v" prefix (the syntax shown in the
    // README and accepted by dotenv/dotenvx) so such lines parse identically
    // to "KEY=v". Only a real prefix followed by whitespace is stripped, so a
    // key literally named "export" or "exported" is never affected.
    const body = /^export[ \t]+/.test(line) ? line.replace(/^export[ \t]+/, "") : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue; // no key or no separator
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    } else if (value.startsWith('"') || value.startsWith("'")) {
      // Strip a quoted value, tolerating an inline comment after the closing
      // quote: `KEY="v" # comment` must parse as "v", not `"v" # comment`
      // (the latter would silently corrupt e.g. a quoted API key). If the
      // quote never closes or stray text follows the closing quote, keep the
      // raw value untouched, matching the previous behavior.
      const quote = value[0];
      const closing = value.indexOf(quote, 1);
      if (closing !== -1) {
        const tail = value.slice(closing + 1).trim();
        if (!tail || tail.startsWith("#")) value = value.slice(1, closing);
      }
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
