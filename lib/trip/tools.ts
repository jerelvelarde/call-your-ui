/**
 * The trip's edits as tool definitions. They're registered as ordinary CopilotKit frontend tools
 * (components/use-trip-tools.ts), so a chat agent or a voice call can use them the same way.
 */
import { z } from "zod";
import type { TripAction } from "./types";

export interface TripToolDef {
  name: TripAction["type"];
  description: string;
  parameters: z.ZodType<Record<string, unknown>>;
  toAction(args: Record<string, unknown>): TripAction;
}

const IDS = 'Use the ids shown in the "Trip plan" context (days look like d2, stops like s7).';
const weekday = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
const time = z.string().describe('24h time, "HH:MM", e.g. "09:30" or "21:00".');

const stopFields = {
  title: z.string().describe("Short name of the place or activity, e.g. \"Castelo de São Jorge\"."),
  time: time.optional(),
  area: z.string().optional().describe("Neighbourhood or town."),
  note: z.string().optional().describe("One short practical note, at most ten words."),
  estimate: z.number().optional().describe("Estimated cost per person in the trip currency. 0 for free."),
  kind: z.enum(["sight", "food", "transport", "other"]).optional(),
};
const stop = z.object(stopFields);

const as = <T extends TripAction["type"]>(type: T) => (args: Record<string, unknown>) => ({ type, ...args }) as TripAction;

export const TRIP_TOOLS: readonly TripToolDef[] = [
  {
    name: "create_trip",
    description:
      "Replace the whole plan with a new trip. Use it once, for a new trip, with every day and its stops. Give each day the weekday the user named, if any.",
    parameters: z.object({
      title: z.string().describe('e.g. "Three days in Lisbon".'),
      destination: z.string().optional(),
      currency: z.string().optional().describe('ISO code, default "EUR".'),
      days: z
        .array(
          z.object({
            weekday: weekday.optional().describe("Only when the user named the day."),
            area: z.string().optional().describe("Where the day is spent, e.g. a neighbourhood or a day-trip town."),
            stops: z.array(stop),
          }),
        )
        .describe("The days in order."),
    }),
    toAction: as("create_trip"),
  },
  {
    name: "add_stop",
    description: `Add one stop to a day. ${IDS}`,
    parameters: z.object({
      dayId: z.string(),
      stop,
      position: z.number().optional().describe("Only for stops without a time: where to put it in the day."),
    }),
    toAction: as("add_stop"),
  },
  {
    name: "update_stop",
    description: `Change a stop in place, or swap it for something else by giving a new title, time and estimate. ${IDS}`,
    parameters: z.object({ stopId: z.string(), changes: z.object(stopFields).partial() }),
    toAction: as("update_stop"),
  },
  {
    name: "move_stop",
    description: `Move a stop to another day, optionally at a new time. ${IDS}`,
    parameters: z.object({
      stopId: z.string(),
      toDayId: z.string(),
      time: time.optional(),
      position: z.number().optional().describe("Only for stops without a time."),
    }),
    toAction: as("move_stop"),
  },
  {
    name: "remove_stop",
    description: `Remove a stop from the plan. ${IDS}`,
    parameters: z.object({ stopId: z.string() }),
    toAction: as("remove_stop"),
  },
  {
    name: "set_view",
    description: 'Show the plan as day columns ("days") or as a calendar of the trip\'s dates ("calendar").',
    parameters: z.object({ view: z.enum(["days", "calendar"]) }),
    toAction: as("set_view"),
  },
  {
    name: "set_trip_details",
    description:
      "Set the trip's title, start date, budget or currency. Setting a start date labels the days with real dates; it fails if the date's weekday contradicts the weekdays the user already named.",
    parameters: z.object({
      title: z.string().optional(),
      startDate: z.string().optional().describe('"YYYY-MM-DD". Resolve "the eleventh" from Today\'s date.'),
      budget: z.number().optional(),
      currency: z.string().optional(),
    }),
    toAction: as("set_trip_details"),
  },
];
