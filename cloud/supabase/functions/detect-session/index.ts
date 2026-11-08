import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Series-specific ranges reduce unnecessary NASCAR CDN traffic.
// Expand a series range when NASCAR introduces new race IDs.
const SERIES = [
  { id: 1, name: "Cup", start: 5601, end: 5650 },
  { id: 2, name: "Xfinity", start: 5635, end: 5700 },
  { id: 3, name: "Truck", start: 5660, end: 5750 },
];
const MAX_CONCURRENCY = 24;

function mapRunType(runType: number, runName: string): string {
  if (runType === 3) return "race";
  if (runType === 4) return "qualifying";
  if (runType === 1 || runType === 2) {
    const name = (runName || "").toLowerCase();
    return name.includes("2") || name.includes("group 2") || name.includes("final")
      ? "practice2"
      : "practice1";
  }
  return "unknown";
}

function isLive(flagState: number): boolean {
  return flagState === 1 || flagState === 2 || flagState === 8;
}

async function fetchLiveFeed(seriesId: number, raceId: number): Promise<any | null> {
  try {
    const response = await fetch(
      `https://cf.nascar.com/cacher/live/series_${seriesId}/${raceId}/live-feed.json`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const tasks = SERIES.flatMap((series) =>
      Array.from({ length: series.end - series.start + 1 }, (_, offset) => ({
        id: series.start + offset,
        seriesId: series.id,
        seriesName: series.name,
      }))
    );

    const results: any[] = new Array(tasks.length);
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= tasks.length) return;
        const task = tasks[index];
        results[index] = {
          ...task,
          feed: await fetchLiveFeed(task.seriesId, task.id),
        };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENCY, tasks.length) }, () => worker())
    );

    const candidates = results
      .filter((item) => item.feed && isLive(item.feed.flag_state))
      .map((item) => ({
        raceId: item.id,
        seriesId: item.seriesId,
        seriesName: item.seriesName,
        trackName: item.feed.track_name || "unknown",
        runType: item.feed.run_type,
        runName: item.feed.run_name || "",
        flagState: item.feed.flag_state,
        lapsInRace: item.feed.laps_in_race,
        lapNumber: item.feed.lap_number,
      }));

    if (!candidates.length) {
      return new Response(JSON.stringify({
        ok: false,
        reason: "no_live_session",
        message: "No live NASCAR session detected. Check back closer to session start.",
        scanned: tasks.length,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    candidates.sort((a, b) =>
      a.flagState - b.flagState ||
      a.seriesId - b.seriesId ||
      b.raceId - a.raceId
    );
    const pick = candidates[0];
    const sessionType = mapRunType(pick.runType, pick.runName);
    const pollUrl = `https://cf.nascar.com/cacher/live/series_${pick.seriesId}/${pick.raceId}/lap-times.json`;
    const today = new Date().toISOString().slice(0, 10);

    const { error: deactivateError } = await supabase
      .from("sessions")
      .update({ is_active: false })
      .eq("is_active", true);
    if (deactivateError) throw deactivateError;

    const { data: existing, error: lookupError } = await supabase
      .from("sessions")
      .select("*")
      .eq("race_id", String(pick.raceId))
      .eq("session_type", sessionType)
      .eq("session_date", today)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const values = {
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
      series: pick.seriesId,
      last_error: null,
    };

    let session;
    if (existing) {
      const { data, error } = await supabase
        .from("sessions")
        .update(values)
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      session = data;
    } else {
      const { data, error } = await supabase
        .from("sessions")
        .insert(values)
        .select()
        .single();
      if (error) throw error;
      session = data;
    }

    // Fire the first poll immediately. The DB lease prevents overlap with cron.
    const functionUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/poll-nascar`;
    fetch(functionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ triggered_by: "detect-session" }),
    }).catch((error) => console.error("Initial poll trigger failed:", error));

    return new Response(JSON.stringify({
      ok: true,
      session,
      detected: {
        race_id: pick.raceId,
        track: pick.trackName,
        session_type: sessionType,
        run_name: pick.runName,
        flag_state: pick.flagState,
        series: pick.seriesId,
        series_name: pick.seriesName,
        candidates_found: candidates.length,
        scanned: tasks.length,
      },
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Session detection failed:", error);
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
