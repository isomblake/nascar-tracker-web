// Race-engineering metrics built from per-lap public timing data.
// Tire age is exact only when a verified tire-change/pit event is supplied.
// Otherwise callers must label run boundaries as inferred.

const toSet = (values) => new Set((values || []).map(Number).filter(Number.isFinite));

export function splitLapsIntoRuns(laps, options = {}) {
  const pitLaps = toSet(options.pitLaps);
  const cautionLaps = toSet(options.cautionLaps);
  const explicitRunStarts = toSet(options.runStartLaps);
  const sorted = (laps || [])
    .map((row) => ({ lap: Number(row?.[0]), time: Number(row?.[1]) }))
    .filter((row) => Number.isInteger(row.lap) && row.lap > 0 && Number.isFinite(row.time) && row.time > 0 && row.time < 300)
    .sort((a, b) => a.lap - b.lap);

  const runs = [];
  let current = [];
  let previousLap = null;
  const finish = () => {
    if (!current.length) return;
    runs.push({
      runNumber: runs.length + 1,
      startLap: current[0].lap,
      endLap: current[current.length - 1].lap,
      laps: current.map((row, index) => ({ ...row, tireAge: index + 1 })),
    });
    current = [];
  };

  for (const row of sorted) {
    const isBoundaryLap = pitLaps.has(row.lap) || cautionLaps.has(row.lap);
    const explicitStart = explicitRunStarts.has(row.lap);
    const hasGap = previousLap != null && row.lap !== previousLap + 1;
    if (isBoundaryLap) {
      finish();
      previousLap = row.lap;
      continue;
    }
    if (explicitStart || hasGap) finish();
    current.push(row);
    previousLap = row.lap;
  }
  finish();
  return runs;
}

export function summarizeRun(run) {
  const laps = run?.laps || [];
  const times = laps.map((row) => Number(row.time)).filter((time) => Number.isFinite(time) && time > 0);
  if (!times.length) return null;
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const firstFive = times.slice(0, 5);
  const lastFive = times.slice(-5);
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const avg = mean(times);
  const variance = mean(times.map((time) => (time - avg) ** 2));
  const slope = times.length >= 3
    ? (() => {
        const xMean = (times.length - 1) / 2;
        const numerator = times.reduce((sum, y, x) => sum + (x - xMean) * (y - avg), 0);
        const denominator = times.reduce((sum, _, x) => sum + (x - xMean) ** 2, 0);
        return denominator ? numerator / denominator : null;
      })()
    : null;
  return {
    lapCount: times.length,
    average: avg,
    median,
    best: Math.min(...times),
    firstFiveAverage: mean(firstFive),
    lastFiveAverage: mean(lastFive),
    firstToLastFiveDelta: times.length >= 10 && firstFive.length === 5 && lastFive.length === 5
      ? mean(lastFive) - mean(firstFive)
      : null,
    standardDeviation: Math.sqrt(variance),
    trendSecondsPerLap: slope,
  };
}

export function compareRunsByTireAge(primaryRun, competitorRun, windows = [[1, 5], [6, 10], [11, 15], [16, 20], [21, 30]]) {
  const indexByAge = (run) => new Map((run?.laps || []).map((row) => [Number(row.tireAge), Number(row.time)]));
  const primary = indexByAge(primaryRun);
  const competitor = indexByAge(competitorRun);
  const comparisons = windows.map(([startAge, endAge]) => {
    const ages = [];
    for (let age = startAge; age <= endAge; age++) {
      if (primary.has(age) && competitor.has(age)) ages.push(age);
    }
    const requiredMatches = Math.ceil((endAge - startAge + 1) * 0.8);
    const delta = ages.length >= requiredMatches
      ? ages.reduce((sum, age) => sum + primary.get(age) - competitor.get(age), 0) / ages.length
      : null;
    return { startAge, endAge, matchedLaps: ages.length, deltaSecondsPerLap: delta };
  });
  return {
    comparisons,
    matchedTireAges: comparisons.reduce((sum, item) => sum + item.matchedLaps, 0),
    note: "Tire-age comparison is valid only when both run boundaries represent actual tire changes.",
  };
}

