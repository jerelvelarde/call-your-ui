import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/realtime/session/route";

function request(ip: string, site = "same-origin") {
  return new Request("http://localhost:3300/api/realtime/session", {
    method: "POST",
    headers: { "sec-fetch-site": site, "x-forwarded-for": `${ip}, 10.0.0.1` },
  });
}

describe("POST /api/realtime/session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses a cross-site request with 403", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const res = await POST(request("1.0.0.1", "cross-site"));
    expect(res.status).toBe(403);
  });

  it("returns 503 without OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await POST(request("1.0.0.2"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "OPENAI_API_KEY is not set in .env.local" });
  });

  it("returns 429 with Retry-After after 10 requests", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    for (let i = 0; i < 10; i++) expect((await POST(request("1.0.0.3"))).status).toBe(503);
    const res = await POST(request("1.0.0.3"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("posts the session config to OpenAI and returns the secret", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ value: "ek_123", expires_at: 1_800_000_000 });
    });
    const res = await POST(request("1.0.0.4"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "ek_123", expires_at: 1_800_000_000, model: "gpt-realtime-2.1-mini" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 600 });
    expect(body.session.type).toBe("realtime");
    expect(body.session.audio.input.turn_detection).toEqual({ type: "semantic_vad", eagerness: "auto" });
    expect(body.session.audio.input.transcription).toEqual({ model: "gpt-4o-mini-transcribe" });
    expect(body.session.tools).toBeUndefined();
  });

  it("passes an OpenAI error message through with its status", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubGlobal("fetch", async () => Response.json({ error: { message: "Incorrect API key provided." } }, { status: 401 }));
    const res = await POST(request("1.0.0.5"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Incorrect API key provided." });
  });
});
