import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accumulateOutput,
  applyEnvOverrides,
  captionDisplayText,
  createDebugLogBuffer,
  createOutputAccumulator,
  escapeAppleScript,
  extractFirstJsonObject,
  typeDelayMs,
  hasVirtualAudioDevice,
  humanizeError,
  sameMediaDeviceList,
  humanizeSpawnError,
  isApiKeyRejection,
  isPlausibleApiKey,
  isSafeAppIdentity,
  isSafeCuaLaunchArgs,
  isSafeCuaToolName,
  isSafeLaunchUrl,
  isSdpAnswer,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTargetLanguage,
  normalizeTone,
  normalizeToneKey,
  parseEnvFile,
  redactSecrets,
  requireMaxLength,
  requireNoNullBytes,
  requireNonEmptyString,
  requireTypeableLength,
  resolveAppIdentity,
  resolveOpenAppTarget,
  resolveWorkdir,
  rotateLogIfNeeded,
  toPositiveInt,
  truncateOutput,
  validateCuaDriverRequiredArgs,
} from "../src/lib.js";

test("normalizeReasoningEffort accepts known values and falls back", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeReasoningEffort("bogus"), "low");
  assert.equal(normalizeReasoningEffort("bogus", "medium"), "medium");
});

test("normalizeReasoningEffort normalizes case and whitespace (.env style)", () => {
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort(" High "), "high");
  assert.equal(normalizeReasoningEffort("XHigh"), "xhigh");
  assert.equal(normalizeReasoningEffort("MEDIUM"), "medium");
  // A non-string value must keep falling back instead of throwing on .trim().
  assert.equal(normalizeReasoningEffort(42), "low");
});

test("normalizeTone maps known tones and defaults to calm", () => {
  assert.match(normalizeTone("direct"), /direct/);
  assert.match(normalizeTone("energetic"), /upbeat/);
  assert.match(normalizeTone("unknown"), /calm/);
});

test("normalizeTone normalizes case and whitespace like normalizeReasoningEffort", () => {
  assert.match(normalizeTone("CALM"), /calm/);
  assert.match(normalizeTone(" Direct "), /direct/);
  assert.match(normalizeTone("ENERGETIC\n"), /upbeat/);
  // A non-string value must keep falling back instead of throwing on .trim().
  assert.match(normalizeTone(42), /calm/);
});

test("normalizeToneKey returns canonical keys and defaults to calm", () => {
  assert.equal(normalizeToneKey("calm"), "calm");
  assert.equal(normalizeToneKey("direct"), "direct");
  assert.equal(normalizeToneKey("energetic"), "energetic");
  assert.equal(normalizeToneKey("unknown"), "calm");
  assert.equal(normalizeToneKey(""), "calm");
  assert.equal(normalizeToneKey(42), "calm");
  // A caller-supplied fallback is honored for invalid values.
  assert.equal(normalizeToneKey("bogus", "direct"), "direct");
});

test("normalizeToneKey normalizes case and whitespace like normalizeTone", () => {
  assert.equal(normalizeToneKey("CALM"), "calm");
  assert.equal(normalizeToneKey(" Direct "), "direct");
  assert.equal(normalizeToneKey("ENERGETIC\n"), "energetic");
});

test("normalizeTone stays consistent with normalizeToneKey", () => {
  // normalizeToneKey accepts keys, so a key normalized then rendered must
  // produce that tone's prompt (the reverse direction is not a round trip:
  // normalizeTone returns a prompt phrase, not a key).
  assert.match(normalizeTone(normalizeToneKey("direct")), /direct/);
  assert.match(normalizeTone(normalizeToneKey("ENERGETIC")), /upbeat/);
  // normalizeToneKey is idempotent: a normalized key re-normalizes to itself.
  assert.equal(normalizeToneKey(normalizeToneKey("calm")), "calm");
  assert.equal(normalizeToneKey(normalizeToneKey("unknown")), "calm");
});

test("normalizeTargetLanguage returns canonical codes and defaults to es", () => {
  assert.equal(normalizeTargetLanguage("es"), "es");
  assert.equal(normalizeTargetLanguage("en"), "en");
  assert.equal(normalizeTargetLanguage("fr"), "fr");
  assert.equal(normalizeTargetLanguage("de"), "de");
  assert.equal(normalizeTargetLanguage("pt"), "pt");
  assert.equal(normalizeTargetLanguage("ja"), "ja");
  assert.equal(normalizeTargetLanguage("ko"), "ko");
  assert.equal(normalizeTargetLanguage("zh"), "zh");
  // Any value outside the renderer's language list falls back, not 400s.
  assert.equal(normalizeTargetLanguage("spanish"), "es");
  assert.equal(normalizeTargetLanguage(""), "es");
  assert.equal(normalizeTargetLanguage(42), "es");
  // A caller-supplied fallback is honored for invalid values.
  assert.equal(normalizeTargetLanguage("bogus", "en"), "en");
});

test("normalizeTargetLanguage normalizes case and whitespace (.env style)", () => {
  assert.equal(normalizeTargetLanguage("ES"), "es");
  assert.equal(normalizeTargetLanguage(" Es "), "es");
  assert.equal(normalizeTargetLanguage("FRENCH\n"), "es");
  assert.equal(normalizeTargetLanguage("EN"), "en");
  // A non-string value must keep falling back instead of throwing on .trim().
  assert.equal(normalizeTargetLanguage(null), "es");
  // normalizeTargetLanguage is idempotent: a normalized code re-normalizes.
  assert.equal(normalizeTargetLanguage(normalizeTargetLanguage("KO")), "ko");
});

test("escapeAppleScript doubles quotes the AppleScript way", () => {
  assert.equal(escapeAppleScript('a"b\\c'), 'a""b\\c');
  assert.equal(escapeAppleScript("plain"), "plain");
  assert.equal(escapeAppleScript('x"\ndo shell script "id"'), 'x""do shell script ""id""');
});

test("escapeAppleScript keeps printable non-ASCII (accented app names)", () => {
  assert.equal(escapeAppleScript("Música"), "Música");
  assert.equal(escapeAppleScript("Números"), "Números");
  assert.equal(escapeAppleScript("Páginas"), "Páginas");
});

test("escapeAppleScript still strips control characters", () => {
  assert.equal(escapeAppleScript("a\u0007b\nc"), "abc");
  assert.equal(escapeAppleScript("a\u0085b"), "ab"); // C1 control
  assert.equal(escapeAppleScript("a\u007Fb"), "ab"); // DEL
});

test("escapeAppleScript strips Unicode line/paragraph separators", () => {
  // AppleScript treats U+2028/U+2029 as line breaks in script text, so they
  // must not survive into the string literal any more than \n does.
  assert.equal(escapeAppleScript("a\u2028b"), "ab");
  assert.equal(escapeAppleScript("a\u2029b"), "ab");
  assert.equal(escapeAppleScript('x"\u2028do shell script "id"'), 'x""do shell script ""id""');
  assert.equal(escapeAppleScript('x"\u2029do shell script "id"'), 'x""do shell script ""id""');
  // Printable non-ASCII must still pass through untouched.
  assert.equal(escapeAppleScript("Música"), "Música");
});

test("isSafeAppIdentity allowlists bundle ids and simple app names", () => {
  assert.equal(isSafeAppIdentity({ bundle_id: "com.apple.Safari" }), true);
  assert.equal(isSafeAppIdentity({ name: "Visual Studio Code" }), true);
  assert.equal(isSafeAppIdentity({ name: 'x"\ndo shell script' }), false);
  assert.equal(isSafeAppIdentity({ bundle_id: "a; do shell script" }), false);
  assert.equal(isSafeAppIdentity({}), false);
});

test("isSafeAppIdentity accepts accented app names but not controls", () => {
  assert.equal(isSafeAppIdentity({ name: "Música" }), true);
  assert.equal(isSafeAppIdentity({ name: "Números 2024" }), true);
  assert.equal(isSafeAppIdentity({ name: "Música\u0007" }), false); // control char still rejected
  assert.equal(isSafeAppIdentity({ name: "Música\u2028" }), false); // line separator still rejected
  assert.equal(isSafeAppIdentity({ name: "Música\\" }), false); // backslash still rejected
});

test("isSafeAppIdentity rejects non-string identities instead of String()-coercing them", () => {
  // The regexes used to String() their input, so a model-supplied numeric
  // value (e.g. launch_app with "bundle_id": 42) passed the gate as "42" and
  // reached cua-driver in a shape the driver rejects with an opaque error the
  // model cannot self-correct from. Non-strings are now rejected up front.
  assert.equal(isSafeAppIdentity({ bundle_id: 42 }), false);
  assert.equal(isSafeAppIdentity({ bundle_id: true }), false);
  assert.equal(isSafeAppIdentity({ bundle_id: ["com.apple.Safari"] }), false);
  assert.equal(isSafeAppIdentity({ name: 42 }), false);
  assert.equal(isSafeAppIdentity({ name: null }), false);
  // String identities still pass — the type gate must not reject real values.
  assert.equal(isSafeAppIdentity({ bundle_id: "com.apple.Safari" }), true);
  assert.equal(isSafeAppIdentity({ name: "MyApp" }), true);
});

test("resolveAppIdentity does not String()-coerce non-string identities", () => {
  // A numeric bundle_id/app_name used to be coerced to "42" and launched as
  // an app literally named "42" (or handed to cua-driver as a number) — an
  // opaque driver failure the model cannot self-correct from. Non-strings now
  // resolve to {} so the caller's clean "Missing app_name, bundle_id, or
  // url." (open_app) or "Rejected unsafe launch_app arguments" (launch_app)
  // wins, and string identities still resolve exactly as before.
  assert.deepEqual(resolveAppIdentity({ bundle_id: 42 }), {});
  assert.deepEqual(resolveAppIdentity({ bundle_id: true }), {});
  assert.deepEqual(resolveAppIdentity({ app_name: 42 }), {});
  assert.deepEqual(resolveAppIdentity({ app_name: ["Safari"] }), {});
  assert.deepEqual(resolveAppIdentity({ app_name: "Safari" }), { bundle_id: "com.apple.Safari" });
  assert.deepEqual(resolveAppIdentity({ bundle_id: " com.apple.Safari " }), { bundle_id: "com.apple.Safari" });
});

test("resolveAppIdentity maps aliases and falls back to name", () => {
  assert.deepEqual(resolveAppIdentity({ app_name: "Safari" }), { bundle_id: "com.apple.Safari" });
  assert.deepEqual(resolveAppIdentity({ app_name: "google chrome" }), { bundle_id: "com.google.Chrome" });
  assert.deepEqual(resolveAppIdentity({ app_name: "MyApp" }), { name: "MyApp" });
  assert.deepEqual(resolveAppIdentity({ bundle_id: "x.y.z" }), { bundle_id: "x.y.z" });
  assert.deepEqual(resolveAppIdentity({}), {});
});

test("resolveAppIdentity trims stray whitespace around app_name like isSafeLaunchUrl does for URLs", () => {
  // Model-generated JSON often wraps values in stray whitespace/newlines;
  // a trimmed alias must still resolve, and a raw name must launch trimmed.
  assert.deepEqual(resolveAppIdentity({ app_name: " Safari " }), { bundle_id: "com.apple.Safari" });
  assert.deepEqual(resolveAppIdentity({ app_name: "\ngoogle chrome\t" }), { bundle_id: "com.google.Chrome" });
  assert.deepEqual(resolveAppIdentity({ app_name: "  MyApp  " }), { name: "MyApp" });
  // A whitespace-only name trims to "" and falls through like an empty name.
  assert.deepEqual(resolveAppIdentity({ app_name: "   " }), { name: "" });
});

test("resolveAppIdentity trims stray whitespace around bundle_id like it does for app_name", () => {
  // The same cosmetic noise that wraps app_name in whitespace/newlines also
  // wraps bundle_id; an untrimmed bundle_id would fail BUNDLE_ID_RE and come
  // back as "Rejected unsafe app_name or bundle_id" for a safe identity.
  assert.deepEqual(resolveAppIdentity({ bundle_id: " com.apple.Safari " }), { bundle_id: "com.apple.Safari" });
  assert.deepEqual(resolveAppIdentity({ bundle_id: "\ncom.google.Chrome\t" }), { bundle_id: "com.google.Chrome" });
  // A whitespace-only bundle_id trims to "" and is no longer a usable identity.
  assert.deepEqual(resolveAppIdentity({ bundle_id: "   " }), { bundle_id: "" });
});

