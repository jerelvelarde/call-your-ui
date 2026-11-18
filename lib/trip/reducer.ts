/**
 * Every change to the trip. Pure: the same trip and action always give the same result, the input
 * is never mutated, and an invalid action changes nothing and says why in words the voice can use.
 */
import { addDays, formatShort, isIsoDate, shiftWeekday, weekdayOf } from "./dates";
import { EMPTY_TRIP } from "./types";
import type { ActionResult, Day, Stop, StopInput, Trip, TripAction } from "./types";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "Fri 11 Dec" when the trip has a start date, else the day's weekday, else "Day 2". */
export function dayLabel(trip: Trip, index: number): string {
  if (trip.startDate) return formatShort(addDays(trip.startDate, index));
  return trip.days[index]?.weekday ?? `Day ${index + 1}`;
}

/** Timed stops first, by time; untimed stops after them, in their existing order. */
function sortStops(stops: Stop[]): Stop[] {
  return stops
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => {
      const at = a.stop.time;
      const bt = b.stop.time;
      if (at && bt) return at === bt ? a.index - b.index : at < bt ? -1 : 1;
      if (at) return -1;
      if (bt) return 1;
      return a.index - b.index;
    })
    .map(({ stop }) => stop);
}

/** Why a stop's fields are invalid, or null. */
function stopProblem(stop: Partial<StopInput>, requireTitle: boolean): string | null {
  if (requireTitle && !stop.title?.trim()) return "A stop needs a title.";
  if (stop.title !== undefined && !stop.title.trim()) return "A stop's title can't be empty.";
  if (stop.time !== undefined && !TIME.test(stop.time)) return `"${stop.time}" is not a 24h time like 09:30.`;
  if (stop.estimate !== undefined && !(Number.isFinite(stop.estimate) && stop.estimate >= 0)) {
    return "An estimate must be a number of zero or more.";
  }
  return null;
}

/** Drops undefined fields, so they never overwrite or show up as keys. */
function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function findStop(trip: Trip, stopId: string): { dayIndex: number; stop: Stop } | null {
  for (let dayIndex = 0; dayIndex < trip.days.length; dayIndex++) {
    const stop = trip.days[dayIndex].stops.find((s) => s.id === stopId);
    if (stop) return { dayIndex, stop };
  }
  return null;
}

const noStop = (id: string) => `There is no stop "${id}". Use a stop id from the trip plan.`;
const noDay = (id: string) => `There is no day "${id}". Use a day id from the trip plan.`;

function insertAt<T>(list: T[], item: T, position?: number): T[] {
  const copy = list.slice();
  const at = position === undefined ? copy.length : Math.max(0, Math.min(copy.length, Math.floor(position)));
  copy.splice(at, 0, item);
  return copy;
}

function done(trip: Trip, next: Partial<Trip>, lastChanged: string[], message: string): ActionResult {
  return { ok: true, trip: { ...trip, ...next, lastChanged, revision: trip.revision + 1 }, message };
}

