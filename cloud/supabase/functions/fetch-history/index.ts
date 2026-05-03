// supabase/functions/fetch-history/index.ts
//
// Called by the PWA History panel (race) and Practice tab (practice history).
// Strategy 1: fetch NASCAR schedule API and find a prior completed run.
// Strategy 2: scan backwards from the most recent known race ID via live-feed.json.
// Whichever finds data first wins. Results are cached in the DB (started_by='historical').
//
// run_type param: 3=race (default), 1=practice1, 2=practice2/final-practice

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
  if (runType === 2) return "practice2";
  if (runType === 1) return "practice1";
  return "unknown";
}

// Normalise any shape NASCAR returns for a schedule entry.
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

// Fetch the NASCAR CDN schedule for a given year + series.
async function fetchSchedule(year: number, series: number): Promise<ReturnType<typeof normaliseRace>[]> {
  const urls = [
    `https://cf.nascar.com/cacher/${year}/${series}/schedule.json`,
    `https://cf.nascar.com/cacher/${year}/series_${series}/schedule.json`,
    `https://cf.nascar.com/cacher/${year}/${series}/races.json`,
    `https://cf.nascar.com/cacher/${year}/series_${series}/races.json`,
    `https://cf.nascar.com/cacher/${year}/${series}/results.json`,
  ];

  for (const url of urls) {
    const data = await fetchJson(url, 6000);
    if (!data) continue;

    let raw: any[] = [];
    if (Array.isArray(data)) {
      raw = data;
    } else {
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) { raw = data[key]; break; }
      }
    }

    const parsed = raw.map(normaliseRace).filter(Boolean) as ReturnType<typeof normaliseRace>[];
    if (parsed.length > 0) return parsed;
  }
  return [];
}

