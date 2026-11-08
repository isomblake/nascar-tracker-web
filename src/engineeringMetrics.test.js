import {
  splitLapsIntoRuns,
  summarizeRun,
  compareRunsByTireAge,
  compareLapByLap,
  compareOfficialTiming,
  formatOfficialLeaderGap,
  estimatePaceDeficitPerLap,
  isTireChangePitStop,
  getPitStopTireCount,
} from "./engineeringMetrics";

describe("engineeringMetrics", () => {
  test("splits runs at pit/caution laps and missing lap numbers", () => {
    const laps = [[1, 30], [2, 30.1], [3, 30.2], [4, 45], [5, 29.8], [6, 29.9], [8, 30]];
    const runs = splitLapsIntoRuns(laps, { pitLaps: [4] });
    expect(runs.map((run) => run.laps.map((row) => row.lap))).toEqual([[1, 2, 3], [5, 6], [8]]);
    expect(runs[1].laps[0].tireAge).toBe(1);
  });

  test("summarizes average, median, consistency and falloff", () => {
    const run = { laps: [30, 30.1, 30.2, 30.3, 30.4, 30.5, 30.6, 30.7, 30.8, 30.9].map((time, i) => ({ lap: i + 1, time, tireAge: i + 1 })) };
    const summary = summarizeRun(run);
    expect(summary.lapCount).toBe(10);
    expect(summary.average).toBeCloseTo(30.45, 5);
    expect(summary.firstToLastFiveDelta).toBeCloseTo(0.5, 5);
    expect(summary.trendSecondsPerLap).toBeCloseTo(0.1, 5);
  });

  test("compares drivers at matched tire ages rather than session lap numbers", () => {
    const a = { laps: [30, 30.2, 30.4].map((time, i) => ({ tireAge: i + 1, time })) };
    const b = { laps: [30.1, 30.1, 30.1].map((time, i) => ({ tireAge: i + 1, time })) };
    const result = compareRunsByTireAge(a, b, [[1, 3]]);
    expect(result.comparisons[0].matchedLaps).toBe(3);
    expect(result.comparisons[0].deltaSecondsPerLap).toBeCloseTo(0.1, 5);
  });

  test("distinguishes tire-change stops from fuel-only or unknown stops", () => {
    expect(isTireChangePitStop({ details: { left_front_tire_changed: true, right_front_tire_changed: false } })).toBe(true);
    expect(isTireChangePitStop({ details: { left_front_tire_changed: false, left_rear_tire_changed: false, right_front_tire_changed: false, right_rear_tire_changed: false } })).toBe(false);
    expect(isTireChangePitStop({ details: { pit_stop_type: "FOUR_TIRE_CHANGE" } })).toBe(true);
    expect(isTireChangePitStop({ details: { pit_stop_type: "FOUR_WHEEL_CHANGE" } })).toBe(true);
    expect(isTireChangePitStop({ details: { pit_stop_type: "TWO_WHEEL_CHANGE_LEFT" } })).toBe(true);
    expect(getPitStopTireCount({ details: { pit_stop_type: "FOUR_WHEEL_CHANGE" } })).toBe(4);
    expect(getPitStopTireCount({ details: { pit_stop_type: "FOUR_TIRE_CHANGE" } })).toBe(4);
    expect(getPitStopTireCount({ details: { pit_stop_type: "TWO_WHEEL_CHANGE_LEFT" } })).toBe(2);
    expect(getPitStopTireCount({ details: { pit_stop_type: "OTHER" } })).toBeNull();
    expect(isTireChangePitStop({ details: { total_duration: 13.2 } })).toBe(false);
  });

  test("uses official leader deltas for same-lap interval comparisons", () => {
    const result = compareOfficialTiming(
      { laps_completed: 100, delta_leader: 12.4 },
      { laps_completed: 100, delta_leader: 11.1 }
    );
    expect(result.gapSeconds).toBeCloseTo(1.3, 5);
    expect(result.source).toBe("difference-of-official-leader-deltas");
    const crossing = compareOfficialTiming(
      { laps_completed: 9, delta_leader: 4.2, last_lap_time: 34.4 },
      { laps_completed: 8, delta_leader: 3.6, last_lap_time: 34.5 }
    );
    expect(crossing).toEqual({ lapDelta: 0, gapSeconds: 0.6, source: "difference-of-official-leader-deltas" });
  });

  test("formats time to leader as seconds on the same lap and laps down otherwise", () => {
    expect(formatOfficialLeaderGap(
      { laps_completed: 443, delta_leader: 1.346 },
      { laps_completed: 443, delta_leader: 0 }
    )).toEqual({ label: "1.35s", type: "seconds", value: 1.346, timeGapSeconds: 1.346 });
    expect(formatOfficialLeaderGap(
      { laps_completed: 8, delta_leader: 4.236, last_lap_time: 34.647 },
      { laps_completed: 9, delta_leader: 0, last_lap_time: 34.37 }
    )).toEqual({ label: "4.24s", type: "seconds", value: 4.236, timeGapSeconds: 4.236 });
    expect(formatOfficialLeaderGap(
      { laps_completed: 8, delta_leader: 34.2, last_lap_time: 34.6 },
      { laps_completed: 9, delta_leader: 0, last_lap_time: 34.3 }
    )).toEqual({ label: "1 lap down", type: "laps", value: 1, timeGapSeconds: null });
    expect(formatOfficialLeaderGap(
      { laps_completed: 440, delta_leader: -3, vehicle_elapsed_time: 10238.595 },
      { laps_completed: 443, delta_leader: 0, vehicle_elapsed_time: 10173.195 }
    )).toEqual({ label: "3 laps down", type: "laps", value: 3, timeGapSeconds: null });
    expect(formatOfficialLeaderGap(
      { laps_completed: 443, delta_leader: 0 },
      { laps_completed: 443, delta_leader: 0 }
    )).toEqual({ label: "LEADER", type: "leader", value: 0, timeGapSeconds: 0 });
  });

  test("calculates estimated pace deficit per lap", () => {
    expect(estimatePaceDeficitPerLap(30.2, 29.8)).toBeCloseTo(0.4, 5);
    expect(estimatePaceDeficitPerLap(29.4, 29.8)).toBeCloseTo(-0.4, 5);
    expect(estimatePaceDeficitPerLap(null, 29.8)).toBeNull();
  });

  test("does not interpret negative NASCAR lap-down sentinel values as seconds", () => {
    expect(compareOfficialTiming(
      { laps_completed: 442, delta_leader: -1 },
      { laps_completed: 442, delta_leader: -1 }
    )).toBeNull();
  });

  test("returns lap-by-lap and cumulative time deltas", () => {
    const result = compareLapByLap([[10, 30], [11, 30.2], [12, 30.1]], [[10, 30.1], [11, 30.1], [12, 30.3]]);
    expect(result.rows[0].lapDeltaSeconds).toBeCloseTo(-0.1, 5);
    expect(result.rows[1].lapDeltaSeconds).toBeCloseTo(0.1, 5);
    expect(result.rows[2].lapDeltaSeconds).toBeCloseTo(-0.2, 5);
    expect(result.cumulativeDeltaSeconds).toBeCloseTo(-0.2, 5);
    expect(result.latestCommonLap).toBe(12);
  });
});
