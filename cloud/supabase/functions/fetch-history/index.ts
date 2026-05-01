// supabase/functions/fetch-history/index.ts
//
// Called by the PWA History panel before a race weekend.
// Finds the most recent completed race at the given track via NASCAR's schedule
// API, fetches its lap-times.json, and stores everything in the DB tagged
// started_by='historical'. Subsequent calls for the same track hit the DB
// cache instead of re-fetching from NASCAR.

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

// Normalise any shape NASCAR returns for a schedule entry.
// The CDN has varied this across years (snake_case, PascalCase, nested).
function normaliseRace(r: any): { raceId: number; trackName: string; raceDate: string; runType: number } | null {
  const raceId = parseInt(String(r.race_id ?? r.RaceId ?? r.RaceID ?? r.EventId ?? r.event_id ?? ""), 10);
  if (!raceId || isNaN(raceId)) return null;

  const trackName = String(r.track_name ?? r.TrackName ?? r.track ?? r.Track ?? "");
  if (!trackName) return null;

  // Date field — may be ISO string or "YYYY-MM-DD"
  const rawDate = r.race_date ?? r.date ?? r.RaceDate ?? r.start_date ?? r.StartDate ?? "";
  const raceDate = String(rawDate).slice(0, 10); // take YYYY-MM-DD prefix
  if (!raceDate || raceDate.length < 10) return null;

  const runType = parseInt(String(r.run_type ?? r.RunType ?? 3), 10);
  return { raceId, trackName, raceDate, runType };
}

// Fetch the NASCAR CDN schedule for a given year + series.
// Tries two URL patterns; returns an array of normalised race entries.
async function fetchSchedule(year: number, series: number): Promise<ReturnType<typeof normaliseRace>[]> {
  const urls = [
    `https://cf.nascar.com/cacher/${year}/${series}/schedule.json`,
    `https://cf.nascar.com/cacher/${year}/series_${series}/schedule.json`,
  ];

  for (const url of urls) {
    const data = await fetchJson(url, 6000);
    if (!data) continue;

    // Payload can be an array, or an object with a list somewhere inside
    let raw: any[] = [];
    if (Array.isArray(data)) {
      raw = data;
    } else {
      // Walk top-level keys looking for the first array
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) { raw = data[key]; break; }
      }
    }

    const parsed = raw.map(normaliseRace).filter(Boolean) as ReturnType<typeof normaliseRace>[];
    if (parsed.length > 0) return parsed;
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

    // ── Find previous races at this track from schedule ──────────
    const today = new Date().toISOString().slice(0, 10);
    const currentYear = new Date().getFullYear();
    const trackKeyword = track_name.split(" ")[0].toLowerCase(); // "texas" from "Texas Motor Speedway"

    let candidates: NonNullable<ReturnType<typeof normaliseRace>>[] = [];

    for (let year = currentYear; year >= currentYear - 2 && candidates.length === 0; year--) {
      const schedule = await fetchSchedule(year, series);
      const matching = schedule
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .filter((r) => r.trackName.toLowerCase().includes(trackKeyword))
        .filter((r) => r.raceDate < today) // only completed events
        .filter((r) => r.runType === 3);   // races only (run_type 3)
      candidates = matching.sort((a, b) => b.raceDate.localeCompare(a.raceDate));
    }

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          reason: "no_schedule_data",
          message: `No completed race found for "${track_name}" in the last 2 seasons. NASCAR schedule API may be unavailable.`,
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
      if (data && Array.isArray(data.laps) && data.laps.length > 0) {
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
          message: `Found schedule entries for "${track_name}" but lap data is not available yet.`,
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

    // ── Import drivers and laps (same format as poll-nascar) ─────
    const driversArr: any[] = lapData.laps ?? [];
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

      for (const lap of (d.Laps ?? [])) {
        const lapNumber = lap.Lap;
        const lapTime = lap.LapTime;
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