// Scan backwards from startId via live-feed.json, looking for completed runs matching
// trackKeyword and targetRunType. BATCH=60 concurrent requests; stops on first batch with matches.
async function scanBackwardsForRun(
  series: number,
  trackKeyword: string,
  startId: number,
  today: string,
  targetRunType: number
): Promise<{ raceId: number; trackName: string; raceDate: string; runType: number }[]> {
  const SCAN_BACK = 400;
  const BATCH = 60;

  for (let offset = 1; offset <= SCAN_BACK; offset += BATCH) {
    const ids: number[] = [];
    for (let j = offset; j < offset + BATCH && j <= SCAN_BACK; j++) {
      ids.push(startId - j);
    }

    const results = await Promise.all(
      ids.map(async (id) => {
        const feed = await fetchJson(
          `https://cf.nascar.com/cacher/live/series_${series}/${id}/live-feed.json`,
          2000
        );
        if (!feed) return null;

        const trackName = String(feed.track_name ?? feed.TrackName ?? "");
        if (!trackName.toLowerCase().includes(trackKeyword)) return null;

        const runType = parseInt(String(feed.run_type ?? feed.RunType ?? 3), 10);
        // NASCAR uses run_type 1 for all practice sessions (P1 and Final/P2 alike).
        // Accept either when looking for any practice type.
        const isPracticeTarget = targetRunType === 1 || targetRunType === 2;
        if (isPracticeTarget ? (runType !== 1 && runType !== 2) : runType !== targetRunType) return null;

        const raceDate = String(feed.race_date ?? feed.RaceDate ?? feed.start_date ?? "").slice(0, 10);
        if (!raceDate || raceDate.length < 10) return null;
        // Use <= (not <) so practice sessions stored with the race weekend date (today) are included.
        if (raceDate > today) return null;

        return { raceId: id, trackName, raceDate, runType };
      })
    );

    const found = results.filter((r): r is NonNullable<typeof r> => r !== null);
    if (found.length > 0) return found.sort((a, b) => b.raceDate.localeCompare(a.raceDate));
  }
  return [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const { track_name, series = 1, force_refresh = false, run_type = 3 } = body;

  if (!track_name) {
    return new Response(
      JSON.stringify({ ok: false, error: "track_name required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const isPractice = run_type === 1 || run_type === 2;
  const sessionType = mapRunType(run_type);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // ── Cache check ──────────────────────────────────────────────
    if (!force_refresh) {
      let query = supabase
        .from("sessions")
        .select("id, track_name, session_type, session_date, series, race_id")
        .eq("started_by", "historical")
        .ilike("track_name", `%${track_name.split(" ")[0]}%`)
        .eq("series", series)
        .order("session_date", { ascending: false })
        .limit(3);

      // For practice, filter to the specific session type to avoid returning race sessions
      if (isPractice) {
        query = query.eq("session_type", sessionType);
      } else {
        query = query.eq("session_type", "race");
      }

      const { data: cached } = await query;

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

    // ── Strategy 1: schedule API ─────────────────────────────────
    let candidates: NonNullable<ReturnType<typeof normaliseRace>>[] = [];

    for (let year = currentYear; year >= currentYear - 2 && candidates.length === 0; year--) {
      const schedule = await fetchSchedule(year, series);
      const matching = schedule
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .filter((r) => r.trackName.toLowerCase().includes(trackKeyword))
        .filter((r) => r.raceDate <= today)
        .filter((r) => r.runType === run_type);
      candidates = matching.sort((a, b) => b.raceDate.localeCompare(a.raceDate));
    }

    // ── Strategy 2: backwards live-feed scan ─────────────────────
    if (candidates.length === 0) {
      const { data: recentSessions } = await supabase
        .from("sessions")
        .select("race_id")
        .order("id", { ascending: false })
        .limit(1);

      const rawId = recentSessions?.[0]?.race_id;
      const startId = rawId ? parseInt(String(rawId), 10) : 5720;

      if (!isNaN(startId) && startId > 0) {
        candidates = await scanBackwardsForRun(series, trackKeyword, startId, today, run_type);
      }
    }

    if (candidates.length === 0) {
      const runLabel = isPractice ? (run_type === 2 ? "final practice" : "practice") : "race";
      return new Response(
        JSON.stringify({
          ok: false,
          reason: "no_schedule_data",
          message: `No completed ${runLabel} found for "${track_name}". NASCAR CDN may be unavailable or the track name is unrecognised.`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Fetch lap data ───────────────────────────────────────────
    let lapData: any = null;
    let pickedRace: typeof candidates[0] | null = null;

    if (isPractice) {
      // Practice: lap data lives in live-feed.json vehicles[].laps
      for (const race of candidates.slice(0, 5)) {
        const feedUrl = `https://cf.nascar.com/cacher/live/series_${series}/${race.raceId}/live-feed.json`;
        const data = await fetchJson(feedUrl);
        const vehicles: any[] = data?.vehicles ?? data?.Vehicles ?? [];
        const hasLaps = vehicles.length > 0 && vehicles.some((v: any) => (v.laps ?? v.Laps ?? []).length > 0);
        if (data && hasLaps) {
          lapData = data;
          pickedRace = race;
          break;
        }
      }
    } else {
      // Race: lap data in lap-times.json
      for (const race of candidates.slice(0, 5)) {
        const lapUrl = `https://cf.nascar.com/cacher/live/series_${series}/${race.raceId}/lap-times.json`;
        const data = await fetchJson(lapUrl);
        if (data && (Array.isArray(data.laps) || Array.isArray(data.Laps)) && (data.laps ?? data.Laps).length > 0) {
          lapData = data;
          pickedRace = race;
          break;
        }
      }
    }

    if (!lapData || !pickedRace) {
      const runLabel = isPractice ? "practice" : "race";
      return new Response(
        JSON.stringify({
          ok: false,
          reason: "no_lap_data",
          message: `Found schedule entries for "${track_name}" but ${runLabel} lap data is not available.`,
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
        session_type: sessionType,
        session_date: pickedRace.raceDate,
        is_active: false,
        poll_url: isPractice
          ? `https://cf.nascar.com/cacher/live/series_${series}/${pickedRace.raceId}/live-feed.json`
          : `https://cf.nascar.com/cacher/live/series_${series}/${pickedRace.raceId}/lap-times.json`,
        started_by: "historical",
        series,
      })
      .select()
      .single();

    if (sErr) throw sErr;

    // ── Import drivers and laps ──────────────────────────────────
    const driverRows: any[] = [];
    const lapRows: any[] = [];

    if (isPractice) {
      // Practice: extract from vehicles array
      const vehicles: any[] = lapData.vehicles ?? lapData.Vehicles ?? [];
      for (const v of vehicles) {
        const driverKey = String(v.NASCARDriverID ?? v.driver?.NASCARDriverID ?? v.vehicle_number ?? "");
        if (!driverKey) continue;
        const carNumber = String(v.vehicle_number ?? v.Number ?? "");
        const fullName = String(v.driver?.FullName ?? v.FullName ?? v.driver?.full_name ?? "");
        const lastName = fullName.split(" ").slice(-1)[0] ?? "";
        const practiceGroup = v.practice_group ?? v.PracticeGroup ?? null;

        driverRows.push({
          session_id: sessionRow.id,
          driver_key: driverKey,
          car_number: carNumber,
          full_name: fullName,
          last_name: lastName,
          practice_group: practiceGroup,
        });

        const laps: any[] = v.laps ?? v.Laps ?? [];
        for (const lap of laps) {
          const lapNumber = lap.Lap ?? lap.lap ?? lap.lap_number;
          const lapTime = lap.LapTime ?? lap.lapTime ?? lap.lap_time;
          if (lapNumber == null || lapTime == null || lapTime <= 0) continue;
          lapRows.push({ session_id: sessionRow.id, driver_key: driverKey, lap_number: lapNumber, lap_time: lapTime });
        }
      }
    } else {
      // Race: extract from laps/Laps array
      const driversArr: any[] = lapData.laps ?? lapData.Laps ?? [];
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

        const driverLaps: any[] = d.Laps ?? d.laps ?? [];
        for (const lap of driverLaps) {
          const lapNumber = lap.Lap ?? lap.lap_number;
          const lapTime = lap.LapTime ?? lap.lapTime ?? lap.lap_time;
          if (lapNumber == null || lapTime == null || lapTime <= 0) continue;
          lapRows.push({ session_id: sessionRow.id, driver_key: driverKey, lap_number: lapNumber, lap_time: lapTime });
        }
      }
    }

    if (driverRows.length > 0) {
      await supabase
        .from("drivers")
        .upsert(driverRows, { onConflict: "session_id,driver_key" });
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
