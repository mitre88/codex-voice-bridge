import { hasVirtualAudioDevice, humanizeError, isApiKeyRejection, truncateOutput } from "./renderer-utils.js";
import { createSessionController } from "./session-controller.js";
import { TailBuffer } from "./tail-buffer.js";
import { createVisibleRenderer } from "./visible-renderer.js";

// How long the Realtime SDP exchange may take before we give up. The main
// process already times out the token fetch; this bounds the second network
// hop so a hung connection cannot leave the UI stuck on "Connecting" forever.
// Defaults to 60s, then follows the main process's configured
// CODEX_VOICE_OPENAI_TIMEOUT_MS (delivered via app:config) so that env var
// governs every OpenAI HTTP hop, not just the token fetch.
let openaiCallTimeoutMs = 60000;

const INTERVIEW_SETUP_TEXT = "Route English to BlackHole/Loopback, then select that device as the meeting microphone.";
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
const voiceInput = document.querySelector("#voice");
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
const configEl = document.querySelector("#config");

let currentSession;
const activeSessions = [];
const errorBanner = document.querySelector("#errorBanner");
const errorMessage = document.querySelector("#errorMessage");
const routingEl = document.querySelector("#routing");
const capabilitiesEl = document.querySelector("#capabilities");
const captionAnnouncement = document.querySelector("#captionAnnouncement");
const actionAnnouncement = document.querySelector("#actionAnnouncement");
const actionDeadline = document.querySelector("#actionDeadline");
const debugPanel = document.querySelector(".debug-panel");
const debugBuffer = new TailBuffer(50000);
const sourceBuffer = new TailBuffer(50000);
const outputBuffer = new TailBuffer(50000);
let appVisible = true;
let previousApprovalFocus;
const requestId = () => window.crypto.randomUUID();
const view = createVisibleRenderer({
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
  isVisible: () => appVisible && !document.hidden,
  render() {
    if (!captionPanel.hidden) {
      sourceCaptionEl.textContent = sourceBuffer.display() || "Waiting for speech…";
      outputCaptionEl.textContent = outputBuffer.display() || "Waiting for speech…";
    }
    if (debugPanel.open) {
      logEl.textContent = debugBuffer.display();
      logEl.scrollTop = logEl.scrollHeight;
    }
  },
});
function showError(message) {
  errorMessage.textContent = message;
  errorBanner.hidden = false;
}
function hideError() {
  errorBanner.hidden = true;
  errorMessage.textContent = "";
}

const handledToolCalls = new Set();
// Main owns the serial local-action queue; renderer also guards stale dispatch.
function enqueueCodexRun(args) {
  return getBridge().runCodex(args);
}
let pendingAction;
let pendingActionTimer;
let actionTimeoutMs = 120000;
let actionDataChannel;
// Aborted by disconnectRealtime() while a connect is still in flight so a
// Disconnect press mid-"Connecting" tears down the pending session instead of
// letting it come up afterwards with a live microphone. Recreated on each
// connect; aborting a finished connect's controller is a harmless no-op.

let hasStoredKey = false;
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
  voiceInput,
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
  tryBridge()
    ?.log("window.error", { message: event.message, filename: event.filename, lineno: event.lineno })
    .catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  tryBridge()
    ?.log("window.unhandledrejection", { reason: String(event.reason), stack: event.reason?.stack })
    .catch(() => {});
});

function setStatus(text, state) {
  statusEl.textContent = text;
  document.body.dataset.state = state || text.toLowerCase().replace(/\s+/g, "-");
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
  try {
    serialized = JSON.stringify(data, null, 2);
  } catch {
    serialized = String(data);
  }
  const suffix = data ? `\n${typeof data === "string" ? data : serialized}` : "";
  debugBuffer.append(`${new Date().toLocaleTimeString()}  ${message}${suffix}\n`);
  view.invalidate();
  tryBridge()
    ?.log("ui", { message, data })
    .catch(() => {});
}

function updateModeControls() {
  const mode = voiceModeInput.value;
  assistantOptions.forEach((el) => (el.hidden = mode !== "assistant"));
  translateOptions.forEach((el) => (el.hidden = mode !== "translate"));
  transcribeOptions.forEach((el) => (el.hidden = mode !== "transcribe"));
  interviewOptions.forEach((el) => (el.hidden = mode !== "interview"));
  interviewerDeviceField.hidden = mode !== "interview" || interviewerInputMode.value !== "device";
  captionPanel.hidden = false;
  view.invalidate();

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
    voice: voiceInput.value,
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
  sourceBuffer.clear();
  outputBuffer.clear();
  view.invalidate();
}
function appendCaption(kind, text, replace = false) {
  if (!text || typeof text !== "string") return;
  const buffer = kind === "source" ? sourceBuffer : outputBuffer;
  if (replace) buffer.clear();
  buffer.append(text);
  // Announce a completed segment, never the whole growing delta buffer.
  if (replace) captionAnnouncement.textContent = text.slice(-2000);
  view.invalidate();
}

