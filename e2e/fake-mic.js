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

  const NativePC = window.RTCPeerConnection;
  function RecordingPC(...args) {
    const pc = new NativePC(...args);
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
