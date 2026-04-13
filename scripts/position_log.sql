-- Long-term per-player position tracking for admin forensics.
-- Writes happen from server.js socket player:location, throttled so at most
-- one row per player per 60s OR one row per >500m jump — whichever comes first.
-- Used to reconstruct movement history after the fact (teleport detection,
-- twink coordination, etc.).
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.position_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id  bigint NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  logged_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_position_log_tg_logged
  ON public.position_log (telegram_id, logged_at DESC);

GRANT SELECT, INSERT, DELETE ON public.position_log TO overthrow;
