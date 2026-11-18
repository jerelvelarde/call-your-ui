"use client";
import { LayoutGroup } from "motion/react";
import { useRef } from "react";
import { addDays, formatShort } from "@/lib/trip/dates";
import { money } from "@/lib/trip/describe";
import type { Trip } from "@/lib/trip/types";
import { Calendar } from "./calendar";
import { DayColumns } from "./day-columns";
import { EmptyPlan } from "./empty-plan";

/** "Fri 11 – Sun 13 Dec", "3 days", "8 stops", "€210 est. per person". */
function summary(trip: Trip): string {
  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
  const total = trip.days.reduce((n, d) => n + d.stops.reduce((m, s) => m + (s.estimate ?? 0), 0), 0);
  const parts: string[] = [];
  if (trip.startDate) {
    const end = addDays(trip.startDate, trip.days.length - 1);
    const [a, b] = [formatShort(trip.startDate), formatShort(end)];
    parts.push(a.slice(-3) === b.slice(-3) ? `${a.slice(0, -4)} – ${b}` : `${a} – ${b}`);
  }
  parts.push(`${trip.days.length} ${trip.days.length === 1 ? "day" : "days"}`);
  parts.push(`${stops} ${stops === 1 ? "stop" : "stops"}`);
  if (total > 0) parts.push(`${money(total, trip.currency)} est. per person`);
  return parts.join(" · ");
}

/**
 * Stops that weren't in the previous version of the plan fade in, one after another; moved or
 * re-laid-out stops slide instead (their layoutId stays the same).
 */
function useEnterDelays(trip: Trip): ReadonlyMap<string, number> {
  const seen = useRef<{ revision: number; ids: Set<string>; delays: Map<string, number> }>({
    revision: -1,
    ids: new Set(),
    delays: new Map(),
  });
  if (seen.current.revision !== trip.revision) {
    const ids = new Set(trip.days.flatMap((d) => d.stops.map((s) => s.id)));
    const delays = new Map<string, number>();
    let i = 0;
    for (const day of trip.days) {
      for (const stop of day.stops) if (!seen.current.ids.has(stop.id)) delays.set(stop.id, Math.min(i++ * 0.07, 1.2));
    }
    seen.current = { revision: trip.revision, ids, delays };
  }
  return seen.current.delays;
}

export function Plan({ trip, inCall }: { trip: Trip; inCall: boolean }) {
  const enterDelays = useEnterDelays(trip);
  if (trip.days.length === 0) return <EmptyPlan inCall={inCall} />;
  return (
    <section className="plan" data-view={trip.view} aria-label="Trip plan">
      <header className="plan-head">
        <h1>{trip.title}</h1>
        <p>{summary(trip)}</p>
      </header>
      <LayoutGroup>
        {trip.view === "calendar" ? (
          <Calendar trip={trip} enterDelays={enterDelays} />
        ) : (
          <DayColumns trip={trip} enterDelays={enterDelays} />
        )}
      </LayoutGroup>
    </section>
  );
}
