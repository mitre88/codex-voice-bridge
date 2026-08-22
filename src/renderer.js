import { hasVirtualAudioDevice, humanizeError, isApiKeyRejection, isSdpAnswer, sameMediaDeviceList, truncateOutput } from "./renderer-utils.js";

// How long the Realtime SDP exchange may take before we give up. The main
// process already times out the token fetch; this bounds the second network
// hop so a hung connection cannot leave the UI stuck on "Connecting" forever.
// Defaults to 60s, then follows the main process's configured
// CODEX_VOICE_OPENAI_TIMEOUT_MS (delivered via app:config) so that env var
// governs every OpenAI HTTP hop, not just the token fetch.
let openaiCallTimeoutMs = 60000;

const INTERVIEW_SETUP_TEXT =
  "Route English to BlackHole/Loopback, then select that device as the meeting microphone.";
const INTERVIEW_VIRTUAL_AUDIO_WARNING =
  "Warning: no BlackHole, Loopback, or virtual audio device found. English can still play through speakers, but the meeting will only hear it if your microphone picks up that output.";

const statusEl = document.querySelector("#status");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const runCodexButton = document.querySelector("#runCodex");
const rejectCodexButton = document.querySelector("#rejectCodex");
const apiKeyInput = document.querySelector("#apiKey");
const apiKeyField = document.querySelector("#apiKeyField");
const keyStatusEl = document.querySelector("#keyStatus");
const autoRunInput = document.querySelector("#autoRun");
const voiceModeInput = document.querySelector("#voiceMode");
const toneInput = document.querySelector("#tone");
const reasoningInput = document.querySelector("#reasoningEffort");
const targetLanguageInput = document.querySelector("#targetLanguage");
const sourceLanguageInput = document.querySelector("#sourceLanguage");
const myMicDeviceInput = document.querySelector("#myMicDevice");
const interviewerInputMode = document.querySelector("#interviewerInputMode");
const interviewerDeviceField = document.querySelector("#interviewerDeviceField");
const interviewerAudioDeviceInput = document.querySelector("#interviewerAudioDevice");
const spanishOutputDeviceInput = document.querySelector("#spanishOutputDevice");
const englishOutputDeviceInput = document.querySelector("#englishOutputDevice");
const assistantOptions = document.querySelectorAll(".assistant-option");
const translateOptions = document.querySelectorAll(".translate-option");
const transcribeOptions = document.querySelectorAll(".transcribe-option");
const interviewOptions = document.querySelectorAll(".interview-option");
const captionPanel = document.querySelector("#captionPanel");
const sourceCaptionLabel = document.querySelector("#sourceCaptionLabel");
const outputCaptionLabel = document.querySelector("#outputCaptionLabel");
const sourceCaptionEl = document.querySelector("#sourceCaption");
const outputCaptionEl = document.querySelector("#outputCaption");
const pendingPanel = document.querySelector("#pendingPanel");
const pendingPromptEl = document.querySelector("#pendingPrompt");
const logEl = document.querySelector("#log");
const debugPanel = logEl?.closest("details");
const configEl = document.querySelector("#config");

