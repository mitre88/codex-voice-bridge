import assert from "node:assert/strict";
import { test } from "node:test";

import { deferred, Peer, fixture } from "./helpers/session-fixture.js";

test("cancel during pending token stops the already owned microphone and peer immediately", async () => {
  const token = deferred();
  const f = fixture({ createToken: () => token.promise });
  const pending = f.c.start([f.route()]);
  await new Promise((r) => setImmediate(r));
  f.c.dispose();
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.peers[0].closed, 1);
  await assert.rejects(pending, /cancel/i);
  token.resolve({ value: "late" });
  assert.equal(f.c.resources.size, 0);
});
test("late media grant after cancel is stopped before token or peer use", async () => {
  const media = deferred();
  let tokens = 0;
  const f = fixture({
    createToken: async () => {
      tokens++;
      return { value: "x" };
    },
  });
  const pending = f.c.start([{ label: "Voice", acquire: () => media.promise }]);
  await new Promise((r) => setImmediate(r));
  f.c.dispose();
  await assert.rejects(pending, /cancel/i);
  media.resolve(f.stream());
  await new Promise((r) => setImmediate(r));
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(tokens, 0);
  assert.equal(f.peers.length, 0);
});
test("50 complete connect/disconnect cycles release every resource", async () => {
  for (let i = 0; i < 50; i++) {
    const f = fixture();
    await f.c.start([f.route()]);
    assert.equal(f.c.ready, true);
    f.c.dispose();
    f.c.dispose();
    assert.equal(f.c.resources.size, 0);
    assert.equal(f.tracks[0].stops, 1);
    assert.equal(f.peers[0].closed, 1);
    assert.equal(f.audios[0].srcObject, null);
  }
});
test("SDP completion alone never means ready; timeout rolls back", async () => {
  const f = fixture({
    timeoutMs: 15,
    createPeer: () => {
      const p = new Peer();
      p.setRemoteDescription = async () => {};
      return p;
    },
  });
  await assert.rejects(f.c.start([f.route()]), /timed out/i);
  assert.equal(f.c.ready, false);
  assert.equal(f.tracks[0].stops, 1);
});
test("one failed interview leg rolls back both parallel routes", async () => {
  let calls = 0;
  const f = fixture({
    createToken: async () => {
      if (++calls === 2) throw new Error("second leg failed");
      return { value: "x" };
    },
  });
  await assert.rejects(f.c.start([f.route(), f.route()]), /second leg/);
  assert.equal(calls, 2);
  assert.ok(f.tracks.every((t) => t.stops === 1));
  assert.ok(f.peers.every((p) => p.closed === 1));
});
test("explicit failed or unsupported sink does not fall back to speakers", async () => {
  for (const audio of [
    { pause() {} },
    {
      pause() {},
      setSinkId: async () => {
        throw new Error("gone");
      },
    },
  ]) {
    const f = fixture({ createAudio: () => audio });
    await assert.rejects(f.c.start([{ ...f.route(), outputDeviceId: "selected-output" }]), /output/i);
    assert.equal(f.c.ready, false);
    assert.ok(f.tracks.every((t) => t.stops === 1));
  }
});
test("track ended, channel close, ICE disconnected and peer failure tear down all routes", async () => {
  for (const trigger of [
    (f) => f.tracks[0].dispatchEvent(new Event("ended")),
    (f) => f.peers[0].channel.close(),
    (f) => {
      f.peers[0].iceConnectionState = "disconnected";
      f.peers[0].dispatchEvent(new Event("iceconnectionstatechange"));
    },
    (f) => {
      f.peers[0].connectionState = "failed";
      f.peers[0].dispatchEvent(new Event("connectionstatechange"));
    },
  ]) {
    let failure;
    const f = fixture({ onFailure: (e) => (failure = e) });
    await f.c.start([f.route(), f.route()]);
    trigger(f);
    assert.equal(f.c.ready, false);
    assert.equal(f.c.resources.size, 0);
    assert.match(failure.message, /Retry/);
  }
});
test("cancel at each asynchronous route stage never permits a stale continuation", async () => {
  for (const stage of ["sink", "token", "offer", "local", "fetch", "body", "remote"]) {
    const hold = deferred();
    const entered = deferred();
    const block = () => {
      entered.resolve();
      return hold.promise;
    };
    const f = fixture();
    const p = new Peer();
    const original = {};
    for (const [s, name] of [
      ["offer", "createOffer"],
      ["local", "setLocalDescription"],
      ["remote", "setRemoteDescription"],
    ])
      if (s === stage) {
        original.peer = p[name].bind(p);
        p[name] = block;
      }
    f.c.dispose();
    const g = fixture({
      createPeer: () => p,
      createAudio: () => ({ pause() {}, setSinkId: stage === "sink" ? block : async () => {} }),
      createToken: stage === "token" ? block : async () => ({ value: "x" }),
      fetch:
        stage === "fetch"
          ? block
          : async () => ({ ok: true, text: stage === "body" ? block : async () => "v=0\r\nm=audio 9 RTP/AVP 0\r\n" }),
    });
    const pending = g.c.start([{ ...g.route(), outputDeviceId: "out" }]);
    await entered.promise;
    g.c.dispose();
    await assert.rejects(pending, /cancel/i);
    assert.equal(g.tracks[0].stops, 1);
    hold.resolve(
      stage === "offer"
        ? { sdp: "v=0\r\n" }
        : stage === "token"
          ? { value: "x" }
          : stage === "fetch"
            ? { ok: true, text: async () => "v=0\r\n" }
            : "v=0\r\n",
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(g.c.ready, false);
    assert.equal(g.c.resources.size, 0);
  }
});
