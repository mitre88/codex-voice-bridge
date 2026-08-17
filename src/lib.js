// Pure helpers shared between the Electron main process and the renderer.
// No Node/Electron-specific APIs here so these stay unit-testable in a plain Node runtime.

import fs from "node:fs";
import path from "node:path";

// The sandboxed renderer (Chromium ESM loader) cannot import node: builtins,
// so the helpers it needs live in renderer-utils.js (zero imports). Re-export
// them here so the main process and tests keep a single import surface.
export { hasVirtualAudioDevice, humanizeError, isSdpAnswer, truncateOutput, VIRTUAL_AUDIO_LABEL } from "./renderer-utils.js";

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
  // Common apps a voice user is likely to name (Mail, Calendar, Messages,
  // ...) whose display name differs from the process name or whose lookup by
  // name alone is unreliable. Resolving them to the exact bundle id makes
  // launch_app/open_app succeed where a name-based lookup could miss.
  ["arc", "company.thebrowser.Browser"],
  ["brave", "com.brave.Browser"],
  ["calculator", "com.apple.calculator"],
  ["calendar", "com.apple.iCal"],
  ["discord", "com.hnc.discord"],
  ["excel", "com.microsoft.Excel"],
  ["facetime", "com.apple.facetime"],
  ["figma", "com.figma.Desktop"],
  ["firefox", "org.mozilla.firefox"],
  ["iterm", "com.googlecode.iterm2"],
  ["iterm2", "com.googlecode.iterm2"],
  ["keynote", "com.apple.Keynote"],
  ["mail", "com.apple.mail"],
  ["messages", "com.apple.MobileSMS"],
  ["music", "com.apple.Music"],
  // More apps a voice user is likely to name whose display name differs from
  // the bundle id (App Store, Activity Monitor, Podcasts) or that are common
  // enough to deserve a stable alias (Maps, VLC, Ghostty, 1Password, Todoist,
  // Kindle). "podcast" and "podcasts" both map to the same app; a word like
  // "podcasting" still cannot false-positive because the boundary regex
  // requires a non-word character after the alias.
  ["activity monitor", "com.apple.ActivityMonitor"],
  ["app store", "com.apple.AppStore"],
  ["ghostty", "com.mitchellh.ghostty"],
  ["kindle", "com.amazon.Kindle"],
  ["maps", "com.apple.Maps"],
  ["podcast", "com.apple.podcasts"],
  ["podcasts", "com.apple.podcasts"],
  ["todoist", "com.todoist.mac.Todoist"],
  ["vlc", "org.videolan.vlc"],
  ["1password", "com.1password.1password"],
  ["notion", "notion.id"],
  ["numbers", "com.apple.iWork.Numbers"],
  ["outlook", "com.microsoft.Outlook"],
  ["pages", "com.apple.Pages"],
  ["photos", "com.apple.Photos"],
  ["powerpoint", "com.microsoft.Powerpoint"],
  ["reminders", "com.apple.reminders"],
  ["slack", "com.tinyspeck.slackmacgap"],
  ["signal", "org.whispersystems.signal"],
  ["spotify", "com.spotify.client"],
  ["steam", "com.valvesoftware.steam"],
  ["system preferences", "com.apple.systempreferences"],
  ["system settings", "com.apple.systempreferences"],
  ["teams", "com.microsoft.teams"],
  ["telegram", "ru.keepcoder.Telegram"],
  ["visual studio code", "com.microsoft.VSCode"],
  ["vs code", "com.microsoft.VSCode"],
  ["vscode", "com.microsoft.VSCode"],
  ["word", "com.microsoft.Word"],
  ["zoom", "us.zoom.xos"],
  // Developer tools a voice user is likely to name whose bundle ids are opaque
  // (Warp, Raycast, Docker, Postman, Zed, Cursor, Sublime Text, Alfred) and
  // Apple system apps whose display names differ from their bundle ids
  // (Books, Voice Memos, Clock, Weather, Shortcuts). "home", "bear", and
  // "things" are deliberately NOT aliased: those words appear too often in
  // model reason text ("home directory", "bear with me", "the things we need")
  // and would false-positive the word-boundary guess into the wrong app.
  ["alfred", "com.runningwithcrayons.Alfred"],
  ["books", "com.apple.iBooks"],
  ["clock", "com.apple.clock"],
  ["cursor", "com.todesktop.230313mzl4w4u92"],
  ["docker", "com.docker.docker"],
  ["linear", "com.linear.linear"],
  ["postman", "com.postmanlabs.mac"],
  ["raycast", "com.raycast.macos"],
  ["shortcuts", "com.apple.shortcuts"],
  ["sublime text", "com.sublimetext.4"],
  ["voice memos", "com.apple.VoiceMemos"],
  ["warp", "dev.warp.Warp-Stable"],
  ["weather", "com.apple.weather"],
  ["zed", "dev.zed.Zed"],
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
// model-controlled app_name inject `do shell script`. Control characters
// (C0, DEL, C1) and the Unicode line terminators U+2028/U+2029 are stripped
// so a model-controlled name cannot smuggle a newline or other terminator:
// AppleScript treats U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
// SEPARATOR) as line breaks in script text exactly like \n and \r, so a name
// containing one would terminate the string literal and break out of the
// `tell application` statement. Printable non-ASCII characters (e.g. accented
// Spanish app names like "Música" or "Números") are kept — inside a quoted
// AppleScript string they are plain data, and stripping them would make
// osascript fail to find the app.
export function escapeAppleScript(value = "") {
  let out = "";
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    // Strip control characters (C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F) and the
    // Unicode line/paragraph separators (U+2028/U+2029) so a model-controlled
    // name cannot smuggle a newline or other AppleScript line terminator.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) continue;
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
  if (input.bundle_id) {
    // Same cosmetic-noise trim as app_name below: model-generated JSON often
    // wraps values in stray whitespace or a trailing newline (e.g. a template
    // literal), and an untrimmed bundle_id would fail BUNDLE_ID_RE and come
    // back as "Rejected unsafe app_name or bundle_id" for a perfectly safe,
    // correctly-intended identity. Trimming cannot weaken the gates: the
    // identity is still validated by isSafeAppIdentity afterwards, and a
    // whitespace-only bundle_id trims to "" and fails the regex like any
    // empty value.
    return { bundle_id: String(input.bundle_id).trim() };
  }
  if (input.app_name) {
    // Model-generated JSON often wraps values in stray whitespace or a
    // trailing newline (e.g. a template literal) — the same cosmetic noise
    // isSafeLaunchUrl already trims from URLs. Trim before the alias lookup
    // so " Safari " resolves to the Safari bundle id and a raw-name launch
    // never tries to open an app literally named " Safari ". Trimming cannot
    // weaken the safety gates: the identity is still validated by
    // isSafeAppIdentity afterwards, and a whitespace-only name trims to ""
    // and fails the name regex like any other empty name.
    const appName = String(input.app_name).trim();
    const key = appName.toLowerCase();
    return aliases.has(key) ? { bundle_id: aliases.get(key) } : { name: appName };
  }
  return {};
}

