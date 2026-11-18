/**
 * One voice call's logic, without React or WebRTC: keeps the session's tools and instructions in
 * step with CopilotKit, runs the tools the model calls, answers them, and reports status and
 * transcript. `use-copilot-call.ts` wires it to a live connection.
 */
import type { FrontendTool, ScopedContext } from "@/lib/cpk";
import { isFunctionCall } from "./events";
import type { FunctionCallOutput, RealtimeClientEvent, RealtimeServerEvent } from "./events";
import { buildInstructions, runToolCall, toRealtimeTools } from "./tool-bridge";

export type CallStatus = "idle" | "connecting" | "listening" | "thinking" | "running-tool" | "speaking" | "error";

export interface TranscriptEntry {
  /** The Realtime item id, so deltas and the final text land on the same entry. */
  id: string;
  role: "user" | "assistant";
  text: string;
  /** False while deltas are still arriving. */
  final: boolean;
  /** ms since epoch: when the user started speaking, or when the reply started. */
  at: number;
}

export interface CallControllerOptions {
  /** Sends one event right away (used for session.update). */
  send(event: RealtimeClientEvent): void;
  /** Sends a group of events through the response sequencer. */
  turn(...events: RealtimeClientEvent[]): void;
  getTools(): readonly FrontendTool<any>[];
  getContext(): Readonly<Record<string, ScopedContext>>;
  instructions: string;
  agentId?: string;
  toolDeadlineMs: number;
  onStatus(status: CallStatus): void;
  onTranscript(entry: TranscriptEntry): void;
  onError(message: string): void;
  /**
   * Resolves once the app has committed what the tools changed, so the next session.update carries
   * it. The default waits two macrotask hops: enough for a React commit scheduled by a state setter
   * (its layout effects update CopilotKit's context). Not requestAnimationFrame: it pauses in hidden tabs.
   */
  settle?: () => Promise<void>;
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const defaultSettle = async () => {
  await nextTask();
  await nextTask();
};

export interface CallController {
  /** Call once the data channel is open: sends the first session.update. */
  open(): void;
  handle(event: RealtimeServerEvent): void;
  /** Sends a session.update if the tools or the context changed since the last one. */
  syncSession(): void;
  /** A typed user message, then a response. */
  sendText(text: string): void;
  /** Aborts running tools; nothing is sent afterwards. */
  dispose(): void;
}

/** The server refuses a second response.create while one is active; the sequencer retries it. */
const ALREADY_ACTIVE = "conversation_already_has_active_response";
const RESPONSE_CREATE: RealtimeClientEvent = { type: "response.create" };

export function createCallController(opts: CallControllerOptions): CallController {
  let disposed = false;
  let lastSession = "";
  let status: CallStatus | null = null;
  let audioPlaying = false;
  let toolsRunning = 0;
  /** Each call runs once, as soon as its item is complete; `response.done` collects the results. */
  const started = new Map<string, ReturnType<typeof runToolCall>>();
  const answered = new Set<string>();
  const stop = new AbortController();
  const speechAt = new Map<string, number>();
  const entries = new Map<string, TranscriptEntry>();

  const setStatus = (next: CallStatus) => {
    if (disposed || next === status) return;
    status = next;
    opts.onStatus(next);
  };
  /** Where the call settles when nothing is running or playing. */
  const idleStatus = (): CallStatus => (toolsRunning > 0 ? "running-tool" : audioPlaying ? "speaking" : "listening");

  const upsert = (id: string, role: TranscriptEntry["role"], at: number, text: (prev: string) => string, final: boolean) => {
    if (disposed) return;
    const prev = entries.get(id);
    if (prev?.final && !final) return;
    const next: TranscriptEntry = { id, role, at: prev?.at ?? at, text: text(prev?.text ?? ""), final };
    if (prev && prev.text === next.text && prev.final === next.final) return;
    entries.set(id, next);
    opts.onTranscript(next);
  };

  const syncSession = (force = false) => {
    if (disposed) return;
    const tools = toRealtimeTools(opts.getTools(), opts.agentId);
    const instructions = buildInstructions(opts.instructions, opts.getContext(), opts.agentId);
    const signature = JSON.stringify([instructions, tools]);
    if (!force && signature === lastSession) return;
    lastSession = signature;
    opts.send({ type: "session.update", session: { type: "realtime", instructions, tools, tool_choice: "auto" } });
  };

  /** The tool a call names, with the same scoping rules as the tools the session was given. */
  const findTool = (name: string) =>
    opts
      .getTools()
      .find(
        (t) => t.name === name && t.available !== false && !!t.handler && (!t.agentId || t.agentId === opts.agentId),
      );

  /** A finished call the model wants run: complete arguments (not cut off by the caller talking over it). */
  const runnable = (item: unknown): item is FunctionCallOutput =>
    isFunctionCall(item as FunctionCallOutput) &&
    !!(item as FunctionCallOutput).call_id &&
    (!(item as FunctionCallOutput).status || (item as FunctionCallOutput).status === "completed");

  const startCall = (call: FunctionCallOutput) => {
    let run = started.get(call.call_id);
    if (!run) {
      toolsRunning++;
      setStatus("running-tool");
      run = runToolCall(findTool(call.name), call, { signal: stop.signal, deadlineMs: opts.toolDeadlineMs }).finally(() => {
        toolsRunning--;
      });
      started.set(call.call_id, run);
    }
    return run;
  };

  const answer = async (calls: FunctionCallOutput[]) => {
    toolsRunning++;
    const results = await Promise.all(calls.map(startCall));
    // The tools may have changed what the model should see (the plan): let the app commit it, then
    // update the session before asking the model to speak.
    await (opts.settle ?? defaultSettle)();
    toolsRunning--;
    if (disposed) return;
    syncSession();
    opts.turn(
      ...calls.map(
        (call, i): RealtimeClientEvent => ({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: call.call_id, output: results[i].output },
        }),
      ),
      RESPONSE_CREATE,
    );
  };