export function compareLapByLap(primaryLaps, competitorLaps) {
  const toMap = (rows) => new Map((rows || []).map((row) => [Number(row?.[0]), Number(row?.[1])])
    .filter(([lap, time]) => Number.isInteger(lap) && lap > 0 && Number.isFinite(time) && time > 0));
  const primary = toMap(primaryLaps);
  const competitor = toMap(competitorLaps);
  const common = [...primary.keys()].filter((lap) => competitor.has(lap)).sort((a, b) => a - b);
  let cumulativeDelta = 0;
  const rows = common.map((lap, index) => {
    const delta = primary.get(lap) - competitor.get(lap);
    cumulativeDelta += delta;
    return {
      lap,
      primaryTime: primary.get(lap),
      competitorTime: competitor.get(lap),
      lapDeltaSeconds: delta,
      cumulativeDeltaSeconds: cumulativeDelta,
      consecutiveFromPrevious: index === 0 || lap === common[index - 1] + 1,
    };
  });
  return {
    rows,
    latestCommonLap: common.length ? common[common.length - 1] : null,
    commonLapCount: common.length,
    latestLapDeltaSeconds: rows.length ? rows[rows.length - 1].lapDeltaSeconds : null,
    cumulativeDeltaSeconds: rows.length ? cumulativeDelta : null,
  };
}

export function getPitStopTireCount(stop) {
  const details = stop?.details || stop || {};
  const keys = ["left_front_tire_changed", "left_rear_tire_changed", "right_front_tire_changed", "right_rear_tire_changed"];
  const flags = keys.map((key) => details[key]).filter((value) => typeof value === "boolean");
  if (flags.length) return flags.filter(Boolean).length;
  const type = String(details.pit_stop_type ?? details.stop_type ?? "").toUpperCase();
  if (type.includes("FOUR_WHEEL_CHANGE") || type.includes("FOUR_TIRE_CHANGE")) return 4;
  if (type.includes("TWO_WHEEL_CHANGE") || type.includes("TWO_TIRE_CHANGE")) return 2;
  return null;
}

export function isTireChangePitStop(stop) {
  const count = getPitStopTireCount(stop);
  if (count != null) return count > 0;
  const details = stop?.details || stop || {};
  const type = String(details.pit_stop_type ?? details.stop_type ?? "").toUpperCase();
  return type.includes("TIRE_CHANGE") || type.includes("WHEEL_CHANGE");
}

export function buildDriverRunAnalysis(laps, options = {}) {
  const cautionLaps = toSet(options.cautionLaps);
  const explicitPitLaps = toSet(options.pitLaps);
  const hasVerifiedTireChanges = explicitPitLaps.size > 0;
  // Never infer a pit stop from lap-time delta alone: traffic, cooldown laps,
  // spins and changing track conditions can all produce legitimate slow laps.
  const inferredPitLaps = new Set();
  const pitLaps = new Set(explicitPitLaps);
  const runs = splitLapsIntoRuns(laps, { pitLaps: [...pitLaps], cautionLaps: [...cautionLaps] });
  return {
    runs: runs.map((run) => ({
      ...run,
      summary: summarizeRun(run),
      tireAgeBasis: hasVerifiedTireChanges && inferredPitLaps.size ? "mixed-pit-events-and-inference" : hasVerifiedTireChanges ? "official-pit-event" : "inferred-run-boundary",
      tireAgeConfidence: hasVerifiedTireChanges && inferredPitLaps.size === 0 ? "higher" : "estimated",
    })),
    pitLaps: [...pitLaps].sort((a, b) => a - b),
    hasVerifiedTireChanges,
    tireAgeBasis: hasVerifiedTireChanges && inferredPitLaps.size ? "mixed-pit-events-and-inference" : hasVerifiedTireChanges ? "official-pit-event" : "inferred-run-boundary",
  };
}