const activeSessions = [];
const handledToolCalls = new Set();
// Two parallel run_codex calls (parallel tool use) would spawn two read-only
// Codex processes fighting over the same repo (git index locks, CPU). Queue
// them so one runs at a time; cua/mac actions stay parallel — they are quick
// and independent. A rejected run never blocks the queue.
let codexRunQueue = Promise.resolve();
function enqueueCodexRun(args) {
  const run = codexRunQueue.then(() => getBridge().runCodex(args));
  codexRunQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
let pendingAction;
let pendingActionTimer;
let actionTimeoutMs = 120000;
let actionDataChannel;
// Aborted by disconnectRealtime() while a connect is still in flight so a
// Disconnect press mid-"Connecting" tears down the pending session instead of
// letting it come up afterwards with a live microphone. Recreated on each
// connect; aborting a finished connect's controller is a harmless no-op.
let connectAbortController;
let hasStoredKey = false;
let sourceCaption = "";
let outputCaption = "";
// Transcript deltas arrive many times per second. Concatenating into the
// growing caption string on every delta copies up to 50KB per event; keep
// parts here and join once per animation frame (and once if we hit the cap).
const sourceBucket = { parts: [], length: 0 };
const outputBucket = { parts: [], length: 0 };
let baseConfigText = "";
let lastMediaDevices = [];
let warnedMissingVirtualAudio = false;
// Set while the last refresh had to fall back to the default because a
// previously selected device disappeared; cleared by the first refresh that
// finds every selection intact again (see refreshMediaDevices).
let warnedDeviceFallback = false;

// Every control captured by getVoiceOptions() at connect time. Changing any
// of them mid-session has no effect on the running Realtime session and
// would mislead the user into thinking it did, so all of them are locked
// while connected (not just the mode select).
const connectTimeControls = [
  voiceModeInput,
  toneInput,
  reasoningInput,
  targetLanguageInput,
  sourceLanguageInput,
  myMicDeviceInput,
  interviewerInputMode,
  interviewerAudioDeviceInput,
  spanishOutputDeviceInput,
  englishOutputDeviceInput,
];

function setConnectControlsLocked(locked) {
  connectTimeControls.forEach((control) => {
    control.disabled = locked;
  });
}

function getBridge() {
  if (!window.voiceBridge) throw new Error("Electron preload bridge is unavailable.");
  return window.voiceBridge;
}

function tryBridge() {
  return window.voiceBridge;
}

window.addEventListener("error", (event) => {
  tryBridge()?.log("window.error", { message: event.message, filename: event.filename, lineno: event.lineno }).catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  tryBridge()?.log("window.unhandledrejection", { reason: String(event.reason), stack: event.reason?.stack }).catch(() => {});
});

function setStatus(text, state) {
  statusEl.textContent = text;
  document.body.dataset.state = state || text.toLowerCase().replace(/\s+/g, "-");
}

const logLines = [];
let logChars = 0;
let logBuffer = "";

function joinLogLines() {
  return logLines.join("");
}

function pushLogLine(line) {
  logLines.unshift(line);
  logChars += line.length;
  while (logChars > 50000 && logLines.length > 1) {
    logChars -= logLines.pop().length;
  }
  if (logChars > 50000 && logLines.length === 1) {
    logLines[0] = logLines[0].slice(0, 50000);
    logChars = logLines[0].length;
  }
}

function log(message, data) {
  // Serialize defensively: log() runs inside the window error/unhandled
  // rejection handlers too, and a non-serializable payload (a circular
  // reason object, a throwing toJSON, a BigInt) would make JSON.stringify
  // throw *inside* the error handler — the new throw then triggers the same
  // handler again, and the renderer loops forever logging a log failure.
  // main.js writeLog already guards its own stringify for exactly this
  // reason; the renderer log must not be the one unguarded link.
  let serialized;
  let logData = data;
  try {
    // A finished Codex/CUA result can carry up to 1MB of stdout. Pretty-printing
    // that into the debug log (and sending it over IPC) spiked renderer memory
    // on every "Local action finished" line. Cap before stringify; the model
    // still receives the separately truncated function_call_output.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      logData = truncateOutput(data, 8000);
    } else if (typeof data === "string" && data.length > 16000) {
      logData = `${data.slice(0, 16000)}\n...[truncated ${data.length - 16000} chars]`;
    }
    serialized = JSON.stringify(logData, null, 2);
    if (typeof serialized === "string" && serialized.length > 16000) {
      serialized = `${serialized.slice(0, 16000)}\n...[truncated ${serialized.length - 16000} chars]`;
    }
  } catch {
    serialized = String(data);
    logData = serialized;
  }
  const suffix = data ? `\n${typeof logData === "string" ? logData : serialized}` : "";
  const line = `${new Date().toLocaleTimeString()}  ${message}${suffix}\n`;
  // Newest-first line list: concatenating into a 50KB string on every log
  // copied the whole buffer (and then sliced it) even while the debug panel
  // was closed. Join only when the user can see it.
  pushLogLine(line);
  if (debugPanel?.open) {
    logBuffer = joinLogLines();
    logEl.textContent = logBuffer;
  }
  tryBridge()?.log("ui", { message, data: logData }).catch(() => {});
}

function updateModeControls() {
  const mode = voiceModeInput.value;
  assistantOptions.forEach((el) => (el.hidden = mode !== "assistant"));
  translateOptions.forEach((el) => (el.hidden = mode !== "translate"));
  transcribeOptions.forEach((el) => (el.hidden = mode !== "transcribe"));
  interviewOptions.forEach((el) => (el.hidden = mode !== "interview"));
  interviewerDeviceField.hidden = mode !== "interview" || interviewerInputMode.value !== "device";
  captionPanel.hidden = mode === "assistant";

  if (mode === "interview") {
    sourceCaptionLabel.textContent = "Interview English -> Spanish";
    outputCaptionLabel.textContent = "My Spanish -> English";
    updateInterviewAudioWarning();
  } else {
    sourceCaptionLabel.textContent = "Source";
    outputCaptionLabel.textContent = "Output";
    configEl.classList.remove("is-warning");
    if (baseConfigText) configEl.textContent = baseConfigText;
  }
}

function updateInterviewAudioWarning(devices = lastMediaDevices) {
  if (voiceModeInput.value !== "interview") return;
  if (!hasVirtualAudioDevice(devices)) {
    configEl.textContent = INTERVIEW_VIRTUAL_AUDIO_WARNING;
    configEl.classList.add("is-warning");
    if (!warnedMissingVirtualAudio) {
      warnedMissingVirtualAudio = true;
      log("Interview virtual audio missing. Speaker fallback is still available.");
    }
    return;
  }
  configEl.textContent = INTERVIEW_SETUP_TEXT;
  configEl.classList.remove("is-warning");
}

function getVoiceOptions() {
  return {
    mode: voiceModeInput.value,
    tone: toneInput.value,
    reasoningEffort: reasoningInput.value,
    targetLanguage: targetLanguageInput.value,
    sourceLanguage: sourceLanguageInput.value,
    myMicDeviceId: myMicDeviceInput.value,
    interviewerInputMode: interviewerInputMode.value,
    interviewerAudioDeviceId: interviewerAudioDeviceInput.value,
    spanishOutputDeviceId: spanishOutputDeviceInput.value,
    englishOutputDeviceId: englishOutputDeviceInput.value,
  };
}

function resetCaptions() {
  sourceBucket.parts = [];
  sourceBucket.length = 0;
  outputBucket.parts = [];
  outputBucket.length = 0;
  sourceCaption = "";
  outputCaption = "";
  renderCaptions();
}

let captionsDirty = false;

function renderCaptions() {
  if (captionsDirty) return;
  captionsDirty = true;
  requestAnimationFrame(() => {
    captionsDirty = false;
    // Assistant mode hides the panel; skip the join + DOM write.
    if (captionPanel?.hidden) return;
    sourceCaption = sourceBucket.parts.join("");
    outputCaption = outputBucket.parts.join("");
    sourceCaptionEl.textContent = sourceCaption.trim() || "...";
    outputCaptionEl.textContent = outputCaption.trim() || "...";
  });
}

