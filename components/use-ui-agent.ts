"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "@ag-ui/client";
import { REDRAW_MARKER, SURFACE_ACTIVITY, UI_AGENT_ID } from "@/lib/config";
import { useAgent, useCopilotKit } from "@/lib/cpk";
import { abortMessage } from "@/lib/deadline";
import type { DrawRequest, DrawResult, Handoff } from "@/lib/types";

export interface UseUiAgent {
  /** The runtime's agent is connected (not a provisional stand-in). */
  ready: boolean;
  running: boolean;
  handoffs: Handoff[];
  /**
   * Views a stopped draw left part-drawn, by activity message id, with the content they were left at.
   * A view whose content has changed since (a later redraw) is no longer stopped.
   */
  stoppedViews: ReadonlyMap<string, string>;
  /** Queues a brief for the UI writer. Requests run one at a time. */
  draw(req: DrawRequest): Promise<DrawResult>;
  /** Called with the action text when the user acts on a view (a click). Returns unsubscribe. */
  onUserAction(cb: (text: string) => void): () => void;
}

/**
 * How long a draw waits for the runtime to connect before giving up. The first request after
 * `pnpm dev` compiles the runtime and the A2UI compiler, which took ~36 s on a cold start.
 */
const READY_TIMEOUT_MS = 60_000;
/** How long a draw waits for another run (a click's redraw) to finish. */
const IDLE_TIMEOUT_MS = 60_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A surface's content as a string, to tell whether it changed. */
export function surfaceKey(message: Message): string {
  return JSON.stringify((message as { content?: unknown }).content ?? null);
}

/** Every surface in the thread: activity message id to its content key. */
function surfaceKeys(messages: readonly Message[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "activity" && m.activityType === SURFACE_ACTIVITY) keys.set(m.id, surfaceKey(m));
  }
  return keys;
}

/** The text of a message, whether it is a string or a list of parts. */
export function messageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("")
      .trim();
  }
  return "";
}

