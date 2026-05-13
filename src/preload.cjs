const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceBridge", {
  config: () => ipcRenderer.invoke("app:config"),
  keyStatus: () => ipcRenderer.invoke("realtime:key-status"),
  setApiKey: (apiKey) => ipcRenderer.invoke("realtime:set-api-key", apiKey),
  createClientSecret: (options) => ipcRenderer.invoke("realtime:create-client-secret", options),
  runCodex: (input) => ipcRenderer.invoke("codex:run", input),
  runCua: (input) => ipcRenderer.invoke("cua:run", input),
  runMac: (input) => ipcRenderer.invoke("mac:run", input),
  log: (message, data) => ipcRenderer.invoke("log:renderer", message, data),
  logPath: () => ipcRenderer.invoke("log:path"),
  onCodexOutput: (callback) => {
    ipcRenderer.on("codex-output", (_event, chunk) => callback(chunk));
  },
});
