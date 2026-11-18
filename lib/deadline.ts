import type { DrawResult } from "@/lib/types";

/**
 * Runs a draw against a deadline. At the deadline the draw's signal aborts, so a request still waiting in
 * the queue never starts and a view that is streaming stops, and the voice gets its answer at once.
 * Without the abort the voice would say the view failed and then the view would appear anyway.
 */
export function drawWithDeadline(
  draw: (signal: AbortSignal) => Promise<DrawResult>,
  ms: number,
): Promise<DrawResult> {
  const controller = new AbortController();
  const error = `The view took longer than ${Math.round(ms / 1000)}s to draw, so it was stopped. Anything already drawn stays on screen, marked as stopped.`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DrawResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(error));
      resolve({ ok: false, ms, error });
    }, ms);
  });
  return Promise.race([draw(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

/** The message a draw reports when its caller aborted it. */
export function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return "The request for this view was cancelled.";
}