test("resolveAppIdentity maps common-app aliases to exact bundle ids", () => {
  assert.deepEqual(resolveAppIdentity({ app_name: "Mail" }), { bundle_id: "com.apple.mail" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Calendar" }), { bundle_id: "com.apple.iCal" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Messages" }), { bundle_id: "com.apple.MobileSMS" });
  // "iMessage" is the spoken name for Messages; it must resolve like the
  // "messages" alias instead of falling back to a name lookup that misses.
  assert.deepEqual(resolveAppIdentity({ app_name: "iMessage" }), { bundle_id: "com.apple.MobileSMS" });
  // "iTunes" no longer exists as an app; the legacy spoken name maps to Music.
  assert.deepEqual(resolveAppIdentity({ app_name: "iTunes" }), { bundle_id: "com.apple.Music" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Dropbox" }), { bundle_id: "com.getdropbox.dropbox" });
  assert.deepEqual(resolveAppIdentity({ app_name: "System Settings" }), { bundle_id: "com.apple.systempreferences" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Slack" }), { bundle_id: "com.tinyspeck.slackmacgap" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Spotify" }), { bundle_id: "com.spotify.client" });
  // Browsers and office apps a voice user is likely to name, whose bundle ids
  // differ from the display name or need a stable alias to resolve reliably.
  assert.deepEqual(resolveAppIdentity({ app_name: "Arc" }), { bundle_id: "company.thebrowser.Browser" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Brave" }), { bundle_id: "com.brave.Browser" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Firefox" }), { bundle_id: "org.mozilla.firefox" });
  assert.deepEqual(resolveAppIdentity({ app_name: "VS Code" }), { bundle_id: "com.microsoft.VSCode" });
  assert.deepEqual(resolveAppIdentity({ app_name: "visual studio code" }), { bundle_id: "com.microsoft.VSCode" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Numbers" }), { bundle_id: "com.apple.iWork.Numbers" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Excel" }), { bundle_id: "com.microsoft.Excel" });
  assert.deepEqual(resolveAppIdentity({ app_name: "PowerPoint" }), { bundle_id: "com.microsoft.Powerpoint" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Word" }), { bundle_id: "com.microsoft.Word" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Zoom" }), { bundle_id: "us.zoom.xos" });
  // Messaging/gaming apps with proper-noun names a voice user is likely to
  // say; safe to guess from the reason text because they are not common words.
  assert.deepEqual(resolveAppIdentity({ app_name: "Telegram" }), { bundle_id: "ru.keepcoder.Telegram" });
  assert.deepEqual(resolveAppIdentity({ app_name: "signal" }), { bundle_id: "org.whispersystems.signal" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Steam" }), { bundle_id: "com.valvesoftware.steam" });
  // System utilities and media/terminal apps whose display name differs from
  // the bundle id, plus the podcast singular/plural pair.
  assert.deepEqual(resolveAppIdentity({ app_name: "App Store" }), { bundle_id: "com.apple.AppStore" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Activity Monitor" }), { bundle_id: "com.apple.ActivityMonitor" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Maps" }), { bundle_id: "com.apple.Maps" });
  assert.deepEqual(resolveAppIdentity({ app_name: "podcast" }), { bundle_id: "com.apple.podcasts" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Podcasts" }), { bundle_id: "com.apple.podcasts" });
  assert.deepEqual(resolveAppIdentity({ app_name: "VLC" }), { bundle_id: "org.videolan.vlc" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Ghostty" }), { bundle_id: "com.mitchellh.ghostty" });
  assert.deepEqual(resolveAppIdentity({ app_name: "1Password" }), { bundle_id: "com.1password.1password" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Todoist" }), { bundle_id: "com.todoist.mac.Todoist" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Kindle" }), { bundle_id: "com.amazon.Kindle" });
  // Developer tools with opaque bundle ids and Apple system apps whose display
  // name differs from the bundle id, all named aloud by a voice user.
  assert.deepEqual(resolveAppIdentity({ app_name: "Warp" }), { bundle_id: "dev.warp.Warp-Stable" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Raycast" }), { bundle_id: "com.raycast.macos" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Docker" }), { bundle_id: "com.docker.docker" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Postman" }), { bundle_id: "com.postmanlabs.mac" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Zed" }), { bundle_id: "dev.zed.Zed" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Cursor" }), { bundle_id: "com.todesktop.230313mzl4w4u92" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Sublime Text" }), { bundle_id: "com.sublimetext.4" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Alfred" }), { bundle_id: "com.runningwithcrayons.Alfred" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Books" }), { bundle_id: "com.apple.iBooks" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Voice Memos" }), { bundle_id: "com.apple.VoiceMemos" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Clock" }), { bundle_id: "com.apple.clock" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Weather" }), { bundle_id: "com.apple.weather" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Shortcuts" }), { bundle_id: "com.apple.shortcuts" });
  assert.deepEqual(resolveAppIdentity({ app_name: "Linear" }), { bundle_id: "com.linear.linear" });
});

test("normalizeCuaArgs fills bundle_id for launch_app from context", () => {
  assert.deepEqual(
    normalizeCuaArgs("launch_app", {}, { tool_name: "launch_app", json_args: {}, reason: "open safari" }),
    { bundle_id: "com.apple.Safari" },
  );
  assert.deepEqual(normalizeCuaArgs("launch_app", { name: "X" }), { name: "X" });
  assert.deepEqual(normalizeCuaArgs("other_tool", { a: 1 }), { a: 1 });
});

test("normalizeCuaArgs normalizes press_key key/modifiers like the dedicated tool", () => {
  // A direct run_cua_driver call with tool_name "press_key" must get the same
  // normalization pressKeyInFrontApp applies: cua-driver expects a lowercase
  // key and an array of lowercase modifier names, and a capitalized key,
  // bare-string modifiers, or a "+"-joined combo would otherwise fail
  // opaquely in the driver.
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "Return", modifiers: "cmd" }), {
    pid: 42,
    key: "return",
    modifiers: ["cmd"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: " esc ", modifiers: ["CMD", "Shift"] }), {
    pid: 42,
    key: "esc",
    modifiers: ["cmd", "shift"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "x", modifiers: "Cmd + Shift" }), {
    pid: 42,
    key: "x",
    modifiers: ["cmd", "shift"],
  });
  // Whitespace-only modifier entries and duplicates collapse; non-string
  // modifier entries are dropped.
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "v", modifiers: ["cmd", "  ", "cmd", 7] }), {
    pid: 42,
    key: "v",
    modifiers: ["cmd"],
  });
  // Normalization is idempotent: the already-normalized args the dedicated
  // tool sends pass through unchanged.
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "return", modifiers: ["cmd"] }), {
    pid: 42,
    key: "return",
    modifiers: ["cmd"],
  });
  // A model may put the whole shortcut in the key ("cmd+shift+p") instead of
  // a single key + modifiers array: the last part becomes the pressed key
  // and the preceding parts become modifiers, so the combo reaches the
  // driver in the exact single-key + array shape it expects instead of
  // failing opaquely. Key-derived modifiers merge with the explicit ones,
  // and exact duplicates collapse ("cmd+p" with modifiers ["cmd"] is just
  // cmd+p).
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "cmd+shift+p" }), {
    pid: 42,
    key: "p",
    modifiers: ["cmd", "shift"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "CMD + SHIFT + P" }), {
    pid: 42,
    key: "p",
    modifiers: ["cmd", "shift"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "cmd+p", modifiers: ["shift"] }), {
    pid: 42,
    key: "p",
    modifiers: ["cmd", "shift"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "cmd+p", modifiers: ["cmd"] }), {
    pid: 42,
    key: "p",
    modifiers: ["cmd"],
  });
  // The combo split is idempotent too: re-normalizing the normalized result
  // is a no-op.
  assert.deepEqual(normalizeCuaArgs("press_key", normalizeCuaArgs("press_key", { key: "cmd+shift+p" })), {
    key: "p",
    modifiers: ["cmd", "shift"],
  });
  // A stray leading/trailing "+" ("cmd+", "+p") is the same cosmetic noise
  // as a whole combo: the split yields one normalized part, and that part is
  // the key — the raw key with the stray plus would reach cua-driver and
  // fail with an opaque error the model cannot self-correct from. Plain
  // single keys ("return") produce the same single part and are unchanged.
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "cmd+" }), {
    pid: 42,
    key: "cmd",
    modifiers: [],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "+p" }), {
    pid: 42,
    key: "p",
    modifiers: [],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "CMD +" }), {
    pid: 42,
    key: "cmd",
    modifiers: [],
  });
  // "+" is a real key name — the plus key, e.g. Cmd+Plus to zoom in — so a
  // lone "+" is a valid single-key press, not stray noise: it must reach the
  // driver as the "+" key, and the required-arg guard must accept it.
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "+" }), {
    pid: 42,
    key: "+",
    modifiers: [],
  });
  assert.equal(
    validateCuaDriverRequiredArgs("press_key", normalizeCuaArgs("press_key", { key: "+" })),
    null,
  );
  // A model wanting the plus key with a modifier writes the whole shortcut
  // in the key ("cmd++", "cmd + +"): the final "+" IS the key and the
  // preceding parts become modifiers. Without this the combo would split to
  // a single "cmd" part and silently press a bare Cmd (reported as success,
  // wrong action). A single trailing "+" ("cmd+") is still stray noise, and
  // all-plus strings ("++") still normalize to "" for the guard to reject.
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "cmd++" }), {
    pid: 42,
    key: "+",
    modifiers: ["cmd"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "cmd + +" }), {
    pid: 42,
    key: "+",
    modifiers: ["cmd"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "cmd++", modifiers: ["cmd"] }), {
    pid: 42,
    key: "+",
    modifiers: ["cmd"],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: 42, key: "++" }), {
    pid: 42,
    key: "",
    modifiers: [],
  });
  // The plus-key normalization is idempotent too: re-normalizing the
  // normalized result is a no-op.
  assert.deepEqual(normalizeCuaArgs("press_key", normalizeCuaArgs("press_key", { key: "cmd++" })), {
    key: "+",
    modifiers: ["cmd"],
  });
  // Non-string keys stay untouched (they fail in the driver like today), a
  // missing modifiers becomes the explicit empty array (same shape the
  // dedicated tool always sends), and other tools are not affected.
  assert.deepEqual(normalizeCuaArgs("press_key", { key: 7 }), { key: 7, modifiers: [] });
  assert.deepEqual(normalizeCuaArgs("type_text_chars", { text: "Return" }), { text: "Return" });
});

test("normalizeCuaArgs converts stringified pids to numbers for press_key/type_text_chars", () => {
  // A model very plausibly emits the pid as a string ("123") instead of the
  // number cua-driver's schema expects; the stringified form would otherwise
  // reach the driver raw and fail with an opaque error the model cannot
  // self-correct from. Leading zeros normalize too ("0123" is pid 123).
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: "123", key: "return" }), {
    pid: 123,
    key: "return",
    modifiers: [],
  });
  assert.deepEqual(normalizeCuaArgs("type_text_chars", { pid: "0123", text: "hola" }), {
    pid: 123,
    text: "hola",
  });
  // Already-numeric pids pass through unchanged (the dedicated tools' path).
  assert.deepEqual(normalizeCuaArgs("type_text_chars", { pid: 42, text: "hola" }), { pid: 42, text: "hola" });
  // Non-digit strings and non-positive values are left untouched: validation
  // rejects them with a clean message instead of the driver failing opaquely.
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: "abc", key: "return" }), {
    pid: "abc",
    key: "return",
    modifiers: [],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: "0", key: "return" }), {
    pid: "0",
    key: "return",
    modifiers: [],
  });
  assert.deepEqual(normalizeCuaArgs("press_key", { pid: "-5", key: "return" }), {
    pid: "-5",
    key: "return",
    modifiers: [],
  });
  // Other tools are not affected.
  assert.deepEqual(normalizeCuaArgs("launch_app", { name: "X", pid: "123" }), { name: "X", pid: "123" });
});

