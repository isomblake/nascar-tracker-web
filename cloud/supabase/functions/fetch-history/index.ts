// supabase/functions/fetch-history/index.ts
//
// Called by the PWA History panel before a race weekend.
// Finds the most recent completed race at the given track, fetches its
// lap-times.json, and stores everything in the DB tagged started_by='historical'.
//
// Discovery strategy:
//   1. Try NASCAR schedule API (fast, but often unavailable mid-season)
//   2. Fallback: scan live-feed.json backwards from current session's race_id,
//      looking for flag_state=4 (checkered) + track name match

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function fetchJson(url: string, timeoutMs = 5000): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function mapRunType(runType: number): string {
  if (runType === 3) return "race";
  if (runType === 4) return "qualifying";
  if (runType === 1) return "practice1";
  if (runType === 2) return "practice2";
  return "unknown";
}

function normaliseRace(r: any): { raceId: number; trackName: string; raceDate: string; runType: number } | null {
  const raceId = parseInt(String(r.race_id ?? r.RaceId ?? r.RaceID ?? r.EventId ?? r.event_id ?? ""), 10);
  if (!raceId || isNaN(raceId)) return null;
  const trackName = String(r.track_name ?? r.TrackName ?? r.track ?? r.Track ?? "");
  if (!trackName) return null;
  const rawDate = r.race_date ?? r.date ?? r.RaceDate ?? r.start_date ?? r.StartDate ?? "";
  const raceDate = String(rawDate).slice(0, 10);
  if (!raceDate || raceDate.length < 10) return null;
  const runType = parseInt(String(r.run_type ?? r.RunType ?? 3), 10);
  return { raceId, trackName, raceDate, runType };
}

async function fetchSchedule(year: number, series: number): Promise<ReturnType<typeof normaliseRace>[]> {
  const urls = [
    `https://cf.nascar.com/cacher/${year}/${series}/schedule.json`,
    `https://cf.nascar.com/cacher/${year}/series_${series}/schedule.json`,
  ];
  for (const url of urls) {
    const data = await fetchJson(url, 6000);
    if (!data) continue;
    let raw: any[] = Array.isArray(data) ? data : [];
    if (!raw.length) {
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) { raw = data[key]; break; }
      }
    }
    const parsed = raw.map(normaliseRace).filter(Boolean) as ReturnType<typeof normaliseRace>[];
    if (parsed.length > 0) return parsed;
  }
  return [];
}