// Cap each accumulated caption so a long session cannot grow the caption
// strings and the DOM without bound — the debug log, the codex output
// buffer, and the main-process output buffers are all capped, and the
// captions were the one unbounded accumulator. A single spoken turn is far
// below the cap, and .completed/.done events replace the whole caption, so
// the cap only trims runaway accumulation. Truncation keeps the NEWEST text
// (the tail is what the user is reading live) with a marker showing the cut.
const MAX_CAPTION_CHARS = 50000;

function appendCaption(kind, text, replace = false) {
  if (!text) return;
  const bucket = kind === "source" ? sourceBucket : outputBucket;
  if (replace) {
    bucket.parts = [text];
    bucket.length = text.length;
  } else {
    bucket.parts.push(text);
    bucket.length += text.length;
  }
  if (bucket.length > MAX_CAPTION_CHARS) {
    let next = bucket.parts.join("");
    next = `...[truncated ${next.length - MAX_CAPTION_CHARS} chars]\n${next.slice(-MAX_CAPTION_CHARS)}`;
    bucket.parts = [next];
    bucket.length = next.length;
  } else if (bucket.parts.length >= 32) {
    bucket.parts = [bucket.parts.join("")];
  }
  renderCaptions();
}

function handleTranscriptEvent(event, targets = { source: "source", output: "output" }) {
  // Assistant mode hides #captionPanel. Accumulating 50KB strings and
  // joining them every frame is wasted CPU/memory the user cannot see —
  // tools still run; only the live transcript UI is skipped.
  if (captionPanel?.hidden) return;
  if (event.type === "session.input_transcript.delta" && targets.source) appendCaption(targets.source, event.delta);
  if (event.type === "session.output_transcript.delta" && targets.output) appendCaption(targets.output, event.delta);
  if (event.type === "conversation.item.input_audio_transcription.delta" && targets.source) appendCaption(targets.source, event.delta);
  if (event.type === "conversation.item.input_audio_transcription.completed" && targets.source) {
    appendCaption(targets.source, event.transcript, true);
  }
  if ((event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") && targets.output) {
    appendCaption(targets.output, event.delta);
  }
  if ((event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") && targets.output) {
    appendCaption(targets.output, event.transcript, true);
  }
}

// Cap the JSON shown in the pending-action panel so a model-generated args
// blob (bounded at 200KB for run_cua_driver, unbounded for the rest) cannot
// inflate the textarea and the DOM without limit — the log, the captions, and
// the output buffers are all capped, and the panel was the one unbounded sink.
// Truncation is display-only: the full args are still sent for execution, so
// the model never loses data it asked to run. A marker shows the cut.
const MAX_PENDING_ARGS_CHARS = 20000;

function formatPendingArgs(args) {
  const text = JSON.stringify(args || {}, null, 2);
  if (text.length <= MAX_PENDING_ARGS_CHARS) return text;
  return `${text.slice(0, MAX_PENDING_ARGS_CHARS)}\n...[truncated ${text.length - MAX_PENDING_ARGS_CHARS} chars]`;
}

function setPendingAction(action) {
  clearPendingActionTimer();
  // The Realtime API can emit several function calls in one turn (parallel
  // tool use). If a second call arrives while the first still awaits a human
  // Run/Reject answer, the first would never receive its function_call_output
  // and the session would stall waiting for it — so auto-reject the superseded
  // call before showing the new one. (setPendingAction(null) is the "answered"
  // path and never triggers this.)
  if (action && pendingAction && pendingAction.callId !== action.callId) {
    sendFunctionOutput(pendingAction.callId, {
      ok: false,
      code: -96,
      stdout: "",
      stderr: "Superseded by another tool call before the human could respond.",
    });
  }
  pendingAction = action;
  pendingPanel.hidden = !action;
  if (!action) pendingPromptEl.value = "";
  // Display-only caps for both branches: the codex prompt and the args JSON
  // arrive from the Realtime API before the main process validates their
  // length, so an oversized model-generated prompt (or args blob) must not
  // inflate the textarea without limit. The full value is still sent for
  // execution — the panel is just a preview for the human to approve.
  else if (action.kind === "codex") pendingPromptEl.value = formatPendingArgs(action.args?.prompt || "");
  else pendingPromptEl.value = formatPendingArgs(action.args);
  runCodexButton.disabled = !action;
  rejectCodexButton.disabled = !action;
  // If the human never answers (model waiting on Run/Reject), auto-reject so
  // the Realtime session does not hang forever on a tool call.
  if (action && !autoRunInput.checked) {
    pendingActionTimer = setTimeout(() => {
      log(`Pending action auto-rejected after ${Math.round(actionTimeoutMs / 1000)}s without a human response.`);
      sendFunctionOutput(action.callId, {
        ok: false,
        code: -97,
        stdout: "",
        stderr: `Auto-rejected: no human response within ${Math.round(actionTimeoutMs / 1000)} seconds.`,
      });
      setPendingAction(null);
    }, actionTimeoutMs);
  }
}

function clearPendingActionTimer() {
  if (pendingActionTimer) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = undefined;
  }
}

function applyKeyStatus(status) {
  hasStoredKey = Boolean(status.hasEnvKey || status.hasSavedKey || status.hasRuntimeKey);
  apiKeyField.hidden = hasStoredKey;
  keyStatusEl.hidden = !hasStoredKey;
  keyStatusEl.textContent = status.hasSavedKey
    ? "Saved OpenAI key active"
    : status.hasEnvKey
      ? "Using OPENAI_API_KEY"
      : status.hasRuntimeKey
        ? "Using in-memory API key"
        : "";
}

// Reveal the API key input after a connect failed because the key itself was
// rejected. The field is hidden whenever ANY key exists (saved, env, or
// in-memory — see applyKeyStatus), so a key that gets revoked or expires
// leaves the input invisible while the 401 error tells the user to "save it
// again" — with no way to do it. Only the key-rejection class may reveal it:
// a network, quota, or server error must not make the user think the key is
// the problem by suddenly showing the input.
function revealApiKeyField() {
  hasStoredKey = false;
  apiKeyField.hidden = false;
  keyStatusEl.hidden = true;
  keyStatusEl.textContent = "";
}

async function ensureApiKeyReady() {
  const apiKey = apiKeyInput.value.trim();
  if (apiKey) {
    const result = await getBridge().setApiKey(apiKey);
    if (!result.ok) throw new Error(result.error || "The API key format does not look valid.");
    apiKeyInput.value = "";
    applyKeyStatus({ hasEnvKey: false, hasSavedKey: result.saved, hasRuntimeKey: true });
    return;
  }
  if (!hasStoredKey) {
    const status = await getBridge().keyStatus();
    applyKeyStatus(status);
    if (!hasStoredKey) throw new Error("Paste the OpenAI API key once.");
  }
}

function getFunctionCall(event) {
  if (event.type === "response.function_call_arguments.done") {
    return { callId: event.call_id, name: event.name, argsText: event.arguments };
  }
  if (event.type === "conversation.item.done" && event.item?.type === "function_call") {
    return { callId: event.item.call_id, name: event.item.name, argsText: event.item.arguments };
  }
  return null;
}

async function executeAction(action) {
  setPendingAction(null);
  // Pin the data channel of the session that approved this action BEFORE the
  // (potentially long) local run: a disconnect+reconnect while Codex is still
  // running replaces the global actionDataChannel with the NEW session's
  // channel, and delivering this action's output into it would leak a stale
  // function_call_output (a call_id that does not exist in the new
  // conversation) into the new session. The output must go to the channel it
  // was approved on — or be dropped when that channel is gone.
  const channel = actionDataChannel;
  setStatus(action.kind === "codex" ? "Codex running" : "CUA running");
  let result;
  try {
    result =
      action.kind === "codex"
        ? await enqueueCodexRun({ prompt: action.args.prompt, cwd: action.args.cwd })
        : action.kind === "cua"
          ? await getBridge().runCua(action.args)
          : await getBridge().runMac(action.args);
  } catch (error) {
    // Never leave the Realtime session waiting for a tool output that will not come.
    result = { ok: false, code: -99, stdout: "", stderr: error?.message || String(error) };
    log("Local action error.", error);
  }
  // Streamed output is batched to avoid DOM spam and only flushed at 4000
  // chars or on disconnect; without this the tail of a finished run (final
  // lines, error summaries) would stay invisible in the debug log until the
  // user disconnects. All "codex-output" chunks are posted before the IPC
  // call resolves, so flushing here captures the complete run.
  flushCodexOutput();
  sendFunctionOutput(action.callId, result, channel);
  // The user may have disconnected while the local action ran (the child
  // process keeps running in the main process, so the IPC call still
  // resolves). Without this guard the status would flip back to "Listening"
  // over a session that is already gone — the UI already shows "Idle" and
  // the Disconnect button is disabled.
  if (activeSessions.length > 0) setStatus("Listening");
  log("Local action finished.", result);
}

const KNOWN_TOOLS = ["run_codex", "run_cua_driver", "open_app", "type_text_in_front_app", "press_key_in_front_app"];

async function handleToolEvent(event) {
  const functionCall = getFunctionCall(event);
  if (!functionCall) return;
  if (handledToolCalls.has(functionCall.callId)) return;
  // Tool call ids are unique per session and never replayed after the fact, so
  // dropping the whole dedupe set when it gets large is safe and keeps memory bounded.
  if (handledToolCalls.size >= 1000) handledToolCalls.clear();
  handledToolCalls.add(functionCall.callId);

  if (!KNOWN_TOOLS.includes(functionCall.name)) {
    // A hallucinated or stale tool name must not stall the session waiting
    // forever for a function_call_output that will never come: answer with an
    // error so the model can self-correct from the message.
    sendFunctionOutput(functionCall.callId, {
      ok: false,
      code: -100,
      stdout: "",
      stderr: `Unknown tool: ${functionCall.name}.`,
    });
    return;
  }

  let args;
  try {
    args = JSON.parse(functionCall.argsText || "{}");
  } catch (error) {
    sendFunctionOutput(functionCall.callId, {
      ok: false,
      code: -98,
      stdout: "",
      stderr: `Invalid tool arguments JSON: ${error?.message || error}`,
    });
    return;
  }
  // A well-formed JSON payload is not necessarily an object: the model can
  // emit "null", a bare string, a number, or an array (e.g. a hallucinated
  // call with json_args "[]"). The codex path would then read
  // action.args.prompt off null and throw a raw TypeError (caught by
  // executeAction, but surfaced to the model as an opaque "Cannot read
  // properties of null" message), and an array/string would reach the main
  // process where validation rejects it with a misleading message. Reject
  // non-object args here with a clean error so the model can self-correct
  // from the message, and the pending panel never shows junk args.
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    sendFunctionOutput(functionCall.callId, {
      ok: false,
      code: -101,
      stdout: "",
      stderr: "Invalid tool arguments: expected a JSON object.",
    });
    return;
  }
  const isMacAction = ["open_app", "type_text_in_front_app", "press_key_in_front_app"].includes(functionCall.name);
  // The declared tool name is the source of truth for dispatch: runMacAction
  // switches on input.action, so a model-supplied "action" key inside the
  // args must never override it. The spread comes FIRST so the declared name
  // always wins — otherwise a call declared as open_app with a hallucinated
  // args.action could silently execute a different mac action than the one
  // the model declared (and the human approved in the pending panel).
  const action = {
    kind: functionCall.name === "run_codex" ? "codex" : functionCall.name === "run_cua_driver" ? "cua" : "mac",
    callId: functionCall.callId,
    args: isMacAction ? { ...args, action: functionCall.name } : args,
  };
  setPendingAction(action);
  if (autoRunInput.checked) executeAction(action);
}

