const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld("voiceBridge", {
  config: () => ipcRenderer.invoke("app:config"),
  getCapabilities: () => ipcRenderer.invoke("app:capabilities"),
  beginSession: (sessionId) => ipcRenderer.invoke("session:begin", { sessionId }),
  cancelSession: (sessionId) => ipcRenderer.invoke("session:cancel", { sessionId }),
  keyStatus: () => ipcRenderer.invoke("realtime:key-status"),
  setApiKey: (apiKey) => ipcRenderer.invoke("realtime:set-api-key", apiKey),
  createClientSecret: (options) => ipcRenderer.invoke("realtime:create-client-secret", options),
  runCodex: (input) => ipcRenderer.invoke("codex:run", input),
  runCua: (input) => ipcRenderer.invoke("cua:run", input),
  runMac: (input) => ipcRenderer.invoke("mac:run", input),
  log: (message, data) => ipcRenderer.invoke("log:renderer", message, data),
  logPath: () => ipcRenderer.invoke("log:path"),
  onCodexOutput: (callback) => subscribe("codex-output", callback),
  onVisibility: (callback) => subscribe("app:visibility", callback),
});
