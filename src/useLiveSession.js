// ═══════════════════════════════════════════════════════════════════
// useLiveSession — loads live race data from Supabase and computes the
// derived data structures the UI was built around (BEST, EOR, LAPS, SIM_POS).
//
// The Python tracker writes raw laps + positions. All analytics (rolling
// averages, best windows, end-of-run) are computed here on the client.
// ═══════════════════════════════════════════════════════════════════

import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from './supabaseClient';

// Track-independent lap classification:
// - A "pit/outlier lap" is anything significantly slower than the driver's best.
// - Margin of 5s works across all tracks: short tracks (Martinsville ~20s best, pit ~45s),
//   intermediates (~30s best, pit ~55s), superspeedways (~47s best, pit ~55s).
// - Green-flag variation is typically <2s even on worn tires, so 5s is safe.
const PIT_MARGIN_SECONDS = 5;
const ABSOLUTE_MAX_LAP = 300;    // hard cap for obviously bad data
const WINDOWS = [5, 10, 15, 20, 25, 30, 35, 40, 50, 75, 100];

// ─── pure helpers ─────────────────────────────────────────────────

// Compute the per-driver threshold above which a lap is considered a pit/outlier.
// Uses best lap + margin. Caller can pass a pre-computed best to avoid re-scanning.
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
  const slice = laps.slice(-n);
  return slice.reduce((a, [, t]) => a + t, 0) / n;
}

function bestWindow(laps, n) {
  if (laps.length < n) return null;
  let best = Infinity;
  for (let i = 0; i <= laps.length - n; i++) {
    const sum = laps.slice(i, i + n).reduce((a, [, t]) => a + t, 0);
    const avg = sum / n;
    if (avg < best) best = avg;
  }
  return best === Infinity ? null : best;
}

