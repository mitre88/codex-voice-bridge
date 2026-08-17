import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accumulateOutput,
  applyEnvOverrides,
  escapeAppleScript,
  extractFirstJsonObject,
  typeDelayMs,
  hasVirtualAudioDevice,
  humanizeError,
  humanizeSpawnError,
  isPlausibleApiKey,
  isSafeAppIdentity,
  isSafeCuaLaunchArgs,
  isSafeCuaToolName,
  isSafeLaunchUrl,
  isSdpAnswer,
  normalizeCuaArgs,
  normalizeReasoningEffort,
  normalizeTone,
  parseEnvFile,
  redactSecrets,
  requireMaxLength,
  requireNonEmptyString,
  requireTypeableLength,
  resolveAppIdentity,
  resolveOpenAppTarget,
  resolveWorkdir,
  rotateLogIfNeeded,
  toPositiveInt,
  truncateOutput,
} from "../src/lib.js";

test("normalizeReasoningEffort accepts known values and falls back", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeReasoningEffort("bogus"), "low");
  assert.equal(normalizeReasoningEffort("bogus", "medium"), "medium");
});

test("normalizeTone maps known tones and defaults to calm", () => {
  assert.match(normalizeTone("direct"), /direct/);
  assert.match(normalizeTone("energetic"), /upbeat/);
  assert.match(normalizeTone("unknown"), /calm/);
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
  const out = truncateOutput({ ok: true, code: 0, stdout: "x".repeat(100), stderr: "" }, 50);
  assert.ok(out.stdout.includes("[truncated 50 chars]"));
  assert.equal(out.ok, true);
  assert.equal(out.code, 0);
  assert.equal(out.stderr, "");
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
  const over = accumulateOutput("", "x".repeat(100), 50);
  assert.equal(over.text.length, 50);
  assert.equal(over.capped, true);
  // A buffer already at the cap stays put and keeps reporting truncation.
  const full = accumulateOutput("x".repeat(50), "more", 50);
  assert.equal(full.text, "x".repeat(50));
  assert.equal(full.capped, true);
  // Small chunks pass through untouched while under the cap.
  const ok = accumulateOutput("abc", "def", 100);
  assert.equal(ok.text, "abcdef");
  assert.equal(ok.capped, false);
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
