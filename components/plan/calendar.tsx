"use client";
import type { CSSProperties } from "react";
import { layoutLanes } from "@/lib/trip/lanes";
import { dayLabel } from "@/lib/trip/reducer";
import type { Stop, Trip } from "@/lib/trip/types";
import { StopCard } from "./stop-card";

const HOUR_PX = 44;
/** A stop is drawn as this long: the plan has start times, not durations. */
const BLOCK_MIN = 60;

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The hours to show: at least 08:00–22:00, widened to fit every stop. */
function hourRange(trip: Trip): [number, number] {
  const times = trip.days.flatMap((d) => d.stops.map((s) => s.time).filter((t): t is string => !!t)).map(minutes);
  const first = times.length ? Math.floor(Math.min(...times) / 60) : 8;
  const last = times.length ? Math.ceil((Math.max(...times) + BLOCK_MIN) / 60) : 22;
  return [Math.min(8, first), Math.min(24, Math.max(22, last))];
}

export function Calendar({ trip, enterDelays }: { trip: Trip; enterDelays: ReadonlyMap<string, number> }) {
  const changed = new Set(trip.lastChanged);
  const [startHour, endHour] = hourRange(trip);
  const height = (endHour - startHour) * HOUR_PX;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const columns = `56px repeat(${trip.days.length}, minmax(0, 1fr))`;

  const card = (stop: Stop, extra: CSSProperties = {}) => (
    <StopCard
      key={stop.id}
      stop={stop}
      currency={trip.currency}
      flash={changed.has(stop.id)}
      flashKey={trip.revision}
      enterDelay={enterDelays.get(stop.id)}
      compact
      style={extra}
    />
  );

  return (
    <div className="calendar">
      <div className="cal-heads" style={{ gridTemplateColumns: columns }}>
        <span />
        {trip.days.map((day, i) => (
          <header key={day.id} className="cal-head" data-day-id={day.id} data-weekday={day.weekday ?? ""}>
            <span className="day-label">{dayLabel(trip, i)}</span>
            {day.area ? <span className="day-area">{day.area}</span> : null}
            {day.stops.some((s) => !s.time) ? (
              <div className="cal-anytime">{day.stops.filter((s) => !s.time).map((s) => card(s))}</div>
            ) : null}
          </header>
        ))}
      </div>
      <div className="cal-grid" style={{ gridTemplateColumns: columns, height }}>
        <div className="cal-hours">
          {hours.map((h) => (
            <span key={h} style={{ top: (h - startHour) * HOUR_PX }}>
              {String(h).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {trip.days.map((day) => {
          const timed = day.stops.filter((s): s is Stop & { time: string } => !!s.time);
          const lanes = layoutLanes(timed, BLOCK_MIN);
          return (
            <div key={day.id} className="cal-col" style={{ backgroundSize: `100% ${HOUR_PX}px` }}>
              {timed.map((stop) => {
                const start = minutes(stop.time);
                const { lane, lanes: count } = lanes.get(stop.id) ?? { lane: 0, lanes: 1 };
                const width = 100 / count;
                return card(stop, {
                  position: "absolute",
                  top: ((start - startHour * 60) / 60) * HOUR_PX + 1,
                  height: (BLOCK_MIN / 60) * HOUR_PX - 3,
                  left: `calc(${lane * width}% + 4px)`,
                  width: `calc(${width}% - 8px)`,
                });
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
