/**
 * The browser side of a GPT Realtime session over WebRTC: mint a client secret, open the mic, exchange
 * SDP with OpenAI, play the model's audio and carry events on the "oai-events" data channel.
 */
import type { RealtimeClientEvent, RealtimeServerEvent } from "./events";
import { createResponseSequencer } from "./sequencer";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const OPEN_TIMEOUT_MS = 15_000;

export type RealtimeErrorKind = "no_key" | "token" | "mic" | "connection" | "aborted";

/** A failure the page can show in plain words. */
export class RealtimeError extends Error {
  readonly kind: RealtimeErrorKind;
  constructor(kind: RealtimeErrorKind, message: string) {
    super(message);
    this.name = "RealtimeError";
    this.kind = kind;
  }
}

export interface RealtimeLevels {
  /** Mic loudness, 0..1. */
  input: number;
  /** The model's voice loudness, 0..1. */
  output: number;
}

export interface RealtimeConnection {
  /** The model the session runs on, as the token route reported it. */
  readonly model: string;
  /** Send one event right away. */
  send(event: RealtimeClientEvent): void;
  /** Send a group of events now, or after the active response is done (see sequencer.ts). */
  turn(...events: RealtimeClientEvent[]): void;
  setMuted(muted: boolean): void;
  getLevels(): RealtimeLevels;
  close(): void;
}

export interface ConnectOptions {
  /** This app's route that mints a short-lived client secret (POST). */
  sessionUrl: string;
  onEvent: (event: RealtimeServerEvent) => void;
  /** The session ended without `close()` being called (network drop, the server hung up). */
  onClose: (reason: string) => void;
  /**
   * Aborting it gives up on the connect: its requests are cancelled, nothing is left open, and the promise
   * rejects with an "aborted" RealtimeError. A mic prompt already on screen can't be withdrawn, but the
   * mic is released as soon as the user answers it. It has no effect once the connection is returned.
   */
  signal?: AbortSignal;
}

const aborted = () => new RealtimeError("aborted", "The voice session was cancelled.");

interface TokenResponse {
  value?: string;
  expires_at?: number | null;
  model?: string;
  error?: string;
}

async function fetchToken(sessionUrl: string, signal?: AbortSignal): Promise<{ value: string; model: string }> {
  let res: Response;
  try {
    res = await fetch(sessionUrl, { method: "POST", cache: "no-store", signal });
  } catch {
    throw new RealtimeError("token", "Could not reach this app's server to start the voice session.");
  }
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    // Not JSON: a crashed route or a proxy page. Fall through with the status.
  }
  if (!res.ok || !body.value) {
    const message = body.error || `The voice session could not start (${res.status}).`;
    throw new RealtimeError(/OPENAI_API_KEY/.test(message) ? "no_key" : "token", message);
  }
  return { value: body.value, model: body.model ?? "" };
}

async function openMic(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new RealtimeError("mic", "This browser can't use a microphone here. Open the app on localhost or over HTTPS.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new RealtimeError("mic", "Microphone access is blocked. Allow it for this site and try again.");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new RealtimeError("mic", "No microphone was found. Plug one in and try again.");
    }
    if (name === "NotReadableError") {
      throw new RealtimeError("mic", "The microphone is in use by another app.");
    }
    throw new RealtimeError("mic", "The microphone could not be opened.");
  }
}

/** Loudness of a stream from its waveform, smoothed by the analyser, as 0..1. */
function meter(ctx: AudioContext, stream: MediaStream) {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  // Not connected to the destination: the <audio> element plays the voice, and the mic must not echo.
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  return {
    read() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // Speech sits around 0.02–0.2 RMS; spread that over 0..1.
      return Math.min(1, rms * 4.5);
    },
    disconnect() {
      try {
        source.disconnect();
      } catch {}
    },
  };
}

function waitForOpen(channel: RTCDataChannel, pc: RTCPeerConnection, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted());
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new RealtimeError("connection", "The voice connection timed out.")), OPEN_TIMEOUT_MS);
    const onState = () => {
      if (pc.connectionState === "failed") {
        done(new RealtimeError("connection", "The voice connection failed. Check your network and try again."));
      }
    };
    const onOpen = () => done();
    const onClose = () => done(new RealtimeError("connection", "The voice connection closed before it opened."));
    const onAbort = () => done(aborted());
    function done(error?: Error) {
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      pc.removeEventListener("connectionstatechange", onState);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    pc.addEventListener("connectionstatechange", onState);
    signal?.addEventListener("abort", onAbort);
  });
}

