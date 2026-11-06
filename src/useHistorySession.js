// useHistorySession — loads a completed (historical) session by ID and
// computes the same BEST / EOR / LAPS analytics that useLiveSession produces.
// No polling — historical data is static once imported.
//
// Duplicates the pure computation helpers from useLiveSession intentionally
// to avoid coupling; if the analytics logic diverges in the future each hook
// can evolve independently.

import { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { normalizePracticeGroup } from './raceMetrics';
import { buildDriverRunAnalysis, isTireChangePitStop } from './engineeringMetrics';

const PIT_MARGIN_SECONDS = 5;
const ABSOLUTE_MAX_LAP = 300;
const WINDOWS = [5, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100];

const PALETTE = [
  '#2563eb','#dc2626','#22c55e','#eab308','#a855f7','#06b6d4',
  '#f97316','#ec4899','#10b981','#6366f1','#84cc16','#f43f5e',
  '#14b8a6','#8b5cf6','#f59e0b','#3b82f6','#ef4444','#0ea5e9',
];

function driverThreshold(laps, bestOverride = null) {
  if (!laps.length) return ABSOLUTE_MAX_LAP;
  const best = bestOverride != null
    ? bestOverride
    : Math.min(...laps.map(([, t]) => t).filter((t) => t > 0 && t < ABSOLUTE_MAX_LAP));
  if (!isFinite(best) || best <= 0) return ABSOLUTE_MAX_LAP;
  return best + PIT_MARGIN_SECONDS;
}

function cleanLaps(laps, thr) {
  return laps.filter(([, t]) => t > 0 && t <= thr);
}

function rollingAvg(laps, n) {
  if (laps.length < n) return null;
  return laps.slice(-n).reduce((a, [, t]) => a + t, 0) / n;
}

function bestWindow(laps, n) {
  if (laps.length < n) return null;
  let best = Infinity;
  for (let i = 0; i <= laps.length - n; i++) {
    const avg = laps.slice(i, i + n).reduce((a, [, t]) => a + t, 0) / n;
    if (avg < best) best = avg;
  }
  return best === Infinity ? null : best;
}

function bestSingle(laps) {
  const candidates = laps.map(([, t]) => t).filter((t) => t > 0 && t < ABSOLUTE_MAX_LAP);
  return candidates.length ? Math.min(...candidates) : null;
}

function currentStint(rawLapsAsc, thr, cautionSet = new Set()) {
  if (!rawLapsAsc.length) return [];
  let lastBoundaryIdx = -1;
  for (let i = 0; i < rawLapsAsc.length; i++) {
    const [lapNum, lapTime] = rawLapsAsc[i];
    if (lapTime > thr || cautionSet.has(lapNum)) lastBoundaryIdx = i;
  }
  return rawLapsAsc
    .slice(lastBoundaryIdx + 1)
    .filter(([n, t]) => t > 0 && t <= thr && !cautionSet.has(n));
}

function computeDriverStats(rawLaps, cautionSet = new Set()) {
  const laps = [...rawLaps].sort((a, b) => a[0] - b[0]);
  const bestLap = bestSingle(laps);
  const thr = driverThreshold(laps, bestLap);
  const clean = cleanLaps(laps, thr).filter(([n]) => !cautionSet.has(n));
  const stintAsc = currentStint(laps, thr, cautionSet);

  const best = {};
  for (const n of WINDOWS) best[`t${n}`] = bestWindow(stintAsc, n);
  best.best = bestLap;
  best.tl = clean.length;

  const eor = {};
  for (const n of WINDOWS) eor[`t${n}`] = rollingAvg(stintAsc, n);

  return { best, eor, laps, clean, stint: stintAsc };
}

function detectCautionLaps(rawLaps) {
  if (!rawLaps || rawLaps.length === 0) return new Set();
  const byLap = new Map();
  for (const r of rawLaps) {
    const t = parseFloat(r.lap_time);
    if (!isFinite(t) || t <= 0 || t > ABSOLUTE_MAX_LAP) continue;
    if (!byLap.has(r.lap_number)) byLap.set(r.lap_number, []);
    byLap.get(r.lap_number).push(t);
  }
  const medianByLap = new Map();
  for (const [lap, times] of byLap.entries()) {
    if (times.length < 5) continue;
    const sorted = [...times].sort((a, b) => a - b);
    medianByLap.set(lap, sorted[Math.floor(sorted.length / 2)]);
  }
  if (medianByLap.size < 5) return new Set();
  const medians = [...medianByLap.values()].sort((a, b) => a - b);
  const baseline = medians[Math.floor(medians.length * 0.1)];
  const cautionLaps = new Set();
  for (const [lap, med] of medianByLap.entries()) {
    if (med > baseline * 1.20) cautionLaps.add(lap);
  }
  return cautionLaps;
}

export function useHistorySession(sessionId) {
  const [session, setSession] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [rawLaps, setRawLaps] = useState([]);
  const [rawPitStops, setRawPitStops] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | loaded | error

  useEffect(() => {
    if (!sessionId) {
      setStatus('idle');
      setSession(null);
      setDrivers([]);
      setRawLaps([]);
      return;
    }

    let cancelled = false;
    setStatus('loading');

    (async () => {
      try {
        const { data: sess, error: sErr } = await supabase
          .from('sessions')
          .select('*')
          .eq('id', sessionId)
          .single();
        if (sErr) throw sErr;
        if (!cancelled) setSession(sess);

        const { data: drvs } = await supabase
          .from('drivers')
          .select('*')
          .eq('session_id', sessionId);
        if (!cancelled) setDrivers(drvs || []);

        let all = [];
        let from = 0;
        const PAGE = 1000;
        while (!cancelled) {
          const { data: chunk, error: lErr } = await supabase
            .from('laps')
            .select('driver_key, lap_number, lap_time, is_pit, is_caution, recorded_at')
            .eq('session_id', sessionId)
            .order('lap_number', { ascending: true })
            .range(from, from + PAGE - 1);
          if (lErr) throw lErr;
          if (!chunk || chunk.length === 0) break;
          all = all.concat(chunk);
          if (chunk.length < PAGE) break;
          from += PAGE;
        }
        const { data: pitStops } = await supabase
          .from('race_events')
          .select('driver_key, lap_number, details, recorded_at')
          .eq('session_id', sessionId)
          .eq('event_type', 'pit_stop')
          .order('lap_number', { ascending: true });
        if (!cancelled) {
          setRawLaps(all);
          setRawPitStops(pitStops || []);
          setStatus('loaded');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId]);

  const derived = useMemo(() => {
    // Deduplicate poll snapshots: one authoritative record per driver/session lap.
    // Prefer the most recently recorded snapshot, retaining its flags and corrected time.
    const uniqueLapRows = new Map();
    for (const row of rawLaps) {
      const key = String(row.driver_key) + ":" + Number(row.lap_number);
      const prior = uniqueLapRows.get(key);
      if (!prior || String(row.recorded_at || "") >= String(prior.recorded_at || "")) uniqueLapRows.set(key, row);
    }
    const canonicalLaps = [...uniqueLapRows.values()].sort((a,b)=>Number(a.lap_number)-Number(b.lap_number));
    const cautionSet = detectCautionLaps(canonicalLaps);
    canonicalLaps.forEach((row) => { if (row.is_caution === true) cautionSet.add(Number(row.lap_number)); });
    const byDriver = {};
    for (const row of canonicalLaps) {
      if (!byDriver[row.driver_key]) byDriver[row.driver_key] = [];
      byDriver[row.driver_key].push([Number(row.lap_number), parseFloat(row.lap_time)]);
    }

    const BEST = {}, EOR = {}, LAPS = {}, NUM = {}, CLR = {}, GROUPS = {};
    const RUN_ANALYSIS = {}, PIT_STOPS = {};

    for (const d of drivers) {
      const dkey = d.driver_key;
      const name = d.full_name;
      NUM[name] = d.car_number || '?';
      GROUPS[name] = normalizePracticeGroup(d.practice_group);

      const stats = computeDriverStats(byDriver[dkey] || [], cautionSet);
      const driverPitStops = rawPitStops.filter((stop) => stop.driver_key === dkey);
      RUN_ANALYSIS[name] = buildDriverRunAnalysis(
        stats.laps,
        { cautionLaps: [...cautionSet], pitLaps: [...driverPitStops.filter(isTireChangePitStop).map((stop) => stop.lap_number), ...(canonicalLaps.filter(row=>row.driver_key===dkey&&row.is_pit===true).map(row=>row.lap_number))] }
      );
      PIT_STOPS[name] = driverPitStops;
      BEST[name] = stats.best;
      EOR[name] = stats.eor;
      LAPS[name] = stats.laps;

      const hash = (parseInt(d.car_number, 10) || name.charCodeAt(0)) % PALETTE.length;
      CLR[name] = PALETTE[hash];
    }

    const NAMES = drivers
      .map((d) => d.full_name)
      .sort((a, b) => (parseInt(NUM[a], 10) || 99) - (parseInt(NUM[b], 10) || 99));

    return { BEST, EOR, LAPS, NUM, CLR, GROUPS, RUN_ANALYSIS, PIT_STOPS, NAMES, cautionSet };
  }, [drivers, rawLaps, rawPitStops]);

  return { session, status, rawPitStops, ...derived };
}
