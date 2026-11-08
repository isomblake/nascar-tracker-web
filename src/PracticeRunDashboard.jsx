import React, { useMemo, useState } from "react";

const fmt = (value, digits = 3) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";

export default function PracticeRunDashboard({
  names = [],
  numbers = {},
  groups = {},
  runAnalysis = {},
  selectedDriver,
  dark = true,
  onSelectDriver,
}) {
  const [minimumLaps, setMinimumLaps] = useState("5");
  const [sortBy, setSortBy] = useState("longest");
  const [groupFilter, setGroupFilter] = useState("0");

  const colors = {
    panel: dark ? "#101a29" : "#ffffff",
    panelAlt: dark ? "#172235" : "#f5f7fa",
    border: dark ? "#263247" : "#dce2ea",
    text: dark ? "#e8eef7" : "#172235",
    muted: dark ? "#8b9bb0" : "#66758a",
    accent: "#2563eb",
    good: "#16a34a",
  };

  const allRuns = useMemo(() => names.flatMap((name) => {
    const runs = Array.isArray(runAnalysis?.[name]?.runs) ? runAnalysis[name].runs : [];
    return runs.map((run) => ({
      name,
      number: numbers[name] || "?",
      group: groups[name] || null,
      runNumber: run.runNumber,
      startLap: run.startLap,
      endLap: run.endLap,
      laps: Array.isArray(run.laps) ? run.laps.length : 0,
      average: Number(run.summary?.average),
      best: Number(run.summary?.best),
      median: Number(run.summary?.median),
      consistency: Number(run.summary?.standardDeviation),
      fade: run.summary?.firstToLastFiveDelta == null
        ? null
        : Number(run.summary.firstToLastFiveDelta),
      trend: run.summary?.trendSecondsPerLap == null
        ? null
        : Number(run.summary.trendSecondsPerLap),
      tireAgeConfidence: run.tireAgeConfidence || "estimated",
      tireAgeBasis: run.tireAgeBasis || "inferred-run-boundary",
    }));
  }), [names, numbers, groups, runAnalysis]);

  const visibleRuns = useMemo(() => {
    const minimum = Number(minimumLaps);
    const filtered = allRuns.filter((run) =>
      run.laps >= minimum &&
      (groupFilter === "0" || String(run.group) === groupFilter)
    );
    return filtered.sort((a, b) => {
      if (sortBy === "fastest") return a.average - b.average || b.laps - a.laps;
      if (sortBy === "consistent") return a.consistency - b.consistency || b.laps - a.laps;
      if (sortBy === "fade") return (b.fade ?? -Infinity) - (a.fade ?? -Infinity);
      return b.laps - a.laps || a.average - b.average;
    });
  }, [allRuns, minimumLaps, sortBy, groupFilter]);

  const fieldNames = names.filter((name) =>
    groupFilter === "0" || String(groups[name]) === groupFilter
  );
  const driversWithData = new Set(allRuns
    .filter((run) => groupFilter === "0" || String(run.group) === groupFilter)
    .map((run) => run.name)).size;
  const driversWithTenLapRun = new Set(allRuns
    .filter((run) => run.laps >= 10 && (groupFilter === "0" || String(run.group) === groupFilter))
    .map((run) => run.name)).size;
  const longestRun = allRuns.reduce((max, run) =>
    groupFilter === "0" || String(run.group) === groupFilter
      ? Math.max(max, run.laps)
      : max, 0);
  const totalRuns = allRuns.filter((run) =>
    groupFilter === "0" || String(run.group) === groupFilter
  ).length;

  const cardStyle = {
    background: colors.panel,
    border: "1px solid " + colors.border,
    borderRadius: 9,
    padding: "11px 12px",
    minWidth: 0,
  };
  const metric = (label, value, detail) => (
    <div style={cardStyle}>
      <div style={{ fontSize: 9, color: colors.muted, fontWeight: 800, letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 850, color: colors.text, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {detail && <div style={{ fontSize: 9, color: colors.muted, marginTop: 2 }}>{detail}</div>}
    </div>
  );

  return (
    <div style={{ padding: "12px", color: colors.text }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 850 }}>Practice run analysis</div>
        <div style={{ fontSize: 11, color: colors.muted, lineHeight: 1.5, marginTop: 4 }}>
          Every row is one continuous run. Runs end at a missing source lap, a caution lap, or a recorded pit lap. Slow laps alone do not create a new run.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8, marginBottom: 12 }}>
        {metric("DRIVERS WITH LAP DATA", driversWithData + " / " + fieldNames.length)}
        {metric("CONTINUOUS RUNS", totalRuns)}
        {metric("DRIVERS WITH 10+ LAP RUN", driversWithTenLapRun)}
        {metric("LONGEST RUN", longestRun + " laps")}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <label style={{ fontSize: 10, color: colors.muted, fontWeight: 800 }}>
          MIN RUN LENGTH
          <select value={minimumLaps} onChange={(event) => setMinimumLaps(event.target.value)} style={{ display: "block", marginTop: 4, padding: "7px 8px", color: colors.text, background: colors.panel, border: "1px solid " + colors.border, borderRadius: 6 }}>
            <option value="1">All runs</option>
            <option value="5">5+ laps</option>
            <option value="10">10+ laps</option>
            <option value="15">15+ laps</option>
          </select>
        </label>
        <label style={{ fontSize: 10, color: colors.muted, fontWeight: 800 }}>
          SORT RUNS BY
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} style={{ display: "block", marginTop: 4, padding: "7px 8px", color: colors.text, background: colors.panel, border: "1px solid " + colors.border, borderRadius: 6 }}>
            <option value="longest">Longest first</option>
            <option value="fastest">Fastest average</option>
            <option value="consistent">Most consistent</option>
            <option value="fade">Largest first-to-last change</option>
          </select>
        </label>
        <label style={{ fontSize: 10, color: colors.muted, fontWeight: 800 }}>
          PRACTICE GROUP
          <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} style={{ display: "block", marginTop: 4, padding: "7px 8px", color: colors.text, background: colors.panel, border: "1px solid " + colors.border, borderRadius: 6 }}>
            <option value="0">All drivers</option>
            <option value="1">Group 1</option>
            <option value="2">Group 2</option>
          </select>
        </label>
      </div>

      <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "11px 12px", background: colors.panelAlt, borderBottom: "1px solid " + colors.border, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 850 }}>Individual continuous runs</div>
            <div style={{ fontSize: 10, color: colors.muted, marginTop: 2 }}>{visibleRuns.length} runs meet the selected filter</div>
          </div>
          <div style={{ fontSize: 9, color: colors.muted, textAlign: "right" }}>Average lap time · lower is faster</div>
        </div>
        {visibleRuns.length === 0 ? (
          <div style={{ padding: 18, fontSize: 12, color: colors.muted }}>No runs meet the selected filters.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 610, borderCollapse: "collapse", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr style={{ color: colors.muted, background: colors.panelAlt, textAlign: "right" }}>
                  <th style={{ padding: "9px 8px", textAlign: "left" }}>DRIVER / RUN</th>
                  <th style={{ padding: "9px 8px" }}>LAPS</th>
                  <th style={{ padding: "9px 8px" }}>AVG</th>
                  <th style={{ padding: "9px 8px" }}>BEST</th>
                  <th style={{ padding: "9px 8px" }}>STD DEV</th>
                  <th style={{ padding: "9px 8px" }}>FIRST 5 → LAST 5</th>
                </tr>
              </thead>
              <tbody>
                {visibleRuns.map((run, index) => (
                  <tr key={run.name + "-" + run.runNumber} onClick={() => onSelectDriver && onSelectDriver(run.name)} style={{ borderTop: "1px solid " + colors.border, background: run.name === selectedDriver ? (dark ? "#173452" : "#edf5ff") : "transparent", cursor: onSelectDriver ? "pointer" : "default" }}>
                    <td style={{ padding: "9px 8px", textAlign: "left", whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 800, color: run.name === selectedDriver ? colors.accent : colors.text }}>#{run.number} {run.name}</div>
                      <div style={{ color: colors.muted, fontSize: 9, marginTop: 2 }}>Run {run.runNumber} · L{run.startLap}–L{run.endLap}</div>
                    </td>
                    <td style={{ padding: "9px 8px", textAlign: "right", fontWeight: 800 }}>{run.laps}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right", fontWeight: 800 }}>{fmt(run.average)}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right" }}>{fmt(run.best)}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right" }}>{fmt(run.consistency)}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right", color: run.fade == null ? colors.muted : run.fade > 0 ? "#dc2626" : colors.good }}>{run.fade == null ? "—" : (run.fade > 0 ? "+" : "") + fmt(run.fade) + " s"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ fontSize: 9, color: colors.muted, lineHeight: 1.5, marginTop: 10 }}>
        STD DEV measures lap-time variation within that run. First 5 → Last 5 is the change in average lap time; positive means the final five were slower. Run age should be treated as estimated unless event data explicitly confirms a tire change. Averages from runs of different lengths are not perfectly comparable, so use the run-length filter before comparing pace.
      </div>
    </div>
  );
}
