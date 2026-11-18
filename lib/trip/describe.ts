/** The plan as text, for the voice model's context: every id it may pass to a tool, in order. */
import { dayLabel } from "./reducer";
import type { Trip } from "./types";

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };

export function money(amount: number, currency: string): string {
  const symbol = SYMBOLS[currency];
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
}

export function describeTrip(trip: Trip): string {
  const head = [
    `Title: ${trip.title || "(none)"}`,
    trip.destination ? `Destination: ${trip.destination}` : null,
    `Currency: ${trip.currency}`,
    `View: ${trip.view}`,
    `Start date: ${trip.startDate ?? "not set"}`,
    trip.budget !== undefined ? `Budget: ${money(trip.budget, trip.currency)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (trip.days.length === 0) return `${head}\nThe plan is empty.`;
  const lines = [head];
  trip.days.forEach((day, i) => {
    lines.push(`${day.id} (${[dayLabel(trip, i), day.area].filter(Boolean).join(" · ")})`);
    if (day.stops.length === 0) lines.push("  (no stops)");
    for (const s of day.stops) {
      const parts = [`  ${s.id} ${s.time ?? "--:--"} ${s.title}`];
      if (s.estimate !== undefined) parts.push(`${money(s.estimate, trip.currency)} est.`);
      if (s.area) parts.push(s.area);
      if (s.note) parts.push(s.note);
      lines.push(parts.join(" · "));
    }
  });
  return lines.join("\n");
}
