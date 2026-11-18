/** Holds the trip and applies actions to it. Tool handlers read and write it synchronously. */
import { applyAction } from "./reducer";
import { EMPTY_TRIP } from "./types";
import type { ActionResult, Trip, TripAction } from "./types";

export interface TripStore {
  getState(): Trip;
  dispatch(action: TripAction): ActionResult;
  subscribe(cb: () => void): () => void;
}

export function createTripStore(initial: Trip = EMPTY_TRIP): TripStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const result = applyAction(state, action);
      if (result.ok) {
        state = result.trip;
        for (const cb of [...listeners]) cb();
      }
      return result;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