// Escape a string for literal use inside a RegExp. The alias matching below
// interpolates aliases into a pattern, and an alias containing a regex
// metacharacter (".", "+", "(", "[", ...) would otherwise be interpreted —
// e.g. "c++" would match "cc", and an unbalanced "(" would throw a
// SyntaxError on every launch_app call. Escaping keeps the match literal.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compiled word-boundary patterns for an aliases map, cached per map so the
// default APP_BUNDLE_ALIASES (and any custom map a caller passes) compiles
// once instead of rebuilding a regex for every alias on every launch_app call
// without an explicit identity. A WeakMap keyed on the map object keeps the
// cache bounded (a discarded map is collectable).
const aliasPatternCache = new WeakMap();
function getAliasPatterns(aliases) {
  let patterns = aliasPatternCache.get(aliases);
  if (!patterns) {
    patterns = new Map(
      [...aliases].map(([alias, bundleId]) => [
        alias,
        { bundleId, re: new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}($|[^a-z0-9])`) },
      ]),
    );
    aliasPatternCache.set(aliases, patterns);
  }
  return patterns;
}

export function normalizeCuaArgs(toolName, jsonArgs = {}, fullInput = {}, aliases = APP_BUNDLE_ALIASES) {
  const args = jsonArgs && typeof jsonArgs === "object" ? { ...jsonArgs } : {};
  if (toolName !== "launch_app") return args;
  // Same cosmetic-noise trim as resolveAppIdentity applies to app_name: a
  // model-generated bundle_id/name wrapped in stray whitespace or a trailing
  // newline (e.g. a template literal) would otherwise fail the identity gate
  // below and come back as "Rejected unsafe launch_app arguments" for a
  // perfectly safe identity. Trimming cannot weaken the gates: the identity
  // is still validated by isSafeCuaLaunchArgs/isSafeAppIdentity afterwards,
  // and a whitespace-only value trims to "" and fails the regexes like any
  // empty value.
  if (typeof args.bundle_id === "string") args.bundle_id = args.bundle_id.trim();
  if (typeof args.name === "string") args.name = args.name.trim();
  // cua-driver's launch_app speaks name/bundle_id, but callers may pass the
  // app_name key the open_app tool uses. Resolve it through the same alias
  // map so launch_app({app_name}) validates and launches the exact identity
  // the open_app path would — otherwise an app_name (aliased or not) would
  // skip both the alias resolution and the isSafeAppIdentity gate below.
  if (args.app_name && !args.bundle_id && !args.name) {
    const identity = resolveAppIdentity({ app_name: args.app_name }, aliases);
    if (identity.bundle_id) args.bundle_id = identity.bundle_id;
    else if (identity.name) args.name = identity.name;
    delete args.app_name;
  }
  // Only guess an app from context when the call carries neither an explicit
  // identity nor a URL. A url/urls field is an explicit "open in the default
  // browser" intent, so a keyword in the reason text (e.g. "open the chrome
  // docs") must not silently redirect that URL to a guessed app.
  if (!args.bundle_id && !args.name && !args.urls && !args.url) {
    // The alias guess is a heuristic over short context: the model's reason
    // for the call and the (small) args blob. A model-controlled json_args
    // can be arbitrarily large (e.g. a prompt-injected launch_app carrying a
    // multi-MB blob), and scanning the full serialized payload — a regex test
    // per alias over a multi-MB string — would block the main process for
    // seconds before the json_args length guard downstream even runs. Scan
    // only the head of the payload: the reason is stringified FIRST so a long
    // args blob cannot truncate the very field the guess is meant to read.
    // A standalone alias mention lives in the reason or the first chars of
    // args, so truncating cannot weaken the guess for legitimate calls.
    const text = JSON.stringify({ reason: fullInput?.reason, args }).slice(0, 4096).toLowerCase();
    for (const { bundleId, re } of getAliasPatterns(aliases).values()) {
      // Match the alias on word boundaries, not as a raw substring: "keynotes"
      // contains "notes" and "previewing" contains "preview", so a substring
      // check would launch the wrong app for "open the keynotes deck" or
      // "previewing the diff". Only a standalone alias mention is a hint.
      if (re.test(text)) {
        args.bundle_id = bundleId;
        break;
      }
    }
  }
  // URLs get the same cosmetic-noise trim the identity fields get above:
  // isSafeLaunchUrl validates the trimmed value, so a whitespace-padded URL
  // would pass the gate but reach cua-driver untrimmed and fail to open.
  // Trim AFTER the alias-guess guard: a whitespace-only url is still truthy
  // there (an explicit "open this URL" intent must never be re-guessed as an
  // app), and trims to "" only for the downstream safety gate to reject.
  // Trimming cannot weaken the gates: isSafeCuaLaunchArgs re-validates every
  // URL afterwards, and a whitespace-only entry trims to "" and fails like
  // any other empty value.
  if (typeof args.url === "string") args.url = args.url.trim();
  if (Array.isArray(args.urls)) {
    args.urls = args.urls.map((url) => (typeof url === "string" ? url.trim() : url));
  }
  return args;
}

// cua-driver's launch_app must honor the same safety rules as open_app: the
// model can call run_cua_driver directly with tool_name "launch_app", so an
// unvalidated file:// or custom-scheme URL (or an unsafe app identity) would
// otherwise bypass the http/https gate that the open_app path enforces. Returns
// true only when the args carry a safe app identity and only http/https URLs
// (a urls array, or the singular url form some callers use). When BOTH forms
// are present, every URL the model supplied is validated — a safe urls array
// must not mask an unsafe singular url (and vice versa), and an empty urls
// array must not make .every() vacuously true while url carries a payload.
// Nothing unsafe is rejected beyond that: missing identities/URLs are
// cua-driver's problem.
export function isSafeCuaLaunchArgs(args = {}) {
  // A raw app_name field is validated as a name (the same semantic open_app
  // gives it): normalizeCuaArgs resolves it first, but any caller that skips
  // normalization must not get a free pass past the identity gate.
  const identity = args.bundle_id
    ? { bundle_id: args.bundle_id }
    : args.name
      ? { name: args.name }
      : args.app_name
        ? { name: args.app_name }
        : null;
  if (identity && !isSafeAppIdentity(identity)) return false;
  const hasUrls = args.urls !== undefined || args.url !== undefined;
  if (!hasUrls) return true;
  const urls = [];
  if (Array.isArray(args.urls)) urls.push(...args.urls);
  else if (args.urls !== undefined) return false; // non-array urls is not a shape cua-driver accepts
  if (args.url !== undefined) urls.push(args.url);
  // No URLs at all (e.g. an empty urls array) is an identity-only launch,
  // same as omitting them: nothing to validate.
  if (urls.length === 0) return true;
  return urls.every((url) => isSafeLaunchUrl(url));
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
    // The URL becomes a single argv entry to the `open` command (no shell), so
    // it must respect the same per-argument cap the prompt/text/json_args
    // guards enforce: a model-controlled megabyte URL would otherwise make
    // spawn() fail with E2BIG — or worse, on a lenient kernel, pass an
    // unbounded string to the OS. 8192 bytes is far beyond any real URL.
    const lengthError = requireMaxLength(input.url, "url", 8192);
    if (lengthError) return { kind: "error", code: -9, message: lengthError };
    if (isSafeLaunchUrl(input.url)) return { kind: "url", url: String(input.url).trim() };
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
// would otherwise make spawn() fail with E2BIG. The limit is measured in
// UTF-8 BYTES, not characters: a voice-transcribed Spanish prompt (or any
// other multibyte text) is up to 4 bytes per character, so a character-based
// count could let a value through that still blows the OS limit and fails
// with E2BIG — the exact failure this guard exists to prevent. Returns null
// when valid, or a short human-readable error message. Non-strings pass
// through: type checks are the caller's job (see requireNonEmptyString).
export function requireMaxLength(value, label, maxBytes = 200000) {
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maxBytes) {
    return `${label} exceeds the maximum length of ${maxBytes} bytes.`;
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
  // The \b requires a token boundary before "sk": a bare /sk-.../ match also
  // hits the "sk-" inside ordinary words ("risk-2024", "task-proj", "ask-1")
  // and would corrupt log text with false redactions. Real keys never start
  // mid-word (they follow whitespace, a quote, or a colon), so none are missed.
  return String(value).replace(/\bsk-[A-Za-z0-9_.-]+/g, "[REDACTED_OPENAI_KEY]");
}

// Turn a failed child-process spawn into a short, actionable message. A
// missing binary surfaces as "spawn <command> ENOENT" (e.g. the user never
// installed codex or cua-driver, or the binary is not on the app's PATH), an
// installed-but-not-executable binary as EACCES, and an over-limit command
// line as E2BIG; a raw pass-through leaves the user (and the model relaying
// it) guessing whether the app, the PATH, the environment, or the install is
// at fault. Anything else passes through as-is.
export function humanizeSpawnError(command, error) {
  const code = error?.code;
  const message = error?.message || String(error);
  if (code === "ENOENT") {
    return `"${command}" was not found on PATH. Install it and make sure it is available to this app, then retry.`;
  }
  if (code === "EACCES") {
    return `"${command}" is not executable. Check its permissions and retry.`;
  }
  if (code === "E2BIG") {
    // The prompt/args length guards cap individual argv entries, but macOS
    // limits the whole argv+env block (ARG_MAX, ~1 MiB), so a large
    // environment can still overflow it with a much smaller request. The raw
    // "spawn codex E2BIG" leaves the user blaming the request size alone.
    return `"${command}" could not start: the command line or environment is too large for macOS (E2BIG). Trim oversized environment variables or reduce the request size, then retry.`;
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

// Pick a per-character delay so a whole text fits inside the CUA timeout:
// 20ms/char is comfortable for short inputs, but a long text (e.g. 10k chars
// at 20ms = 200s) would blow past the 60s driver timeout and fail. Scale the
// delay down for long texts, never below 1ms, keeping ~80% of the budget as
// headroom for driver startup and the app lookup.
export function typeDelayMs(textLength, maxDelayMs = 20, budgetMs = 48000) {
  if (!Number.isFinite(textLength) || textLength <= 0) return maxDelayMs;
  return Math.max(1, Math.min(maxDelayMs, Math.floor(budgetMs / textLength)));
}

// Reject a text that could never be typed inside the driver timeout: typeDelayMs
// floors the per-character delay at 1ms, so a text longer than the typing budget
// (budgetMs) takes more than budgetMs milliseconds no matter what, and one long
// enough (e.g. 100k chars at 1ms/char = 100s) is guaranteed to blow past the 60s
// CUA timeout. The byte cap alone does not catch this — 100k ASCII chars fit well
// under 200KB — so callers check this up front and return a clean error instead of
// launching a run that is doomed to time out. Returns null when the text can fit,
// or a short human-readable error message.
export function requireTypeableLength(textLength, budgetMs = 48000) {
  if (Number.isFinite(textLength) && textLength > budgetMs) {
    return `text is too long to type within the driver timeout (max ${budgetMs} characters). Split it into smaller chunks and retry.`;
  }
  return null;
}

// Find the first top-level JSON object in a string. cua-driver may emit log
// lines before its JSON payload, and a strict JSON.parse of the whole stdout
// would then fail and make callers report "no result" for a perfectly valid
// response. Scans for the first '{', brace-matches (skipping braces inside
// strings), and parses just that object. Returns null when no object parses
// or the input is not a string.
export function extractFirstJsonObject(text) {
  if (typeof text !== "string") return null;
  // The inner scan restarts from every '{', so a pathological input turns
  // this quadratic: each unclosed candidate re-scans nearly the whole buffer.
  // That is reachable in practice — the model can type a barrage of '{' into
  // an app, the editor's window title carries them, and cua-driver's
  // list_apps stdout (capped at 1MB) surfaces them here; O(n²) over 1MB would
  // freeze the main process for minutes. Bound the total scanning work to ~2×
  // the input length: legitimate output still costs ~N total (each candidate
  // scans at most up to its own closing brace, and braces inside strings are
  // skipped), while an adversarial run of unclosed candidates exhausts the
  // budget after a couple of attempts and bails out in linear time. A null
  // here degrades exactly like the driver emitting no JSON at all — callers
  // already handle that.
  let scanBudget = text.length * 2;
  for (let i = 0; i < text.length && scanBudget > 0; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length && scanBudget > 0; j++, scanBudget--) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1));
          } catch {
            break; // malformed object starting here; try the next '{'
          }
        }
      }
    }
  }
  return null;
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
  // The lexical prefix check alone trusts path strings, and path.normalize
  // does not follow symlinks: a symlink inside the workspace pointing outside
  // (e.g. work/evil -> /etc) would pass the prefix check and move the Codex
  // run out of the configured workspace. Resolve real paths so the
  // containment check sees where the directory actually is. realpathSync
  // throws when a path does not exist yet; fall back to the lexical path in
  // that case — a not-yet-created directory cannot hide a symlink escape, and
  // the run would fail with "no such directory" anyway. The workspace root is
  // realpath'd too so the prefix comparison is consistent even when the root
  // itself is reached through a symlink (e.g. macOS /tmp -> /private/tmp).
  let base = baseWorkdir;
  try {
    base = fs.realpathSync(baseWorkdir);
  } catch {
    // Workspace root does not exist yet; compare lexically.
  }
  let target = normalized;
  try {
    target = fs.realpathSync(normalized);
  } catch {
    // Target does not exist yet; resolve it against the real base so a
    // symlinked base still admits its legitimate children.
    target = path.resolve(base, path.relative(baseWorkdir, normalized));
  }
  if (target !== base && !target.startsWith(base + path.sep)) return baseWorkdir;
  return target;
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
