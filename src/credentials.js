import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPlausibleApiKey } from "./lib.js";

const WARNING =
  "The saved key is unavailable. Unlock your login Keychain and restart, or enter a key to replace it. No plaintext fallback is used.";
const SAVE_WARNING =
  "The key works in memory for this launch, but could not be saved securely. Unlock your login Keychain and save it again.";
const validKey = (value) =>
  isPlausibleApiKey(value) &&
  value.length <= 4096 &&
  ![...value].some((char) => char.charCodeAt(0) <= 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));

// Construct only after app.whenReady(). Tests inject fake safeStorage and a
// temporary directory; importing this module never touches a real Keychain.
export function createCredentialStore({
  userData,
  safeStorage,
  readLegacy,
  envKey = "",
  development = false,
  io = fs,
  platform = process.platform,
}) {
  const directory = path.join(userData, development ? "credentials-dev" : "credentials");
  const file = path.join(directory, "openai-api-key.v1.enc");
  let runtime = "",
    saved = "",
    legacy = "",
    warning = "";
  let generation = 0,
    loaded = false;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function available() {
    if (platform !== "darwin") throw new Error("Secure persistence is supported only on macOS.");
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("Secure storage unavailable.");
  }
  async function decrypt(bytes) {
    await available();
    // Electron 44 returns { result, shouldReEncrypt }; temporary failures reject.
    const result = await safeStorage.decryptStringAsync(bytes);
    if (!validKey(result?.result)) throw new Error("Invalid encrypted credential.");
    return result;
  }
  async function writeVerified(key, expectedGeneration) {
    let temporary;
    try {
      await available();
      const ciphertext = await safeStorage.encryptStringAsync(key);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error("Invalid ciphertext.");
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await io.lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new Error("Unsafe credential directory.");
      await io.chmod(directory, 0o700);
      temporary = path.join(directory, `.${randomUUID()}.tmp`);
      const handle = await io.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(ciphertext);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const verified = await decrypt(await io.readFile(temporary));
      if (verified.result !== key) throw new Error("Credential verification failed.");
      // A newer manually-entered key may arrive while encryption/readback waits.
      if (generation !== expectedGeneration) return false;
      await io.rename(temporary, file);
      temporary = undefined;
      // Flush the directory entry after the atomic replacement. A failure is
      // reported honestly (the verified replacement may already be committed).
      const dirHandle = await io.open(directory, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
      saved = key;
      warning = "";
      return true;
    } catch {
      warning = SAVE_WARNING;
      return false;
    } finally {
      if (temporary) await io.unlink(temporary).catch(() => {});
    }
  }
  async function load() {
    if (loaded) return;
    loaded = true;
    const before = generation;
    let bytes;
    try {
      const info = await io.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("Unsafe credential file.");
      bytes = await io.readFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") {
        warning = WARNING;
        return;
      }
      // Development never reads/migrates the production generic-password item.
      if (!development && readLegacy) {
        try {
          const value = (await readLegacy()).trim();
          if (validKey(value)) legacy = value;
        } catch {
          /* Optional one-time legacy lookup. */
        }
        if (legacy && generation === before) await writeVerified(legacy, before);
      }
      return;
    }
    try {
      const decoded = await decrypt(bytes);
      saved = decoded.result;
      if (decoded.shouldReEncrypt && generation === before) await writeVerified(saved, before);
    } catch {
      warning = WARNING;
    }
  }
  function setKey(value) {
    const key = typeof value === "string" ? value.trim() : "";
    if (!validKey(key))
      return Promise.resolve({ ok: false, saved: false, error: "The API key format does not look valid." });
    runtime = key;
    const revision = ++generation;
    return serialize(async () => {
      // No prerequisite read or migration: an explicit replacement repairs a
      // corrupt file without accidentally reviving a stale legacy credential.
      const stored = await writeVerified(key, revision);
      loaded = true;
      return { ok: true, saved: stored, error: stored ? "" : SAVE_WARNING };
    });
  }
  const environment = typeof envKey === "string" && validKey(envKey.trim()) ? envKey.trim() : "";
  return {
    file,
    setKey,
    resolveKey: () =>
      serialize(async () => {
        await load();
        return runtime || saved || legacy || environment;
      }),
    status: () =>
      serialize(async () => {
        await load();
        return {
          hasRuntimeKey: Boolean(runtime),
          hasSavedKey: Boolean(saved),
          hasLegacyKey: Boolean(legacy),
          hasEnvKey: Boolean(environment),
          warning,
        };
      }),
    settled: () => queue,
  };
}
