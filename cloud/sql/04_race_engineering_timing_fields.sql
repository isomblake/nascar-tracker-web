-- Applied to Supabase project ofqqgbgxoywnqoukvwth.
-- Extend the current vehicle timing snapshot with public NASCAR feed fields.
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS laps_completed integer,
  ADD COLUMN IF NOT EXISTS delta_leader numeric,
  ADD COLUMN IF NOT EXISTS vehicle_elapsed_time numeric,
  ADD COLUMN IF NOT EXISTS last_lap_time numeric,
  ADD COLUMN IF NOT EXISTS last_lap_speed numeric,
  ADD COLUMN IF NOT EXISTS average_running_position numeric,
  ADD COLUMN IF NOT EXISTS average_speed numeric,
  ADD COLUMN IF NOT EXISTS pit_stops_count integer,
  ADD COLUMN IF NOT EXISTS last_pit_lap integer,
  ADD COLUMN IF NOT EXISTS last_pit_total_duration numeric,
  ADD COLUMN IF NOT EXISTS last_pit_box_duration numeric,
  ADD COLUMN IF NOT EXISTS last_pit_tire_count integer,
  ADD COLUMN IF NOT EXISTS last_pit_positions_gained integer,
  ADD COLUMN IF NOT EXISTS last_pit_stop_type text,
  ADD COLUMN IF NOT EXISTS pit_details jsonb;
