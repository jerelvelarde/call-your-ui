"use client";

import { Component, memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ActivityMessage, Message } from "@ag-ui/client";
import { REDRAW_MARKER, SURFACE_ACTIVITY, UI_AGENT_ID } from "@/lib/config";
import { useAgent, useRenderActivityMessage } from "@/lib/cpk";
import type { Handoff } from "@/lib/types";
import { messageText, surfaceKey } from "./use-ui-agent";

type Agent = ReturnType<typeof useAgent>["agent"];

interface View {
  message: ActivityMessage;
  /** Changes whenever the surface does: its operations or its status. */
  version: string;
  /** First line of the brief that drew it. */
  label: string;
  status: string;
}

/** FNV-1a: a short, cheap fingerprint to tell one version of a surface from the next. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function surfaceVersion(message: ActivityMessage) {
  const c = message.content as { operations?: unknown[]; status?: string; rejected?: unknown[] };
  // The content, not only the count: an operation can be patched in place.
  return `${c.operations?.length ?? 0}|${hash(JSON.stringify(c.operations ?? []))}|${c.status}|${c.rejected?.length ?? 0}`;
}

function briefLabel(text: string) {
  const lines = text.split("\n").filter((l) => l.trim() && l.trim() !== REDRAW_MARKER);
  return (lines[0] ?? "").trim();
}

/**
 * Every surface in the thread, newest first, with the brief that asked for it.
 * - "stopped": a draw was stopped (it ran past the voice's deadline) and the view hasn't changed since.
 * - "error" when still marked streaming with no run going: the run ended without closing it, such as a
 *   dropped connection. A surface only streams during a run.
 */
function readViews(messages: readonly Message[], running: boolean, stopped: ReadonlyMap<string, string>): View[] {
  const views: View[] = [];
  let lastBrief = "";
  for (const m of messages) {
    if (m.role === "user") {
      lastBrief = messageText(m);
    } else if (m.role === "activity" && m.activityType === SURFACE_ACTIVITY) {
      let status = String((m.content as { status?: unknown }).status ?? "streaming");
      if (status === "streaming" && !running) status = "error";
      else if (stopped.has(m.id) && stopped.get(m.id) === surfaceKey(m)) status = "stopped";
      views.push({ message: m, version: surfaceVersion(m), label: briefLabel(lastBrief), status });
    }
  }
  return views.reverse();
}

/**
 * The surfaces, re-read once a frame after any agent event. Activity deltas patch a message in place, so
 * the stage listens to events and run ends as well as message changes.
 */
function useViews(agent: Agent, ready: boolean, stopped: ReadonlyMap<string, string>): View[] {
  const [views, setViews] = useState<View[]>([]);
  useEffect(() => {
    let raf = 0;
    let last = "";
    const read = () => {
      raf = 0;
      const next = readViews(agent.messages, agent.isRunning, stopped);
      const sig = next.map((v) => `${v.message.id}:${v.version}:${v.status}:${v.label}`).join(",");
      if (sig === last) return;
      last = sig;
      setViews(next);
    };
    const later = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    const sub = agent.subscribe({
      onMessagesChanged: later,
      onEvent: later,
      onRunFinalized: later,
      onRunFailed: later,
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      sub.unsubscribe();
    };
  }, [agent, ready, stopped]);
  return views;
}

/** One surface through CopilotKit's own activity renderer, re-rendered only when the surface changed. */
const LiveSurface = memo(
  function LiveSurface({ message }: { message: ActivityMessage; version: string }) {
    const { renderActivityMessage } = useRenderActivityMessage();
    return <>{renderActivityMessage(message)}</>;
  },
  (a, b) => a.message.id === b.message.id && a.version === b.version,
);

/** A view that throws while rendering shows a plain note instead of taking the page down. */
class ViewBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  componentDidCatch(error: unknown) {
    console.error("[panels] a panel failed to render", error);
  }
  render() {
    if (this.state.failed) return <p className="view-broken">This view could not be shown.</p>;
    return this.props.children;
  }
}

function ViewFrame({ view, onClose }: { view: View; onClose: () => void }) {
  return (
    <article className="view" data-status={view.status} data-panel-status={view.status}>
      <header className="view-head">
        <span className="view-label" title={view.label}>
          {view.label || "View"}
        </span>
        {view.status === "streaming" ? (
          <span className="view-state" data-state="drawing">
            Drawing
          </span>
        ) : view.status === "error" ? (
          <span className="view-state" data-state="error">
            Incomplete
          </span>
        ) : view.status === "stopped" ? (
          <span className="view-state" data-state="error">
            Stopped
          </span>
        ) : null}
        <button type="button" className="view-close" onClick={onClose} aria-label="Close panel">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="view-body">
        <ViewBoundary resetKey={view.version}>
          <LiveSurface message={view.message} version={view.version} />
        </ViewBoundary>
      </div>
    </article>
  );
}

/** Stands in for a new view until its first component lands. */
function PendingFrame({ brief }: { brief: string }) {
  return (
    <article className="view view-pending" aria-busy="true">
      <header className="view-head">
        <span className="view-label">{briefLabel(brief)}</span>
        <span className="view-state" data-state="drawing">
          Writing
        </span>
      </header>
      <div className="view-body">
        <div className="skeleton" aria-hidden>
          <span style={{ width: "42%" }} />
          <span style={{ width: "86%" }} />
          <span style={{ width: "64%" }} />
        </div>
      </div>
    </article>
  );
}

/**
 * The panels the UI writer drew (a cost breakdown, a comparison), newest first, under the plan.
 * Closing one only hides it here.
 */
export function Panels({ drawing, stopped }: { drawing: Handoff | null; stopped: ReadonlyMap<string, string> }) {
  const { agent, isReady } = useAgent({ agentId: UI_AGENT_ID, updates: [] });
  const all = useViews(agent, isReady, stopped);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const views = all.filter((v) => !hidden.has(v.message.id));

  // A new panel stands in as a pending frame until the surface for it shows up.
  const [base, setBase] = useState<{ id: string; count: number } | null>(null);
  if (drawing && base?.id !== drawing.id) setBase({ id: drawing.id, count: all.length });
  const pending = drawing && drawing.target === "new" && base?.id === drawing.id && all.length <= base.count;

  // Bring a new panel into sight.
  const topRef = useRef<HTMLDivElement>(null);
  const count = views.length + (pending ? 1 : 0);
  const lastCount = useRef(count);
  useEffect(() => {
    if (count > lastCount.current) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      topRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
    lastCount.current = count;
  }, [count]);

  if (count === 0) return null;
  return (
    <section className="panels" aria-label="Panels">
      <div ref={topRef} />
      {pending && drawing ? <PendingFrame key={`pending-${drawing.id}`} brief={drawing.brief} /> : null}
      {views.map((view) => (
        <ViewFrame
          key={view.message.id}
          view={view}
          onClose={() => setHidden((set) => new Set(set).add(view.message.id))}
        />
      ))}
    </section>
  );
}
