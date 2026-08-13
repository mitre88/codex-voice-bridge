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
  // undici (Node's fetch) buries the real reason in error.cause — e.g.
  // TypeError "fetch failed" with cause "unable to verify the first
  // certificate" — and syscall codes (ENOTFOUND, ECONNREFUSED, ...) may live
  // only on error.code. Search all three so the specific diagnosis wins over
  // the generic message instead of a raw pass-through.
  const haystack = [lower, error?.cause?.message, error?.cause?.code, error?.code]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  // An exact deviceId (the mic/output selected in the UI) that is unplugged,
  // renamed, or otherwise gone rejects getUserMedia with OverconstrainedError;
  // the raw Chromium message ("Constraints could not be satisfied") leaves the
  // user guessing whether the app or the hardware is at fault.
  if (name === "OverconstrainedError" || haystack.includes("constraints could not be satisfied")) {
    return "The selected microphone or audio device is no longer available. Check that it is still connected, then reconnect or refresh the device list and try again.";
  }
  // TLS/certificate verification failures (corporate proxy/VPN interception,
  // expired certificate, wrong system clock) surface as raw OpenSSL strings or
  // as the cause of an undici "fetch failed"; without this branch users see
  // the generic connectivity message or an opaque error and blame the wrong
  // thing. Placed before the network branch so a wrapped cert error is not
  // shadowed by "fetch failed".
  if (
    haystack.includes("unable to verify the first certificate") ||
    haystack.includes("unable to get local issuer certificate") ||
    haystack.includes("unable to verify leaf signature") ||
    haystack.includes("self-signed certificate") ||
    haystack.includes("certificate has expired") ||
    haystack.includes("certificate is not yet valid") ||
    // OpenSSL error codes (underscore form) as they appear on error.code.
    haystack.includes("unable_to_get_issuer_cert_locally") ||
    haystack.includes("unable_to_verify_leaf_signature") ||
    haystack.includes("self_signed_cert_in_chain") ||
    haystack.includes("cert_has_expired") ||
    haystack.includes("cert_not_yet_valid") ||
    haystack.includes("depth_zero_self_signed") ||
    haystack.includes("err_cert_")
  ) {
    return "Could not verify the OpenAI API server's TLS certificate. This usually means a corporate proxy or VPN is intercepting traffic, the system clock is wrong, or the certificate expired — check those and retry.";
  }
  // Network-level failures (DNS lookup, connection refused/reset, offline)
  // surface as TypeError "fetch failed" in the main process or "NetworkError"
  // in the renderer; a raw pass-through leaves the user guessing whether the
  // problem is the key, the server, or their connection.
  if (
    haystack.includes("fetch failed") ||
    haystack.includes("failed to fetch") ||
    haystack.includes("networkerror") ||
    haystack.includes("enotfound") ||
    haystack.includes("econnrefused") ||
    haystack.includes("econnreset") ||
    haystack.includes("eai_again") ||
    haystack.includes("getaddrinfo") ||
    haystack.includes("socket hang up") ||
    haystack.includes("network is unreachable")
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
  // 5xx responses ("OpenAI Realtime token failed: 500 Internal Server Error",
  // "Error code: 502 - Bad Gateway", "Realtime call failed: 503 Service
  // Unavailable") are OpenAI-side outages; a raw pass-through makes the user
  // suspect their key or network when the fix is simply to retry. Placed after
  // the specific 4xx branches so a client error is never shadowed. The status
  // must be exactly three digits (5\d\d\b) so a stray 4+ digit number in an
  // unrelated message cannot false-positive.
  if (
    /(?:token|call) failed: 5\d\d\b/.test(lower) ||
    /error code: 5\d\d\b/.test(lower) ||
    /(^|[^0-9])5\d\d\s+(internal server error|bad gateway|service unavailable|gateway timeout)/.test(lower)
  ) {
    return "OpenAI API is temporarily unavailable (5xx server error). Wait a few seconds and retry — this is an OpenAI-side outage, not your connection or key.";
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
