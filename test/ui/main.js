// Isolated harness entrypoint. NEVER imported by the production app.
import { app, BrowserWindow, ipcMain, session } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationRegistry } from "../../src/operations.js";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-bridge-ui-no-secrets-"));
app.setPath("userData", directory);
app.setPath("sessionData", directory);
const operations = createOperationRegistry();
const pendingTokens = new Map();
let behavior = {},
  calls = [],
  key = false;
globalThis.harness = {
  configure(value) {
    behavior = value;
    calls = [];
  },
  calls() {
    return calls;
  },
  pendingTokens: () => pendingTokens.size,
  activeSessions: () => operations.size,
  releaseTokens() {
    for (const resolve of pendingTokens.values()) resolve();
  },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
ipcMain.handle("harness:behavior", (_event, value) => {
  behavior = value;
  calls = [];
});
ipcMain.handle("harness:calls", () => calls);
ipcMain.handle("app:config", () => ({
  version: "mock",
  model: "mock-realtime",
  translateModel: "mock-translate",
  transcribeModel: "mock-transcribe",
  voice: "marin",
  actionTimeoutMs: 1200,
  openaiTimeoutMs: behavior.openaiTimeoutMs ?? 60000,
}));
ipcMain.handle("app:capabilities", () => ({
  microphone: "mock-granted",
  accessibility: "not-granted",
  codex: { available: false },
  cua: { available: false },
  screenAudio: "Mock audio only. No permissions requested.",
}));
ipcMain.handle("realtime:key-status", () => ({ hasRuntimeKey: true }));
ipcMain.handle("realtime:set-api-key", (_event, value) => {
  key = Boolean(value);
  return { ok: key, saved: false, error: "Test key is memory-only." };
});
ipcMain.handle("session:begin", (event, input) => operations.begin(event.sender, input.sessionId));
ipcMain.handle("session:cancel", (event, input) => operations.cancel(event.sender, input.sessionId));
ipcMain.handle("realtime:create-client-secret", async (event, input) => {
  const result = await operations.run(event.sender, input, async (context) => {
    calls.push({ kind: "token", requestId: input.requestId, sessionId: input.sessionId });
    if (behavior.tokenError) throw new Error(behavior.tokenError);
    if (behavior.holdToken) {
      await new Promise((resolve) => pendingTokens.set(input.requestId, resolve));
      pendingTokens.delete(input.requestId);
    }
    if (behavior.tokenDelay)
      await Promise.race([
        sleep(behavior.tokenDelay),
        new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true })),
      ]);
    return { value: "mock-ephemeral", callEndpoint: "https://api.openai.com/v1/realtime/calls" };
  });
  calls.push({ kind: "token-settled", requestId: input.requestId, cancelled: result.code === -95 });
  return result;
});
for (const channel of ["codex:run", "cua:run", "mac:run"])
  ipcMain.handle(channel, (event, input) =>
    operations.run(
      event.sender,
      input,
      async (context) => {
        calls.push({ kind: channel, requestId: input.requestId, sessionId: input.sessionId });
        if (behavior.actionDelay) await sleep(behavior.actionDelay);
        context.output("mock output");
        return { ok: true, code: 0, stdout: "mock finished", stderr: "" };
      },
      { queued: true },
    ),
  );
ipcMain.handle("log:renderer", () => ({ ok: true }));
ipcMain.handle("log:path", () => "isolated-harness-no-log-file");
app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  const window = new BrowserWindow({
    width: 520,
    height: 980,
    show: true,
    webPreferences: {
      preload: fileURLToPath(new URL("../../src/preload.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.on("hide", () => window.webContents.send("app:visibility", false));
  window.on("show", () => window.webContents.send("app:visibility", true));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.once("destroyed", () => operations.destroy(window.webContents));
  await window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  operations.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
});
