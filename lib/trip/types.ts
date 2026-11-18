/** The trip plan on screen. Every change goes through `applyAction` (lib/trip/reducer.ts). */

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export type StopKind = "sight" | "food" | "transport" | "other";

export interface Stop {
  id: string;
  title: string;
  /** 24h "HH:MM". */
  time?: string;
  area?: string;
  note?: string;
  /** Estimated cost per person, in the trip's currency. Always shown as an estimate. */
  estimate?: number;
  kind?: StopKind;
}

export type StopInput = Omit<Stop, "id">;

export interface Day {
  id: string;
  /** Known when the caller named the day or a start date is set. */
  weekday?: Weekday;
  area?: string;
  stops: Stop[];
}

export interface Trip {
  title: string;
  destination?: string;
  /** ISO 4217 code, e.g. "EUR". */
  currency: string;
  /** "YYYY-MM-DD". */
  startDate?: string;
  budget?: number;
  view: "days" | "calendar";
  days: Day[];
  /** Ids of the stops or days the latest change touched, for the highlight. */
  lastChanged: string[];
  /** Bumped by every successful change. */
  revision: number;
  /** The next number for a `d<n>` or `s<n>` id. */
  nextId: number;
}

export const EMPTY_TRIP: Trip = {
  title: "",
  currency: "EUR",
  view: "days",
  days: [],
  lastChanged: [],
  revision: 0,
  nextId: 1,
};

export type TripAction =
  | {
      type: "create_trip";
      title: string;
      destination?: string;
      currency?: string;
      days: { weekday?: Weekday; area?: string; stops: StopInput[] }[];
    }
  | { type: "add_stop"; dayId: string; stop: StopInput; position?: number }
  | { type: "update_stop"; stopId: string; changes: Partial<StopInput>; toDayId?: string }
  | { type: "move_stop"; stopId: string; toDayId: string; position?: number; time?: string }
  | { type: "remove_stop"; stopId: string }
  | { type: "set_view"; view: "days" | "calendar" }
  | { type: "set_trip_details"; title?: string; startDate?: string; budget?: number; currency?: string };

export type ActionResult = { ok: true; trip: Trip; message: string } | { ok: false; error: string };
