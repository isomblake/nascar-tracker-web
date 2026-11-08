// NASCAR polling worker: one bounded poll per invocation, protected by a DB lease.
// pg_cron runs once per minute. The lease prevents cron/manual-start overlap.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FLAG_CHECKERED = 4;
const FLAG_COLD = 9;

interface Session {
  id: number;
  race_id: string;
  track_name: string;
  session_type: string;
  poll_url: string;
  is_active: boolean;
  total_laps_seen: number | null;
  current_lap: number | null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function getDrivers(lapData: any, liveData: any): any[] {
  let drivers: any[] = lapData?.laps ?? lapData?.Laps ?? [];
  if (!drivers.length && lapData && typeof lapData === "object") {
    for (const value of Object.values(lapData)) {
      if (!Array.isArray(value) || !value.length) continue;
      const first: any = value[0];
      if (first?.NASCARDriverID != null || first?.vehicle_number != null || first?.Number != null) {
        drivers = value;
        break;
      }
    }
  }

  if (!drivers.length) {
    const vehicles: any[] = liveData?.vehicles ?? liveData?.Vehicles ?? [];
    drivers = vehicles
      .filter((v) => v.laps_completed != null || (v.laps ?? v.Laps)?.length)
      .map((v) => {
        const existingLaps = v.laps ?? v.Laps ?? [];
        const synthLaps =
          !existingLaps.length && v.laps_completed != null && v.last_lap_time > 0
            ? [{ Lap: v.laps_completed, LapTime: v.last_lap_time }]
            : existingLaps;
        return {
          NASCARDriverID: v.NASCARDriverID ?? v.driver?.NASCARDriverID ?? v.driver?.driver_id ?? v.driver?.id ?? v.vehicle_number,
          Number: v.vehicle_number ?? v.Number,
          FullName: v.driver?.FullName ?? v.FullName ?? v.driver?.full_name ?? "",
          Laps: synthLaps,
          running_position: v.running_position ?? v.RunningPos,
          practice_group: v.practice_group ?? v.PracticeGroup ?? null,
        };
      });
  }
  return drivers;
}

async function pollOnce(supabase: SupabaseClient, session: Session) {
  if (!session.poll_url) throw new Error("Active session has no poll_url");
  const liveUrl = session.poll_url.replace("lap-times", "live-feed");
  const [lapData, liveData] = await Promise.all([
    fetchJson(session.poll_url),
    fetchJson(liveUrl),
  ]);

  if (!lapData && !liveData) throw new Error("Both NASCAR live-feed and lap-times endpoints failed");

  // Prefer lap-times.json when it contains per-driver lap histories for every session.
  // Fall back to live-feed vehicle laps only when lap-times has no usable driver array.
  const drivers = getDrivers(lapData, liveData);
  const vehicles: any[] = liveData?.vehicles ?? liveData?.Vehicles ?? [];
  const vehicleByDriver = new Map<string, any>();
  for (const vehicle of vehicles) {
    const key = String(vehicle.NASCARDriverID ?? vehicle.driver?.NASCARDriverID ?? vehicle.driver?.driver_id ?? vehicle.driver?.id ?? vehicle.vehicle_number ?? "");
    if (key) vehicleByDriver.set(key, vehicle);
  }
  const driverRows: any[] = [];
  const lapRows: any[] = [];
  const positionRows = new Map<string, any>();
  const pitEventRows: any[] = [];

  for (const driver of drivers) {
    const driverKey = String(driver.NASCARDriverID ?? driver.Number ?? "");
    if (!driverKey) continue;
    const fullName = driver.FullName ?? "";
    const laps = driver.Laps ?? driver.laps ?? [];
    const vehicle = vehicleByDriver.get(driverKey) ?? driver;
    const pitStops: any[] = vehicle.pit_stops ?? vehicle.PitStops ?? [];
    const sortedPitStops = [...pitStops].sort((a, b) =>
      Number(a.pit_in_lap_count ?? a.pit_in_leader_lap ?? 0) - Number(b.pit_in_lap_count ?? b.pit_in_leader_lap ?? 0)
    );
    const lastPit = sortedPitStops.length ? sortedPitStops[sortedPitStops.length - 1] : null;

    driverRows.push({
      session_id: session.id,
      driver_key: driverKey,
      car_number: String(driver.Number ?? ""),
      full_name: fullName,
      last_name: fullName.split(" ").slice(-1)[0] ?? "",
      practice_group: driver.practice_group ?? driver.PracticeGroup ?? null,
    });

    for (const lap of laps) {
      const lapNumber = lap.Lap ?? lap.lap ?? lap.lap_number;
      const lapTime = lap.LapTime ?? lap.lapTime ?? lap.lap_time;
      if (lapNumber == null || lapTime == null || Number(lapTime) <= 0) continue;
      const pitLapNumbers = new Set(sortedPitStops.map((stop) =>
        Number(stop.pit_in_lap_count ?? stop.pit_in_leader_lap ?? 0)
      ).filter((lap) => Number.isInteger(lap) && lap > 0));
      lapRows.push({
        session_id: session.id,
        driver_key: driverKey,
        lap_number: Number(lapNumber),
        lap_time: Number(lapTime),
        ...(pitLapNumbers.has(Number(lapNumber)) ? { is_pit: true } : {}),
      });
    }

    const topPosition = vehicle.running_position ?? vehicle.RunningPos ?? vehicle.running_pos ??
      driver.running_position ?? driver.RunningPos ?? driver.running_pos;
    const lastLap = laps[laps.length - 1];
    const position = topPosition ?? lastLap?.RunningPos ?? lastLap?.running_pos ?? lastLap?.runningPos;
    if (position != null) {
      const tireChangeKeys = ["left_front_tire_changed", "left_rear_tire_changed", "right_front_tire_changed", "right_rear_tire_changed"];
      const tireFlags = lastPit ? tireChangeKeys.map((key) => lastPit[key]).filter((value) => typeof value === "boolean") : [];
      const pitType = String(lastPit?.pit_stop_type ?? lastPit?.stop_type ?? "").toUpperCase();
      const changedTires = !lastPit
        ? null
        : tireFlags.length
          ? tireFlags.filter(Boolean).length
          : pitType.includes("FOUR_WHEEL_CHANGE")
            ? 4
            : pitType.includes("TWO_WHEEL_CHANGE")
              ? 2
              : null;
      const pitInElapsed = numberOrNull(lastPit?.pit_in_elapsed_time);
      const pitOutElapsed = numberOrNull(lastPit?.pit_out_elapsed_time);
      const pitRoadDuration = numberOrNull(lastPit?.total_duration) ??
        (pitInElapsed != null && pitOutElapsed != null && pitOutElapsed >= pitInElapsed
          ? pitOutElapsed - pitInElapsed
          : null);
      positionRows.set(driverKey, {
        session_id: session.id,
        driver_key: driverKey,
        position: Number(position),
        laps_completed: numberOrNull(vehicle.laps_completed ?? vehicle.LapsCompleted),
        delta_leader: numberOrNull(vehicle.delta),
        vehicle_elapsed_time: numberOrNull(vehicle.vehicle_elapsed_time),
        last_lap_time: numberOrNull(vehicle.last_lap_time),
        last_lap_speed: numberOrNull(vehicle.last_lap_speed),
        average_running_position: numberOrNull(vehicle.average_running_position),
        average_speed: numberOrNull(vehicle.average_speed),
        pit_stops_count: pitStops.length,
        last_pit_lap: lastPit ? Number(lastPit.pit_in_lap_count ?? lastPit.pit_in_leader_lap ?? 0) || null : null,
        last_pit_total_duration: pitRoadDuration,
        last_pit_box_duration: lastPit && Number.isFinite(Number(lastPit.pit_stop_duration ?? lastPit.box_stop_duration)) ? Number(lastPit.pit_stop_duration ?? lastPit.box_stop_duration) : null,
        last_pit_tire_count: changedTires,
        last_pit_positions_gained: lastPit && Number.isFinite(Number(lastPit.positions_gained ?? lastPit.positions_gained_lossed)) ? Number(lastPit.positions_gained ?? lastPit.positions_gained_lossed) : null,
        last_pit_stop_type: lastPit?.pit_stop_type ?? lastPit?.stop_type ?? null,
        pit_details: lastPit ?? null,
      });
    }
    for (const stop of sortedPitStops) {
      const pitLap = Number(stop.pit_in_lap_count ?? stop.pit_in_leader_lap ?? 0);
      if (!Number.isInteger(pitLap) || pitLap <= 0) continue;
      pitEventRows.push({
        session_id: session.id,
        event_type: "pit_stop",
        lap_number: pitLap,
        driver_key: driverKey,
        details: {
          ...stop,
          car_number: String(driver.Number ?? vehicle.vehicle_number ?? ""),
          driver_name: fullName,
        },
      });
    }
  }

  if (driverRows.length) {
    const { error } = await supabase
      .from("drivers")
      .upsert(driverRows, { onConflict: "session_id,driver_key" });
    if (error) throw new Error("Driver upsert failed: " + error.message);
  }

  for (let i = 0; i < lapRows.length; i += 400) {
    const { error } = await supabase
      .from("laps")
      .upsert(lapRows.slice(i, i + 400), { onConflict: "session_id,driver_key,lap_number" });
    if (error) throw new Error("Lap upsert failed: " + error.message);
  }

  if (positionRows.size) {
    const { error } = await supabase
      .from("positions")
      .upsert([...positionRows.values()], { onConflict: "session_id,driver_key" });
    if (error) throw new Error("Position upsert failed: " + error.message);
  }

  if (pitEventRows.length) {
    const { data: existingPitEvents, error: pitReadError } = await supabase
      .from("race_events")
      .select("driver_key,lap_number")
      .eq("session_id", session.id)
      .eq("event_type", "pit_stop");
    if (pitReadError) throw new Error("Pit-event lookup failed: " + pitReadError.message);
    const existingKeys = new Set((existingPitEvents ?? []).map((event) => `${event.driver_key}:${event.lap_number}`));
    const newPitEvents = pitEventRows.filter((event) => !existingKeys.has(`${event.driver_key}:${event.lap_number}`));
    for (let i = 0; i < newPitEvents.length; i += 100) {
      const { error } = await supabase.from("race_events").insert(newPitEvents.slice(i, i + 100));
      if (error) throw new Error("Pit-event insert failed: " + error.message);
    }
  }

  const { count, error: countError } = await supabase
    .from("laps")
    .select("lap_number", { count: "exact", head: true })
    .eq("session_id", session.id);
  if (countError) throw new Error("Lap count failed: " + countError.message);

  const vehicleMaxLap = vehicles.reduce(
    (max, vehicle) => Math.max(max, Number(vehicle.laps_completed ?? 0)),
    0,
  );
  const payloadMaxLap = lapRows.reduce((max, lap) => Math.max(max, lap.lap_number), 0);
  const currentLap =
    liveData?.lap_number ??
    (vehicleMaxLap > 0 ? vehicleMaxLap : payloadMaxLap > 0 ? payloadMaxLap : session.current_lap);

  const sessionUpdate: Record<string, any> = {
    last_poll_at: new Date().toISOString(),
    total_laps_seen: count ?? 0,
    last_error: null,
  };
  if (liveData?.flag_state != null) sessionUpdate.flag_state = liveData.flag_state;
  if (currentLap != null) sessionUpdate.current_lap = currentLap;
  if (liveData?.laps_in_race != null) sessionUpdate.laps_in_race = liveData.laps_in_race;
  if (liveData?.laps_to_go != null) sessionUpdate.laps_to_go = liveData.laps_to_go;
  if (liveData?.stage != null) {
    const stageValue = liveData.stage;
    const stageNumber = typeof stageValue === "number"
      ? stageValue
      : Number(stageValue?.stage_num ?? stageValue?.stage ?? NaN);
    if (Number.isInteger(stageNumber)) sessionUpdate.stage = stageNumber;
  }

  const shouldStop =
    liveData?.flag_state === FLAG_CHECKERED ||
    (session.session_type !== "race" && liveData?.flag_state === FLAG_COLD);

  if (shouldStop) sessionUpdate.is_active = false;

  const { error: updateError } = await supabase
    .from("sessions")
    .update(sessionUpdate)
    .eq("id", session.id);
  if (updateError) throw new Error("Session heartbeat update failed: " + updateError.message);

  return {
    drivers_seen: driverRows.length,
    lap_rows: lapRows.length,
    lap_rows_total: count ?? 0,
    current_lap: currentLap ?? null,
    flag_state: liveData?.flag_state ?? null,
    stopped: shouldStop,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let lockToken: string | null = null;
  let sessionId: number | null = null;

  try {
    const { data: token, error: lockError } = await supabase.rpc("claim_nascar_poll_lock");
    if (lockError) throw new Error("Could not claim poll lease: " + lockError.message);
    lockToken = token;
    if (!lockToken) {
      return new Response(JSON.stringify({ ok: true, status: "poll_already_running" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select("*")
      .eq("is_active", true)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sessionError) throw sessionError;

    if (!session) {
      return new Response(JSON.stringify({ ok: true, status: "no_active_session" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    sessionId = session.id;

    // Four snapshots per cron minute; lease remains held to prevent overlap.
    const results: any[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(await pollOnce(supabase, session as Session));
      if (i < 3) await new Promise((resolve) => setTimeout(resolve, 12000));
      const { data: latest } = await supabase.from("sessions").select("is_active").eq("id", sessionId).maybeSingle();
      if (latest && !latest.is_active) break;
    }
    const result = results[results.length - 1] ?? {};
    return new Response(JSON.stringify({ ok: true, status: "poll_complete", session_id: sessionId, polls_completed: results.length, ...result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = String(error).slice(0, 500);
    if (sessionId != null) {
      const { error: recordError } = await supabase
        .from("sessions")
        .update({ last_error: message })
        .eq("id", sessionId);
      if (recordError) console.error("Failed to record polling error:", recordError.message);
    }
    console.error("NASCAR poll failed:", message);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } finally {
    if (lockToken) {
      const { error } = await supabase.rpc("release_nascar_poll_lock", { p_token: lockToken });
      if (error) console.error("Failed to release poll lease:", error.message);
    }
  }
});