function deviceConstraint(deviceId, options = {}) {
  const base = {
    echoCancellation: options.echoCancellation ?? true,
    noiseSuppression: options.noiseSuppression ?? true,
    autoGainControl: options.autoGainControl ?? true,
  };
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
}

function setSelectOptions(select, devices, defaultLabel) {
  const current = select.value;
  select.replaceChildren(new Option(defaultLabel, ""));
  devices.forEach((device, index) => select.appendChild(new Option(device.label || `${defaultLabel} ${index + 1}`, device.deviceId)));
  for (const option of select.options) {
    if (option.value === current) {
      select.value = current;
      break;
    }
  }
}

async function refreshMediaDevices(promptForLabels = false) {
  let permissionStream;
  try {
    if (promptForLabels) permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // Permission denied or the prompt dismissed: getUserMedia rejects, but the
    // device list can still be enumerated and refreshed (labels just come back
    // empty). Letting the rejection abort the refresh would leave the dropdowns
    // stale — worse than unlabeled — and surface a raw "Permission denied" log
    // on every interview-mode switch.
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // devicechange fires often on macOS (Bluetooth, sleep, audio session
    // flaps) with an identical list. Rebuilding four <select>s and scanning
    // lost selections is wasted DOM work when nothing changed — labels
    // appearing after a permission grant still differ, so that path rebuilds.
    if (sameMediaDeviceList(lastMediaDevices, devices)) return;
    // Capture the previous selections BEFORE the setSelectOptions calls below
    // replace the options: a device that vanished (unplugged, renamed with a
    // new id, permission revoked) silently falls back to the default option,
    // and without the old values that fallback is undetectable afterwards.
    const previousDevices = lastMediaDevices;
    const previousSelections = [
      ["microphone", myMicDeviceInput],
      ["interview input", interviewerAudioDeviceInput],
      ["Spanish output", spanishOutputDeviceInput],
      ["English output", englishOutputDeviceInput],
    ].map(([label, select]) => [label, select, select.value]);
    const previousLabels = new Map(previousDevices.map((device) => [device.deviceId, device.label]));
    lastMediaDevices = devices;
    setSelectOptions(myMicDeviceInput, devices.filter((device) => device.kind === "audioinput"), "Default microphone");
    setSelectOptions(interviewerAudioDeviceInput, devices.filter((device) => device.kind === "audioinput"), "Default input");
    setSelectOptions(spanishOutputDeviceInput, devices.filter((device) => device.kind === "audiooutput"), "Default output");
    setSelectOptions(englishOutputDeviceInput, devices.filter((device) => device.kind === "audiooutput"), "Default output");
    updateInterviewAudioWarning(devices);
    // A selected device that disappeared (unplugged, renamed, permission
    // revoked) falls back to the default SILENTLY — and in interview mode
    // that can route the call to the wrong speaker or capture the wrong mic
    // with no visible sign. Surface it once while the situation persists
    // (debug log plus the status line), and clear the warning on the first
    // refresh that finds every selection intact again. Placed after
    // updateInterviewAudioWarning so the more specific fallback warning wins
    // over the virtual-audio hint while both apply.
    const lostSelections = previousSelections.filter(([, select, oldValue]) => {
      return oldValue !== "" && ![...select.options].some((option) => option.value === oldValue);
    });
    if (lostSelections.length > 0) {
      if (!warnedDeviceFallback) {
        warnedDeviceFallback = true;
        const detail = lostSelections
          .map(([label, , oldValue]) => `${label} (${previousLabels.get(oldValue) || "device no longer listed"})`)
          .join(", ");
        log(`Selected audio device(s) are no longer available and fell back to the default: ${detail}. Reconnect the device or pick it again.`);
      }
      configEl.textContent = `Device fallback: ${lostSelections.map(([label]) => label).join(", ")} — using the default.`;
      configEl.classList.add("is-warning");
    } else if (warnedDeviceFallback) {
      warnedDeviceFallback = false;
      if (voiceModeInput.value === "interview") updateInterviewAudioWarning(devices);
      else {
        configEl.textContent = baseConfigText;
        configEl.classList.remove("is-warning");
      }
    }
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
}

async function getInterviewAudioStream(options, controller) {
  if (options.interviewerInputMode === "device") {
    return navigator.mediaDevices.getUserMedia({
      audio: deviceConstraint(options.interviewerAudioDeviceId, {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
      // Same cancel semantics as the assistant path: a Disconnect pressed
      // while this prompt is pending aborts it instead of leaving the OS
      // dialog up after the UI already went Idle.
      signal: controller?.signal,
    });
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((track) => track.stop());
  if (!stream.getAudioTracks().length) throw new Error("No meeting audio was captured.");
  return new MediaStream(stream.getAudioTracks());
}

async function applyAudioOutputDevice(audio, deviceId, label) {
  if (!deviceId) return;
  if (typeof audio.setSinkId !== "function") {
    log(`${label}: this runtime cannot select a separate audio output device.`);
    return;
  }
  try {
    await audio.setSinkId(deviceId);
  } catch (error) {
    // A failed sink switch (device unplugged, permissions) must not abort the
    // whole connection: fall back to the default output device instead.
    log(`${label}: could not use the selected output device, using the default.`, error?.message || String(error));
  }
}

async function connectPeerSession({ label, tokenOptions, inputStream, outputDeviceId, transcriptTargets, enableTools = false, controller }) {
  const pc = new RTCPeerConnection();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  try {
    // The token fetch must live inside the try: a failure here (bad key,
    // network, quota) would otherwise skip the catch below, and since this
    // session is never pushed to activeSessions, disconnectRealtime() cannot
    // stop the microphone either — the mic would stay hot after a failed
    // connect. Fetching it inside the try guarantees the cleanup path always
    // runs: pc closed and inputStream tracks stopped.
    const token = await getBridge().createClientSecret(tokenOptions);
    await applyAudioOutputDevice(audio, outputDeviceId, label);

    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== "failed" && pc.connectionState !== "closed") return;
      if (!activeSessions.some((session) => session.pc === pc)) return;
      log(`${label}: Realtime connection ${pc.connectionState}.`);
      disconnectRealtime();
    };
    pc.addTrack(inputStream.getAudioTracks()[0], inputStream);

    const dc = pc.createDataChannel(`oai-events-${label}`);
    if (enableTools) actionDataChannel = dc;
    dc.addEventListener("open", () => log(`${label}: Realtime data channel open.`));
    dc.addEventListener("message", async (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch (error) {
        log(`${label}: dropped malformed Realtime event.`, String(error));
        return;
      }
      // JSON.parse can succeed with a non-object: "null", a bare string, a
      // number, or an array all parse cleanly. Reading .type off null would
      // throw inside this async handler (an unhandled rejection that skips
      // the transcript/tool handling for the message), and a string/number/
      // array is not a Realtime event either — drop the whole message with a
      // log, mirroring the malformed-JSON branch above.
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        log(`${label}: dropped non-object Realtime event.`, String(message.data));
        return;
      }
      if (event.type?.includes("error")) log(`${label}: Realtime error`, event);
      handleTranscriptEvent(event, transcriptTargets);
      if (enableTools) await handleToolEvent(event);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch(token.callEndpoint || "https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${token.value}`,
        "Content-Type": "application/sdp",
      },
      // Never let a hung network call leave the Connect flow pending forever;
      // humanizeError turns the resulting TimeoutError into a clear message.
      // The connect controller aborts this fetch when the user presses
      // Disconnect while "Connecting" is still in flight, so the session below
      // is never pushed with a live microphone after the UI already went Idle.
      signal: AbortSignal.any([
        AbortSignal.timeout(openaiCallTimeoutMs),
        controller?.signal,
      ].filter(Boolean)),
    });
    if (!response.ok) throw new Error(`${label}: Realtime call failed: ${response.status} ${await response.text()}`);
    const sdp = await response.text();
    // A 2xx non-SDP body (a captive portal or proxy answering with an HTML or
    // JSON page) would make setRemoteDescription fail with an opaque "not a
    // valid SDP" error that humanizeError passes through raw; fail with an
    // actionable message instead so the user can spot the interception.
    if (!isSdpAnswer(sdp)) {
      throw new Error(`${label}: the Realtime server returned an unexpected response (HTTP ${response.status}) instead of an SDP answer — a proxy or captive portal may be intercepting the connection.`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp });
    // The user disconnected while the SDP exchange was in flight: refuse to
    // register the session — the catch below closes the peer connection and
    // stops the microphone so a "Disconnected" UI never leaves audio live.
    // Check the controller captured at connect start, never the global: a
    // newer connect may have replaced it by now, and this session must only
    // answer to the connect that created it.
    if (controller?.signal.aborted) {
      throw new Error(`${label}: connection cancelled by disconnect.`);
    }
    activeSessions.push({ label, pc, dc, stream: inputStream, audio });
  } catch (error) {
    // Never leak the peer connection or leave the microphone hot after a failed connect.
    try {
      pc.close();
    } catch {
      // Already closed.
    }
    try {
      inputStream.getTracks().forEach((track) => track.stop());
    } catch {
      // Track already stopped.
    }
    audio.srcObject = null;
    throw error;
  }
}

async function connectSingleRealtime(options, controller) {
  // Respect the microphone selected in the UI (it was previously ignored
  // outside interview mode, silently falling back to the system default).
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceConstraint(options.myMicDeviceId),
    // A Disconnect press mid-connect must also cancel a still-pending
    // microphone permission prompt, not just the SDP fetch: without the
    // signal, getUserMedia keeps waiting on the OS prompt after the UI
    // already went Idle, and the grant then starts a pointless token fetch
    // and peer connection for a session the user cancelled.
    signal: controller?.signal,
  });
  // The abort can also win the race between getUserMedia resolving and this
  // check (the prompt was answered just as Disconnect was pressed); refuse
  // to start the SDP exchange so the mic is stopped here instead of staying
  // hot through a wasted token fetch and offer.
  if (controller?.signal.aborted) {
    stopMediaStream(stream);
    throw new Error("Connection cancelled by disconnect.");
  }
  await connectPeerSession({
    label: "Assistant",
    tokenOptions: options,
    inputStream: stream,
    transcriptTargets: { source: "source", output: "output" },
    enableTools: options.mode === "assistant",
    controller,
  });
}

