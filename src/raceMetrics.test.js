import { compareRaceLaps, normalizePracticeGroup } from "./raceMetrics";

describe("compareRaceLaps", () => {
  test("calculates a same-lap elapsed-time gap and pace deltas", () => {
    const primary = [[1, 30], [2, 31], [3, 32], [4, 33], [5, 34]];
    const competitor = [[1, 31], [2, 32], [3, 33], [4, 34], [5, 35]];
    const result = compareRaceLaps(primary, competitor);

    expect(result.lapDelta).toBe(0);
    expect(result.gapSeconds).toBe(-5);
    expect(result.lastLapDelta).toBe(-1);
    expect(result.paceDelta5).toBe(-1);
  });

  test("reports lap status instead of a misleading time gap when lap counts differ", () => {
    const primary = [[1, 30], [2, 31], [3, 32], [4, 33]];
    const competitor = [[1, 31], [2, 32], [3, 33], [4, 34], [5, 35]];
    const result = compareRaceLaps(primary, competitor);

    expect(result.lapDelta).toBe(-1);
    expect(result.gapSeconds).toBeNull();
  });

  test("suppresses a calculated gap when too much lap history is missing", () => {
    const primary = Array.from({ length: 10 }, (_, i) => [i + 1, 30 + i]);
    const competitor = primary.filter(([lap]) => lap !== 4);
    const result = compareRaceLaps(primary, competitor);

    expect(result.gapSeconds).toBeNull();
  });

  test("does not calculate rolling pace across missing lap numbers", () => {
    const primary = [[1, 30], [2, 30], [3, 30], [4, 30], [5, 30], [7, 30]];
    const competitor = [[1, 31], [2, 31], [3, 31], [4, 31], [5, 31], [7, 31]];
    const result = compareRaceLaps(primary, competitor);

    expect(result.paceDelta5).toBeNull();
  });
});

describe("normalizePracticeGroup", () => {
  test("normalizes numeric and text group labels", () => {
    expect(normalizePracticeGroup(1)).toBe(1);
    expect(normalizePracticeGroup("Group 1")).toBe(1);
    expect(normalizePracticeGroup("2")).toBe(2);
    expect(normalizePracticeGroup("Practice Group 2")).toBe(2);
    expect(normalizePracticeGroup(null)).toBeNull();
    expect(normalizePracticeGroup("unknown")).toBeNull();
  });
});