export function formatOfficialLeaderGap(driver, leader) {
  if (!driver || !leader) return null;
  const driverLaps = Number(driver.laps_completed);
  const leaderLaps = Number(leader.laps_completed);
  const lapDifference = Number.isFinite(driverLaps) && Number.isFinite(leaderLaps)
    ? leaderLaps - driverLaps : null;

  const delta = Number(driver.delta_leader);
  const hasOfficialSeconds = driver.delta_leader != null && Number.isFinite(delta) && delta >= 0;
  // Cars cross the timing line at different moments. A one-lap completed-count
  // difference with a sub-lap official interval is a transient, not a real deficit.
  const referenceLapTime = Number(leader.last_lap_time) > 0
    ? Number(leader.last_lap_time)
    : Number(driver.last_lap_time);
  const isCrossingLineTransient = lapDifference === 1 &&
    hasOfficialSeconds && referenceLapTime > 0 &&
    delta < referenceLapTime * 0.75;

  if (lapDifference > 0 && !isCrossingLineTransient) {
    return { label: `${lapDifference} lap${lapDifference === 1 ? "" : "s"} down`, type: "laps", value: lapDifference, timeGapSeconds: null };
  }
  if (lapDifference < 0) {
    const lapsAhead = Math.abs(lapDifference);
    return { label: `${lapsAhead} lap${lapsAhead === 1 ? "" : "s"} ahead`, type: "laps", value: lapDifference, timeGapSeconds: null };
  }
  if (!hasOfficialSeconds) return null;
  return delta === 0
    ? { label: "LEADER", type: "leader", value: 0, timeGapSeconds: 0 }
    : { label: `${delta.toFixed(2)}s`, type: "seconds", value: delta, timeGapSeconds: delta };
}

export function estimatePaceDeficitPerLap(driverAverage, leaderAverage) {
  const driver = Number(driverAverage);
  const leader = Number(leaderAverage);
  if (driverAverage == null || leaderAverage == null ||
      !Number.isFinite(driver) || !Number.isFinite(leader) ||
      driver <= 0 || leader <= 0) return null;
  return driver - leader;
}

export function compareOfficialTiming(primary, competitor) {
  if (!primary || !competitor) return null;
  const primaryLaps = Number(primary.laps_completed);
  const competitorLaps = Number(competitor.laps_completed);
  const primaryDelta = Number(primary.delta_leader);
  const competitorDelta = Number(competitor.delta_leader);
  const lapDifference = primaryLaps - competitorLaps;
  const referenceLapTime = Number(competitor.last_lap_time) > 0
    ? Number(competitor.last_lap_time)
    : Number(primary.last_lap_time);
  const crossingLineTransient = Number.isFinite(lapDifference) && Math.abs(lapDifference) === 1 &&
    primary.delta_leader != null && competitor.delta_leader != null &&
    Number.isFinite(primaryDelta) && Number.isFinite(competitorDelta) &&
    primaryDelta >= 0 && competitorDelta >= 0 && referenceLapTime > 0 &&
    Math.max(primaryDelta, competitorDelta) < referenceLapTime * 0.75;
  if (Number.isFinite(primaryLaps) && Number.isFinite(competitorLaps) && primaryLaps > 0 && competitorLaps > 0 && primaryLaps !== competitorLaps && !crossingLineTransient) {
    return {
      lapDelta: lapDifference,
      gapSeconds: null,
      source: "official-lap-count",
    };
  }
  const primaryDelta = Number(primary.delta_leader);
  if (Number.isFinite(primaryDelta) && Number.isFinite(competitorDelta) &&
      primary.delta_leader != null && competitor.delta_leader != null &&
      primaryDelta >= 0 && competitorDelta >= 0 &&
      (primaryLaps === competitorLaps || !Number.isFinite(primaryLaps) || !Number.isFinite(competitorLaps))) {
    return {
      lapDelta: 0,
      gapSeconds: primaryDelta - competitorDelta,
      source: "difference-of-official-leader-deltas",
    };
  }
  return null;
}