function stopMediaStream(stream) {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Track already stopped.
  }
}

async function connectInterviewRealtime(options, controller) {
  const interviewerStream = await getInterviewAudioStream(options, controller);
  // A Disconnect pressed while the meeting-audio picker was open (or while
  // the device-mode mic prompt was pending) must not start the SDP exchange:
  // stop the captured stream and bail so the UI stays Idle. (The abort
  // signal above already cancels the device-mode prompt itself; this check
  // covers the system screen-picker path, which cannot be aborted.)
  if (controller?.signal.aborted) {
    stopMediaStream(interviewerStream);
    throw new Error("Connection cancelled by disconnect.");
  }
  let myMicStream;
  try {
    myMicStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceConstraint(options.myMicDeviceId),
      signal: controller?.signal,
    });
    // Same race as connectSingleRealtime: the prompt was answered just as
    // Disconnect was pressed. The catch below stops both streams.
    if (controller?.signal.aborted) throw new Error("Connection cancelled by disconnect.");
    await connectPeerSession({
      label: "Interview to Spanish",
      tokenOptions: { mode: "translate", targetLanguage: "es" },
      inputStream: interviewerStream,
      outputDeviceId: options.spanishOutputDeviceId,
      transcriptTargets: { source: null, output: "source" },
      controller,
    });
    await connectPeerSession({
      label: "My reply to English",
      tokenOptions: { mode: "translate", targetLanguage: "en" },
      inputStream: myMicStream,
      outputDeviceId: options.englishOutputDeviceId,
      transcriptTargets: { source: null, output: "output" },
      controller,
    });
  } catch (error) {
    // Streams not yet owned by a session stay hot if the second half fails
    // (mic denied after meeting audio was captured, or the second Realtime
    // call dies). connectPeerSession / disconnectRealtime stop owned ones.
    stopMediaStream(interviewerStream);
    stopMediaStream(myMicStream);
    throw error;
  }
}

