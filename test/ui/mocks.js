// Runs only via Playwright addInitScript in the isolated harness main world.
(() => {
  const tracks = [],
    peers = [],
    sent = [];
  let mediaRequests = 0;
  const options = {};
  class Track extends EventTarget {
    stopped = false;
    stop() {
      this.stopped = true;
    }
  }
  function stream(display = false) {
    const audio = new Track();
    tracks.push(audio);
    const video = display ? new Track() : null;
    if (video) tracks.push(video);
    return {
      getTracks: () => (video ? [audio, video] : [audio]),
      getAudioTracks: () => [audio],
      getVideoTracks: () => (video ? [video] : []),
    };
  }
  let devices = [
    { kind: "audioinput", deviceId: "microphone", label: "Test microphone" },
    { kind: "audioinput", deviceId: "meeting", label: "Meeting virtual input" },
    { kind: "audiooutput", deviceId: "headphones", label: "Studio headphones" },
    { kind: "audiooutput", deviceId: "virtual", label: "BlackHole meeting output" },
  ];
  const media = new EventTarget();
  media.enumerateDevices = async () => devices;
  const acquire = async (display) => {
    mediaRequests++;
    if (options.mediaDelay) await new Promise((r) => setTimeout(r, options.mediaDelay));
    if (options.mediaDenied) throw new DOMException("Denied mock permission", "NotAllowedError");
    return stream(display);
  };
  media.getUserMedia = () => acquire(false);
  media.getDisplayMedia = () => acquire(true);
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  class Channel extends EventTarget {
    readyState = "connecting";
    close() {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
    send(value) {
      sent.push(JSON.parse(value));
    }
  }
  class Peer extends EventTarget {
    connectionState = "new";
    iceConnectionState = "new";
    channel = new Channel();
    closed = false;
    constructor() {
      super();
      peers.push(this);
    }
    addTrack() {}
    createDataChannel() {
      return this.channel;
    }
    async createOffer() {
      return { sdp: "v=0\r\nm=audio 9 RTP/AVP 0\r\n" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {
      if (options.neverReady) return;
      this.connectionState = "connected";
      this.channel.readyState = "open";
      this.dispatchEvent(new Event("connectionstatechange"));
      this.channel.dispatchEvent(new Event("open"));
    }
    close() {
      this.closed = true;
      this.connectionState = "closed";
      this.dispatchEvent(new Event("connectionstatechange"));
    }
  }
  window.RTCPeerConnection = Peer;
  HTMLMediaElement.prototype.setSinkId = async function (id) {
    if (options.sinkFails) throw new Error("Mock sink disconnected");
    this.dataset.effectiveSink = id;
  };
  window.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\n",
  });
  window.__fixture = {
    configure(value) {
      Object.assign(options, value);
    },
    devices(value) {
      devices = value;
      media.dispatchEvent(new Event("devicechange"));
    },
    event(payload, index = peers.length - 1) {
      peers[index].channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    },
    stats() {
      return {
        mediaRequests,
        liveTracks: tracks.filter((t) => !t.stopped).length,
        livePeers: peers.filter((p) => !p.closed).length,
        sent,
        trackCount: tracks.length,
      };
    },
    burst(count) {
      for (let i = 0; i < count; i++)
        this.event({ type: "response.output_audio_transcript.delta", delta: "A clear thought. " });
    },
  };
})();