  return {
    open: () => syncSession(true),
    syncSession: () => syncSession(),

    handle(event) {
      if (disposed) return;
      switch (event.type) {
        case "response.created":
          if (!audioPlaying) setStatus("thinking");
          break;
        case "response.done": {
          if (event.response?.status === "failed") {
            opts.onError(event.response.status_details?.error?.message || "The voice model could not answer. Try again.");
          }
          if (!audioPlaying && toolsRunning === 0) setStatus("listening");
          const calls = (event.response?.output ?? []).filter(
            (item): item is FunctionCallOutput => runnable(item) && !answered.has(item.call_id),
          );
          if (calls.length === 0) break;
          calls.forEach((call) => answered.add(call.call_id));
          void answer(calls);
          break;
        }
        case "response.output_item.done":
          // Run each call as soon as its arguments are complete, so edits land while the model is
          // still writing the next call or talking; the results go back when the response is done.
          if (runnable(event.item)) void startCall(event.item);
          break;
        case "output_audio_buffer.started":
          audioPlaying = true;
          setStatus("speaking");
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          audioPlaying = false;
          setStatus(idleStatus());
          break;
        case "input_audio_buffer.speech_started":
          if (event.item_id) speechAt.set(event.item_id, Date.now());
          if (toolsRunning === 0) setStatus("listening");
          break;
        case "conversation.item.input_audio_transcription.delta": {
          const delta = event.delta;
          upsert(event.item_id, "user", speechAt.get(event.item_id) ?? Date.now(), (t) => t + delta, false);
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const transcript = (event.transcript ?? "").trim();
          upsert(event.item_id, "user", speechAt.get(event.item_id) ?? Date.now(), () => transcript, true);
          break;
        }
        case "response.output_audio_transcript.delta":
        case "response.output_text.delta": {
          const delta = event.delta;
          upsert(event.item_id, "assistant", Date.now(), (t) => t + delta, false);
          break;
        }
        case "response.output_audio_transcript.done": {
          const transcript = event.transcript ?? "";
          upsert(event.item_id, "assistant", Date.now(), (t) => transcript || t, true);
          break;
        }
        case "response.output_text.done": {
          const text = event.text ?? "";
          upsert(event.item_id, "assistant", Date.now(), (t) => text || t, true);
          break;
        }
        case "error":
          if (event.error?.code === ALREADY_ACTIVE) break;
          if (event.error?.message) opts.onError(event.error.message);
          break;
        default:
          break;
      }
    },

    sendText(text) {
      const value = text.trim();
      if (disposed || !value) return;
      const id = `typed-${Math.random().toString(36).slice(2)}`;
      upsert(id, "user", Date.now(), () => value, true);
      opts.turn(
        { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: value }] } },
        RESPONSE_CREATE,
      );
    },

    dispose() {
      disposed = true;
      stop.abort();
    },
  };
}