async function connectRealtime() {
  setStatus("Connecting");
  connectButton.disabled = true;
  // Disconnect doubles as Cancel while a connect is in flight, so enable it
  // before the (potentially slow) token + SDP exchange instead of only after
  // the session is up: a Disconnect press mid-"Connecting" must be possible
  // or the abort controller below is dead UI and the user is stuck waiting
  // out the full timeout.
  disconnectButton.disabled = false;
  // A fresh controller per connect: disconnectRealtime() aborts it so a
  // Disconnect press mid-"Connecting" cancels the in-flight SDP exchange
  // instead of letting the session come up afterwards. The controller is
  // captured in a LOCAL first and threaded through the whole connect flow:
  // the global can be replaced by a newer connect (Disconnect + quick
  // Connect), and a stale connect must keep checking — and aborting — only
  // its own controller, never the newer connect's.
  const controller = new AbortController();
  connectAbortController = controller;
  handledToolCalls.clear();
  resetCaptions();
  try {
    await ensureApiKeyReady();
    await refreshMediaDevices(false).catch(() => {});
    const options = getVoiceOptions();
    if (options.mode === "interview") await connectInterviewRealtime(options, controller);
    else await connectSingleRealtime(options, controller);
    // Mode/tone/language/audio devices are captured at connect time; changing
    // them mid-session would not affect the running session and would mislead
    // the user into thinking it did, so lock them all until disconnect.
    setConnectControlsLocked(true);
    setStatus("Listening");
    disconnectButton.disabled = false;
  } catch (error) {
    // A newer connect may have replaced the global controller while this
    // connect was still in flight (Disconnect + quick Connect). A stale
    // connect must never touch the UI or abort the newer connect's
    // controller: only the connect that still owns the global may run the
    // error path.
    if (connectAbortController !== controller) return;
    // The user pressed Disconnect while this connect was still in flight:
    // disconnectRealtime() already tore down the UI, so surface the quiet
    // Idle state instead of flipping to Error over an intentional cancel.
    if (controller.signal.aborted) {
      setStatus("Idle");
      connectButton.disabled = false;
      return;
    }
    disconnectRealtime({ silent: true });
    // The humanized message is the actionable one ("check your key", "check
    // your network", ...); burying it only in the collapsible debug log left
    // the user staring at a bare "Error" pill. Surface it in the status
    // itself, keeping the "error" state so the orb styling still applies.
    const message = humanizeError(error);
    log(message);
    // A rejected key (revoked, expired, wrong project) must also un-hide the
    // key input: it is hidden whenever any key exists, so the user would see
    // "save it again" with no way to save — reveal it only for the
    // key-rejection class, never for network/quota/server failures.
    if (isApiKeyRejection(error)) revealApiKeyField();
    setStatus(`Error: ${message}`, "error");
    connectButton.disabled = false;
  }
}

