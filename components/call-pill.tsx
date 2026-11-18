"use client";
import { useEffect, useRef, useState } from "react";
import type { UseCopilotCall } from "@/lib/copilot-call";
import type { CallStatus } from "@/lib/copilot-call";

const STATE_WORD: Record<CallStatus, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  "running-tool": "Editing…",
  speaking: "Speaking",
  error: "",
};
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.75, 0.95, 0.6];
/** How long the caller's last sentence stays in the pill. */
const SAID_MS = 4_000;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Six bars that follow the mic while listening and the voice while speaking. */
function Waveform({ status, getLevels }: { status: CallStatus; getLevels: UseCopilotCall["getLevels"] }) {
  const bars = useRef<(HTMLElement | null)[]>([]);
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    let raf = 0;
    const smooth = BAR_WEIGHTS.map(() => 0.15);
    const tick = (t: number) => {
      const { input, output } = getLevels();
      const s = statusRef.current;
      const level = s === "speaking" ? output : s === "listening" ? input : 0;
      const busy = s === "thinking" || s === "running-tool" || s === "connecting";
      bars.current.forEach((bar, i) => {
        if (!bar) return;
        const target = busy
          ? 0.22 + 0.18 * (0.5 + 0.5 * Math.sin(t / 180 - i * 0.7))
          : 0.14 + Math.min(1, level * 3.2) * BAR_WEIGHTS[i] * (0.75 + 0.25 * Math.sin(t / 90 + i * 1.7));
        smooth[i] += (target - smooth[i]) * 0.35;
        bar.style.transform = `scaleY(${smooth[i].toFixed(3)})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getLevels]);
  return (
    <span className="wave" aria-hidden>
      {BAR_WEIGHTS.map((_, i) => (
        <i key={i} ref={(el) => void (bars.current[i] = el)} />
      ))}
    </span>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The caller's latest finished sentence, shown for a few seconds. */
function useLastSaid(call: UseCopilotCall): string | null {
  const last = [...call.transcript].reverse().find((e) => e.role === "user" && e.final && e.text);
  const [shownId, setShownId] = useState<string | null>(null);
  useEffect(() => {
    if (!last) return;
    setShownId(last.id);
    const timer = setTimeout(() => setShownId((id) => (id === last.id ? null : id)), SAID_MS);
    return () => clearTimeout(timer);
  }, [last?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return last && shownId === last.id ? last.text : null;
}

const MicIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
    <rect x="7" y="2.5" width="6" height="10" rx="3" fill="currentColor" />
    <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    {off ? <path d="M3.5 3.5l13 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
  </svg>
);

const HangUpIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
    <path
      d="M2.6 11.6c-.4-.4-.4-1 0-1.4C4.8 8 7.3 7 10 7s5.2 1 7.4 3.2c.4.4.4 1 0 1.4l-1.5 1.5c-.3.3-.9.4-1.3.1l-1.8-1.3c-.3-.2-.4-.5-.4-.8V9.6c-1.5-.5-3.3-.5-4.8 0v1.5c0 .3-.2.6-.4.8l-1.8 1.3c-.4.3-1 .2-1.3-.1z"
      fill="currentColor"
    />
  </svg>
);

export function CallPill({ call }: { call: UseCopilotCall }) {
  const { status, error, startedAt, muted } = call;
  const now = useNow(startedAt !== null);
  const said = useLastSaid(call);

  if (status === "error") {
    return (
      <div className="call-pill" data-status="error" role="alert">
        <span className="pill-error">{error ?? "The call ended."}</span>
        <button type="button" className="pill-text-btn" data-action="close" onClick={call.stop}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="call-pill" data-status={status} aria-live="polite">
      <Waveform status={status} getLevels={call.getLevels} />
      <span className="pill-clock">{startedAt ? clock(now - startedAt) : "0:00"}</span>
      <span className="pill-state">{STATE_WORD[status]}</span>
      {said ? (
        <span className="pill-said" key={said} title={said}>
          “{said}”
        </span>
      ) : null}
      {error ? <span className="pill-warn">{error}</span> : null}
      <button
        type="button"
        className="pill-btn"
        data-action="mute"
        data-on={muted || undefined}
        aria-pressed={muted}
        aria-label={muted ? "Unmute" : "Mute"}
        onClick={() => call.setMuted(!muted)}
        disabled={status === "connecting"}
      >
        <MicIcon off={muted} />
      </button>
      <button type="button" className="pill-btn pill-end" data-action="hangup" aria-label="Hang up" onClick={call.stop}>
        <HangUpIcon />
      </button>
    </div>
  );
}