function handleTranscriptEvent(event, targets = { source: "source", output: "output" }) {
  if (event.type === "session.input_transcript.delta" && targets.source) appendCaption(targets.source, event.delta);
  if (event.type === "session.output_transcript.delta" && targets.output) appendCaption(targets.output, event.delta);
  if (event.type === "conversation.item.input_audio_transcription.delta" && targets.source)
    appendCaption(targets.source, event.delta);
  if (event.type === "conversation.item.input_audio_transcription.completed" && targets.source) {
    appendCaption(targets.source, event.transcript, true);
  }
  if (
    (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") &&
    targets.output
  ) {
    appendCaption(targets.output, event.delta);
  }
  if (
    (event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") &&
    targets.output
  ) {
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
  if (action && !pendingAction) previousApprovalFocus = document.activeElement;
  const hadApprovalFocus = pendingPanel.contains(document.activeElement);
  pendingAction = action;
  pendingPanel.hidden = !action;
  actionAnnouncement.textContent = action ? "Local action needs approval." : "";
  actionDeadline.textContent = action
    ? `Automatically rejected after ${Math.round(actionTimeoutMs / 1000)} seconds. Preview is read-only.`
    : "";
  if (!action && hadApprovalFocus) {
    (previousApprovalFocus?.isConnected &&
    previousApprovalFocus.matches("button, input, select, textarea, [tabindex]") &&
    !previousApprovalFocus.disabled
      ? previousApprovalFocus
      : disconnectButton.disabled
        ? connectButton
        : disconnectButton
    ).focus();
  }
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
  if (action && !autoRunInput.checked) runCodexButton.focus();
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
  hasStoredKey = Boolean(status.hasEnvKey || status.hasSavedKey || status.hasRuntimeKey || status.hasLegacyKey);
  if (status.warning) showError(status.warning);
  apiKeyField.hidden = hasStoredKey;
  keyStatusEl.hidden = !hasStoredKey;
  keyStatusEl.textContent = status.hasRuntimeKey
    ? "Using your entered key for this launch"
    : status.hasSavedKey
      ? "Encrypted saved key active"
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
    applyKeyStatus({
      hasEnvKey: false,
      hasSavedKey: result.saved,
      hasRuntimeKey: true,
      warning: result.saved ? "" : result.error,
    });
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
  const owner = currentSession;
  if (!owner?.ready || owner.signal.aborted || action.sessionId !== owner.id) return;
  setPendingAction(null);
  // Pin the data channel of the session that approved this action BEFORE the
  // (potentially long) local run: a disconnect+reconnect while Codex is still
  // running replaces the global actionDataChannel with the NEW session's
  // channel, and delivering this action's output into it would leak a stale
  // function_call_output (a call_id that does not exist in the new
  // conversation) into the new session. The output must go to the channel it
  // was approved on — or be dropped when that channel is gone.
  const channel = actionDataChannel;
  const identity = { sessionId: owner.id, requestId: requestId() };
  const scopedArgs = { ...action.args, ...identity };
  setStatus(action.kind === "codex" ? "Codex running" : "CUA running");
  let result;
  try {
    result =
      action.kind === "codex"
        ? await enqueueCodexRun({ prompt: action.args.prompt, cwd: action.args.cwd, ...identity })
        : action.kind === "cua"
          ? await getBridge().runCua(scopedArgs)
          : await getBridge().runMac(scopedArgs);
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
  if (currentSession !== owner || owner.signal.aborted) return;
  flushCodexOutput();
  sendFunctionOutput(action.callId, result, channel);
  // The user may have disconnected while the local action ran (the child
  // process keeps running in the main process, so the IPC call still
  // resolves). Without this guard the status would flip back to "Listening"
  // over a session that is already gone — the UI already shows "Idle" and
  // the Disconnect button is disabled.
  if (currentSession === owner && owner.ready) setStatus("Listening");
  log("Local action finished.", result);
}

const KNOWN_TOOLS = ["run_codex", "run_cua_driver", "open_app", "type_text_in_front_app", "press_key_in_front_app"];

async function handleToolEvent(event) {
  if (!currentSession?.ready || currentSession.signal.aborted) return;
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
    sessionId: currentSession.id,
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
  devices.forEach((device, index) =>
    select.appendChild(new Option(device.label || `${defaultLabel} ${index + 1}`, device.deviceId)),
  );
  if (current && !devices.some((device) => device.deviceId === current)) {
    const missing = new Option("Selected device unavailable — choose an output/input", current);
    missing.dataset.missing = "true";
    select.appendChild(missing);
  }
  select.value = current;
}

async function refreshMediaDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  lastMediaDevices = devices;
  for (const [select, kind, label] of [
    [myMicDeviceInput, "audioinput", "Default microphone"],
    [interviewerAudioDeviceInput, "audioinput", "Default input"],
    [spanishOutputDeviceInput, "audiooutput", "Default output"],
    [englishOutputDeviceInput, "audiooutput", "Default output"],
  ])
    setSelectOptions(
      select,
      devices.filter((device) => device.kind === kind),
      label,
    );
  updateInterviewAudioWarning(devices);
  const relevant =
    voiceModeInput.value === "interview"
      ? [
          myMicDeviceInput,
          ...(interviewerInputMode.value === "device" ? [interviewerAudioDeviceInput] : []),
          spanishOutputDeviceInput,
          englishOutputDeviceInput,
        ]
      : [myMicDeviceInput];
  const missing = relevant.filter((select) => select.selectedOptions[0]?.dataset.missing);
  warnedDeviceFallback = Boolean(missing.length);
  if (warnedDeviceFallback) {
    if (currentSession) disconnectRealtime({ silent: true });
    showError(
      "A selected audio device disappeared. Reconnect it or explicitly select another device. No automatic fallback was chosen.",
    );
    setStatus("Device unavailable", "error");
    connectButton.textContent = "Retry";
  }
  return devices;
}

async function getInterviewAudioStream(options) {
  if (options.interviewerInputMode === "device") {
    return navigator.mediaDevices.getUserMedia({
      audio: deviceConstraint(options.interviewerAudioDeviceId, {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });
  }
  // getUserMedia/getDisplayMedia do not support AbortSignal cancellation.
  // The session owner stops a late grant; macOS can leave its picker visible.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((track) => track.stop());
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("No meeting audio was captured. Use a virtual audio input and Retry.");
  }
  return stream;
}

function routeDescription(options) {
  const label = (select) => select.selectedOptions[0]?.textContent || "Default";
  return options.mode === "interview"
    ? `Their English → Spanish → ${label(spanishOutputDeviceInput)}. Your Spanish (${label(myMicDeviceInput)}) → English → ${label(englishOutputDeviceInput)}.`
    : `${label(myMicDeviceInput)} → ${options.mode === "transcribe" ? "captions (no translated output)" : "default audio output"}.`;
}

async function connectRealtime() {
  if (currentSession) return;
  hideError();
  setStatus("Connecting");
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  disconnectButton.textContent = "Cancel";
  setConnectControlsLocked(true);
  const options = getVoiceOptions();
  const owner = createSessionController({
    id: requestId(),
    timeoutMs: openaiCallTimeoutMs,
    createPeer: () => new RTCPeerConnection(),
    createAudio: () => document.createElement("audio"),
    createToken: (tokenOptions) => getBridge().createClientSecret({ ...tokenOptions, requestId: requestId() }),
    fetch,
    onEvent(event, resource) {
      if (currentSession !== owner || owner.signal.aborted) return;
      if (event.type?.includes("error")) log(`${resource.label}: Realtime error`, event);
      handleTranscriptEvent(event, resource.route.transcriptTargets);
      if (resource.route.enableTools) return handleToolEvent(event);
    },
    onFailure(error) {
      if (currentSession !== owner) return;
      disconnectRealtime({ silent: true });
      showError(humanizeError(error));
      setStatus("Interrupted", "error");
      connectButton.textContent = "Retry";
    },
  });
  currentSession = owner;
  handledToolCalls.clear();
  resetCaptions();
  try {
    const begun = await owner.wait(getBridge().beginSession(owner.id));
    if (!begun.ok) throw new Error(begun.error || "Could not begin a session.");
    await owner.wait(ensureApiKeyReady());
    await owner.wait(refreshMediaDevices());
    if (warnedDeviceFallback) throw new Error("Select available audio devices before reconnecting.");
    const microphone = () => navigator.mediaDevices.getUserMedia({ audio: deviceConstraint(options.myMicDeviceId) });
    const routes =
      options.mode === "interview"
        ? [
            {
              label: "Interview to Spanish",
              acquire: () => getInterviewAudioStream(options),
              tokenOptions: { mode: "translate", targetLanguage: "es" },
              outputDeviceId: options.spanishOutputDeviceId,
              transcriptTargets: { source: null, output: "source" },
            },
            {
              label: "My reply to English",
              acquire: microphone,
              tokenOptions: { mode: "translate", targetLanguage: "en" },
              outputDeviceId: options.englishOutputDeviceId,
              transcriptTargets: { source: null, output: "output" },
            },
          ]
        : [
            {
              label: "Assistant",
              acquire: microphone,
              tokenOptions: options,
              transcriptTargets: { source: "source", output: "output" },
              enableTools: options.mode === "assistant",
            },
          ];
    const connected = await owner.start(routes);
    if (currentSession !== owner || owner.signal.aborted) return;
    activeSessions.push(...connected);
    actionDataChannel = connected.find((resource) => resource.route.enableTools)?.dc;
    setStatus("Listening");
    disconnectButton.textContent = "Disconnect";
    routingEl.textContent = `Active route: ${routeDescription(options)}`;
    refreshMediaDevices().catch(() => {});
  } catch (error) {
    if (currentSession !== owner) return;
    disconnectRealtime({ silent: true });
    const message = humanizeError(error);
    log(message);
    if (isApiKeyRejection(error)) revealApiKeyField();
    showError(message);
    setStatus("Not connected", "error");
    connectButton.textContent = "Retry";
  }
}

function disconnectRealtime(options = {}) {
  const owner = currentSession;
  currentSession = undefined;
  owner?.dispose();
  if (owner)
    getBridge()
      .cancelSession(owner.id)
      .catch(() => {});
  activeSessions.length = 0;
  codexOutputBuffer.clear();
  actionDataChannel = undefined;
  setPendingAction(null);
  connectButton.disabled = false;
  connectButton.textContent = "Connect";
  disconnectButton.disabled = true;
  disconnectButton.textContent = "Disconnect";
  setConnectControlsLocked(false);
  routingEl.textContent = "Microphone off. Choose a route before connecting.";
  if (!options.silent) {
    setStatus("Idle");
    log("Disconnected. Queued local actions cancelled.");
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
  log("Data channel closed; function output dropped.");
}

connectButton.addEventListener("click", connectRealtime);
disconnectButton.addEventListener("click", disconnectRealtime);
voiceModeInput.addEventListener("change", async () => {
  updateModeControls();
  if (voiceModeInput.value === "interview") refreshMediaDevices().catch((error) => log(error.message));
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
navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshMediaDevices(false).catch(() => {}));

const codexOutputBuffer = new TailBuffer(50000);

function flushCodexOutput() {
  if (!codexOutputBuffer.length) return;
  log("codex output", codexOutputBuffer.display());
  codexOutputBuffer.clear();
}

try {
  getBridge()
    .config()
    .then((config) => {
      if (config.voice) voiceInput.value = config.voice;
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
  getBridge()
    .logPath()
    .then((logPath) => log(`Live log: ${logPath}`));
  getBridge()
    .keyStatus()
    .then((status) => {
      applyKeyStatus(status);
      if (status.hasEnvKey || status.hasSavedKey)
        log(status.hasSavedKey ? "Using encrypted saved OpenAI key." : "Using OPENAI_API_KEY.");
    });
  // Stream Codex/CUA progress into the debug log (batched to avoid DOM spam).
  const unsubscribeOutput = getBridge().onCodexOutput((payload) => {
    if (!currentSession || payload.sessionId !== currentSession.id || currentSession.signal.aborted) return;
    codexOutputBuffer.append(payload.chunk);
    if (codexOutputBuffer.length >= 4000) flushCodexOutput();
  });
  const unsubscribeVisibility = getBridge().onVisibility((visible) => {
    appVisible = visible;
    document.body.dataset.hidden = String(!visible || document.hidden);
    view.visibilityChanged();
  });
  window.addEventListener("beforeunload", () => {
    disconnectRealtime({ silent: true });
    unsubscribeOutput();
    unsubscribeVisibility();
    view.dispose();
  });
  getBridge()
    .getCapabilities()
    .then((capabilities) => {
      capabilitiesEl.textContent = `Microphone: ${capabilities.microphone}. Accessibility: ${capabilities.accessibility}. Codex: ${capabilities.codex.available ? "ready" : "not installed (optional)"}. CUA: ${capabilities.cua.available ? "ready" : "not installed (optional)"}. ${capabilities.screenAudio}`;
    })
    .catch(() => {
      capabilitiesEl.textContent = "Capability diagnostics are unavailable. Standalone voice can still be used.";
    });
  refreshMediaDevices(false).catch(() => {});
  updateModeControls();
} catch (error) {
  log(error.message);
  setStatus("Bridge error");
}

debugPanel.addEventListener("toggle", () => view.invalidate());
document.addEventListener("visibilitychange", () => {
  document.body.dataset.hidden = String(!appVisible || document.hidden);
  view.visibilityChanged();
});
document.querySelector("#dismissError").addEventListener("click", hideError);
document.querySelector("#changeKey").addEventListener("click", () => {
  revealApiKeyField();
  apiKeyInput.focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingAction) {
    event.preventDefault();
    rejectCodexButton.click();
  }
});
