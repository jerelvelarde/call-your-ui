"use client";
import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { money } from "@/lib/trip/describe";
import type { Stop } from "@/lib/trip/types";

const SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 } as const;

/**
 * One stop. Its `layoutId` is the stop id, so when an edit moves it to another day, or the plan turns
 * into a calendar, the same card slides to its new place instead of popping.
 */
export function StopCard({
  stop,
  currency,
  flash,
  flashKey,
  enterDelay,
  compact = false,
  style,
}: {
  stop: Stop;
  currency: string;
  /** The latest edit touched this stop. */
  flash: boolean;
  /** Restarts the flash on every edit that touches it. */
  flashKey: number;
  /** Set for a stop that just appeared: fades in after this many seconds. */
  enterDelay?: number;
  compact?: boolean;
  style?: CSSProperties;
}) {
  const meta = [stop.area, stop.note].filter(Boolean).join(" · ");
  return (
    <motion.article
      layout
      layoutId={stop.id}
      className="stop"
      data-stop-id={stop.id}
      data-kind={stop.kind ?? "other"}
      data-compact={compact || undefined}
      style={style}
      initial={enterDelay === undefined ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { delay: enterDelay ?? 0, duration: 0.32, ease: [0.2, 0.7, 0.2, 1] } }}
      transition={{ layout: SPRING }}
    >
      {flash ? <span key={flashKey} className="stop-flash" aria-hidden /> : null}
      <div className="stop-row">
        <span className="stop-title">{stop.title}</span>
        {stop.time ? <span className="stop-time">{stop.time}</span> : null}
      </div>
      {!compact && (meta || stop.estimate !== undefined) ? (
        <div className="stop-meta">
          <span className="stop-where">{meta}</span>
          {stop.estimate !== undefined ? (
            <span className="stop-est">{stop.estimate === 0 ? "Free" : `${money(stop.estimate, currency)} est.`}</span>
          ) : null}
        </div>
      ) : null}
    </motion.article>
  );
}
