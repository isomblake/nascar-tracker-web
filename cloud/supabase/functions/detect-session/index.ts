// supabase/functions/detect-session/index.ts
//
// Called by the PWA when Blake hits "Start Tracking".
// Scans NASCAR race IDs in a window, finds the one that's live today,
// creates a sessions row with is_active=true, and returns it.
//
// The poll-nascar cron will see is_active=true on its next tick and start polling.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Scan window. Kansas was 5607. Talladega will be ~5608, Texas ~5609. Pad generously.
const SCAN_START = 5605;
const SCAN_END = 5640;
const SERIES = 1; // Cup

// NASCAR run_type → our session_type convention
function mapRunType(runType: number, runName: string): string {
  if (runType === 3) return "race";
  if (runType === 4) return "qualifying";
  if (runType === 1 || runType === 2) {
    // Practice 1 vs 2 distinguished by run_name
    const n = (runName || "").toLowerCase();
    if (n.includes("2") || n.includes("group 2") || n.includes("final")) return "practice2";
    return "practice1";
  }
  return "unknown";
}

// Flag state meaning:
// 1 = green, 2 = yellow, 3 = red, 4 = checkered, 8 = warmup/pre-race, 9 = cold/not started
function isLive(flagState: number): boolean {
  return flagState === 1 || flagState === 2 || flagState === 8;
}

async function fetchLiveFeed(raceId: number): Promise<any | null> {
  const url = `https://cf.nascar.com/cacher/live/series_${SERIES}/${raceId}/live-feed.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Scan all IDs in parallel
    const ids: number[] = [];
    for (let i = SCAN_START; i <= SCAN_END; i++) ids.push(i);

    const results = await Promise.all(
      ids.map(async (id) => ({ id, feed: await fetchLiveFeed(id) }))
    );

    // Filter to live sessions
    const today = new Date().toISOString().slice(0, 10);
    const candidates = results
      .filter((r) => r.feed)
      .filter((r) => isLive(r.feed.flag_state))
      .map((r) => ({
        raceId: r.id,
        trackName: r.feed.track_name || "unknown",
        runType: r.feed.run_type,
        runName: r.feed.run_name || "",
        flagState: r.feed.flag_state,
        lapsInRace: r.feed.laps_in_race,
        lapNumber: r.feed.lap_number,
      }));

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          reason: "no_live_session",
          message: "No live NASCAR session detected. Check back closer to session start.",
          scanned: ids.length,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Prefer green (1), then yellow (2), then warmup (8)
    candidates.sort((a, b) => a.flagState - b.flagState);
    const pick = candidates[0];

    const sessionType = mapRunType(pick.runType, pick.runName);
    const pollUrl = `https://cf.nascar.com/cacher/live/series_${SERIES}/${pick.raceId}/lap-times.json`;

    // Deactivate any existing active sessions first (prevents double-polling)
    await supabase.from("sessions").update({ is_active: false }).eq("is_active", true);

    // Check if this exact session already exists for today (resume scenario)
    const { data: existing } = await supabase
      .from("sessions")
      .select("*")
      .eq("race_id", String(pick.raceId))
      .eq("session_type", sessionType)
      .eq("session_date", today)
      .maybeSingle();

    let session;
    if (existing) {
      const { data, error } = await supabase
        .from("sessions")
        .update({
          is_active: true,
          poll_url: pollUrl,
          flag_state: pick.flagState,
          laps_in_race: pick.lapsInRace ?? null,
          current_lap: pick.lapNumber ?? null,
          started_by: "phone",
          last_error: null,
        })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      session = data;
    } else {
      const { data, error } = await supabase
        .from("sessions")
        .insert({
          race_id: String(pick.raceId),
          track_name: pick.trackName,
          session_type: sessionType,
          session_date: today,
          is_active: true,
          poll_url: pollUrl,
          flag_state: pick.flagState,
          laps_in_race: pick.lapsInRace ?? null,
          current_lap: pick.lapNumber ?? null,
          started_by: "phone",
          series: SERIES,
        })
        .select()
        .single();
      if (error) throw error;
      session = data;
    }

    // Kick off the first poll immediately (don't wait for cron)
    const fnUrl = Deno.env.get("SUPABASE_URL") + "/functions/v1/poll-nascar";
    fetch(fnUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ triggered_by: "detect-session" }),
    }).catch(() => {}); // fire and forget

    return new Response(
      JSON.stringify({
        ok: true,
        session,
        detected: {
          race_id: pick.raceId,
          track: pick.trackName,
          session_type: sessionType,
          run_name: pick.runName,
          flag_state: pick.flagState,
          candidates_found: candidates.length,
        },
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