export function useUiAgent(): UseUiAgent {
  // Re-rendering on every streamed operation is the stage's job, not the whole page's.
  const { agent, isReady } = useAgent({ agentId: UI_AGENT_ID, updates: [] });
  const { copilotkit } = useCopilotKit();

  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [running, setRunning] = useState(false);
  const [stoppedViews, setStoppedViews] = useState<ReadonlyMap<string, string>>(() => new Map());

  const readyRef = useRef(isReady);
  useEffect(() => {
    readyRef.current = isReady;
  }, [isReady]);

  /** User messages that draw() added: a run that starts from any other user message is a click. */
  const ownMessageIds = useRef(new Set<string>());
  const listeners = useRef(new Set<(text: string) => void>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** The handoff of the click run in progress, and its error if it failed. */
  const clickRun = useRef<{ handoffId: string; error: string | null } | null>(null);

  const patch = useCallback((id: string, next: Partial<Handoff>) => {
    setHandoffs((list) => list.map((h) => (h.id === id ? { ...h, ...next } : h)));
  }, []);

  // Run lifecycle of the real agent: the running flag, and runs this hook did not start (clicks on a view).
  useEffect(() => {
    if (!isReady) return;
    const finishClick = (error?: string | null) => {
      const run = clickRun.current;
      if (!run) return;
      clickRun.current = null;
      const failure = error ?? run.error;
      patch(run.handoffId, failure ? { status: "error", error: failure, finishedAt: Date.now() } : { status: "ready", finishedAt: Date.now() });
    };
    const sub = agent.subscribe({
      onRunInitialized: ({ messages }) => {
        setRunning(true);
        const last = [...messages].reverse().find((m) => m.role === "user");
        if (!last || ownMessageIds.current.has(last.id)) return;
        const text = messageText(last);
        if (!text) return;
        finishClick();
        const handoffId = crypto.randomUUID();
        clickRun.current = { handoffId, error: null };
        setHandoffs((list) => [
          ...list,
          { id: handoffId, callId: null, brief: text, target: "current", source: "click", status: "drawing", startedAt: Date.now() },
        ]);
        for (const cb of listeners.current) {
          try {
            cb(text);
          } catch (e) {
            console.error("[ui-agent] onUserAction listener failed", e);
          }
        }
        // A follow-up run (a renderer function adds only a developer message) sees the same
        // click message as its newest user message; don't report the click twice.
        ownMessageIds.current.add(last.id);
      },
      onRunErrorEvent: ({ event }) => {
        if (clickRun.current) clickRun.current.error = event.message || "The UI writer failed.";
      },
      onRunFailed: ({ error }) => {
        setRunning(false);
        finishClick(error?.message || "The UI writer failed.");
      },
      onRunFinalized: () => {
        setRunning(false);
        finishClick();
      },
    });
    return () => sub.unsubscribe();
  }, [agent, isReady, patch]);

  /** The runtime's agent once it is connected; null if it does not connect in time or the signal aborts. */
  const waitForAgent = useCallback(async (signal?: AbortSignal) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline && !signal?.aborted) {
      const live = copilotkit.getAgent(UI_AGENT_ID);
      if (readyRef.current && live) return live;
      if (String(copilotkit.runtimeConnectionStatus) === "error") return null;
      await sleep(POLL_MS);
    }
    return null;
  }, [copilotkit]);

  const runDraw = useCallback(
    async (req: DrawRequest): Promise<DrawResult> => {
      const brief = req.brief.trim();
      const handoff: Handoff = {
        id: crypto.randomUUID(),
        callId: req.callId ?? null,
        brief,
        target: req.target,
        source: req.source,
        status: "drawing",
        startedAt: Date.now(),
      };
      setHandoffs((list) => [...list, handoff]);

      const finish = (error: string | null): DrawResult => {
        const finishedAt = Date.now();
        const ms = finishedAt - handoff.startedAt;
        if (error) {
          patch(handoff.id, { status: "error", error, finishedAt });
          return { ok: false, ms, error };
        }
        patch(handoff.id, { status: "ready", finishedAt });
        return { ok: true, ms };
      };

      if (!brief) return finish("The brief was empty.");

      // The caller may give up while this request waits: in the queue, for the runtime, or behind a click's
      // redraw. A view nobody is waiting for any more must not start.
      const { signal } = req;
      if (signal?.aborted) return finish(abortMessage(signal));

      const live = await waitForAgent(signal);
      if (signal?.aborted) return finish(abortMessage(signal));
      if (!live) return finish("The UI writer is not reachable. Check that the app's /api/copilotkit route is running.");

      // A click's redraw may be running; wait for it rather than be refused.
      const idleBy = Date.now() + IDLE_TIMEOUT_MS;
      while (live.isRunning) {
        if (signal?.aborted) return finish(abortMessage(signal));
        if (Date.now() > idleBy) return finish("The UI writer is still busy with another view.");
        await sleep(POLL_MS);
      }
      if (signal?.aborted) return finish(abortMessage(signal));

      const messageId = crypto.randomUUID();
      ownMessageIds.current.add(messageId);
      const content = req.target === "current" ? `${REDRAW_MARKER}\n${brief}` : brief;
      const outcome = { error: null as string | null, stopped: false };
      // Aborted mid-run: stop the run, so the view doesn't keep streaming after the caller gave up on it.
      const onAbort = () => {
        outcome.stopped = true;
        copilotkit.stopAgent({ agent: live });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const before = surfaceKeys(live.messages);
      const sub = live.subscribe({
        onRunErrorEvent: ({ event }) => {
          outcome.error = event.message || "The UI writer failed.";
        },
        onRunFailed: ({ error }) => {
          outcome.error ??= error?.message || "The UI writer failed.";
        },
      });
      try {
        live.addMessage({ id: messageId, role: "user", content });
        // CopilotKit reports run failures to the subscriber above (and its onError) rather than throwing.
        await copilotkit.runAgent({ agent: live });
      } catch (e) {
        outcome.error ??= e instanceof Error ? e.message : String(e);
      } finally {
        sub.unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      }
      if (outcome.stopped && signal) {
        // The server closes a stopped view as "ready" so what painted stays; remember which views
        // this run left part-drawn, so the stage can say so.
        const touched = [...surfaceKeys(live.messages)].filter(([id, key]) => before.get(id) !== key);
        if (touched.length) setStoppedViews((map) => new Map([...map, ...touched]));
        return finish(abortMessage(signal));
      }
      return finish(outcome.error);
    },
    [copilotkit, patch, waitForAgent],
  );

  const draw = useCallback(
    (req: DrawRequest) => {
      const job = queue.current.then(() => runDraw(req));
      queue.current = job.catch(() => undefined);
      return job;
    },
    [runDraw],
  );

  const onUserAction = useCallback((cb: (text: string) => void) => {
    listeners.current.add(cb);
    return () => {
      listeners.current.delete(cb);
    };
  }, []);

  return { ready: isReady, running, handoffs, stoppedViews, draw, onUserAction };
}