export function applyAction(trip: Trip, action: TripAction): ActionResult {
  switch (action.type) {
    case "create_trip": {
      if (!action.title?.trim()) return { ok: false, error: "A trip needs a title." };
      if (!Array.isArray(action.days) || action.days.length === 0 || action.days.length > 14) {
        return { ok: false, error: "A trip needs between 1 and 14 days." };
      }
      for (const day of action.days) {
        for (const stop of day.stops ?? []) {
          const problem = stopProblem(stop, true);
          if (problem) return { ok: false, error: problem };
        }
      }
      let nextId = trip.nextId;
      const dayIds = action.days.map(() => `d${nextId++}`);
      const days: Day[] = action.days.map((day, i) =>
        clean({
          id: dayIds[i],
          weekday: day.weekday,
          area: day.area,
          stops: sortStops((day.stops ?? []).map((stop) => clean({ ...stop, id: `s${nextId++}` }))),
        }),
      );
      const count = days.reduce((n, d) => n + d.stops.length, 0);
      // A new trip replaces everything: no start date, budget or destination carries over.
      const next: Trip = clean({
        ...EMPTY_TRIP,
        title: action.title.trim(),
        destination: action.destination,
        currency: action.currency ?? trip.currency,
        days,
        nextId,
        lastChanged: dayIds,
        revision: trip.revision + 1,
      });
      const named = days.map((d, i) => `${d.id} (${d.weekday ?? `Day ${i + 1}`})`).join(", ");
      const stops = count === 0 ? ". No stops yet." : `, with ${count} stops.`;
      return { ok: true, trip: next, message: `Planned ${days.length} days: ${named}${stops}` };
    }

    case "add_stop": {
      const dayIndex = trip.days.findIndex((d) => d.id === action.dayId);
      if (dayIndex < 0) return { ok: false, error: noDay(action.dayId) };
      const problem = stopProblem(action.stop, true);
      if (problem) return { ok: false, error: problem };
      const id = `s${trip.nextId}`;
      const stop = clean({ ...action.stop, id });
      const days = trip.days.map((d, i) =>
        i === dayIndex ? { ...d, stops: sortStops(insertAt(d.stops, stop, action.position)) } : d,
      );
      return done(trip, { days, nextId: trip.nextId + 1 }, [id], `Added "${stop.title}" to ${dayLabel(trip, dayIndex)}.`);
    }

    case "update_stop": {
      const found = findStop(trip, action.stopId);
      if (!found) return { ok: false, error: noStop(action.stopId) };
      const problem = stopProblem(action.changes, false);
      if (problem) return { ok: false, error: problem };
      const old = found.stop;
      const updated = clean({ ...old, ...clean(action.changes), id: old.id });
      const days = trip.days.map((d, i) =>
        i === found.dayIndex ? { ...d, stops: sortStops(d.stops.map((s) => (s.id === old.id ? updated : s))) } : d,
      );
      const message =
        updated.title !== old.title ? `Replaced "${old.title}" with "${updated.title}".` : `Updated "${old.title}".`;
      return done(trip, { days }, [old.id], message);
    }

    case "move_stop": {
      const found = findStop(trip, action.stopId);
      if (!found) return { ok: false, error: noStop(action.stopId) };
      const toIndex = trip.days.findIndex((d) => d.id === action.toDayId);
      if (toIndex < 0) return { ok: false, error: noDay(action.toDayId) };
      if (action.time !== undefined && !TIME.test(action.time)) {
        return { ok: false, error: `"${action.time}" is not a 24h time like 09:30.` };
      }
      const moved = action.time ? { ...found.stop, time: action.time } : found.stop;
      const days = trip.days.map((d, i) => {
        let stops = i === found.dayIndex ? d.stops.filter((s) => s.id !== moved.id) : d.stops;
        if (i === toIndex) stops = sortStops(insertAt(stops, moved, action.position));
        return stops === d.stops ? d : { ...d, stops };
      });
      const when = moved.time ? ` ${moved.time}` : "";
      return done(trip, { days }, [moved.id], `Moved "${moved.title}" to ${dayLabel(trip, toIndex)}${when}.`);
    }

    case "remove_stop": {
      const found = findStop(trip, action.stopId);
      if (!found) return { ok: false, error: noStop(action.stopId) };
      const days = trip.days.map((d, i) =>
        i === found.dayIndex ? { ...d, stops: d.stops.filter((s) => s.id !== action.stopId) } : d,
      );
      return done(trip, { days }, [], `Removed "${found.stop.title}".`);
    }

    case "set_view": {
      if (action.view !== "days" && action.view !== "calendar") {
        return { ok: false, error: 'The view is "days" or "calendar".' };
      }
      const message = action.view === "calendar" ? "Switched to the calendar." : "Switched to the day columns.";
      return done(trip, { view: action.view }, trip.days.map((d) => d.id), message);
    }

    case "set_trip_details": {
      const next: Partial<Trip> = {};
      const said: string[] = [];
      let lastChanged: string[] = [];
      if (action.title !== undefined) {
        if (!action.title.trim()) return { ok: false, error: "A trip needs a title." };
        next.title = action.title.trim();
        said.push(`the title to "${next.title}"`);
      }
      if (action.budget !== undefined) {
        if (!(Number.isFinite(action.budget) && action.budget >= 0)) {
          return { ok: false, error: "A budget must be a number of zero or more." };
        }
        next.budget = action.budget;
        said.push(`the budget to ${action.budget}`);
      }
      if (action.currency !== undefined) {
        if (!/^[A-Z]{3}$/.test(action.currency)) return { ok: false, error: 'A currency is a code like "EUR".' };
        next.currency = action.currency;
        said.push(`the currency to ${action.currency}`);
      }
      if (action.startDate !== undefined) {
        const start = action.startDate;
        if (!isIsoDate(start)) return { ok: false, error: `"${start}" is not a date like 2026-12-11.` };
        for (let i = 0; i < trip.days.length; i++) {
          const named = trip.days[i].weekday;
          if (named && weekdayOf(addDays(start, i)) !== named) {
            return {
              ok: false,
              error: `That date is a ${weekdayOf(start)}, but the plan starts on ${shiftWeekday(named, -i)}. Ask which they meant.`,
            };
          }
        }
        next.startDate = start;
        next.days = trip.days.map((d, i) => ({ ...d, weekday: weekdayOf(addDays(start, i)) }));
        lastChanged = trip.days.map((d) => d.id);
        said.push(`the start date to ${formatShort(start)}`);
      }
      if (said.length === 0) return { ok: false, error: "Nothing to change." };
      return done(trip, next, lastChanged, `Set ${said.join(", ")}.`);
    }

    default:
      return { ok: false, error: `Unknown change "${(action as { type?: unknown }).type}".` };
  }
}
