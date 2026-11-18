/**
 * Side-by-side lanes for a day's timed stops in the calendar. Each stop is drawn `blockMin` long;
 * stops that overlap share their group's width, and a lane is reused once its stop has ended.
 */
export interface Lane {
  lane: number;
  /** How many lanes the stop's overlapping group needs. */
  lanes: number;
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function layoutLanes(stops: readonly { id: string; time: string }[], blockMin: number): Map<string, Lane> {
  const sorted = stops
    .map((s, index) => ({ id: s.id, start: minutes(s.time), index }))
    .sort((a, b) => a.start - b.start || a.index - b.index);
  const result = new Map<string, Lane>();
  let group: { id: string; lane: number }[] = [];
  let groupEnd = -Infinity;
  /** When each lane in the current group frees up. */
  let laneEnds: number[] = [];

  const closeGroup = () => {
    const lanes = laneEnds.length;
    for (const g of group) result.set(g.id, { lane: g.lane, lanes });
    group = [];
    laneEnds = [];
  };

  for (const s of sorted) {
    if (s.start >= groupEnd) {
      closeGroup();
      groupEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= s.start);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = s.start + blockMin;
    groupEnd = Math.max(groupEnd, s.start + blockMin);
    group.push({ id: s.id, lane });
  }
  closeGroup();
  return result;
}