test("validateCuaDriverRequiredArgs rejects malformed pids but allows a missing one", () => {
  // pid is optional: cua-driver falls back to the frontmost app when it is
  // absent, and the dedicated tools always resolve and send it. A PRESENT
  // pid must be a positive integer — a 0/negative/fractional pid or a
  // non-numeric string would otherwise reach the driver raw and fail with an
  // opaque error the model cannot self-correct from. Digit strings are
  // accepted raw too (normalizeCuaArgs converts them to numbers first).
  assert.equal(validateCuaDriverRequiredArgs("press_key", { key: "return" }), null);
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", { text: "hola" }), null);
  assert.equal(validateCuaDriverRequiredArgs("press_key", { key: "return", pid: 42 }), null);
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", { text: "hola", pid: "123" }), null);
  assert.equal(
    validateCuaDriverRequiredArgs("press_key", { key: "return", pid: 0 }),
    "pid must be a positive integer when provided.",
  );
  assert.equal(
    validateCuaDriverRequiredArgs("press_key", { key: "return", pid: -1 }),
    "pid must be a positive integer when provided.",
  );
  assert.equal(
    validateCuaDriverRequiredArgs("press_key", { key: "return", pid: 1.5 }),
    "pid must be a positive integer when provided.",
  );
  assert.equal(
    validateCuaDriverRequiredArgs("type_text_chars", { text: "hola", pid: "abc" }),
    "pid must be a positive integer when provided.",
  );
  assert.equal(
    validateCuaDriverRequiredArgs("press_key", { key: "return", pid: "0" }),
    "pid must be a positive integer when provided.",
  );
  // Other tools are not affected.
  assert.equal(validateCuaDriverRequiredArgs("launch_app", { name: "X", pid: "abc" }), null);
});

test("validateCuaDriverRequiredArgs rejects missing/blank/non-string press_key key and type_text_chars text", () => {
  // The run_cua_driver schema only requires tool_name+json_args, so the model
  // can call press_key/type_text_chars directly with the required field
  // missing — a shape cua-driver rejects with an opaque error. The guard must
  // refuse missing, whitespace-only (trims to ""), and non-string values with
  // the same clean message the dedicated tools use.
  assert.equal(validateCuaDriverRequiredArgs("press_key", {}), "key must be a non-empty string.");
  assert.equal(validateCuaDriverRequiredArgs("press_key", { key: "   " }), "key must be a non-empty string.");
  assert.equal(validateCuaDriverRequiredArgs("press_key", { key: 7 }), "key must be a non-empty string.");
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", {}), "text must be a non-empty string.");
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", { text: "\n" }), "text must be a non-empty string.");
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", { text: 42 }), "text must be a non-empty string.");
});

test("validateCuaDriverRequiredArgs passes valid args and ignores other tools", () => {
  // Only press_key/type_text_chars have required fields this bridge knows of;
  // every other tool (including launch_app, which has its own safety gate)
  // must pass through untouched.
  assert.equal(validateCuaDriverRequiredArgs("press_key", { key: "return", modifiers: ["cmd"] }), null);
  assert.equal(validateCuaDriverRequiredArgs("press_key", { key: "p" }), null);
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", { text: "hola" }), null);
  assert.equal(validateCuaDriverRequiredArgs("list_apps", {}), null);
  assert.equal(validateCuaDriverRequiredArgs("get_active_app", {}), null);
  assert.equal(validateCuaDriverRequiredArgs("launch_app", { name: "Safari" }), null);
  assert.equal(validateCuaDriverRequiredArgs("launch_app", {}), null);
});

test("validateCuaDriverRequiredArgs runs on normalized args", () => {
  // Callers normalize first, so a "+"-joined combo normalizes to a real key
  // and must pass, while a whitespace-only key trims to "" and must fail.
  const combo = normalizeCuaArgs("press_key", { key: "CMD+SHIFT+P" });
  assert.equal(combo.key, "p");
  assert.equal(validateCuaDriverRequiredArgs("press_key", combo), null);
  const blank = normalizeCuaArgs("press_key", { key: "   " });
  assert.equal(blank.key, "");
  assert.equal(validateCuaDriverRequiredArgs("press_key", blank), "key must be a non-empty string.");
  assert.equal(
    validateCuaDriverRequiredArgs("type_text_chars", normalizeCuaArgs("type_text_chars", { text: " ok " })),
    null,
  );
});

test("validateCuaDriverRequiredArgs caps oversized press_key keys like the dedicated tool", () => {
  // pressKeyInFrontApp rejects a key longer than 100 bytes up front; the
  // run_cua_driver path must mirror that so a model-generated megabyte key
  // never reaches cua-driver raw (the json_args byte cap alone allows up to
  // 200KB). A real key name is always short, so the cap cannot reject
  // anything legitimate.
  assert.equal(
    validateCuaDriverRequiredArgs("press_key", { key: "x".repeat(101) }),
    "key exceeds the maximum length of 100 bytes.",
  );
  assert.equal(
    validateCuaDriverRequiredArgs("press_key", { key: "é".repeat(51) }), // 102 UTF-8 bytes
    "key exceeds the maximum length of 100 bytes.",
  );
  assert.equal(validateCuaDriverRequiredArgs("press_key", { key: "x".repeat(100) }), null);
});

test("validateCuaDriverRequiredArgs rejects type_text_chars text that cannot fit the typing budget", () => {
  // typeTextInFrontApp rejects a text longer than the typing budget up front
  // (at the 1ms/char floor it can never finish inside the driver timeout);
  // the run_cua_driver path must mirror that so a 100k-char text — well
  // under the 200KB json_args byte cap — is refused cleanly instead of
  // launching a run doomed to time out. The budget follows the caller's
  // configured driver timeout, same as the dedicated tool.
  assert.equal(
    validateCuaDriverRequiredArgs("type_text_chars", { text: "a".repeat(48001) }),
    "text is too long to type within the driver timeout (max 48000 characters). Split it into smaller chunks and retry.",
  );
  // A shorter configured timeout shrinks the budget accordingly.
  assert.equal(
    validateCuaDriverRequiredArgs("type_text_chars", { text: "a".repeat(40001) }, 40000),
    "text is too long to type within the driver timeout (max 40000 characters). Split it into smaller chunks and retry.",
  );
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", { text: "a".repeat(48000) }), null);
  assert.equal(validateCuaDriverRequiredArgs("type_text_chars", { text: "a".repeat(40000) }, 40000), null);
});

test("normalizeCuaArgs matches aliases on word boundaries, not substrings", () => {
  // "keynotes" contains "notes" and "previewing" contains "preview": a raw
  // substring match would launch the wrong app for these reasons.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the keynotes deck" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "previewing the diff" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "my notes are here" }), { bundle_id: "com.apple.Notes" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open google chrome" }), { bundle_id: "com.google.Chrome" });
});

test("normalizeCuaArgs resolves common-app aliases without substring false positives", () => {
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open mail" }), { bundle_id: "com.apple.mail" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the calendar" }), { bundle_id: "com.apple.iCal" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open keynote" }), { bundle_id: "com.apple.Keynote" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open iterm2" }), { bundle_id: "com.googlecode.iterm2" });
  // "keynotes" (plural) is a different word than the "keynote" alias, so it
  // must not resolve; "email" contains "mail" but not as a standalone word.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the keynotes deck" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "check the email" }), {});
  // Proper-noun aliases resolve from the reason text like the other common
  // apps, and word boundaries still apply: "signal" alone launches Signal,
  // but "signals" (a different word) must not.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open telegram" }), { bundle_id: "ru.keepcoder.Telegram" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open steam" }), { bundle_id: "com.valvesoftware.steam" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open signal" }), { bundle_id: "org.whispersystems.signal" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "check the signals" }), {});
  // Newer aliases resolve from the reason text too, and word boundaries still
  // hold: "podcast" is a substring of "podcasting" but not a standalone word,
  // and "unmapped" must not launch Maps.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the maps" }), { bundle_id: "com.apple.Maps" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open podcasts" }), { bundle_id: "com.apple.podcasts" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the app store" }), { bundle_id: "com.apple.AppStore" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open activity monitor" }), { bundle_id: "com.apple.ActivityMonitor" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open 1password" }), { bundle_id: "com.1password.1password" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "podcasting the session" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "unmapped the fields" }), {});
  // Newer developer-tool and system-app aliases resolve from the reason text
  // too, and word boundaries still hold: "warping" is not "warp".
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open warp" }), { bundle_id: "dev.warp.Warp-Stable" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the voice memos" }), { bundle_id: "com.apple.VoiceMemos" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open sublime text" }), { bundle_id: "com.sublimetext.4" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open raycast" }), { bundle_id: "com.raycast.macos" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "warping the selection" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "check the weather report" }), { bundle_id: "com.apple.weather" });
});

test("normalizeCuaArgs resolves the newer system/creative/dev/comms aliases", () => {
  // Apple system apps (display names differ from bundle ids).
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open my contacts" }), { bundle_id: "com.apple.AddressBook" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the dictionary" }), { bundle_id: "com.apple.Dictionary" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open disk utility" }), { bundle_id: "com.apple.DiskUtility" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open stickies" }), { bundle_id: "com.apple.Stickies" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open imovie" }), { bundle_id: "com.apple.iMovie" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open garageband" }), { bundle_id: "com.apple.garageband" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open quicktime" }), { bundle_id: "com.apple.QuickTimePlayerX" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open the stocks" }), { bundle_id: "com.apple.stocks" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open freeform" }), { bundle_id: "com.apple.Freeform" });
  // Creative/professional apps.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open photoshop" }), { bundle_id: "com.adobe.Photoshop" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open after effects" }), { bundle_id: "com.adobe.AfterEffects" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open blender" }), { bundle_id: "org.blenderfoundation.blender" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open davinci resolve" }), { bundle_id: "com.blackmagic-design.Resolve" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open final cut pro" }), { bundle_id: "com.apple.FinalCut" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open logic pro" }), { bundle_id: "com.apple.logic10" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open canva" }), { bundle_id: "com.canva.CanvaDesktop" });
  // Developer tools and comms apps.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open android studio" }), { bundle_id: "com.google.android.studio" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open intellij" }), { bundle_id: "com.jetbrains.intellij" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open pycharm" }), { bundle_id: "com.jetbrains.pycharm" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open github desktop" }), { bundle_id: "com.github.GitHubClient" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open microsoft edge" }), { bundle_id: "com.microsoft.edgemac" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open obs studio" }), { bundle_id: "com.obsproject.obs" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open skype" }), { bundle_id: "com.skype.skype" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open wechat" }), { bundle_id: "com.tencent.xinWeChat" });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open webex" }), { bundle_id: "com.cisco.webexmeetings" });
  // Deliberately un-aliased ambiguous words must NOT resolve: "edge" alone
  // (cutting edge / edge case), "resolve" alone (resolve the issue), "obs"
  // alone (observation contexts), and "contacts" as a substring ("contactless").
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "on the cutting edge" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "resolve the issue" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "check the obs logs" }), {});
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "contactless payment" }), {});
});

test("normalizeCuaArgs does not guess an app when launch_app already carries a URL", () => {
  // An explicit URL means "open in the default browser"; a keyword in the
  // reason text must not silently redirect it to a guessed app.
  assert.deepEqual(
    normalizeCuaArgs("launch_app", { urls: ["https://example.com"] }, { reason: "open the chrome docs" }),
    { urls: ["https://example.com"] },
  );
  assert.deepEqual(
    normalizeCuaArgs("launch_app", { url: "https://example.com" }, { reason: "open safari" }),
    { url: "https://example.com" },
  );
});

