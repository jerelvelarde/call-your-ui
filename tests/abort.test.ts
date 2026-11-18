import { afterEach, describe, expect, it } from "vitest";
import { connectRealtime, RealtimeError } from "@/lib/copilot-call/client";
import { abortMessage, drawWithDeadline } from "@/lib/copilot-call/deadline";
import type { DrawResult } from "@/lib/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A draw that takes `ms` unless its signal aborts first, like the UI agent's run. */
function fakeDraw(ms: number, seen: { signal?: AbortSignal; stoppedEarly?: boolean }) {
  return (signal: AbortSignal) =>
    new Promise<DrawResult>((resolve) => {
      seen.signal = signal;
      const timer = setTimeout(() => resolve({ ok: true, ms }), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        seen.stoppedEarly = true;
        resolve({ ok: false, ms, error: abortMessage(signal) });
      });
    });
}

describe("drawWithDeadline", () => {
  it("lets a draw that beats the deadline succeed without aborting it", async () => {
    const fast: { signal?: AbortSignal } = {};
    const quick = await drawWithDeadline(fakeDraw(10, fast), 200);
    expect(quick.ok).toBe(true);
    expect(fast.signal?.aborted).toBe(false);
  });

  it("fails a slow draw at the deadline and tells it to stop", async () => {
    const slow: { signal?: AbortSignal; stoppedEarly?: boolean } = {};
    const started = Date.now();
    const late = await drawWithDeadline(fakeDraw(5_000, slow), 50);
    expect(late.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slow.signal?.aborted).toBe(true);
    expect(slow.stoppedEarly).toBe(true);
    expect(late.error).toMatch(/so it was stopped/);
    expect(abortMessage(slow.signal!)).toBe(late.error);
  });

  it("answers at the deadline even when the draw never settles", async () => {
    const stuck = await drawWithDeadline(() => new Promise<DrawResult>(() => {}), 30);
    expect(stuck.ok).toBe(false);
  });
});

interface FakeEnv {
  urls: string[];
  signals: (AbortSignal | undefined)[];
  micAsks: number;
  tracksStopped: number;
}

const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** Stubs fetch and the mic. `token` and `mic` decide when each settles. */
function stubBrowser(opts: { token: "hang" | "ok"; mic: "ok" | ((release: () => void) => void) }): FakeEnv {
  const env: FakeEnv = { urls: [], signals: [], micAsks: 0, tracksStopped: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    env.urls.push(String(input));
    env.signals.push(init?.signal ?? undefined);
    if (opts.token === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Response.json({ value: "ek_test", model: "gpt-realtime-2.1-mini" });
  }) as typeof fetch;
  const track = { enabled: true, stop: () => env.tracksStopped++ };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => {
          env.micAsks++;
          if (opts.mic === "ok") return Promise.resolve(stream);
          const answer = opts.mic;
          return new Promise<MediaStream>((resolve) => answer(() => resolve(stream)));
        },
      },
    },
  });
  return env;
}

async function failureKind(work: Promise<unknown>) {
  try {
    await work;
    return "resolved";
  } catch (error) {
    return error instanceof RealtimeError ? error.kind : String(error);
  }
}

const noop = { onEvent: () => {}, onClose: () => {} };

describe("connectRealtime with a signal", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  });

  it("rejects an already-cancelled connect as aborted without a request", async () => {
    const env = stubBrowser({ token: "ok", mic: "ok" });
    const controller = new AbortController();
    controller.abort();
    expect(await failureKind(connectRealtime({ ...noop, signal: controller.signal }))).toBe("aborted");
    expect(env.urls).toEqual([]);
  });

  it("aborts the token request and never asks for the mic when cancelled while minting", async () => {
    const env = stubBrowser({ token: "hang", mic: "ok" });
    const controller = new AbortController();
    const pending = connectRealtime({ ...noop, signal: controller.signal });
    await sleep(20);
    controller.abort();
    expect(await failureKind(pending)).toBe("aborted");
    expect(env.signals[0]?.aborted).toBe(true);
    expect(env.micAsks).toBe(0);
  });

  it("releases the mic and never calls OpenAI when cancelled during the mic prompt", async () => {
    let release = () => {};
    const env = stubBrowser({ token: "ok", mic: (r) => (release = r) });
    const controller = new AbortController();
    const pending = connectRealtime({ ...noop, signal: controller.signal });
    await sleep(20);
    expect(env.micAsks).toBe(1);
    controller.abort();
    release();
    expect(await failureKind(pending)).toBe("aborted");
    expect(env.tracksStopped).toBe(1);
    expect(env.urls.some((u) => u.includes("api.openai.com"))).toBe(false);
  });
});
