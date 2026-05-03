import { useState, useMemo, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useLiveSession } from "./useLiveSession";
import { useHistorySession } from "./useHistorySession";
import SessionControl from "./SessionControl";

/* ═══ HISTORY FETCH ═══ */
async function fetchHistory(trackName, series = 1, forceRefresh = false, runType = 3) {
  const base = process.env.REACT_APP_SUPABASE_URL;
  const key  = process.env.REACT_APP_SUPABASE_ANON_KEY;
  const r = await fetch(`${base}/functions/v1/fetch-history`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ track_name: trackName, series, force_refresh: forceRefresh, run_type: runType }),
  });
  return r.json();
}

/* ═══ CONSTANTS ═══ */
const PIT_MARGIN = 5;            // seconds over best lap = pit/outlier
const ABSOLUTE_MAX = 300;        // hard cap for bad data

// Factory: given a cautionSet (from useLiveSession), returns an isCaution predicate
const makeCautionCheck = (cautionSet) => (lap) => cautionSet && cautionSet.has(lap);

// Per-driver threshold: best lap + PIT_MARGIN. Returns ABSOLUTE_MAX if no best known.
const thrFor = (BEST, driver) => {
  const b = BEST?.[driver]?.best;
  return (b != null && b > 0) ? b + PIT_MARGIN : ABSOLUTE_MAX;
};

/* ═══ HELPERS ═══ */
const sn = (n) => (n ? n.split(" ").pop() : "—");
const ft = (t) => (t != null ? t.toFixed(3) : "—");
const MF = { fontFamily: "'SF Mono','Consolas',monospace", letterSpacing: "0.5px" };

const rkColor = (r) => (r == null ? "#555" : r <= 3 ? "#22c55e" : r <= 10 ? "#eab308" : "#ef4444");

function rank(dataset, key, pri, NAMES) {
  const mv = dataset[pri]?.[key];
  if (mv == null) return null;
  return (
    NAMES.map((n) => dataset[n]?.[key])
      .filter((v) => v != null)
      .sort((a, b) => a - b)
      .filter((v) => v <= mv).length
  );
}

