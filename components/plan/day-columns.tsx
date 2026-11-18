"use client";
import { dayLabel } from "@/lib/trip/reducer";
import type { Trip } from "@/lib/trip/types";
import { StopCard } from "./stop-card";

export function DayColumns({ trip, enterDelays }: { trip: Trip; enterDelays: ReadonlyMap<string, number> }) {
  const changed = new Set(trip.lastChanged);
  return (
    <div className="days" style={{ gridTemplateColumns: `repeat(${trip.days.length}, minmax(0, 1fr))` }}>
      {trip.days.map((day, i) => (
        <section key={day.id} className="day" data-day-id={day.id} data-weekday={day.weekday ?? ""}>
          <header className="day-head" data-flash={changed.has(day.id) || undefined} key={`${day.id}-${changed.has(day.id) ? trip.revision : 0}`}>
            <span className="day-label">{dayLabel(trip, i)}</span>
            {day.area ? <span className="day-area">{day.area}</span> : null}
          </header>
          <div className="day-stops">
            {day.stops.map((stop) => (
              <StopCard
                key={stop.id}
                stop={stop}
                currency={trip.currency}
                flash={changed.has(stop.id)}
                flashKey={trip.revision}
                enterDelay={enterDelays.get(stop.id)}
              />
            ))}
            {day.stops.length === 0 ? <p className="day-empty">Nothing planned yet</p> : null}
          </div>
        </section>
      ))}
    </div>
  );
}