function disconnectRealtime(options = {}) {
  // Cancel any connect still in flight: the pending SDP fetch aborts and the
  // aborted session is never pushed (see connectPeerSession), so a Disconnect
  // press mid-"Connecting" cannot leave a live microphone behind.
  connectAbortController?.abort();
  activeSessions.splice(0).forEach((session) => {
    session.stream?.getTracks().forEach((track) => track.stop());
    session.dc?.close();
    session.pc?.close();
    if (session.audio) session.audio.srcObject = null;
  });
  flushCodexOutput();
  actionDataChannel = undefined;
  // A tool call awaiting approval is meaningless once the session is gone;
  // leaving it would strand a stale Run/Reject panel on screen.
  setPendingAction(null);
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  setConnectControlsLocked(false);
  if (!options.silent) {
    setStatus("Idle");
    log("Disconnected.");
  }
}

// The channel is passed in (defaulting to the global) rather than always read
// from the global so a stale output can never leak into a later session's
// channel after a disconnect+reconnect: executeAction pins the channel its
// action was approved on, so an output that outlives its session is either
// delivered on the original channel or dropped when that channel is gone.
function sendFunctionOutput(callId, output, channel = actionDataChannel) {
  const messages = [
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(truncateOutput(output)) },
    }),
    JSON.stringify({ type: "response.create" }),
  ];
  // The channel can close between the readyState check and send() (e.g. the
  // user disconnected while a long Codex run was finishing); send() on a
  // closing/closed channel throws InvalidStateError, so guard both the state
  // and the call itself.
  const send = (target) => {
    if (!target || target.readyState !== "open") {
      log("Data channel closed before the function output could be sent.");
      return;
    }
    try {
      messages.forEach((message) => target.send(message));
    } catch (error) {
      log("Function output could not be sent; data channel closed.", String(error));
    }
  };
  if (channel && channel.readyState === "open") {
    send(channel);
    return;
  }
  // Dropping the output here would leave the Realtime session waiting forever
  // for a tool response (e.g. the user approved an action right after connect,
  // before the data channel finished opening). Wait briefly instead.
  if (!channel) {
    log("No data channel to deliver function output.");
    return;
  }
  const onOpen = () => {
    clearTimeout(dropTimer);
    send(channel);
  };
  let dropTimer;
  dropTimer = setTimeout(() => {
    // Cancel the pending send: without the removal, the once-listener would
    // still fire when the channel finally opens and send the output anyway —
    // contradicting this log and leaking a stale function_call_output (with a
    // callId from a dead session) into whatever channel is open by then.
    channel.removeEventListener("open", onOpen);
    log("Data channel did not open in time; function output dropped.");
  }, 5000);
  channel.addEventListener("open", onOpen, { once: true });
}