test("normalizeCuaArgs matches aliases with regex metacharacters literally", () => {
  // Aliases are interpolated into a RegExp, so a metacharacter in an alias
  // must be escaped: unescaped, "c++" would match "cc" (and an unbalanced
  // "(" would throw a SyntaxError on every call). A custom alias map is the
  // only way to exercise this today; a future default alias with a
  // metacharacter must behave the same way.
  const customAliases = new Map([
    ["c++", "com.example.cpp"],
    ["vs.code", "com.example.vscode"],
    ["a(b", "com.example.paren"],
  ]);
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open c++" }, customAliases), {
    bundle_id: "com.example.cpp",
  });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open vs.code" }, customAliases), {
    bundle_id: "com.example.vscode",
  });
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open a(b now" }, customAliases), {
    bundle_id: "com.example.paren",
  });
  // "cc" is not the "c++" alias: the escaped pattern must not match it.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open cc" }, customAliases), {});
  // Word boundaries still apply to escaped aliases.
  assert.deepEqual(normalizeCuaArgs("launch_app", {}, { reason: "open c++x" }, customAliases), {});
});

test("normalizeCuaArgs bounds the alias-guess scan so a huge args blob cannot stall it", () => {
  // The guess scans the serialized call context for an alias mention. A
  // model-controlled json_args can be arbitrarily large (prompt injection or
  // hallucination), and an unbounded scan runs every alias regex over the
  // whole payload — freezing the main process before the json_args length
  // guard downstream even runs. The scan must be bounded to the head of the
  // payload, with the reason first so a long args blob cannot truncate it.
  const hugeArgs = { padding: "x".repeat(100000) };
  // The alias mention lives in the reason, which is stringified before args,
  // so it must still resolve even with a huge args blob present.
  assert.deepEqual(
    normalizeCuaArgs("launch_app", hugeArgs, { reason: "open safari" }),
    { bundle_id: "com.apple.Safari", padding: "x".repeat(100000) },
  );
  // A mention buried beyond the scan window is not a hint (and must not
  // resolve): the guess only reads the head of the payload.
  assert.deepEqual(
    normalizeCuaArgs("launch_app", { reason: `${"x".repeat(5000)} open safari` }),
    { reason: `${"x".repeat(5000)} open safari` },
  );
});

test("normalizeCuaArgs resolves launch_app app_name through the open_app alias map", () => {
  // open_app understands app_name; launch_app must resolve the same key so a
  // model using app_name gets the identical identity (alias -> bundle_id).
  assert.deepEqual(normalizeCuaArgs("launch_app", { app_name: "safari" }), { bundle_id: "com.apple.Safari" });
  assert.deepEqual(normalizeCuaArgs("launch_app", { app_name: "Visual Studio Code" }), {
    bundle_id: "com.microsoft.VSCode",
  });
  // Unknown app names stay plain names, exactly like resolveAppIdentity.
  assert.deepEqual(normalizeCuaArgs("launch_app", { app_name: "MyApp" }), { name: "MyApp" });
  // An explicit bundle_id/name wins and app_name is left untouched for
  // non-launch tools.
  assert.deepEqual(normalizeCuaArgs("launch_app", { bundle_id: "x.y.z", app_name: "Safari" }), {
    bundle_id: "x.y.z",
    app_name: "Safari",
  });
  assert.deepEqual(normalizeCuaArgs("list_apps", { app_name: "Safari" }), { app_name: "Safari" });
});

test("normalizeCuaArgs trims stray whitespace around launch_app bundle_id and name", () => {
  // The same cosmetic noise that wraps app_name also wraps bundle_id/name;
  // an untrimmed value would fail the identity gate for a safe identity.
  assert.deepEqual(normalizeCuaArgs("launch_app", { bundle_id: " com.apple.Safari " }), {
    bundle_id: "com.apple.Safari",
  });
  assert.deepEqual(normalizeCuaArgs("launch_app", { bundle_id: "\ncom.google.Chrome\t" }), {
    bundle_id: "com.google.Chrome",
  });
  assert.deepEqual(normalizeCuaArgs("launch_app", { name: "  MyApp  " }), { name: "MyApp" });
  // A whitespace-only bundle_id trims to "" and cannot smuggle an identity.
  assert.deepEqual(normalizeCuaArgs("launch_app", { bundle_id: "   " }), { bundle_id: "" });
});

test("normalizeCuaArgs trims stray whitespace around launch_app url/urls", () => {
  // isSafeLaunchUrl validates the trimmed URL, so an untrimmed value would
  // pass the gate but reach cua-driver padded and fail to open. The same
  // cosmetic-noise trim that applies to bundle_id/name must apply to URLs.
  assert.deepEqual(normalizeCuaArgs("launch_app", { url: "  https://example.com  " }), {
    url: "https://example.com",
  });
  assert.deepEqual(normalizeCuaArgs("launch_app", { url: "\nhttp://localhost:3000\t" }), {
    url: "http://localhost:3000",
  });
  assert.deepEqual(normalizeCuaArgs("launch_app", { urls: ["  https://example.com  ", "\thttps://x.test\n"] }), {
    urls: ["https://example.com", "https://x.test"],
  });
  // A whitespace-only URL trims to "" but must NOT be re-guessed as an app:
  // the alias guess runs before the trim, so an explicit (even if empty)
  // url field still suppresses context guessing and the safety gate rejects.
  assert.deepEqual(normalizeCuaArgs("launch_app", { url: "   " }, { reason: "open safari" }), { url: "" });
  // Non-string entries are left untouched for the safety gate to reject.
  assert.deepEqual(normalizeCuaArgs("launch_app", { urls: ["https://example.com", 42] }), {
    urls: ["https://example.com", 42],
  });
});

test("normalizeCuaArgs resolves app_name alongside urls like open_app does", () => {
  // open_app launches the identity AND passes a safe url; launch_app must do
  // the same instead of leaving the app_name unresolved when urls are present.
  assert.deepEqual(
    normalizeCuaArgs("launch_app", { app_name: "safari", urls: ["https://example.com"] }),
    { bundle_id: "com.apple.Safari", urls: ["https://example.com"] },
  );
});

test("normalizeCuaArgs does not resolve a non-string app_name into a launchable name", () => {
  // The app_name resolution used to String()-coerce 42 into name "42", which
  // then passed the identity gate and reached cua-driver as a launch attempt
  // for an app literally named "42" — an opaque driver failure. A non-string
  // app_name must stay unresolved so the identity gate rejects it cleanly.
  const args = normalizeCuaArgs("launch_app", { app_name: 42 });
  assert.equal(args.app_name, 42); // left untouched for the identity gate
  assert.equal(isSafeCuaLaunchArgs(args), false);
  // A string app_name still resolves exactly as before.
  assert.deepEqual(normalizeCuaArgs("launch_app", { app_name: "Safari" }), { bundle_id: "com.apple.Safari" });
});

test("isSafeCuaLaunchArgs rejects non-string identities like the open_app gate does", () => {
  assert.equal(isSafeCuaLaunchArgs({ bundle_id: 42 }), false);
  assert.equal(isSafeCuaLaunchArgs({ name: 42 }), false);
  assert.equal(isSafeCuaLaunchArgs({ app_name: 42 }), false);
  assert.equal(isSafeCuaLaunchArgs({ bundle_id: true }), false);
  // String identities still pass.
  assert.equal(isSafeCuaLaunchArgs({ bundle_id: "com.apple.Safari" }), true);
  assert.equal(isSafeCuaLaunchArgs({ app_name: "Safari" }), true);
});

test("isSafeCuaLaunchArgs validates a raw app_name identity", () => {
  assert.equal(isSafeCuaLaunchArgs({ app_name: "Safari" }), true);
  assert.equal(isSafeCuaLaunchArgs({ app_name: "Música" }), true);
  // The same unsafe string open_app rejects must not pass the launch_app gate.
  assert.equal(isSafeCuaLaunchArgs({ app_name: 'x"\ndo shell script' }), false);
  assert.equal(isSafeCuaLaunchArgs({ app_name: "Música\u0007" }), false);
});

test("isSafeCuaLaunchArgs accepts safe launch_app identities and http/https urls", () => {
  assert.equal(isSafeCuaLaunchArgs({ bundle_id: "com.apple.Safari" }), true);
  assert.equal(isSafeCuaLaunchArgs({ name: "Visual Studio Code" }), true);
  assert.equal(isSafeCuaLaunchArgs({ bundle_id: "com.apple.Safari", urls: ["https://example.com"] }), true);
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", url: "http://localhost:3000" }), true);
  // No identity and no urls is not unsafe per se: cua-driver reports the miss.
  assert.equal(isSafeCuaLaunchArgs({}), true);
  assert.equal(isSafeCuaLaunchArgs({ reason: "open something" }), true);
});

test("isSafeCuaLaunchArgs rejects unsafe identities and non-http urls", () => {
  assert.equal(isSafeCuaLaunchArgs({ name: 'x"\ndo shell script' }), false);
  assert.equal(isSafeCuaLaunchArgs({ bundle_id: "a; do shell script" }), false);
  assert.equal(isSafeCuaLaunchArgs({ name: "Música\u0007" }), false);
  assert.equal(isSafeCuaLaunchArgs({ bundle_id: "com.apple.Terminal", urls: ["file:///etc/passwd"] }), false);
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", urls: ["x-apple.systempreferences:com.apple.preference.general"] }), false);
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", url: "javascript:alert(1)" }), false);
  // A urls value that is not an array is not a shape cua-driver accepts.
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", urls: "https://example.com" }), false);
  // One bad url poisons the whole array.
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", urls: ["https://ok.example", "file:///etc/hosts"] }), false);
  // Both url forms are validated when present: a safe urls array must not mask
  // an unsafe singular url (cua-driver may consult either field), and an empty
  // urls array must not make .every() vacuously true while url carries a payload.
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", urls: ["https://ok.example"], url: "file:///etc/hosts" }), false);
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", urls: [], url: "javascript:alert(1)" }), false);
  // A safe singular url alongside a safe array stays accepted, and an empty
  // urls array alone is an identity-only launch (nothing to validate).
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", urls: ["https://ok.example"], url: "https://also-ok.example" }), true);
  assert.equal(isSafeCuaLaunchArgs({ name: "Safari", urls: [] }), true);
});

test("resolveOpenAppTarget prefers an app identity over a url", () => {
  assert.deepEqual(resolveOpenAppTarget({ app_name: "Safari", url: "https://example.com" }), {
    kind: "app",
    identity: { bundle_id: "com.apple.Safari" },
  });
  assert.deepEqual(resolveOpenAppTarget({ bundle_id: "x.y.z" }), { kind: "app", identity: { bundle_id: "x.y.z" } });
  assert.deepEqual(resolveOpenAppTarget({ app_name: "MyApp" }), { kind: "app", identity: { name: "MyApp" } });
});

test("resolveOpenAppTarget allows a url-only open in the default browser", () => {
  assert.deepEqual(resolveOpenAppTarget({ url: "https://meet.google.com/abc" }), {
    kind: "url",
    url: "https://meet.google.com/abc",
  });
  assert.deepEqual(resolveOpenAppTarget({ url: "http://localhost:3000/page" }), {
    kind: "url",
    url: "http://localhost:3000/page",
  });
  // The same cosmetic-noise trim isSafeLaunchUrl applies for validation must
  // apply to the value handed to the `open` command: a padded URL would pass
  // the gate but fail to open with the whitespace attached.
  assert.deepEqual(resolveOpenAppTarget({ url: "  https://example.com  " }), {
    kind: "url",
    url: "https://example.com",
  });
  assert.deepEqual(resolveOpenAppTarget({ url: "https://example.com\n" }), {
    kind: "url",
    url: "https://example.com",
  });
});

test("resolveOpenAppTarget rejects unsafe or missing targets", () => {
  assert.deepEqual(resolveOpenAppTarget({}), { kind: "error", code: -1, message: "Missing app_name, bundle_id, or url." });
  assert.deepEqual(resolveOpenAppTarget({ url: "" }), { kind: "error", code: -1, message: "Missing app_name, bundle_id, or url." });
  assert.equal(resolveOpenAppTarget({ url: "file:///etc/passwd" }).kind, "error");
  assert.equal(resolveOpenAppTarget({ url: "ssh://evil-host" }).kind, "error");
  assert.equal(resolveOpenAppTarget({ url: 42 }).kind, "error");
  assert.equal(resolveOpenAppTarget({ url: "javascript:alert(1)" }).code, -9);
});

