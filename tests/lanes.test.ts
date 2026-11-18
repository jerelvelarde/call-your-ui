import { describe, expect, it } from "vitest";
import { layoutLanes } from "@/lib/trip/lanes";

const stop = (id: string, time: string) => ({ id, time });

describe("layoutLanes", () => {
  it("puts two stops at the same time side by side", () => {
    expect(layoutLanes([stop("a", "09:30"), stop("b", "09:30")], 75)).toEqual(
      new Map([
        ["a", { lane: 0, lanes: 2 }],
        ["b", { lane: 1, lanes: 2 }],
      ]),
    );
  });

  it("gives stops that don't overlap the full width", () => {
    const lanes = layoutLanes([stop("a", "09:30"), stop("b", "11:00")], 75);
    expect(lanes.get("a")).toEqual({ lane: 0, lanes: 1 });
    expect(lanes.get("b")).toEqual({ lane: 0, lanes: 1 });
  });

  it("reuses a lane once its stop has ended, within one overlapping group", () => {
    // a 09:00–10:15 overlaps b 10:00–11:15; c at 10:30 starts after a ends, so it takes a's lane.
    const lanes = layoutLanes([stop("a", "09:00"), stop("b", "10:00"), stop("c", "10:30")], 75);
    expect(lanes.get("a")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("b")).toEqual({ lane: 1, lanes: 2 });
    expect(lanes.get("c")).toEqual({ lane: 0, lanes: 2 });
  });
});
