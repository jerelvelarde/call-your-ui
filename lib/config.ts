/**
 * Shared, secret-free configuration. Safe to import from the server and the browser.
 * Model ids are read from the environment on the server; these are the fallbacks.
 */

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const DEFAULT_REALTIME_VOICE = "marin";
export const DEFAULT_COMPOSER_MODEL = "gpt-5.6-sol";

/** Transcribes the caller's speech so the call pill can show what they said. */
export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** The CopilotKit agent that writes generated panels (A2UI). */
export const UI_AGENT_ID = "default";
export const COPILOTKIT_RUNTIME_URL = "/api/copilotkit";

/** Where the browser asks for a short-lived Realtime client secret. */
export const SESSION_URL = "/api/realtime/session";

export const APP_PORT = 3300;

/** A call hangs up on its own after this long. */
export const MAX_CALL_MS = 600_000;

/** How long one tool call (including a generated panel) may run before the call stops waiting. */
export const TOOL_DEADLINE_MS = 60_000;

/**
 * A brief that redraws the view already on screen starts with this line. The UI agent
 * strips it and rewrites the most recent surface in the thread instead of adding one.
 */
export const REDRAW_MARKER = "[redraw current view]";

/** The activity type of an A2UI surface (`GENERATIVE_UI_ACTIVITY_TYPE` in @copilotkit/shared). */
export const SURFACE_ACTIVITY = "generative-ui-surface";
