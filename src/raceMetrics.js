// Shared race timing and practice-group helpers.
// Gap values are calculated from public lap-time history, not a direct NASCAR interval feed.

function toLapMap(laps) {
  const map = new Map();
  for (const row of laps || []) {
    const lap = Number(row?.[0]);
    const time = Number(row?.[1]);
    if (Number.isInteger(lap) && lap > 0 && Number.isFinite(time) && time > 0) {
      map.set(lap, time);
    }
  }
  return map;
}

export function compareRaceLaps(primaryLaps, competitorLaps) {
  const primary = toLapMap(primaryLaps);
  const competitor = toLapMap(competitorLaps);
  const primaryLap = primary.size ? Math.max(...primary.keys()) : 0;
  const competitorLap = competitor.size ? Math.max(...competitor.keys()) : 0;
  const lapDelta = primaryLap - competitorLap;
  const commonLaps = [...primary.keys()]
    .filter((lap) => competitor.has(lap))
    .sort((a, b) => a - b);
  const latestCommonLap = commonLaps.length ? commonLaps[commonLaps.length - 1] : null;

  const recent = commonLaps.slice(-10);
  const recentDeltas = recent.map((lap) => primary.get(lap) - competitor.get(lap));
  const paceDelta5 = recentDeltas.length >= 5
    ? recentDeltas.slice(-5).reduce((sum, value) => sum + value, 0) / 5
    : null;
  const paceDelta10 = recentDeltas.length >= 10
    ? recentDeltas.reduce((sum, value) => sum + value, 0) / 10
    : null;
  const lastLapDelta = recentDeltas.length ? recentDeltas[recentDeltas.length - 1] : null;

  // A same-lap elapsed-time estimate is only displayed when both cars have
  // completed the same latest lap and the common lap history is substantially complete.
  let gapSeconds = null;
  if (
    primaryLap > 0 &&
    primaryLap === competitorLap &&
    latestCommonLap === primaryLap &&
    commonLaps.length >= Math.ceil(primaryLap * 0.9)
  ) {
    gapSeconds = commonLaps.reduce(
      (sum, lap) => sum + primary.get(lap) - competitor.get(lap),
      0
    );
  }

  return {
    primaryLap,
    competitorLap,
    lapDelta,
    latestCommonLap,
    commonLapCount: commonLaps.length,
    gapSeconds,
    lastLapDelta,
    paceDelta5,
    paceDelta10,
  };
}

export function normalizePracticeGroup(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value === 1 || value === 2 ? value : null;
  const text = String(value).trim().toLowerCase();
  if (/^(?:group\s*)?1$/.test(text) || text.includes("group 1")) return 1;
  if (/^(?:group\s*)?2$/.test(text) || text.includes("group 2")) return 2;
  return null;
}
