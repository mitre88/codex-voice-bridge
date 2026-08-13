import { hasVirtualAudioDevice, humanizeError, truncateOutput } from "./renderer-utils.js";

// How long the Realtime SDP exchange may take before we give up. The main
// process already times out the token fetch; this bounds the second network
// hop so a hung connection cannot leave the UI stuck on "Connecting" forever.
const OPENAI_CALL_TIMEOUT_MS = 60000;

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
const configEl = document.querySelector("#config");

const activeSessions = [];
const handledToolCalls = new Set();
let pendingAction;
let pendingActionTimer;
let actionTimeoutMs = 120000;
let actionDataChannel;
let hasStoredKey = false;
let sourceCaption = "";
let outputCaption = "";
let baseConfigText = "";
let lastMediaDevices = [];
let warnedMissingVirtualAudio = false;

function getBridge() {
  if (!window.voiceBridge) throw new Error("Electron preload bridge is unavailable.");
  return window.voiceBridge;
}

function tryBridge() {
  return window.voiceBridge;
}

window.addEventListener("error", (event) => {
  tryBridge()?.log("window.error", { message: event.message, filename: event.filename, lineno: event.lineno });
});

window.addEventListener("unhandledrejection", (event) => {
  tryBridge()?.log("window.unhandledrejection", { reason: String(event.reason), stack: event.reason?.stack });
});

function setStatus(text) {
  statusEl.textContent = text;
  document.body.dataset.state = text.toLowerCase().replace(/\s+/g, "-");
}

