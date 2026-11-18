/**
 * A per-key sliding-window limit, in memory. It holds across requests to one server process only:
 * a speed bump for someone running their own copy, not protection for a public deployment.
 */
export interface RateLimiter {
  check(key: string, now?: number): { ok: true } | { ok: false; retryAfterMs: number };
}

export function createRateLimiter({ limit, windowMs }: { limit: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok: false, retryAfterMs: recent[0] + windowMs - now };
      }
      recent.push(now);
      hits.set(key, recent);
      // Keep the map from growing without bound: forget keys with no recent hits.
      if (hits.size > 10_000) {
        for (const [k, times] of hits) if (times.every((t) => t <= now - windowMs)) hits.delete(k);
      }
      return { ok: true };
    },
  };
}