test("resolveOpenAppTarget rejects a URL that would overflow the argv entry", () => {
  // The URL becomes a single argv entry to the `open` command (macOS caps one
  // argument at ~256 KiB), so an unbounded model-controlled URL would make
  // spawn() fail with E2BIG — the same failure the prompt/text/json_args
  // guards exist to prevent. The cap is the same requireMaxLength gate those
  // paths use, so a megabyte URL fails with the clear message instead of an
  // opaque spawn error.
  const huge = `https://example.com/${"x".repeat(9000)}`;
  assert.equal(resolveOpenAppTarget({ url: huge }).kind, "error");
  assert.match(resolveOpenAppTarget({ url: huge }).message, /maximum length/i);
  // A normal URL still passes.
  assert.equal(resolveOpenAppTarget({ url: "https://example.com" }).kind, "url");
});

test("isSafeCuaToolName accepts snake_case identifiers and rejects option-like names", () => {
  assert.equal(isSafeCuaToolName("launch_app"), true);
  assert.equal(isSafeCuaToolName("list_apps"), true);
  assert.equal(isSafeCuaToolName("--version"), false);
  assert.equal(isSafeCuaToolName("call --help"), false);
  assert.equal(isSafeCuaToolName(""), false);
  assert.equal(isSafeCuaToolName("a".repeat(101)), false);
  assert.equal(isSafeCuaToolName(42), false);
});

test("isSafeLaunchUrl accepts http/https URLs with a hostname", () => {
  assert.equal(isSafeLaunchUrl("https://meet.google.com/abc"), true);
  assert.equal(isSafeLaunchUrl("http://localhost:3000/page"), true);
  assert.equal(isSafeLaunchUrl("https://example.com"), true);
});

test("isSafeLaunchUrl tolerates surrounding whitespace", () => {
  assert.equal(isSafeLaunchUrl("  https://example.com  "), true);
  assert.equal(isSafeLaunchUrl("https://example.com\n"), true);
  assert.equal(isSafeLaunchUrl("\thttp://localhost:3000\t"), true);
  assert.equal(isSafeLaunchUrl("   "), false);
  // Trimming must not smuggle a different scheme or hostname past the gates.
  assert.equal(isSafeLaunchUrl(" file:///etc/passwd "), false);
  assert.equal(isSafeLaunchUrl(" javascript:alert(1) "), false);
  assert.equal(isSafeLaunchUrl("https://"), false);
});

test("isSafeLaunchUrl rejects non-http schemes and malformed input", () => {
  assert.equal(isSafeLaunchUrl("file:///etc/passwd"), false);
  assert.equal(isSafeLaunchUrl("ssh://evil-host"), false);
  assert.equal(isSafeLaunchUrl("x-apple.systempreferences:com.apple.preference.general"), false);
  assert.equal(isSafeLaunchUrl("javascript:alert(1)"), false);
  assert.equal(isSafeLaunchUrl("https://"), false);
  assert.equal(isSafeLaunchUrl("not a url"), false);
  assert.equal(isSafeLaunchUrl(""), false);
  assert.equal(isSafeLaunchUrl(42), false);
  assert.equal(isSafeLaunchUrl(undefined), false);
});

test("isPlausibleApiKey accepts sk- keys and rejects obvious non-keys", () => {
  assert.equal(isPlausibleApiKey("sk-proj-abc123_DEF"), true);
  assert.equal(isPlausibleApiKey("sk-abc"), true);
  assert.equal(isPlausibleApiKey(""), false);
  assert.equal(isPlausibleApiKey("sk- with space"), false);
  assert.equal(isPlausibleApiKey("not-a-key"), false);
  assert.equal(isPlausibleApiKey(42), false);
});

