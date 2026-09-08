import { createSessionController } from "../../src/session-controller.js";
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
export class Track extends EventTarget {
  stops = 0;
  stop() {
    this.stops++;
  }
}
export class Channel extends EventTarget {
  readyState = "connecting";
  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
export class Peer extends EventTarget {
  connectionState = "new";
  iceConnectionState = "new";
  channel = new Channel();
  closed = 0;
  addTrack() {}
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { sdp: "v=0\r\n" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
    this.channel.readyState = "open";
    this.channel.dispatchEvent(new Event("open"));
  }
  close() {
    this.closed++;
    this.connectionState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}
export function fixture(overrides = {}) {
  const tracks = [],
    peers = [],
    audios = [];
  const stream = () => {
    const track = new Track();
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const c = createSessionController({
    id: "session-1",
    timeoutMs: 200,
    createPeer: () => {
      const p = new Peer();
      peers.push(p);
      return p;
    },
    createAudio: () => {
      const a = { srcObject: null, muted: false, pause() {}, setSinkId: async () => {} };
      audios.push(a);
      return a;
    },
    createToken: async () => ({ value: "ephemeral", callEndpoint: "https://api.openai.com/v1/realtime/calls" }),
    fetch: async () => ({
      ok: true,
      text: async () => "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    }),
    ...overrides,
  });
  return {
    c,
    tracks,
    peers,
    audios,
    stream,
    route: () => ({ label: "Voice", acquire: async () => stream(), tokenOptions: { mode: "assistant" } }),
  };
}
