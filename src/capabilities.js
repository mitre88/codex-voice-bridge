import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const TRUSTED_BIN_DIRS = [
  "/opt/homebrew/opt/node@24/bin",
  "/usr/local/opt/node@24/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".cargo", "bin"),
];

// Finder does not inherit interactive shell PATH. Never evaluate a login shell
// (or shell startup files) just to discover executables.
export function resolveExecutable(
  name,
  explicit,
  { io = fs, directories = TRUSTED_BIN_DIRS, uid = process.getuid?.() } = {},
) {
  const configured = typeof explicit === "string" ? explicit.trim() : "";
  const candidates = configured ? [configured] : directories.map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    if (
      !path.isAbsolute(candidate) ||
      [...candidate].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      continue;
    try {
      const resolved = io.realpathSync(candidate);
      const stat = io.statSync(resolved);
      if (!stat.isFile() || !(stat.mode & 0o111) || stat.mode & 0o022 || ![0, uid].includes(stat.uid)) continue;
      io.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      /* Missing optional capability. */
    }
  }
  return null;
}

export function capabilitySnapshot({
  systemPreferences,
  codex,
  cua,
  platform = process.platform,
  arch = process.arch,
}) {
  let microphone = "unknown";
  try {
    microphone = systemPreferences.getMediaAccessStatus("microphone");
  } catch {
    /* Permission not available on this host. */
  }
  let accessibility = "unknown";
  try {
    accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-granted";
  } catch {
    /* Never prompt during diagnosis. */
  }
  return {
    platform,
    arch,
    microphone,
    accessibility,
    codex: { available: Boolean(codex), path: codex },
    cua: { available: Boolean(cua), path: cua },
    standaloneVoice: platform === "darwin",
    virtualAudio: "renderer-device-check",
    screenAudio:
      "Use a virtual input on macOS 13/14; native meeting audio depends on OS permissions and runtime support.",
  };
}
