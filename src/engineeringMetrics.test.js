import {
  splitLapsIntoRuns,
  summarizeRun,
  compareRunsByTireAge,
  compareLapByLap,
} from "./engineeringMetrics";

describe("engineeringMetrics", () => {
  test("splits runs at pit/caution laps and missing lap numbers", () => {
    const laps = [[1, 30], [2, 30.1], [3, 30.2], [4, 45], [5, 29.8], [6, 29.9], [8, 30]];
    const runs = splitLapsIntoRuns(laps, { pitLaps: [4] });
    expect(runs.map((run) => run.laps.map((row) => row.lap))).toEqual([[1, 2, 3], [5, 6], [8]]);
    expect(runs[1].laps[0].tireAge).toBe(1);
  });

  test("summarizes average, median, consistency and falloff", () => {
    const run = { laps: [30, 30.1, 30.2, 30.3, 30.4, 30.5].map((time, i) => ({ lap: i + 1, time, tireAge: i + 1 })) };
    const summary = summarizeRun(run);
    expect(summary.lapCount).toBe(6);
    expect(summary.average).toBeCloseTo(30.25, 5);
    expect(summary.firstToLastFiveDelta).toBeCloseTo(0.1, 5);
    expect(summary.trendSecondsPerLap).toBeCloseTo(0.1, 5);
  });

  test("compares drivers at matched tire ages rather than session lap numbers", () => {
    const a = { laps: [30, 30.2, 30.4].map((time, i) => ({ tireAge: i + 1, time })) };
    const b = { laps: [30.1, 30.1, 30.1].map((time, i) => ({ tireAge: i + 1, time })) };
    const result = compareRunsByTireAge(a, b, [[1, 3]]);
    expect(result.comparisons[0].matchedLaps).toBe(3);
    expect(result.comparisons[0].deltaSecondsPerLap).toBeCloseTo(0.1, 5);
  });

  test("returns lap-by-lap and cumulative time deltas", () => {
    const result = compareLapByLap([[10, 30], [11, 30.2], [12, 30.1]], [[10, 30.1], [11, 30.1], [12, 30.3]]);
    expect(result.rows.map((row) => row.lapDeltaSeconds)).toEqual([-0.1, 0.1, -0.2]);
    expect(result.cumulativeDeltaSeconds).toBeCloseTo(-0.2, 5);
    expect(result.latestCommonLap).toBe(12);
  });
});