async function readCallError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {}
  return text.trim().slice(0, 300) || `${res.status} ${res.statusText}`.trim();
}

/**
 * Opens a Realtime session. Call it from a user gesture (a tap): the audio context is created before the
 * first await, so the browser lets it play.
 */
export async function connectRealtime({ sessionUrl, onEvent, onClose, signal }: ConnectOptions): Promise<RealtimeConnection> {
  if (signal?.aborted) throw aborted();
  /** Called after every await: a cancelled connect stops there, and the catch below releases what it opened. */
  const checkpoint = () => {
    if (signal?.aborted) throw aborted();
  };

  const AudioCtx: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  const ctx = AudioCtx ? new AudioCtx() : null;
  void ctx?.resume().catch(() => {});

  let mic: MediaStream | null = null;
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  const audio = typeof document === "undefined" ? null : document.createElement("audio");
  let inputMeter: ReturnType<typeof meter> | null = null;
  let outputMeter: ReturnType<typeof meter> | null = null;
  let closed = false;

  const teardown = () => {
    closed = true;
    inputMeter?.disconnect();
    outputMeter?.disconnect();
    try {
      channel?.close();
    } catch {}
    try {
      pc?.getSenders().forEach((s) => s.track?.stop());
      pc?.close();
    } catch {}
    mic?.getTracks().forEach((t) => t.stop());
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
    void ctx?.close().catch(() => {});
  };

  try {
    const token = await fetchToken(sessionUrl, signal);
    // Cancelled while the secret was minted: stop before the browser asks for the mic.
    checkpoint();
    mic = await openMic();
    checkpoint();

    pc = new RTCPeerConnection();
    const peer = pc;

    if (audio) {
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      audio.hidden = true;
      document.body.appendChild(audio);
    }
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (audio) {
        audio.srcObject = stream;
        void audio.play().catch(() => {});
      }
      if (ctx && !outputMeter) outputMeter = meter(ctx, stream);
    });

    for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);
    if (ctx) inputMeter = meter(ctx, mic);

    // The events channel has to exist before the offer, or it is not negotiated.
    channel = peer.createDataChannel("oai-events");
    const events = channel;

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    checkpoint();

    let res: Response;
    try {
      res = await fetch(CALLS_URL, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/sdp" },
        signal,
      });
    } catch {
      throw new RealtimeError("connection", "Could not reach OpenAI to start the voice session.");
    }
    if (!res.ok) {
      throw new RealtimeError("connection", `OpenAI refused the voice session: ${await readCallError(res)}`);
    }
    const answer = await res.text();
    checkpoint();
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    checkpoint();

    const send = (event: RealtimeClientEvent) => {
      if (events.readyState === "open") events.send(JSON.stringify(event));
    };
    const sequencer = createResponseSequencer(send);

    events.addEventListener("message", (message: MessageEvent) => {
      let event: RealtimeServerEvent;
      try {
        event = JSON.parse(String(message.data)) as RealtimeServerEvent;
      } catch {
        return;
      }
      if (!event || typeof event.type !== "string") return;
      sequencer.handle(event);
      onEvent(event);
    });

    await waitForOpen(events, peer, signal);

    const lost = (reason: string) => {
      if (closed) return;
      teardown();
      sequencer.reset();
      onClose(reason);
    };
    events.addEventListener("close", () => lost("The voice session ended."));
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed") lost("The voice connection dropped. Check your network and call again.");
    });

    const mic$ = mic;
    return {
      model: token.model,
      send,
      turn: (...e) => sequencer.turn(...e),
      setMuted(muted) {
        mic$.getAudioTracks().forEach((t) => (t.enabled = !muted));
      },
      getLevels() {
        if (closed) return { input: 0, output: 0 };
        const muted = mic$.getAudioTracks().every((t) => !t.enabled);
        return {
          input: muted ? 0 : (inputMeter?.read() ?? 0),
          output: outputMeter?.read() ?? 0,
        };
      },
      close() {
        if (closed) return;
        sequencer.reset();
        teardown();
      },
    };
  } catch (error) {
    teardown();
    // Whatever failed after a cancel (an aborted fetch, a checkpoint), the caller gets one plain answer.
    if (signal?.aborted) throw aborted();
    if (error instanceof RealtimeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RealtimeError("connection", `The voice session could not start: ${message}`);
  }
}
