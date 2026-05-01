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
async function processLapTimes(
  supabase: SupabaseClient,
  session: Session,
  lapData: any,
  liveData: any
): Promise<number> {
  // lap-times.json structure:
  // { laps: [ { Number: 6, FullName: "Brad Keselowski", NASCARDriverID: ..., Laps: [ { Lap, LapTime, RunningPos, ... } ] } ] }
  const driversArr = lapData?.laps ?? [];
  if (!Array.isArray(driversArr) || driversArr.length === 0) return 0;

  // Build driver upsert rows (only on first sight per session; we skip if already seen)
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
    });

    const laps = d.Laps ?? [];
    for (const lap of laps) {
      const lapNumber = lap.Lap;
      const lapTime = lap.LapTime;
      if (lapNumber == null || lapTime == null || lapTime <= 0) continue;
      lapRows.push({
        session_id: session.id,
        driver_key: driverKey,
        lap_number: lapNumber,
        lap_time: lapTime,
      });
    }

    // Running position = position on the most recent lap
    if (laps.length > 0) {
      const lastLap = laps[laps.length - 1];
      if (lastLap.RunningPos != null) {
        positionMap.set(driverKey, lastLap.RunningPos);
      }
    }
  }

  // Upsert drivers (ignore conflicts — driver list is stable within a session)
  if (driverRows.length > 0) {
    await supabase
      .from("drivers")
      .upsert(driverRows, { onConflict: "session_id,driver_key", ignoreDuplicates: true });
  }

  // Upsert laps (compound unique on session_id, driver_key, lap_number)
  let newLaps = 0;
  if (lapRows.length > 0) {
    // Chunked to avoid payload size limits
    const CHUNK = 500;
    for (let i = 0; i < lapRows.length; i += CHUNK) {
      const chunk = lapRows.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("laps")
        .upsert(chunk, { onConflict: "session_id,driver_key,lap_number" });
      if (!error) newLaps += chunk.length;
    }
  }

  // Overwrite positions (one row per driver)
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

  // Update session with live-feed context
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

      if (lapData) {
        const newLaps = await processLapTimes(supabase, session, lapData, liveData);
        totalNewLaps += newLaps;
      }

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
