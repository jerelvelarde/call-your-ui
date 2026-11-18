import { describe, expect, it } from "vitest";
import { addDays, formatShort, nextMatchingDate, weekdayOf } from "@/lib/trip/dates";

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

  it("nextMatchingDate finds the next date on or after today that fits what was said", () => {
    expect(nextMatchingDate("2026-11-18", { weekday: "Fri", dayOfMonth: 11 })).toBe("2026-12-11");
    expect(nextMatchingDate("2026-11-18", { weekday: "Fri" })).toBe("2026-11-20");
    expect(nextMatchingDate("2026-11-18", { dayOfMonth: 25 })).toBe("2026-11-25");
    expect(nextMatchingDate("2026-11-18", { dayOfMonth: 18 })).toBe("2026-11-18");
    expect(nextMatchingDate("2026-11-18", { dayOfMonth: 3, month: 1 })).toBe("2027-01-03");
    expect(nextMatchingDate("2026-11-18", { dayOfMonth: 31, month: 2 })).toBeNull();
  });
});
