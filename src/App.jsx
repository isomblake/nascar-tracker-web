import React, { useState, useMemo, useCallback, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useLiveSession } from "./useLiveSession";
import { useHistorySession } from "./useHistorySession";
import PracticeRunDashboard from "./PracticeRunDashboard";
import SessionControl from "./SessionControl";
import { supabase } from "./supabaseClient";
import { compareRaceLaps } from "./raceMetrics";
import { compareOfficialTiming, compareLapByLap, formatOfficialLeaderGap, estimatePaceDeficitPerLap, getPitStopTireCount } from "./engineeringMetrics";

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
const ABSOLUTE_MAX = 300;        // hard cap for invalid timing records

// Factory: given a cautionSet (from useLiveSession), returns an isCaution predicate
const makeCautionCheck = (cautionSet) => (lap) => cautionSet && cautionSet.has(lap);

// Do not classify slow laps as pit/outliers from time alone. Explicit event flags
// are used by the lap/run analysis; this threshold is only an invalid-data ceiling.
const thrFor = () => ABSOLUTE_MAX;

/* ═══ HELPERS ═══ */
const sn = (n) => (n ? n.split(" ").pop() : "—");
const ft = (t) => (t != null ? t.toFixed(3) : "—");
const pitRoadDuration = (details) => {
  if (details?.total_duration != null && Number.isFinite(Number(details.total_duration))) return Number(details.total_duration);
  if (details?.pit_in_elapsed_time == null || details?.pit_out_elapsed_time == null) return null;
  const pitIn = Number(details.pit_in_elapsed_time);
  const pitOut = Number(details.pit_out_elapsed_time);
  return Number.isFinite(pitIn) && Number.isFinite(pitOut) && pitOut >= pitIn ? pitOut - pitIn : null;
};
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

function RankTable({ title, dataset, primary, group, compDrivers, dark, onSetPrimary, onToggleComp, extraW, NAMES, GROUPS, NUM, BEST, showRunLength, defaultSort = "t10" }) {
  const bdr = dark ? "#1e1e3a" : "#e0e0e0";
  const fg = dark ? "#e0e0e0" : "#1a1a1a";
  const sub = dark ? "#555" : "#999";
  const acc = "#2563eb";
  const bgc = dark ? "#08081a" : "#f8f8fa";
  const [sortCol, setSortCol] = useState(defaultSort);
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

class PracticeMatrixErrorBoundary extends React.Component {
 constructor(props) { super(props); this.state={error:null}; }
 static getDerivedStateFromError(error) { return {error}; }
 componentDidCatch(error,info) { console.error("Practice Lap Matrix failed",error,info); }
 render() {
  if(this.state.error) return <div style={{padding:16,margin:12,border:"1px solid #ef4444",borderRadius:8,color:"#ef4444",fontSize:12}}>
   <strong>Lap-by-lap rendering error</strong>
   <div style={{marginTop:8,whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{String(this.state.error.message||this.state.error)}</div>
   <button onClick={()=>this.setState({error:null})} style={{marginTop:10,padding:8}}>Retry matrix</button>
  </div>;
  return this.props.children;
 }
}

function PracticeLapMatrix({lapsByDriver,names,numbers,selectedDriver,dark,accent,runAnalysis={},favorites=[],onToggleFavorite}) {
 const [paceWindow,setPaceWindow]=useState("10"),[showMatrix,setShowMatrix]=useState(false),[matrixRange,setMatrixRange]=useState("25");
 const border=dark?"#263247":"#dce2ea",panel=dark?"#111b2b":"#fff",muted=dark?"#8b9bb0":"#66758a",fg=dark?"#e8eef7":"#172235";
 const driverNames=Array.isArray(names)?names:[],lapData=lapsByDriver||{},numberData=numbers||{},n=Number(paceWindow);
 const bestRuns=driverNames.map(name=>{let best=null;const runs=Array.isArray(runAnalysis?.[name]?.runs)?runAnalysis[name].runs:[];for(const run of runs){const rows=Array.isArray(run.laps)?run.laps:[];for(let i=n-1;i<rows.length;i++){const w=rows.slice(i-n+1,i+1);if(w.length!==n||w.some((r,j)=>j>0&&Number(r.lap)!==Number(w[j-1].lap)+1))continue;const ts=w.map(r=>Number(r.time));if(ts.some(t=>!Number.isFinite(t)||t<=0))continue;const avg=ts.reduce((x,y)=>x+y,0)/n;if(!best||avg<best.average)best={average:avg,startLap:Number(w[0].lap),endLap:Number(w[n-1].lap),runNumber:run.runNumber};}}return {name,...(best||{})};}).filter(x=>Number.isFinite(x.average)).sort((a,b)=>a.average-b.average);
 const median=xs=>{if(!xs.length)return null;const v=[...xs].sort((a,b)=>a-b),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};
 const fieldMedian=median(bestRuns.map(x=>x.average)),top10Median=median(bestRuns.slice(0,10).map(x=>x.average)),top20Median=median(bestRuns.slice(0,20).map(x=>x.average)),selected=bestRuns.find(x=>x.name===selectedDriver);
 const maxLap=Math.max(0,...driverNames.flatMap(name=>(lapData[name]||[]).map(x=>Number(x?.[0])).filter(Number.isFinite))),count=Math.min(matrixRange==="all"?maxLap:Number(matrixRange),maxLap),shown=Array.from({length:count},(_,i)=>maxLap-count+i+1);
 const maps=Object.fromEntries(driverNames.map(name=>[name,new Map((lapData[name]||[]).map(x=>[Number(x[0]),Number(x[1])]))]));
 const lapCoverage=driverNames.reduce((acc,name)=>{const nums=[...new Set((lapData[name]||[]).map(x=>Number(x[0])).filter(x=>Number.isInteger(x)&&x>0))].sort((a,b)=>a-b);acc.records+=nums.length;for(let i=1;i<nums.length;i++)acc.gaps+=Math.max(0,nums[i]-nums[i-1]-1);if(nums.length)acc.driversWithLaps++;return acc;},{records:0,gaps:0,driversWithLaps:0});
 const card={border:"1px solid "+border,borderRadius:8,background:panel};
 const metric=(label,value)=> <div style={{...card,padding:"10px 12px"}}><div style={{fontSize:9,color:muted,fontWeight:700,textTransform:"uppercase"}}>{label}</div><div style={{fontSize:17,fontWeight:800,color:fg,marginTop:3,fontVariantNumeric:"tabular-nums"}}>{value==null?"—":typeof value==="number"?value.toFixed(3)+" s":String(value)}</div></div>;
 return <div style={{padding:12,color:fg}}>
  <div style={{fontSize:16,fontWeight:850,marginBottom:4}}>Consecutive-run pace</div>
  <div style={{fontSize:11,color:muted,lineHeight:1.5,marginBottom:12}}>This ranks each driver by their fastest average over an uninterrupted block of laps within a single run. We never combine laps from separate runs. A run boundary is a verified pit lap, caution lap, or missing source lap. Slow lap times alone are not treated as pit stops.</div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:8,marginBottom:12}}>{metric("Lap records",lapCoverage.records)}{metric("Internal missing laps",lapCoverage.gaps)}{metric("Drivers with data",lapCoverage.driversWithLaps+" / "+driverNames.length)}</div>
  <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:12}}><label style={{fontSize:11,color:muted,fontWeight:700}}>CONSECUTIVE LAPS <select value={paceWindow} onChange={e=>setPaceWindow(e.target.value)} style={{marginLeft:6,padding:"7px 9px",background:panel,color:fg,border:"1px solid "+border,borderRadius:6}}>{[5,10,15,20,25,30,35,40,50,75,100].map(v=><option key={v} value={String(v)}>{v} laps</option>)}</select></label><span style={{fontSize:10,color:muted}}>Example: 10 laps means one uninterrupted 10-lap sequence.</span></div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:8,marginBottom:12}}>{metric(bestRuns[0]?"Fastest · #"+(numberData[bestRuns[0].name]||"?")+" "+bestRuns[0].name:"Fastest driver",bestRuns[0]?.average)}{metric("Top-10 median",top10Median)}{metric("Field median",fieldMedian)}</div>
  <div style={{...card,overflow:"hidden",marginBottom:12}}>
   <div style={{padding:"10px 12px",borderBottom:"1px solid "+border,display:"flex",justifyContent:"space-between",gap:8,alignItems:"center"}}><div><div style={{fontSize:13,fontWeight:800}}>Best {n}-lap consecutive averages</div><div style={{fontSize:10,color:muted,marginTop:2}}>{bestRuns.length} of {driverNames.length} drivers have a qualifying run</div></div><div style={{fontSize:10,color:muted}}>Fastest to slowest</div></div>
   {bestRuns.length===0?<div style={{padding:18,fontSize:12,color:muted}}>No driver has completed a valid {n}-lap sequence in a recorded run yet.</div>:<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontVariantNumeric:"tabular-nums"}}><thead><tr style={{color:muted,textAlign:"left",background:dark?"#172235":"#f5f7fa"}}>{["POS","DRIVER","AVG LAP","LAP RANGE","RUN"].map(x=><th key={x} style={{padding:"8px 10px",fontSize:9}}>{x}</th>)}</tr></thead><tbody>{bestRuns.map((row,i)=><tr key={row.name} style={{borderTop:"1px solid "+border,background:row.name===selectedDriver?(dark?"#173452":"#edf5ff"):"transparent"}}><td style={{padding:"8px 10px",fontWeight:800,color:i===0?"#16a34a":muted}}>{i+1}</td><td style={{padding:"8px 10px",fontWeight:750,whiteSpace:"nowrap"}}><button onClick={()=>onToggleFavorite&&onToggleFavorite(row.name)} style={{border:0,background:"transparent",padding:"0 5px 0 0",color:favorites.includes(row.name)?"#eab308":muted,cursor:"pointer"}}>{favorites.includes(row.name)?"★":"☆"}</button>{numberData[row.name]?"#"+numberData[row.name]+" ":""}{row.name}{row.name===selectedDriver?" · SELECTED":""}</td><td style={{padding:"8px 10px",fontWeight:800}}>{row.average.toFixed(3)} s</td><td style={{padding:"8px 10px",whiteSpace:"nowrap"}}>L{row.startLap}–L{row.endLap}</td><td style={{padding:"8px 10px"}}>{row.runNumber??"—"}</td></tr>)}</tbody></table></div>}
  </div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:8,marginBottom:14}}>{metric("Top-20 median",top20Median)}{metric("Selected driver",selected?.average??null)}{metric("Selected lap range",selected?selected.startLap+"–"+selected.endLap:null)}</div>
  <button onClick={()=>setShowMatrix(v=>!v)} style={{width:"100%",textAlign:"left",padding:"11px 12px",border:"1px solid "+border,borderRadius:8,background:panel,color:fg,fontSize:12,fontWeight:800,cursor:"pointer"}}>{showMatrix?"Hide":"Show"} lap-by-lap matrix <span style={{float:"right",color:muted}}>{showMatrix?"−":"+"}</span></button>
  {showMatrix&&<div style={{...card,marginTop:8,overflow:"hidden"}}><div style={{padding:10,borderBottom:"1px solid "+border,display:"flex",justifyContent:"space-between",alignItems:"center"}}><b style={{fontSize:12}}>Individual lap times</b><select value={matrixRange} onChange={e=>setMatrixRange(e.target.value)} style={{padding:6,background:panel,color:fg,border:"1px solid "+border,borderRadius:5,fontSize:10}}><option value="25">Last 25 laps</option><option value="50">Last 50 laps</option><option value="100">Last 100 laps</option><option value="all">All laps</option></select></div><div style={{overflow:"auto",maxHeight:520}}><table style={{borderCollapse:"separate",borderSpacing:0,fontSize:10,fontFamily:"monospace",whiteSpace:"nowrap"}}><thead><tr><th style={{position:"sticky",left:0,top:0,zIndex:3,padding:8,textAlign:"left",background:panel}}>DRIVER</th>{shown.map(l=><th key={l} style={{position:"sticky",top:0,padding:7,background:panel,color:muted}}>L{l}</th>)}</tr></thead><tbody>{driverNames.map(name=><tr key={name}><th style={{position:"sticky",left:0,zIndex:1,padding:7,textAlign:"left",background:panel,color:name===selectedDriver?accent:fg}}>{numberData[name]?"#"+numberData[name]+" ":""}{name}</th>{shown.map(l=>{const t=maps[name]?.get(l);return <td key={l} style={{padding:7,textAlign:"right",borderTop:"1px solid "+border,color:Number.isFinite(t)&&t>0?fg:muted}}>{Number.isFinite(t)&&t>0?t.toFixed(3):"—"}</td>})}</tr>)}</tbody></table></div></div>}
  <div style={{fontSize:9,color:muted,lineHeight:1.5,marginTop:10}}>Run boundaries and tire-age labels depend on pit and caution data. Some boundaries may be inferred. Average MPH is intentionally omitted until the session has a verified track-length value.</div>
 </div>;
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