test("requireNonEmptyString accepts non-empty strings and rejects the rest", () => {
  assert.equal(requireNonEmptyString("run the tests", "prompt"), null);
  assert.equal(requireNonEmptyString("  spaced  ", "prompt"), null);
  assert.equal(requireNonEmptyString("", "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString("   ", "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString(undefined, "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString(null, "prompt"), "prompt must be a non-empty string.");
  assert.equal(requireNonEmptyString(42, "text"), "text must be a non-empty string.");
  assert.equal(requireNonEmptyString({ a: 1 }, "key"), "key must be a non-empty string.");
});

test("requireMaxLength caps oversized argv-bound values", () => {
  assert.equal(requireMaxLength("short", "prompt"), null);
  assert.equal(requireMaxLength("x".repeat(200001), "prompt"), "prompt exceeds the maximum length of 200000 bytes.");
  assert.equal(requireMaxLength("y".repeat(50), "key", 100), null);
  assert.equal(requireMaxLength("y".repeat(101), "key", 100), "key exceeds the maximum length of 100 bytes.");
  // Multibyte UTF-8 is counted in bytes, not characters: 100001 two-byte
  // accents are ~200KB in argv and would blow MAX_ARG_STRLEN despite a
  // character count under the limit, so they must be rejected too.
  assert.equal(requireMaxLength("á".repeat(100001), "prompt"), "prompt exceeds the maximum length of 200000 bytes.");
  assert.equal(requireMaxLength("á".repeat(99999), "prompt"), null);
  // Non-strings pass through: type checks are the caller's job.
  assert.equal(requireMaxLength(undefined, "prompt"), null);
  assert.equal(requireMaxLength({ a: 1 }, "prompt"), null);
});

test("requireNoNullBytes rejects argv-bound strings containing a null byte", () => {
  // A null byte in a spawn arg (or cwd) makes Node throw a synchronous
  // TypeError ("must be a string without null bytes") instead of settling
  // with a clean error — the exact failure the prompt/cwd/url guards exist
  // to prevent. JSON args can encode "\u0000", so model-controlled values
  // must be rejected here with a self-correctable message.
  assert.equal(requireNoNullBytes("run the tests", "prompt"), null);
  assert.equal(requireNoNullBytes("with\u0000null", "prompt"), "prompt must not contain null bytes.");
  assert.equal(requireNoNullBytes("a\u0000b\u0000c", "cwd"), "cwd must not contain null bytes.");
  // A lone null byte is still a null byte: an empty-ish value must not slip
  // past the guard and reach spawn (requireNonEmptyString does not strip \0).
  assert.equal(requireNoNullBytes("\u0000", "prompt"), "prompt must not contain null bytes.");
  // Non-strings pass through: type checks are the caller's job.
  assert.equal(requireNoNullBytes(undefined, "prompt"), null);
  assert.equal(requireNoNullBytes(null, "prompt"), null);
  assert.equal(requireNoNullBytes({ a: 1 }, "prompt"), null);
});

test("redactSecrets masks OpenAI keys", () => {
  assert.equal(redactSecrets("key sk-proj-abc123_DEF"), "key [REDACTED_OPENAI_KEY]");
  assert.equal(redactSecrets("no secrets here"), "no secrets here");
});

test("redactSecrets masks modern project keys containing dots", () => {
  assert.equal(redactSecrets("token sk-proj-abc123.def456-ghi"), "token [REDACTED_OPENAI_KEY]");
  assert.equal(redactSecrets("sk-proj-a.b.c"), "[REDACTED_OPENAI_KEY]");
});

test("redactSecrets does not corrupt words containing sk-", () => {
  assert.equal(redactSecrets("risk-2024 went up; task-proj done; ask-1 first"), "risk-2024 went up; task-proj done; ask-1 first");
  assert.equal(redactSecrets("disk-usage high"), "disk-usage high");
});

test("redactSecrets redacts keys at token boundaries only", () => {
  assert.equal(redactSecrets("key:sk-proj-abc123, ok"), "key:[REDACTED_OPENAI_KEY], ok");
  assert.equal(redactSecrets("\"sk-abc123\" and (sk-proj-x.y)"), "\"[REDACTED_OPENAI_KEY]\" and ([REDACTED_OPENAI_KEY])");
});

test("isApiKeyRejection detects only 401-class key rejections", () => {
  // The main process surfaces a bad key as "OpenAI Realtime token failed: 401
  // ...invalid_api_key..." (token fetch) or "Realtime call failed: 401"
  // (SDP exchange); both must count as key rejections.
  assert.equal(isApiKeyRejection(new Error("OpenAI Realtime token failed: 401 {\"error\":{\"code\":\"invalid_api_key\"}}")), true);
  assert.equal(isApiKeyRejection(new Error("OpenAI Realtime token failed: 401 Incorrect API key provided: sk-abc")), true);
  assert.equal(isApiKeyRejection(new Error("Realtime call failed: 401 Unauthorized")), true);
  assert.equal(isApiKeyRejection(new Error("Error code: 401")), true);
  // A stray 4+ digit number in an unrelated message must not false-positive,
  // mirroring the humanizeError bare-status branches.
  assert.equal(isApiKeyRejection(new Error("http status 4010 at line 12")), false);
  // Everything else leaves the key alone: the input must NOT be revealed for
  // network, quota, rate-limit, permission, or server failures.
  assert.equal(isApiKeyRejection(new Error("OpenAI Realtime token failed: 429 rate_limit_exceeded")), false);
  assert.equal(isApiKeyRejection(new Error("OpenAI Realtime token failed: 403 insufficient_permissions")), false);
  assert.equal(isApiKeyRejection(new Error("OpenAI Realtime token failed: 500 Internal Server Error")), false);
  assert.equal(isApiKeyRejection(new Error("OpenAI request timed out after 60s")), false);
  assert.equal(isApiKeyRejection(new Error("insufficient_quota (402)")), false);
  assert.equal(isApiKeyRejection(new Error("fetch failed")), false);
  // Non-error input must not throw.
  assert.equal(isApiKeyRejection(undefined), false);
  assert.equal(isApiKeyRejection("OpenAI Realtime token failed: 401 Unauthorized"), true);
});

test("humanizeError maps common failure modes to actionable messages", () => {
  assert.match(humanizeError({ name: "NotAllowedError", message: "denied" }), /microphone or screen access was denied/i);
  assert.match(humanizeError({ name: "NotFoundError", message: "no device" }), /no audio input device/i);
  assert.match(humanizeError({ name: "TimeoutError", message: "aborted" }), /request timed out/i);
  assert.match(humanizeError({ name: "AbortError", message: "aborted" }), /request timed out/i);
  assert.match(humanizeError(new Error("insufficient_quota")), /insufficient_quota/i);
  assert.match(humanizeError(new Error("exceeded your current quota")), /insufficient_quota/i);
});

test("humanizeError maps the main-process request timeout to the timeout message", () => {
  // postOpenAIJson rethrows its AbortSignal.timeout TimeoutError as a plain
  // Error ("OpenAI request timed out after 60s: <url>"), so the DOMException
  // name is gone by the time the error reaches the UI; the message pattern is
  // the only remaining signal and must still map to the friendly timeout text.
  assert.match(
    humanizeError(new Error("OpenAI request timed out after 60s: https://api.openai.com/v1/realtime/client_secrets")),
    /request timed out/i,
  );
});

test("humanizeError maps a bare HTTP 408 to the timeout message", () => {
  // A proxy or server answering with a bare 408 (opaque body, or a response
  // whose text is not the usual JSON error) carries no DOMException name; the
  // status alone is a definitive timeout diagnosis and must map to the
  // friendly timeout text instead of passing through raw, mirroring the
  // bare-status 401/403/404/429/5xx branches.
  assert.match(humanizeError(new Error("OpenAI token failed: 408 Request Timeout")), /request timed out/i);
  assert.match(humanizeError(new Error("Realtime call failed: 408")), /request timed out/i);
  assert.match(humanizeError(new Error("Error code: 408")), /request timed out/i);
  // A stray 4+ digit number in an unrelated message must not false-positive.
  assert.doesNotMatch(humanizeError(new Error("http status 4080 at line 12")), /request timed out/i);
});

test("humanizeError maps stale media device selections to an actionable message", () => {
  assert.match(
    humanizeError({ name: "OverconstrainedError", message: "Constraints could not be satisfied" }),
    /no longer available/i,
  );
  assert.match(humanizeError(new Error("Constraints could not be satisfied")), /no longer available/i);
});

test("humanizeError maps a busy/unavailable microphone to an actionable message", () => {
  // getUserMedia rejects with NotReadableError when the mic exists but is
  // held by another app (video call, recorder, another bridge instance); the
  // raw Chromium text would otherwise pass through as "Could not start audio
  // source" with no hint about the cause.
  assert.match(
    humanizeError({ name: "NotReadableError", message: "Could not start audio source" }),
    /in use by another app/i,
  );
  assert.match(humanizeError({ name: "TrackStartError", message: "Could not start audio source" }), /in use by another app/i);
  assert.match(humanizeError(new Error("Could not start audio source")), /in use by another app/i);
});

test("humanizeError maps invalid API key failures to an actionable message", () => {
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 401 invalid_api_key")), /rejected the API key/i);
  assert.match(humanizeError(new Error("Incorrect API key provided")), /rejected the API key/i);
  // A bare status (opaque body, proxy) must still map to the key message.
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 401 Unauthorized")), /rejected the API key/i);
  assert.match(humanizeError(new Error("Assistant: Realtime call failed: 401")), /rejected the API key/i);
  assert.match(humanizeError(new Error("Error code: 401")), /rejected the API key/i);
  // A 4-digit number must not false-positive on the 401 branch.
  assert.equal(humanizeError(new Error("OpenAI Realtime token failed: 4011")), "OpenAI Realtime token failed: 4011");
});

test("humanizeError maps network failures to a connectivity message", () => {
  assert.match(humanizeError(new TypeError("fetch failed")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("getaddrinfo ENOTFOUND api.openai.com")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("fetch failed: ECONNREFUSED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("socket hang up")), /could not reach the openai api/i);
  assert.match(humanizeError(new TypeError("NetworkError when attempting to fetch resource.")), /could not reach the openai api/i);
  // A network error must not shadow a more specific API error.
  assert.match(humanizeError(new Error("Error code: 401 - invalid_api_key")), /rejected the API key/i);
});

test("humanizeError maps Chromium net:: network codes to a connectivity message", () => {
  assert.match(humanizeError(new Error("net::ERR_INTERNET_DISCONNECTED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_NAME_NOT_RESOLVED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("Failed to load resource: net::ERR_CONNECTION_REFUSED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_CONNECTION_RESET")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_CONNECTION_ABORTED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_CONNECTION_CLOSED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_CONNECTION_FAILED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_TIMED_OUT")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_CONNECTION_TIMED_OUT")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_TUNNEL_CONNECTION_FAILED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_ADDRESS_UNREACHABLE")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("net::ERR_NETWORK_CHANGED")), /could not reach the openai api/i);
  // undici syscall codes (usually hidden inside error.cause of "fetch failed").
  assert.match(humanizeError(new Error("connect ETIMEDOUT 104.18.32.8:443")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("connect ENETUNREACH 10.0.0.1:443")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("connect EHOSTUNREACH 192.168.1.1:443")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("connect ECONNABORTED 104.18.32.8:443")), /could not reach the openai api/i);
  // undici's own failure codes (UND_ERR_*), direct and hidden in error.cause
  // of "fetch failed", must map to the connectivity message like the syscall
  // codes do instead of passing through "Connect Timeout Error" / "Socket Error".
  assert.match(
    humanizeError(Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })),
    /could not reach the openai api/i,
  );
  assert.match(
    humanizeError(Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" })),
    /could not reach the openai api/i,
  );
  assert.match(
    humanizeError(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
      }),
    ),
    /could not reach the openai api/i,
  );
  assert.match(
    humanizeError(Object.assign(new Error("Socket Error"), { code: "UND_ERR_SOCKET" })),
    /could not reach the openai api/i,
  );
  // The shared "err_" prefix must not drag certificate codes into this branch.
  assert.match(humanizeError(new Error("net::ERR_CERT_DATE_INVALID")), /tls certificate/i);
});

test("humanizeError maps proxy and empty-response net:: codes to a connectivity message", () => {
  // A configured-but-unreachable proxy (corporate proxy down) and a server
  // closing the connection without data (firewall/proxy dropping the request)
  // are connectivity problems; the raw net:: text must not pass through.
  assert.match(humanizeError(new Error("net::ERR_PROXY_CONNECTION_FAILED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("Failed to load resource: net::ERR_EMPTY_RESPONSE")), /could not reach the openai api/i);
  // Certificate codes still keep their own diagnosis, not the network one.
  assert.match(humanizeError(new Error("net::ERR_CERT_AUTHORITY_INVALID")), /tls certificate/i);
});

test("humanizeError maps TLS certificate failures to a certificate message", () => {
  assert.match(humanizeError(new Error("unable to verify the first certificate")), /tls certificate/i);
  assert.match(humanizeError(new Error("self-signed certificate in certificate chain")), /tls certificate/i);
  assert.match(humanizeError(new Error("certificate has expired")), /tls certificate/i);
  assert.match(humanizeError(new Error("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")), /tls certificate/i);
  assert.match(humanizeError(new Error("net::ERR_CERT_DATE_INVALID")), /tls certificate/i);
  // Non-certificate TLS handshake failures must map to the TLS message too,
  // not pass through raw (proxy/VPN interception is the usual cause).
  assert.match(humanizeError(new Error("net::ERR_SSL_PROTOCOL_ERROR")), /tls certificate/i);
  assert.match(humanizeError(new Error("net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH")), /tls certificate/i);
  // undici wraps the real reason in error.cause; the generic "fetch failed"
  // must not shadow the certificate diagnosis.
  const wrapped = new TypeError("fetch failed");
  wrapped.cause = new Error("unable to verify the first certificate");
  assert.match(humanizeError(wrapped), /tls certificate/i);
  // undici TLS protocol failures (EPROTO) carry the interception root cause
  // too: a proxy/antivirus speaking plain HTTP to a TLS port, a captive
  // portal, or a MITM. The raw OpenSSL text must map to the TLS message, not
  // pass through raw — and the cause-wrapped "fetch failed" form must not be
  // shadowed by the generic connectivity message.
  assert.match(
    humanizeError(new Error("write EPROTO: error:1408F10B:SSL routines:ssl3_get_record:wrong version number")),
    /tls certificate/i,
  );
  assert.match(humanizeError(new Error("tlsv1 alert unknown ca")), /tls certificate/i);
  assert.match(humanizeError(new Error("sslv3 alert handshake failure")), /tls certificate/i);
  const eprotoWrapped = new TypeError("fetch failed");
  eprotoWrapped.cause = { code: "EPROTO", message: "wrong version number" };
  assert.match(humanizeError(eprotoWrapped), /tls certificate/i);
  // A network error without a certificate cause still maps to connectivity.
  assert.match(humanizeError(new TypeError("fetch failed")), /could not reach the openai api/i);
  // The macOS application firewall denying this app outbound access surfaces
  // as Chromium's ERR_NETWORK_ACCESS_DENIED — a firewall problem that must
  // map to the connectivity message instead of passing through raw, so the
  // user does not blame the key or the server.
  assert.match(humanizeError(new Error("net::ERR_NETWORK_ACCESS_DENIED")), /could not reach the openai api/i);
  assert.match(humanizeError(new Error("fetch failed: enetdown")), /could not reach the openai api/i);
  // A syscall-code-only failure (the message is only the generic "fetch
  // failed", the code carries the diagnosis) must still map to connectivity.
  const enetdown = new TypeError("fetch failed");
  enetdown.cause = { code: "ENETDOWN", message: "network is down" };
  assert.match(humanizeError(enetdown), /could not reach the openai api/i);
});

test("humanizeError maps insufficient permissions failures to an actionable message", () => {
  assert.match(humanizeError(new Error("Error code: 403 - insufficient_permissions for project")), /insufficient permissions \(403\)/i);
  assert.match(humanizeError(new Error("You do not have access to the realtime API")), /insufficient permissions \(403\)/i);
  // A bare 403 status must still map to the permissions message.
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 403 Forbidden")), /insufficient permissions \(403\)/i);
  // A 404 model error must keep mapping to the 404 branch, not the 403 one.
  assert.match(
    humanizeError(new Error("Error code: 404 - The model 'gpt-realtime-2' does not exist or you do not have access to it.")),
    /could not find the requested realtime model \(404\)/i,
  );
});

test("humanizeError maps 402 billing failures to an actionable message", () => {
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 402")), /insufficient_quota \(402\)/i);
  assert.match(humanizeError(new Error("Realtime call failed: 402")), /insufficient_quota \(402\)/i);
  assert.match(humanizeError(new Error("Error code: 402 - insufficient_quota")), /insufficient_quota \(402\)/i);
  assert.match(humanizeError(new Error("Insufficient balance for this project")), /insufficient_quota \(402\)/i);
  // A 4-digit number must not false-positive on the 402 branch.
  assert.equal(humanizeError(new Error("Error code: 4021")), "Error code: 4021");
});

test("humanizeError maps billing hard limit failures to a billing message", () => {
  // OpenAI returns billing_hard_limit_reached with a 429 status; the billing
  // diagnosis must win over the generic rate-limit message.
  assert.match(humanizeError(new Error("Error code: 429 - billing_hard_limit_reached")), /billing hard limit/i);
  assert.match(humanizeError(new Error("You have reached the billing hard limit for this project")), /billing hard limit/i);
  assert.doesNotMatch(humanizeError(new Error("Error code: 429 - billing_hard_limit_reached")), /rate limit reached/i);
  // A real rate limit still maps to the rate-limit message.
  assert.match(humanizeError(new Error("Error code: 429 - rate_limit_exceeded")), /rate limit reached \(429\)/i);
});

test("humanizeError maps rate limit failures to an actionable message", () => {
  assert.match(humanizeError(new Error("Error code: 429 - rate_limit_exceeded for gpt-realtime-2")), /rate limit reached \(429\)/i);
  assert.match(humanizeError(new Error("Rate limit reached for model on requests per min (RPM)")), /rate limit reached \(429\)/i);
});

test("humanizeError maps bare 429 statuses to the rate limit message", () => {
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 429")), /rate limit reached \(429\)/i);
  assert.match(humanizeError(new Error("Realtime call failed: 429")), /rate limit reached \(429\)/i);
  assert.match(humanizeError(new Error("Error code: 429")), /rate limit reached \(429\)/i);
  // A 4-digit number must not false-positive on the 429 branch.
  assert.equal(humanizeError(new Error("Error code: 4291")), "Error code: 4291");
});

test("humanizeError maps content policy rejections to a content message, not the 400 config message", () => {
  // OpenAI's content_policy_violation is a 400, so without a dedicated branch
  // it would be mislabeled as a .env configuration problem.
  assert.match(
    humanizeError(new Error("Error code: 400 - content_policy_violation: Your request was rejected as a result of our safety system")),
    /content safety system/i,
  );
  assert.match(humanizeError(new Error("content_policy_violation")), /content safety system/i);
  assert.match(humanizeError(new Error("Your request was rejected as a result of our safety system")), /content safety system/i);
  assert.match(
    humanizeError(new Error("OpenAI Realtime token failed: 400 content_policy_violation")),
    /content safety system/i,
  );
  // The content diagnosis must win over the generic 400 .env advice.
  assert.doesNotMatch(
    humanizeError(new Error("Error code: 400 - content_policy_violation")),
    /check the model, voice, and language values/i,
  );
  // A real config 400 still maps to the config message (regression guard).
  assert.match(humanizeError(new Error("Error code: 400 - Invalid value for 'voice': 'marin'")), /rejected the realtime request \(400\)/i);
});

test("humanizeError maps invalid request errors (400) to a config message", () => {
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 400 invalid_request_error")), /rejected the realtime request \(400\)/i);
  assert.match(humanizeError(new Error("Error code: 400 - Invalid value for 'voice': 'marin'")), /rejected the realtime request \(400\)/i);
  // A bare 400 status must still map to the config message (also when the
  // error comes from the translation or transcription token endpoints).
  assert.match(humanizeError(new Error("OpenAI Realtime translation token failed: 400 Bad Request")), /rejected the realtime request \(400\)/i);
  // A 4-digit number must not false-positive on the 400 branch.
  assert.equal(humanizeError(new Error("Error code: 4000")), "Error code: 4000");
});

test("humanizeError maps missing model failures to an actionable message", () => {
  assert.match(humanizeError(new Error("Error code: 404 - The model 'gpt-realtime-2' does not exist or you do not have access to it.")), /could not find the requested realtime model \(404\)/i);
  assert.match(humanizeError(new Error("model_not_found")), /could not find the requested realtime model \(404\)/i);
  // A bare 404 status must still map to the model message.
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 404 Not Found")), /could not find the requested realtime model \(404\)/i);
  // A generic "does not exist" that is not about a model still passes through.
  assert.equal(humanizeError(new Error("the file does not exist")), "the file does not exist");
});

test("humanizeError maps 5xx server errors to a retry message", () => {
  assert.match(humanizeError(new Error("OpenAI Realtime token failed: 500 Internal Server Error")), /temporarily unavailable \(5xx/i);
  assert.match(humanizeError(new Error("OpenAI Realtime translation token failed: 502 Bad Gateway")), /temporarily unavailable \(5xx/i);
  assert.match(humanizeError(new Error("Error code: 503 - Service Unavailable")), /temporarily unavailable \(5xx/i);
  assert.match(humanizeError(new Error("Realtime call failed: 503 Service Unavailable")), /temporarily unavailable \(5xx/i);
  // A client error mentioning a 5xx-looking number must not hit the 5xx branch.
  assert.match(humanizeError(new Error("Error code: 401 - invalid_api_key")), /rejected the API key/i);
  assert.equal(humanizeError(new Error("error code: 5000 is my favorite number")), "error code: 5000 is my favorite number");
});

test("humanizeError passes through unknown messages", () => {
  assert.equal(humanizeError(new Error("boom")), "boom");
  assert.equal(humanizeError("plain string"), "plain string");
  assert.equal(humanizeError(undefined), "undefined");
  assert.equal(humanizeError(null), "null");
});

test("truncateOutput truncates long stdout and preserves metadata", () => {
  // 100 chars: 60 "A" then 40 "B". Truncation must keep the TAIL (the last
  // 50 chars) — the part of a long run's output where the result/error
  // summary lives — with a marker at the front, never the head.
  const out = truncateOutput({ ok: true, code: 0, stdout: "A".repeat(60) + "B".repeat(40), stderr: "" }, 50);
  assert.ok(out.stdout.startsWith("...[truncated 50 chars]\n"));
  assert.ok(out.stdout.endsWith("B".repeat(40)));
  assert.ok(!out.stdout.includes("A".repeat(60)));
  assert.equal(out.ok, true);
  assert.equal(out.code, 0);
  assert.equal(out.stderr, "");
});

test("truncateOutput truncates long stderr with the same tail+marker semantics", () => {
  // The truncation loop covers stderr identically to stdout (a long run's
  // error summary — the actionable part for the model — lives at the END of
  // stderr too), but only the stdout branch was pinned by tests. A future
  // refactor could special-case stderr and regress the tail-keeping that the
  // model relies on to self-correct from the failure, so pin it explicitly:
  // keep the tail, prepend the marker with the exact dropped count, and leave
  // a short stdout untouched.
  const out = truncateOutput({ ok: false, code: 1, stdout: "short", stderr: "X".repeat(60) + "Y".repeat(40) }, 50);
  assert.ok(out.stderr.startsWith("...[truncated 50 chars]\n"));
  assert.ok(out.stderr.endsWith("Y".repeat(40)));
  assert.ok(!out.stderr.includes("X".repeat(60)));
  assert.equal(out.stdout, "short");
  assert.equal(out.ok, false);
  assert.equal(out.code, 1);
});

test("truncateOutput truncates stdout and stderr independently when both are long", () => {
  // Each stream gets its own cap and marker: truncating stdout must not
  // consume the budget meant for stderr (or vice versa), and each keeps its
  // own tail so both the result and the error summary reach the model.
  const out = truncateOutput({ ok: false, code: 2, stdout: "A".repeat(40) + "B".repeat(40), stderr: "C".repeat(30) + "D".repeat(30) }, 50);
  assert.ok(out.stdout.startsWith("...[truncated 30 chars]\n"));
  assert.ok(out.stdout.endsWith("B".repeat(40)));
  assert.ok(out.stderr.startsWith("...[truncated 10 chars]\n"));
  assert.ok(out.stderr.endsWith("D".repeat(30)));
});

test("truncateOutput leaves short output untouched", () => {
  const out = truncateOutput({ ok: true, stdout: "short", stderr: "" }, 50);
  assert.equal(out.stdout, "short");
});

test("isSdpAnswer accepts SDP answers and rejects non-SDP bodies", () => {
  assert.equal(isSdpAnswer("v=0\r\n"), true);
  assert.equal(isSdpAnswer("  v=0\r\no=- 1 1 IN IP4 0.0.0.0"), true);
  assert.equal(isSdpAnswer("<!doctype html><html>captive portal</html>"), false);
  assert.equal(isSdpAnswer('{"error":{"message":"boom"}}'), false);
  assert.equal(isSdpAnswer(""), false);
  assert.equal(isSdpAnswer(null), false);
  assert.equal(isSdpAnswer(undefined), false);
});

test("humanizeSpawnError maps a missing binary to an actionable message", () => {
  const error = new Error("spawn codex ENOENT");
  error.code = "ENOENT";
  assert.match(humanizeSpawnError("codex", error), /"codex" was not found on PATH/i);
  assert.match(humanizeSpawnError("cua-driver", { code: "ENOENT", message: "spawn cua-driver ENOENT" }), /"cua-driver" was not found on PATH/i);
});

test("humanizeSpawnError maps a non-executable binary to a permissions message", () => {
  assert.match(humanizeSpawnError("cua-driver", { code: "EACCES", message: "spawn cua-driver EACCES" }), /not executable/i);
});

test("humanizeSpawnError maps an oversized command line to an actionable message", () => {
  // The prompt/args guards cap individual argv entries, but macOS caps the
  // whole argv+env block (ARG_MAX), so a large environment can still trigger
  // E2BIG; the message must point at the environment, not just the request.
  assert.match(
    humanizeSpawnError("codex", { code: "E2BIG", message: "spawn codex E2BIG" }),
    /too large for macOS \(E2BIG\)/i,
  );
  assert.match(humanizeSpawnError("codex", { code: "E2BIG", message: "spawn codex E2BIG" }), /environment/i);
});

test("humanizeSpawnError passes through other spawn errors", () => {
  assert.equal(humanizeSpawnError("codex", new Error("spawn codex EMFILE")), "spawn codex EMFILE");
});

test("accumulateOutput caps the buffer at maxChars and reports truncation", () => {
  // Truncation keeps the TAIL, not the head — the same convention as
  // truncateOutput: this buffer is what the model later receives as
  // function_call_output, and for a long run the actionable part (result,
  // error summary) is at the END.
  const over = accumulateOutput("", "A".repeat(60) + "B".repeat(40), 50);
  assert.equal(over.text.length, 50);
  assert.ok(over.text.endsWith("B".repeat(40)));
  assert.ok(!over.text.startsWith("A".repeat(50)));
  assert.equal(over.capped, true);
  // A buffer already at the cap keeps rolling to the newest tail: output that
  // arrives after the first overflow (the true end of a long run) must not be
  // discarded, or the model would miss the conclusion it needs.
  const full = accumulateOutput("x".repeat(50), "tail", 50);
  assert.equal(full.text, "x".repeat(46) + "tail");
  assert.equal(full.capped, true);
  // Small chunks pass through untouched while under the cap.
  const ok = accumulateOutput("abc", "def", 100);
  assert.equal(ok.text, "abcdef");
  assert.equal(ok.capped, false);
  // An empty chunk is a no-op and must not report a false truncation.
  const empty = accumulateOutput("abc", "", 100);
  assert.equal(empty.text, "abc");
  assert.equal(empty.capped, false);
});

test("createOutputAccumulator keeps the tail across many small chunks without flattening each time", () => {
  const acc = createOutputAccumulator(50);
  for (const ch of "A".repeat(60) + "B".repeat(40)) acc.push(ch);
  assert.equal(acc.length, 50);
  assert.equal(acc.capped, true);
  assert.equal(acc.text(), "A".repeat(10) + "B".repeat(40));
  // A single chunk larger than the cap keeps only its tail.
  const big = createOutputAccumulator(8);
  big.push("0123456789abcdef");
  assert.equal(big.text(), "89abcdef");
  assert.equal(big.capped, true);
});

test("createOutputAccumulator stays linear across thousands of tiny chunks", () => {
  // Without compacting, trim used Array.shift() on the chunk list — O(n) per
  // overflow byte, quadratic over a 1MB stream of 1-char writes. Compacting
  // into one string before slicing keeps this in linear time and bounded
  // memory. The public contract is unchanged: cap at maxChars, keep the tail.
  const acc = createOutputAccumulator(100);
  for (let i = 0; i < 10000; i++) acc.push(String(i % 10));
  assert.equal(acc.length, 100);
  assert.equal(acc.capped, true);
  const expectedTail = Array.from({ length: 100 }, (_, i) => String((9900 + i) % 10)).join("");
  assert.equal(acc.text(), expectedTail);
});

test("resolveWorkdir keeps paths inside the base workdir", () => {
  const base = path.join(path.sep, "Users", "alex", "projects", "app");
  assert.equal(resolveWorkdir(undefined, base), base);
  assert.equal(resolveWorkdir("", base), base);
  assert.equal(resolveWorkdir("  ", base), base);
  assert.equal(resolveWorkdir("sub/dir", base), path.join(base, "sub", "dir"));
  assert.equal(resolveWorkdir(path.join(base, "sub"), base), path.join(base, "sub"));
});

test("resolveWorkdir rejects traversal and outside absolute paths", () => {
  const base = path.join(path.sep, "Users", "alex", "projects", "app");
  assert.equal(resolveWorkdir("../outside", base), base);
  assert.equal(resolveWorkdir("../../etc", base), base);
  assert.equal(resolveWorkdir(path.join(path.sep, "etc", "passwd"), base), base);
  // A sibling prefix must not pass the containment check.
  assert.equal(resolveWorkdir(`${base}2`, base), base);
  assert.equal(resolveWorkdir(base, base), base);
});

test("resolveWorkdir resolves symlinks so an inside link to outside cannot escape", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cvb-workdir-"));
  const base = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(base);
  fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(base, "evil"), "dir");
  } catch {
    t.skip("symlinks not available on this platform");
    return;
  }
  try {
    // The link is lexically inside the workspace but points outside: the
    // real-path check must reject it instead of trusting the string prefix.
    assert.equal(resolveWorkdir(path.join(base, "evil"), base), base);
    assert.equal(resolveWorkdir(path.join(base, "evil", "sub"), base), base);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkdir allows a symlink that stays inside the workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cvb-workdir-"));
  const base = path.join(root, "workspace");
  const real = path.join(base, "real");
  fs.mkdirSync(real, { recursive: true });
  try {
    fs.symlinkSync(real, path.join(base, "alias"), "dir");
  } catch {
    t.skip("symlinks not available on this platform");
    return;
  }
  try {
    // The link resolves back inside the workspace, so it stays allowed and
    // the canonical (de-symlinked) path is returned.
    assert.equal(resolveWorkdir(path.join(base, "alias"), base), fs.realpathSync(real));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkdir admits children of a symlinked base", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cvb-workdir-"));
  const realBase = path.join(root, "real-base");
  fs.mkdirSync(realBase);
  const linkBase = path.join(root, "link-base");
  try {
    fs.symlinkSync(realBase, linkBase, "dir");
  } catch {
    t.skip("symlinks not available on this platform");
    return;
  }
  try {
    // The base itself is reached through a symlink (like macOS /tmp): a
    // child of the base must resolve under the real base and stay allowed.
    assert.equal(resolveWorkdir("sub", linkBase), path.join(fs.realpathSync(realBase), "sub"));
    // A non-existent outside path under a symlinked base is still rejected.
    assert.equal(resolveWorkdir(path.join(linkBase, "..", "elsewhere"), linkBase), linkBase);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseEnvFile parses KEY=VALUE lines, comments, blanks, and quoted values", () => {
  assert.deepEqual(
    parseEnvFile(`
      # full-line comment
      OPENAI_API_KEY=sk-test-123
      EMPTY=
      QUOTED="hello world"
      SINGLE='a=b'
      INLINE=sk-x-1 # trailing comment
      bad line
      =novalue
    `),
    {
      OPENAI_API_KEY: "sk-test-123",
      EMPTY: "",
      QUOTED: "hello world",
      SINGLE: "a=b",
      INLINE: "sk-x-1",
    },
  );
  assert.deepEqual(parseEnvFile(""), {});
  assert.deepEqual(parseEnvFile(null), {});
  assert.deepEqual(parseEnvFile(42), {});
});

test("parseEnvFile keeps '#' inside unquoted values without preceding whitespace", () => {
  assert.deepEqual(parseEnvFile("KEY=sk-x#note\nQUOTED=\"a # b\""), { KEY: "sk-x#note", QUOTED: "a # b" });
});

test("parseEnvFile strips inline comments after quoted values", () => {
  assert.deepEqual(parseEnvFile('QUOTED="hello world" # trailing comment'), { QUOTED: "hello world" });
  assert.deepEqual(parseEnvFile("SINGLE='a=b' # comment"), { SINGLE: "a=b" });
  // A stray quote with non-comment text after it keeps the raw value.
  assert.deepEqual(parseEnvFile('KEY="a"b'), { KEY: '"a"b' });
});

test("parseEnvFile handles escaped quotes and backslashes in double-quoted values", () => {
  // A naive first-closing-quote scan would stop at the escaped quote and keep
  // the raw `"a\"b"` (quotes included), silently corrupting the value.
  assert.deepEqual(parseEnvFile('KEY="a\\"b"'), { KEY: 'a"b' });
  assert.deepEqual(parseEnvFile('KEY="quote\\"" # comment'), { KEY: 'quote"' });
  assert.deepEqual(parseEnvFile('KEY="a\\\\b"'), { KEY: "a\\b" });
  // dotenv-style \n, \r, \t escapes are unescaped inside double quotes.
  assert.deepEqual(parseEnvFile('KEY="line1\\nline2"'), { KEY: "line1\nline2" });
  // An escaped quote at the very end does not leave the value unterminated.
  assert.deepEqual(parseEnvFile('KEY="a\\"'), { KEY: '"a\\"' });
  // Single-quoted values stay literal: no escape processing, matching dotenv.
  assert.deepEqual(parseEnvFile("KEY='a\\'b'"), { KEY: "'a\\'b'" });
});

test("parseEnvFile accepts the shell-style export prefix", () => {
  assert.deepEqual(
    parseEnvFile("export OPENAI_API_KEY=sk-test-123\nexport QUOTED='a=b' # comment\nexport UNQUOTED=val # trailing"),
    { OPENAI_API_KEY: "sk-test-123", QUOTED: "a=b", UNQUOTED: "val" },
  );
  // A key literally named "export" or "exported" is not treated as a prefix.
  assert.deepEqual(parseEnvFile("export=1\nexported=2"), { export: "1", exported: "2" });
});

test("applyEnvOverrides never overrides existing environment variables", () => {
  const env = { EXISTING: "keep" };
  applyEnvOverrides({ EXISTING: "new", NEW: "added" }, env);
  assert.equal(env.EXISTING, "keep");
  assert.equal(env.NEW, "added");
});

test("toPositiveInt accepts positive integers and falls back otherwise", () => {
  assert.equal(toPositiveInt("120000", 60000), 120000);
  assert.equal(toPositiveInt("abc", 60000), 60000);
  assert.equal(toPositiveInt("0", 60000), 60000);
  assert.equal(toPositiveInt("-5", 60000), 60000);
  assert.equal(toPositiveInt("1.5", 60000), 60000);
  assert.equal(toPositiveInt("", 60000), 60000);
  assert.equal(toPositiveInt(undefined, 60000), 60000);
});

test("hasVirtualAudioDevice matches BlackHole, Loopback, and virtual labels", () => {
  assert.equal(hasVirtualAudioDevice([{ label: "MacBook Pro Microphone" }]), false);
  assert.equal(hasVirtualAudioDevice([{ label: "BlackHole 2ch" }]), true);
  assert.equal(hasVirtualAudioDevice([{ label: "Loopback Audio" }]), true);
  assert.equal(hasVirtualAudioDevice([{ label: "Virtual Cable" }]), true);
  assert.equal(hasVirtualAudioDevice([]), false);
});

test("hasVirtualAudioDevice tolerates non-array input", () => {
  assert.equal(hasVirtualAudioDevice(null), false);
  assert.equal(hasVirtualAudioDevice(undefined), false);
  assert.equal(hasVirtualAudioDevice("BlackHole"), false);
  assert.equal(hasVirtualAudioDevice({ label: "BlackHole 2ch" }), false);
});

test("captionDisplayText reuses the string when trim would be a no-op", () => {
  const spoken = "Hello from the live caption";
  assert.equal(captionDisplayText(spoken), spoken);
  assert.ok(captionDisplayText(spoken) === spoken);
  assert.equal(captionDisplayText(""), "...");
  assert.equal(captionDisplayText("   "), "...");
  assert.equal(captionDisplayText("  padded  "), "padded");
  assert.equal(captionDisplayText("\nline\n"), "line");
});

test("createDebugLogBuffer joins newest-first without shifting the line array", () => {
  const buf = createDebugLogBuffer(100);
  buf.push("old\n");
  buf.push("mid\n");
  buf.push("new\n");
  assert.equal(buf.joinNewestFirst(), "new\nmid\nold\n");
  assert.equal(buf.length, 12);
});

test("createDebugLogBuffer drops oldest lines when over the char cap", () => {
  const buf = createDebugLogBuffer(10);
  buf.push("aaaa\n");
  buf.push("bbbb\n");
  buf.push("cccc\n");
  assert.equal(buf.joinNewestFirst(), "cccc\nbbbb\n");
  assert.equal(buf.length, 10);
});

test("createDebugLogBuffer keeps the head of a single oversized line", () => {
  const buf = createDebugLogBuffer(8);
  buf.push("HEAD....TAIL");
  assert.equal(buf.joinNewestFirst(), "HEAD....");
  assert.equal(buf.length, 8);
});

test("createDebugLogBuffer compact of dropped prefixes keeps newest-first order", () => {
  const buf = createDebugLogBuffer(15);
  for (let i = 0; i < 40; i++) buf.push(`${String(i).padStart(2, "0")}\n`);
  assert.equal(buf.joinNewestFirst(), "39\n38\n37\n36\n35\n");
  assert.equal(buf.length, 15);
});

test("sameMediaDeviceList is true only when id, kind, and label match in order", () => {
  const mic = { deviceId: "mic-1", kind: "audioinput", label: "Built-in Microphone" };
  const out = { deviceId: "out-1", kind: "audiooutput", label: "Speakers" };
  assert.equal(sameMediaDeviceList([mic, out], [mic, out]), true);
  assert.equal(sameMediaDeviceList([mic, out], [{ ...mic }, { ...out }]), true);
  assert.equal(sameMediaDeviceList([mic], [mic, out]), false);
  assert.equal(sameMediaDeviceList([mic, out], [out, mic]), false);
  assert.equal(sameMediaDeviceList([mic], [{ ...mic, label: "USB Mic" }]), false);
  assert.equal(sameMediaDeviceList([mic], [{ ...mic, deviceId: "mic-2" }]), false);
  assert.equal(sameMediaDeviceList(null, [mic]), false);
  assert.equal(sameMediaDeviceList([], []), true);
});

test("rotateLogIfNeeded ignores a missing log file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-voice-bridge-log-"));
  const logFile = path.join(dir, "bridge.log");
  assert.equal(rotateLogIfNeeded(fs, logFile, 16), false);
  assert.equal(fs.existsSync(logFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotateLogIfNeeded keeps a small log file in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-voice-bridge-log-"));
  const logFile = path.join(dir, "bridge.log");
  fs.writeFileSync(logFile, "small");
  assert.equal(rotateLogIfNeeded(fs, logFile, 16), false);
  assert.equal(fs.readFileSync(logFile, "utf8"), "small");
  assert.equal(fs.existsSync(`${logFile}.1`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotateLogIfNeeded keeps only the previous oversized file as .1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-voice-bridge-log-"));
  const logFile = path.join(dir, "bridge.log");
  fs.writeFileSync(`${logFile}.1`, "older");
  fs.writeFileSync(logFile, "current-oversize");
  assert.equal(rotateLogIfNeeded(fs, logFile, 8), true);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.readFileSync(`${logFile}.1`, "utf8"), "current-oversize");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extractFirstJsonObject finds the first JSON object amid log noise", () => {
  assert.deepEqual(extractFirstJsonObject('{"apps":[]}'), { apps: [] });
  assert.deepEqual(extractFirstJsonObject('2026-08-13 23:00:00 INFO starting\n{"apps":[{"pid":1,"active":true}]}'), {
    apps: [{ pid: 1, active: true }],
  });
  // Braces inside strings must not confuse the brace matcher.
  assert.deepEqual(extractFirstJsonObject('{"a":"{not json}","b":1}'), { a: "{not json}", b: 1 });
  // Nested objects and arrays still match to the correct closing brace.
  assert.deepEqual(extractFirstJsonObject('{"apps":[{"nested":{"x":1}}],"ok":true}'), {
    apps: [{ nested: { x: 1 } }],
    ok: true,
  });
});

test("extractFirstJsonObject returns null for non-JSON or non-string input", () => {
  assert.equal(extractFirstJsonObject("no json here"), null);
  assert.equal(extractFirstJsonObject(""), null);
  assert.equal(extractFirstJsonObject("{\"unterminated"), null);
  assert.equal(extractFirstJsonObject(null), null);
  assert.equal(extractFirstJsonObject(undefined), null);
  assert.equal(extractFirstJsonObject(42), null);
});
test("extractFirstJsonObject bails out in linear time on a barrage of unclosed braces", () => {
  // A window title full of '{' (text the model typed into an app, surfaced by
  // cua-driver's list_apps stdout) would make every '{' start a fresh O(n)
  // inner scan — O(n²) over the 1MB output cap would freeze the main process
  // for minutes. The bounded scan must return null quickly: with the fix this
  // is microseconds; the unbounded version takes tens of seconds.
  const barrage = "{".repeat(200000);
  const started = Date.now();
  assert.equal(extractFirstJsonObject(barrage), null);
  assert.ok(Date.now() - started < 2000, "a brace barrage must not stall the scanner");
});
test("extractFirstJsonObject still finds a real object after an unterminated candidate", () => {
  // The scan budget must not break legitimate output: a stray unclosed brace
  // (log noise) before the real JSON payload must still find the payload.
  assert.deepEqual(extractFirstJsonObject('{"log":"unterminated\n{"apps":[{"pid":1,"active":true}]}'), {
    apps: [{ pid: 1, active: true }],
  });
});

test("typeDelayMs scales the per-character delay so long texts fit the timeout", () => {
  assert.equal(typeDelayMs(0), 20);
  assert.equal(typeDelayMs(10), 20);
  assert.equal(typeDelayMs(100), 20);
  // 48s budget / 2400 chars = 20ms exactly.
  assert.equal(typeDelayMs(2400), 20);
  // Longer texts scale down proportionally.
  assert.equal(typeDelayMs(4800), 10);
  assert.equal(typeDelayMs(9600), 5);
  // Never below 1ms, whatever the length.
  assert.equal(typeDelayMs(1e9), 1);
  // Custom budget/max.
  assert.equal(typeDelayMs(100, 10, 1000), 10);
  assert.equal(typeDelayMs(500, 10, 1000), 2);
});

test("requireTypeableLength rejects texts that cannot fit the typing budget", () => {
  // At the 1ms/char floor, anything at or under the budget fits.
  assert.equal(requireTypeableLength(0), null);
  assert.equal(requireTypeableLength(48000), null);
  // Longer than the budget is a guaranteed timeout at 1ms/char.
  assert.match(requireTypeableLength(48001), /too long to type within the driver timeout/);
  assert.match(requireTypeableLength(1e9), /max 48000 characters/);
  // Non-finite lengths are not the caller's problem (type checks elsewhere).
  assert.equal(requireTypeableLength(undefined), null);
  assert.equal(requireTypeableLength(NaN), null);
  // Custom budget.
  assert.equal(requireTypeableLength(1000, 1000), null);
  assert.match(requireTypeableLength(1001, 1000), /max 1000 characters/);
});
