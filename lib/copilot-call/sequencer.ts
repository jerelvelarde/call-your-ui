/**
 * Only one Realtime response may be active at a time. The sequencer holds client "turns" (a group of
 * events that usually ends in `response.create`) while a response is active and sends the next one
 * when `response.done` arrives. Pure: no DOM, no timers, so the smoke test runs it in Node.
 */
import type { RealtimeClientEvent } from "./events";

/** The fields of a server event the sequencer reads. */
export interface SequencerServerEvent {
  type: string;
  /** On an `error` event: `{ code, message, … }`. */
  error?: unknown;
}

function errorCode(event: SequencerServerEvent): string | undefined {
  const error = event.error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export interface ResponseSequencer {
  /** Feed every server event through here, before the app handles it. */
  handle(event: SequencerServerEvent): void;
  /** Send these events now if no response is active, else once the active one is done. Order is kept. */
  turn(...events: RealtimeClientEvent[]): void;
  /** Forget the queue and the active response (on disconnect). */
  reset(): void;
}

const ALREADY_ACTIVE = "conversation_already_has_active_response";

export function createResponseSequencer(send: (event: RealtimeClientEvent) => void): ResponseSequencer {
  /** A response is in progress, or a `response.create` was sent and has not been answered yet. */
  let active = false;
  /** A `response.create` was sent and no `response.created` has arrived since. */
  let awaiting = false;
  /**
   * The last `response.create` sent, until the response it may have started is done. The server can
   * still refuse it after a `response.created`: that one may be a response it started on its own.
   */
  let lastCreate: RealtimeClientEvent | null = null;
  const queue: RealtimeClientEvent[][] = [];

  const sendTurn = (events: RealtimeClientEvent[]) => {
    for (const event of events) {
      send(event);
      if (event.type === "response.create") {
        // Until the server answers, a second response.create would be refused: count it as active now.
        active = true;
        awaiting = true;
        lastCreate = event;
      }
    }
  };

  /** Send queued turns until one of them starts a response. */
  const flush = () => {
    while (!active && queue.length > 0) sendTurn(queue.shift()!);
  };

  return {
    handle(event) {
      switch (event.type) {
        case "response.created":
          active = true;
          awaiting = false;
          break;
        case "response.done":
          active = false;
          awaiting = false;
          lastCreate = null;
          flush();
          break;
        case "error": {
          if (errorCode(event) === ALREADY_ACTIVE) {
            // A response the server started on its own (voice activity) won the race and ours was
            // refused: ask again first thing after that one is done.
            if (lastCreate) queue.unshift([lastCreate]);
            lastCreate = null;
            awaiting = false;
            active = true;
          } else if (awaiting) {
            // Some other refusal before any response started: don't wait for one that will never come.
            awaiting = false;
            lastCreate = null;
            active = false;
            flush();
          }
          break;
        }
      }
    },
    turn(...events) {
      if (events.length === 0) return;
      queue.push(events);
      flush();
    },
    reset() {
      active = false;
      awaiting = false;
      lastCreate = null;
      queue.length = 0;
    },
  };
}
