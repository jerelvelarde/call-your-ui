// Injected before the app loads (puppeteer evaluateOnNewDocument). The app is unchanged: it still asks
// for the microphone, and gets a stream that is silent until the test plays the caller's next line into
// it. It also records the model's voice (the first remote audio track) for the demo video.
(() => {
  let ctx = null;
  let dest = null;
  const ensure = () => {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 48000 });
      dest = ctx.createMediaStreamDestination();
      // A faint room-noise floor (about -54 dBFS), like a real mic. Pure digital silence makes WebRTC
      // stop sending audio, and then the server's voice detector never hears the caller stop talking.
      const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      const floor = ctx.createBufferSource();
      floor.buffer = noise;
      floor.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0.002;
      floor.connect(gain).connect(dest);
      floor.start();
    }
    return { ctx, dest };
  };

  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return original(constraints);
    const { ctx, dest } = ensure();
    await ctx.resume();
    return new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone()));
  };

  window.__fakeMic = {
    /** Plays one base64 WAV into the mic; resolves when it ends, with wall-clock times. */
    async say(base64) {
      const { ctx, dest } = ensure();
      await ctx.resume();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest);
      const startedAt = Date.now();
      source.start();
      await new Promise((resolve) => (source.onended = resolve));
      return { startedAt, endedAt: Date.now() };
    },
  };

  const remote = { startedAt: null, chunks: [], recorder: null };
  window.__remoteAudio = {
    /** Stops recording; resolves { startedAt, base64 } (webm/opus), or null when nothing was recorded. */
    stop() {
      const rec = remote.recorder;
      if (!rec) return Promise.resolve(null);
      return new Promise((resolve) => {
        rec.onstop = () => {
          const blob = new Blob(remote.chunks, { type: "audio/webm" });
          const reader = new FileReader();
          reader.onload = () => resolve({ startedAt: remote.startedAt, base64: String(reader.result).split(",")[1] });
          reader.readAsDataURL(blob);
        };
        if (rec.state !== "inactive") rec.stop();
        else rec.onstop();
      });
    },
  };

  // Every event on the Realtime data channel, both ways (type plus the fields worth reading), for result.json.
  const events = [];
  window.__events = events;
  const brief = (e) => {
    const out = { t: Date.now(), type: e.type };
    if (e.error) out.error = e.error.message ?? e.error;
    if (e.transcript) out.transcript = e.transcript;
    if (e.response) {
      out.status = e.response.status;
      out.details = e.response.status_details?.error?.message ?? e.response.status_details?.reason;
      out.output = (e.response.output ?? []).map((o) => (o.type === "function_call" ? `${o.name}(${o.status})` : o.type));
    }
    if (e.item?.type === "function_call_output") out.output = e.item.output.slice(0, 160);
    if (e.session) out.session = Object.keys(e.session).join(",");
    return out;
  };
  const NativePC = window.RTCPeerConnection;
  function RecordingPC(...args) {
    const pc = new NativePC(...args);
    const nativeChannel = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (...a) => {
      const channel = nativeChannel(...a);
      channel.addEventListener("message", (m) => {
        try {
          const e = JSON.parse(m.data);
          if (!/delta$/.test(e.type)) events.push({ dir: "in", ...brief(e) });
        } catch {}
      });
      const send = channel.send.bind(channel);
      channel.send = (data) => {
        try {
          events.push({ dir: "out", ...brief(JSON.parse(data)) });
        } catch {}
        return send(data);
      };
      return channel;
    };
    pc.addEventListener("track", (event) => {
      if (event.track.kind !== "audio" || remote.recorder) return;
      const rec = new MediaRecorder(new MediaStream([event.track]), { mimeType: "audio/webm;codecs=opus" });
      rec.ondataavailable = (e) => e.data.size && remote.chunks.push(e.data);
      rec.start(1000);
      remote.recorder = rec;
      remote.startedAt = Date.now();
    });
    return pc;
  }
  RecordingPC.prototype = NativePC.prototype;
  Object.setPrototypeOf(RecordingPC, NativePC);
  window.RTCPeerConnection = RecordingPC;
})();