// Scan live-feed.json backwards from startId looking for a completed race
// at the given track. Returns found candidates sorted newest-first.
// We do NOT filter on flag_state here because the NASCAR CDN often serves
// a cached flag_state that no longer reflects the final checkered value for
// older races. Instead we filter by raceDate < today so we never pick up
// the currently-running event.
async function scanBackwardsForRace(
  series: number,
  trackKeyword: string,
  startId: number,
  today: string
): Promise<{ raceId: number; trackName: string; raceDate: string; runType: number }[]> {
  const SCAN_BACK = 400;
  const BATCH = 30;

  for (let offset = 1; offset <= SCAN_BACK; offset += BATCH) {
    const ids: number[] = [];
    for (let j = offset; j < offset + BATCH && j <= SCAN_BACK; j++) {
      ids.push(startId - j);
    }

    const results = await Promise.all(
      ids.map(async (id) => {
        const feed = await fetchJson(
          `https://cf.nascar.com/cacher/live/series_${series}/${id}/live-feed.json`,
          3000
        );
        if (!feed) return null;
        const trackName = String(feed.track_name ?? "");
        if (!trackName.toLowerCase().includes(trackKeyword)) return null;
        const runType = parseInt(String(feed.run_type ?? 3), 10);
        if (runType !== 3) return null; // races only
        const raceDate = String(feed.race_date ?? feed.RaceDate ?? "").slice(0, 10);
        if (!raceDate || raceDate.length < 10) return null;
        if (raceDate >= today) return null; // skip today's live race
        return { raceId: id, trackName, raceDate, runType };
      })
    );

    const found = results.filter((r): r is NonNullable<typeof r> => r !== null);
    if (found.length > 0) {
      return found.sort((a, b) => b.raceDate.localeCompare(a.raceDate));
    }
  }
  return [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const { track_name, series = 1, force_refresh = false } = body;

  if (!track_name) {
    return new Response(
      JSON.stringify({ ok: false, error: "track_name required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Cache check ──────────────────────────────────────────────
    if (!force_refresh) {
      const { data: cached } = await supabase
        .from("sessions")
        .select("id, track_name, session_type, session_date, series, race_id")
        .eq("started_by", "historical")
        .ilike("track_name", `%${track_name.split(" ")[0]}%`)
        .eq("series", series)
        .order("session_date", { ascending: false })
        .limit(3);

      if (cached && cached.length > 0) {
        return new Response(
          JSON.stringify({ ok: true, cached: true, sessions: cached }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const currentYear = new Date().getFullYear();
    const trackKeyword = track_name.split(" ")[0].toLowerCase();

    // ── Strategy 1: NASCAR schedule API ─────────────────────────
    let candidates: NonNullable<ReturnType<typeof normaliseRace>>[] = [];

    for (let year = currentYear; year >= currentYear - 2 && candidates.length === 0; year--) {
      const schedule = await fetchSchedule(year, series);
      const matching = schedule
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .filter((r) => r.trackName.toLowerCase().includes(trackKeyword))
        .filter((r) => r.raceDate < today)
        .filter((r) => r.runType === 3);
      if (matching.length > 0) {
        candidates = matching.sort((a, b) => b.raceDate.localeCompare(a.raceDate));
      }
    }

    // ── Strategy 2: scan backwards from current session race_id ─
    if (candidates.length === 0) {
      const { data: recentSessions } = await supabase
        .from("sessions")
        .select("race_id")
        .neq("started_by", "historical")
        .eq("series", series)
        .order("started_at", { ascending: false })
        .limit(1);

      const startId = recentSessions?.[0]?.race_id
        ? parseInt(String(recentSessions[0].race_id), 10)
        : null;

      if (startId && !isNaN(startId)) {
        candidates = await scanBackwardsForRace(series, trackKeyword, startId, today);
      }
    }

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          reason: "no_schedule_data",
          message: `No completed race found for "${track_name}". Try again after the current race finishes.`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Fetch lap data for the most recent matching race ─────────
    let lapData: any = null;
    let pickedRace: typeof candidates[0] | null = null;

    for (const race of candidates.slice(0, 5)) {
      const lapUrl = `https://cf.nascar.com/cacher/live/series_${series}/${race.raceId}/lap-times.json`;
      const data = await fetchJson(lapUrl);
      // Handle both laps (Cup) and Laps (Truck/Xfinity) variants
      const arr = data?.laps ?? data?.Laps;
      if (data && Array.isArray(arr) && arr.length > 0) {
        lapData = data;
        pickedRace = race;
        break;
      }
    }

    if (!lapData || !pickedRace) {
      return new Response(
        JSON.stringify({
          ok: false,
          reason: "no_lap_data",
          message: `Found a previous race at "${track_name}" but lap data is not available.`,
          candidates: candidates.slice(0, 3).map((r) => ({ race_id: r.raceId, date: r.raceDate })),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Create the historical session row ────────────────────────
    const { data: sessionRow, error: sErr } = await supabase
      .from("sessions")
      .insert({
        race_id: String(pickedRace.raceId),
        track_name: pickedRace.trackName,
        session_type: mapRunType(pickedRace.runType),
        session_date: pickedRace.raceDate,
        is_active: false,
        poll_url: `https://cf.nascar.com/cacher/live/series_${series}/${pickedRace.raceId}/lap-times.json`,
        started_by: "historical",
        series,
      })
      .select()
      .single();

    if (sErr) throw sErr;

    // ── Import drivers and laps (handles PascalCase + camelCase) ─
    const driversArr: any[] = lapData.laps ?? lapData.Laps ?? [];
    const driverRows: any[] = [];
    const lapRows: any[] = [];

    for (const d of driversArr) {
      const driverKey = String(d.NASCARDriverID ?? d.Number ?? "");
      if (!driverKey) continue;
      const carNumber = String(d.Number ?? "");
      const fullName = String(d.FullName ?? "");
      const lastName = fullName.split(" ").slice(-1)[0] ?? "";

      driverRows.push({
        session_id: sessionRow.id,
        driver_key: driverKey,
        car_number: carNumber,
        full_name: fullName,
        last_name: lastName,
      });

      for (const lap of (d.Laps ?? d.laps ?? [])) {
        const lapNumber = lap.Lap ?? lap.lap;
        const lapTime = lap.LapTime ?? lap.lapTime ?? lap.lap_time;
        if (lapNumber == null || lapTime == null || lapTime <= 0) continue;
        lapRows.push({ session_id: sessionRow.id, driver_key: driverKey, lap_number: lapNumber, lap_time: lapTime });
      }
    }

    if (driverRows.length > 0) {
      await supabase
        .from("drivers")
        .upsert(driverRows, { onConflict: "session_id,driver_key", ignoreDuplicates: true });
    }

    const CHUNK = 500;
    let lapsInserted = 0;
    for (let i = 0; i < lapRows.length; i += CHUNK) {
      const { error } = await supabase
        .from("laps")
        .upsert(lapRows.slice(i, i + CHUNK), { onConflict: "session_id,driver_key,lap_number" });
      if (!error) lapsInserted += CHUNK;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        cached: false,
        sessions: [{ id: sessionRow.id, track_name: sessionRow.track_name, session_type: sessionRow.session_type, session_date: sessionRow.session_date, series: sessionRow.series, race_id: sessionRow.race_id }],
        stats: { drivers: driverRows.length, laps: lapsInserted },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
