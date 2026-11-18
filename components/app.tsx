"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCopilotCall } from "@/lib/copilot-call";
import type { CallStatus } from "@/lib/copilot-call";
import { MAX_CALL_MS, SESSION_URL, TOOL_DEADLINE_MS } from "@/lib/config";
import { CALL_INSTRUCTIONS } from "@/lib/persona";
import { createTripStore } from "@/lib/trip/store";
import type { Trip } from "@/lib/trip/types";
import { CallPill } from "./call-pill";
import { Panels } from "./panels";
import { Plan } from "./plan/plan";
import { useTripTools, runTripTool } from "./use-trip-tools";
import { useUiAgent } from "./use-ui-agent";

declare global {
  interface Window {
    /** Read-only hooks for the e2e test; `applyTool` exists in development only. */
    __callYourUi?: {
      getTrip(): Trip;
      getStatus(): CallStatus;
      applyTool?(name: string, args: Record<string, unknown>): string;
    };
  }
}

const PhoneIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
    <path
      d="M6.2 2.8 4.4 3.3c-.8.2-1.3 1-1.2 1.8.6 5.6 5.1 10.1 10.7 10.7.8.1 1.6-.4 1.8-1.2l.5-1.8c.2-.6-.1-1.3-.7-1.6l-2.2-1c-.5-.2-1.1-.1-1.5.3l-.8.9c-1.9-.9-3.4-2.4-4.3-4.3l.9-.8c.4-.4.5-1 .3-1.5l-1-2.2c-.3-.6-1-.9-1.7-.7z"
      fill="currentColor"
    />
  </svg>
);

export function App() {
  const [store] = useState(createTripStore);
  const trip = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { draw, handoffs, onUserAction, stoppedViews } = useUiAgent();
  useTripTools(store, trip, draw);

  const call = useCopilotCall({
    instructions: CALL_INSTRUCTIONS,
    sessionUrl: SESSION_URL,
    toolDeadlineMs: TOOL_DEADLINE_MS,
    maxCallMs: MAX_CALL_MS,
  });
  const { sendText, status } = call;

  // A click inside a panel redraws it; the voice hears what happened.
  useEffect(() => onUserAction((text) => sendText(`[UI] ${text}`)), [onUserAction, sendText]);

  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    window.__callYourUi = {
      getTrip: () => store.getState(),
      getStatus: () => statusRef.current,
      ...(process.env.NODE_ENV === "development"
        ? { applyTool: (name: string, args: Record<string, unknown>) => runTripTool(store, name, args) }
        : {}),
    };
    return () => {
      delete window.__callYourUi;
    };
  }, [store]);

  const drawing = handoffs.find((h) => h.status === "drawing") ?? null;
  const inCall = status !== "idle";
  const live = inCall && status !== "error";

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden />
          Trips
        </span>
        <span className="toolbar-title">{trip.title || "New trip"}</span>
        <div className="toolbar-end">
          {inCall ? null : (
            <button type="button" className="call-btn" data-action="call" onClick={() => void call.start()}>
              <PhoneIcon />
              Call
            </button>
          )}
        </div>
      </header>
      <main className="main">
        <Plan trip={trip} inCall={live} />
        <Panels drawing={drawing} stopped={stoppedViews} />
      </main>
      {inCall ? <CallPill call={call} /> : null}
    </div>
  );
}
