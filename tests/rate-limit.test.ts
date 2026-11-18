import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/server/rate-limit";

describe("createRateLimiter", () => {
  it("allows limit requests per window then refuses with retryAfterMs", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.check("ip", 0)).toEqual({ ok: true });
    expect(limiter.check("ip", 10_000)).toEqual({ ok: true });
    expect(limiter.check("ip", 20_000)).toEqual({ ok: true });
    expect(limiter.check("ip", 30_000)).toEqual({ ok: false, retryAfterMs: 30_000 });
    expect(limiter.check("other", 30_000)).toEqual({ ok: true });
  });

  it("a new window allows again", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.check("ip", 0).ok).toBe(true);
    expect(limiter.check("ip", 999).ok).toBe(false);
    expect(limiter.check("ip", 1_000).ok).toBe(true);
  });
});
