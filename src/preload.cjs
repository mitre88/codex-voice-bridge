const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceBridge", {
  config: () => ipcRenderer.invoke("app:config"),
  keyStatus: () => ipcRenderer.invoke("realtime:key-status"),
  setApiKey: (apiKey) => ipcRenderer.invoke("realtime:set-api-key", apiKey),
  createClientSecret: (options) => ipcRenderer.invoke("realtime:create-client-secret", options),
  runCodex: (input) => ipcRenderer.invoke("codex:run", input),
  runCua: (input) => ipcRenderer.invoke("cua:run", input),
  runMac: (input) => ipcRenderer.invoke("mac:run", input),
  log: (message, data) => {
    // Fire-and-forget: invoke() waited for a round-trip on every UI log line
    // (including batched Codex output). The renderer only needs the write to
    // be queued; returning a resolved promise keeps the .catch() guards on
    // the window error handlers valid.
    ipcRenderer.send("log:renderer", message, data);
    return Promise.resolve({ ok: true });
  },
  logPath: () => ipcRenderer.invoke("log:path"),
  onCodexOutput: (callback) => {
    // Replace, do not stack: a second subscribe (dev reload, or a future
    // caller) would otherwise deliver every Codex chunk twice and grow the
    // renderer log twice as fast.
    ipcRenderer.removeAllListeners("codex-output");
    ipcRenderer.on("codex-output", (_event, chunk) => callback(chunk));
  },
});
