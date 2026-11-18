/**
 * Mints a short-lived GPT Realtime client secret for the browser. The real key never leaves the server;
 * the browser gets an `ek_…` secret that is only good for opening one session in the next ten minutes.
 * The call sends its instructions and tools itself (session.update), from what CopilotKit has registered.
 *
 * The origin check and the rate limit are speed bumps for someone running their own copy. Before
 * deploying this publicly, put real authentication in front of it: every call is billed per minute.
 */
import { DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_VOICE, TRANSCRIPTION_MODEL } from "@/lib/config";
import { createRateLimiter } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const NO_STORE = { "Cache-Control": "no-store" };
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

interface ClientSecretResponse {
  value?: unknown;
  expires_at?: unknown;
  error?: { message?: unknown };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export async function POST(request: Request) {
  // Browsers always send Sec-Fetch-Site; a request without it (curl, a script) is refused too.
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return json({ error: "Only this app's own page can start a voice session." }, 403);
  }

  const limit = limiter.check(clientKey(request));
  if (!limit.ok) {
    const seconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return json({ error: `Too many calls started. Try again in ${seconds}s.` }, 429, { "Retry-After": String(seconds) });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json({ error: "OPENAI_API_KEY is not set in .env.local" }, 503);

  const model = process.env.REALTIME_MODEL || DEFAULT_REALTIME_MODEL;
  const voice = process.env.REALTIME_VOICE || DEFAULT_REALTIME_VOICE;

  const body = {
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",
      model,
      instructions: "",
      output_modalities: ["audio"],
      reasoning: { effort: "low" },
      audio: {
        input: {
          transcription: { model: TRANSCRIPTION_MODEL },
          turn_detection: { type: "semantic_vad", eagerness: "auto" },
        },
        output: { voice },
      },
    },
  };

  let res: Response;
  try {
    res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: `Could not reach OpenAI: ${message}` }, 502);
  }

  const text = await res.text();
  let data: ClientSecretResponse | null = null;
  try {
    data = JSON.parse(text) as ClientSecretResponse;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message =
      typeof data?.error?.message === "string" && data.error.message
        ? data.error.message
        : `OpenAI returned ${res.status} ${res.statusText}`.trim();
    return json({ error: message }, res.status >= 400 && res.status < 600 ? res.status : 502);
  }

  if (typeof data?.value !== "string" || !data.value) {
    return json({ error: "OpenAI did not return a client secret." }, 502);
  }

  return json({ value: data.value, expires_at: data.expires_at ?? null, model });
}
