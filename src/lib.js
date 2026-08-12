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

export function escapeAppleScript(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

// OpenAI keys start with "sk-" and contain no whitespace or control characters.
// Be permissive about the payload (exotic-but-valid formats are not rejected),
// but refuse anything that is obviously not a key.
export function isPlausibleApiKey(value) {
  return typeof value === "string" && /^sk-\S+$/.test(value);
}

export function redactSecrets(value) {
  return String(value).replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_OPENAI_KEY]");
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

// Keep the model inside the configured workspace: the model may suggest any
// absolute path, and Codex runs read-only, but we still honor least privilege.
export function resolveWorkdir(requested, baseWorkdir) {
  const raw = typeof requested === "string" && requested.trim() ? requested.trim() : baseWorkdir;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(baseWorkdir, raw);
  const normalized = path.normalize(resolved);
  if (normalized !== baseWorkdir && !normalized.startsWith(baseWorkdir + path.sep)) return baseWorkdir;
  return normalized;
}
