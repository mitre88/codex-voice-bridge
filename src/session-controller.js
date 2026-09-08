// Browser-safe resource owner. No Electron, DOM globals or real media in tests.
import { isSdpAnswer } from "./renderer-utils.js";

export function createSessionController({
  id,
  createPeer,
  createAudio,
  createToken,
  fetch,
  timeoutMs = 60000,
  onEvent = () => {},
  onFailure = () => {},
}) {
  const abort = new AbortController();
  const resources = new Set();
  const disposers = new Set();
  const stopped = new WeakSet();
  let ready = false;
  let started = false;
  let deadline;
  const cancelled = () => new Error("Connection cancelled. Connect again when ready.");
  function check() {
    if (abort.signal.aborted) throw abort.signal.reason;
  }
  function stop(stream) {
    for (const track of stream?.getTracks() || []) {
      if (stopped.has(track)) continue;
      stopped.add(track);
      try {
        track.stop();
      } catch {
        /* Already released. */
      }
    }
  }
  function own(dispose) {
    if (abort.signal.aborted) {
      dispose();
      return;
    }
    disposers.add(dispose);
  }
  function listen(target, event, handler) {
    target.addEventListener(event, handler);
    own(() => target.removeEventListener(event, handler));
  }
  function dispose(reason = cancelled()) {
    if (abort.signal.aborted) return;
    ready = false;
    clearTimeout(deadline);
    // Invalidate callbacks BEFORE closing tracks/channels (close can emit events).
    abort.abort(reason);
    for (const cleanup of [...disposers].reverse()) {
      try {
        cleanup();
      } catch {
        /* Continue releasing the other resources. */
      }
    }
    disposers.clear();
    resources.clear();
  }
  function fail(reason) {
    if (abort.signal.aborted) return;
    dispose(reason);
    onFailure(reason);
  }
  // A cancellable wait, not a claim that the underlying OS prompt is cancelled.
  // The acquisition's continuation still owns and stops a late media grant.
  function wait(promise) {
    check();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          abort.signal.removeEventListener("abort", onAbort);
          if (abort.signal.aborted) reject(abort.signal.reason);
          else resolve(value);
        },
        (error) => {
          abort.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
  async function acquire(factory) {
    check();
    const promise = Promise.resolve()
      .then(() => {
        check();
        return factory();
      })
      .then((stream) => {
        if (abort.signal.aborted) {
          stop(stream);
          throw abort.signal.reason;
        }
        own(() => stop(stream));
        for (const track of stream.getTracks()) {
          listen(track, "ended", () => fail(new Error("Audio input ended. Reconnect the device, then choose Retry.")));
        }
        return stream;
      });
    return wait(promise);
  }
  async function connectRoute(route) {
    const inputStream = await acquire(route.acquire);
    check();
    const track = inputStream.getAudioTracks()[0];
    if (!track) throw new Error(`${route.label}: no audio was captured. Select an audio input and Retry.`);
    const pc = createPeer();
    own(() => pc.close());
    const audio = createAudio();
    audio.autoplay = true;
    // Neither interview route emits output until BOTH routes are ready.
    audio.muted = true;
    own(() => {
      audio.pause?.();
      audio.srcObject = null;
    });
    pc.addTrack(track, inputStream);
    const dc = pc.createDataChannel(`oai-events-${route.label}`);
    own(() => dc.close());
    const resource = { label: route.label, pc, dc, stream: inputStream, audio, route };
    resources.add(resource);
    let markReady;
    const transportReady = new Promise((resolve) => {
      markReady = resolve;
    });
    const transportChanged = () => {
      if (abort.signal.aborted) return;
      if (
        ["failed", "closed", "disconnected"].includes(pc.connectionState) ||
        ["failed", "closed", "disconnected"].includes(pc.iceConnectionState)
      ) {
        fail(new Error(`${route.label}: audio connection lost. Choose Retry to reconnect explicitly.`));
      } else if (pc.connectionState === "connected" && dc.readyState === "open") markReady();
    };
    listen(pc, "connectionstatechange", transportChanged);
    listen(pc, "iceconnectionstatechange", transportChanged);
    listen(dc, "open", transportChanged);
    listen(dc, "close", () => fail(new Error(`${route.label}: data channel closed. Choose Retry.`)));
    listen(dc, "error", () => fail(new Error(`${route.label}: data channel failed. Choose Retry.`)));
    listen(pc, "track", (event) => {
      if (!abort.signal.aborted) audio.srcObject = event.streams[0];
    });
    listen(dc, "message", (event) => {
      if (!ready || abort.signal.aborted) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      // Handler failures must not become unhandled rejections from EventTarget.
      Promise.resolve()
        .then(() => {
          if (ready && !abort.signal.aborted) return onEvent(payload, resource);
        })
        .catch((error) => fail(error));
    });
    if (route.outputDeviceId) {
      if (typeof audio.setSinkId !== "function")
        throw new Error(
          `${route.label}: output selection is unavailable. Explicitly choose Default output or use a supported runtime.`,
        );
      try {
        await wait(audio.setSinkId(route.outputDeviceId));
      } catch (error) {
        check();
        throw new Error(
          `${route.label}: selected output is unavailable. Reconnect it or explicitly choose Default output.`,
          { cause: error },
        );
      }
    }
    check();
    const token = await wait(createToken({ ...route.tokenOptions, sessionId: id }));
    check();
    const offer = await wait(pc.createOffer());
    check();
    await wait(pc.setLocalDescription(offer));
    check();
    const endpoint = token.callEndpoint || "https://api.openai.com/v1/realtime/calls";
    if (!/^https:\/\/api\.openai\.com\/v1\/realtime\/(?:translations\/)?calls$/.test(endpoint))
      throw new Error("Unexpected Realtime endpoint.");
    const response = await wait(
      fetch(endpoint, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/sdp" },
        signal: abort.signal,
      }),
    );
    const sdp = await wait(response.text());
    if (!response.ok) throw new Error(`${route.label}: Realtime call failed: ${response.status}`);
    if (!isSdpAnswer(sdp))
      throw new Error(
        `${route.label}: unexpected response instead of an SDP answer. Check for a proxy or captive portal.`,
      );
    check();
    await wait(pc.setRemoteDescription({ type: "answer", sdp }));
    transportChanged();
    await wait(transportReady);
    return resource;
  }
  async function start(routes) {
    if (started) throw new Error("A connection owner can only be started once.");
    started = true;
    check();
    deadline = setTimeout(
      () => fail(new Error(`Connection timed out after ${timeoutMs / 1000}s. Choose Retry.`)),
      timeoutMs,
    );
    try {
      const connected = await Promise.all(routes.map(connectRoute));
      check();
      ready = true;
      clearTimeout(deadline);
      for (const resource of connected) resource.audio.muted = false;
      return connected;
    } catch (error) {
      dispose(error);
      throw error;
    }
  }
  return {
    id,
    resources,
    signal: abort.signal,
    wait,
    acquire,
    start,
    dispose,
    get ready() {
      return ready;
    },
  };
}
