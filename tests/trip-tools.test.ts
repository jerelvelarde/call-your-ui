import { schemaToJsonSchema } from "@copilotkit/shared";
import { describe, expect, it } from "vitest";
import { createTripStore } from "@/lib/trip/store";
import { TRIP_TOOLS } from "@/lib/trip/tools";
import type { TripAction } from "@/lib/trip/types";

const ACTION_TYPES: TripAction["type"][] = [
  "create_trip",
  "add_stop",
  "update_stop",
  "move_stop",
  "remove_stop",
  "set_view",
  "set_trip_details",
];

describe("TRIP_TOOLS", () => {
  it("every TripAction type has exactly one tool", () => {
    expect(TRIP_TOOLS.map((t) => t.name).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it("each tool schema converts to JSON schema with an object root", () => {
    for (const tool of TRIP_TOOLS) {
      const schema = schemaToJsonSchema(tool.parameters) as { type?: string; properties?: object };
      expect(schema.type, tool.name).toBe("object");
      expect(typeof schema.properties, tool.name).toBe("object");
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });

  it("toAction turns validated arguments into the matching action", () => {
    const move = TRIP_TOOLS.find((t) => t.name === "move_stop")!;
    const args = move.parameters.parse({ stopId: "s4", toDayId: "d2", time: "09:00" });
    expect(move.toAction(args, { today: "2026-11-18" })).toEqual({ type: "move_stop", stopId: "s4", toDayId: "d2", time: "09:00" });
  });

  it("set_trip_details resolves a spoken start day to the next matching date", () => {
    const details = TRIP_TOOLS.find((t) => t.name === "set_trip_details")!;
    const args = details.parameters.parse({ startWeekday: "Fri", startDayOfMonth: 11 });
    expect(details.toAction(args, { today: "2026-11-18" })).toEqual({ type: "set_trip_details", startDate: "2026-12-11" });
  });

  it("set_trip_details reports a spoken start day that never comes", () => {
    const details = TRIP_TOOLS.find((t) => t.name === "set_trip_details")!;
    const args = details.parameters.parse({ startDayOfMonth: 31, startMonth: 2 });
    expect(() => details.toAction(args, { today: "2026-11-18" })).toThrow("No date in the next year matches");
  });
});

describe("createTripStore", () => {
  it("store.dispatch applies an action and notifies subscribers once", () => {
    const store = createTripStore();
    let calls = 0;
    store.subscribe(() => calls++);
    const result = store.dispatch({ type: "create_trip", title: "Lisbon", days: [{ stops: [] }] });
    expect(result.ok).toBe(true);
    expect(store.getState().title).toBe("Lisbon");
    expect(calls).toBe(1);
  });

  it("store.dispatch leaves state and subscribers untouched on error", () => {
    const store = createTripStore();
    const before = store.getState();
    let calls = 0;
    store.subscribe(() => calls++);
    const result = store.dispatch({ type: "remove_stop", stopId: "s1" });
    expect(result.ok).toBe(false);
    expect(store.getState()).toBe(before);
    expect(calls).toBe(0);
  });

  it("unsubscribe stops notifications", () => {
    const store = createTripStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    off();
    store.dispatch({ type: "create_trip", title: "Lisbon", days: [{ stops: [] }] });
    expect(calls).toBe(0);
  });
});
