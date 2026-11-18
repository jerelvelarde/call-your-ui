"use client";
/**
 * `useCopilotCall`: a GPT Realtime voice call that can use every frontend tool and context entry
 * registered with CopilotKit (`useFrontendTool`, `useAgentContext`). The model calls the same
 * tools a chat would; their results go back to the call, and the call's instructions carry the
 * live context, so the voice always sees what's on screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useCopilotKit } from "@/lib/cpk";
import { connectRealtime } from "./client";
import type { RealtimeConnection, RealtimeLevels } from "./client";
import { createCallController } from "./controller";
import type { CallController, CallStatus, TranscriptEntry } from "./controller";

export const DEFAULT_SESSION_URL = "/api/realtime/session";
export const DEFAULT_TOOL_DEADLINE_MS = 60_000;
export const DEFAULT_MAX_CALL_MS = 600_000;
/** rc.53 has no tools-changed event, so the call also re-checks the tools this often. */
const SYNC_INTERVAL_MS = 1_000;
const CONTEXT_DEBOUNCE_MS = 200;
const NO_LEVELS: RealtimeLevels = { input: 0, output: 0 };

export interface UseCopilotCallOptions {
  /** Persona and style. The current CopilotKit context is appended to it. */
  instructions: string;
  /** Which agent-scoped tools and context the call may use; global ones always apply. */
  agentId?: string;
  /** This app's route that mints a client secret. Default "/api/realtime/session". */
  sessionUrl?: string;
  /** How long one tool call may run. Default 60 s. */
  toolDeadlineMs?: number;
  /** The call hangs up on its own after this long. Default 10 minutes. */
  maxCallMs?: number;
}

export interface UseCopilotCall {
  status: CallStatus;
  error: string | null;
  transcript: TranscriptEntry[];
  muted: boolean;
  /** When the call connected (ms since epoch), or null. */
  startedAt: number | null;
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  sendText(text: string): void;
  /** Zeros when not connected. */
  getLevels(): RealtimeLevels;
}

function upsertEntry(list: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const i = list.findIndex((e) => e.id === entry.id);
  if (entry.final && !entry.text) return i < 0 ? list : list.filter((e) => e.id !== entry.id);
  if (i < 0) return [...list, entry];
  const copy = list.slice();
  copy[i] = entry;
  return copy;
}

export function useCopilotCall(opts: UseCopilotCallOptions): UseCopilotCall {
  const { copilotkit } = useCopilotKit();
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [muted, setMutedState] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const connRef = useRef<RealtimeConnection | null>(null);
  const controllerRef = useRef<CallController | null>(null);
  /** Bumped by every start and stop, so a stale connect or event is dropped. */
  const sessionRef = useRef(0);
  const connectingRef = useRef(false);
  const connectAbortRef = useRef<AbortController | null>(null);

  /** Ends the call (or the connect in progress). With a reason, the call shows it as an error. */
  const end = useCallback((reason?: string) => {
    sessionRef.current++;
    connectingRef.current = false;
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    controllerRef.current?.dispose();
    controllerRef.current = null;
    connRef.current?.close();
    connRef.current = null;
    setMutedState(false);
    setStartedAt(null);
    setStatus(reason ? "error" : "idle");
    setError(reason ?? null);
  }, []);

  const stop = useCallback(() => end(), [end]);

  const start = useCallback(async () => {
    if (connRef.current || connectingRef.current) return;
    const session = ++sessionRef.current;
    const live = () => sessionRef.current === session;
    connectingRef.current = true;
    const abort = new AbortController();
    connectAbortRef.current = abort;
    const o = optsRef.current;

    setError(null);
    setTranscript([]);
    setMutedState(false);
    setStatus("connecting");

    const controller = createCallController({
      send: (event) => connRef.current?.send(event),
      turn: (...events) => connRef.current?.turn(...events),
      getTools: () => copilotkit.tools,
      getContext: () => copilotkit.context,
      instructions: o.instructions,
      agentId: o.agentId,
      toolDeadlineMs: o.toolDeadlineMs ?? DEFAULT_TOOL_DEADLINE_MS,
      onStatus: (next) => live() && setStatus(next),
      onTranscript: (entry) => live() && setTranscript((list) => upsertEntry(list, entry)),
      onError: (message) => live() && setError(message),
    });
    controllerRef.current = controller;

    try {
      // Called synchronously from the click, so the client can start its audio context.
      const conn = await connectRealtime({
        sessionUrl: o.sessionUrl ?? DEFAULT_SESSION_URL,
        signal: abort.signal,
        onEvent: (event) => live() && controller.handle(event),
        onClose: (reason) => live() && end(reason),
      });
      if (!live()) {
        conn.close();
        return;
      }
      connRef.current = conn;
      setStartedAt(Date.now());
      setStatus("listening");
      controller.open();
    } catch (e) {
      if (!live()) return;
      end(e instanceof Error ? e.message : String(e));
    } finally {
      if (live()) connectingRef.current = false;
      if (connectAbortRef.current === abort) connectAbortRef.current = null;
    }
  }, [copilotkit, end]);

  // While connected: follow context changes (debounced) and re-check the tools every second.
  useEffect(() => {
    if (startedAt === null) return;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const sync = () => controllerRef.current?.syncSession();
    const subscription = copilotkit.subscribe({
      onContextChanged: () => {
        clearTimeout(debounce);
        debounce = setTimeout(sync, CONTEXT_DEBOUNCE_MS);
      },
    });
    const interval = setInterval(sync, SYNC_INTERVAL_MS);
    return () => {
      subscription.unsubscribe();
      clearTimeout(debounce);
      clearInterval(interval);
    };
  }, [copilotkit, startedAt]);

  // A call hangs up on its own after maxCallMs.
  useEffect(() => {
    if (startedAt === null) return;
    const limit = optsRef.current.maxCallMs ?? DEFAULT_MAX_CALL_MS;
    const timer = setTimeout(
      () => end(`Calls end after ${Math.round(limit / 60_000)} minutes.`),
      Math.max(0, startedAt + limit - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [startedAt, end]);

  // Unmount ends the call, or the connect in progress.
  useEffect(
    () => () => {
      sessionRef.current++;
      connectAbortRef.current?.abort();
      controllerRef.current?.dispose();
      connRef.current?.close();
      connRef.current = null;
    },
    [],
  );

  const setMuted = useCallback((next: boolean) => {
    const conn = connRef.current;
    if (!conn) return;
    conn.setMuted(next);
    setMutedState(next);
  }, []);

  const sendText = useCallback((text: string) => controllerRef.current?.sendText(text), []);
  const getLevels = useCallback(() => connRef.current?.getLevels() ?? NO_LEVELS, []);

  return { status, error, transcript, muted, startedAt, start, stop, setMuted, sendText, getLevels };
}
