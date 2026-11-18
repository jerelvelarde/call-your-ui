import { describe, expect, it } from "vitest";
import { addDays, formatShort, weekdayOf } from "@/lib/trip/dates";

describe("trip dates", () => {
  it("weekdayOf reads the weekday of an ISO date", () => {
    expect(weekdayOf("2026-12-11")).toBe("Fri");
    expect(weekdayOf("2026-12-13")).toBe("Sun");
  });

  it("addDays crosses month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("formatShort gives weekday, day and month", () => {
    expect(formatShort("2026-12-11")).toBe("Fri 11 Dec");
  });
});
