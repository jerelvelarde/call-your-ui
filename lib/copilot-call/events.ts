/**
 * Minimal types for the GPT Realtime GA events this app sends and handles.
 * Anything else the server sends still arrives (as `{ type: string }`) and is ignored.
 */

/* ───────────────────────── client → server ───────────────────────── */

export interface InputTextContent {
  type: "input_text";
  text: string;
}

export interface UserMessageItem {
  type: "message";
  role: "user";
  content: InputTextContent[];
}

export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  /** A JSON string the model reads as the tool's result. */
  output: string;
}

export interface ConversationItemCreateEvent {
  type: "conversation.item.create";
  item: UserMessageItem | FunctionCallOutputItem;
}

export interface ResponseCreateEvent {
  type: "response.create";
  response?: Record<string, unknown>;
}

export interface ResponseCancelEvent {
  type: "response.cancel";
}

/** Replaces the session's instructions and tools (the rest of the session config stays). */
export interface SessionUpdateEvent {
  type: "session.update";
  session: { type: "realtime" } & Record<string, unknown>;
}

export type RealtimeClientEvent =
  | ConversationItemCreateEvent
  | ResponseCreateEvent
  | ResponseCancelEvent
  | SessionUpdateEvent;

/* ───────────────────────── server → client ───────────────────────── */

export interface FunctionCallOutput {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  /** The arguments as a JSON string. */
  arguments: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface MessageOutput {
  type: "message";
  id?: string;
  role?: string;
  status?: string;
}

export type ResponseOutputItem = FunctionCallOutput | MessageOutput | { type: string; id?: string };

export interface RealtimeResponse {
  id: string;
  status?: "in_progress" | "completed" | "cancelled" | "failed" | "incomplete";
  /** Why a response was cancelled, cut short or failed (a quota or rate limit error lands here). */
  status_details?: {
    type?: string;
    reason?: string;
    error?: { type?: string; code?: string; message?: string } | null;
  } | null;
  output?: ResponseOutputItem[];
}

export interface ResponseCreatedEvent {
  type: "response.created";
  response: RealtimeResponse;
}

export interface ResponseDoneEvent {
  type: "response.done";
  response: RealtimeResponse;
}

export interface TranscriptDeltaEvent {
  type: "response.output_audio_transcript.delta" | "response.output_text.delta";
  response_id?: string;
  item_id: string;
  delta: string;
}

export interface AudioTranscriptDoneEvent {
  type: "response.output_audio_transcript.done";
  response_id?: string;
  item_id: string;
  transcript: string;
}

export interface TextDoneEvent {
  type: "response.output_text.done";
  response_id?: string;
  item_id: string;
  text: string;
}

export interface InputTranscriptionDeltaEvent {
  type: "conversation.item.input_audio_transcription.delta";
  item_id: string;
  delta: string;
}

export interface InputTranscriptionCompletedEvent {
  type: "conversation.item.input_audio_transcription.completed";
  item_id: string;
  transcript: string;
}

export interface InputTranscriptionFailedEvent {
  type: "conversation.item.input_audio_transcription.failed";
  item_id: string;
  error?: { message?: string };
}

export interface SpeechStartedEvent {
  type: "input_audio_buffer.speech_started";
  item_id?: string;
  audio_start_ms?: number;
}

export interface SpeechStoppedEvent {
  type: "input_audio_buffer.speech_stopped";
  item_id?: string;
}

/** WebRTC only: the model's audio started or stopped playing (`cleared` on an interruption). */
export interface OutputAudioBufferEvent {
  type: "output_audio_buffer.started" | "output_audio_buffer.stopped" | "output_audio_buffer.cleared";
  response_id?: string;
}

export interface ConversationItemEvent {
  type: "conversation.item.added" | "conversation.item.done";
  item: { id: string; type: string; role?: string };
  previous_item_id?: string | null;
}

export interface FunctionCallArgumentsDoneEvent {
  type: "response.function_call_arguments.done";
  item_id?: string;
  call_id: string;
  name?: string;
  arguments: string;
}

export interface OutputItemDoneEvent {
  type: "response.output_item.done";
  item: ResponseOutputItem;
}

export interface RealtimeErrorEvent {
  type: "error";
  error: { type?: string; code?: string | null; message: string; param?: string | null; event_id?: string | null };
}

export type RealtimeServerEvent =
  | ResponseCreatedEvent
  | ResponseDoneEvent
  | TranscriptDeltaEvent
  | AudioTranscriptDoneEvent
  | TextDoneEvent
  | InputTranscriptionDeltaEvent
  | InputTranscriptionCompletedEvent
  | InputTranscriptionFailedEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | OutputAudioBufferEvent
  | ConversationItemEvent
  | FunctionCallArgumentsDoneEvent
  | OutputItemDoneEvent
  | RealtimeErrorEvent;

/**
 * The data channel delivers these and others; it is parsed as this union and anything the app does not
 * handle falls through a `switch (event.type)` to its default branch.
 */
export type ServerEventType = RealtimeServerEvent["type"];

export function isFunctionCall(item: ResponseOutputItem): item is FunctionCallOutput {
  return item.type === "function_call";
}
