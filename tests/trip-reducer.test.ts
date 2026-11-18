import { describe, expect, it } from "vitest";
import { describeTrip } from "@/lib/trip/describe";
import { applyAction, dayLabel } from "@/lib/trip/reducer";
import { EMPTY_TRIP } from "@/lib/trip/types";
import type { Trip, TripAction } from "@/lib/trip/types";

/** Freezes every object in the trip, so any mutation by the reducer throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as object).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const LISBON: TripAction = {
  type: "create_trip",
  title: "Three days in Lisbon",
  destination: "Lisbon",
  days: [
    {
      weekday: "Fri",
      area: "Alfama",
      stops: [
        { title: "Castelo de São Jorge", time: "09:30", estimate: 15, kind: "sight" },
        { title: "Fado dinner at a casa de fado", time: "21:00", estimate: 75, kind: "food" },
      ],
    },
    {
      weekday: "Sat",
      area: "Belém",
      stops: [
        { title: "Jerónimos Monastery", time: "11:00", estimate: 12, kind: "sight" },
        { title: "Pastéis de Belém", time: "13:00", estimate: 6, kind: "food" },
      ],
    },
    { weekday: "Sun", area: "Sintra", stops: [{ title: "Pena Palace", time: "10:00", estimate: 20, kind: "sight" }] },
  ],
};

function created(): Trip {
  const result = applyAction(EMPTY_TRIP, LISBON);
  if (!result.ok) throw new Error(result.error);
  return deepFreeze(result.trip);
}

function apply(trip: Trip, action: TripAction): Trip {
  const result = applyAction(trip, action);
  if (!result.ok) throw new Error(result.error);
  return result.trip;
}

describe("applyAction", () => {
  it("create_trip builds three labelled days with ids d1..d3 and stop ids from s4", () => {
    const trip = created();
    expect(trip.days.map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(trip.days.map((d) => d.weekday)).toEqual(["Fri", "Sat", "Sun"]);
    expect(trip.days.flatMap((d) => d.stops.map((s) => s.id))).toEqual(["s4", "s5", "s6", "s7", "s8"]);
    expect(trip.title).toBe("Three days in Lisbon");
    expect(trip.view).toBe("days");
    expect(trip.revision).toBe(1);
    expect(trip.lastChanged).toEqual(["d1", "d2", "d3"]);
  });

  it("move_stop moves a stop across days and re-sorts by time", () => {
    const result = applyAction(created(), { type: "move_stop", stopId: "s4", toDayId: "d2", time: "09:00" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trip.days[0].stops.map((s) => s.id)).toEqual(["s5"]);
    expect(result.trip.days[1].stops.map((s) => [s.id, s.time])).toEqual([
      ["s4", "09:00"],
      ["s6", "11:00"],
      ["s7", "13:00"],
    ]);
    expect(result.trip.lastChanged).toEqual(["s4"]);
    expect(result.message).toBe('Moved "Castelo de São Jorge" to Sat 09:00.');
  });

  it("update_stop replaces a stop in place keeping its id", () => {
    const result = applyAction(created(), {
      type: "update_stop",
      stopId: "s5",
      changes: { title: "Dinner at a tasca in Alfama", estimate: 30 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stop = result.trip.days[0].stops.find((s) => s.id === "s5");
    expect(stop).toMatchObject({ id: "s5", title: "Dinner at a tasca in Alfama", estimate: 30, time: "21:00" });
    expect(result.message).toBe('Replaced "Fado dinner at a casa de fado" with "Dinner at a tasca in Alfama".');
  });

  it("rejects an unknown stop id without changing the trip", () => {
    const trip = created();
    const before = JSON.stringify(trip);
    const result = applyAction(trip, { type: "remove_stop", stopId: "s99" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("s99");
    expect(JSON.stringify(trip)).toBe(before);
  });

  it("set_trip_details with a Friday date relabels Day 1..3 as Fri, Sat, Sun", () => {
    const unnamed = apply(EMPTY_TRIP, {
      type: "create_trip",
      title: "Lisbon",
      days: [{ stops: [] }, { stops: [] }, { stops: [] }],
    });
    expect(unnamed.days.map((_, i) => dayLabel(unnamed, i))).toEqual(["Day 1", "Day 2", "Day 3"]);
    const dated = apply(unnamed, { type: "set_trip_details", startDate: "2026-12-11" });
    expect(dated.days.map((d) => d.weekday)).toEqual(["Fri", "Sat", "Sun"]);
    expect(dated.startDate).toBe("2026-12-11");
  });

  it("set_trip_details rejects a date that contradicts named weekdays", () => {
    const result = applyAction(created(), { type: "set_trip_details", startDate: "2026-12-12" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("That date is a Sat, but the plan starts on Fri. Ask which they meant.");
  });

  it("rejects a bad time and a negative estimate", () => {
    const trip = created();
    const badTime = applyAction(trip, { type: "add_stop", dayId: "d1", stop: { title: "Lunch", time: "25:00" } });
    const negative = applyAction(trip, { type: "update_stop", stopId: "s4", changes: { estimate: -5 } });
    expect(badTime.ok).toBe(false);
    expect(negative.ok).toBe(false);
  });

  it("dayLabel prefers the date, then the weekday, then Day N", () => {
    const trip = created();
    expect(dayLabel(trip, 0)).toBe("Fri");
    const dated = apply(trip, { type: "set_trip_details", startDate: "2026-12-11" });
    expect(dayLabel(dated, 0)).toBe("Fri 11 Dec");
    expect(dayLabel(dated, 2)).toBe("Sun 13 Dec");
    const blank = apply(EMPTY_TRIP, { type: "create_trip", title: "x", days: [{ stops: [] }, { stops: [] }] });
    expect(dayLabel(blank, 1)).toBe("Day 2");
  });

  it("adds an untimed stop after the timed ones and keeps its position among untimed", () => {
    const trip = apply(created(), { type: "add_stop", dayId: "d3", stop: { title: "Walk the gardens" } });
    const withSecond = apply(trip, { type: "add_stop", dayId: "d3", stop: { title: "Coffee" }, position: 1 });
    expect(withSecond.days[2].stops.map((s) => s.title)).toEqual(["Pena Palace", "Coffee", "Walk the gardens"]);
  });
});

describe("describeTrip", () => {
  it("lists day ids, labels, stop ids, times, titles and estimates", () => {
    const text = describeTrip(apply(created(), { type: "move_stop", stopId: "s4", toDayId: "d2", time: "09:00" }));
    expect(text).toContain("d2 (Sat · Belém)");
    expect(text).toContain("s4 09:00 Castelo de São Jorge · €15 est.");
    expect(text).toContain("View: days");
  });

  it("says the plan is empty when there are no days", () => {
    expect(describeTrip(EMPTY_TRIP)).toContain("The plan is empty.");
  });
});
