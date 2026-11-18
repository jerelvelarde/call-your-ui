"use client";
/**
 * Registers the trip's edits as CopilotKit frontend tools and shares the plan as agent context.
 * Nothing here knows about voice: a CopilotKit chat could use the same tools.
 */
import { useMemo } from "react";
import { z } from "zod";
import { useAgentContext, useFrontendTools } from "@/lib/cpk";
import type { FrontendTool } from "@/lib/cpk";
import { weekdayOf } from "@/lib/trip/dates";
import { describeTrip } from "@/lib/trip/describe";
import type { TripStore } from "@/lib/trip/store";
import { TRIP_TOOLS } from "@/lib/trip/tools";
import type { Trip } from "@/lib/trip/types";
import type { DrawRequest, DrawResult } from "@/lib/types";

/** Today in the user's time zone, "YYYY-MM-DD". */
export function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Runs one trip tool against the store: the message the voice reads back, or the error. */
export function runTripTool(store: TripStore, name: string, args: Record<string, unknown>): string {
  const def = TRIP_TOOLS.find((t) => t.name === name);
  if (!def) return `Error: unknown tool "${name}".`;
  const result = store.dispatch(def.toAction(args));
  return result.ok ? result.message : `Error: ${result.error}`;
}

export function useTripTools(store: TripStore, trip: Trip, draw: (req: DrawRequest) => Promise<DrawResult>) {
  const tools = useMemo<FrontendTool<any>[]>(
    () => [
      ...TRIP_TOOLS.map(
        (def): FrontendTool<any> => ({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          followUp: false,
          handler: async (args: Record<string, unknown>) => runTripTool(store, def.name, args),
        }),
      ),
      {
        name: "show_panel",
        description:
          "Draw a panel of generated UI under the plan, for anything the plan can't show by itself, such as a cost breakdown or a comparison. The panel writer only sees the brief, so put every number and label in it.",
        parameters: z.object({
          brief: z
            .string()
            .describe(
              "What the panel shows: its purpose, its layout (e.g. a total, a bar per day, a row per category) and every number, worked out from the plan.",
            ),
        }),
        followUp: false,
        handler: async ({ brief }: { brief: string }, ctx) => {
          const result = await draw({ brief, target: "new", source: "voice", callId: ctx.toolCall.id, signal: ctx.signal });
          return result.ok ? "The panel is on screen." : `Error: ${result.error ?? "the panel could not be drawn."}`;
        },
      },
    ],
    [store, draw],
  );
  useFrontendTools(tools, [tools]);

  useAgentContext({ description: "Trip plan (use these ids with the tools)", value: describeTrip(trip) });
  const today = todayISO();
  useAgentContext({ description: "Today's date", value: `${today} (${weekdayOf(today)})` });
}