connectButton.addEventListener("click", connectRealtime);
disconnectButton.addEventListener("click", disconnectRealtime);
voiceModeInput.addEventListener("change", async () => {
  updateModeControls();
  if (voiceModeInput.value === "interview") refreshMediaDevices(true).catch((error) => log(error.message));
});
interviewerInputMode.addEventListener("change", updateModeControls);
runCodexButton.addEventListener("click", () => pendingAction && executeAction(pendingAction));
rejectCodexButton.addEventListener("click", () => {
  if (!pendingAction) return;
  sendFunctionOutput(pendingAction.callId, { ok: false, stderr: "The human rejected this local action request." });
  setPendingAction(null);
});
// Enabling auto-run must apply to a tool call already awaiting a human
// decision: without this, the pending action keeps its auto-reject timer and
// gets rejected later even though the human just asked for automatic
// execution. Run it now, exactly like the model path does when a call arrives
// with auto-run already checked (executeAction clears the pending timer).
autoRunInput.addEventListener("change", () => {
  if (autoRunInput.checked && pendingAction) executeAction(pendingAction);
});
debugPanel?.addEventListener("toggle", () => {
  if (debugPanel.open) {
    logBuffer = joinLogLines();
    logEl.textContent = logBuffer;
  }
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshMediaDevices(false).catch(() => {}));

let codexOutputBuffer = "";

function flushCodexOutput() {
  if (!codexOutputBuffer) return;
  log("codex output", codexOutputBuffer);
  codexOutputBuffer = "";
}

try {
  getBridge().config().then((config) => {
    if (config.reasoningEffort) reasoningInput.value = config.reasoningEffort;
    if (config.tone) toneInput.value = config.tone;
    if (config.targetLanguage) targetLanguageInput.value = config.targetLanguage;
    if (config.actionTimeoutMs) actionTimeoutMs = config.actionTimeoutMs;
    if (config.openaiTimeoutMs) openaiCallTimeoutMs = config.openaiTimeoutMs;
    // The config line also shows the workdir: app:config already sends it
    // (CODEX_VOICE_WORKDIR or the launch cwd) but it used to be dropped on
    // the floor, leaving the user unable to verify which directory Codex
    // operates on without opening the debug log. The main process always
    // resolves a workdir (path.resolve), so the value is never empty.
    baseConfigText = `v${config.version || "?"} / ${config.model} / ${config.translateModel} / ${config.transcribeModel} / ${(config.shortcut || "CommandOrControl+Shift+Space").replace(/CommandOrControl/g, "Cmd")} / ${config.workdir}`;
    configEl.textContent = baseConfigText;
    updateModeControls();
  });
  getBridge().logPath().then((logPath) => log(`Live log: ${logPath}`));
  getBridge().keyStatus().then((status) => {
    applyKeyStatus(status);
    if (status.hasEnvKey || status.hasSavedKey) log(status.hasSavedKey ? "Using saved OpenAI key from Keychain." : "Using OPENAI_API_KEY.");
  });
  // Stream Codex/CUA progress into the debug log (batched to avoid DOM spam).
  getBridge().onCodexOutput((chunk) => {
    codexOutputBuffer += chunk;
    if (codexOutputBuffer.length >= 4000) flushCodexOutput();
  });
  refreshMediaDevices(false).catch(() => {});
  updateModeControls();
} catch (error) {
  log(error.message);
  setStatus("Bridge error");
}
