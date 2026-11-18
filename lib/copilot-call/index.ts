/** Voice calls for CopilotKit apps: GPT Realtime that drives your registered frontend tools. */
export { useCopilotCall, DEFAULT_MAX_CALL_MS, DEFAULT_SESSION_URL, DEFAULT_TOOL_DEADLINE_MS } from "./use-copilot-call";
export type { UseCopilotCall, UseCopilotCallOptions } from "./use-copilot-call";
export { createCallController } from "./controller";
export type { CallController, CallControllerOptions, CallStatus, TranscriptEntry } from "./controller";
export { buildInstructions, runToolCall, toRealtimeTools } from "./tool-bridge";
export type { RealtimeFunctionTool, ToolCallInput } from "./tool-bridge";
export { RealtimeError } from "./client";
export type { RealtimeErrorKind, RealtimeLevels } from "./client";
