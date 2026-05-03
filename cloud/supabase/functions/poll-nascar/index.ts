// supabase/functions/poll-nascar/index.ts
//
// Triggered every 60s by pg_cron. Runs a sub-loop polling NASCAR every 5s
// for ~55s, then exits (cron fires again for the next minute).
//
// If is_active=false on the active session, exits immediately — that's how Stop works.
// Self-healing: if one invocation crashes, the next cron tick recovers.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const POLL_INTERVAL_MS = 5000;
const MAX_RUNTIME_MS = 55_000; // leave headroom before 60s cron tick

// NASCAR flag states
const FLAG_CHECKERED = 4; // race over
const FLAG_COLD = 9;      // session not started / ended (practice, qualifying end)

interface Session {
  id: number;
  race_id: string;
  track_name: string;
  session_type: string;
  poll_url: string;
  is_active: boolean;
  total_laps_seen: number | null;
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Parse NASCAR lap-times.json payload and upsert new laps/positions.
// Returns number of new laps written.
// Handles both PascalCase (Cup) and camelCase/snake_case (Truck/Xfinity) CDN variants.
async function processLapTimes(
  supabase: SupabaseClient,
  session: Session,
  lapData: any,
  liveData: any
): Promise<number> {
  // 1. Try lap-times.json: walk all top-level keys to find the driver array.
  //    Key varies: "laps" (Cup), "Laps" (Truck/Xfinity), or other.
  let driversArr: any[] = lapData?.laps ?? lapData?.Laps ?? [];
  if (driversArr.length === 0 && lapData && typeof lapData === "object") {
    for (const key of Object.keys(lapData)) {
      const val = lapData[key];
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0];
        if (first?.NASCARDriverID != null || first?.vehicle_number != null || first?.Number != null) {
          driversArr = val;
          break;
        }
      }
    }
  }

  // 2. Fallback: live-feed.json vehicles array (practice sessions often only populate here).
  //    During practice the CDN may only serve live-feed.json with per-vehicle state
  //    (laps_completed + last_lap_time) rather than a full lap-by-lap array.
  //    We synthesise a single lap record per driver per poll using laps_completed as
  //    the lap number — upsert deduplication means repeated polls for the same lap are
  //    ignored and new laps accumulate naturally.
  if (driversArr.length === 0) {
    const vehicles: any[] = liveData?.vehicles ?? liveData?.Vehicles ?? [];
    driversArr = vehicles
      .filter((v: any) => v.laps_completed != null || (v.laps ?? v.Laps)?.length > 0)
      .map((v: any) => {
        const existingLaps = v.laps ?? v.Laps ?? [];
        // If no laps array, synthesise one entry from aggregate fields
        const synthLaps = existingLaps.length === 0 && v.laps_completed != null && v.last_lap_time != null && v.last_lap_time > 0
          ? [{ Lap: v.laps_completed, LapTime: v.last_lap_time }]
          : existingLaps;
        return {
          NASCARDriverID: v.NASCARDriverID ?? v.driver?.NASCARDriverID ?? v.vehicle_number,
          Number: v.vehicle_number ?? v.Number,
          FullName: v.driver?.FullName ?? v.FullName ?? v.driver?.full_name ?? "",
          Laps: synthLaps,
          running_position: v.running_position ?? v.RunningPos,
          practice_group: v.practice_group ?? v.PracticeGroup ?? null,
        };
      });
  }

  let newLaps = 0;

  if (Array.isArray(driversArr) && driversArr.length > 0) {
    const driverRows: any[] = [];
    const lapRows: any[] = [];
    const positionMap = new Map<string, number>();

    for (const d of driversArr) {
      const driverKey = String(d.NASCARDriverID ?? d.Number ?? "");
      if (!driverKey) continue;
      const carNumber = String(d.Number ?? "");
      const fullName = d.FullName ?? "";
      const lastName = fullName.split(" ").slice(-1)[0] ?? "";

      driverRows.push({
        session_id: session.id,
        driver_key: driverKey,
        car_number: carNumber,
        full_name: fullName,
        last_name: lastName,
        practice_group: d.practice_group ?? null,
      });

      // Handle both "Laps" (PascalCase) and "laps" (camelCase)
      const laps = d.Laps ?? d.laps ?? [];
      for (const lap of laps) {
        // Handle PascalCase (Lap/LapTime/RunningPos), camelCase (lap/lapTime/running_pos), snake_case (lap_number)
        const lapNumber = lap.Lap ?? lap.lap ?? lap.lap_number;
        const lapTime = lap.LapTime ?? lap.lapTime ?? lap.lap_time;
        if (lapNumber == null || lapTime == null || lapTime <= 0) continue;
        lapRows.push({
          session_id: session.id,
          driver_key: driverKey,
          lap_number: lapNumber,
          lap_time: lapTime,
        });
      }

      // Running position: try per-lap field first, then top-level vehicle field (live-feed fallback)
      const topLevelPos = d.running_position ?? d.RunningPos ?? d.running_pos;
      if (topLevelPos != null) {
        positionMap.set(driverKey, topLevelPos);
      } else if (laps.length > 0) {
        const lastLap = laps[laps.length - 1];
        const pos = lastLap.RunningPos ?? lastLap.running_pos ?? lastLap.runningPos;
        if (pos != null) positionMap.set(driverKey, pos);
      }
    }

    if (driverRows.length > 0) {
      await supabase
        .from("drivers")
        .upsert(driverRows, { onConflict: "session_id,driver_key" });
    }

    // Supplement lap-times.json with live-feed per-vehicle data every poll.
    // lap-times.json CDN can lag 1-4 laps; live-feed last_lap_time updates
    // each lap in real-time, closing gaps that the historical file misses.
    const liveVehicles: any[] = liveData?.vehicles ?? liveData?.Vehicles ?? [];
    for (const v of liveVehicles) {
      const driverKey = String(v.NASCARDriverID ?? v.driver?.NASCARDriverID ?? v.vehicle_number ?? "");
      if (!driverKey) continue;
      const lapsCompleted = v.laps_completed ?? v.LapsCompleted;
      const lastLapTime = v.last_lap_time ?? v.LastLapTime;
      if (lapsCompleted != null && lastLapTime != null && lastLapTime > 0) {
        lapRows.push({
          session_id: session.id,
          driver_key: driverKey,
          lap_number: lapsCompleted,
          lap_time: lastLapTime,
        });
      }
    }

    if (lapRows.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < lapRows.length; i += CHUNK) {
        const chunk = lapRows.slice(i, i + CHUNK);
        const { error } = await supabase
          .from("laps")
          .upsert(chunk, { onConflict: "session_id,driver_key,lap_number" });
        if (!error) newLaps += chunk.length;
      }
    }

    if (positionMap.size > 0) {
      const positionRows = Array.from(positionMap.entries()).map(([driver_key, position]) => ({
        session_id: session.id,
        driver_key,
        position,
      }));
      await supabase
        .from("positions")
        .upsert(positionRows, { onConflict: "session_id,driver_key" });
    }
  }

  // Always update session heartbeat — even when no lap data came back
  const sessionUpdate: any = {
    last_poll_at: new Date().toISOString(),
    total_laps_seen: (session.total_laps_seen ?? 0) + newLaps,
  };
  if (liveData) {
    if (liveData.flag_state != null) sessionUpdate.flag_state = liveData.flag_state;
    if (liveData.lap_number != null) sessionUpdate.current_lap = liveData.lap_number;
    if (liveData.laps_in_race != null) sessionUpdate.laps_in_race = liveData.laps_in_race;
    if (liveData.laps_to_go != null) sessionUpdate.laps_to_go = liveData.laps_to_go;
    if (liveData.stage != null) sessionUpdate.stage = liveData.stage;
  }
  await supabase.from("sessions").update(sessionUpdate).eq("id", session.id);

  return newLaps;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Load active session
    const { data: sessions, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("is_active", true)
      .limit(1);
    if (error) throw error;

    if (!sessions || sessions.length === 0) {
      return new Response(JSON.stringify({ ok: true, status: "no_active_session" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const session = sessions[0] as Session;
    const pollUrl = session.poll_url;
    const liveUrl = pollUrl.replace("lap-times", "live-feed");

    let polls = 0;
    let totalNewLaps = 0;
    let checkeredSeen = false;

    while (Date.now() - startedAt < MAX_RUNTIME_MS) {
      // Re-read is_active each tick — Stop button flips it to false
      const { data: check } = await supabase
        .from("sessions")
        .select("is_active")
        .eq("id", session.id)
        .single();
      if (!check || check.is_active === false) {
        return new Response(
          JSON.stringify({ ok: true, status: "stopped_by_user", polls, newLaps: totalNewLaps }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const [lapData, liveData] = await Promise.all([fetchJson(pollUrl), fetchJson(liveUrl)]);

      // Always call processLapTimes — it handles lapData=null by falling back to
      // live-feed.json vehicles (practice sessions often serve no lap-times.json).
      // Race path is unchanged: lapData is always present for races.
      const newLaps = await processLapTimes(supabase, session, lapData, liveData);
      totalNewLaps += newLaps;

      polls++;

      // Auto-stop on checkered flag
      if (liveData?.flag_state === FLAG_CHECKERED) {
        checkeredSeen = true;
        await supabase
          .from("sessions")
          .update({ is_active: false, flag_state: FLAG_CHECKERED })
          .eq("id", session.id);
        break;
      }

      // Auto-stop when session goes cold (practice/qualifying ended, or stale session).
      // Two conditions cover both cases:
      //   totalSeen > 0 — session ran normally and data stopped coming in
      //   polls >= 2    — stale/empty session that was never live (no-data guard)
      // detect-session only creates sessions in live states (flag 1/2/8), so seeing
      // FLAG_COLD for 2+ polls means the session is genuinely over.
      const totalSeen = (session.total_laps_seen ?? 0) + totalNewLaps;
      if (liveData?.flag_state === FLAG_COLD && (totalSeen > 0 || polls >= 2)) {
        await supabase
          .from("sessions")
          .update({ is_active: false, flag_state: FLAG_COLD })
          .eq("id", session.id);
        break;
      }

      // Gentle wait
      await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: checkeredSeen ? "checkered_auto_stop" : "cron_tick_complete",
        session_id: session.id,
        polls,
        newLaps: totalNewLaps,
        runtime_ms: Date.now() - startedAt,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    // Log error on session row but don't crash the cron chain
    try {
      await supabase
        .from("sessions")
        .update({ last_error: String(err).slice(0, 500) })
        .eq("is_active", true);
    } catch {}
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