function bestSingle(laps) {
  if (!laps.length) return null;
  const candidates = laps.map(([, t]) => t).filter((t) => t > 0 && t < ABSOLUTE_MAX_LAP);
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

// Detect current stint. A stint break happens at EITHER:
//   (a) a pit lap (this driver's time > best + 5s), OR
//   (b) a caution lap (field-wide slowdown, passed in via cautionSet)
// Current stint = all clean laps AFTER the most recent boundary of either type.
// Operates on raw laps so pit laps are visible as boundaries.
function currentStint(rawLapsAsc, thr, cautionSet = new Set()) {
  if (!rawLapsAsc.length) return [];
  let lastBoundaryIdx = -1;
  for (let i = 0; i < rawLapsAsc.length; i++) {
    const [lapNum, lapTime] = rawLapsAsc[i];
    const isPit = lapTime > thr;
    const isCaution = cautionSet.has(lapNum);
    if (isPit || isCaution) lastBoundaryIdx = i;
  }
  const afterBoundary = rawLapsAsc.slice(lastBoundaryIdx + 1);
  // Filter out any remaining pit/caution laps (shouldn't happen, but defensive)
  return afterBoundary.filter(([n, t]) => t > 0 && t <= thr && !cautionSet.has(n));
}

// Compute BEST/EOR for one driver's laps. Excludes both personal outliers
// (pit/spin) AND field-wide caution laps. Stint resets on EITHER boundary.
function computeDriverStats(rawLaps, cautionSet = new Set()) {
  const laps = [...rawLaps].sort((a, b) => a[0] - b[0]);

  // Per-driver threshold: best lap + 5s. Works at every track.
  const bestLap = bestSingle(laps);
  const thr = driverThreshold(laps, bestLap);

  // For BEST window computation, use full-session clean laps
  const clean = cleanLaps(laps, thr).filter(([n]) => !cautionSet.has(n));

  // Current stint uses RAW laps so pit/caution boundaries are visible
  const stintAsc = currentStint(laps, thr, cautionSet);

  // BEST window (search within current stint only — since session-best is meaningless)
  const best = {};
  for (const n of WINDOWS) {
    best[`t${n}`] = bestWindow(stintAsc, n);
  }
  best.best = bestLap;
  best.tl = clean.length;

  // END OF RUN = last N laps of current stint
  const eor = {};
  for (const n of WINDOWS) {
    eor[`t${n}`] = rollingAvg(stintAsc, n);
  }

  return { best, eor, laps, clean, stint: stintAsc };
}

// ─── main hook ────────────────────────────────────────────────────
export function useLiveSession() {
  const [session, setSession] = useState(null);
  const [drivers, setDrivers] = useState([]);         // [{driver_key, car_number, full_name, last_name, practice_group}]
  const [rawLaps, setRawLaps] = useState([]);         // [{driver_key, lap_number, lap_time}]
  const [rawPositions, setRawPositions] = useState([]); // [{driver_key, position}]
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState(null);

  // Load initial active session + its data
  const loadAll = useCallback(async () => {
    try {
      setStatus('loading');
      // 1. Find active session
      const { data: sessions, error: sErr } = await supabase
        .from('sessions')
        .select('*')
        .eq('is_active', true)
        .order('started_at', { ascending: false })
        .limit(1);
      if (sErr) throw sErr;

      if (!sessions || sessions.length === 0) {
        // No active session — fall back to most recent any-session
        const { data: recent } = await supabase
          .from('sessions')
          .select('*')
          .order('started_at', { ascending: false })
          .limit(1);
        if (!recent || recent.length === 0) {
          setSession(null);
          setStatus('no_session');
          return;
        }
        setSession(recent[0]);
      } else {
        setSession(sessions[0]);
      }

      const activeId = (sessions && sessions[0]?.id) || null;
      if (!activeId) { setStatus('no_session'); return; }

      // 2. Load drivers
      const { data: drvs } = await supabase
        .from('drivers')
        .select('*')
        .eq('session_id', activeId);
      setDrivers(drvs || []);

      // 3. Load all laps (paginated — Supabase caps at 1000 per query)
      let all = [];
      let from = 0;
      const PAGE = 1000;
      while (true) {
        const { data: chunk, error: lErr } = await supabase
          .from('laps')
          .select('driver_key, lap_number, lap_time')
          .eq('session_id', activeId)
          .order('lap_number', { ascending: true })
          .range(from, from + PAGE - 1);
        if (lErr) throw lErr;
        if (!chunk || chunk.length === 0) break;
        all = all.concat(chunk);
        if (chunk.length < PAGE) break;
        from += PAGE;
      }
      setRawLaps(all);

      // 4. Load positions
      const { data: pos } = await supabase
        .from('positions')
        .select('driver_key, position')
        .eq('session_id', activeId);
      setRawPositions(pos || []);

      setStatus('live');
      setError(null);
    } catch (e) {
      console.error('[useLiveSession] load error', e);
      setError(e.message || String(e));
      setStatus('error');
    }
  }, []);

  // Initial load
  useEffect(() => { loadAll(); }, [loadAll]);

  // Realtime: subscribe to laps and positions for the active session
  useEffect(() => {
    if (!session?.id) return;
    const sessId = session.id;

    const lapsChannel = supabase
      .channel(`laps-${sessId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'laps', filter: `session_id=eq.${sessId}` },
        (payload) => {
          const row = payload.new || payload.old;
          if (!row) return;
          setRawLaps((prev) => {
            // Upsert by (driver_key, lap_number)
            const filtered = prev.filter(
              (r) => !(r.driver_key === row.driver_key && r.lap_number === row.lap_number)
            );
            if (payload.eventType === 'DELETE') return filtered;
            return [...filtered, {
              driver_key: row.driver_key,
              lap_number: row.lap_number,
              lap_time: row.lap_time,
            }];
          });
        }
      )
      .subscribe();

    const posChannel = supabase
      .channel(`positions-${sessId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions', filter: `session_id=eq.${sessId}` },
        (payload) => {
          const row = payload.new || payload.old;
          if (!row) return;
          setRawPositions((prev) => {
            const filtered = prev.filter((r) => r.driver_key !== row.driver_key);
            if (payload.eventType === 'DELETE') return filtered;
            return [...filtered, { driver_key: row.driver_key, position: row.position }];
          });
        }
      )
      .subscribe();

    // Also watch for session changes (e.g. is_active flips on new session)
    const sessionChannel = supabase
      .channel('sessions-watch')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sessions' },
        () => { loadAll(); }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(lapsChannel);
      supabase.removeChannel(posChannel);
      supabase.removeChannel(sessionChannel);
    };
  }, [session?.id, loadAll]);

// ═══════════════════════════════════════════════════════════════════
// Field-wide caution detection:
// Look at the median lap time across the whole field per lap. On a caution,
// most drivers slow to pace car speed simultaneously (~1.25x+ green pace).
// A single driver pitting/spinning does NOT affect the field median.
// ═══════════════════════════════════════════════════════════════════
const CAUTION_MULT_THRESHOLD = 1.20;  // field median this much above baseline = caution
const MIN_DRIVERS_FOR_CAUTION = 5;    // need enough cars reporting

function detectCautionLaps(rawLaps) {
  // rawLaps: [{driver_key, lap_number, lap_time}]
  if (!rawLaps || rawLaps.length === 0) return new Set();

  // Index lap_number -> [times]
  const byLap = new Map();
  for (const r of rawLaps) {
    const t = parseFloat(r.lap_time);
    if (!isFinite(t) || t <= 0 || t > ABSOLUTE_MAX_LAP) continue;
    if (!byLap.has(r.lap_number)) byLap.set(r.lap_number, []);
    byLap.get(r.lap_number).push(t);
  }

  // Compute field median per lap (only laps with enough cars)
  const medianByLap = new Map();
  for (const [lap, times] of byLap.entries()) {
    if (times.length < MIN_DRIVERS_FOR_CAUTION) continue;
    const sorted = [...times].sort((a, b) => a - b);
    medianByLap.set(lap, sorted[Math.floor(sorted.length / 2)]);
  }

  if (medianByLap.size < 5) return new Set();

  // Baseline = 10th percentile of field medians (representative green-flag pace)
  const medians = [...medianByLap.values()].sort((a, b) => a - b);
  const baseline = medians[Math.floor(medians.length * 0.1)];

  // Any lap whose field median exceeds baseline * threshold = caution lap
  const cautionLaps = new Set();
  for (const [lap, med] of medianByLap.entries()) {
    if (med > baseline * CAUTION_MULT_THRESHOLD) cautionLaps.add(lap);
  }
  return cautionLaps;
}


  // ─── derived data (matches prototype shapes) ──────────────────
  const derived = useMemo(() => {
    // FIRST: detect field-wide caution laps (done once for whole field)
    const cautionSet = detectCautionLaps(rawLaps);

    // Group laps by driver_key
    const byDriver = {};
    for (const row of rawLaps) {
      if (!byDriver[row.driver_key]) byDriver[row.driver_key] = [];
      byDriver[row.driver_key].push([row.lap_number, parseFloat(row.lap_time)]);
    }

    const BEST = {};
    const EOR = {};
    const LAPS = {};
    const NUM = {};
    const CLR = {};
    const GROUPS = {};
    const SIM_POS = {};
    const STINT = {};           // per-driver: current stint laps array
    const LAST_PIT = {};        // per-driver: lap number of last pit stop (or null)
    const LAST_LAP_TIME = {};   // per-driver: most recent clean lap time (for full-field "Last" column)

    // Stable color palette for drivers (cycled by car-number hash)
    const PALETTE = [
      '#2563eb','#dc2626','#22c55e','#eab308','#a855f7','#06b6d4',
      '#f97316','#ec4899','#10b981','#6366f1','#84cc16','#f43f5e',
      '#14b8a6','#8b5cf6','#f59e0b','#3b82f6','#ef4444','#0ea5e9',
    ];

    for (const d of drivers) {
      const dkey = d.driver_key;
      const dispName = d.full_name;
      NUM[dispName] = d.car_number || '?';
      GROUPS[dispName] = d.practice_group || null;

      const rawDrv = byDriver[dkey] || [];
      const stats = computeDriverStats(rawDrv, cautionSet);
      BEST[dispName] = stats.best;
      EOR[dispName] = stats.eor;
      LAPS[dispName] = stats.laps;
      STINT[dispName] = stats.stint;

      // Find last pit lap: highest lap where raw time > best + 5 (ignore cautions)
      const bestL = stats.best.best;
      const thr = (bestL != null && bestL > 0) ? bestL + 5 : ABSOLUTE_MAX_LAP;
      let lastPitLap = null;
      for (let i = stats.laps.length - 1; i >= 0; i--) {
        const [n, t] = stats.laps[i];
        if (t > thr && !cautionSet.has(n)) { lastPitLap = n; break; }
      }
      LAST_PIT[dispName] = lastPitLap;

      // Most recent clean lap time (not caution, not pit)
      let lastLapTime = null;
      for (let i = stats.laps.length - 1; i >= 0; i--) {
        const [n, t] = stats.laps[i];
        if (t > 0 && t <= thr && !cautionSet.has(n)) { lastLapTime = t; break; }
      }
      LAST_LAP_TIME[dispName] = lastLapTime;

      const hash = (parseInt(d.car_number, 10) || dispName.charCodeAt(0)) % PALETTE.length;
      CLR[dispName] = PALETTE[hash];
    }

    for (const p of rawPositions) {
      // Map driver_key -> full_name for SIM_POS
      const drv = drivers.find((x) => x.driver_key === p.driver_key);
      if (drv) SIM_POS[drv.full_name] = p.position;
    }

    const NAMES = drivers
      .map((d) => d.full_name)
      .sort((a, b) => (parseInt(NUM[a], 10) || 99) - (parseInt(NUM[b], 10) || 99));

    // Build caution ranges (consecutive lap numbers) for UI timeline markers
    const cautionLapsSorted = [...cautionSet].sort((a, b) => a - b);
    const cautionRanges = [];
    for (const lap of cautionLapsSorted) {
      const last = cautionRanges[cautionRanges.length - 1];
      if (last && last.end === lap - 1) last.end = lap;
      else cautionRanges.push({ start: lap, end: lap });
    }

    return { BEST, EOR, LAPS, NUM, CLR, GROUPS, SIM_POS, STINT, LAST_PIT, LAST_LAP_TIME, NAMES, cautionSet, cautionRanges };
  }, [drivers, rawLaps, rawPositions]);

  return {
    session,
    status,
    error,
    drivers,
    rawLaps,
    rawPositions,
    ...derived,
    reload: loadAll,
  };
}
