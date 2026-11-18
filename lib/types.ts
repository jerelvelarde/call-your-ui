/** Types for the UI agent hook (generated panels). */

export type DrawTarget = "new" | "current";

/** Where a draw request came from. */
export type HandoffSource = "voice" | "typed" | "click";

export type HandoffStatus = "drawing" | "ready" | "error";

/** One request to the UI agent, shown on the timeline next to the captions. */
export interface Handoff {
  id: string;
  /** The voice model's call id when source is "voice". */
  callId: string | null;
  brief: string;
  target: DrawTarget;
  source: HandoffSource;
  status: HandoffStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface DrawRequest {
  brief: string;
  target: DrawTarget;
  source: HandoffSource;
  callId?: string;
  /** Aborting it cancels the request: a queued one never starts, and a running one is stopped. */
  signal?: AbortSignal;
}

export interface DrawResult {
  ok: boolean;
  /** How long the UI agent's run took. */
  ms: number;
  error?: string;
}