/* ═══ REUSABLE COMPONENTS ═══ */
function StatCell({ label, value, rk, dark }) {
  return (
    <div style={{ textAlign: "center", padding: "8px 4px", background: dark ? "#ffffff06" : "#00000006", borderRadius: 6 }}>
      <div style={{ fontSize: 9, color: dark ? "#666" : "#999", fontWeight: 700, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#2563eb", ...MF }}>{ft(value)}</div>
      {rk != null && <div style={{ fontSize: 10, fontWeight: 700, color: rkColor(rk), marginTop: 2 }}>#{rk}</div>}
    </div>
  );
}

function RankTable({ title, dataset, primary, group, compDrivers, dark, onSetPrimary, onToggleComp, extraW, NAMES, GROUPS, NUM, BEST, showRunLength }) {
  const bdr = dark ? "#1e1e3a" : "#e0e0e0";
  const fg = dark ? "#e0e0e0" : "#1a1a1a";
  const sub = dark ? "#555" : "#999";
  const acc = "#2563eb";
  const bgc = dark ? "#08081a" : "#f8f8fa";
  const [sortCol, setSortCol] = useState("t10");
  const lastKey = extraW ? "t" + extraW : "t30";
  const lastLabel = extraW ? extraW + "L" : "30L";
  const cols = [
    { key: "t5", label: "5L" }, { key: "t10", label: "10L" }, { key: "t15", label: "15L" },
    { key: "t20", label: "20L" }, { key: "t25", label: "25L" }, { key: lastKey, label: lastLabel },
    { key: "best", label: "Best" }
  ];

  const filtered = NAMES.filter((n) => group === 0 || GROUPS[n] === group);
  const sorted = [...filtered].sort((a, b) => {
    const av = dataset[a]?.[sortCol] ?? BEST[a]?.[sortCol] ?? 99;
    const bv = dataset[b]?.[sortCol] ?? BEST[b]?.[sortCol] ?? 99;
    return av - bv;
  });

  const stickyStyle = (isPri, isComp) => ({
    position: "sticky", left: 0, zIndex: 1,
    background: isPri ? (dark ? "#0d0d2a" : "#eef2ff") : isComp ? (dark ? "#0c0c20" : "#f8f8ff") : bgc,
  });

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, color: sub, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>{title}</div>
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 380, border: `1px solid ${bdr}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, ...MF, minWidth: 500, width: "100%" }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
            <tr style={{ borderBottom: `2px solid ${bdr}`, background: bgc }}>
              <th style={{ padding: "8px 6px", textAlign: "left", color: sub, fontSize: 9, fontWeight: 700, ...stickyStyle(false, false) }}>DRIVER</th>
              {showRunLength && <th style={{ padding: "8px 4px", textAlign: "right", color: sub, fontSize: 9, fontWeight: 700 }}>Run</th>}
              {cols.map((c) => (
                <th key={c.key} onClick={() => setSortCol(c.key)} style={{ padding: "8px 6px", textAlign: "right", color: sortCol === c.key ? acc : sub, fontSize: 9, fontWeight: 700, cursor: "pointer", userSelect: "none" }}>
                  {c.label}{sortCol === c.key ? " ▼" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((n, i) => {
              const d = dataset[n] || {};
              const isPri = n === primary;
              const isComp = compDrivers.includes(n);
              return (
                <tr key={n} style={{ borderBottom: `1px solid ${bdr}` }}>
                  <td style={{ padding: "8px 6px", fontWeight: isPri ? 700 : isComp ? 600 : 400, color: isPri ? acc : fg, fontSize: 11, whiteSpace: "nowrap", ...stickyStyle(isPri, isComp) }}>
                    <span style={{ color: sub, fontSize: 9, marginRight: 4 }}>{i + 1}.</span>
                    <span onClick={() => onSetPrimary && onSetPrimary(n)} style={{ cursor: "pointer" }}>#{NUM[n] || "?"} {sn(n)}</span>
                    {!isPri && <span onClick={() => onToggleComp && onToggleComp(n)} style={{ cursor: "pointer", marginLeft: 6, fontSize: 9, color: isComp ? "#ef4444" : acc }}>{isComp ? "−" : "+"}</span>}
                    {GROUPS[n] && <span style={{ fontSize: 7, color: sub, marginLeft: 3 }}>G{GROUPS[n]}</span>}
                  </td>
                  {showRunLength && <td style={{ padding: "8px 4px", textAlign: "right", color: sub, fontSize: 10 }}>{d.tl || BEST[n]?.tl || "—"}</td>}
                  {cols.map((c) => {
                    const v = d[c.key] ?? BEST[n]?.[c.key];
                    return (
                      <td key={c.key} style={{ padding: "8px 6px", textAlign: "right", color: fg, fontSize: 11 }}>{ft(v)}</td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FalloffCard({ primary, compDrivers, dark, BEST, EOR, NUM }) {
  const bdr = dark ? "#1e1e3a" : "#e0e0e0";
  const card = dark ? "#10102a" : "#fff";
  const sub = dark ? "#555" : "#999";
  const fg = dark ? "#e0e0e0" : "#1a1a1a";

  const drivers = [primary, ...compDrivers.filter((n) => n !== primary)];
  const data = drivers
    .map((n) => {
      const b = BEST[n] || {};
      const e = EOR[n] || {};
      const fo = b.t5 != null && e.t5 != null ? e.t5 - b.t5 : null;
      return { name: n, best5: b.t5, eor5: e.t5, falloff: fo };
    })
    .filter((d) => d.falloff != null);
  if (data.length === 0) return null;
  const bestFO = Math.min(...data.map((d) => d.falloff));

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, color: sub, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>TIRE DEGRADATION (5L)</div>
      <div style={{ background: card, border: `1px solid ${bdr}`, borderRadius: 10, padding: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 0, fontSize: 10 }}>
          <div style={{ padding: "6px 8px", color: sub, fontWeight: 700, fontSize: 9 }}>DRIVER</div>
          <div style={{ padding: "6px 8px", textAlign: "right", color: sub, fontWeight: 700, fontSize: 9 }}>BEST 5L</div>
          <div style={{ padding: "6px 8px", textAlign: "right", color: sub, fontWeight: 700, fontSize: 9 }}>END 5L</div>
          <div style={{ padding: "6px 8px", textAlign: "right", color: sub, fontWeight: 700, fontSize: 9 }}>FALLOFF</div>
          {data.map((d) => {
            const isPri = d.name === primary;
            const isBest = d.falloff === bestFO;
            const foColor = d.falloff <= 0.5 ? "#22c55e" : d.falloff <= 0.6 ? "#eab308" : "#ef4444";
            return [
              <div key={d.name + "n"} style={{ padding: "8px 8px", borderTop: `1px solid ${bdr}`, fontWeight: isPri ? 700 : 400, color: isPri ? "#2563eb" : fg, fontSize: 11 }}>
                {isPri ? "★ " : ""}#{NUM[d.name] || "?"} {sn(d.name)}
              </div>,
              <div key={d.name + "b"} style={{ padding: "8px 8px", borderTop: `1px solid ${bdr}`, textAlign: "right", fontSize: 11, ...MF }}>{ft(d.best5)}</div>,
              <div key={d.name + "e"} style={{ padding: "8px 8px", borderTop: `1px solid ${bdr}`, textAlign: "right", fontSize: 11, ...MF }}>{ft(d.eor5)}</div>,
              <div key={d.name + "f"} style={{ padding: "8px 8px", borderTop: `1px solid ${bdr}`, textAlign: "right", fontSize: 11, fontWeight: 700, color: foColor, ...MF }}>
                +{d.falloff.toFixed(3)}
                {isBest && <span style={{ fontSize: 8, marginLeft: 4 }}>BEST</span>}
              </div>
            ];
          })}
        </div>
      </div>
    </div>
  );
}

function PracticeCompCard({ name, primary, dark, BEST, EOR, NUM, GROUPS, extraWindow }) {
  const bdr = dark ? "#1e1e3a" : "#e0e0e0";
  const card = dark ? "#10102a" : "#fff";
  const sub = dark ? "#555" : "#999";

  if (!name || !BEST[name]) return null;
  const pb = BEST[primary] || {};
  const pe = EOR[primary] || {};
  const tb = BEST[name] || {};
  const te = EOR[name] || {};

  return (
    <div style={{ padding: 14, marginBottom: 10, background: card, border: `1px solid ${bdr}`, borderRadius: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>#{NUM[name] || "?"} {name}</div>
        <div style={{ fontSize: 10, color: sub }}>G{GROUPS[name] || "?"} · {BEST[name].tl || 0} laps</div>
      </div>
      <div style={{ fontSize: 9, color: sub, fontWeight: 700, marginBottom: 4 }}>BEST WINDOW (lower = faster)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 10 }}>
        {["t5", "t10", "t15", "t20", "t25", extraWindow ? "t" + extraWindow : "t30"].map((k) => {
          const diff = pb[k] != null && tb[k] != null ? pb[k] - tb[k] : null;
          const c = diff == null ? sub : diff > 0 ? "#22c55e" : "#ef4444";
          return (
            <div key={k} style={{ textAlign: "center", padding: "5px 0", background: dark ? "#ffffff06" : "#00000006", borderRadius: 4 }}>
              <div style={{ fontSize: 9, color: sub, fontWeight: 700 }}>{k.replace("t", "")}L</div>
              <div style={{ fontSize: 12, fontWeight: 600, ...MF }}>{ft(tb[k])}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: c, ...MF }}>{diff != null ? (diff > 0 ? "+" : "") + diff.toFixed(3) : "—"}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9, color: sub, fontWeight: 700, marginBottom: 4 }}>END OF RUN (worn tires)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
        {["t5", "t10", "t15", "t20", "t25", extraWindow ? "t" + extraWindow : "t30"].map((k) => {
          const diff = pe[k] != null && te[k] != null ? pe[k] - te[k] : null;
          const c = diff == null ? sub : diff > 0 ? "#22c55e" : "#ef4444";
          return (
            <div key={k + "e"} style={{ textAlign: "center", padding: "5px 0", background: dark ? "#ffffff06" : "#00000006", borderRadius: 4 }}>
              <div style={{ fontSize: 9, color: sub, fontWeight: 700 }}>{k.replace("t", "")}L</div>
              <div style={{ fontSize: 12, fontWeight: 600, ...MF }}>{ft(te[k])}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: c, ...MF }}>{diff != null ? (diff > 0 ? "+" : "") + diff.toFixed(3) : "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FieldRow({ name, primary, compDrivers, dark, me, onSetPrimary, onToggleComp, sortRank, sortKey, extraW, BEST, SIM_POS, NUM, LAST_LAP_TIME }) {
  const bdr = dark ? "#1e1e3a" : "#e0e0e0";
  const fg = dark ? "#e0e0e0" : "#1a1a1a";
  const sub = dark ? "#555" : "#999";
  const acc = "#2563eb";
  const d = BEST[name] || {};
  const pos = SIM_POS[name] || 99;
  const lastTime = LAST_LAP_TIME ? LAST_LAP_TIME[name] : null;
  const isPri = name === primary;
  const isComp = compDrivers.includes(name);
  const delta = !isPri && me.t10 != null && d.t10 != null ? me.t10 - d.t10 : null;
  const dc = delta == null ? sub : delta > 0 ? "#ef4444" : "#22c55e";

  return (
    <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${bdr}`, borderLeft: isComp ? `3px solid ${acc}` : "3px solid transparent", background: isPri ? (dark ? "#0d0d2a" : "#eef2ff") : "transparent" }}>
      <div style={{ width: 36, textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: isPri ? acc : sub, ...MF }}>{pos}</div>
        {sortRank != null && sortKey !== "pos" && (
          <div style={{ fontSize: 9, fontWeight: 700, color: rkColor(sortRank), marginTop: 1 }}>#{sortRank}</div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: isPri ? 700 : isComp ? 600 : 400, color: isPri ? acc : fg, marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span>
            <span onClick={() => onSetPrimary && onSetPrimary(name)} style={{ cursor: "pointer" }}>#{NUM[name] || "?"} {name}</span>
            {!isPri && onToggleComp && <span onClick={() => onToggleComp(name)} style={{ cursor: "pointer", marginLeft: 6, fontSize: 10, color: isComp ? "#ef4444" : acc }}>{isComp ? "−" : "+"}</span>}
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: sortKey === "last" ? acc : fg, ...MF }}>{lastTime != null ? lastTime.toFixed(3) : "—"}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
          {["t5", "t10", "t15", "t20", "t25", extraW ? "t" + extraW : "t30"].map((k) => (
            <div key={k}>
              <span style={{ fontSize: 8, color: sub }}>{k.replace("t", "")}L </span>
              <span style={{ fontSize: 10, ...MF }}>{ft(d[k])}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ textAlign: "right", paddingLeft: 12, minWidth: 60 }}>
        {isPri ? (
          <div style={{ fontSize: 14, fontWeight: 600, ...MF }}>{ft(d.best)}</div>
        ) : (
          <div style={{ fontSize: 13, fontWeight: 700, color: dc, ...MF }}>{delta != null ? (delta > 0 ? "+" : "") + delta.toFixed(3) : "—"}</div>
        )}
        <div style={{ fontSize: 9, color: sub, marginTop: 2 }}>{d.tl || 0}L</div>
      </div>
    </div>
  );
}

/* ═══ MAIN ═══ */
export default function App() {
  const live = useLiveSession();
  const { BEST, EOR, LAPS, NUM, CLR, GROUPS, SIM_POS, STINT, LAST_PIT, LAST_LAP_TIME, NAMES, session, status, error, cautionSet } = live;
  const isCaution = makeCautionCheck(cautionSet);

  const [dark, setDark] = useState(true);
  const [mode, setMode] = useState("race");

  // ── History state ──────────────────────────────────────────────
  const [historySessionId, setHistorySessionId] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const hist = useHistorySession(historySessionId);

  // ── Practice history state ─────────────────────────────────────
  const [practHistSessionId, setPractHistSessionId] = useState(null);
  const [practHistLoading, setPractHistLoading] = useState(false);
  const [practHistError, setPractHistError] = useState(null);
  const practHist = useHistorySession(practHistSessionId);
  const [tab, setTab] = useState(0);
  const [primary, setPrimary] = useState("Brad Keselowski");
  const [compDrivers, setCompDrivers] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [pView, setPView] = useState("dashboard");
  const [pGroup, setPGroup] = useState(0);
  const [cDrivers, setCDrivers] = useState(new Set(["Brad Keselowski"]));
  const [fieldSort, setFieldSort] = useState("pos");
  const [compMode, setCompMode] = useState("last");
  const [extraWindow, setExtraWindow] = useState(null);
  const [heroExpanded, setHeroExpanded] = useState(false);
  const [chartWindow, setChartWindow] = useState(50); // laps to show, or 0 = all

  const bg = dark ? "#08081a" : "#f8f8fa";
  const fg = dark ? "#e0e0e0" : "#1a1a1a";
  const card = dark ? "#10102a" : "#fff";
  const bdr = dark ? "#1e1e3a" : "#e0e0e0";
  const sub = dark ? "#555" : "#999";
  const acc = "#2563eb";

  // Derive primaryResolved defensively — falls back to first driver if configured primary not yet in data
  const primaryResolved = BEST[primary] ? primary : (NAMES[0] || primary);
  const me = BEST[primaryResolved] || {};
  const myPos = SIM_POS[primaryResolved] || 99;
  const myThr = thrFor(BEST, primaryResolved);
  const myCl = (LAPS[primaryResolved] || []).filter(([n, t]) => t > 0 && t <= myThr && !isCaution(n));
  const myAll = LAPS[primaryResolved] || [];
  const myLast = myCl.slice(-10);
  const myLastTime = myLast.length ? myLast[myLast.length - 1][1] : null;

  // ALL HOOKS MUST BE DECLARED BEFORE ANY CONDITIONAL RETURN
  const fieldRanked = useMemo(() => NAMES.map((n) => ({ name: n, pos: SIM_POS[n] || 99 })).sort((a, b) => a.pos - b.pos), [NAMES, SIM_POS]);
  const aheadName = useMemo(() => { const f = fieldRanked.find((x) => x.pos === myPos - 1); return f ? f.name : null; }, [fieldRanked, myPos]);
  const behindName = useMemo(() => { const f = fieldRanked.find((x) => x.pos === myPos + 1); return f ? f.name : null; }, [fieldRanked, myPos]);

  const chartData = useMemo(() => {
    const allLapNums = new Set();
    [...cDrivers].forEach((n) => (LAPS[n] || []).forEach(([l]) => allLapNums.add(l)));
    const sortedLaps = [...allLapNums].sort((a, b) => a - b);
    // Apply window: show only last N laps (0 = all)
    const windowed = chartWindow > 0 ? sortedLaps.slice(-chartWindow) : sortedLaps;
    return windowed.map((lap) => {
      const pt = { lap };
      cDrivers.forEach((n) => {
        const f = (LAPS[n] || []).find(([l]) => l === lap);
        const dThr = thrFor(BEST, n);
        if (f && f[1] > 0 && f[1] <= dThr) pt[n] = f[1];
      });
      return pt;
    });
  }, [cDrivers, LAPS, BEST, chartWindow]);

  const toggleC = useCallback((n) => setCDrivers((p) => { const s = new Set(p); if (s.has(n)) s.delete(n); else s.add(n); return s; }), []);

  const toggleComp = useCallback((n) => {
    setCompDrivers((prev) => prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]);
  }, []);

  const callout = useMemo(() => {
    const r5 = rank(EOR, "t5", primaryResolved, NAMES);
    const r10 = rank(EOR, "t10", primaryResolved, NAMES);
    if (r5 != null && r5 <= 2) return { text: sn(primaryResolved) + " #" + r5 + " in end-of-run 5-lap pace" };
    if (r10 != null && r10 <= 3) return { text: sn(primaryResolved) + " top 3 in end-of-run 10-lap pace" };
    return null;
  }, [primaryResolved, EOR, NAMES]);

  // NOW safe to do early-return rendering for empty data
  if (!NAMES || NAMES.length === 0) {
    return (
      <div style={{ background: bg, minHeight: "100vh", color: fg, fontFamily: "'SF Pro Display',-apple-system,sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ textAlign: "center", maxWidth: 400 }}>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 16 }}>NASCAR RACE ANALYTICS</div>
          <div style={{ fontSize: 14, color: sub, marginBottom: 20 }}>
            {status === "connecting" && "Connecting to Supabase..."}
            {status === "loading" && "Loading session..."}
            {status === "no_session" && "No active session. Tap START below during a live NASCAR session."}
            {status === "error" && `Error: ${error}`}
            {status === "live" && "Waiting for lap data..."}
          </div>
          {session && (
            <div style={{ fontSize: 11, color: sub, marginTop: 12 }}>
              Last: {session.track_name} · {session.session_type} · {session.session_date}
            </div>
          )}
        </div>
        <SessionControl session={session} dark={dark} onAfterAction={live.reload} />
      </div>
    );
  }

  const HH = 60, MTH = 44, TH = 44;

  /* ─── Comparison card for race mode ─── */
  const RaceComp = ({ label, emoji, name, borderColor, isBehind }) => {
    if (!name || !BEST[name]) {
      return (<div style={{ padding: 12, marginBottom: 8, background: card, border: `1px solid ${bdr}`, borderRadius: 10, color: sub, fontSize: 11 }}>{label}: —</div>);
    }
    const compData = compMode === "best" ? BEST : EOR;
    const s = compData[name] || {};
    const meD = compData[primaryResolved] || {};
    const lapCount = extraWindow === "all" ? 9999 : (extraWindow || 30);

    const theirThr = thrFor(BEST, name);
    const theirCl = (LAPS[name] || []).filter(([n, t]) => t > 0 && t <= theirThr && !isCaution(n));
    const myClLaps = myCl;
    const cPairs = Math.min(myClLaps.length, theirCl.length, 5);
    const myLL = myClLaps.length > 0 ? myClLaps[myClLaps.length - 1][1] : null;
    const theirLL = theirCl.length > 0 ? theirCl[theirCl.length - 1][1] : null;
    const d = (myLL != null && theirLL != null) ? myLL - theirLL : null;
    const dc = d == null ? sub : d > 0 ? "#ef4444" : "#22c55e";

    // All-lap maps (crossing-time gap and per-lap delta bars both use these)
    const myMap = new Map((LAPS[primaryResolved] || []).map(([n, t]) => [n, t]));
    const theirMap = new Map((LAPS[name] || []).map(([n, t]) => [n, t]));

    // Gap trend: positive = my laps slower than theirs.
    const gapPerLap = cPairs >= 3 ? (() => {
      let t = 0;
      for (let i = 0; i < cPairs; i++) {
        t += myClLaps[myClLaps.length - 1 - i][1] - theirCl[theirCl.length - 1 - i][1];
      }
      return t / cPairs;
    })() : null;

    // Crossing-time gap: sum ALL laps (including pits/cautions) since that real elapsed time
    // determines when each car actually crosses the line. Positive = primary crossed later = behind.
    let cumulativeGap = 0;
    let cumulativePairs = 0;
    for (const [lap, myT] of myMap) {
      const theirT = theirMap.get(lap);
      if (theirT != null && myT > 0 && theirT > 0) { cumulativeGap += myT - theirT; cumulativePairs++; }
    }
    const hasCumGap = cumulativePairs >= 3;
    const cumGapColor = cumulativeGap > 0 ? "#ef4444" : "#22c55e";

    // Trend label depends on whether they're ahead or behind of primary driver
    let trendLabel = null;
    let trendColor = null;
    if (gapPerLap != null) {
      if (isBehind) {
        // Car behind: their laps faster than mine = they're catching up (bad)
        // their laps slower than mine = I'm pulling away (good)
        if (gapPerLap > 0) { trendLabel = "▲ Losing"; trendColor = "#ef4444"; }
        else               { trendLabel = "▼ Extending"; trendColor = "#22c55e"; }
      } else {
        // Car ahead (default): my laps faster than theirs = closing gap (good)
        // my laps slower = falling behind (bad)
        if (gapPerLap > 0) { trendLabel = "▲ Losing"; trendColor = "#ef4444"; }
        else               { trendLabel = "▼ Closing"; trendColor = "#22c55e"; }
      }
    }

    const allNums = [...new Set([...myMap.keys(), ...theirMap.keys()])].sort((a, b) => a - b);
    const deltaLaps = (extraWindow === "all" ? allNums : allNums.slice(-lapCount)).map((n) => {
      const mt = myMap.get(n), tt = theirMap.get(n);
      // Classify this lap for display:
      //   'yel'    - field-wide caution (many cars slow)
      //   'myPit'  - I pitted (my time slow, theirs normal, not caution)
      //   'theirPit' - they pitted (their time slow, mine normal, not caution)
      //   'bothPit' - both slow but not caution (rare)
      //   'normal' - compute delta
      //   null     - no data from one or both yet
      const mySlow = mt != null && mt > myThr;
      const theirSlow = tt != null && tt > theirThr;
      const inCaution = isCaution(n);
      let kind = 'normal';
      if (inCaution) kind = 'yel';
      else if (mySlow && theirSlow) kind = 'bothPit';
      else if (mySlow) kind = 'myPit';
      else if (theirSlow) kind = 'theirPit';
      const delta = (kind === 'normal' && mt != null && tt != null) ? mt - tt : null;
      return { lap: n, kind, delta };
    });

    return (
      <div style={{ padding: "12px 14px", marginBottom: 8, background: card, border: `1px solid ${bdr}`, borderLeft: `3px solid ${borderColor || acc}`, borderRadius: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>{emoji}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>#{NUM[name] || "?"} {name}</div>
              <div style={{ fontSize: 10, color: sub }}>
                {label}
                {(() => {
                  const lp = LAST_PIT[name];
                  const curLap = (LAPS[name] || []).length ? (LAPS[name])[(LAPS[name]).length - 1][0] : null;
                  if (lp != null && curLap != null) {
                    const ago = curLap - lp;
                    return <span style={{ marginLeft: 6 }}>· pitted L{lp} ({ago} ago)</span>;
                  }
                  if (lp == null && (LAPS[name] || []).length > 3) {
                    return <span style={{ marginLeft: 6 }}>· no pit yet</span>;
                  }
                  return null;
                })()}
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: sub }}>P{SIM_POS[name] || "?"}</div>
            {hasCumGap ? (
              <>
                <div style={{ fontSize: 9, color: sub }}>GAP</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: cumGapColor, ...MF, lineHeight: 1.1 }}>{Math.abs(cumulativeGap).toFixed(2)}s</div>
                <div style={{ fontSize: 9, color: sub, marginTop: 3 }}>last lap</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: dc, ...MF }}>{d != null ? (d > 0 ? "+" : "") + d.toFixed(3) : "—"}</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 9, color: sub }}>last lap</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: dc, ...MF }}>{d != null ? (d > 0 ? "+" : "") + d.toFixed(3) : "—"}</div>
              </>
            )}
          </div>
        </div>

        {trendLabel != null && (
          <div style={{ padding: "4px 8px", borderRadius: 4, marginTop: 8, background: trendColor + "20", fontSize: 10, color: trendColor, fontWeight: 700 }}>
            {trendLabel} {Math.abs(gapPerLap).toFixed(3)}s/lap
          </div>
        )}

        {deltaLaps.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 8, color: sub, fontWeight: 700, marginBottom: 3 }}>LAP DELTAS (newest left)</div>
            <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 2 }}>
              {[...deltaLaps].reverse().map((lp) => {
                if (lp.kind === 'yel') {
                  return (
                    <div key={lp.lap} style={{ textAlign: "center", flex: "0 0 auto", minWidth: 28 }}>
                      <div style={{ fontSize: 7, color: "#eab308", ...MF }}>⚑L{lp.lap}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#eab308", ...MF }}>YEL</div>
                    </div>
                  );
                }
                if (lp.kind === 'myPit' || lp.kind === 'theirPit' || lp.kind === 'bothPit') {
                  const label = lp.kind === 'myPit' ? 'MY PIT' : lp.kind === 'theirPit' ? 'PIT' : 'PIT';
                  return (
                    <div key={lp.lap} style={{ textAlign: "center", flex: "0 0 auto", minWidth: 28 }}>
                      <div style={{ fontSize: 7, color: "#06b6d4", ...MF }}>⏱L{lp.lap}</div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#06b6d4", ...MF }}>{label}</div>
                    </div>
                  );
                }
                if (lp.delta == null) return null;
                const c = lp.delta > 0 ? "#ef4444" : "#22c55e";
                return (
                  <div key={lp.lap} style={{ textAlign: "center", flex: "0 0 auto", minWidth: 28 }}>
                    <div style={{ fontSize: 7, color: sub, ...MF }}>L{lp.lap}</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: c, ...MF }}>{lp.delta > 0 ? "+" : ""}{lp.delta.toFixed(2)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {heroExpanded && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${bdr}` }}>
            <div style={{ fontSize: 9, color: sub, fontWeight: 600, marginBottom: 4 }}>{compMode === "best" ? "RUN BEST" : "LAST N"} averages vs primary</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
              {["t5", "t10", "t15", "t20", "t25", extraWindow ? "t" + extraWindow : "t30"].map((k) => {
                const diff = meD[k] != null && s[k] != null ? meD[k] - s[k] : null;
                const c = diff == null ? sub : diff > 0 ? "#ef4444" : "#22c55e";
                return (
                  <div key={k} style={{ textAlign: "center", padding: "5px 0", background: dark ? "#ffffff06" : "#00000006", borderRadius: 4 }}>
                    <div style={{ fontSize: 9, color: sub, fontWeight: 700 }}>{k.replace("t", "")}L</div>
                    <div style={{ fontSize: 12, fontWeight: 600, ...MF }}>{ft(s[k])}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: c, ...MF, marginTop: 1 }}>{diff != null ? (diff > 0 ? "+" : "") + diff.toFixed(3) : "—"}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: bg, minHeight: "100vh", color: fg, fontFamily: "'SF Pro Display',-apple-system,sans-serif", maxWidth: 480, margin: "0 auto", overflowX: "hidden" }}>
      {/* HEADER — title row only; no mode buttons to prevent horizontal overflow */}
      <div style={{ padding: "calc(10px + env(safe-area-inset-top, 0px)) 14px 10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: HH, boxSizing: "border-box", background: bg, position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.5px" }}>RACE ANALYTICS</div>
          <div style={{ fontSize: 10, color: sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {session?.track_name?.toUpperCase() || "—"}
            {session?.current_lap != null && session?.laps_in_race != null && session.laps_in_race > 0 && (
              <span> · L{session.current_lap}/{session.laps_in_race}</span>
            )}
            {session?.stage != null && session.stage > 0 && (
              <span> · S{session.stage}</span>
            )}
            {(() => {
              const fs = session?.flag_state;
              if (fs == null) return null;
              const flagMap = {1: '● GREEN', 2: '● YELLOW', 3: '● RED', 4: '● CHECKERED', 8: '● WARMUP', 9: '● COLD'};
              const flagColor = {1: '#22c55e', 2: '#eab308', 3: '#ef4444', 4: '#06b6d4', 8: '#6b7280', 9: '#6b7280'};
              const lbl = flagMap[fs];
              if (!lbl) return null;
              return <span style={{ color: flagColor[fs] || sub, marginLeft: 6 }}>{lbl}</span>;
            })()}
            {status === 'no_session' && NAMES.length > 0 && (
              <span style={{ marginLeft: 6, color: sub }}>· REPLAY</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {["Race", "Practice", "History"].map((m) => (
            <button key={m} onClick={() => setMode(m.toLowerCase())} style={{ minWidth: 52, height: 40, padding: "0 10px", borderRadius: 6, background: mode === m.toLowerCase() ? acc : "transparent", color: mode === m.toLowerCase() ? "#fff" : fg, border: `1px solid ${bdr}`, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{m}</button>
          ))}
          <SessionControl session={session} dark={dark} onAfterAction={live.reload} compact />
          <button onClick={() => setShowSettings(!showSettings)} aria-label="Settings" style={{ width: 40, height: 40, borderRadius: 6, background: showSettings ? acc : "transparent", border: `1px solid ${bdr}`, color: showSettings ? "#fff" : fg, cursor: "pointer", fontSize: 16 }}>⚙</button>
        </div>
      </div>

      {/* MODE TABS — full-width sticky bar, no overflow possible */}
      <div style={{ display: "flex", borderBottom: `1px solid ${bdr}`, background: bg, position: "sticky", top: HH, zIndex: 10 }}>
        {["Race", "Practice", "History"].map((m) => (
          <button key={m} onClick={() => setMode(m.toLowerCase())} style={{ flex: 1, padding: "10px", background: "transparent", color: mode === m.toLowerCase() ? acc : sub, border: "none", borderBottom: mode === m.toLowerCase() ? `2px solid ${acc}` : "2px solid transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", height: MTH }}>{m}</button>
        ))}
      </div>

      {/* SETTINGS */}
      {showSettings && (
        <div style={{ padding: 14, margin: "8px 12px", background: card, border: `1px solid ${bdr}`, borderRadius: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: sub, marginBottom: 10 }}>SETTINGS</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: sub }}>Theme</div>
            <button onClick={() => setDark(!dark)} style={{ padding: "4px 12px", borderRadius: 4, background: "transparent", color: fg, border: `1px solid ${bdr}`, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{dark ? "☀ Light" : "☾ Dark"}</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: sub, marginBottom: 4 }}>Primary Driver</div>
            <select value={primaryResolved} onChange={(e) => setPrimary(e.target.value)} style={{ width: "100%", padding: 6, background: bg, color: fg, border: `1px solid ${bdr}`, borderRadius: 4, fontSize: 12 }}>
              {NAMES.map((n) => <option key={n} value={n}>#{NUM[n] || "?"} {n}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: sub, marginBottom: 4 }}>Comparison Drivers (tap to toggle)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
              {NAMES.filter((n) => n !== primaryResolved).sort((a, b) => (parseInt(NUM[a], 10) || 99) - (parseInt(NUM[b], 10) || 99)).map((n) => (
                <button key={n} onClick={() => toggleComp(n)} style={{ padding: "5px 4px", fontSize: 10, background: compDrivers.includes(n) ? acc : "transparent", color: compDrivers.includes(n) ? "#fff" : fg, border: `1px solid ${bdr}`, borderRadius: 4, cursor: "pointer", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>#{NUM[n] || "?"} {sn(n)}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══ RACE ═══ */}
      {mode === "race" && (
        <>
          <div style={{ display: "flex", borderBottom: `1px solid ${bdr}`, position: "sticky", top: HH + MTH, background: bg, zIndex: 9 }}>
            {["Dashboard", "Full Field", "Chart"].map((t, i) => (
              <button key={i} onClick={() => setTab(i)} style={{ flex: 1, padding: "10px", background: "transparent", color: tab === i ? acc : sub, border: "none", borderBottom: tab === i ? `2px solid ${acc}` : "2px solid transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", height: TH }}>{t}</button>
            ))}
          </div>

          {tab === 0 && (
            <div style={{ padding: "0 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 0, borderRadius: 5, overflow: "hidden", border: `1px solid ${bdr}` }}>
                  {[["last", "Last"], ["best", "Run Best"]].map(([v, l]) => (
                    <button key={v} onClick={() => setCompMode(v)} style={{ padding: "4px 10px", background: compMode === v ? acc : "transparent", color: compMode === v ? "#fff" : fg, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>{l}</button>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={() => setHeroExpanded(!heroExpanded)} style={{ padding: "4px 8px", borderRadius: 4, background: heroExpanded ? acc : "transparent", color: heroExpanded ? "#fff" : fg, border: `1px solid ${bdr}`, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                    {heroExpanded ? "▾ Avgs" : "▸ Avgs"}
                  </button>
                  <select value={extraWindow || ""} onChange={(e) => setExtraWindow(e.target.value || null)} style={{ padding: 4, background: bg, color: fg, border: `1px solid ${bdr}`, borderRadius: 4, fontSize: 10 }}>
                    <option value="">30L</option>
                    <option value="35">35L</option>
                    <option value="40">40L</option>
                    <option value="50">50L</option>
                    <option value="75">75L</option>
                    <option value="100">100L</option>
                    <option value="all">All</option>
                  </select>
                </div>
              </div>

              {callout && (
                <div style={{ padding: "4px 10px", borderRadius: 6, background: card, border: `1px solid ${acc}`, marginBottom: 6, fontSize: 11, color: acc, fontWeight: 600 }}>⚡ {callout.text}</div>
              )}

              <div style={{ background: dark ? acc + "10" : acc + "08", border: `1px solid ${acc}`, borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 800, color: acc }}>★ #{NUM[primaryResolved] || "?"} {sn(primaryResolved)}</span>
                    <span style={{ fontSize: 9, color: sub, marginLeft: 8 }}>L{myAll.length > 0 ? myAll[myAll.length - 1][0] : "?"} · {(STINT[primaryResolved] || []).length} into run</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 8, color: sub }}>LAST</div>
                      <div style={{ fontSize: 14, fontWeight: 700, ...MF }}>{ft(myLastTime)}</div>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800 }}>P{myPos}</div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 3, overflowX: "auto", marginBottom: 4, paddingBottom: 2 }}>
                  {[...(extraWindow === "all" ? myAll : myAll.slice(-(parseInt(extraWindow, 10) || 30)))].reverse().map(([n, t]) => {
                    const caution = isCaution(n) || t > myThr;
                    return (
                      <div key={n} style={{ flex: "0 0 auto", textAlign: "center", padding: "2px 4px", minWidth: 36 }}>
                        <div style={{ fontSize: 7, color: caution ? "#eab308" : sub }}>{caution ? "⚑" : ""}L{n}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: caution ? "#eab308" : fg, ...MF }}>{t.toFixed(2)}</div>
                      </div>
                    );
                  })}
                </div>

                {(() => {
                  const fo = EOR[primaryResolved]?.t5 != null && BEST[primaryResolved]?.t5 != null ? EOR[primaryResolved].t5 - BEST[primaryResolved].t5 : null;
                  if (fo == null) return null;
                  const c = fo <= 0.4 ? "#22c55e" : fo <= 0.6 ? "#eab308" : "#ef4444";
                  return (<div style={{ padding: "2px 6px", borderRadius: 3, background: dark ? c + "20" : c + "15", fontSize: 10, color: c, fontWeight: 700, display: "inline-block", ...MF }}>Run falloff: +{fo.toFixed(3)}s</div>);
                })()}

                {heroExpanded && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${bdr}` }}>
                    <div style={{ fontSize: 8, color: sub, fontWeight: 700, marginBottom: 3 }}>THIS RUN</div>
                    <div style={{ display: "flex", gap: 3, marginBottom: 6 }}>
                      {["t5", "t10", "t15", "t20", "t25", extraWindow ? "t" + extraWindow : "t30"].map((k) => {
                        const v = EOR[primaryResolved]?.[k];
                        const r = rank(EOR, k, primaryResolved, NAMES);
                        return (
                          <div key={k} style={{ textAlign: "center", flex: 1, padding: 2, background: dark ? "#ffffff06" : "#00000006", borderRadius: 3 }}>
                            <div style={{ fontSize: 7, color: sub, fontWeight: 600 }}>{k.replace("t", "")}L</div>
                            <div style={{ fontSize: 11, fontWeight: 600, ...MF }}>{ft(v)}</div>
                            {r != null && <div style={{ fontSize: 8, fontWeight: 700, color: rkColor(r) }}>#{r}</div>}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 8, color: sub, fontWeight: 700, marginBottom: 3 }}>RUN BEST</div>
                    <div style={{ display: "flex", gap: 3 }}>
                      {["t5", "t10", "t15", "t20", "t25", extraWindow ? "t" + extraWindow : "t30"].map((k) => {
                        const v = BEST[primaryResolved]?.[k];
                        const r = rank(BEST, k, primaryResolved, NAMES);
                        return (
                          <div key={k + "b"} style={{ textAlign: "center", flex: 1, padding: 2, background: dark ? "#ffffff06" : "#00000006", borderRadius: 3 }}>
                            <div style={{ fontSize: 7, color: sub, fontWeight: 600 }}>{k.replace("t", "")}L</div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: dark ? "#aaa" : "#444", ...MF }}>{ft(v)}</div>
                            {r != null && <div style={{ fontSize: 8, fontWeight: 700, color: rkColor(r) }}>#{r}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ fontSize: 9, color: sub, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>POSITION BATTLE</div>
              <RaceComp label="Car Ahead" emoji="▲" name={aheadName} borderColor="#22c55e" />
              <RaceComp label="Car Behind" emoji="▼" name={behindName} borderColor="#ef4444" isBehind />

              {compDrivers.filter((n) => n !== primaryResolved && n !== aheadName && n !== behindName).length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 9, color: sub, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>COMPARISONS</div>
                  {compDrivers.filter((n) => n !== primaryResolved && n !== aheadName && n !== behindName).map((n) => (
                    <RaceComp key={n} label="Custom" emoji="◆" name={n} borderColor={CLR[n] || acc} />
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 1 && (
            <div>
              <div style={{ display: "flex", gap: 0, padding: "6px 14px", borderBottom: `1px solid ${bdr}`, overflowX: "auto", position: "sticky", top: HH + MTH + TH, background: bg, zIndex: 8 }}>
                {[{ k: "pos", l: "Pos" }, { k: "last", l: "Last" }, { k: "t5", l: "5L" }, { k: "t10", l: "10L" }, { k: "t15", l: "15L" }, { k: "t20", l: "20L" }, { k: "t25", l: "25L" }, { k: extraWindow ? "t" + extraWindow : "t30", l: extraWindow ? extraWindow + "L" : "30L" }, { k: "best", l: "Best" }].map((c) => (
                  <button key={c.k} onClick={() => setFieldSort(c.k)} style={{ padding: "6px 10px", background: "transparent", border: "none", color: fieldSort === c.k ? acc : sub, fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                    {c.l}{fieldSort === c.k ? " ▼" : ""}
                  </button>
                ))}
                <select value={extraWindow || ""} onChange={(e) => setExtraWindow(e.target.value || null)} style={{ marginLeft: "auto", padding: "4px 6px", background: bg, color: fg, border: `1px solid ${bdr}`, borderRadius: 4, fontSize: 11 }}>
                  <option value="">30L</option><option value="35">35L</option><option value="40">40L</option><option value="50">50L</option><option value="75">75L</option><option value="100">100L</option>
                </select>
              </div>

              {(() => {
                const sortedAll = [...NAMES].sort((a, b) => {
                  if (fieldSort === "pos") return (SIM_POS[a] || 99) - (SIM_POS[b] || 99);
                  if (fieldSort === "last") return (LAST_LAP_TIME[a] ?? 99) - (LAST_LAP_TIME[b] ?? 99);
                  return (BEST[a]?.[fieldSort] ?? 99) - (BEST[b]?.[fieldSort] ?? 99);
                });
                const ranks = {};
                sortedAll.forEach((n, i) => { ranks[n] = i + 1; });
                const others = sortedAll.filter((n) => n !== primaryResolved);
                return (
                  <>
                    <div style={{ position: "sticky", top: HH + MTH + TH + 32, zIndex: 8, background: bg, borderBottom: `2px solid ${acc}` }}>
                      <FieldRow name={primaryResolved} primary={primaryResolved} compDrivers={compDrivers} dark={dark} me={me} onSetPrimary={setPrimary} sortRank={ranks[primaryResolved]} sortKey={fieldSort} extraW={extraWindow} BEST={BEST} SIM_POS={SIM_POS} NUM={NUM} LAST_LAP_TIME={LAST_LAP_TIME} />
                    </div>
                    {others.map((n) => (
                      <FieldRow key={n} name={n} primary={primaryResolved} compDrivers={compDrivers} dark={dark} me={me} onSetPrimary={setPrimary} onToggleComp={toggleComp} sortRank={ranks[n]} sortKey={fieldSort} extraW={extraWindow} BEST={BEST} SIM_POS={SIM_POS} NUM={NUM} LAST_LAP_TIME={LAST_LAP_TIME} />
                    ))}
                  </>
                );
              })()}
            </div>
          )}

          {tab === 2 && (
            <div style={{ padding: "8px 4px 0" }}>
              <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "6px 8px" }}>
                <span style={{ fontSize: 10, color: sub, alignSelf: "center" }}>Show:</span>
                {[{v: 25, l: "25L"}, {v: 50, l: "50L"}, {v: 100, l: "100L"}, {v: 0, l: "All"}].map((w) => (
                  <button key={w.v} onClick={() => setChartWindow(w.v)} style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, background: chartWindow === w.v ? acc : "transparent", color: chartWindow === w.v ? "#fff" : fg, border: `1px solid ${bdr}`, borderRadius: 4, cursor: "pointer" }}>{w.l}</button>
                ))}
              </div>
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 8, left: -4, bottom: 8 }}>
                    <CartesianGrid stroke={dark ? "#14142a" : "#eee"} strokeDasharray="3 3" />
                    <XAxis dataKey="lap" tick={{ fill: sub, fontSize: 9 }} interval="preserveStartEnd" />
                    <YAxis domain={["auto", "auto"]} tick={{ fill: sub, fontSize: 9 }} tickFormatter={(v) => v.toFixed(1)} />
                    <Tooltip contentStyle={{ background: dark ? "#12121f" : "#fff", border: `1px solid ${bdr}`, fontSize: 11 }} />
                    {[...cDrivers].map((n) => LAPS[n] ? (<Line key={n} type="monotone" dataKey={n} stroke={CLR[n] || acc} strokeWidth={n === primaryResolved ? 3 : 1.5} dot={false} />) : null)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "8px 8px" }}>
                {[...NAMES].sort((a, b) => (parseInt(NUM[a], 10) || 99) - (parseInt(NUM[b], 10) || 99)).map((n) => (
                  <button key={n} onClick={() => toggleC(n)} style={{ padding: "4px 8px", fontSize: 10, background: cDrivers.has(n) ? (CLR[n] || acc) : "transparent", color: cDrivers.has(n) ? "#fff" : fg, border: `1px solid ${cDrivers.has(n) ? (CLR[n] || acc) : bdr}`, borderRadius: 4, cursor: "pointer", fontWeight: 600 }}>#{NUM[n] || "?"} {sn(n)}</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══ PRACTICE ═══ */}
      {mode === "practice" && (() => {
        const usingPH = practHistSessionId != null && practHist.NAMES?.length > 0;
        const pB = usingPH ? practHist.BEST : BEST;
        const pE = usingPH ? practHist.EOR : EOR;
        const pL = usingPH ? practHist.LAPS : LAPS;
        const pG = usingPH ? practHist.GROUPS : GROUPS;
        const pN = usingPH ? practHist.NUM : NUM;
        const pNA = usingPH ? practHist.NAMES : NAMES;
        const pC = usingPH ? practHist.CLR : CLR;
        const pPri = pNA.includes(primaryResolved) ? primaryResolved : (pNA[0] || primaryResolved);
        const pSess = usingPH ? practHist.session : session;

        // Chart data computed from the active practice source (historical or live)
        const pChartData = (() => {
          const allLapNums = new Set();
          [...cDrivers].forEach((n) => (pL[n] || []).forEach(([l]) => allLapNums.add(l)));
          const sorted = [...allLapNums].sort((a, b) => a - b);
          const windowed = chartWindow > 0 ? sorted.slice(-chartWindow) : sorted;
          return windowed.map((lap) => {
            const pt = { lap };
            cDrivers.forEach((n) => {
              const f = (pL[n] || []).find(([l]) => l === lap);
              const dThr = thrFor(pB, n);
              if (f && f[1] > 0 && f[1] <= dThr) pt[n] = f[1];
            });
            return pt;
          });
        })();

        const handleLoadPractHist = async (runType) => {
          const trackName = session?.track_name;
          const seriesNum = session?.series ?? 1;
          if (!trackName) return;
          setPractHistLoading(true);
          setPractHistError(null);
          setPractHistSessionId(null);
          try {
            const res = await fetchHistory(trackName, seriesNum, false, runType);
            if (res.ok && res.sessions?.length > 0) {
              setPractHistSessionId(res.sessions[0].id);
            } else {
              setPractHistError(res.message || res.error || "No practice data found.");
            }
          } catch (e) {
            setPractHistError(e.message || "Fetch failed.");
          } finally {
            setPractHistLoading(false);
          }
        };

        return (
        <>
          {/* Practice source banner */}
          <div style={{ padding: "6px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${bdr}`, background: usingPH ? (dark ? "#0d0d2a" : "#eef2ff") : bg }}>
            <div style={{ fontSize: 10, color: usingPH ? acc : sub }}>
              {usingPH
                ? `${pSess?.track_name || ""} · ${pSess?.session_type?.toUpperCase() || ""} · ${pSess?.session_date || ""}`
                : session?.track_name ? `LIVE · ${session.track_name}` : "No live session"}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {usingPH && (
                <button onClick={() => { setPractHistSessionId(null); setPractHistError(null); }}
                  style={{ padding: "3px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4, border: `1px solid ${bdr}`, background: "transparent", color: sub, cursor: "pointer" }}>
                  ✕ Live
                </button>
              )}
              {session?.track_name && (
                <>
                  <button onClick={() => handleLoadPractHist(1)} disabled={practHistLoading}
                    style={{ padding: "3px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4, border: `1px solid ${bdr}`, background: "transparent", color: fg, cursor: practHistLoading ? "wait" : "pointer", opacity: practHistLoading ? 0.6 : 1 }}>
                    {practHistLoading ? "…" : "P1"}
                  </button>
                  <button onClick={() => handleLoadPractHist(2)} disabled={practHistLoading}
                    style={{ padding: "3px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4, border: `1px solid ${acc}`, background: usingPH ? acc : "transparent", color: usingPH ? "#fff" : acc, cursor: practHistLoading ? "wait" : "pointer", opacity: practHistLoading ? 0.6 : 1 }}>
                    {practHistLoading ? "…" : "Final"}
                  </button>
                </>
              )}
            </div>
          </div>
          {practHistError && (
            <div style={{ padding: "6px 12px", fontSize: 11, color: "#ef4444" }}>{practHistError}</div>
          )}

          <div style={{ display: "flex", borderBottom: `1px solid ${bdr}`, position: "sticky", top: HH + MTH, background: bg, zIndex: 9 }}>
            {["Dashboard", "Chart"].map((t) => (
              <button key={t} onClick={() => setPView(t.toLowerCase().replace(" ", ""))} style={{ flex: 1, padding: "10px", background: "transparent", color: pView === t.toLowerCase().replace(" ", "") ? acc : sub, border: "none", borderBottom: pView === t.toLowerCase().replace(" ", "") ? `2px solid ${acc}` : "2px solid transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", height: TH }}>{t}</button>
            ))}
          </div>

          {pView === "dashboard" && (
            <div style={{ padding: "0 12px" }}>
              <div style={{ display: "flex", gap: 6, marginTop: 10, justifyContent: "center", marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
                {[{ l: "All", v: 0 }, { l: "Group 1", v: 1 }, { l: "Group 2", v: 2 }].map((g) => (
                  <button key={g.v} onClick={() => setPGroup(g.v)} style={{ padding: "6px 16px", borderRadius: 4, background: pGroup === g.v ? acc : "transparent", color: pGroup === g.v ? "#fff" : fg, border: `1px solid ${bdr}`, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{g.l}</button>
                ))}
                <select value={extraWindow || ""} onChange={(e) => setExtraWindow(e.target.value || null)} style={{ padding: 4, background: bg, color: fg, border: `1px solid ${bdr}`, borderRadius: 4, fontSize: 10 }}>
                  <option value="">30L</option><option value="35">35L</option><option value="40">40L</option><option value="50">50L</option><option value="75">75L</option><option value="100">100L</option>
                </select>
              </div>

              <div style={{ background: dark ? acc + "10" : acc + "08", border: `1px solid ${acc}`, borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: acc }}>★ #{pN[pPri] || "?"} {pPri}</div>
                  <div style={{ fontSize: 10, color: sub }}>G{pG[pPri] || "?"} · {pB[pPri]?.tl || 0} laps</div>
                </div>
                <div style={{ fontSize: 9, color: sub, fontWeight: 700, marginBottom: 4 }}>BEST WINDOW</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 10 }}>
                  {["t5", "t10", "t15", "t20", "t25", extraWindow ? "t" + extraWindow : "t30"].map((k) => (
                    <StatCell key={k} label={k.replace("t", "") + "L"} value={pB[pPri]?.[k]} rk={rank(pB, k, pPri, pNA.filter((n) => pGroup === 0 || pG[n] === pGroup))} dark={dark} />
                  ))}
                </div>
                <div style={{ fontSize: 9, color: sub, fontWeight: 700, marginBottom: 4 }}>END OF RUN (worn tires)</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                  {["t5", "t10", "t15", "t20", "t25", extraWindow ? "t" + extraWindow : "t30"].map((k) => (
                    <StatCell key={k + "e"} label={k.replace("t", "") + "L"} value={pE[pPri]?.[k]} rk={rank(pE, k, pPri, pNA.filter((n) => pGroup === 0 || pG[n] === pGroup))} dark={dark} />
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <RankTable title="BEST WINDOW RANKINGS" dataset={pB} primary={pPri} group={pGroup} compDrivers={compDrivers} dark={dark} onSetPrimary={setPrimary} onToggleComp={toggleComp} extraW={extraWindow} NAMES={pNA} GROUPS={pG} NUM={pN} BEST={pB} />
              </div>

              <RankTable title="WORN TIRE SPEED (End of Longest Run)" dataset={pE} primary={pPri} group={pGroup} compDrivers={compDrivers} dark={dark} onSetPrimary={setPrimary} onToggleComp={toggleComp} extraW={extraWindow} NAMES={pNA} GROUPS={pG} NUM={pN} BEST={pB} showRunLength />

              <FalloffCard primary={pPri} compDrivers={compDrivers} dark={dark} BEST={pB} EOR={pE} NUM={pN} />

              {compDrivers.filter((n) => n !== pPri).length > 0 && (
                <div>
                  <div style={{ fontSize: 10, color: sub, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>HEAD TO HEAD</div>
                  {compDrivers.filter((n) => n !== pPri).map((n) => (
                    <PracticeCompCard key={n} name={n} primary={pPri} dark={dark} BEST={pB} EOR={pE} NUM={pN} GROUPS={pG} extraWindow={extraWindow} />
                  ))}
                </div>
              )}
            </div>
          )}

          {pView === "chart" && (
            <div style={{ padding: "8px 4px 0" }}>
              <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "6px 8px" }}>
                <span style={{ fontSize: 10, color: sub, alignSelf: "center" }}>Show:</span>
                {[{v: 25, l: "25L"}, {v: 50, l: "50L"}, {v: 100, l: "100L"}, {v: 0, l: "All"}].map((w) => (
                  <button key={w.v} onClick={() => setChartWindow(w.v)} style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, background: chartWindow === w.v ? acc : "transparent", color: chartWindow === w.v ? "#fff" : fg, border: `1px solid ${bdr}`, borderRadius: 4, cursor: "pointer" }}>{w.l}</button>
                ))}
              </div>
              <div style={{ height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={pChartData} margin={{ top: 8, right: 8, left: -4, bottom: 8 }}>
                    <CartesianGrid stroke={dark ? "#14142a" : "#eee"} strokeDasharray="3 3" />
                    <XAxis dataKey="lap" tick={{ fill: sub, fontSize: 9 }} interval="preserveStartEnd" />
                    <YAxis domain={["auto", "auto"]} tick={{ fill: sub, fontSize: 9 }} tickFormatter={(v) => v.toFixed(1)} />
                    <Tooltip contentStyle={{ background: dark ? "#12121f" : "#fff", border: `1px solid ${bdr}`, fontSize: 11 }} />
                    {[...cDrivers].map((n) => pL[n] ? (<Line key={n} type="monotone" dataKey={n} stroke={pC[n] || acc} strokeWidth={n === pPri ? 3 : 1.5} dot={false} />) : null)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "8px 8px" }}>
                {[...pNA].sort((a, b) => (parseInt(pN[a], 10) || 99) - (parseInt(pN[b], 10) || 99)).map((n) => (
                  <button key={n} onClick={() => toggleC(n)} style={{ padding: "4px 8px", fontSize: 10, background: cDrivers.has(n) ? (pC[n] || acc) : "transparent", color: cDrivers.has(n) ? "#fff" : fg, border: `1px solid ${cDrivers.has(n) ? (pC[n] || acc) : bdr}`, borderRadius: 4, cursor: "pointer", fontWeight: 600 }}>#{pN[n] || "?"} {sn(n)}</button>
                ))}
              </div>
            </div>
          )}
        </>
        );
      })()}
      {/* ═══ HISTORY ═══ */}
      {mode === "history" && (() => {
        const trackName = session?.track_name;
        const seriesNum = session?.series ?? 1;

        const handleLoad = async (forceRefresh = false) => {
          if (!trackName) return;
          setHistoryLoading(true);
          setHistoryError(null);
          try {
            const res = await fetchHistory(trackName, seriesNum, forceRefresh);
            if (res.ok && res.sessions && res.sessions.length > 0) {
              setHistorySessionId(res.sessions[0].id);
            } else {
              setHistoryError(res.message || res.error || "No history found.");
            }
          } catch (e) {
            setHistoryError(e.message || "Fetch failed.");
          } finally {
            setHistoryLoading(false);
          }
        };

        // Banner shown above the data regardless of state
        const HistBanner = () => (
          <div style={{ padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${bdr}` }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: acc }}>
                {hist.session
                  ? `${hist.session.track_name} · ${hist.session.session_type.toUpperCase()} · ${hist.session.session_date}`
                  : `Previous ${trackName || "track"} race`}
              </div>
              <div style={{ fontSize: 9, color: sub, marginTop: 1 }}>
                {hist.session ? `Race ID ${hist.session.race_id}` : "Historical lap data"}
              </div>
            </div>
            <button
              onClick={() => handleLoad(true)}
              disabled={historyLoading}
              style={{ padding: "4px 10px", fontSize: 10, fontWeight: 600, borderRadius: 4, border: `1px solid ${bdr}`, background: "transparent", color: sub, cursor: historyLoading ? "wait" : "pointer" }}
            >
              {historyLoading ? "…" : "↺ Refresh"}
            </button>
          </div>
        );

        // Nothing loaded yet
        if (!historySessionId && !historyLoading) {
          return (
            <div style={{ padding: 20 }}>
              <HistBanner />
              <div style={{ marginTop: 24, textAlign: "center" }}>
                {!trackName ? (
                  <div style={{ color: sub, fontSize: 13 }}>
                    Start a live session first — history loads for that track.
                  </div>
                ) : (
                  <>
                    <div style={{ color: sub, fontSize: 13, marginBottom: 16 }}>
                      Load previous race data for <strong style={{ color: fg }}>{trackName}</strong>
                    </div>
                    <button
                      onClick={() => handleLoad(false)}
                      style={{ padding: "12px 28px", borderRadius: 8, background: acc, color: "#fff", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
                    >
                      Load History
                    </button>
                    {historyError && (
                      <div style={{ marginTop: 12, color: "#ef4444", fontSize: 12 }}>{historyError}</div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        }

        if (historyLoading || hist.status === "loading") {
          return (
            <div style={{ padding: 20 }}>
              <HistBanner />
              <div style={{ textAlign: "center", color: sub, marginTop: 32, fontSize: 13 }}>Loading history…</div>
            </div>
          );
        }

        if (hist.status === "error") {
          return (
            <div style={{ padding: 20 }}>
              <HistBanner />
              <div style={{ textAlign: "center", color: "#ef4444", marginTop: 24, fontSize: 13 }}>
                Failed to load historical data.
                <br />
                <button onClick={() => handleLoad(false)} style={{ marginTop: 12, padding: "6px 16px", borderRadius: 6, background: acc, color: "#fff", border: "none", fontSize: 12, cursor: "pointer" }}>Retry</button>
              </div>
            </div>
          );
        }

        if (hist.status !== "loaded" || hist.NAMES.length === 0) {
          return (
            <div style={{ padding: 20 }}>
              <HistBanner />
              <div style={{ textAlign: "center", color: sub, marginTop: 32, fontSize: 13 }}>No lap data in this historical session.</div>
            </div>
          );
        }

        // Data loaded — render using the same analytics components
        return (
          <div>
            <HistBanner />
            <div style={{ padding: "0 12px", marginTop: 10 }}>
              <div style={{ background: dark ? acc + "10" : acc + "08", border: `1px solid ${acc}`, borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: acc }}>
                    ★ #{hist.NUM[primary] || hist.NUM[hist.NAMES[0]] || "?"} {hist.BEST[primary] ? primary : hist.NAMES[0]}
                  </div>
                  <div style={{ fontSize: 10, color: sub }}>
                    {(hist.BEST[primary] || hist.BEST[hist.NAMES[0]])?.tl || 0} laps tracked
                  </div>
                </div>
                <div style={{ fontSize: 9, color: sub, fontWeight: 700, marginBottom: 4 }}>BEST WINDOW</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                  {["t5","t10","t15","t20","t25","t30"].map((k) => {
                    const dName = hist.BEST[primary] ? primary : hist.NAMES[0];
                    const v = hist.BEST[dName]?.[k];
                    return (
                      <StatCell key={k} label={k.replace("t","")+"L"} value={v} dark={dark} />
                    );
                  })}
                </div>
              </div>

              <RankTable
                title="RACE BEST WINDOW"
                dataset={hist.BEST}
                primary={hist.BEST[primary] ? primary : hist.NAMES[0]}
                group={0}
                compDrivers={[]}
                dark={dark}
                extraW={null}
                NAMES={hist.NAMES}
                GROUPS={hist.GROUPS}
                NUM={hist.NUM}
                BEST={hist.BEST}
              />

              <RankTable
                title="WORN TIRE SPEED (End of Longest Run)"
                dataset={hist.EOR}
                primary={hist.BEST[primary] ? primary : hist.NAMES[0]}
                group={0}
                compDrivers={[]}
                dark={dark}
                extraW={null}
                NAMES={hist.NAMES}
                GROUPS={hist.GROUPS}
                NUM={hist.NUM}
                BEST={hist.BEST}
                showRunLength
              />

              <FalloffCard
                primary={hist.BEST[primary] ? primary : hist.NAMES[0]}
                compDrivers={[]}
                dark={dark}
                BEST={hist.BEST}
                EOR={hist.EOR}
                NUM={hist.NUM}
              />
            </div>
          </div>
        );
      })()}

    </div>
  );
}