function log(message, data) {
  const suffix = data ? `\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}` : "";
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${message}${suffix}\n${logEl.textContent}`;
  // Cap the in-memory log so long Codex streams cannot grow the DOM forever.
  if (logEl.textContent.length > 50000) logEl.textContent = logEl.textContent.slice(0, 50000);
  tryBridge()?.log("ui", { message, data }).catch(() => {});
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
  sourceCaption = "";
  outputCaption = "";
  renderCaptions();
}

function renderCaptions() {
  sourceCaptionEl.textContent = sourceCaption.trim() || "...";
  outputCaptionEl.textContent = outputCaption.trim() || "...";
}

function appendCaption(kind, text, replace = false) {
  if (!text) return;
  if (kind === "source") sourceCaption = replace ? text : `${sourceCaption}${text}`;
  else outputCaption = replace ? text : `${outputCaption}${text}`;
  renderCaptions();
}

function handleTranscriptEvent(event, targets = { source: "source", output: "output" }) {
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
  else if (action.kind === "codex") pendingPromptEl.value = action.args?.prompt || "";
  else pendingPromptEl.value = JSON.stringify(action.args || {}, null, 2);
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
  setStatus(action.kind === "codex" ? "Codex running" : "CUA running");
  let result;
  try {
    result =
      action.kind === "codex"
        ? await getBridge().runCodex({ prompt: action.args.prompt, cwd: action.args.cwd })
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
  sendFunctionOutput(action.callId, result);
  setStatus("Listening");
  log("Local action finished.", result);
}

async function handleToolEvent(event) {
  const functionCall = getFunctionCall(event);
  if (
    !functionCall ||
    !["run_codex", "run_cua_driver", "open_app", "type_text_in_front_app", "press_key_in_front_app"].includes(functionCall.name)
  ) {
    return;
  }
  if (handledToolCalls.has(functionCall.callId)) return;
  // Tool call ids are unique per session and never replayed after the fact, so
  // dropping the whole dedupe set when it gets large is safe and keeps memory bounded.
  if (handledToolCalls.size >= 1000) handledToolCalls.clear();
  handledToolCalls.add(functionCall.callId);

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
  const isMacAction = ["open_app", "type_text_in_front_app", "press_key_in_front_app"].includes(functionCall.name);
  const action = {
    kind: functionCall.name === "run_codex" ? "codex" : functionCall.name === "run_cua_driver" ? "cua" : "mac",
    callId: functionCall.callId,
    args: isMacAction ? { action: functionCall.name, ...args } : args,
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
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function refreshMediaDevices(promptForLabels = false) {
  let permissionStream;
  if (promptForLabels) permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    lastMediaDevices = devices;
    setSelectOptions(myMicDeviceInput, devices.filter((device) => device.kind === "audioinput"), "Default microphone");
    setSelectOptions(interviewerAudioDeviceInput, devices.filter((device) => device.kind === "audioinput"), "Default input");
    setSelectOptions(spanishOutputDeviceInput, devices.filter((device) => device.kind === "audiooutput"), "Default output");
    setSelectOptions(englishOutputDeviceInput, devices.filter((device) => device.kind === "audiooutput"), "Default output");
    updateInterviewAudioWarning(devices);
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
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

async function connectPeerSession({ label, tokenOptions, inputStream, outputDeviceId, transcriptTargets, enableTools = false }) {
  const token = await getBridge().createClientSecret(tokenOptions);
  const pc = new RTCPeerConnection();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  try {
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
      signal: AbortSignal.timeout(OPENAI_CALL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${label}: Realtime call failed: ${response.status} ${await response.text()}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
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

async function connectSingleRealtime(options) {
  // Respect the microphone selected in the UI (it was previously ignored
  // outside interview mode, silently falling back to the system default).
  const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceConstraint(options.myMicDeviceId) });
  await connectPeerSession({
    label: "Assistant",
    tokenOptions: options,
    inputStream: stream,
    transcriptTargets: { source: "source", output: "output" },
    enableTools: options.mode === "assistant",
  });
}

function stopMediaStream(stream) {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Track already stopped.
  }
}

async function connectInterviewRealtime(options) {
  const interviewerStream = await getInterviewAudioStream(options);
  let myMicStream;
  try {
    myMicStream = await navigator.mediaDevices.getUserMedia({ audio: deviceConstraint(options.myMicDeviceId) });
    await connectPeerSession({
      label: "Interview to Spanish",
      tokenOptions: { mode: "translate", targetLanguage: "es" },
      inputStream: interviewerStream,
      outputDeviceId: options.spanishOutputDeviceId,
      transcriptTargets: { source: null, output: "source" },
    });
    await connectPeerSession({
      label: "My reply to English",
      tokenOptions: { mode: "translate", targetLanguage: "en" },
      inputStream: myMicStream,
      outputDeviceId: options.englishOutputDeviceId,
      transcriptTargets: { source: null, output: "output" },
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
  handledToolCalls.clear();
  resetCaptions();
  try {
    await ensureApiKeyReady();
    await refreshMediaDevices(false).catch(() => {});
    const options = getVoiceOptions();
    if (options.mode === "interview") await connectInterviewRealtime(options);
    else await connectSingleRealtime(options);
    setStatus("Listening");
    disconnectButton.disabled = false;
  } catch (error) {
    disconnectRealtime({ silent: true });
    log(humanizeError(error));
    setStatus("Error");
    connectButton.disabled = false;
  }
}

function disconnectRealtime(options = {}) {
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
  if (!options.silent) {
    setStatus("Idle");
    log("Disconnected.");
  }
}

function sendFunctionOutput(callId, output) {
  const messages = [
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(truncateOutput(output)) },
    }),
    JSON.stringify({ type: "response.create" }),
  ];
  const send = () => {
    // The channel can close between the readyState check and send() (e.g. the
    // user disconnected while a long Codex run was finishing); send() on a
    // closing/closed channel throws InvalidStateError, so guard both the state
    // and the call itself.
    if (!actionDataChannel || actionDataChannel.readyState !== "open") {
      log("Data channel closed before the function output could be sent.");
      return;
    }
    try {
      messages.forEach((message) => actionDataChannel.send(message));
    } catch (error) {
      log("Function output could not be sent; data channel closed.", String(error));
    }
  };
  if (actionDataChannel && actionDataChannel.readyState === "open") {
    send();
    return;
  }
  // Dropping the output here would leave the Realtime session waiting forever
  // for a tool response (e.g. the user approved an action right after connect,
  // before the data channel finished opening). Wait briefly instead.
  if (!actionDataChannel) {
    log("No data channel to deliver function output.");
    return;
  }
  const channel = actionDataChannel;
  const timeout = setTimeout(() => {
    log("Data channel did not open in time; function output dropped.");
  }, 5000);
  channel.addEventListener(
    "open",
    () => {
      clearTimeout(timeout);
      send();
    },
    { once: true },
  );
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
    if (config.targetLanguage) targetLanguageInput.value = config.targetLanguage;
    if (config.actionTimeoutMs) actionTimeoutMs = config.actionTimeoutMs;
    baseConfigText = `v${config.version || "?"} / ${config.model} / ${config.translateModel} / ${config.transcribeModel} / ${(config.shortcut || "CommandOrControl+Shift+Space").replace(/CommandOrControl/g, "Cmd")}`;
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