/* ═══ RACE COMMAND COCKPIT ═══ */
function RaceCommandCockpit({ session, NAMES, NUM, SIM_POS, TIMING, LAST_LAP_TIME, BEST, EOR, STINT, LAPS, isCaution, primary, onSelectDriver, dark, status }) {
  const [demoMode, setDemoMode] = useState(false);
  const [demoScenario, setDemoScenario] = useState("3 laps down");
  const [demoSelectedDriver, setDemoSelectedDriver] = useState("Brad Keselowski");
  const demoNames = ["Kyle Larson", "William Byron", "Denny Hamlin", "Ryan Blaney", "Brad Keselowski", "Chase Elliott"];
  const demoLapsDown = demoScenario === "1 lap down" ? 1 : demoScenario === "2 laps down" ? 2 : demoScenario === "on lead lap" ? 0 : 3;
  const demoPace = demoScenario === "gaining" ? 29.4 : demoScenario === "on lead lap" ? 29.8 : 30.2;
  const displayNames = demoMode ? demoNames : NAMES;
  const displayNum = demoMode ? {"Kyle Larson":"5","William Byron":"24","Denny Hamlin":"11","Ryan Blaney":"12","Brad Keselowski":"6","Chase Elliott":"9"} : NUM;
  const displayPos = demoMode ? {"Kyle Larson":1,"William Byron":2,"Denny Hamlin":3,"Ryan Blaney":4,"Brad Keselowski":5,"Chase Elliott":6} : SIM_POS;
  const displayTiming = demoMode ? {
    "Kyle Larson":{laps_completed:500,delta_leader:0},
    "William Byron":{laps_completed:500,delta_leader:1.25},
    "Denny Hamlin":{laps_completed:500-demoLapsDown,delta_leader:-demoLapsDown},
    "Ryan Blaney":{laps_completed:500-demoLapsDown,delta_leader:-demoLapsDown},
    "Brad Keselowski":{laps_completed:500-demoLapsDown,delta_leader:-demoLapsDown},
    "Chase Elliott":{laps_completed:500-demoLapsDown,delta_leader:-demoLapsDown}
  } : TIMING;
  const displayEor = demoMode ? {
    "Kyle Larson":{t5:29.8},"William Byron":{t5:29.9},"Denny Hamlin":{t5:30.05},
    "Ryan Blaney":{t5:30.1},"Brad Keselowski":{t5:demoPace},"Chase Elliott":{t5:30.0}
  } : EOR;
  const displayLastLap = demoMode ? {"Kyle Larson":29.7,"William Byron":29.9,"Denny Hamlin":30.0,"Ryan Blaney":30.1,"Brad Keselowski":demoPace,"Chase Elliott":30.0} : LAST_LAP_TIME;
  const displaySession = demoMode ? {track_name:"Bristol Motor Speedway",session_type:"RACE",session_date:"SYNTHETIC DEMO",current_lap:500,laps_in_race:500,flag_state:1} : session;
  const displayPrimary = demoMode ? demoSelectedDriver : primary;
  const palette = {
    bg: dark ? "#080d17" : "#f3f6fb",
    panel: dark ? "#111b2b" : "#ffffff",
    panel2: dark ? "#0c1421" : "#f7f9fc",
    line: dark ? "#25344a" : "#dce4ef",
    text: dark ? "#edf3fb" : "#142033",
    muted: dark ? "#8292a8" : "#63738a",
    accent: "#48a7ff",
    green: "#39d98a",
    yellow: "#f5bd4f",
    red: "#ff647c"
  };
  const mono = { fontFamily: "'SF Mono','Consolas',monospace", fontVariantNumeric: "tabular-nums" };
  const ordered = [...displayNames].sort((a,b) => (displayPos[a] || 99) - (displayPos[b] || 99));
  const towerNames = ordered.slice(0, 12);
  if (displayPrimary && !towerNames.includes(displayPrimary)) towerNames.push(displayPrimary);
  const selected = displayTiming[displayPrimary] || {};
  const leaderName = ordered.find(n => displayPos[n] === 1);
  const leaderTiming = leaderName ? displayTiming[leaderName] : null;
  const timeToLeader = formatOfficialLeaderGap(selected, leaderTiming);
  const paceDeficit = timeToLeader?.type === "laps" && timeToLeader.value > 0
    ? estimatePaceDeficitPerLap(displayEor[displayPrimary]?.t5, displayEor[leaderName]?.t5)
    : null;
  const selectedPosition = displayPos[displayPrimary] || 99;
  const ahead = ordered.find(n => displayPos[n] === selectedPosition - 1);
  const behind = ordered.find(n => displayPos[n] === selectedPosition + 1);
  const gapTo = (name) => {
    const competitor = displayTiming[name];
    const result = compareOfficialTiming(selected, competitor);
    if (result?.gapSeconds != null) {
      // Position snapshots can lag the lap feed. Treat their official interval
      // as an anchor, then add each subsequent common clean-lap delta exactly
      // once by deriving the sum from lap numbers (no mutable accumulator).
      const myAnchorLap = Number(selected?.laps_completed);
      const theirAnchorLap = Number(competitor?.laps_completed);
      let adjustment = 0;
      let adjustedLaps = 0;
      if (Number.isFinite(myAnchorLap) && Number.isFinite(theirAnchorLap) && myAnchorLap === theirAnchorLap) {
        for (const lap of lapTimeHistory(name)) {
          if (lap.lap > myAnchorLap) {
            adjustment += lap.value;
            adjustedLaps += 1;
          }
        }
      }
      const interval = result.gapSeconds + adjustment;
      return {
        label: (interval > 0 ? "+" : "") + fmt(interval, 2) + "s",
        value: interval,
        source: "official-anchor-plus-lap-deltas",
        adjustedLaps
      };
    }
    if (result?.lapDelta != null && result.lapDelta !== 0) {
      const laps = Math.abs(result.lapDelta);
      return { label: laps + " lap" + (laps === 1 ? "" : "s") + (result.lapDelta < 0 ? " behind" : " ahead"), value: result.lapDelta, source: result.source };
    }
    return null;
  };
  const lapTimeHistory = (name) => {
    if (!name || demoMode) return [];
    const myLaps = new Map((LAPS[displayPrimary] || []).map(([lap, time]) => [Number(lap), Number(time)]));
    const theirLaps = new Map((LAPS[name] || []).map(([lap, time]) => [Number(lap), Number(time)]));
    const myThreshold = thrFor(BEST, displayPrimary);
    const theirThreshold = thrFor(BEST, name);
    return [...myLaps.keys()].filter(lap => theirLaps.has(lap)).sort((a,b) => a-b)
      .filter(lap => {
        const mine = myLaps.get(lap), theirs = theirLaps.get(lap);
        return !isCaution?.(lap) && mine > 0 && theirs > 0 && mine <= myThreshold && theirs <= theirThreshold;
      })
      .map(lap => ({ lap, value: myLaps.get(lap) - theirLaps.get(lap) }));
  };
  const fmt = (v, digits=3) => v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(digits);
  const statusLabel = status === "live" ? "LIVE DATA" : status === "no_session" ? "REPLAY / STORED DATA" : String(status || "CONNECTING").toUpperCase();
  const flag = session?.flag_state;
  const flagLabel = ({1:"GREEN",2:"YELLOW",3:"RED",4:"CHECKERED",8:"WARMUP",9:"COLD"})[flag] || "FLAG N/A";
  const flagColor = flag === 1 ? palette.green : flag === 2 ? palette.yellow : flag === 3 ? palette.red : palette.muted;
  const card = { background: palette.panel, border: "1px solid " + palette.line, borderRadius: 12 };
  const metric = (label,value,detail) => <div style={{background:palette.panel2,border:"1px solid "+palette.line,borderRadius:9,padding:"11px 12px",minWidth:0}}><div style={{fontSize:9,letterSpacing:1.1,fontWeight:800,color:palette.muted}}>{label}</div><div style={{fontSize:22,fontWeight:850,color:palette.text,marginTop:4,...mono}}>{value}</div>{detail && <div style={{fontSize:10,color:palette.muted,marginTop:3}}>{detail}</div>}</div>;
  return (
    <section style={{margin:"14px 12px 18px",color:palette.text}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10}}>
        <div><div style={{fontSize:10,fontWeight:900,letterSpacing:2,color:palette.accent}}>RACE CONTROL / LIVE TIMING</div><div style={{fontSize:22,fontWeight:900,letterSpacing:-.6,marginTop:3}}>Race Command</div></div>
        <div style={{textAlign:"right"}}><div style={{fontSize:9,fontWeight:900,letterSpacing:1.2,color:palette.muted}}>FEED STATUS</div><div style={{fontSize:11,fontWeight:900,color:demoMode?palette.yellow:status==="live"?palette.green:palette.yellow,marginTop:4}}>{demoMode?"DEMO MODE":statusLabel}</div></div>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
        <button onClick={()=>setDemoMode(v=>!v)} style={{padding:"7px 11px",borderRadius:6,border:"1px solid "+palette.accent,background:demoMode?palette.accent:"transparent",color:demoMode?"#07111f":palette.accent,fontSize:10,fontWeight:900}}>{demoMode?"EXIT DEMO":"TRY DEMO DATA"}</button>
        {demoMode && ["3 laps down","2 laps down","1 lap down","on lead lap","gaining"].map(s=><button key={s} onClick={()=>setDemoScenario(s)} style={{padding:"6px 8px",borderRadius:5,border:"1px solid "+palette.line,background:demoScenario===s?palette.panel2:"transparent",color:palette.text,fontSize:9,fontWeight:800}}>{s.toUpperCase()}</button>)}
      </div>
      <div style={{...card,padding:14,marginBottom:10,background:dark?"linear-gradient(120deg,#132b43,#101a2a 68%,#17243a)": "linear-gradient(120deg,#e5f2ff,#fff 70%,#eaf0fa)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
          <div style={{minWidth:0}}><div style={{fontSize:9,letterSpacing:1.4,fontWeight:900,color:palette.muted}}>TRACK / SESSION</div><div style={{fontSize:16,fontWeight:900,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{displaySession?.track_name || "Session not identified"}</div><div style={{fontSize:10,color:palette.muted,marginTop:3}}>{String(displaySession?.session_type || "NO SESSION").replaceAll("_"," ").toUpperCase()} · {displaySession?.session_date || "—"}</div></div>
          <div style={{textAlign:"right",flexShrink:0}}><div style={{fontSize:9,letterSpacing:1.2,fontWeight:900,color:palette.muted}}>RACE STATUS</div><div style={{fontSize:15,fontWeight:900,color:flagColor,marginTop:4}}>{demoMode ? "GREEN" : flagLabel}</div><div style={{fontSize:11,color:palette.muted,...mono,marginTop:3}}>LAP {displaySession?.current_lap ?? selected.laps_completed ?? "—"}{displaySession?.laps_in_race ? " / "+displaySession.laps_in_race : ""}</div></div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:8,marginBottom:10}}>
        {metric("SELECTED DRIVER", "#"+(displayNum[displayPrimary] || "?")+" · "+displayPrimary.split(" ").slice(-1)[0], "P"+(displayPos[displayPrimary] || "—")+" · "+(selected.laps_completed ?? "—")+" laps completed")}
        {metric("LAP DEFICIT", timeToLeader?.label || "—", "Official lap-count difference to leader")}
        {metric("PACE DEFICIT / LAP", paceDeficit == null ? "—" : (paceDeficit > 0 ? "+" : "")+paceDeficit.toFixed(2)+"s", demoMode ? "Synthetic five-lap average vs leader" : "Estimated current-stint 5-lap average vs leader")}
        {metric("LAST CLEAN LAP", fmt(displayLastLap[displayPrimary]), "Lap-time history filter excludes detected cautions / pit laps")}
        {metric("LAST 5 LAP AVG", fmt(displayEor[displayPrimary]?.t5), "Current stint · latest five clean laps available")}
      </div>
      <div style={{...card,padding:12,marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:9}}><div style={{fontSize:11,fontWeight:900,letterSpacing:1.1}}>BATTLE WINDOW</div><div style={{fontSize:9,color:palette.muted}}>Official interval + completed lap deltas</div></div>
        {[["AHEAD",ahead],["BEHIND",behind]].map(([label,name]) => {
          const d= name ? gapTo(name) : null;
          return <div key={label} style={{display:"grid",gridTemplateColumns:"58px 1fr auto",gap:8,alignItems:"center",padding:"9px 0",borderTop:"1px solid "+palette.line}}>
            <div style={{fontSize:9,fontWeight:900,color:palette.muted,letterSpacing:1}}>{label}</div>
            <div style={{minWidth:0}}><div style={{fontSize:12,fontWeight:800,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{name ? "#"+(NUM[name]||"?")+" "+name : "No car "+label.toLowerCase()}</div><div style={{fontSize:9,color:palette.muted,marginTop:2}}>P{ name ? SIM_POS[name] : "—"} · {name ? (TIMING[name]?.laps_completed ?? "—")+" laps" : "—"}</div></div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:13,fontWeight:900,color:d==null?palette.muted:(typeof d.value==="number" && d.value>0)?palette.red:palette.green,...mono}}>{d?.label || "—"}</div>
            </div>
          </div>;
        })}
        {!demoMode && <div style={{marginTop:8,borderTop:"1px solid "+palette.line,paddingTop:8}}>
          <div style={{fontSize:9,fontWeight:900,letterSpacing:1,color:palette.muted,marginBottom:6}}>LAP-BY-LAP PACE DELTA · SELECTED DRIVER</div>
          <div style={{display:"grid",gridTemplateColumns:"48px 1fr 1fr",gap:6,padding:"5px 7px",background:palette.panel2,fontSize:8,fontWeight:900,color:palette.muted}}>
            <span>LAP</span><span style={{textAlign:"right"}}>VS AHEAD</span><span style={{textAlign:"right"}}>VS BEHIND</span>
          </div>
          {(() => {
            const aheadRows = lapTimeHistory(ahead), behindRows = lapTimeHistory(behind);
            const byLap = new Map(aheadRows.map(row => [row.lap, { lap: row.lap, ahead: row.value, behind: null }]));
            behindRows.forEach(row => { const current = byLap.get(row.lap) || { lap: row.lap, ahead: null, behind: null }; current.behind = row.value; byLap.set(row.lap, current); });
            const rows = [...byLap.values()].sort((a,b) => b.lap-a.lap).slice(0,15);
            return rows.length ? rows.map(row => <div key={row.lap} style={{display:"grid",gridTemplateColumns:"48px 1fr 1fr",gap:6,padding:"6px 7px",borderBottom:"1px solid "+palette.line,fontSize:10,...mono}}>
              <span style={{color:palette.muted}}>L{row.lap}</span>
              <span style={{textAlign:"right",fontWeight:800,color:row.ahead==null?palette.muted:row.ahead>0?palette.red:palette.green}}>{row.ahead==null?"—":(row.ahead>0?"+":"")+row.ahead.toFixed(3)+"s"}</span>
              <span style={{textAlign:"right",fontWeight:800,color:row.behind==null?palette.muted:row.behind>0?palette.red:palette.green}}>{row.behind==null?"—":(row.behind>0?"+":"")+row.behind.toFixed(3)+"s"}</span>
            </div>) : <div style={{padding:8,fontSize:9,color:palette.muted}}>No matched clean laps available for both adjacent cars yet.</div>;
          })()}
          <div style={{fontSize:8,color:palette.muted,marginTop:6}}>Positive = selected driver slower · Negative = selected driver faster · same lap number, clean laps only · latest 15 shown</div>
        </div>}
      </div>
      <div style={{...card,overflow:"hidden"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 12px 10px"}}><div style={{fontSize:11,fontWeight:900,letterSpacing:1.1}}>LIVE TIMING TOWER</div><div style={{fontSize:9,color:palette.muted}}>TOP 12 + SELECTED DRIVER</div></div>
        <div style={{display:"grid",gridTemplateColumns:"34px minmax(0,1fr) 66px 66px 66px",gap:4,padding:"7px 10px",background:palette.panel2,borderTop:"1px solid "+palette.line,borderBottom:"1px solid "+palette.line,fontSize:8,fontWeight:900,letterSpacing:.7,color:palette.muted}}>
          <span>POS</span><span>DRIVER</span><span style={{textAlign:"right"}}>TO LEADER</span><span style={{textAlign:"right"}}>LAST</span><span style={{textAlign:"right"}}>5-LAP</span>
        </div>
        {towerNames.map(name => {
          const p=displayTiming[name]||{}, active=name===displayPrimary;
          return <button key={name} onClick={()=>demoMode?setDemoSelectedDriver(name):onSelectDriver(name)} style={{display:"grid",width:"100%",gridTemplateColumns:"34px minmax(0,1fr) 66px 66px 66px",gap:4,alignItems:"center",padding:"10px",textAlign:"left",border:0,borderBottom:"1px solid "+palette.line,background:active?(dark?"#173452":"#e5f2ff"):"transparent",color:palette.text,cursor:"pointer"}}>
            <span style={{fontSize:13,fontWeight:900,color:active?palette.accent:palette.muted,...mono}}>{displayPos[name]||"—"}</span>
            <span style={{minWidth:0}}><span style={{display:"block",fontSize:11,fontWeight:850,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>#{displayNum[name]||"?"} {name}</span><span style={{display:"block",fontSize:8,color:palette.muted,marginTop:2}}>{p.laps_completed??"—"} LAPS</span></span>
            <span style={{textAlign:"right",fontSize:10,fontWeight:800,...mono}}>{formatOfficialLeaderGap(p,leaderTiming)?.label || "—"}</span>
            <span style={{textAlign:"right",fontSize:10,...mono}}>{fmt(displayLastLap[name])}</span>
            <span style={{textAlign:"right",fontSize:10,...mono}}>{fmt(displayEor[name]?.t5)}</span>
          </button>;
        })}
        <div style={{padding:"9px 11px",fontSize:9,lineHeight:1.5,color:palette.muted,borderTop:"1px solid "+palette.line}}>* Lapped cars show lap deficit plus estimated pace deficit per lap. Positive pace deficit means slower than the leader. Demo values are synthetic.</div>
      </div>
    </section>
  );
}

/* ═══ MAIN ═══ */
export default function App() {
  const live = useLiveSession();
  const { BEST, EOR, LAPS, NUM, CLR, GROUPS, SIM_POS, STINT, LAST_PIT, LAST_LAP_TIME, RUN_ANALYSIS, TIMING, PIT_STOPS, NAMES, session, status, error, cautionSet } = live;
  const isCaution = makeCautionCheck(cautionSet);

  const [dark, setDark] = useState(true);
  const [mode, setMode] = useState("race");

  // Keep the app on the Practice view for the latest practice session even after it ends.
  // Switch back to Race automatically when a new race session is detected.
  useEffect(() => {
    if (session?.session_type === 'practice1' || session?.session_type === 'practice2') {
      setMode("practice");
    } else if (session?.session_type === 'race') {
      setMode("race");
    }
  }, [session?.id, session?.session_type]);

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

  // Auto-persist last practice session in the Practice tab.
  // Clears when a live practice starts (show live data), reloads after it ends.
  // Race and qualifying sessions leave practHistSessionId untouched.
  useEffect(() => {
    let cancelled = false;
    const isLivePractice = session?.is_active &&
      (session?.session_type === 'practice1' || session?.session_type === 'practice2');

    if (isLivePractice) {
      setPractHistSessionId(null);
      return;
    }

    const seriesFilter = session?.series ?? 1;
    (async () => {
      try {
        let practiceQuery = supabase
          .from('sessions')
          .select('id')
          .neq('started_by', 'historical')
          .in('session_type', ['practice1', 'practice2'])
          .eq('series', seriesFilter);
        if (session?.track_name) practiceQuery = practiceQuery.eq('track_name', session.track_name);
        const { data, error } = await practiceQuery
          .order('started_at', { ascending: false })
          .limit(1);
        if (error) { console.error('practice auto-load:', error); return; }
        if (!cancelled && data?.[0]?.id) setPractHistSessionId(data[0].id);
      } catch (e) { console.error('practice auto-load:', e); }
    })();

    return () => { cancelled = true; };
  }, [session?.id, session?.is_active, session?.session_type, session?.series, session?.track_name]);

  const [tab, setTab] = useState(0);
  const [primary, setPrimary] = useState("Brad Keselowski");
  const [compDrivers, setCompDrivers] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [pView, setPView] = useState("dashboard");
  const [practiceLapFavorites, setPracticeLapFavorites] = useState([]);
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
    const raceTiming = compareRaceLaps(LAPS[primaryResolved] || [], LAPS[name] || []);
    const d = raceTiming.lastLapDelta;
    const dc = d == null ? sub : d > 0 ? "#ef4444" : "#22c55e";

    // All-lap maps (crossing-time gap and per-lap delta bars both use these)
    const myMap = new Map((LAPS[primaryResolved] || []).map(([n, t]) => [n, t]));
    const theirMap = new Map((LAPS[name] || []).map(([n, t]) => [n, t]));

    // Positive pace delta means the primary driver is slower.
    const gapPerLap = raceTiming.paceDelta5;
    const cumulativeGap = raceTiming.gapSeconds;
    const hasCumGap = cumulativeGap != null;
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
            {raceTiming.lapDelta != null && raceTiming.lapDelta !== 0 ? (
              <>
                <div style={{ fontSize: 9, color: sub }}>LAP STATUS</div>
                <div style={{ fontSize: 19, fontWeight: 800, color: raceTiming.lapDelta > 0 ? "#22c55e" : "#ef4444", ...MF }}>
                  {Math.abs(raceTiming.lapDelta)} LAP{Math.abs(raceTiming.lapDelta) === 1 ? "" : "S"} {raceTiming.lapDelta > 0 ? "AHEAD" : "DOWN"}
                </div>
              </>
            ) : hasCumGap ? (
              <>
                <div style={{ fontSize: 9, color: sub }}>CALCULATED GAP</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: cumGapColor, ...MF, lineHeight: 1.1 }}>
                  {Math.abs(cumulativeGap).toFixed(2)}s {cumulativeGap > 0 ? "BEHIND" : "AHEAD"}
                </div>
                <div style={{ fontSize: 8, color: sub }}>through lap {raceTiming.latestCommonLap}</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 9, color: sub }}>GAP</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: sub, ...MF }}>—</div>
              </>
            )}
            <div style={{ fontSize: 9, color: sub, marginTop: 4 }}>LAST MATCHED LAP Δ · L{raceTiming.latestCommonLap ?? "—"}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: dc, ...MF }}>
              {d != null ? (d > 0 ? "+" : "") + d.toFixed(3) : "—"}
            </div>
          </div>
        </div>

        {trendLabel != null && (
          <div style={{ padding: "4px 8px", borderRadius: 4, marginTop: 8, background: trendColor + "20", fontSize: 10, color: trendColor, fontWeight: 700 }}>
            {trendLabel} {Math.abs(gapPerLap).toFixed(3)}s/lap
          </div>
        )}
        {(raceTiming.paceDelta5 != null || raceTiming.paceDelta10 != null) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
            {[["5-LAP PACE Δ", raceTiming.paceDelta5], ["10-LAP PACE Δ", raceTiming.paceDelta10]].map(([label, value]) => (
              <div key={label} style={{ padding: "6px 8px", background: dark ? "#ffffff06" : "#00000006", borderRadius: 5 }}>
                <div style={{ fontSize: 8, color: sub, fontWeight: 700 }}>{label}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: value == null ? sub : value > 0 ? "#ef4444" : "#22c55e", ...MF }}>
                  {value == null ? "—" : (value > 0 ? "+" : "") + value.toFixed(3) + "s"}
                </div>
              </div>
            ))}
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
    <div style={{ background: bg, minHeight: "100vh", color: fg, fontFamily: "'SF Pro Display',-apple-system,sans-serif", width: "100%", maxWidth: 1100, margin: "0 auto", overflowX: "hidden", boxSizing: "border-box" }}>
      {/* HEADER — title row only; no mode buttons to prevent horizontal overflow */}
      <div style={{ padding: "calc(10px + env(safe-area-inset-top, 0px)) 14px 10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: HH, boxSizing: "border-box", background: bg, position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: "1px" }}>RACE ENGINEERING</div>
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
            {session?.last_poll_at && (() => {
              const age = Math.max(0, Math.round((Date.now() - new Date(session.last_poll_at).getTime()) / 1000));
              const stale = age > 90;
              return <span style={{ marginLeft: 6, color: stale ? "#ef4444" : sub }}>· UPDATED {age}s AGO</span>;
            })()}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select value={primaryResolved} onChange={(e) => setPrimary(e.target.value)} aria-label="Selected driver" style={{ maxWidth: 138, height: 38, padding: "0 7px", borderRadius: 6, background: card, color: fg, border: `1px solid ${bdr}`, fontSize: 10, fontWeight: 700 }}>
            {NAMES.map((name) => <option key={name} value={name}>#{NUM[name] || "?"} {sn(name)}</option>)}
          </select>
          <SessionControl session={session} dark={dark} onAfterAction={live.reload} compact />
          <button onClick={() => setShowSettings(!showSettings)} aria-label="Settings" style={{ width: 38, height: 38, borderRadius: 6, background: showSettings ? acc : "transparent", border: `1px solid ${bdr}`, color: showSettings ? "#fff" : fg, cursor: "pointer", fontSize: 16 }}>⚙</button>
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
      {mode === "race" && (session?.session_type === 'practice1' || session?.session_type === 'practice2') && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: sub, fontSize: 13 }}>
          Practice session is active —
          <button onClick={() => setMode("practice")} style={{ marginLeft: 6, color: acc, background: "none", border: "none", fontSize: 13, fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>
            go to Practice tab
          </button>
        </div>
      )}

      {mode === "race" && session?.session_type !== 'practice1' && session?.session_type !== 'practice2' && (
        <>
          <div style={{ display: "flex", borderBottom: `1px solid ${bdr}`, position: "sticky", top: HH + MTH, background: bg, zIndex: 9 }}>
            {["Race Command", "Timing Tower", "Lap Chart", "Driver Engineering", "Strategy"].map((t, i) => (
              <button key={i} onClick={() => setTab(i)} style={{ flex: 1, padding: "10px", background: "transparent", color: tab === i ? acc : sub, border: "none", borderBottom: tab === i ? `2px solid ${acc}` : "2px solid transparent", fontSize: 10, fontWeight: 700, cursor: "pointer", height: TH }}>{t}</button>
            ))}
          </div>

          {tab === 0 && <RaceCommandCockpit session={session} NAMES={NAMES} NUM={NUM} SIM_POS={SIM_POS} TIMING={TIMING} LAST_LAP_TIME={LAST_LAP_TIME} BEST={BEST} EOR={EOR} STINT={STINT} LAPS={LAPS} isCaution={isCaution} primary={primaryResolved} onSelectDriver={setPrimary} dark={dark} status={status} />}
          {tab === 0 && false && (
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
              <div style={{ fontSize: 8, color: sub, marginBottom: 6 }}>Gap is calculated from matched lap times, not a direct NASCAR interval feed. It updates through the latest lap completed by both cars.</div>
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

          {mode === "race" && tab === 4 && (() => {
            const selectedTiming = TIMING[primaryResolved] || {};
            const driverStops = PIT_STOPS[primaryResolved] || [];
            const lastStop = driverStops[driverStops.length - 1] || null;
            const currentLap = Number(selectedTiming.laps_completed ?? session?.current_lap ?? 0) || null;
            const lapsSinceStop = lastStop && currentLap != null ? Math.max(0, currentLap - Number(lastStop.lap_number)) : null;
            const currentRun = RUN_ANALYSIS?.[primaryResolved]?.runs?.slice(-1)[0] || null;
            const fieldPitCycle = NAMES.map((name) => {
              const stops = PIT_STOPS[name] || [];
              const stop = stops[stops.length - 1] || null;
              const timing = TIMING[name] || {};
              return {
                name,
                position: SIM_POS[name] || 99,
                lastPitLap: stop ? Number(stop.lap_number) : null,
                lapsSincePit: stop && Number(timing.laps_completed) ? Number(timing.laps_completed) - Number(stop.lap_number) : null,
                stop,
              };
            }).sort((a, b) => (b.lastPitLap ?? -1) - (a.lastPitLap ?? -1));
            const stopDetails = lastStop?.details || {};
            const changedTires = getPitStopTireCount(stopDetails);
            const panel = (title, body) => <div style={{ background: card, border: `1px solid ${bdr}`, borderRadius: 10, padding: 12, marginBottom: 10 }}><div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.6, marginBottom: 8 }}>{title}</div>{body}</div>;
            return (
              <div style={{ padding: "12px 10px 24px", maxWidth: 900, margin: "0 auto" }}>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 15, fontWeight: 900 }}>RACE STRATEGY & PIT CYCLE</div>
                  <div style={{ fontSize: 10, color: sub }}>Race context and observed pit activity — not a fuel or tire sensor</div>
                </div>
                {panel("RACE SITUATION", <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 7 }}>
                  {[
                    ["LAP", currentLap == null ? "—" : currentLap + (session?.laps_in_race ? " / " + session.laps_in_race : "")],
                    ["STAGE", session?.stage ?? "—"],
                    ["LAPS TO GO", session?.laps_to_go ?? "—"],
                  ].map(([label,value]) => <div key={label} style={{ background: dark ? "#ffffff08" : "#00000006", borderRadius: 6, padding: 8 }}>
                    <div style={{ fontSize: 8, color: sub, fontWeight: 700 }}>{label}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, ...MF }}>{value}</div>
                  </div>)}
                </div>)}
                {panel("SELECTED DRIVER · PIT STOP", lastStop ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 7 }}>
                      {[
                        ["LAST STOP", "Lap " + lastStop.lap_number],
                        ["PIT ROAD", pitRoadDuration(stopDetails) != null ? pitRoadDuration(stopDetails).toFixed(2) + "s" : "—"],
                        ["BOX TIME", stopDetails.pit_stop_duration != null ? Number(stopDetails.pit_stop_duration).toFixed(2) + "s" : "—"],
                        ["TIRES", changedTires != null ? changedTires + " changed" : stopDetails.pit_stop_type || "Unknown"],
                        ["STINT AGE", lapsSinceStop == null ? "—" : lapsSinceStop + " laps"],
                        ["POSITION Δ", stopDetails.positions_gained ?? stopDetails.positions_gained_lossed ?? "—"],
                      ].map(([label,value]) => <div key={label} style={{ background: dark ? "#ffffff08" : "#00000006", borderRadius: 6, padding: 8 }}>
                        <div style={{ fontSize: 8, color: sub, fontWeight: 700 }}>{label}</div>
                        <div style={{ fontSize: 13, fontWeight: 800, ...MF }}>{value}</div>
                      </div>)}
                    </div>
                    <div style={{ fontSize: 8, color: sub, marginTop: 7 }}>Tire count and pit-stop timing reflect the public feed record. A missing field means NASCAR did not supply that value to this app.</div>
                  </>
                ) : <div style={{ fontSize: 10, color: sub }}>No pit-stop event has been recorded for this driver in the current session.</div>)}
                {panel("CURRENT RUN PACE", currentRun?.summary ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 7 }}>
                    {[
                      ["RUN LAPS", currentRun.laps.length],
                      ["AVG LAP", currentRun.summary.average.toFixed(3)],
                      ["TREND", currentRun.summary.trendSecondsPerLap == null ? "—" : (currentRun.summary.trendSecondsPerLap > 0 ? "+" : "") + currentRun.summary.trendSecondsPerLap.toFixed(3) + "s/lap"],
                    ].map(([label,value]) => <div key={label} style={{ background: dark ? "#ffffff08" : "#00000006", borderRadius: 6, padding: 8 }}>
                      <div style={{ fontSize: 8, color: sub, fontWeight: 700 }}>{label}</div>
                      <div style={{ fontSize: 13, fontWeight: 800, ...MF }}>{value}</div>
                    </div>)}
                  </div>
                ) : <div style={{ fontSize: 10, color: sub }}>Insufficient clean lap data for a current-run summary.</div>)}
                {panel("FIELD PIT CYCLE", (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, ...MF }}>
                      <thead><tr style={{ color: sub, textAlign: "right" }}>
                        <th style={{ textAlign: "left", padding: "6px 4px" }}>DRIVER</th>
                        <th style={{ padding: "6px 4px" }}>POS</th>
                        <th style={{ padding: "6px 4px" }}>LAST PIT</th>
                        <th style={{ padding: "6px 4px" }}>STINT</th>
                        <th style={{ padding: "6px 4px" }}>PIT ROAD</th>
                      </tr></thead>
                      <tbody>{fieldPitCycle.map((row) => (
                        <tr key={row.name} style={{ borderTop: `1px solid ${bdr}`, textAlign: "right", background: row.name === primaryResolved ? (dark ? "#ffffff0a" : "#eff6ff") : "transparent" }}>
                          <td style={{ textAlign: "left", padding: "7px 4px", fontWeight: row.name === primaryResolved ? 800 : 500 }}>#{NUM[row.name] || "?"} {sn(row.name)}</td>
                          <td style={{ padding: "7px 4px" }}>{row.position}</td>
                          <td style={{ padding: "7px 4px" }}>{row.lastPitLap == null ? "—" : "L" + row.lastPitLap}</td>
                          <td style={{ padding: "7px 4px" }}>{row.lapsSincePit == null ? "—" : row.lapsSincePit + "L"}</td>
                          <td style={{ padding: "7px 4px" }}>{pitRoadDuration(row.stop?.details) != null ? pitRoadDuration(row.stop.details).toFixed(1) + "s" : "—"}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                ))}
                {panel("WHAT THIS APP CANNOT CONFIRM", <div style={{ fontSize: 10, color: sub, lineHeight: 1.55 }}>
                  We do not have actual fuel remaining, fuel burn per lap, tire pressure, tire temperature, compound/set identification, or private team radio. The app can compare observed pit cycles and pace, but it will not issue a false "pit now" recommendation without those inputs.
                </div>)}
              </div>
            );
          })()}
          {mode === "race" && tab === 3 && (() => {
            const validDrivers = NAMES.filter((n) => EOR[n]?.t10 != null);
            const ranked = [...validDrivers].sort((a, b) => EOR[a].t10 - EOR[b].t10);
            const paceRank = ranked.indexOf(primaryResolved) + 1;
            const paceMedian = ranked.length
              ? [...ranked].map((n) => EOR[n].t10).sort((a, b) => a - b)[Math.floor(ranked.length / 2)]
              : null;
            const driverLaps = (LAPS[primaryResolved] || [])
              .filter(([lap, time]) => time > 0 && time <= myThr && !isCaution(lap))
              .sort((a, b) => a[0] - b[0]);
            const recent5 = driverLaps.slice(-5);
            const prior5 = driverLaps.slice(-10, -5);
            const avg = (rows) => rows.length === 5 ? rows.reduce((sum, row) => sum + row[1], 0) / 5 : null;
            const recentAvg = avg(recent5);
            const priorAvg = avg(prior5);
            const trend = recentAvg != null && priorAvg != null ? recentAvg - priorAvg : null;
            const medianDelta = me.t10 != null && paceMedian != null ? me.t10 - paceMedian : null;
            const selectedTiming = TIMING[primaryResolved] || {};
            const selectedPitStops = PIT_STOPS[primaryResolved] || [];
            const latestPit = selectedPitStops[selectedPitStops.length - 1] || null;
            const driverRuns = RUN_ANALYSIS[primaryResolved]?.runs || [];
            const latestRun = driverRuns[driverRuns.length - 1] || null;
            const latestRunSummary = latestRun?.summary || null;
            const runBasisLabel = latestRun?.tireAgeBasis === "official-pit-event"
              ? "Run boundary supported by official pit event"
              : latestRun?.tireAgeBasis === "mixed-pit-events-and-inference"
                ? "Mixed official pit events and inferred boundaries"
                : "Run boundaries inferred from lap data";
            const leaderTiming = TIMING[NAMES.find((n) => SIM_POS[n] === 1)] || null;
            const officialLeaderGap = formatOfficialLeaderGap(selectedTiming, leaderTiming)?.label || null;
            const battleDriver = compDrivers.find((name) => name !== primaryResolved) || "";
            const lapBattle = battleDriver ? compareLapByLap(LAPS[primaryResolved] || [], LAPS[battleDriver] || []) : null;
            const metricCard = (label, value, detail) => (
              <div style={{ background: card, border: `1px solid ${bdr}`, borderRadius: 9, padding: 12, minWidth: 0 }}>
                <div style={{ fontSize: 9, color: sub, fontWeight: 700, letterSpacing: 0.7 }}>{label}</div>
                <div style={{ fontSize: 21, fontWeight: 800, color: fg, ...MF, marginTop: 5 }}>{value}</div>
                {detail && <div style={{ fontSize: 10, color: sub, marginTop: 4 }}>{detail}</div>}
              </div>
            );
            const deltaText = (value) => value == null ? "—" : (value > 0 ? "+" : "") + value.toFixed(3) + "s";
            const deltaColor = (value) => value == null ? sub : value < 0 ? "#22c55e" : value > 0 ? "#ef4444" : fg;
            return (
              <div style={{ padding: "12px 10px 24px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800 }}>DRIVER PERFORMANCE</div>
                    <div style={{ fontSize: 10, color: sub }}>#{NUM[primaryResolved] || "?"} {primaryResolved} · {session?.track_name || "Current session"}</div>
                  </div>
                  <select value={primaryResolved} onChange={(e) => setPrimary(e.target.value)} style={{ maxWidth: 150, padding: 7, borderRadius: 6, background: card, color: fg, border: `1px solid ${bdr}`, fontSize: 11 }}>
                    {NAMES.map((n) => <option key={n} value={n}>#{NUM[n] || "?"} {sn(n)}</option>)}
                  </select>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8 }}>
                  {metricCard("RUNNING POSITION", myPos === 99 ? "—" : "P" + myPos, "Live position feed")}
                  {metricCard("10-LAP PACE RANK", paceRank ? "#" + paceRank + " / " + ranked.length : "—", "Among drivers with a valid 10-lap run")}
                  {metricCard("10-LAP VS FIELD MEDIAN", deltaText(medianDelta), "Negative = faster than field median")}
                  {metricCard("LAST 5 VS PRIOR 5", deltaText(trend), trend == null ? "Requires 10 consecutive clean laps" : trend < 0 ? "Pace improving" : trend > 0 ? "Pace slowing" : "No change")}
                  {metricCard("TIME TO LEADER", officialLeaderGap || "—", "Elapsed-time gap plus lap deficit when lapped")}
                  {metricCard("LAST PIT STOP", latestPit ? "Lap " + latestPit.lap_number : "—", pitRoadDuration(latestPit?.details) != null ? pitRoadDuration(latestPit.details).toFixed(1) + "s pit road" : "Pit duration unavailable")}
                </div>
                <div style={{ background: card, border: `1px solid ${bdr}`, borderRadius: 9, padding: 12, marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 10, fontWeight: 800 }}>LATEST RUN ANALYSIS</div>
                    <div style={{ fontSize: 9, color: sub }}>{latestRun ? `L${latestRun.startLap}–L${latestRun.endLap}` : "No run data"}</div>
                  </div>
                  {latestRunSummary ? (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8 }}>
                        {metricCard("RUN LAPS", String(latestRunSummary.lapCount), "Valid timed laps in latest segment")}
                        {metricCard("RUN AVG", ft(latestRunSummary.average), "Mean lap time")}
                        {metricCard("RUN BEST", ft(latestRunSummary.best), "Fastest valid lap")}
                        {metricCard("LAP-TIME VARIABILITY", latestRunSummary.standardDeviation == null ? "—" : latestRunSummary.standardDeviation.toFixed(3) + "s", "Standard deviation; lower is more consistent")}
                        {metricCard("FIRST 5 → LAST 5", latestRunSummary.firstToLastFiveDelta == null ? "—" : (latestRunSummary.firstToLastFiveDelta > 0 ? "+" : "") + latestRunSummary.firstToLastFiveDelta.toFixed(3) + "s", "Positive = slower over the run")}
                        {metricCard("PACE TREND", latestRunSummary.trendSecondsPerLap == null ? "—" : (latestRunSummary.trendSecondsPerLap > 0 ? "+" : "") + latestRunSummary.trendSecondsPerLap.toFixed(3) + "s/lap", "Linear trend; positive = slowing")}
                      </div>
                      <div style={{ fontSize: 9, color: sub, lineHeight: 1.5, marginTop: 8 }}>{runBasisLabel}. This is a lap-time segment, not verified tire age; track evolution, traffic, weather, and setup changes can also affect the trend.</div>
                    </>
                  ) : <div style={{ fontSize: 10, color: sub }}>Not enough valid lap history to summarize a run.</div>}
                </div>
                <div style={{ background: card, border: `1px solid ${bdr}`, borderRadius: 9, padding: 12, marginTop: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, marginBottom: 8 }}>POSITION BATTLE</div>
                  {[{label:"CAR AHEAD",name:aheadName},{label:"CAR BEHIND",name:behindName}].map((item) => {
                    const timing = item.name ? compareRaceLaps(LAPS[primaryResolved] || [], LAPS[item.name] || []) : null;
                    const official = item.name ? compareOfficialTiming(TIMING[primaryResolved], TIMING[item.name]) : null;
                    const pace = timing?.paceDelta5;
                    const gapLabel = official?.gapSeconds != null
                      ? Math.abs(official.gapSeconds).toFixed(2) + "s feed Δ"
                      : official?.lapDelta
                        ? Math.abs(official.lapDelta) + " lap" + (Math.abs(official.lapDelta) === 1 ? "" : "s")
                        : timing?.lapDelta
                          ? Math.abs(timing.lapDelta) + " lap" + (Math.abs(timing.lapDelta) === 1 ? "" : "s")
                          : timing?.gapSeconds != null
                            ? Math.abs(timing.gapSeconds).toFixed(2) + "s calc."
                            : "Gap n/a";
                    return <div key={item.label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderTop:`1px solid ${bdr}`, gap:8 }}>
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:9,color:sub,fontWeight:700}}>{item.label}</div>
                        <div style={{fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name ? "#" + (NUM[item.name] || "?") + " " + item.name : "No car in this position"}</div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div style={{fontSize:12,fontWeight:800,...MF}}>{gapLabel}</div>
                        <div style={{fontSize:10,color:deltaColor(pace),...MF}}>{pace == null ? "5L pace unavailable" : (pace > 0 ? "+" : "") + pace.toFixed(3) + "s/lap vs them"}</div>
                      </div>
                    </div>;
                  })}
                  <div style={{fontSize:9,color:sub,marginTop:7}}>Uses NASCAR live-feed leader deltas when both cars are on the same lap. Falls back to calculated lap-history estimates when official interval data is unavailable.</div>
                </div>
                <div style={{ background: card, border: `1px solid ${bdr}`, borderRadius: 9, padding: 12, marginTop: 10 }}>
                  <div style={{fontSize:10,fontWeight:800,marginBottom:8}}>SELECTED HEAD-TO-HEAD</div>
                  {compDrivers.filter((n)=>n!==primaryResolved).length ? compDrivers.filter((n)=>n!==primaryResolved).map((n)=>{
                    const t=compareRaceLaps(LAPS[primaryResolved]||[],LAPS[n]||[]);
                    return <div key={n} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:`1px solid ${bdr}`,gap:8}}>
                      <span style={{fontSize:11,fontWeight:600}}>#{NUM[n]||"?"} {sn(n)}</span>
                      <span style={{fontSize:11,...MF,color:deltaColor(t.paceDelta5)}}>{t.paceDelta5==null?"—":deltaText(t.paceDelta5)+"/lap"}</span>
                    </div>;
                  }) : <div style={{fontSize:11,color:sub}}>Select comparison drivers from the Cockpit or Full Field view to populate this section.</div>}
                </div>
                <div style={{ background: card, border: `1px solid ${bdr}`, borderRadius: 9, padding: 12, marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 7 }}>
                    <div style={{ fontSize: 10, fontWeight: 800 }}>LAP-BY-LAP COMPARISON</div>
                    <div style={{ fontSize: 9, color: sub }}>{battleDriver ? "vs " + battleDriver : "Select a comparison driver"}</div>
                  </div>
                  {lapBattle?.rows?.length ? (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, ...MF }}>
                        <thead><tr style={{ color: sub, textAlign: "right" }}>
                          <th style={{ textAlign: "left", padding: "5px 3px" }}>LAP</th>
                          <th style={{ padding: "5px 3px" }}>YOU</th>
                          <th style={{ padding: "5px 3px" }}>THEM</th>
                          <th style={{ padding: "5px 3px" }}>DELTA</th>
                          <th style={{ padding: "5px 3px" }}>RUNNING Δ</th>
                        </tr></thead>
                        <tbody>
                          {lapBattle.rows.slice(-10).map((row) => (
                            <tr key={row.lap} style={{ borderTop: `1px solid ${bdr}`, textAlign: "right" }}>
                              <td style={{ textAlign: "left", padding: "6px 3px", color: sub }}>L{row.lap}</td>
                              <td style={{ padding: "6px 3px" }}>{row.primaryTime.toFixed(3)}</td>
                              <td style={{ padding: "6px 3px" }}>{row.competitorTime.toFixed(3)}</td>
                              <td style={{ padding: "6px 3px", color: deltaColor(row.lapDeltaSeconds) }}>{row.lapDeltaSeconds > 0 ? "+" : ""}{row.lapDeltaSeconds.toFixed(3)}</td>
                              <td style={{ padding: "6px 3px", color: deltaColor(row.cumulativeDeltaSeconds) }}>{row.cumulativeDeltaSeconds > 0 ? "+" : ""}{row.cumulativeDeltaSeconds.toFixed(3)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <div style={{ fontSize: 10, color: sub }}>No matched lap history for the selected comparison.</div>}
                  <div style={{ fontSize: 8, color: sub, marginTop: 6 }}>Negative delta means the selected driver was faster on that lap. Running Δ is the sum of lap-time differences over the displayed common-lap history; it is not the official on-track interval.</div>
                </div>
                <div style={{fontSize:9,color:sub,lineHeight:1.5,marginTop:10}}>
                  Method: pace rank and field median use each driver's current-stint 10-lap average. Last-5 trend compares the latest five clean laps with the five immediately before them. Pit and detected caution laps are excluded. These are descriptive indicators, not a tire-wear or finishing-position prediction model.
                </div>
              </div>
            );
          })()}

      {/* ═══ PRACTICE ═══ */}
      {mode === "practice" && (() => {
        const usingPH = practHistSessionId != null && practHist.NAMES?.length > 0;
        const pB = usingPH ? practHist.BEST : BEST;
        const pL = usingPH ? practHist.LAPS : LAPS;
        const pG = usingPH ? practHist.GROUPS : GROUPS;
        const pN = usingPH ? practHist.NUM : NUM;
        const pNA = usingPH ? practHist.NAMES : NAMES;
        const pC = usingPH ? practHist.CLR : CLR;
        const pRUN = usingPH ? practHist.RUN_ANALYSIS : RUN_ANALYSIS;
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
                ? `${pSess?.is_active ? "LIVE" : "FINAL"} · ${pSess?.track_name || ""} · ${pSess?.session_type?.toUpperCase() || ""} · ${pSess?.session_date || ""}`
                : session?.track_name ? `${session?.is_active ? "LIVE" : "FINAL"} · ${session.track_name}` : "No practice session"}
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
            {["Dashboard", "Lap by Lap", "Chart"].map((t) => (
              <button key={t} onClick={() => setPView(t.toLowerCase().replaceAll(" ", ""))} style={{ flex: 1, padding: "10px", background: "transparent", color: pView === t.toLowerCase().replaceAll(" ", "") ? acc : sub, border: "none", borderBottom: pView === t.toLowerCase().replaceAll(" ", "") ? `2px solid ${acc}` : "2px solid transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", height: TH }}>{t}</button>
            ))}
          </div>

          {pView === "dashboard" && (
            <PracticeRunDashboard
              names={pNA}
              numbers={pN}
              groups={pG}
              runAnalysis={pRUN}
              selectedDriver={pPri}
              dark={dark}
              onSelectDriver={setPrimary}
            />
          )}

          {pView === "lapbylap" && <><div style={{padding:"8px 12px",fontSize:11,color:sub}}>Matrix source: {usingPH ? "archived practice" : "current session"} · {pNA.length} drivers · {Object.values(pL || {}).reduce((sum,rows)=>sum+(Array.isArray(rows)?rows.length:0),0)} lap records</div><PracticeMatrixErrorBoundary><PracticeLapMatrix lapsByDriver={pL} names={pNA} numbers={pN} selectedDriver={pPri} dark={dark} accent={acc} runAnalysis={pRUN} favorites={practiceLapFavorites} onToggleFavorite={(name)=>setPracticeLapFavorites(prev=>prev.includes(name)?prev.filter(x=>x!==name):[...prev,name])} /></PracticeMatrixErrorBoundary></>}

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