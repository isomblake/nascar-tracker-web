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
    .filter((row) => Number.isInteger(row.lap) && row.lap > 0 && Number.isFinite(row.time) && row.time > 0)
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
    firstToLastFiveDelta: firstFive.length === 5 && lastFive.length === 5
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
    const delta = ages.length
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

export function buildDriverRunAnalysis(laps, options = {}) {
  const cautionLaps = toSet(options.cautionLaps);
  const explicitPitLaps = toSet(options.pitLaps);
  const validTimes = (laps || []).map((row) => Number(row?.[1])).filter((time) => Number.isFinite(time) && time > 0 && time < 300);
  const best = validTimes.length ? Math.min(...validTimes) : null;
  const hasOfficialPitEvents = explicitPitLaps.size > 0;
  const inferredPitLaps = new Set();
  if (!hasOfficialPitEvents && best != null) {
    for (const row of laps || []) {
      const lap = Number(row?.[0]);
      const time = Number(row?.[1]);
      if (Number.isInteger(lap) && time > best + 20 && !cautionLaps.has(lap)) inferredPitLaps.add(lap);
    }
  }
  const pitLaps = new Set([...explicitPitLaps, ...inferredPitLaps]);
  const runs = splitLapsIntoRuns(laps, { pitLaps: [...pitLaps], cautionLaps: [...cautionLaps] });
  return {
    runs: runs.map((run) => ({
      ...run,
      summary: summarizeRun(run),
      tireAgeBasis: hasOfficialPitEvents ? "official-pit-event" : "inferred-run-boundary",
      tireAgeConfidence: hasOfficialPitEvents ? "higher" : "estimated",
    })),
    pitLaps: [...pitLaps].sort((a, b) => a - b),
    hasOfficialPitEvents,
    tireAgeBasis: hasOfficialPitEvents ? "official-pit-event" : "inferred-run-boundary",
  };
}
