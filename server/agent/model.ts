/**
 * The model that writes A2UI Express: OpenAI chat completions, streamed.
 *
 *   OPENAI_API_KEY        required
 *   COMPOSER_MODEL        default DEFAULT_COMPOSER_MODEL (lib/config.ts)
 *   COMPOSER_REASONING    reasoning effort, default "low"
 *
 * The composer takes the call as a `ModelStream`, so the smoke test can run it offline
 * with a canned reply.
 */
import OpenAI from "openai";
import { DEFAULT_COMPOSER_MODEL } from "@/lib/config";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Streams the model's reply as text chunks. Honours `signal`. */
export type ModelStream = (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>;

/** A plain, user-facing error: the run ends with RUN_ERROR and this message. */
export class PlainError extends Error {
  readonly plain = true;
}

export const MISSING_KEY_MESSAGE = "OPENAI_API_KEY is not set in .env.local";

/** The longest reply the composer accepts. A large dashboard is well under it. */
const MAX_COMPLETION_TOKENS = 6000;

type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
const EFFORTS: readonly Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** The model id the composer runs on. */
export const composerModel = () => process.env.COMPOSER_MODEL?.trim() || DEFAULT_COMPOSER_MODEL;

function reasoningEffort(): Effort {
  const value = process.env.COMPOSER_REASONING?.trim().toLowerCase() ?? "low";
  return (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : "low";
}

/**
 * The OpenAI model call. Throws a `PlainError` at once when `OPENAI_API_KEY` is unset, so a
 * run fails before it draws anything.
 */
export function openAIModelStream(): ModelStream {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new PlainError(MISSING_KEY_MESSAGE);
  const client = new OpenAI({ apiKey });
  const model = composerModel();
  const reasoning_effort = reasoningEffort();
  return async function* stream(messages, signal) {
    const res = await client.chat.completions.create(
      {
        model,
        stream: true,
        reasoning_effort,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages,
      },
      { signal },
    );
    for await (const chunk of res) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  };
}

/** What the user reads when the model call fails. The raw error stays in the server log. */
export function modelErrorMessage(err: unknown): string {
  if (err instanceof PlainError) return err.message;
  const status = (err as { status?: unknown })?.status;
  if (err instanceof OpenAI.APIError || typeof status === "number") {
    const model = composerModel();
    if (status === 401) return "OpenAI rejected the API key in .env.local.";
    if (status === 403 || status === 404)
      return `The model ${model} isn't available to this OpenAI key. Set COMPOSER_MODEL in .env.local.`;
    if (status === 429) return "OpenAI is rate limiting this key. Wait a moment and try again.";
    const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
    return `The UI writer's model call failed${detail}`;
  }
  const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
  return `The UI writer failed${detail}`;
}
