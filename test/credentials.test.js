import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCredentialStore } from "../src/credentials.js";
const key = "sk-proj-fake-test-only-a",
  next = "sk-proj-fake-test-only-b";
function storage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => Buffer.from(`cipher:${s}`),
    decryptStringAsync: async (b) => {
      const s = b.toString();
      if (!s.startsWith("cipher:")) throw new Error("bad ciphertext");
      return { result: s.slice(7), shouldReEncrypt: false };
    },
  };
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-fake-storage-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const create = (o = {}) =>
    createCredentialStore({
      userData: dir,
      platform: "darwin",
      safeStorage: storage(),
      readLegacy: async () => "",
      envKey: "",
      ...options,
      ...o,
    });
  return { dir, create, store: create() };
}
test("initial save, update and restart decrypt the verified value with private modes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.setKey(key)).saved, true);
  assert.equal((await f.store.setKey(next)).saved, true);
  assert.equal(await f.create().resolveKey(), next);
  const file = f.store.file;
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(await f.store.status()), /sk-proj/);
});
test("encryption failure keeps old file and new typed key in memory, saved false", async (t) => {
  const f = await fixture(t);
  await f.store.setKey(key);
  const broken = f.create({
    safeStorage: {
      ...storage(),
      encryptStringAsync: async () => {
        throw new Error(next);
      },
    },
  });
  const result = await broken.setKey(next);
  assert.equal(result.saved, false);
  assert.equal(await broken.resolveKey(), next);
  assert.equal(await f.create().resolveKey(), key);
  assert.doesNotMatch(JSON.stringify(result), /sk-proj/);
});
test("integrity mismatch cannot replace a good saved credential", async (t) => {
  const f = await fixture(t);
  await f.store.setKey(key);
  const broken = f.create({
    safeStorage: { ...storage(), decryptStringAsync: async () => ({ result: "wrong", shouldReEncrypt: false }) },
  });
  assert.equal((await broken.setKey(next)).saved, false);
  assert.equal(await f.create().resolveKey(), key);
});
test("corrupt or locked existing file never resurrects legacy; environment is not persisted", async (t) => {
  let legacyReads = 0;
  const f = await fixture(t, {
    readLegacy: async () => {
      legacyReads++;
      return key;
    },
    envKey: next,
  });
  await fs.mkdir(path.dirname(f.store.file), { recursive: true });
  await fs.writeFile(f.store.file, "broken");
  assert.equal(await f.store.resolveKey(), next);
  assert.equal(legacyReads, 0);
  assert.match((await f.store.status()).warning, /saved key/i);
  assert.equal(await fs.readFile(f.store.file, "utf8"), "broken");
});
test("legacy absent-file migration reads once, validates and preserves original record", async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    readLegacy: async () => {
      reads++;
      return key;
    },
  });
  assert.equal(await f.store.resolveKey(), key);
  assert.equal((await f.store.status()).hasSavedKey, true);
  assert.equal(await f.store.resolveKey(), key);
  assert.equal(reads, 1);
});
test("literal -U and malformed legacy credentials are never used or migrated", async (t) => {
  for (const legacy of ["-U", "garbage", "sk- a"]) {
    const f = await fixture(t, { readLegacy: async () => legacy, envKey: next });
    assert.equal(await f.store.resolveKey(), next);
    await assert.rejects(fs.stat(f.store.file), { code: "ENOENT" });
  }
});
test("manual save supersedes a pending legacy read without stale migration", async (t) => {
  let release, entered;
  const started = new Promise((r) => (entered = r));
  const f = await fixture(t, {
    readLegacy: () =>
      new Promise((r) => {
        release = r;
        entered();
      }),
  });
  const pending = f.store.resolveKey();
  await started;
  const manual = f.store.setKey(next);
  release(key);
  await pending;
  await manual;
  assert.equal(await f.create().resolveKey(), next);
});
test("development storage stays isolated and never reads production legacy", async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    development: true,
    readLegacy: async () => {
      reads++;
      return key;
    },
  });
  assert.match(f.store.file, /credentials-dev/);
  assert.equal(await f.store.resolveKey(), "");
  assert.equal(reads, 0);
});

test("unavailable async storage uses memory only and never writes plaintext", async (t) => {
  const f = await fixture(t, { safeStorage: { ...storage(), isAsyncEncryptionAvailable: async () => false } });
  const result = await f.store.setKey(key);
  assert.equal(result.saved, false);
  assert.equal(await f.store.resolveKey(), key);
  await assert.rejects(fs.stat(f.store.file), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify(await f.store.status()), /sk-proj/);
});

test("precommit file flush failure preserves the previous ciphertext", async (t) => {
  const f = await fixture(t);
  await f.store.setKey(key);
  const before = await fs.readFile(f.store.file);
  const broken = f.create({
    io: {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (args[1] === "wx")
          handle.sync = async () => {
            throw new Error("injected fsync failure");
          };
        return handle;
      },
    },
  });
  assert.equal((await broken.setKey(next)).saved, false);
  assert.deepEqual(await fs.readFile(f.store.file), before);
  assert.equal(await f.create().resolveKey(), key);
});

test("a pending re-encryption cannot overwrite a later manual save", async (t) => {
  const f = await fixture(t);
  await f.store.setKey(key);
  let begin,
    release,
    encryptions = 0;
  const started = new Promise((resolve) => (begin = resolve));
  const rotating = f.create({
    safeStorage: {
      ...storage(),
      decryptStringAsync: async (bytes) => ({ result: bytes.toString().slice(7), shouldReEncrypt: true }),
      encryptStringAsync: async (value) => {
        if (++encryptions === 1) {
          begin();
          await new Promise((resolve) => (release = resolve));
        }
        return Buffer.from(`cipher:${value}`);
      },
    },
  });
  const loading = rotating.resolveKey();
  await started;
  const manual = rotating.setKey(next);
  release();
  await loading;
  assert.equal((await manual).saved, true);
  assert.equal(await f.create().resolveKey(), next);
});
